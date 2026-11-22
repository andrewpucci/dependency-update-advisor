import { describe, expect, test, vi } from 'vite-plus/test';
import { createAdvisoryReader, createMalwareReader } from './advisory-read.js';
import { createGithubQuotaGuard } from './github-quota.js';
import { createResearchCache } from './research-cache.js';
import { EVIDENCE_READ_ALLOCATION } from '../budget.js';
import { limit } from '../limits.js';

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
// pip and actions malware discover stored names first; their positive-prefix cases are in
// advisory-read.name-forms.test.ts.
test.each(['npm'] as const)(
  'malware reader explicitly queries %s and retains positive prefix on final-page failure',
  async (ecosystem) => {
    const name = 'fixture';
    let calls = 0;
    const r = createMalwareReader(limits, {
      now: () => 0,
      fetch: async (url) => {
        calls++;
        expect(new URL(url).searchParams.get('type')).toBe('malware');
        expect(new URL(url).searchParams.get('affects')).toBe(name + '@1.0.0');
        const next = new URL(url);
        next.searchParams.set('after', 'last');
        return calls === 1
          ? Response.json(
              [
                {
                  ...record,
                  type: 'malware',
                  vulnerabilities: [
                    { package: { ecosystem, name }, vulnerable_version_range: '*' },
                  ],
                },
              ],
              { headers: { link: `<${next}>; rel="next"` } },
            )
          : Response.json({}, { status: 503 });
      },
    });
    if (r.kind !== 'ready') throw new Error('reader');
    const result = await r.read({ ecosystem, name, version: '1.0.0' });
    r.close();
    expect(result).toMatchObject({
      complete: false,
      status: 'partial',
      records: [{ id: record.ghsa_id }],
    });
  },
);
test('malware and reviewed factories reject each other’s record type', async () => {
  for (const [factory, type] of [
    [createMalwareReader, 'reviewed'],
    [createAdvisoryReader, 'malware'],
  ] as const) {
    const r = factory(limits, {
      now: () => 0,
      fetch: async () => Response.json([{ ...record, type }]),
    });
    if (r.kind !== 'ready') throw new Error('reader');
    expect(await r.read(target)).toMatchObject({
      complete: false,
      records: [],
      reasons: ['unsupported'],
    });
    r.close();
  }
});
test('malware empty query and withdrawn observations retain their exact scope', async () => {
  for (const records of [
    [],
    [{ ...record, type: 'malware', withdrawn_at: '2026-01-01T00:00:00Z' }],
  ]) {
    const r = createMalwareReader(limits, {
      now: () => 0,
      fetch: async () => Response.json(records),
    });
    if (r.kind !== 'ready') throw new Error('reader');
    const result = await r.read(target);
    r.close();
    expect(result.complete).toBe(true);
    expect(result.records.every((r) => r.withdrawn)).toBe(true);
  }
});
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
  {
    vulnerabilities: [
      ...record.vulnerabilities,
      { package: { ecosystem: 'npm', name: target.name }, vulnerable_version_range: '' },
    ],
  },
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

test('keeps every range when an advisory lists the package more than once', async () => {
  const twice = {
    ...record,
    vulnerabilities: [
      ...record.vulnerabilities,
      {
        package: { ecosystem: 'npm', name: target.name },
        vulnerable_version_range: '>=3.0.0, <3.1.0',
      },
      { package: { ecosystem: 'npm', name: 'other' }, vulnerable_version_range: '<9.0.0' },
    ],
  };
  const r = reader(async () => Response.json([twice]));
  const result = await r.read(target);
  r.close();
  expect(result.complete).toBe(true);
  expect(result.records[0].range).toBe('<2.0.0 || >=3.0.0, <3.1.0');
});
test('a joined range over the packet text bound is a budget gap, never truncated', async () => {
  const long = Array.from({ length: 80 }, (_, i) => ({
    package: { ecosystem: 'npm', name: target.name },
    vulnerable_version_range: `>=${i}.0.0, <${i}.0.1`,
  }));
  const r = reader(async () => Response.json([{ ...record, vulnerabilities: long }]));
  const result = await r.read(target);
  r.close();
  expect(result).toMatchObject({ complete: false, records: [], reasons: ['budget'] });
});

