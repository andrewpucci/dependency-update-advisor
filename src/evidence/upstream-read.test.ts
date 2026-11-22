import { describe, expect, test, vi } from 'vite-plus/test';
import { createNpmRegistryReader } from './npm-registry.js';
import { createResearchCache, type ResearchCache } from './research-cache.js';
import { createUpstreamReader } from './upstream-read.js';
import { EVIDENCE_READ_ALLOCATION } from '../budget.js';
import { createGithubQuotaGuard } from './github-quota.js';
import { limit } from '../limits.js';

const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const limits = {
  maxRequests: 30,
  maxPages: 10,
  maxTagCandidates: 20,
  maxTagDepth: 5,
  maxResponseBytes: 50_000,
  maxTotalBytes: 500_000,
  maxJsonEntries: 50_000,
  maxJsonDepth: 32,
  maxWork: 100_000,
  maxRetainedBytes: 500_000,
  maxAttempts: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const target = {
  kind: 'npm' as const,
  name: '@fixture/widget',
  version: '1.2.3',
  integrity,
  source: { kind: 'registry' as const, identity: 'https://registry.npmjs.org/widget.tgz' },
};
const document = {
  _id: '@fixture/widget@1.2.3',
  name: target.name,
  version: target.version,
  dist: { integrity },
  description: 'Version-specific package description.',
};
function setup(
  response: (url: string, init: RequestInit) => Promise<Response> = async () =>
    Response.json(document),
  overrides = {},
) {
  const fetch = vi.fn(response);
  const opened = createUpstreamReader({ ...limits, ...overrides }, { fetch, now: () => 0 });
  if (opened.kind !== 'ready') throw new Error('reader');
  return { reader: opened.reader, fetch };
}
test('integrity-bound npm reads remain credential-free and attempt-local', async () => {
  const f = setup();
  const r = await f.reader.read(target);
  expect(r).toMatchObject({ status: 'available', fetched: true, data: document });
  expect(f.fetch).toHaveBeenCalledWith(
    'https://registry.npmjs.org/%40fixture%2Fwidget/1.2.3',
    expect.objectContaining({ redirect: 'manual', credentials: 'omit' }),
  );
  expect(
    (
      await f.reader.read({
        ...target,
        integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64'),
      })
    ).reasons,
  ).toContain('conflict');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.reader.close();
  expect((await f.reader.read(target)).fetched).toBe(false);
});
test('unsupported sources and invalid limits perform no I/O', async () => {
  const f = setup();
  expect(
    (
      await f.reader.read({
        ...target,
        source: { kind: 'registry', identity: 'https://private.example/pkg' },
      })
    ).status,
  ).toBe('unavailable');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(
    createUpstreamReader({ ...limits, maxRequests: 0 }, { fetch: f.fetch, now: () => 0 }).kind,
  ).toBe('invalid');
  f.reader.close();
});
test.each([302, 429, 500])('HTTP %s is not successful empty evidence', async (status) => {
  const f = setup(
    async () => new Response('{}', { status, headers: { location: 'https://elsewhere.example' } }),
  );
  expect((await f.reader.read(target)).status).toBe('unavailable');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.reader.close();
});
test('stream and cumulative request bounds cover nested registry reads', async () => {
  const f = setup(undefined, { maxResponseBytes: 10 });
  expect((await f.reader.read(target)).reasons).toContain('budget');
  f.reader.close();
  const g = setup(undefined, { maxRequests: 1 });
  await g.reader.read(target);
  const second = await g.reader.read({ ...target, version: '1.2.4' });
  expect(second).toMatchObject({ fetched: false, reasons: ['budget'] });
  expect(g.fetch).toHaveBeenCalledTimes(1);
  g.reader.close();
});

test('exact public PyPI metadata validates both normalized identity and version', async () => {
  const f = setup(async () =>
    Response.json({
      info: { name: 'Fixture_Widget', version: '2.0rc1', description: 'Exact prerelease.' },
    }),
  );
  const py = {
    kind: 'pypi',
    name: 'fixture-widget',
    version: '2.0rc1',
    source: { kind: 'registry', identity: 'https://pypi.org/simple' },
  };
  expect(await f.reader.read(py)).toMatchObject({
    status: 'available',
    data: { description: 'Exact prerelease.' },
  });
  expect(f.fetch).toHaveBeenCalledWith(
    'https://pypi.org/pypi/fixture-widget/2.0rc1/json',
    expect.anything(),
  );
  expect((await f.reader.read({ ...py, version: '2.0' })).reasons).toContain('conflict');
  const calls = f.fetch.mock.calls.length;
  expect(
    (
      await f.reader.read({
        ...py,
        source: { kind: 'registry', identity: 'https://private.example/simple' },
      })
    ).status,
  ).toBe('unavailable');
  expect(f.fetch).toHaveBeenCalledTimes(calls);
  f.reader.close();
});

test('failed exact metadata is not retried for another identical request', async () => {
  const f = setup(async () => Response.json({}, { status: 500 }));
  const py = {
    kind: 'pypi',
    name: 'orbit',
    version: '1.0',
    source: { kind: 'registry', identity: 'https://pypi.org/simple' },
  };
  await f.reader.read(py);
  expect(await f.reader.read(py)).toMatchObject({ status: 'unavailable', fetched: false });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.reader.close();
});
test('cache retention is cumulative across individually small documents', async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json({
      info: {
        name: 'orbit',
        version: new URL(url).pathname.split('/')[3],
        description: 'x'.repeat(400),
      },
    }),
  );
  const opened = createUpstreamReader(
    { ...limits, maxRetainedBytes: 700 },
    { fetch, now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('reader');
  const py = {
    kind: 'pypi',
    name: 'orbit',
    version: '1.0',
    source: { kind: 'registry', identity: 'https://pypi.org/simple' },
  };
  expect((await opened.reader.read(py)).status).toBe('available');
  expect((await opened.reader.read({ ...py, version: '2.0' })).reasons).toContain('budget');
  opened.reader.close();
});
test('a damaged body after initial bytes retains a truncation reason', async () => {
  const f = setup(async () => {
    let first = true;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(new TextEncoder().encode('{"info":'));
          } else controller.error(new Error('network failure'));
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  expect((await f.reader.read(target)).reasons).toContain('truncated');
  f.reader.close();
});
test('closing the reader cancels a fetch that ignores its signal', async () => {
  const f = setup(() => new Promise<Response>(() => {}));
  const pending = f.reader.read(target);
  await Promise.resolve();
  f.reader.close();
  expect((await pending).status).toBe('unavailable');
});
test('nested npm cancellation aborts the upstream transport', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const opened = createUpstreamReader(limits, {
      now: () => {
        vi.advanceTimersByTime(1);
        return 0;
      },
      fetch: async (_url, init) => {
        signal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      },
    });
    if (opened.kind !== 'ready') throw new Error('reader');
    const pending = opened.reader.read(target);
    await vi.advanceTimersToNextTimerAsync();
    expect((await pending).status).toBe('unavailable');
    expect(signal?.aborted).toBe(true);
    opened.reader.close();
  } finally {
    vi.useRealTimers();
  }
});
test('an empty 429 body stops its host while independent registry research can succeed', async () => {
  const f = setup(async (url) =>
    new URL(url).hostname === 'pypi.org'
      ? new Response(null, { status: 429 })
      : Response.json(document),
  );
  const py = {
    kind: 'pypi',
    name: 'orbit',
    version: '1.0',
    source: { kind: 'registry', identity: 'https://pypi.org/simple' },
  };
  expect((await f.reader.read(py)).reasons).toEqual(['rate_limit']);
  expect(await f.reader.read({ ...py, version: '2.0' })).toMatchObject({
    fetched: false,
    reasons: ['rate_limit'],
  });
  expect((await f.reader.read(target)).status).toBe('available');
  expect(f.fetch).toHaveBeenCalledTimes(2);
  f.reader.close();
});
test.each([
  [{ message: 'Resource not accessible by integration' }, {}, 'permission'],
  [{ message: 'secondary rate limit' }, {}, 'rate_limit'],
  [{}, { 'x-ratelimit-remaining': '0' }, 'rate_limit'],
  [{}, {}, 'unknown'],
] as const)('403 uses bounded response context (%j)', async (data, headers, reason) => {
  const f = setup(async () => Response.json(data, { status: 403, headers }));
  expect((await f.reader.read(target)).reasons).toEqual([reason]);
  f.reader.close();
});

