import { expect, test, vi } from 'vite-plus/test';
import { createAdvisoryReader } from './advisory-read.js';

const limits = {
  maxRequests: 10,
  maxPages: 10,
  maxResponseBytes: 20_000,
  maxTotalBytes: 200_000,
  maxJsonEntries: 10_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 200_000,
  maxFindings: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const target = { ecosystem: 'npm', name: '@fixture/widget', version: '1.2.3-rc.1+build' };
test('validates limits before I/O and constructs an encoded exact singleton query', async () => {
  let calls = 0;
  const deps = {
    now: () => 0,
    fetch: async (url: string, init: RequestInit) => {
      calls++;
      const query = new URL(url);
      expect(query.searchParams.get('affects')).toBe('@fixture/widget@1.2.3-rc.1+build');
      expect(query.searchParams.get('type')).toBe('reviewed');
      expect(init.headers).toEqual({
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      });
      return Response.json([]);
    },
  };
  expect(createAdvisoryReader({ ...limits, maxRequests: 0 }, deps).kind).toBe('invalid');
  const reader = createAdvisoryReader(limits, deps);
  if (reader.kind !== 'ready') throw new Error('reader');
  const result = await reader.read(target);
  reader.close();
  expect(result).toMatchObject({ status: 'available', complete: true, records: [] });
  expect(calls).toBe(1);
});

const record = {
  ghsa_id: 'GHSA-aaaa-bbbb-cccc',
  html_url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  summary: 'Synthetic finding',
  type: 'reviewed',
  severity: 'high',
  withdrawn_at: null,
  vulnerabilities: [
    { package: { ecosystem: 'npm', name: target.name }, vulnerable_version_range: '<2.0.0' },
  ],
};
function reader(fetch: (url: string, init: RequestInit) => Promise<Response>, overrides = {}) {
  const ready = createAdvisoryReader({ ...limits, ...overrides }, { fetch, now: () => 0 });
  if (ready.kind !== 'ready') throw new Error('reader');
  return ready;
}
test.each([false, true])(
  'follows exact cursor pages, preserving a positive prefix on failure=%s',
  async (fail) => {
    let calls = 0;
    const r = reader(async (url) => {
      calls++;
      const next = new URL(url);
      next.searchParams.set('after', 'cursor-1');
      if (calls === 1)
        return Response.json([record], { headers: { link: `<${next}>; rel="next"` } });
      expect(new URL(url).searchParams.get('after')).toBe('cursor-1');
      return fail ? Response.json({}, { status: 500 }) : Response.json([]);
    });
    const result = await r.read(target);
    r.close();
    expect(result.records).toHaveLength(1);
    expect(result.complete).toBe(!fail);
    expect(result.status).toBe(fail ? 'partial' : 'available');
    expect(calls).toBe(2);
  },
);
test.each([
  [403, {}, { message: 'Resource not accessible by integration' }, 'permission'],
  [403, {}, { message: 'unclassified' }, 'unknown'],
  [403, { 'x-ratelimit-remaining': '0' }, {}, 'rate_limit'],
  [403, { 'retry-after': '5' }, {}, 'rate_limit'],
  [403, {}, { message: 'You have exceeded a secondary rate limit.' }, 'rate_limit'],
  [429, {}, {}, 'rate_limit'],
  [401, {}, {}, 'permission'],
  [404, {}, {}, 'missing'],
  [422, {}, {}, 'unknown'],
  [503, {}, {}, 'unknown'],
] as const)(
  'keeps HTTP %s/%j unknown and stops on throttling',
  async (status, headers, body, reason) => {
    let calls = 0;
    const r = reader(async () => {
      calls++;
      return Response.json(body, { status, headers });
    });
    expect(await r.read(target)).toMatchObject({ complete: false, reasons: [reason] });
    await r.read({ ...target, version: '9.0.0' });
    r.close();
    expect(calls).toBe(reason === 'rate_limit' ? 1 : 2);
  },
);
test.each(['host', 'filter', 'repeated', 'malformed'])(
  'rejects %s continuation without a successful empty result',
  async (mode) => {
    let calls = 0;
    const r = reader(async (url) => {
      calls++;
      const next = new URL(url);
      next.searchParams.set('after', 'one');
      if (mode === 'host') next.host = 'example.com';
      if (mode === 'filter') next.searchParams.set('affects', 'other@1');
      return Response.json(calls === 1 ? [record] : [], {
        headers: { link: mode === 'malformed' ? 'garbage' : `<${next}>; rel="next"` },
      });
    });
    const result = await r.read(target);
    r.close();
    expect(result.complete).toBe(false);
    expect(result.records).toHaveLength(1);
    expect(calls).toBe(mode === 'repeated' ? 2 : 1);
  },
);
test.each([
  { maxResponseBytes: 10 },
  { maxTotalBytes: 10, maxResponseBytes: 10 },
  { maxJsonEntries: 3 },
  { maxJsonDepth: 1 },
  { maxPages: 1 },
  { maxRequests: 1 },
])('honors cumulative/request work bounds %j', async (overrides) => {
  const r = reader(async (url) => {
    const next = new URL(url);
    next.searchParams.set('after', 'one');
    return Response.json([record], { headers: { link: `<${next}>; rel="next"` } });
  }, overrides);
  const result = await r.read(target);
  r.close();
  expect(result.complete).toBe(false);
  expect(result.reasons).toEqual(['budget']);
});
test('request deadlines and close settle even a transport that ignores cancellation', async () => {
  vi.useFakeTimers();
  try {
    const r = reader(async () => new Promise<Response>(() => {}));
    const pending = expect(r.read(target)).resolves.toMatchObject({ reasons: ['timeout'] });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    r.close();
    const other = reader(async () => new Promise<Response>(() => {}));
    const closed = other.read(target);
    other.close();
    expect(await closed).toMatchObject({ complete: false, reasons: ['unknown'] });
  } finally {
    vi.useRealTimers();
  }
});

test('JSON work is cumulative across reads and byte bounds cancel a streaming body', async () => {
  const r = reader(async () => Response.json([]), { maxJsonEntries: 1 });
  expect((await r.read(target)).complete).toBe(true);
  expect(await r.read({ ...target, version: '2' })).toMatchObject({
    complete: false,
    reasons: ['budget'],
  });
  r.close();
  let cancelled = false;
  const streamed = reader(
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(30));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    { maxResponseBytes: 20 },
  );
  expect(await streamed.read(target)).toMatchObject({ complete: false, reasons: ['budget'] });
  expect(cancelled).toBe(true);
  streamed.close();
});
test('large deadlines do not overflow to an immediate timeout and cancellation cleans up timers', async () => {
  vi.useFakeTimers();
  try {
    const r = reader(async () => new Promise<Response>(() => {}), {
      requestTimeoutMs: 3_000_000_000,
      totalTimeoutMs: 4_000_000_000,
    });
    let settled = false;
    const pending = r.read(target).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    r.close();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
test.each([
  new Response('not json', { headers: { 'content-type': 'application/json' } }),
  new Response('[]', { headers: { 'content-type': 'text/html' } }),
  new Response(null, { status: 302, headers: { location: 'https://example.com' } }),
])('malformed or redirected responses never establish absence', async (response) => {
  const r = reader(async () => response);
  expect((await r.read(target)).complete).toBe(false);
  r.close();
});

test.each([
  { type: 'malware' },
  { type: 'unreviewed' },
  { severity: 'urgent' },
  { html_url: 'https://user:password@github.com/advisories/GHSA-aaaa-bbbb-cccc' },
  {
    vulnerabilities: [
      { package: { ecosystem: 'pip', name: target.name }, vulnerable_version_range: '*' },
    ],
  },
  { vulnerabilities: [...record.vulnerabilities, ...record.vulnerabilities] },
])('unexpected advisory shape %j stays unknown', async (extra) => {
  const r = reader(async () => Response.json([{ ...record, ...extra }]));
  const result = await r.read(target);
  r.close();
  expect(result.complete).toBe(false);
  expect(result.records).toEqual([]);
});
test.each([
  ['medium', 'moderate'],
  ['unknown', undefined],
  [null, undefined],
] as const)('normalizes %s without inventing a score', async (severity, expected) => {
  const r = reader(async () =>
    Response.json([{ ...record, severity, withdrawn_at: '2026-01-01T00:00:00Z' }]),
  );
  const result = await r.read(target);
  r.close();
  expect(result.complete).toBe(true);
  expect(result.records[0]).toMatchObject({ withdrawn: true });
  expect(result.records[0].severity).toBe(expected);
});
test('a malformed later record preserves an independently validated positive prefix', async () => {
  const r = reader(async () => Response.json([record, { ...record, severity: 'urgent' }]));
  const result = await r.read(target);
  r.close();
  expect(result.complete).toBe(false);
  expect(result.records).toHaveLength(1);
  expect(result.status).toBe('partial');
});
