import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { analysisDocument } from '../tests/parity/analysis.js';
import { upstreamScenario } from '../tests/parity/upstream.js';
import { uvMetadataScenario } from '../tests/parity/uv-metadata.js';
import { analyzeMistralBatch } from './analysis/mistral.js';
import { createTestClaimStore } from './review.js';
import type { StartupDependencies } from './startup.js';
import {
  MAX_EVENT_BYTES,
  NOT_WIRED_EXIT_CODE,
  SELF_CHECK_EXIT_CODE,
  readBoundedEvent,
  runStartup,
  selfCheck,
} from './startup.js';

const environment = {
  INPUT_GITHUB_TOKEN: 'read-token',
  INPUT_APP_TOKEN: 'app-token',
  INPUT_LLM_API_KEY: '',
  INPUT_CI_WORKFLOW: '.github/workflows/ci.yml',
  GITHUB_REPOSITORY: 'example/consumer',
  GITHUB_REPOSITORY_ID: '101',
};

test('self-check exercises every bundled production dependency', async () => {
  expect(await selfCheck()).toEqual({
    semver: true,
    pep440: true,
    spdx: true,
    toml: true,
    yaml: true,
    streamJson: true,
  });
});

test('startup fails closed without a valid action runtime', async () => {
  const stderr: string[] = [];
  const code = await runStartup((line) => stderr.push(line));
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
  expect(stderr).toEqual(['dependabot-review: runtime configuration invalid; no review ran.']);
});

test('rejects malformed action configuration without echoing input values', async () => {
  const stderr: string[] = [];
  await expect(
    runStartup((line) => stderr.push(line), {
      ...environment,
      INPUT_GITHUB_TOKEN: 'sentinel-token\n',
    }),
  ).resolves.toBe(NOT_WIRED_EXIT_CODE);
  expect(stderr).toEqual(['dependabot-review: runtime configuration invalid; no review ran.']);
  expect(stderr.join('\n')).not.toContain('sentinel-token');
});

test('uses exit codes that differ from a Node load failure', () => {
  expect([NOT_WIRED_EXIT_CODE, SELF_CHECK_EXIT_CODE]).not.toContain(1);
  expect(NOT_WIRED_EXIT_CODE).not.toBe(SELF_CHECK_EXIT_CODE);
});

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const sentinel = 'sentinel-secret-value';
const full = { id: 101, full_name: 'example/consumer' };
const actor = { id: 201, login: 'dependabot[bot]', type: 'Bot' };
const workflow = { id: 301, path: '.github/workflows/ci.yml' };
const run = {
  id: 401,
  workflow_id: 301,
  run_attempt: 1,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  head_sha: HEAD,
  actor,
  repository: full,
  head_repository: full,
  pull_requests: [
    {
      number: 42,
      base: { repo: { id: 101, name: 'consumer' } },
      head: { sha: HEAD, repo: { id: 101, name: 'consumer' } },
    },
  ],
};
const eventFile = JSON.stringify({
  action: 'completed',
  repository: full,
  workflow_run: run,
});
const pullRequest = (head: string) => ({
  number: 42,
  state: 'open',
  merged: false,
  user: actor,
  base: { ref: 'main', sha: BASE, repo: full },
  head: { sha: head, repo: full },
});
const rootTree = '9'.repeat(40);
const githubTree = 'e'.repeat(40);
const configBlob = '1'.repeat(40);
const dependabotBlob = '2'.repeat(40);
const providerConfig = JSON.stringify({
  version: 1,
  analysis: { provider: 'mistral', model: 'synthetic-model' },
});
const dependabotYaml = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n';
const unchanged = { 'pyproject.toml': null, 'uv.lock': null };

function environmentFor(overrides: Record<string, string> = {}) {
  return {
    ...environment,
    INPUT_LLM_API_KEY: sentinel,
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_EVENT_PATH: '/event.json',
    ...overrides,
  };
}

