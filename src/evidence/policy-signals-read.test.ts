import { expect, test } from 'vite-plus/test';
import { createPolicySignalReader } from './policy-signals-read.js';
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
