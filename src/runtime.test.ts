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
  const transport: GithubTransport = { readWorkflow: async () => response };
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
    maxRequests: 512,
    maxResponseBytes: 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 240_000,
  });
});