/** One mocked GitHub: trusted reads, the default-branch snapshot, and consumer evidence. */
function mockGithub(
  options: {
    config?: string;
    heads?: string[];
    filesFail?: boolean;
    /** Serve npm, Actions, and uv updates, and the public registries they are researched in. */
    changes?: Awaited<ReturnType<typeof upstreamScenario>>;
  } = {},
) {
  const evidence = options.changes
    ? { fetch: options.changes.consumerFetch }
    : uvMetadataScenario('empty', { files: { base: unchanged, head: unchanged } });
  const heads = options.heads ?? [HEAD];
  let pulls = 0;
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const objects = new Map<string, unknown>([
    [
      rootTree,
      {
        truncated: false,
        tree: [{ path: '.github', mode: '040000', type: 'tree', sha: githubTree }],
      },
    ],
    [
      githubTree,
      {
        truncated: false,
        tree: [
          {
            path: 'dependabot-review.json',
            mode: '100644',
            type: 'blob',
            sha: configBlob,
            size: Buffer.byteLength(options.config ?? providerConfig),
          },
          {
            path: 'dependabot.yml',
            mode: '100644',
            type: 'blob',
            sha: dependabotBlob,
            size: Buffer.byteLength(dependabotYaml),
          },
        ],
      },
    ],
  ]);
  const blobs = new Map([
    [configBlob, options.config ?? providerConfig],
    [dependabotBlob, dependabotYaml],
  ]);
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
    headers.push(Object.fromEntries(new Headers(init.headers)));
    const path = new URL(url).pathname.replace('/repos/example/consumer', '');
    const inRepository = new URL(url).pathname.startsWith('/repos/example/consumer');
    if (options.changes && !(new URL(url).origin === 'https://api.github.com' && inRepository))
      return options.changes.fetch(url, init);
    if (new URL(url).origin !== 'https://api.github.com')
      return new Response(null, { status: 404 });
    // Every consumer-repository read needs the read token; GitHub rejects it otherwise.
    if (headers.at(-1)?.authorization !== 'Bearer read-token')
      return new Response(null, { status: 401 });
    if (path === '/actions/workflows/ci.yml' || path === '/actions/workflows/301')
      return json(workflow);
    if (path === '/actions/runs/401') return json(run);
    if (path === '/pulls/42')
      return json({ ...pullRequest(heads[Math.min(pulls++, heads.length - 1)]), changed_files: 0 });
    if (path === `/compare/${BASE}...${HEAD}`)
      return json({ base_commit: { sha: BASE }, merge_base_commit: { sha: BASE } });
    if (path === '') return json({ private: false, default_branch: 'main' });
    if (path === '/commits/main') return json({ sha: HEAD, commit: { tree: { sha: rootTree } } });
    const object = path.split('/').at(-1)!;
    if (path.startsWith('/git/trees/') && objects.has(object)) return json(objects.get(object));
    if (path.startsWith('/git/blobs/') && blobs.has(object))
      return json({
        encoding: 'base64',
        content: Buffer.from(blobs.get(object)!).toString('base64'),
      });
    if (options.filesFail && path.startsWith('/pulls/42/files'))
      return new Response(null, { status: 500 });
    return evidence.fetch(url, init);
  };
  return { fetch, urls, headers };
}

function dependenciesFor(
  github: ReturnType<typeof mockGithub>,
  overrides: Partial<StartupDependencies> = {},
): StartupDependencies {
  const model = {
    now: () => 0,
    analyze: ((batch: Parameters<typeof analyzeMistralBatch>[0], options: never) =>
      analyzeMistralBatch(batch, options, {
        now: () => 0,
        fetch: async () =>
          Response.json({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(analysisDocument(batch as never)),
                },
              },
            ],
          }),
      })) as typeof analyzeMistralBatch,
  };
  return {
    fetch: github.fetch,
    readEvent: async () => eventFile,
    now: () => 0,
    evaluationTime: () => Date.parse('2026-11-07T00:00:00Z'),
    model,
    ...overrides,
  };
}

async function start(
  github: ReturnType<typeof mockGithub>,
  env: Record<string, string> = {},
  overrides: Partial<StartupDependencies> = {},
) {
  const stderr: string[] = [];
  const code = await runStartup(
    (line) => stderr.push(line),
    environmentFor(env),
    dependenciesFor(github, overrides),
  );
  return { code, stderr };
}

