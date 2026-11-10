import { expect, test, vi } from 'vite-plus/test';
import { authenticatedFetch, createEventReads, publicFetch, researchFetch } from './adapters.js';
import { createGithubTransport, W2_GITHUB_LIMITS } from './runtime.js';
import { createGithubSnapshotReads } from './snapshot.js';
import { createTestClaimStore } from './review.js';

const repository = { id: 101, owner: 'example', name: 'consumer' };

function transportFor(respond: (url: string) => Response) {
  return createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async (url) => respond(url),
  });
}

test('turns transport reads into the thrown-on-failure reads T1 expects', async () => {
  const claims = createTestClaimStore();
  const reads = createEventReads(
    transportFor((url) =>
      url.endsWith('/pulls/42')
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify({ url })),
    ),
    claims,
  );
  await expect(reads.readRun(repository, 401)).resolves.toEqual({
    url: 'https://api.github.com/repos/example/consumer/actions/runs/401',
  });
  await expect(reads.readWorkflow(repository, 301)).resolves.toEqual({
    url: 'https://api.github.com/repos/example/consumer/actions/workflows/301',
  });
  await expect(reads.readComparison(repository, 'a'.repeat(40), 'b'.repeat(40))).resolves.toEqual({
    url: `https://api.github.com/repos/example/consumer/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`,
  });
  await expect(reads.readPullRequest(repository, 42)).rejects.toThrow();
});

test('reports replay state from the claim store', async () => {
  const claims = createTestClaimStore();
  const reads = createEventReads(
    transportFor(() => new Response('{}')),
    claims,
  );
  const identity = [101, 301, 401, 1, 42, 'a'.repeat(40)] as const;
  await expect(reads.readReplay(identity)).resolves.toMatchObject({ state: 'unseen' });
  await claims.claim(identity);
  await expect(reads.readReplay(identity)).resolves.toMatchObject({ state: 'claimed' });
});

test('adds the read token only to the GitHub API origin and refuses every other URL', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
  const authed = authenticatedFetch('read-token', fetch);
  await authed('https://api.github.com/repos/example/consumer', {
    headers: { accept: 'application/vnd.github+json' },
  });
  const init = fetch.mock.calls[0][1];
  expect(Object.fromEntries(new Headers(init.headers))).toEqual({
    accept: 'application/vnd.github+json',
    authorization: 'Bearer read-token',
  });
  expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });

  for (const url of [
    'https://registry.npmjs.org/x',
    'https://api.github.com.evil.example/x',
    'http://api.github.com/x',
    'https://user@api.github.com/x',
    'https://uploads.github.com/x',
  ])
    await expect(authed(url, {})).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

test('never lets a credential reach a public source', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
  const open = publicFetch(fetch);
  await open('https://registry.npmjs.org/x', {
    headers: {
      Authorization: 'Bearer leaked',
      Cookie: 'a=b',
      'Proxy-Authorization': 'Basic leaked',
      'X-Other': '1',
      accept: 'text/plain',
    },
  });
  const init = fetch.mock.calls[0][1];
  expect(Object.fromEntries(new Headers(init.headers))).toEqual({
    'x-other': '1',
    accept: 'text/plain',
  });
  expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
  await expect(open('http://registry.npmjs.org/x', {})).rejects.toThrow();
  await expect(open('https://user:pw@registry.npmjs.org/x', {})).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

test('fails without echoing the token in the error', async () => {
  const authed = authenticatedFetch('sentinel-read-token', async () => new Response('{}'));
  await expect(authed('https://example.com/', {})).rejects.toThrow(/^(?!.*sentinel-read-token)/u);
});

test('keeps event verification reads available after the snapshot share is exhausted', async () => {
  const transport = transportFor(() => new Response('{"ok":true}'));
  const reads = createEventReads(transport, createTestClaimStore());
  const snapshot = createGithubSnapshotReads(transport);
  for (let index = 0; index < W2_GITHUB_LIMITS.snapshot.maxRequests; index += 1)
    await snapshot.readBlob(repository, 'a'.repeat(40));
  await expect(snapshot.readBlob(repository, 'a'.repeat(40))).resolves.toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  for (let index = 0; index < W2_GITHUB_LIMITS.freshness.maxRequests; index += 1)
    await expect(reads.readRun(repository, 401)).resolves.toEqual({ ok: true });
  await expect(reads.readRun(repository, 401)).rejects.toThrow();
});

test('adds the read token to research requests for api.github.com only', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
  const research = researchFetch('read-token', fetch);
  await research('https://api.github.com/advisories?affects=a%401', {
    headers: { accept: 'application/json' },
  });
  expect(Object.fromEntries(new Headers(fetch.mock.calls[0][1].headers))).toEqual({
    accept: 'application/json',
    authorization: 'Bearer read-token',
  });
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual' });

  for (const url of [
    'https://registry.npmjs.org/x',
    'https://pypi.org/pypi/x/1/json',
    'https://api.github.com.evil.example/x',
    'https://github.com/example/repo',
    'https://uploads.github.com/x',
    'https://raw.githubusercontent.com/example/repo/main/x',
  ]) {
    fetch.mockClear();
    await research(url, { headers: { Authorization: 'Bearer caller-supplied' } });
    const sent = Object.fromEntries(new Headers(fetch.mock.calls[0][1].headers));
    expect(sent, url).not.toHaveProperty('authorization');
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual' });
  }
  await expect(research('http://api.github.com/x', {})).rejects.toThrow();
  await expect(research('https://user@api.github.com/x', {})).rejects.toThrow();
});