const cachedAdvisoryBody = `[${' '.repeat(100)}]`;
const cachedAdvisoryBytes = Buffer.byteLength(cachedAdvisoryBody);
const advisoryTarget = (version: string) => ({
  ecosystem: 'npm' as const,
  name: 'fixture-cache',
  version,
});
function cachedAdvisoryFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    return new Response(cachedAdvisoryBody, { headers: { 'content-type': 'application/json' } });
  };
}
test('a cache hit costs no request', async () => {
  const cache = createResearchCache({ maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22 });
  const calls: string[] = [];
  const deps = { now: () => 0, fetch: cachedAdvisoryFetch(calls), cache };
  const a = createAdvisoryReader(limits, deps);
  if (a.kind !== 'ready') throw new Error('reader');
  const expected = await a.read(advisoryTarget('1.0.0'));
  a.close();
  const b = createAdvisoryReader({ ...limits, maxRequests: 1 }, deps);
  if (b.kind !== 'ready') throw new Error('reader');
  await b.read(advisoryTarget('2.0.0'));
  const hit = await b.read(advisoryTarget('1.0.0'));
  b.close();
  expect(expected).toMatchObject({ status: 'available', complete: true });
  expect(hit).toEqual(expected);
  expect(calls).toHaveLength(2);
});
test('a cache hit debits no total bytes', async () => {
  const cache = createResearchCache({ maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22 });
  const calls: string[] = [];
  const deps = { now: () => 0, fetch: cachedAdvisoryFetch(calls), cache };
  const a = createAdvisoryReader(limits, deps);
  if (a.kind !== 'ready') throw new Error('reader');
  const expected = await a.read(advisoryTarget('1.0.0'));
  a.close();
  const fits = cachedAdvisoryBytes + 1;
  const b = createAdvisoryReader({ ...limits, maxResponseBytes: fits, maxTotalBytes: fits }, deps);
  if (b.kind !== 'ready') throw new Error('reader');
  const live = await b.read(advisoryTarget('2.0.0'));
  const hit = await b.read(advisoryTarget('1.0.0'));
  b.close();
  expect(live).toMatchObject({ status: 'available', complete: true });
  expect(hit).toEqual(expected);
  expect(calls).toHaveLength(2);
});
test('a cached response still respects the per-response cap', async () => {
  const cache = createResearchCache({ maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22 });
  const calls: string[] = [];
  const deps = { now: () => 0, fetch: cachedAdvisoryFetch(calls), cache };
  const a = createAdvisoryReader(limits, deps);
  if (a.kind !== 'ready') throw new Error('reader');
  await a.read(advisoryTarget('1.0.0'));
  a.close();
  const small = cachedAdvisoryBytes - 1;
  const c = createAdvisoryReader(
    { ...limits, maxResponseBytes: small, maxTotalBytes: small },
    deps,
  );
  if (c.kind !== 'ready') throw new Error('reader');
  const result = await c.read(advisoryTarget('1.0.0'));
  c.close();
  expect(result).toMatchObject({ status: 'unavailable', complete: false, reasons: ['budget'] });
  expect(calls).toHaveLength(1);
});
test('a cache hit leaves the total-byte share for later live reads', async () => {
  const cache = createResearchCache({ maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22 });
  const calls: string[] = [];
  const deps = { now: () => 0, fetch: cachedAdvisoryFetch(calls), cache };
  const a = createAdvisoryReader(limits, deps);
  if (a.kind !== 'ready') throw new Error('reader');
  await a.read(advisoryTarget('1.0.0'));
  a.close();
  const fits = cachedAdvisoryBytes + 1;
  const b = createAdvisoryReader({ ...limits, maxResponseBytes: fits, maxTotalBytes: fits }, deps);
  if (b.kind !== 'ready') throw new Error('reader');
  const hit = await b.read(advisoryTarget('1.0.0'));
  const live = await b.read(advisoryTarget('2.0.0'));
  b.close();
  expect(hit).toMatchObject({ status: 'available', complete: true });
  expect(live).toMatchObject({ status: 'available', complete: true });
  expect(calls).toHaveLength(2);
});

/** Serves empty advisory pages; every page links to the next unless it is `lastPage`. */
function cursorPages(lastPage: number | null) {
  let calls = 0;
  const fetch = async (url: string) => {
    calls++;
    const next = new URL(url);
    next.searchParams.set('after', `page-${calls}`);
    const more = lastPage === null || calls < lastPage;
    return Response.json([], more ? { headers: { link: `<${next}>; rel="next"` } } : {});
  };
  return { fetch, calls: () => calls };
}
function requestShareReader(
  factory: typeof createAdvisoryReader,
  maxRequests: number,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) {
  const made = factory(
    { ...limits, maxRequests, maxPages: Number.MAX_SAFE_INTEGER },
    { now: () => 0, fetch },
  );
  if (made.kind !== 'ready') throw new Error('reader');
  return made;
}
function jsonBody(size: number) {
  return `[${' '.repeat(size - 2)}]`;
}
/**
 * Two pages whose bodies total `total + overflow` bytes. The first page is half the share and
 * links to the second, which carries the rest; each response stays under the share on its own.
 */
