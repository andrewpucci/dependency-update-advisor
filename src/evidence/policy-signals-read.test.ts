import { expect, test, vi } from 'vite-plus/test';
import { createPolicySignalReader } from './policy-signals-read.js';
import { PACKET_LIMITS } from '../schema.js';
import { isPlainObject } from './common.js';
const limits = {
  maxRequests: 10,
  maxResponseBytes: 20000,
  maxTotalBytes: 100000,
  maxJsonEntries: 2000,
  maxJsonDepth: 32,
  maxRetainedBytes: 100000,
  maxWork: 100000,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10000,
};
const query = {
  kind: 'pypi',
  name: 'fixture',
  version: '2.0rc1',
  source: { kind: 'registry', identity: 'https://pypi.org/simple' },
};
test('dot-segment versions cannot change the locally constructed metadata route', async () => {
  let requests = 0;
  const r = createPolicySignalReader(limits, {
    now: () => 0,
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  if (r.kind !== 'ready') throw new Error('reader');
  for (const version of ['.', '..'])
    expect(await r.read({ ...query, version })).toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    });
  expect(requests).toBe(0);
  r.close();
});
test.each(['maxJsonDepth', 'maxJsonEntries', 'maxWork', 'maxRetainedBytes'] as const)(
  'optional %s remains a bounded failure',
  async (field) => {
    const r = createPolicySignalReader(
      { ...limits, [field]: 1 },
      {
        now: () => 0,
        fetch: async () =>
          Response.json({ info: { name: query.name, version: query.version }, urls: [] }),
      },
    );
    if (r.kind !== 'ready') throw new Error('reader');
    expect(await r.read(query)).toEqual({ kind: 'unavailable', reason: 'budget' });
    r.close();
  },
);
test('close and timeout cancel ignored-signal fetches without leaking timers', async () => {
  vi.useFakeTimers();
  try {
    for (const close of [true, false]) {
      let signal: AbortSignal | undefined;
      const r = createPolicySignalReader(limits, {
        now: () => 0,
        fetch: async (_url, init) => {
          signal = init.signal as AbortSignal;
          return new Promise<Response>(() => {});
        },
      });
      if (r.kind !== 'ready') throw new Error('reader');
      const pending = r.read(query);
      if (close) r.close();
      else await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs);
      expect(await pending).toMatchObject({
        kind: 'unavailable',
        reason: close ? 'unknown' : 'timeout',
      });
      expect(signal?.aborted).toBe(true);
      r.close();
      expect(vi.getTimerCount()).toBe(0);
    }
  } finally {
    vi.useRealTimers();
  }
});
test('constructs exact public metadata routes, bounds JSON, and never forwards credentials', async () => {
  let requests = 0;
  const r = createPolicySignalReader(limits, {
    now: () => 0,
    fetch: async (url, init) => {
      requests++;
      expect(url).toBe('https://pypi.org/pypi/fixture/2.0rc1/json');
      expect(init.credentials).toBe('omit');
      expect(init.redirect).toBe('manual');
      expect(init.headers).toEqual({ accept: 'application/json' });
      return Response.json({ info: { name: 'fixture', version: '2.0rc1' }, urls: [] });
    },
  });
  if (r.kind !== 'ready') throw new Error('reader');
  expect(
    await r.read({
      ...query,
      source: { kind: 'registry', identity: 'https://private.example/simple' },
    }),
  ).toMatchObject({ kind: 'unavailable', reason: 'unsupported' });
  expect(requests).toBe(0);
  expect(await r.read(query)).toMatchObject({
    kind: 'data',
    data: { info: { version: '2.0rc1' } },
  });
  expect(await r.read(query)).toMatchObject({ kind: 'data' });
  expect(requests).toBe(1);
  r.close();
});
test('coalesces identical in-flight release reads into one immutable result', async () => {
  let resolve: ((response: Response) => void) | undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const r = createPolicySignalReader(limits, { now: () => 0, fetch });
  if (r.kind !== 'ready') throw new Error('reader');
  const first = r.read(query);
  await Promise.resolve();
  const second = r.read(query);
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve?.(Response.json({ info: { name: query.name, version: query.version }, urls: [] }));
  await expect(first).resolves.toEqual(await second);
  r.close();
});
test.each(['close', 'retention'] as const)(
  'returns a tagged %s failure to every coalesced caller',
  async (mode) => {
    let resolve: ((response: Response) => void) | undefined;
    const r = createPolicySignalReader(
      { ...limits, ...(mode === 'retention' ? { maxRetainedBytes: 1 } : {}) },
      {
        now: () => 0,
        fetch: () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      },
    );
    if (r.kind !== 'ready') throw new Error('reader');
    const first = r.read(query);
    await Promise.resolve();
    const second = r.read(query);
    if (mode === 'close') r.close();
    else resolve?.(Response.json({ info: { name: query.name, version: query.version }, urls: [] }));
    await expect(first).resolves.toEqual({
      kind: 'unavailable',
      reason: mode === 'close' ? 'unknown' : 'budget',
    });
    await expect(second).resolves.toEqual({
      kind: 'unavailable',
      reason: mode === 'close' ? 'unknown' : 'budget',
    });
    r.close();
  },
);
test('retains only the PyPI release fields used by upstream and policy evidence', async () => {
  const r = createPolicySignalReader(limits, {
    now: () => 0,
    fetch: async () =>
      Response.json({
        info: {
          name: query.name,
          version: query.version,
          description: 'Release description' + 'x'.repeat(PACKET_LIMITS.textBytes),
          repository: {
            url: 'https://github.com/fixture/project',
            directory: 'pkg',
            arbitrary: 'must not be retained',
          },
          project_urls: {
            Source: 'https://github.com/fixture/project',
            Documentation: 'https://docs.example.test',
          },
          yanked: false,
          license_expression: 'MIT',
          author_email: 'fixture@example.test',
        },
        urls: [
          {
            filename: 'fixture-2.0rc1.tar.gz',
            digests: { sha256: 'a'.repeat(64), md5: 'must not be retained' },
            upload_time_iso_8601: '2026-11-07T00:00:00Z',
            yanked: false,
            url: 'https://files.pythonhosted.org/fixture-2.0rc1.tar.gz',
          },
        ],
        arbitrary: { payload: 'must not be retained' },
      }),
  });
  if (r.kind !== 'ready') throw new Error('reader');
  const result = await r.read(query);
  expect(result).toMatchObject({
    kind: 'data',
    data: {
      info: {
        name: query.name,
        version: query.version,
        description:
          'Release description' +
          'x'.repeat(PACKET_LIMITS.textBytes - 'Release description'.length),
        project_urls: { Source: 'https://github.com/fixture/project' },
      },
      urls: [
        {
          filename: 'fixture-2.0rc1.tar.gz',
          digests: { sha256: 'a'.repeat(64) },
          upload_time_iso_8601: '2026-11-07T00:00:00Z',
          yanked: false,
        },
      ],
    },
  });
  if (result.kind !== 'data') throw new Error('metadata');
  if (
    !isPlainObject(result.data) ||
    !isPlainObject(result.data.info) ||
    !Array.isArray(result.data.urls)
  )
    throw new Error('projected metadata');
  expect(result.data).not.toHaveProperty('arbitrary');
  expect(result.data.info).not.toHaveProperty('author_email');
  expect(result.data.info.project_urls).not.toHaveProperty('Documentation');
  expect(result.data.info.repository).not.toHaveProperty('arbitrary');
  expect(Buffer.byteLength(result.data.info.description as string)).toBe(PACKET_LIMITS.textBytes);
  expect(result.data.urls[0]).not.toHaveProperty('url');
  expect(result.data.urls[0].digests).not.toHaveProperty('md5');
  r.close();
});
test.each([
  [403, 'permission'],
  [429, 'rate_limit'],
  [404, 'missing'],
  [302, 'unsupported'],
  [503, 'unknown'],
] as const)('keeps HTTP %s as a fixed optional reason', async (status, reason) => {
  const r = createPolicySignalReader(limits, {
    now: () => 0,
    fetch: async () => new Response('', { status }),
  });
  if (r.kind !== 'ready') throw new Error('reader');
  expect(await r.read(query)).toEqual({ kind: 'unavailable', reason });
  r.close();
});
test.each(['bytes', 'json', 'identity', 'redirect'] as const)(
  'rejects %s without metadata success',
  async (mode) => {
    const r = createPolicySignalReader(
      { ...limits, ...(mode === 'bytes' ? { maxResponseBytes: 2 } : {}) },
      {
        now: () => 0,
        fetch: async () =>
          mode === 'redirect'
            ? new Response('', { status: 307 })
            : new Response(
                mode === 'json'
                  ? 'broken'
                  : JSON.stringify({
                      info: { name: mode === 'identity' ? 'other' : 'fixture', version: '2.0rc1' },
                      urls: [],
                    }),
                { headers: { 'content-type': 'application/json' } },
              ),
      },
    );
    if (r.kind !== 'ready') throw new Error('reader');
    expect(await r.read(query)).toMatchObject({
      kind: 'unavailable',
      reason:
        mode === 'bytes'
          ? 'budget'
          : mode === 'identity'
            ? 'conflict'
            : mode === 'redirect'
              ? 'unsupported'
              : 'malformed',
    });
    r.close();
  },
);
