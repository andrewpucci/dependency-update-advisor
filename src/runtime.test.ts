import { describe, expect, test, vi } from 'vite-plus/test';
import { JOB_BUDGET_MS } from './budget.js';
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

test('accepts the hyphenated input names the GitHub runner supplies', () => {
  const runnerEnvironment = {
    'INPUT_GITHUB-TOKEN': 'read-token',
    'INPUT_APP-TOKEN': 'app-token',
    'INPUT_LLM-API-KEY': '',
    'INPUT_CI-WORKFLOW': '.github/workflows/ci.yml',
    GITHUB_REPOSITORY: 'example/consumer',
    GITHUB_REPOSITORY_ID: '101',
  };

  expect(parseRuntime(runnerEnvironment)).toMatchObject({
    githubToken: 'read-token',
    appToken: 'app-token',
    llmApiKey: null,
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
    snapshot: { maxRequests: 200, maxTotalBytes: 9 * 1024 * 1024 },
    freshness: { maxRequests: 24, maxTotalBytes: 3 * 1024 * 1024 },
    maxResponseBytes: 1024 * 1024,
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

describe('freshness reads and the shared evidence deadline', () => {
  const pastEvidenceDeadline = W2_GITHUB_LIMITS.totalTimeoutMs + 10_000;

  test('serves a freshness read after the shared deadline but still refuses a snapshot read', async () => {
    let clock = 0;
    const urls: string[] = [];
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => clock,
      fetch: async (url) => {
        urls.push(url);
        return new Response('{}');
      },
    });
    clock = pastEvidenceDeadline;
    await expect(transport.readRun(repo, 401)).resolves.toMatchObject({ kind: 'available' });
    expect(urls).toHaveLength(1);
    await expect(transport.readBlob(repo, 'a'.repeat(40))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
    expect(urls).toHaveLength(1);
  });

  test('refuses a freshness read after the job window without a request', async () => {
    let clock = 0;
    let requests = 0;
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => clock,
      fetch: async () => {
        requests += 1;
        return new Response('{}');
      },
    });
    clock = JOB_BUDGET_MS;
    await expect(transport.readRun(repo, 401)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
    expect(requests).toBe(0);
  });

  test('measures its windows from the supplied job start, not from when it was created', async () => {
    let clock = 100_000;
    let requests = 0;
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => clock,
      startedAt: 0,
      fetch: async () => {
        requests += 1;
        return new Response('{}');
      },
    });
    // 240 s after the job start, but only 140 s after the transport existed.
    clock = W2_GITHUB_LIMITS.totalTimeoutMs;
    await expect(transport.readBlob(repo, 'a'.repeat(40))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
    clock = JOB_BUDGET_MS;
    await expect(transport.readRun(repo, 401)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
    expect(requests).toBe(0);
  });

  test('serves reads right up to each window when the job started after time zero', async () => {
    const started = 20_000;
    let clock = 50_000;
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => clock,
      startedAt: started,
      fetch: async () => new Response('{}'),
    });
    clock = started + W2_GITHUB_LIMITS.totalTimeoutMs - 1_000;
    await expect(transport.readBlob(repo, 'a'.repeat(40))).resolves.toMatchObject({
      kind: 'available',
    });
    clock = started + JOB_BUDGET_MS - 1_000;
    await expect(transport.readRun(repo, 401)).resolves.toMatchObject({ kind: 'available' });
  });

  test.each([
    ['after the shared deadline', pastEvidenceDeadline, W2_GITHUB_LIMITS.requestTimeoutMs],
    ['near the job end', JOB_BUDGET_MS - 1_000, 1_000],
  ])(
    'times a freshness read made %s out at the smaller of the request timeout and the time left',
    async (_name, at, timeout) => {
      vi.useFakeTimers();
      try {
        const started = 20_000;
        let clock = 50_000;
        const transport = createGithubTransport({
          token: 'read-token',
          now: () => clock,
          startedAt: started,
          fetch: (_url, init) =>
            new Promise((_resolve, reject) =>
              init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            ),
        });
        clock = started + at;
        let settled = false;
        const pending = transport.readRun(repo, 401).then((result) => {
          settled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(timeout - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

type Transport = ReturnType<typeof createGithubTransport>;
const snapshotRead = (transport: Transport) => transport.readBlob(repo, 'a'.repeat(40));
const freshnessRead = (transport: Transport) => transport.readRun(repo, 401);
const budget = { kind: 'unavailable', reason: 'budget' } as const;

test.each([
  ['snapshot', snapshotRead, 'snapshot', 200],
  ['freshness', freshnessRead, 'freshness', 24],
] as const)(
  'refuses a %s read after its own request share',
  async (_name, read, share, requests) => {
    expect(W2_GITHUB_LIMITS[share].maxRequests).toBe(requests);
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => 0,
      fetch: async () => new Response('{}'),
    });
    for (let index = 0; index < requests; index += 1)
      await expect(read(transport)).resolves.toMatchObject({ kind: 'available' });
    await expect(read(transport)).resolves.toEqual(budget);
  },
);

test('an exhausted snapshot share cannot starve freshness reads, and the reverse', async () => {
  const transport = createGithubTransport({
    token: 'read-token',
    now: () => 0,
    fetch: async () => new Response('{}'),
  });
  for (let index = 0; index < W2_GITHUB_LIMITS.snapshot.maxRequests; index += 1)
    await snapshotRead(transport);
  await expect(snapshotRead(transport)).resolves.toEqual(budget);
  for (let index = 0; index < W2_GITHUB_LIMITS.freshness.maxRequests; index += 1)
    await expect(freshnessRead(transport)).resolves.toMatchObject({ kind: 'available' });
  await expect(freshnessRead(transport)).resolves.toEqual(budget);
  await expect(snapshotRead(transport)).resolves.toEqual(budget);
});

test('puts every freshness endpoint on the reserve and every snapshot endpoint on the snapshot share', async () => {
  const sha = 'a'.repeat(40);
  const reads = {
    freshness: [
      (t: Transport) => t.readWorkflow(repo, 'ci.yml'),
      (t: Transport) => t.readWorkflowById(repo, 301),
      (t: Transport) => t.readRun(repo, 401),
      (t: Transport) => t.readPullRequest(repo, 42),
      (t: Transport) => t.readComparison(repo, sha, sha),
    ],
    snapshot: [
      (t: Transport) => t.readRepository(repo),
      (t: Transport) => t.readCommit(repo, 'main'),
      (t: Transport) => t.readTree(repo, sha),
      (t: Transport) => t.readBlob(repo, sha),
    ],
  };
  for (const [share, other] of [
    ['freshness', 'snapshot'],
    ['snapshot', 'freshness'],
  ] as const) {
    for (const read of reads[share]) {
      const transport = createGithubTransport({
        token: 'read-token',
        now: () => 0,
        fetch: async () => new Response('{}'),
      });
      // Spend this share to zero through a different endpoint of the same class, then read.
      for (let index = 0; index < W2_GITHUB_LIMITS[share].maxRequests; index += 1)
        await (share === 'snapshot' ? snapshotRead : freshnessRead)(transport);
      await expect(read(transport)).resolves.toEqual(budget);
      // The other share is untouched.
      await expect(
        (other === 'snapshot' ? snapshotRead : freshnessRead)(transport),
      ).resolves.toMatchObject({ kind: 'available' });
    }
  }
});

test.each([
  ['snapshot', snapshotRead],
  ['freshness', freshnessRead],
] as const)(
  "stops a %s read at that share's byte limit and leaves the other share alone",
  async (share, read) => {
    const chunk = JSON.stringify({ pad: 'x'.repeat(W2_GITHUB_LIMITS.maxResponseBytes - 32) });
    const transport = createGithubTransport({
      token: 'read-token',
      now: () => 0,
      fetch: async () => new Response(chunk),
    });
    let reads = 0;
    for (;;) {
      const result = await read(transport);
      if (result.kind === 'unavailable') {
        expect(result).toEqual(budget);
        break;
      }
      reads += 1;
      expect(reads).toBeLessThan(20);
    }
    expect(reads).toBeLessThanOrEqual(
      Math.ceil(W2_GITHUB_LIMITS[share].maxTotalBytes / W2_GITHUB_LIMITS.maxResponseBytes),
    );
    const other = share === 'snapshot' ? freshnessRead : snapshotRead;
    await expect(other(transport)).resolves.toMatchObject({ kind: 'available' });
  },
);

test('reads runs, pull requests, comparisons, and workflows by ID from the fixed origin', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"ok":true}'));
  const transport = createGithubTransport({ token: 'read-token', now: () => 0, fetch });
  const odd = { id: 101, owner: 'space name', name: 'consumer/name' };
  await transport.readRun(odd, 401);
  await transport.readPullRequest(odd, 42);
  await transport.readComparison(odd, 'a'.repeat(40), 'b'.repeat(40));
  await transport.readWorkflowById(odd, 301);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/repos/space%20name/consumer%2Fname/actions/runs/401',
    'https://api.github.com/repos/space%20name/consumer%2Fname/pulls/42',
    `https://api.github.com/repos/space%20name/consumer%2Fname/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`,
    'https://api.github.com/repos/space%20name/consumer%2Fname/actions/workflows/301',
  ]);
});

test.each([
  ['a refspec', 'main', 'b'.repeat(40)],
  ['a path escape', '../x', 'b'.repeat(40)],
  ['an uppercase SHA', 'A'.repeat(40), 'b'.repeat(40)],
])('rejects a comparison with %s before any request', async (_label, base, head) => {
  const fetch = vi.fn(async () => new Response('{}'));
  const transport = createGithubTransport({ token: 'read-token', now: () => 0, fetch });
  await expect(transport.readComparison(repo, base, head)).resolves.toEqual({
    kind: 'unavailable',
    reason: 'malformed',
  });
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  ['a run ID of zero', (t: ReturnType<typeof createGithubTransport>) => t.readRun(repo, 0)],
  [
    'a fractional pull number',
    (t: ReturnType<typeof createGithubTransport>) => t.readPullRequest(repo, 1.5),
  ],
  [
    'a negative workflow ID',
    (t: ReturnType<typeof createGithubTransport>) => t.readWorkflowById(repo, -1),
  ],
])('rejects %s before any request', async (_label, read) => {
  const fetch = vi.fn(async () => new Response('{}'));
  const transport = createGithubTransport({ token: 'read-token', now: () => 0, fetch });
  await expect(read(transport)).resolves.toEqual({ kind: 'unavailable', reason: 'malformed' });
  expect(fetch).not.toHaveBeenCalled();
});
