import { expect, test, vi } from 'vite-plus/test';
import {
  authenticatedFetch,
  createEventReads,
  guardedFetch,
  publicFetch,
  researchFetch,
} from './adapters.js';
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

test("guards every request with the attempt: ownership first, the attempt signal merged with the caller's", async () => {
  const attempt = new AbortController();
  let owned = true;
  const seen: AbortSignal[] = [];
  const guarded = guardedFetch(
    async (_url, init) => {
      seen.push(init.signal as AbortSignal);
      return new Response('{}');
    },
    attempt,
    async () => owned,
  );
  const caller = new AbortController();
  await guarded('https://example.com/a', { signal: caller.signal });
  await guarded('https://example.com/b', {});
  expect(seen).toHaveLength(2);
  // A reader's own timeout still ends the request, and so does the attempt.
  caller.abort();
  expect(seen[0].aborted).toBe(true);
  expect(seen[1].aborted).toBe(false);
  attempt.abort();
  expect(seen[1].aborted).toBe(true);
  expect(seen[0]).not.toBe(seen[1]);
});

test('starts nothing once the attempt has ended or ownership is lost', async () => {
  const attempt = new AbortController();
  let owned = true;
  let checks = 0;
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
  const guarded = guardedFetch(fetch, attempt, async () => {
    checks += 1;
    return owned;
  });
  await guarded('https://example.com/a', {});
  owned = false;
  await expect(guarded('https://example.com/b', {})).rejects.toThrow();
  // Losing ownership ends the whole attempt, not just that request.
  expect(attempt.signal.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  const before = checks;
  await expect(guarded('https://example.com/c', {})).rejects.toThrow();
  // An ended attempt short-circuits without asking again.
  expect(checks).toBe(before);
  expect(fetch).toHaveBeenCalledOnce();
});

test('remembers the fixed reason of the last failed read until it is cleared', async () => {
  const reads = createEventReads(
    transportFor((url) =>
      url.endsWith('/pulls/42') ? new Response('{}', { status: 404 }) : new Response('{}'),
    ),
    createTestClaimStore(),
  );
  expect(reads.failureReason()).toBeNull();
  await expect(reads.readPullRequest(repository, 42)).rejects.toThrow();
  expect(reads.failureReason()).toBe('missing');
  await expect(reads.readRun(repository, 401)).resolves.toEqual({});
  expect(reads.failureReason()).toBe('missing');
  reads.clearFailureReason();
  expect(reads.failureReason()).toBeNull();
});

test('does not put error text or response bodies in the remembered reason', async () => {
  const reads = createEventReads(
    transportFor(() => new Response('sentinel-body', { status: 500 })),
    createTestClaimStore(),
  );
  await expect(reads.readRun(repository, 401)).rejects.toThrow();
  expect(reads.failureReason()).not.toContain('sentinel');
});

test('reports the reason of the most recent failed read, not the first', async () => {
  const reads = createEventReads(
    transportFor((url) =>
      url.endsWith('/pulls/42')
        ? new Response('{}', { status: 404 })
        : new Response('{}', { status: 403, headers: { 'retry-after': '60' } }),
    ),
    createTestClaimStore(),
  );
  await expect(reads.readPullRequest(repository, 42)).rejects.toThrow();
  expect(reads.failureReason()).toBe('missing');
  await expect(reads.readRun(repository, 401)).rejects.toThrow();
  expect(reads.failureReason()).toBe('rate_limit');
});