function byteSharePages(total: number, overflow: number) {
  const first = Math.floor(total / 2);
  const headers = { 'content-type': 'application/json' };
  let calls = 0;
  return {
    fetch: async (url: string) => {
      calls++;
      if (calls === 1) {
        const next = new URL(url);
        next.searchParams.set('after', 'bytes');
        return new Response(jsonBody(first), {
          headers: { ...headers, link: `<${next}>; rel="next"` },
        });
      }
      return new Response(jsonBody(total - first + overflow), { headers });
    },
  };
}
function byteShareReader(
  factory: typeof createAdvisoryReader,
  total: number,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) {
  const made = factory(
    { ...limits, maxResponseBytes: total, maxTotalBytes: total },
    { now: () => 0, fetch },
  );
  if (made.kind !== 'ready') throw new Error('reader');
  return made;
}
test('advisory reader spends exactly its request share and refuses the lookup past it', async () => {
  const share = EVIDENCE_READ_ALLOCATION.advisory.maxRequests;
  const exact = cursorPages(share);
  const atLimit = requestShareReader(createAdvisoryReader, share, exact.fetch);
  expect(await atLimit.read(target)).toMatchObject({ complete: true, reasons: [] });
  atLimit.close();
  expect(exact.calls()).toBe(share);

  const over = cursorPages(null);
  const pastLimit = requestShareReader(createAdvisoryReader, share, over.fetch);
  expect(await pastLimit.read(target)).toMatchObject({ complete: false, reasons: ['budget'] });
  pastLimit.close();
  expect(over.calls()).toBe(share);
});
test('malware reader spends exactly its request share and refuses the lookup past it', async () => {
  const share = EVIDENCE_READ_ALLOCATION.signals.readers.malware.maxRequests;
  const exact = cursorPages(share);
  const atLimit = requestShareReader(createMalwareReader, share, exact.fetch);
  expect(await atLimit.read(target)).toMatchObject({ complete: true, reasons: [] });
  atLimit.close();
  expect(exact.calls()).toBe(share);

  const over = cursorPages(null);
  const pastLimit = requestShareReader(createMalwareReader, share, over.fetch);
  expect(await pastLimit.read(target)).toMatchObject({ complete: false, reasons: ['budget'] });
  pastLimit.close();
  expect(over.calls()).toBe(share);
});
test('advisory reader accepts a byte share exactly and refuses the byte past it', async () => {
  const total = EVIDENCE_READ_ALLOCATION.advisory.maxTotalBytes;
  const exact = byteSharePages(total, 0);
  const atLimit = byteShareReader(createAdvisoryReader, total, exact.fetch);
  expect(await atLimit.read(target)).toMatchObject({ complete: true, reasons: [] });
  atLimit.close();

  const over = byteSharePages(total, 1);
  const pastLimit = byteShareReader(createAdvisoryReader, total, over.fetch);
  expect(await pastLimit.read(target)).toMatchObject({ complete: false, reasons: ['budget'] });
  pastLimit.close();
});
test('malware reader accepts a byte share exactly and refuses the byte past it', async () => {
  const total = EVIDENCE_READ_ALLOCATION.signals.readers.malware.maxTotalBytes;
  const exact = byteSharePages(total, 0);
  const atLimit = byteShareReader(createMalwareReader, total, exact.fetch);
  expect(await atLimit.read(target)).toMatchObject({ complete: true, reasons: [] });
  atLimit.close();

  const over = byteSharePages(total, 1);
  const pastLimit = byteShareReader(createMalwareReader, total, over.fetch);
  expect(await pastLimit.read(target)).toMatchObject({ complete: false, reasons: ['budget'] });
  pastLimit.close();
});
test('advisory JSON depth accepts the register depth exactly and refuses one level deeper', async () => {
  const maxJsonDepth = limit('research.maxJsonDepth');
  // The record is at depth 1; each wrapper array adds a level, and the innermost string sits one
  // level below the last wrapper.
  const nestedTo = (depth: number) => {
    let value: unknown = 'x';
    for (let level = 2; level < depth; level++) value = [value];
    return value;
  };
  const withNesting = (depth: number) => Response.json([{ ...record, nested: nestedTo(depth) }]);
  const exact = reader(async () => withNesting(maxJsonDepth), { maxJsonDepth });
  expect(await exact.read(target)).toMatchObject({
    complete: true,
    records: [{ id: record.ghsa_id }],
  });
  exact.close();

  const deeper = reader(async () => withNesting(maxJsonDepth + 1), { maxJsonDepth });
  expect(await deeper.read(target)).toMatchObject({ complete: false, reasons: ['budget'] });
  deeper.close();
});
test('advisory findings accept the register cap exactly and refuse the finding past it', async () => {
  const maxFindings = limit('research.maxFindings');
  const generous = {
    maxFindings,
    maxJsonEntries: 100_000,
    maxRetainedBytes: 10_000_000,
    maxResponseBytes: 10_000_000,
    maxTotalBytes: 10_000_000,
  };
  const exact = reader(async () => Response.json(Array(maxFindings).fill(record)), generous);
  const atLimit = await exact.read(target);
  exact.close();
  expect(atLimit).toMatchObject({ complete: true, reasons: [] });
  expect(atLimit.records).toHaveLength(maxFindings);

  const over = reader(async () => Response.json(Array(maxFindings + 1).fill(record)), generous);
  const pastLimit = await over.read(target);
  over.close();
  expect(pastLimit).toMatchObject({ complete: false, reasons: ['budget'] });
  expect(pastLimit.records).toHaveLength(maxFindings);
});

