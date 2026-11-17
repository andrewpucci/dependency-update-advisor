import { describe, expect, test, vi } from 'vite-plus/test';
import { AdvisoryFailure } from './advisory-read.js';
import { boundedGet } from './bounded-request.js';
import { createNpmPublishTimeReader } from './npm-publish-times.js';
import { createPolicySignalReader } from './policy-signals-read.js';
import { createResearchCache } from './research-cache.js';

const limits = {
  maxRequests: 4,
  maxResponseBytes: 10000,
  maxTotalBytes: 20000,
  maxJsonEntries: 1000,
  maxJsonDepth: 16,
  maxWork: 10000,
  maxRetainedBytes: 100000,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10000,
};
const readers = {
  publishTimes: {
    create: createNpmPublishTimeReader,
    query: {
      name: 'pkg',
      versions: ['1.0.0'],
      source: { kind: 'registry', identity: 'https://registry.npmjs.org' },
      evaluationTime: 0,
    },
  },
  policySignals: {
    create: createPolicySignalReader,
    query: {
      kind: 'pypi',
      name: 'pkg',
      version: '1.0.0',
      source: { kind: 'registry', identity: 'https://pypi.org/simple' },
    },
  },
};
const neverFetched = async (): Promise<Response> => {
  throw new Error('fetched');
};

