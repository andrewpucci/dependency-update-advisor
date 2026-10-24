import { expect, test, vi } from 'vite-plus/test';
import { createGithubReadSession, type GithubReadLimits } from './github-read.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const repository = { id: 101, owner: 'example', name: 'consumer' };
const repo = { id: 101, full_name: 'example/consumer' };
const binding = {
  repository,
  workflow: { id: 301, path: '.github/workflows/ci.yml' },
  runId: 401,
  runAttempt: 1,
  pullNumber: 42,
  headRepository: repository,
  headSha: HEAD,
  baseRef: 'main',
  baseSha: BASE,
  mergeBaseSha: BASE,
  actorId: 201,
  conclusion: 'success',
  identity: [101, 301, 401, 1, 42, HEAD],
};
const limits: GithubReadLimits = {
  maxRequests: 1000,
  maxPages: 40,
  maxFiles: 4000,
  maxJsonEntries: 100000,
  maxResponseBytes: 1000000,
  maxFileBytes: 100000,
  maxTotalBytes: 10000000,
  maxRetainedBytes: 1000000,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10000,
};
function pr(changed_files = 0) {
  return {
    number: 42,
    state: 'open',
    merged: false,
    user: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
    base: { ref: 'main', sha: BASE, repo },
    head: { sha: HEAD, repo },
    changed_files,
  };
}
function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}
function fixture(responses: Response[] = [json(pr())], overrides: Partial<GithubReadLimits> = {}) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return response;
  });
  return {
    input: { binding: structuredClone(binding), limits: { ...limits, ...overrides } },
    fetch,
    dependencies: { fetch, now: () => 0 },
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  const result = await createGithubReadSession(f.input, f.dependencies);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('expected ready session');
  return result.session;
}

test('creates a detached bound snapshot with fixed-origin GET and manual redirects', async () => {
  const f = fixture();
  const result = await createGithubReadSession(f.input, f.dependencies);
  expect(result).toMatchObject({ kind: 'ready', binding });
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(
    'https://api.github.com/repos/example/consumer/pulls/42',
    expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) }),
  );
  f.input.binding.repository.owner = 'attacker';
  if (result.kind !== 'ready') throw new Error('expected session');
  expect(result.binding.repository.owner).toBe('example');
  result.session.close();
});

test.each(Object.keys(limits))('requires valid caller limit %s before dispatch', async (key) => {
  for (const value of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    Object.assign(f.input.limits, { [key]: value });
    expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({ kind: 'invalid' });
    expect(f.fetch).not.toHaveBeenCalled();
  }
});

test.each([302, 404, 403, 429, 500])('maps status %s to safe fixed provenance', async (status) => {
  const f = fixture([json({ message: 'synthetic-private' }, status)]);
  const result = await createGithubReadSession(f.input, f.dependencies);
  expect(result).toEqual({
    kind: 'unavailable',
    reason: status === 429 ? 'rate_limit' : status === 404 ? 'missing' : 'unknown',
  });
});

test('enforces streamed bytes even with a false Content-Length and cancels the stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(101));
    },
    cancel() {
      cancelled = true;
    },
  });
  const f = fixture([new Response(stream, { headers: { 'content-length': '1' } })], {
    maxResponseBytes: 100,
  });
  expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(cancelled).toBe(true);
});

test('aborts an in-flight request at its deadline and rejects late success', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    let resolve: (response: Response) => void = () => {};
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    const pending = createGithubReadSession({ binding, limits }, { fetch, now: () => 0 });
    await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs);
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
    let cancelled = false;
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('requires a comparison only for observed base movement', async () => {
  const current = pr();
  current.base.sha = 'c'.repeat(40);
  const f = fixture([
    json(current),
    json({ base_commit: { sha: current.base.sha }, merge_base_commit: { sha: BASE } }),
  ]);
  const session = await ready(f);
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/repos/example/consumer/pulls/42',
    `https://api.github.com/repos/example/consumer/compare/${current.base.sha}...${HEAD}`,
  ]);
  session.close();
});

test.each(['head', 'closed', 'retarget', 'repo', 'author', 'count'])(
  'rejects conflicting or malformed metadata: %s',
  async (change) => {
    const value = pr();
    if (change === 'head') value.head.sha = 'c'.repeat(40);
    if (change === 'closed') value.state = 'closed';
    if (change === 'retarget') value.base.ref = 'other';
    if (change === 'repo') value.base.repo = { ...repo, id: 999 };
    if (change === 'author') value.user.id = 999;
    if (change === 'count') value.changed_files = -1;
    const f = fixture([json(value)]);
    expect(await createGithubReadSession(f.input, f.dependencies)).toEqual(
      ['head', 'closed', 'retarget'].includes(change)
        ? { kind: 'obsolete' }
        : { kind: 'unavailable', reason: change === 'count' ? 'malformed' : 'conflict' },
    );
  },
);

test('a streaming deadline cancels the body and request', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const f = fixture([
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    ]);
    const pending = createGithubReadSession(f.input, f.dependencies);
    await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs);
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(cancelled).toBe(true);
    expect(f.fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('validates cross-field limits and binding before dispatch', async () => {
  for (const patch of [
    { maxResponseBytes: limits.maxTotalBytes + 1 },
    { maxFileBytes: limits.maxTotalBytes + 1 },
    { requestTimeoutMs: limits.totalTimeoutMs + 1 },
  ]) {
    const f = fixture([], patch);
    expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({ kind: 'invalid' });
    expect(f.fetch).not.toHaveBeenCalled();
  }
  const f = fixture();
  f.input.binding.identity = [];
  expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({ kind: 'invalid' });
  expect(f.fetch).not.toHaveBeenCalled();
});