test('records a current success without publishing, and never exits as a live review', async () => {
  const github = mockGithub();
  const { code, stderr } = await start(github);
  expect(stderr).toEqual([
    'dependabot-review: no-write rehearsal recorded complete; nothing was published.',
  ]);
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
  expect(github.urls.length).toBeGreaterThan(0);
  expect(github.urls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
  expect(stderr.join('')).not.toContain(sentinel);
});

test('uses only GET requests with the read token, and never the model key or app token', async () => {
  const github = mockGithub();
  const methods = new Set<string>();
  const base = github.fetch;
  await start(
    github,
    {},
    {
      fetch: async (url, init) => {
        methods.add(init.method ?? 'GET');
        return base(url, init);
      },
    },
  );
  expect([...methods]).toEqual(['GET']);
  const sent = JSON.stringify(github.headers);
  expect(sent).toContain('Bearer read-token');
  expect(sent).not.toContain('app-token');
  expect(sent).not.toContain(sentinel);
});

test('reports an invalid trusted config as a recorded status-only failure', async () => {
  const { stderr, code } = await start(mockGithub({ config: '{"version":2}' }));
  expect(stderr).toEqual([
    'dependabot-review: no-write rehearsal recorded invalid-config; nothing was published.',
  ]);
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
});

test('reports a failed file listing as recorded incomplete evidence', async () => {
  const { stderr } = await start(mockGithub({ filesFail: true }));
  expect(stderr).toEqual([
    'dependabot-review: no-write rehearsal recorded incomplete-evidence; nothing was published.',
  ]);
});

test('records a moved PR head as stale', async () => {
  const { stderr } = await start(mockGithub({ heads: [HEAD, NEXT] }));
  expect(stderr).toEqual([
    'dependabot-review: no-write rehearsal recorded stale; nothing was published.',
  ]);
});

test('records no model key as model-unavailable without evidence requests', async () => {
  const github = mockGithub();
  const { stderr } = await start(github, { INPUT_LLM_API_KEY: '' });
  expect(stderr).toEqual([
    'dependabot-review: no-write rehearsal recorded model-unavailable; nothing was published.',
  ]);
  expect(github.urls.some((url) => url.includes('/git/'))).toBe(false);
});

test('skips an ineligible event and a duplicate delivery', async () => {
  const skipped = await start(mockGithub(), { GITHUB_EVENT_NAME: 'push' });
  expect(skipped.stderr).toEqual([
    'dependabot-review: event skipped (ineligible); nothing was published.',
  ]);
  const claims = createTestClaimStore();
  await start(mockGithub(), {}, { claims });
  const duplicate = await start(mockGithub(), {}, { claims });
  expect(duplicate.stderr).toEqual([
    'dependabot-review: event skipped (duplicate); nothing was published.',
  ]);
});

test('offers no handoff when identity cannot be verified', async () => {
  const github = mockGithub();
  const base = github.fetch;
  const { stderr } = await start(
    github,
    {},
    {
      fetch: async (url, init) =>
        url.includes('/actions/runs/') ? new Response(null, { status: 500 }) : base(url, init),
    },
  );
  expect(stderr).toEqual([
    'dependabot-review: no publishable handoff (verification); nothing was published.',
  ]);
});

test.each([
  ['no event path', { GITHUB_EVENT_PATH: '' }, 'event unavailable; no review ran.'],
  ['no event name', { GITHUB_EVENT_NAME: '' }, 'event unavailable; no review ran.'],
])('fails closed with %s', async (_label, env, message) => {
  const github = mockGithub();
  const { stderr, code } = await start(github, env);
  expect(stderr).toEqual([`dependabot-review: ${message}`]);
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
  expect(github.urls).toEqual([]);
});

test('fails closed on an unreadable or malformed event without echoing it', async () => {
  for (const readEvent of [
    async () => {
      throw new Error(sentinel);
    },
    async () => `{ ${sentinel}`,
  ]) {
    const { stderr } = await start(mockGithub(), {}, { readEvent });
    expect(stderr).toEqual(['dependabot-review: event unavailable; no review ran.']);
    expect(stderr.join('')).not.toContain(sentinel);
  }
});

test('fails closed when the workflow cannot be verified', async () => {
  const github = mockGithub();
  const base = github.fetch;
  const { stderr } = await start(
    github,
    {},
    {
      fetch: async (url, init) =>
        url.includes('/actions/workflows/')
          ? Response.json({ id: 999, path: '.github/workflows/other.yml' })
          : base(url, init),
    },
  );
  expect(stderr).toEqual(['dependabot-review: workflow could not be verified; no review ran.']);
});

test('reports an unexpected failure with a fixed message and no error text', async () => {
  const { stderr, code } = await start(
    mockGithub(),
    {},
    {
      evaluationTime: () => {
        throw new Error(sentinel);
      },
    },
  );
  expect(stderr).toEqual(['dependabot-review: rehearsal failed; nothing was published.']);
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
  expect(stderr.join('')).not.toContain(sentinel);
});

test('says so, and does not claim a recording, when the sink refuses the handoff', async () => {
  const sink = {
    record: () => false,
    traces: () => [],
  };
  const { stderr, code } = await start(mockGithub(), {}, { sink });
  expect(stderr).toEqual([
    'dependabot-review: no-write rehearsal could not record the handoff; nothing was published.',
  ]);
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
});

test('sends the read token to the consumer repository only, never to a registry or advisory source', async () => {
  const github = mockGithub({ changes: await upstreamScenario() });
  const { stderr } = await start(github);
  expect(stderr).toHaveLength(1);
  const outsideRepository = github.urls
    .map((url, index) => ({ url, headers: github.headers[index] }))
    .filter(({ url }) => !new URL(url).pathname.startsWith('/repos/example/consumer'));
  // Public research really ran against registries and advisories.
  expect(outsideRepository.some(({ url }) => url.startsWith('https://registry.npmjs.org/'))).toBe(
    true,
  );
  expect(outsideRepository.some(({ url }) => url.includes('/advisories'))).toBe(true);
  for (const { headers } of outsideRepository) {
    expect(headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(headers)).not.toContain('read-token');
  }
});

test.each([
  ['exactly the limit', Buffer.alloc(MAX_EVENT_BYTES, 'a'), true],
  ['one byte over the limit', Buffer.alloc(MAX_EVENT_BYTES + 1, 'a'), false],
  ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), false],
])('reads an event file of %s as bounded text only when it is valid', async (_label, bytes, ok) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'startup-event-'));
  try {
    const path = join(directory, 'event.json');
    await fs.writeFile(path, bytes);
    if (ok) await expect(readBoundedEvent(path)).resolves.toHaveLength(bytes.byteLength);
    else await expect(readBoundedEvent(path)).rejects.toThrow();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects a missing event file', async () => {
  await expect(
    readBoundedEvent(join(tmpdir(), 'startup-event-missing', 'event.json')),
  ).rejects.toThrow();
});
