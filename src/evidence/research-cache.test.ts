import { expect, test } from 'vite-plus/test';
import { createResearchCache } from './research-cache.js';
import { RESEARCH_CACHE_LIMITS } from '../budget.js';

const LIMITS = { maxEntryBytes: 1024, maxTotalBytes: 4096 };

test('returns identical bytes and status for an identical request', async () => {
  const cache = createResearchCache(LIMITS);
  const key = cache.key('GET', 'https://api.github.com/repos/o/r', { accept: 'application/json' });
  await cache.store(
    key,
    new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
  );

  const first = cache.lookup(key);
  const second = cache.lookup(key);
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(first).not.toBe(second);
  expect(await first?.text()).toBe('hello');
  expect(await second?.text()).toBe('hello');
  expect(first?.status).toBe(200);
  expect(first?.headers.get('content-type')).toBe('text/plain');
});

test('keys on the full query string, so advisory and malware queries never collide', async () => {
  const cache = createResearchCache(LIMITS);
  const malware = cache.key('GET', 'https://api.github.com/advisories?type=malware&affects=a@1');
  const reviewed = cache.key('GET', 'https://api.github.com/advisories?type=reviewed&affects=a@1');
  expect(malware).not.toBe(reviewed);

  await cache.store(malware, new Response('[]', { status: 200 }));
  expect(cache.lookup(reviewed)).toBeUndefined();
});

test('keys on the version in the URL', () => {
  const cache = createResearchCache(LIMITS);
  expect(cache.key('GET', 'https://registry.npmjs.org/pkg/1.0.0')).not.toBe(
    cache.key('GET', 'https://registry.npmjs.org/pkg/1.0.1'),
  );
});

test('keys on headers but never holds an authorization value', () => {
  const cache = createResearchCache(LIMITS);
  const url = 'https://api.github.com/advisories';

  expect(cache.key('GET', url, { accept: 'a' })).not.toBe(cache.key('GET', url, { accept: 'b' }));

  const withToken = cache.key('GET', url, { authorization: 'Bearer SECRET-TOKEN' });
  expect(withToken).not.toContain('SECRET-TOKEN');
  expect(withToken).not.toBe(cache.key('GET', url, { authorization: 'Bearer OTHER-TOKEN' }));

  expect(cache.key('GET', url, { Accept: 'a' })).toBe(cache.key('GET', url, { accept: 'a' }));
});

test('caches 404 but not 429 or 500', async () => {
  const cache = createResearchCache(LIMITS);

  const notFoundKey = cache.key('GET', 'https://registry.npmjs.org/missing');
  await cache.store(notFoundKey, new Response('nope', { status: 404 }));
  expect(cache.lookup(notFoundKey)).toBeDefined();

  for (const status of [429, 500]) {
    const key = cache.key('GET', `https://registry.npmjs.org/status-${status}`);
    const response = new Response('x', { status });
    expect(await cache.store(key, response)).toBe(response);
    expect(cache.lookup(key)).toBeUndefined();
  }
});

test('does not cache an oversized body but still returns all of it', async () => {
  const cache = createResearchCache({ maxEntryBytes: 4, maxTotalBytes: 4096 });
  const key = cache.key('GET', 'https://registry.npmjs.org/big');

  const returned = await cache.store(key, new Response('abcdefgh', { status: 200 }));
  expect(await returned.text()).toBe('abcdefgh');
  expect(cache.lookup(key)).toBeUndefined();
});

test('respects the total byte limit', async () => {
  const cache = createResearchCache({ maxEntryBytes: 6, maxTotalBytes: 6 });
  const key1 = cache.key('GET', 'https://registry.npmjs.org/a');
  const key2 = cache.key('GET', 'https://registry.npmjs.org/b');

  await cache.store(key1, new Response('abcd', { status: 200 }));
  expect(cache.lookup(key1)).toBeDefined();

  const returned = await cache.store(key2, new Response('efgh', { status: 200 }));
  expect(await returned.text()).toBe('efgh');
  expect(cache.lookup(key2)).toBeUndefined();
});

test('separate caches share nothing', async () => {
  const cacheA = createResearchCache(LIMITS);
  const cacheB = createResearchCache(LIMITS);
  const key = cacheA.key('GET', 'https://registry.npmjs.org/pkg');

  await cacheA.store(key, new Response('one', { status: 200 }));
  expect(cacheA.lookup(key)).toBeDefined();
  expect(cacheB.lookup(key)).toBeUndefined();
});
test('stores an entry of exactly the register entry cap and passes one byte more through', async () => {
  const { maxEntryBytes } = RESEARCH_CACHE_LIMITS;
  const cache = createResearchCache({ ...RESEARCH_CACHE_LIMITS });
  const atLimit = cache.key('GET', 'https://registry.npmjs.org/entry-at-cap');
  await cache.store(atLimit, new Response(new Uint8Array(maxEntryBytes), { status: 200 }));
  expect(cache.lookup(atLimit)).toBeDefined();

  const overLimit = cache.key('GET', 'https://registry.npmjs.org/entry-over-cap');
  const returned = await cache.store(
    overLimit,
    new Response(new Uint8Array(maxEntryBytes + 1), { status: 200 }),
  );
  expect((await returned.arrayBuffer()).byteLength).toBe(maxEntryBytes + 1);
  expect(cache.lookup(overLimit)).toBeUndefined();
});
test('stores entries up to exactly the register total and passes the next byte through', async () => {
  const { maxEntryBytes, maxTotalBytes } = RESEARCH_CACHE_LIMITS;
  const cache = createResearchCache({ ...RESEARCH_CACHE_LIMITS });
  let stored = 0;
  for (let i = 0; stored < maxTotalBytes; i++) {
    const size = Math.min(maxEntryBytes, maxTotalBytes - stored);
    const key = cache.key('GET', `https://registry.npmjs.org/fill-${i}`);
    await cache.store(key, new Response(new Uint8Array(size), { status: 200 }));
    expect(cache.lookup(key)).toBeDefined();
    stored += size;
  }

  const overTotal = cache.key('GET', 'https://registry.npmjs.org/one-past-total');
  const returned = await cache.store(overTotal, new Response(new Uint8Array(1), { status: 200 }));
  expect((await returned.arrayBuffer()).byteLength).toBe(1);
  expect(cache.lookup(overTotal)).toBeUndefined();
});
