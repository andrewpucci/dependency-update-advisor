import { expect, test } from 'vite-plus/test';
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