test('releases a response that resolves after its request timeout', async () => {
  vi.useFakeTimers();
  try {
    let resolve: ((response: Response) => void) | undefined;
    let cancelled = false;
    const task = boundedGet(
      { now: () => 0, fetch: () => new Promise<Response>((done) => (resolve = done)) },
      { url: 'https://example.test/data', accept: 'application/json', timeoutMs: 1 },
      () => {},
      async (response) => response.json(),
    );
    const timedOut = expect(task).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    resolve?.(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('preserves a timeout when an abort-aware fetch rejects immediately', async () => {
  vi.useFakeTimers();
  try {
    const task = boundedGet(
      {
        now: () => 0,
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      },
      { url: 'https://example.test/data', accept: 'application/json', timeoutMs: 1 },
      () => {},
      async (response) => response.json(),
    );
    const timedOut = expect(task).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
  } finally {
    vi.useRealTimers();
  }
});

test.each(Object.keys(readers) as (keyof typeof readers)[])(
  '%s reader rejects incomplete or inconsistent limits',
  (name) => {
    const { create } = readers[name];
    const deps = { now: () => 0, fetch: neverFetched };
    for (const value of [
      null,
      { ...limits, maxWork: 0 },
      { ...limits, maxJsonDepth: 1.5 },
      { ...limits, totalTimeoutMs: undefined },
      { ...limits, maxResponseBytes: limits.maxTotalBytes + 1 },
      { ...limits, requestTimeoutMs: limits.totalTimeoutMs + 1 },
      { ...limits, requestTimeoutMs: 2 ** 31, totalTimeoutMs: 2 ** 31 },
    ])
      expect(create(value, deps)).toEqual({ kind: 'invalid' });
    expect(create(limits, { now: () => NaN, fetch: neverFetched })).toEqual({ kind: 'invalid' });
    const ready = create({ ...limits, extra: 1 }, deps);
    if (ready.kind !== 'ready') throw new Error('reader');
    expect(ready.limits).toEqual(limits);
    ready.close();
  },
);
test.each(Object.keys(readers) as (keyof typeof readers)[])(
  '%s reader fails a backwards clock or spent total time before fetching',
  async (name) => {
    const { create, query } = readers[name];
    for (const [later, reason] of [
      [-1, 'unknown'],
      [limits.totalTimeoutMs, 'timeout'],
    ] as const) {
      let reads = 0;
      const r = create(limits, { now: () => (reads++ ? later : 0), fetch: neverFetched });
      if (r.kind !== 'ready') throw new Error('reader');
      expect(await r.read(query)).toEqual({ kind: 'unavailable', reason });
      r.close();
    }
  },
);

test('sends a fixed JSON body as a credential-free POST and leaves GET unchanged', async () => {
  const seen: RequestInit[] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    seen.push(init);
    return Response.json({});
  };
  for (const json of [{ package: { name: 'pkg' }, version: '1.0.0' }, undefined])
    await boundedGet(
      { now: () => 0, fetch },
      {
        url: 'https://example.test/q',
        headers: { accept: 'application/json' },
        timeoutMs: 100,
        json,
      },
      () => {},
      async (response) => response.json(),
    );
  expect(seen[0]).toMatchObject({
    method: 'POST',
    redirect: 'manual',
    credentials: 'omit',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{"package":{"name":"pkg"},"version":"1.0.0"}',
  });
  expect(seen[1]).toMatchObject({
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    headers: { accept: 'application/json' },
  });
  expect(seen[1]).not.toHaveProperty('body');
});
test('a POST keeps the request timeout', async () => {
  vi.useFakeTimers();
  try {
    const task = boundedGet(
      { now: () => 0, fetch: () => new Promise<Response>(() => {}) },
      { url: 'https://example.test/q', accept: 'application/json', timeoutMs: 1, json: {} },
      () => {},
      async (response) => response.json(),
    );
    const timedOut = expect(task).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
  } finally {
    vi.useRealTimers();
  }
});

describe('research cache seam', () => {
  const url = 'https://example.test/data';
  const request = { url, accept: 'application/json', timeoutMs: 1000 };
  const cache = () => createResearchCache({ maxEntryBytes: 1024, maxTotalBytes: 4096 });
  const body = (response: Response) => response.text();
  const counting = (make: () => Response = () => new Response('payload')) => {
    let fetches = 0;
    return {
      fetch: async () => (fetches++, make()),
      get fetches() {
        return fetches;
      },
    };
  };

  test('a hit is not fetched or charged and is consumed as cached', async () => {
    const shared = cache();
    const source = counting();
    const charges: string[] = [];
    const seen: boolean[] = [];
    const read = (who: string) =>
      boundedGet(
        { now: () => 0, fetch: source.fetch, cache: shared },
        { ...request, charge: () => charges.push(who) },
        () => {},
        async (response, _aborted, cached) => (seen.push(cached), body(response)),
      );
    expect(await read('first')).toBe('payload');
    expect(await read('second')).toBe('payload');
    expect(source.fetches).toBe(1);
    expect(charges).toEqual(['first']);
    expect(seen).toEqual([false, true]);
  });

  test('without a cache every request is fetched and charged', async () => {
    const source = counting();
    let charges = 0;
    for (let i = 0; i < 2; i++)
      await boundedGet(
        { now: () => 0, fetch: source.fetch },
        { ...request, charge: () => charges++ },
        () => {},
        async (response, _aborted, cached) => (expect(cached).toBe(false), body(response)),
      );
    expect(source.fetches).toBe(2);
    expect(charges).toBe(2);
  });

  test('a failed charge stops the request before fetching', async () => {
    const source = counting();
    const task = boundedGet(
      { now: () => 0, fetch: source.fetch, cache: cache() },
      {
        ...request,
        charge: () => {
          throw new AdvisoryFailure('budget');
        },
      },
      () => {},
      body,
    );
    await expect(task).rejects.toMatchObject({ reason: 'budget' });
    expect(source.fetches).toBe(0);
  });

  test('a response that reports its own URL is stored, as real fetches do', async () => {
    const shared = cache();
    const source = counting(() =>
      Object.defineProperty(new Response('payload'), 'url', { value: url }),
    );
    for (let i = 0; i < 2; i++)
      expect(
        await boundedGet(
          { now: () => 0, fetch: source.fetch, cache: shared },
          request,
          () => {},
          body,
        ),
      ).toBe('payload');
    expect(source.fetches).toBe(1);
  });

  test('a redirected or relocated response reaches the reader unstored', async () => {
    for (const relocate of [
      (r: Response) => Object.defineProperty(r, 'redirected', { value: true }),
      (r: Response) => Object.defineProperty(r, 'url', { value: 'https://elsewhere.test/data' }),
    ]) {
      const shared = cache();
      const source = counting(() => relocate(new Response('payload')));
      const observed: { redirected: boolean; url: string }[] = [];
      for (let i = 0; i < 2; i++)
        await boundedGet(
          { now: () => 0, fetch: source.fetch, cache: shared },
          request,
          () => {},
          async (response) => {
            observed.push({ redirected: response.redirected, url: response.url });
            return body(response);
          },
        );
      expect(source.fetches).toBe(2);
      expect(observed.every((o) => o.redirected || o.url === 'https://elsewhere.test/data')).toBe(
        true,
      );
    }
  });

  test('a stalled body on a miss still times out', async () => {
    vi.useFakeTimers();
    try {
      const stalled = () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      const task = boundedGet(
        { now: () => 0, fetch: async () => stalled(), cache: cache() },
        { ...request, timeoutMs: 1 },
        () => {},
        (response, aborted) => Promise.race([response.text(), aborted]),
      );
      const timedOut = expect(task).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  test('different query strings and headers never share an entry', async () => {
    const shared = cache();
    const source = counting();
    const read = (target: string, headers?: Record<string, string>) =>
      boundedGet(
        { now: () => 0, fetch: source.fetch, cache: shared },
        headers ? { url: target, headers, timeoutMs: 1000 } : { ...request, url: target },
        () => {},
        body,
      );
    await read(url + '?type=malware');
    await read(url + '?type=reviewed');
    await read(url, { accept: 'application/vnd.github+json' });
    await read(url, { accept: 'application/json' });
    await read(url);
    expect(source.fetches).toBe(4);
  });
});