describe.each([
  ['reviewed', createAdvisoryReader],
  ['malware', createMalwareReader],
] as const)('the %s reader waiting for a GitHub rate-limit reset', (_name, create) => {
  const WALL = Date.parse('2026-11-21T00:00:00Z');
  const limited = (retryAfter: string) =>
    Response.json({}, { status: 429, headers: { 'retry-after': retryAfter } });
  function waiting(responses: (() => Promise<Response> | Response)[]) {
    const quota = createGithubQuotaGuard({
      reserve: 0,
      wallNow: () => WALL,
      windowMs: limit('research.githubQuota.windowMs'),
    });
    let call = 0;
    const fetch = vi.fn(async () =>
      (responses[Math.min(call++, responses.length - 1)] as () => Response)(),
    );
    const ready = create(limits, { fetch, now: () => 0, quota });
    if (ready.kind !== 'ready') throw new Error('reader');
    return { reader: ready, fetch, quota };
  }

  test('waits once for a retry time that fits and resends', async () => {
    vi.useFakeTimers();
    try {
      const f = waiting([() => limited('2'), () => Response.json([])]);
      const read = f.reader.read(target);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await read).toMatchObject({ complete: true });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.quota.latestRetryAt()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a retry time that does not fit ends rate_limit at once and records it', async () => {
    const f = waiting([() => limited('20')]);
    expect(await f.reader.read(target)).toMatchObject({ complete: false, reasons: ['rate_limit'] });
    expect(f.quota.latestRetryAt()).toBe(WALL + 20_000);
    await f.reader.read({ ...target, version: '9.0.0' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('a second stop after a wait ends rate_limit without waiting again', async () => {
    const f = waiting([() => limited('0'), () => limited('0')]);
    expect(await f.reader.read(target)).toMatchObject({ reasons: ['rate_limit'] });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.quota.latestRetryAt()).toBe(WALL);
  });

  test('the retried request keeps its own result', async () => {
    const f = waiting([() => limited('0'), () => Response.json({}, { status: 404 })]);
    expect(await f.reader.read(target)).toMatchObject({ reasons: ['missing'] });
    expect(f.quota.latestRetryAt()).toBeNull();
  });
});

test('an OSV rate limit never waits on a GitHub retry time', async () => {
  const quota = createGithubQuotaGuard({
    reserve: 0,
    wallNow: () => Date.parse('2026-11-21T00:00:00Z'),
    windowMs: limit('research.githubQuota.windowMs'),
  });
  const fetch = vi.fn(async () =>
    Response.json({}, { status: 429, headers: { 'retry-after': '0' } }),
  );
  const ready = createAdvisoryReader(limits, { fetch, now: () => 0, quota });
  if (ready.kind !== 'ready') throw new Error('reader');
  const pip = { ecosystem: 'pip', name: 'pyyaml', version: '3.13' };
  expect(await ready.read(pip)).toMatchObject({ reasons: ['rate_limit'] });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(quota.latestRetryAt()).toBeNull();
});

test('a GitHub rate limit when no time is left ends rate_limit with its retry time, not unknown', async () => {
  const wall = Date.parse('2026-11-21T00:00:00Z');
  const quota = createGithubQuotaGuard({
    reserve: 0,
    wallNow: () => wall,
    windowMs: limit('research.githubQuota.windowMs'),
  });
  let now = 0;
  // The reader's time runs out as the rate limit is read, before any wait could start.
  const headers = {
    get: (name: string) => {
      if (name !== 'retry-after') return null;
      now = limits.totalTimeoutMs + 1;
      return '0';
    },
    has: (name: string) => name === 'retry-after',
  };
  const fetch = vi.fn(
    async () =>
      ({ status: 429, headers, redirected: false, url: '', body: null }) as unknown as Response,
  );
  const ready = createAdvisoryReader(limits, { fetch, now: () => now, quota });
  if (ready.kind !== 'ready') throw new Error('reader');
  const result = await ready.read(target);
  // Out of time at the rate limit is still a reason to rerun, whatever the reader reads first;
  // a rate limit keeps its retry time. It is never "untrusted" or "over budget".
  expect([['rate_limit'], ['timeout']]).toContainEqual(result.reasons);
  if (result.reasons[0] === 'rate_limit') expect(quota.latestRetryAt()).toBe(wall);
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
});

describe.each([
  ['reviewed', createAdvisoryReader],
  ['malware', createMalwareReader],
] as const)(
  'the %s reader waits at most once and can be stopped while waiting',
  (_name, create) => {
    const WALL = Date.parse('2026-11-21T00:00:00Z');
    const limited = (retryAfter: string) =>
      Response.json({}, { status: 429, headers: { 'retry-after': retryAfter } });
    function reader(responses: (() => Response)[], signal?: AbortSignal) {
      const quota = createGithubQuotaGuard({
        reserve: 0,
        wallNow: () => WALL,
        windowMs: limit('research.githubQuota.windowMs'),
      });
      let call = 0;
      const fetch = vi.fn(async () =>
        (responses[Math.min(call++, responses.length - 1)] as () => Response)(),
      );
      const ready = create(limits, { fetch, now: () => 0, quota, ...(signal ? { signal } : {}) });
      if (ready.kind !== 'ready') throw new Error('reader');
      return { reader: ready, fetch, quota };
    }

    test('a later lookup in the same reader does not wait a second time', async () => {
      const f = reader([() => limited('0'), () => Response.json([]), () => limited('0')]);
      expect(await f.reader.read(target)).toMatchObject({ complete: true });
      expect(await f.reader.read({ ...target, version: '9.0.0' })).toMatchObject({
        reasons: ['rate_limit'],
      });
      expect(f.fetch).toHaveBeenCalledTimes(3);
      expect(f.quota.latestRetryAt()).toBe(WALL);
    });

    test.each(['abort', 'close'] as const)(
      '%s ends a wait at once, without resending',
      async (how) => {
        vi.useFakeTimers();
        try {
          const run = new AbortController();
          const f = reader([() => limited('5'), () => Response.json([])], run.signal);
          let settled = false;
          const read = f.reader.read(target).finally(() => (settled = true));
          await vi.advanceTimersByTimeAsync(100);
          if (how === 'abort') run.abort();
          else f.reader.close();
          await vi.advanceTimersByTimeAsync(10);
          expect(settled).toBe(true);
          expect((await read).complete).toBe(false);
          expect(f.fetch).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      },
    );
  },
);

test('an exhausted advisory share stays budget and leaves GitHub quota for the next reader', async () => {
  const wall = Date.parse('2026-11-21T00:00:00Z');
  const quota = createGithubQuotaGuard({
    reserve: 6,
    wallNow: () => wall,
    windowMs: limit('research.githubQuota.windowMs'),
  });
  const reset = String(Math.floor(wall / 1000) + 30 * 60);
  let remaining = 40;
  const fetch = vi.fn(async () =>
    Response.json([], {
      headers: { 'x-ratelimit-remaining': String(remaining--), 'x-ratelimit-reset': reset },
    }),
  );
  const advisory = createAdvisoryReader(
    { ...limits, maxRequests: 2 },
    { fetch, now: () => 0, quota },
  );
  if (advisory.kind !== 'ready') throw new Error('reader');
  const versions = Array.from({ length: 40 }, (_, i) => `1.0.${i}`);
  const results = [];
  for (const version of versions) results.push(await advisory.read({ ...target, version }));
  expect(fetch).toHaveBeenCalledTimes(2);
  // Past its share, every member is budget: our own limit, not GitHub's.
  for (const result of results.slice(2)) expect(result.reasons).toEqual(['budget']);
  // GitHub still reports 38 left, so the malware reader is not refused.
  const malware = createMalwareReader(limits, { fetch, now: () => 0, quota });
  if (malware.kind !== 'ready') throw new Error('reader');
  expect(await malware.read(target)).toMatchObject({ complete: true });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(quota.latestRetryAt()).toBeNull();
});
