import { expect, test, vi } from 'vite-plus/test';
import {
  createGithubTransport,
  parseRuntime,
  resolveWorkflow,
  W2_GITHUB_LIMITS,
  type GithubRead,
  type GithubTransport,
} from './runtime.js';

const env = {
  INPUT_GITHUB_TOKEN: 'read-token',
  INPUT_APP_TOKEN: 'app-token',
  INPUT_LLM_API_KEY: '',
  INPUT_CI_WORKFLOW: '.github/workflows/ci.yml',
  GITHUB_REPOSITORY: 'example/consumer',
  GITHUB_REPOSITORY_ID: '101',
};

test('accepts trusted caller context and preserves an empty LLM key for failure handoff', () => {
  expect(parseRuntime(env)).toEqual({
    githubToken: 'read-token',
    appToken: 'app-token',
    llmApiKey: null,
    repository: { id: 101, owner: 'example', name: 'consumer' },
    workflowFile: 'ci.yml',
    workflowPath: '.github/workflows/ci.yml',
  });
});

test.each([
  ['INPUT_GITHUB_TOKEN', ''],
  ['INPUT_APP_TOKEN', ''],
  ['GITHUB_REPOSITORY', 'example/consumer/extra'],
  ['GITHUB_REPOSITORY_ID', '0'],
  ['INPUT_CI_WORKFLOW', '../ci.yml'],
  ['INPUT_CI_WORKFLOW', '.github/workflows/nested/ci.yml'],
])('rejects invalid runtime field %s', (key, value) => {
  expect(parseRuntime({ ...env, [key]: value })).toBeNull();
});

test('uses one fixed-origin, encoded workflow request with the read token', async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ id: 301, path: '.github/workflows/ci.yml' })),
  );
  const transport = createGithubTransport({ token: 'read-token', now: () => 0, fetch });

  await expect(
    transport.readWorkflow({ id: 101, owner: 'space name', name: 'consumer/name' }, 'ci.yml'),
  ).resolves.toEqual({ kind: 'available', value: { id: 301, path: '.github/workflows/ci.yml' } });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'https://api.github.com/repos/space%20name/consumer%2Fname/actions/workflows/ci.yml',
    expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: expect.objectContaining({ authorization: 'Bearer read-token' }),
    }),
  );
});

test('validates the returned workflow ID and exact path', async () => {
  const runtime = parseRuntime(env);
  if (!runtime) throw new Error('fixture must parse');
  let response: GithubRead = {
    kind: 'available',
    value: { id: 301, path: '.github/workflows/ci.yml' },
  };
  const transport: Pick<GithubTransport, 'readWorkflow'> = { readWorkflow: async () => response };
  await expect(resolveWorkflow(runtime, transport)).resolves.toEqual({
    id: 301,
    path: '.github/workflows/ci.yml',
  });

  response = { kind: 'available', value: { id: 301, path: '.github/workflows/other.yml' } };
  await expect(resolveWorkflow(runtime, transport)).resolves.toBeNull();
});

test('fails closed on a rate limit, redirect, or aggregate request budget', async () => {
  const rateLimited = createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async () =>
      new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  });
  await expect(
    rateLimited.readWorkflow({ id: 101, owner: 'example', name: 'consumer' }, 'ci.yml'),
  ).resolves.toEqual({
    kind: 'unavailable',
    reason: 'rate_limit',
  });

  const redirect = createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async () => new Response(null, { status: 302 }),
  });
  await expect(
    redirect.readWorkflow({ id: 101, owner: 'example', name: 'consumer' }, 'ci.yml'),
  ).resolves.toEqual({
    kind: 'unavailable',
    reason: 'unknown',
  });

  expect(W2_GITHUB_LIMITS).toEqual({
    maxRequests: 64,
    maxResponseBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 240_000,
  });
});

const repo = { id: 101, owner: 'example', name: 'consumer' };

test.each([
  [401, {}, { message: 'Bad credentials' }, 'permission'],
  [403, {}, { message: 'Resource not accessible by integration' }, 'permission'],
  [403, {}, { message: 'Resource not accessible by personal access token' }, 'permission'],
  [403, { 'retry-after': '60' }, { message: 'secondary rate limit' }, 'rate_limit'],
  [403, { 'x-ratelimit-remaining': '0' }, { message: 'API rate limit exceeded' }, 'rate_limit'],
  [403, {}, { message: 'Repository access blocked' }, 'unknown'],
  [404, {}, { message: 'Not Found' }, 'missing'],
  [429, {}, { message: 'Too Many Requests' }, 'rate_limit'],
  [500, {}, { message: 'Server Error' }, 'unknown'],
])('preserves the github-read reason for HTTP %i %j', async (status, headers, body, reason) => {
  const response = new Response(JSON.stringify(body), { status, headers });
  const transport = createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async () => response,
  });
  await expect(transport.readRepository(repo)).resolves.toEqual({ kind: 'unavailable', reason });
  expect(response.bodyUsed).toBe(true);
});

test.each([
  ['invalid JSON', new TextEncoder().encode('{"private":')],
  ['invalid UTF-8', new Uint8Array([0x22, 0xff, 0x22])],
])('reports a 200 response with %s as malformed', async (_label, body) => {
  const transport = createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async () => new Response(body),
  });
  await expect(transport.readRepository(repo)).resolves.toEqual({
    kind: 'unavailable',
    reason: 'malformed',
  });
});

test.each([200, 403])(
  'stops reading an HTTP %i body once it exceeds the per-response bound',
  async (status) => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1024).fill(32);
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => 0,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull: (controller) => {
              pulled += 1;
              controller.enqueue(chunk);
            },
            cancel: () => void (cancelled = true),
          }),
          { status },
        ),
    });
    await expect(transport.readRepository(repo)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(W2_GITHUB_LIMITS.maxResponseBytes / chunk.byteLength + 2);
  },
);

test('times out and cancels an error body that never finishes', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => 0,
      fetch: async () =>
        new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), {
          status: 403,
        }),
    });
    const pending = transport.readRepository(repo);
    await vi.advanceTimersByTimeAsync(W2_GITHUB_LIMITS.requestTimeoutMs);
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('limits a late request to the time left in the total deadline', async () => {
  vi.useFakeTimers();
  try {
    let clock = 0;
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => clock,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    clock = W2_GITHUB_LIMITS.totalTimeoutMs - 1_000;
    const pending = transport.readRepository(repo);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
  } finally {
    vi.useRealTimers();
  }
});

test('refuses the request after the transport share and stops at its byte share', async () => {
  const ok = createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async () => new Response('{}'),
  });
  for (let index = 0; index < W2_GITHUB_LIMITS.maxRequests; index += 1)
    await expect(ok.readRepository(repo)).resolves.toMatchObject({ kind: 'available' });
  await expect(ok.readRepository(repo)).resolves.toEqual({ kind: 'unavailable', reason: 'budget' });

  const chunk = JSON.stringify({ pad: 'x'.repeat(W2_GITHUB_LIMITS.maxResponseBytes - 32) });
  const heavy = createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async () => new Response(chunk),
  });
  let reads = 0;
  for (;;) {
    const result = await heavy.readRepository(repo);
    if (result.kind === 'unavailable') {
      expect(result).toEqual({ kind: 'unavailable', reason: 'budget' });
      break;
    }
    reads += 1;
    expect(reads).toBeLessThan(10);
  }
  expect(reads).toBeLessThanOrEqual(
    Math.ceil(W2_GITHUB_LIMITS.maxTotalBytes / W2_GITHUB_LIMITS.maxResponseBytes),
  );
});