describe('run-scoped research cache', () => {
  const shared = () => createResearchCache({ maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 22 });
  const other = { ...target, name: '@fixture/other', version: '2.0.0' };
  const otherDocument = {
    ...document,
    _id: '@fixture/other@2.0.0',
    name: other.name,
    version: other.version,
  };
  const live = (status = 200) =>
    vi.fn(async (url: string) =>
      url.includes('other')
        ? Response.json(otherDocument)
        : status === 200
          ? Response.json(document)
          : new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
    );
  const registryRead = async (cache: ResearchCache, fetch: ReturnType<typeof live>) => {
    const registry = createNpmRegistryReader(
      { ...limits, maxRequests: 10 },
      { fetch, now: () => 0, cache },
    );
    if (registry.kind !== 'ready') throw new Error('registry');
    const { name, version, integrity: sri, source } = target;
    return registry.read({ name, version, integrity: sri, source });
  };
  const upstream = (cache: ResearchCache, fetch: ReturnType<typeof live>, overrides = {}) => {
    const opened = createUpstreamReader(
      { ...limits, ...overrides },
      { fetch, now: () => 0, cache },
    );
    if (opened.kind !== 'ready') throw new Error('reader');
    return opened.reader;
  };

  test('an npm document another reader cached costs upstream no request', async () => {
    const cache = shared();
    const fetch = live();
    expect((await registryRead(cache, fetch)).kind).toBe('metadata');
    const reader = upstream(cache, fetch, { maxRequests: 1 });
    expect(await reader.read(other)).toMatchObject({ status: 'available', fetched: true });
    expect(await reader.read(target)).toMatchObject({
      status: 'available',
      fetched: true,
      data: document,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a cached npm failure is still reported as fetched', async () => {
    const cache = shared();
    const fetch = live(404);
    expect(await registryRead(cache, fetch)).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(await upstream(cache, fetch).read(target)).toMatchObject({
      status: 'unavailable',
      fetched: true,
      reasons: ['missing'],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a cached response debits no total bytes', async () => {
    const cache = shared();
    const fetch = live();
    await registryRead(cache, fetch);
    const sizes = [document, otherDocument].map((d) => Buffer.byteLength(JSON.stringify(d)));
    const reader = upstream(cache, fetch, {
      maxResponseBytes: Math.max(...sizes),
      maxTotalBytes: sizes[0] + sizes[1] - 1,
    });
    expect(await reader.read(other)).toMatchObject({ status: 'available' });
    expect(await reader.read(target)).toMatchObject({ status: 'available', data: document });
  });

  test('a direct upstream hit costs no request or total bytes', async () => {
    const cache = shared();
    const info = (version: string) => ({ info: { name: 'fixture-widget', version } });
    const fetch = vi.fn(async (url: string) => Response.json(info(url.split('/')[5])));
    const py = (version: string) => ({
      kind: 'pypi',
      name: 'fixture-widget',
      version,
      source: { kind: 'registry', identity: 'https://pypi.org/simple' },
    });
    expect(await upstream(cache, fetch).read(py('1.0'))).toMatchObject({ status: 'available' });
    const size = Buffer.byteLength(JSON.stringify(info('1.0')));
    const reader = upstream(cache, fetch, {
      maxRequests: 1,
      maxResponseBytes: size,
      maxTotalBytes: 2 * size - 1,
    });
    expect(await reader.read(py('2.0'))).toMatchObject({ status: 'available' });
    expect(await reader.read(py('1.0'))).toMatchObject({ status: 'available', fetched: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a cached response still respects the per-response cap', async () => {
    const cache = shared();
    const fetch = live();
    await registryRead(cache, fetch);
    const size = Buffer.byteLength(JSON.stringify(document));
    const reader = upstream(cache, fetch, { maxResponseBytes: size - 1 });
    expect(await reader.read(target)).toMatchObject({ status: 'unavailable', reasons: ['budget'] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

test('an npm lookup past the request share reports budget', async () => {
  const other = { ...target, name: '@fixture/other', version: '2.0.0' };
  const f = setup(
    async (url) =>
      Response.json(
        url.includes('other')
          ? { ...document, _id: '@fixture/other@2.0.0', name: other.name, version: other.version }
          : document,
      ),
    { maxRequests: 1 },
  );
  expect(await f.reader.read(target)).toMatchObject({ status: 'available' });
  expect(await f.reader.read(other)).toMatchObject({ status: 'unavailable', reasons: ['budget'] });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
/** An npm document for the version named in the request path, padded to `size` bytes when given. */
function versionBody(url: string, size?: number) {
  const version = decodeURIComponent(url.split('/').pop() ?? '');
  const json = JSON.stringify({ ...document, _id: `@fixture/widget@${version}`, version });
  if (size === undefined) return json;
  // Whitespace after the opening brace keeps the document valid JSON at the exact size.
  return `{${' '.repeat(size - json.length)}${json.slice(1)}`;
}
const versionTarget = (version: string) => ({ ...target, version });
function requestShareBudget(share: number) {
  const f = setup(async (url) => Response.json(JSON.parse(versionBody(url))), {
    maxRequests: share,
  });
  return f;
}
test('upstream reader spends exactly its request share and refuses the request past it', async () => {
  const share = EVIDENCE_READ_ALLOCATION.upstream.maxRequests;
  const f = requestShareBudget(share);
  for (let i = 0; i < share; i++)
    expect(await f.reader.read(versionTarget(`1.0.${i}`))).toMatchObject({ status: 'available' });
  expect(await f.reader.read(versionTarget(`1.0.${share}`))).toMatchObject({
    status: 'unavailable',
    reasons: ['budget'],
  });
  expect(f.fetch).toHaveBeenCalledTimes(share);
  f.reader.close();
});
test('signals upstream reader spends exactly its request share and refuses the request past it', async () => {
  const share = EVIDENCE_READ_ALLOCATION.signals.readers.upstream.maxRequests;
  const f = requestShareBudget(share);
  for (let i = 0; i < share; i++)
    expect(await f.reader.read(versionTarget(`1.0.${i}`))).toMatchObject({ status: 'available' });
  expect(await f.reader.read(versionTarget(`1.0.${share}`))).toMatchObject({
    status: 'unavailable',
    reasons: ['budget'],
  });
  expect(f.fetch).toHaveBeenCalledTimes(share);
  f.reader.close();
});
/** Two npm reads whose bodies total `total + overflow` bytes; each body alone fits the share. */
function byteShareReader(total: number, overflow: number) {
  const first = Math.floor(total / 2);
  const sizes = [first, total - first + overflow];
  let calls = 0;
  return setup(
    async (url) =>
      new Response(versionBody(url, sizes[calls++]), {
        headers: { 'content-type': 'application/json' },
      }),
    { maxResponseBytes: total, maxTotalBytes: total },
  );
}
test('upstream reader accepts a byte share exactly and refuses the byte past it', async () => {
  const total = EVIDENCE_READ_ALLOCATION.upstream.maxTotalBytes;
  const exact = byteShareReader(total, 0);
  await exact.reader.read(versionTarget('1.0.0'));
  expect(await exact.reader.read(versionTarget('1.0.1'))).toMatchObject({ status: 'available' });
  exact.reader.close();

  const over = byteShareReader(total, 1);
  await over.reader.read(versionTarget('1.0.0'));
  expect(await over.reader.read(versionTarget('1.0.1'))).toMatchObject({
    status: 'unavailable',
    reasons: ['budget'],
  });
  over.reader.close();
});
test('signals upstream reader accepts a byte share exactly and refuses the byte past it', async () => {
  const total = EVIDENCE_READ_ALLOCATION.signals.readers.upstream.maxTotalBytes;
  const exact = byteShareReader(total, 0);
  await exact.reader.read(versionTarget('1.0.0'));
  expect(await exact.reader.read(versionTarget('1.0.1'))).toMatchObject({ status: 'available' });
  exact.reader.close();

  const over = byteShareReader(total, 1);
  await over.reader.read(versionTarget('1.0.0'));
  expect(await over.reader.read(versionTarget('1.0.1'))).toMatchObject({
    status: 'unavailable',
    reasons: ['budget'],
  });
  over.reader.close();
});

describe('waiting for a GitHub rate-limit reset', () => {
  const WALL = Date.parse('2026-11-21T00:00:00Z');
  const releases = (page: number) => ({
    kind: 'github',
    repository: 'fixture/action',
    resource: 'releases',
    perPage: 16,
    page,
  });
  const limited = (retryAfter: string) =>
    new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } });
  function waiting(responses: (() => Promise<Response> | Response)[], overrides = {}) {
    const wall = { now: WALL };
    const quota = createGithubQuotaGuard({
      reserve: 0,
      wallNow: () => wall.now,
      windowMs: limit('research.githubQuota.windowMs'),
    });
    const admitted: string[] = [];
    const spied = { ...quota, admit: (url: string) => (admitted.push(url), quota.admit(url)) };
    let call = 0;
    const fetch = vi.fn(async () =>
      (responses[Math.min(call++, responses.length - 1)] ?? (() => Response.json([])))(),
    );
    const opened = createUpstreamReader(
      { ...limits, ...overrides },
      { fetch, now: () => 0, quota: spied },
    );
    if (opened.kind !== 'ready') throw new Error('reader');
    return { reader: opened.reader, fetch, quota, admitted, wall };
  }

  test('waits once for a retry time that fits and resends the request', async () => {
    vi.useFakeTimers();
    try {
      const f = waiting([() => limited('2'), () => Response.json([])]);
      const read = f.reader.read(releases(1));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await read).toMatchObject({ status: 'available' });
      expect(f.fetch).toHaveBeenCalledTimes(2);
      // The resent request is checked by the guard like any other.
      expect(f.admitted).toHaveLength(2);
      // A stop resolved by a wait records no retry time.
      expect(f.quota.latestRetryAt()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a retry time that does not fit ends rate_limit at once and records the time', async () => {
    const f = waiting([() => limited('20')]);
    expect(await f.reader.read(releases(1))).toMatchObject({ reasons: ['rate_limit'] });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.quota.latestRetryAt()).toBe(WALL + 20_000);
    // A reader that stopped without waiting sends no more GitHub requests.
    expect(await f.reader.read(releases(2))).toMatchObject({
      fetched: false,
      reasons: ['rate_limit'],
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  test('a second stop after a wait ends rate_limit without waiting again', async () => {
    const f = waiting([() => limited('0'), () => limited('0')]);
    expect(await f.reader.read(releases(1))).toMatchObject({ reasons: ['rate_limit'] });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.quota.latestRetryAt()).toBe(WALL);
  });

  test('the retried request keeps its own result', async () => {
    const missing = waiting([() => limited('0'), () => new Response('{}', { status: 404 })]);
    expect(await missing.reader.read(releases(1))).toMatchObject({ reasons: ['missing'] });
    expect(missing.quota.latestRetryAt()).toBeNull();
    const hung = waiting([() => limited('0'), () => new Promise<Response>(() => {})], {
      requestTimeoutMs: 20,
    });
    expect(await hung.reader.read(releases(1))).toMatchObject({ reasons: ['timeout'] });
  });

  test('closing the reader ends the wait without resending', async () => {
    vi.useFakeTimers();
    try {
      const f = waiting([() => limited('5'), () => Response.json([])]);
      const read = f.reader.read(releases(1));
      await vi.advanceTimersByTimeAsync(100);
      f.reader.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect((await read).status).not.toBe('available');
      expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

test('a GitHub rate limit when no time is left ends rate_limit with its retry time', async () => {
  const wall = Date.parse('2026-11-21T00:00:00Z');
  const quota = createGithubQuotaGuard({
    reserve: 0,
    wallNow: () => wall,
    windowMs: limit('research.githubQuota.windowMs'),
  });
  let now = 0;
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
  const opened = createUpstreamReader(limits, { fetch, now: () => now, quota });
  if (opened.kind !== 'ready') throw new Error('reader');
  const releases = {
    kind: 'github',
    repository: 'fixture/action',
    resource: 'releases',
    perPage: 16,
    page: 1,
  };
  expect(await opened.reader.read(releases)).toMatchObject({ reasons: ['rate_limit'] });
  expect(quota.latestRetryAt()).toBe(wall);
  expect(fetch).toHaveBeenCalledTimes(1);
});

describe('waiting is bounded per reader, by time, by abort, and to GitHub', () => {
  const WALL = Date.parse('2026-11-21T00:00:00Z');
  const releases = (page: number) => ({
    kind: 'github',
    repository: 'fixture/action',
    resource: 'releases',
    perPage: 16,
    page,
  });
  const limited = (retryAfter: string) =>
    new Response('{}', { status: 429, headers: { 'retry-after': retryAfter } });
  function reader(
    responses: (() => Response)[],
    options: { overrides?: object; signal?: AbortSignal } = {},
  ) {
    const quota = createGithubQuotaGuard({
      reserve: 0,
      wallNow: () => WALL,
      windowMs: limit('research.githubQuota.windowMs'),
    });
    let call = 0;
    const fetch = vi.fn(async () =>
      (responses[Math.min(call++, responses.length - 1)] as () => Response)(),
    );
    const opened = createUpstreamReader(
      { ...limits, ...options.overrides },
      { fetch, now: () => 0, quota, ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (opened.kind !== 'ready') throw new Error('reader');
    return { reader: opened.reader, fetch, quota };
  }

  test('a later read in the same reader does not wait a second time', async () => {
    const f = reader([() => limited('0'), () => Response.json([]), () => limited('0')]);
    expect(await f.reader.read(releases(1))).toMatchObject({ status: 'available' });
    expect(f.quota.latestRetryAt()).toBeNull();
    expect(await f.reader.read(releases(2))).toMatchObject({ reasons: ['rate_limit'] });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.quota.latestRetryAt()).toBe(WALL);
  });

  test.each(['abort', 'close'] as const)(
    '%s ends a wait at once, without resending',
    async (how) => {
      vi.useFakeTimers();
      try {
        const run = new AbortController();
        const f = reader([() => limited('5'), () => Response.json([])], { signal: run.signal });
        let settled = false;
        const read = f.reader.read(releases(1)).finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(100);
        if (how === 'abort') run.abort();
        else f.reader.close();
        await vi.advanceTimersByTimeAsync(10);
        expect(settled).toBe(true);
        expect((await read).status).not.toBe('available');
        expect(f.fetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('a wait must leave one request timeout before the deadline', async () => {
    const overrides = { requestTimeoutMs: 2000, totalTimeoutMs: 10_000 };
    // 9 s plus a 2 s request is past the 10 s left: no wait.
    const late = reader([() => limited('9')], { overrides });
    expect(await late.reader.read(releases(1))).toMatchObject({ reasons: ['rate_limit'] });
    expect(late.fetch).toHaveBeenCalledTimes(1);
    expect(late.quota.latestRetryAt()).toBe(WALL + 9000);
    // 7 s plus 2 s fits.
    vi.useFakeTimers();
    try {
      const fits = reader([() => limited('7'), () => Response.json([])], { overrides });
      const read = fits.reader.read(releases(1));
      await vi.advanceTimersByTimeAsync(7000);
      expect(await read).toMatchObject({ status: 'available' });
      expect(fits.fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a registry rate limit never waits or records a retry time', async () => {
    const f = reader([() => limited('0')]);
    expect(await f.reader.read(target)).toMatchObject({ reasons: ['rate_limit'] });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.quota.latestRetryAt()).toBeNull();
  });
});
