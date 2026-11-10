import { expect, test, vi } from 'vite-plus/test';
import * as assessmentModule from './assessment.js';
import * as npmModule from './evidence/npm.js';
import * as researchModule from './research.js';
import { analysisDocument } from '../tests/parity/analysis.js';
import { snapshotReads, treeEntry } from '../tests/parity/snapshot-reads.js';
import { upstreamScenario } from '../tests/parity/upstream.js';
import { uvMetadataScenario } from '../tests/parity/uv-metadata.js';
import { analyzeMistralBatch } from './analysis/mistral.js';
import type { EventReads, ReviewIdentity } from './event.js';
import { createRehearsalSink } from './handoff.js';
import { runReview, type PipelineInput } from './pipeline.js';
import { createTestClaimStore } from './review.js';

vi.mock('./research.js', async (original) => {
  const actual = await original<typeof import('./research.js')>();
  return { ...actual, runResearch: vi.fn(actual.runResearch) };
});
vi.mock('./assessment.js', async (original) => {
  const actual = await original<typeof import('./assessment.js')>();
  return { ...actual, reviewPacket: vi.fn(actual.reviewPacket) };
});
vi.mock('./evidence/npm.js', async (original) => {
  const actual = await original<typeof import('./evidence/npm.js')>();
  return { ...actual, collectNpmInventory: vi.fn(actual.collectNpmInventory) };
});

const HEAD = 'a'.repeat(40);
/** A default-branch revision distinct from every PR SHA, so substitution is visible. */
const DEFAULT_BRANCH = 'f'.repeat(40);
const BASE = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const sentinel = 'sentinel-model-key';
const repository = { id: 101, owner: 'example', name: 'consumer' };

function t1() {
  const full = { id: 101, full_name: 'example/consumer' };
  const actor = { id: 201, login: 'dependabot[bot]', type: 'Bot' };
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
  const event = {
    eventName: 'workflow_run',
    expected: { repository, workflow: { id: 301, path: '.github/workflows/ci.yml' } },
    payload: { action: 'completed', repository: full, workflow_run: run },
  };
  const pullRequest = (head: string) => ({
    number: 42,
    state: 'open',
    merged: false,
    user: actor,
    base: { ref: 'main', sha: BASE, repo: full },
    head: { sha: head, repo: full },
  });
  return { event, run, pullRequest, actor };
}

const dependabotYaml = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: npm',
  '    directory: "/"',
  '  - package-ecosystem: uv',
  '    directory: "/"',
  '',
].join('\n');
const configBlob = 'b'.repeat(40);
const dependabotBlob = '4'.repeat(40);
const githubTree = 'e'.repeat(40);

const providerConfig = JSON.stringify({
  version: 1,
  analysis: { provider: 'mistral', model: 'synthetic-model' },
});

const sourceTree = 'd'.repeat(40);
const sourceBlob = '3'.repeat(40);

function snapshot(
  config = providerConfig,
  visibility: 'public' | 'private' = 'public',
  source?: string,
) {
  return snapshotReads(
    [
      treeEntry('.github', '040000', githubTree, 'tree'),
      treeEntry('.github/dependabot-review.json', '100644', configBlob),
      treeEntry('.github/dependabot.yml', '100644', dependabotBlob),
      ...(source === undefined
        ? []
        : [
            treeEntry('src', '040000', sourceTree, 'tree'),
            treeEntry('src/app.ts', '100644', sourceBlob),
          ]),
    ],
    {
      [configBlob]: config,
      [dependabotBlob]: dependabotYaml,
      ...(source === undefined ? {} : { [sourceBlob]: source }),
    },
    { visibility, revision: DEFAULT_BRANCH },
  );
}

type Overrides = Partial<PipelineInput> & {
  /** `changes` serves npm, Actions, and uv updates; the default repository has nothing changed. */
  evidence?: 'unchanged' | 'changes' | 'vulnerable' | 'uv-unsupported';
  pullRequestHeads?: string[];
  runFails?: boolean;
  /** Freshness reads for the run fail from this call (0-based) onward. */
  runFailsFrom?: number;
  config?: string;
  visibility?: 'public' | 'private';
  /** Contents of src/app.ts in the default branch. */
  source?: string;
};

const unchanged = { 'pyproject.toml': null, 'uv.lock': null };

async function setup(overrides: Overrides = {}) {
  const {
    pullRequestHeads: _heads,
    runFails: _fails,
    runFailsFrom: _failsFrom,
    config: _config,
    visibility: _visibility,
    source: _source,
    evidence: _evidence,
    ...rest
  } = overrides;
  const { event, run, pullRequest } = t1();
  const claims = overrides.claims ?? createTestClaimStore();
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('sink');
  const kind = overrides.evidence ?? 'unchanged';
  const changes =
    kind === 'changes' || kind === 'vulnerable'
      ? await upstreamScenario({ vulnerableNpm: kind === 'vulnerable' })
      : null;
  const evidence = uvMetadataScenario('empty', {
    files: kind === 'unchanged' ? { base: unchanged, head: unchanged } : {},
  });
  const githubCalls: string[] = [];
  const publicCalls: string[] = [];
  const modelCalls: unknown[] = [];
  const heads = overrides.pullRequestHeads ?? [HEAD];
  let pullReads = 0;
  let runReads = 0;
  const eventReads: EventReads = {
    readWorkflow: async () => ({ id: 301, path: '.github/workflows/ci.yml' }),
    readRun: async () => {
      const call = runReads++;
      if (
        overrides.runFails ||
        (overrides.runFailsFrom !== undefined && call >= overrides.runFailsFrom)
      )
        throw new Error(sentinel);
      return run;
    },
    readPullRequest: async () => pullRequest(heads[Math.min(pullReads++, heads.length - 1)]),
    readComparison: async () => ({
      base_commit: { sha: BASE },
      merge_base_commit: { sha: BASE },
    }),
    readReplay: (identity: ReviewIdentity) => claims.replay(identity),
  };
  const reads =
    overrides.snapshotReads ?? snapshot(overrides.config, overrides.visibility, overrides.source);
  const model = {
    now: () => 0,
    analyze: ((batch: Parameters<typeof analyzeMistralBatch>[0], options: never) => {
      modelCalls.push(batch);
      return analyzeMistralBatch(batch, options, {
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
      });
    }) as typeof analyzeMistralBatch,
  };
  const input: PipelineInput = {
    event,
    repository,
    llmApiKey: sentinel,
    eventReads,
    snapshotReads: reads,
    claims,
    sink,
    githubFetch: async (url, init) => {
      githubCalls.push(url);
      return (changes ? changes.consumerFetch : evidence.fetch)(url, init);
    },
    publicFetch: async (url, init) => {
      publicCalls.push(url);
      return changes ? changes.fetch(url, init) : new Response(null, { status: 404 });
    },
    model,
    now: () => 0,
    evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
    ...rest,
  };
  return { input, claims, sink, githubCalls, publicCalls, modelCalls, reads };
}

test('runs a current review to a complete, exact-bound handoff recorded without a live write', async () => {
  const { input, sink, githubCalls, modelCalls } = await setup();
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'complete',
    handoff: { status: 'success', comment: 'eligible', generation: 1 },
    recorded: true,
  });
  if (result.kind !== 'handed-off') return;
  expect(result.body).toEqual(expect.stringContaining(HEAD));
  expect(sink.traces()).toEqual([
    {
      kind: 'complete',
      identity: [101, 301, 401, 1, 42, HEAD],
      generation: 1,
      status: 'success',
      comment: 'eligible',
    },
  ]);
  expect(githubCalls.length).toBeGreaterThan(0);
  expect(modelCalls.length).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('hands an invalid config off as status-only failure before any collector or model starts', async () => {
  const { input, sink, githubCalls, modelCalls } = await setup({ config: '{"version":2}' });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'invalid-config',
    body: null,
    handoff: { status: 'failure', comment: 'none' },
  });
  expect(githubCalls).toEqual([]);
  expect(modelCalls).toEqual([]);
  expect(sink.traces()).toHaveLength(1);
});

test('makes no snapshot, collector, or model request without a model key', async () => {
  const { input, githubCalls, modelCalls, reads } = await setup({ llmApiKey: null });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'model-unavailable',
    handoff: { status: 'failure', comment: 'none' },
  });
  expect(githubCalls).toEqual([]);
  expect(modelCalls).toEqual([]);
  expect((reads as unknown as { calls: string[] }).calls).toEqual([]);
});

test('offers no handoff when identity cannot be verified, and claims nothing', async () => {
  const { input, sink, claims } = await setup({ runFails: true });
  const result = await runReview(input);
  expect(result).toEqual({ kind: 'not-eligible', reason: 'verification' });
  expect(sink.traces()).toEqual([]);
  await expect(claims.replay([101, 301, 401, 1, 42, HEAD])).resolves.toMatchObject({
    state: 'unseen',
  });
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('skips an ineligible event and a duplicate delivery without a handoff', async () => {
  const first = await setup();
  await runReview(first.input);
  const duplicate = await setup({ claims: first.claims });
  await expect(runReview(duplicate.input)).resolves.toEqual({
    kind: 'skipped',
    reason: 'duplicate',
  });
  expect(duplicate.sink.traces()).toEqual([]);

  const other = await setup();
  const ineligible = {
    ...other.input,
    event: { ...(other.input.event as object), eventName: 'push' },
  };
  await expect(runReview(ineligible)).resolves.toEqual({ kind: 'skipped', reason: 'ineligible' });
});

test('hands a moved PR head off as stale, authorizing neither status nor comment', async () => {
  const { input, sink } = await setup({ pullRequestHeads: [HEAD, HEAD, NEXT] });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'stale',
    body: null,
    handoff: { status: 'none', comment: 'none' },
  });
  expect(sink.traces().map((trace) => trace.kind)).toEqual(['stale']);
});

test('offers nothing when a later attempt replaces this owner before the handoff', async () => {
  const claims = createTestClaimStore();
  const replacing = await setup({ claims });
  const baseRun = replacing.input.eventReads.readRun;
  let replaced = false;
  const input: PipelineInput = {
    ...replacing.input,
    eventReads: {
      ...replacing.input.eventReads,
      readRun: async (repo, id) => {
        const value = await baseRun(repo, id);
        if (!replaced && (await claims.replay([101, 301, 401, 1, 42, HEAD])).state === 'claimed') {
          replaced = true;
          await claims.claim([101, 301, 402, 1, 42, NEXT]);
        }
        return value;
      },
    },
  };
  const result = await runReview(input);
  expect(result).toEqual({ kind: 'not-eligible', reason: 'ownership' });
  expect(replacing.sink.traces()).toEqual([]);
});

test('hands off incomplete evidence as a failure with no body when a collector has no inventory', async () => {
  const { input, sink } = await setup({
    githubFetch: async () => new Response(null, { status: 500 }),
  });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    handoff: { status: 'failure' },
    body: null,
  });
  if (result.kind !== 'handed-off') return;
  expect(['incomplete-evidence', 'internal-failure']).toContain(result.outcome);
  expect(result.outcome).not.toBe('complete');
  expect(sink.traces()[0].status).toBe('failure');
});

test('runs npm, Actions, and uv changes through research and model analysis to a rendered body', async () => {
  const { input, modelCalls, publicCalls } = await setup({ evidence: 'changes' });
  const result = await runReview(input);
  expect(result.kind).toBe('handed-off');
  if (result.kind !== 'handed-off') return;
  expect(['complete', 'incomplete-evidence']).toContain(result.outcome);
  expect(result.body).toEqual(expect.stringContaining(HEAD));
  expect(modelCalls.length).toBeGreaterThan(0);
  expect(publicCalls.some((url) => url.includes('/advisories'))).toBe(true);
});

test('hands off a model failure as a status-only failure with no body', async () => {
  const failing = {
    now: () => 0,
    analyze: (async () => ({ kind: 'unavailable', reason: 'timeout' })) as never,
  };
  const { input, sink } = await setup({ evidence: 'changes', model: failing });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'model-unavailable',
    body: null,
    handoff: { status: 'failure', comment: 'none' },
  });
  expect(sink.traces()[0]).toMatchObject({ kind: 'model-unavailable', status: 'failure' });
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('renders accurately incomplete evidence as a failure with a comment-eligible body', async () => {
  const { input } = await setup({ evidence: 'uv-unsupported' });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'incomplete-evidence',
    handoff: { status: 'failure', comment: 'eligible' },
  });
  if (result.kind !== 'handed-off') return;
  expect(result.body).toEqual(expect.stringContaining('Required evidence: Incomplete'));
});

test('hands off a configuration fault found by source context as invalid config', async () => {
  const config = JSON.stringify({
    version: 1,
    context: { sendSourceExcerptsToModel: true, sourceRoots: ['src'], excerptFiles: [] },
  });
  const { input } = await setup({ config, visibility: 'private' });
  const result = await runReview(input);
  expect(result).toMatchObject({ kind: 'handed-off', outcome: 'invalid-config', body: null });
});

test('never hands the model key to a GitHub or public source fetch', async () => {
  const { input, githubCalls, publicCalls } = await setup();
  const seen: string[] = [];
  const wrap =
    (fetch: PipelineInput['githubFetch']): PipelineInput['githubFetch'] =>
    async (url, init) => {
      seen.push(JSON.stringify([url, init.headers, init.body]));
      return fetch(url, init);
    };
  await runReview({
    ...input,
    githubFetch: wrap(input.githubFetch),
    publicFetch: wrap(input.publicFetch),
  });
  expect(githubCalls.length + publicCalls.length).toBeGreaterThan(0);
  expect(seen.join('')).not.toContain(sentinel);
});

test('skips a concurrent duplicate claim that replay could not see', async () => {
  const first = await setup();
  await runReview(first.input);
  const racing = await setup({ claims: first.claims });
  const input: PipelineInput = {
    ...racing.input,
    eventReads: {
      ...racing.input.eventReads,
      readReplay: async (identity) => ({ identity, state: 'unseen' }),
    },
  };
  await expect(runReview(input)).resolves.toEqual({ kind: 'skipped', reason: 'duplicate' });
  expect(racing.sink.traces()).toEqual([]);
});

test('renders a failed file listing as incomplete evidence in the body, never as complete', async () => {
  const healthy = (await setup()).input.githubFetch;
  const unavailableFiles = async (url: string, init: RequestInit) =>
    url.includes('/pulls/42/files') ? new Response(null, { status: 500 }) : healthy(url, init);
  const { input } = await setup({ githubFetch: unavailableFiles });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'incomplete-evidence',
    handoff: { status: 'failure', comment: 'eligible' },
  });
  if (result.kind !== 'handed-off') return;
  expect(result.body).toEqual(expect.stringContaining('Required evidence: Incomplete'));
});

test('hands off a collector with no usable inventory as incomplete evidence with no body', async () => {
  vi.mocked(npmModule.collectNpmInventory).mockResolvedValueOnce({ kind: 'invalid' });
  const { input, sink } = await setup();
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'incomplete-evidence',
    body: null,
    handoff: { status: 'failure', comment: 'eligible' },
  });
  expect(sink.traces()[0].kind).toBe('incomplete-evidence');
});

test('stops before research and the model when ownership ends during evidence collection', async () => {
  const claims = createTestClaimStore();
  const replacement = await setup({ claims, evidence: 'changes' });
  const { input, publicCalls, modelCalls } = replacement;
  const base = input.githubFetch;
  let replaced = false;
  const result = await runReview({
    ...input,
    githubFetch: async (url, init) => {
      if (!replaced) {
        replaced = true;
        await claims.claim([101, 301, 402, 1, 42, NEXT]);
      }
      return base(url, init);
    },
  });
  expect(result.kind).not.toBe('handed-off');
  // Registry reads during collection are expected; advisory and upstream research must not start.
  expect(publicCalls.filter((url) => !url.startsWith('https://registry.npmjs.org/'))).toEqual([]);
  expect(modelCalls).toEqual([]);
});

test('stops before the model when ownership ends during research', async () => {
  const claims = createTestClaimStore();
  const { input, modelCalls } = await setup({ claims, evidence: 'changes' });
  const base = input.publicFetch;
  let replaced = false;
  const result = await runReview({
    ...input,
    publicFetch: async (url, init) => {
      if (!replaced) {
        replaced = true;
        await claims.claim([101, 301, 402, 1, 42, NEXT]);
      }
      return base(url, init);
    },
  });
  expect(result.kind).not.toBe('handed-off');
  expect(modelCalls).toEqual([]);
});

test('reads public registries through the public fetch only', async () => {
  const { input, publicCalls, githubCalls } = await setup({ evidence: 'changes' });
  await runReview(input);
  expect(publicCalls.some((url) => url.startsWith('https://registry.npmjs.org/'))).toBe(true);
  expect(githubCalls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
});

test('starts no snapshot or collector read when the head moves right after claiming', async () => {
  const { input, githubCalls, reads } = await setup({ pullRequestHeads: [HEAD, NEXT] });
  const result = await runReview(input);
  expect(result).toMatchObject({ kind: 'handed-off', outcome: 'stale' });
  expect(githubCalls).toEqual([]);
  expect((reads as unknown as { calls: string[] }).calls).toEqual([]);
});

test('does not call the model when the head moves after research', async () => {
  const { input, modelCalls } = await setup({
    evidence: 'changes',
    pullRequestHeads: [HEAD, HEAD, HEAD, NEXT],
  });
  const result = await runReview(input);
  expect(result).toMatchObject({ kind: 'handed-off', outcome: 'stale', body: null });
  expect(modelCalls).toEqual([]);
});

test('never hands off a finished review when the head moves only at the very end', async () => {
  const { input, sink } = await setup({ pullRequestHeads: [HEAD, HEAD, HEAD, HEAD, NEXT] });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'stale',
    body: null,
    handoff: { status: 'none', comment: 'none' },
  });
  expect(sink.traces().map((trace) => trace.kind)).toEqual(['stale']);
});

test.each([
  ['a failing status', async () => new Response(null, { status: 500 })],
  [
    'a thrown error',
    async () => {
      throw new Error(sentinel);
    },
  ],
  [
    'a rate limit',
    async () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  ],
])('never reports success when every public source fails with %s', async (_label, failing) => {
  const { input, sink } = await setup({ evidence: 'changes', publicFetch: failing });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'incomplete-evidence',
    handoff: { status: 'failure', comment: 'eligible' },
  });
  if (result.kind !== 'handed-off') return;
  expect(result.body).toEqual(expect.stringContaining('Required evidence: Incomplete'));
  expect(sink.traces()[0]).toMatchObject({ kind: 'incomplete-evidence', status: 'failure' });
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('reports success only when the review body itself says required evidence is complete', async () => {
  const { input } = await setup({ evidence: 'changes' });
  const result = await runReview(input);
  if (result.kind !== 'handed-off') throw new Error('expected a handoff');
  expect(result.outcome === 'complete').toBe(
    result.body?.includes('Required evidence: Complete') === true,
  );
});

test('gives every change, including a GitHub Action, one source-context entry when excerpts are opted in', async () => {
  const config = JSON.stringify({
    version: 1,
    analysis: { provider: 'mistral', model: 'synthetic-model' },
    context: { sendSourceExcerptsToModel: true, excerptFiles: ['src/app.ts'] },
  });
  const { input, modelCalls } = await setup({
    evidence: 'changes',
    config,
    source: "import orbit from 'orbit';\n",
  });
  const result = await runReview(input);
  expect(result.kind).toBe('handed-off');
  if (result.kind !== 'handed-off') return;
  expect(result.outcome).not.toBe('internal-failure');
  expect(result.body).not.toBeNull();
  expect(JSON.stringify(modelCalls)).toContain("import orbit from 'orbit'");
});

test.each([
  ['right after claiming', 1],
  ['before research', 2],
  ['before the model', 3],
  ['at the final check', 4],
])(
  'hands off a failed freshness read %s as a failure, not as stale or success',
  async (_label, from) => {
    const { input, sink, modelCalls } = await setup({ evidence: 'changes', runFailsFrom: from });
    const result = await runReview(input);
    expect(result).toMatchObject({
      kind: 'handed-off',
      outcome: 'internal-failure',
      body: null,
      handoff: { status: 'failure', comment: 'none' },
    });
    expect(sink.traces()[0]).toMatchObject({ kind: 'internal-failure', status: 'failure' });
    if (from < 4) expect(modelCalls).toEqual([]);
  },
);

test('builds the collectors and context from the default-branch revision, never a PR SHA', async () => {
  vi.mocked(npmModule.collectNpmInventory).mockClear();
  vi.mocked(researchModule.runResearch).mockClear();
  const { input } = await setup();
  await runReview(input);
  const [call] = vi.mocked(npmModule.collectNpmInventory).mock.calls;
  expect((call[0] as { configRevision: { sha: string } }).configRevision.sha).toBe(DEFAULT_BRANCH);
  expect(DEFAULT_BRANCH).not.toBe(HEAD);
  expect(DEFAULT_BRANCH).not.toBe(BASE);
  // The validated packet, which research receives, carries the same revision.
  expect(researchModule.runResearch).toHaveBeenCalledWith(
    expect.objectContaining({
      packet: expect.objectContaining({ contextRevision: { repository, sha: DEFAULT_BRANCH } }),
      trusted: expect.objectContaining({ contextRevision: { repository, sha: DEFAULT_BRANCH } }),
    }),
  );
});

test('wires the clock, model key, signal attempts, and npm inventory into research and review', async () => {
  vi.mocked(researchModule.runResearch).mockClear();
  vi.mocked(assessmentModule.reviewPacket).mockClear();
  const { input } = await setup({ evidence: 'changes' });
  const result = await runReview(input);
  const evaluationTime = Date.parse('2026-11-07T00:00:00Z');
  expect(researchModule.runResearch).toHaveBeenCalledWith(
    expect.objectContaining({
      evaluationTime,
      deadline: 240_000,
      npmInventory: expect.objectContaining({ kind: 'inventory' }),
    }),
  );
  expect(assessmentModule.reviewPacket).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: sentinel,
      evaluatedAt: evaluationTime,
      deadlineMs: 900_000,
      signalAttempts: expect.arrayContaining([expect.anything()]),
    }),
  );
  if (result.kind === 'handed-off')
    expect(result.body).toEqual(expect.stringContaining('Generated: 2026-11-07T00:00:00.000Z'));
});

test('renders a verified vulnerability as a reason not to merge instead of failing', async () => {
  const { input } = await setup({ evidence: 'vulnerable' });
  const result = await runReview(input);
  expect(result.kind).toBe('handed-off');
  if (result.kind !== 'handed-off') return;
  expect(result.outcome).not.toBe('internal-failure');
  expect(result.body).toEqual(expect.stringContaining('Reasons not to merge'));
  expect(result.body).toEqual(expect.stringContaining('Remediation:'));
  expect(result.body).toEqual(expect.stringContaining('Validation:'));
});

test('hands a failed snapshot off as a failure and starts no collector', async () => {
  const reads = snapshot();
  reads.readRepository = async () => ({ kind: 'unavailable', reason: 'rate_limit' });
  const { input, githubCalls, modelCalls } = await setup({ snapshotReads: reads });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'internal-failure',
    body: null,
    handoff: { status: 'failure', comment: 'none' },
  });
  expect(githubCalls).toEqual([]);
  expect(modelCalls).toEqual([]);
});

test('hands off a moved head seen only by the evidence session as stale, not as a failure', async () => {
  const healthy = (await setup()).input.githubFetch;
  const moved = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname.endsWith('/pulls/42')) {
      const response = await healthy(url, init);
      const body = (await response.json()) as { head: { sha: string } };
      return Response.json({ ...body, head: { ...body.head, sha: NEXT } });
    }
    return healthy(url, init);
  };
  const { input } = await setup({ githubFetch: moved });
  const result = await runReview(input);
  expect(result).toMatchObject({
    kind: 'handed-off',
    outcome: 'stale',
    body: null,
    handoff: { status: 'none', comment: 'none' },
  });
});

test('starts no further request once ownership is lost during collection', async () => {
  const claims = createTestClaimStore();
  const { input, githubCalls, publicCalls, modelCalls } = await setup({
    claims,
    evidence: 'changes',
  });
  const base = input.githubFetch;
  let replaced = false;
  const result = await runReview({
    ...input,
    githubFetch: async (url, init) => {
      if (!replaced) {
        replaced = true;
        await claims.claim([101, 301, 402, 1, 42, NEXT]);
      }
      return base(url, init);
    },
  });
  expect(result.kind).not.toBe('handed-off');
  // Only the request that was already in progress when ownership ended reached the network.
  expect(githubCalls).toHaveLength(1);
  expect(publicCalls).toEqual([]);
  expect(modelCalls).toEqual([]);
});

test('aborts a request that is still pending when ownership is lost', async () => {
  const claims = createTestClaimStore();
  const { input } = await setup({ claims });
  let signal: AbortSignal | undefined;
  let started: () => void = () => undefined;
  const pendingFetch = new Promise<void>((resolve) => (started = resolve));
  const running = runReview({
    ...input,
    ownershipWatchMs: 10,
    githubFetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init.signal ?? undefined;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        started();
      }),
  });
  await pendingFetch;
  expect(signal?.aborted).toBe(false);
  await claims.claim([101, 301, 402, 1, 42, NEXT]);
  await expect(running).resolves.toEqual({ kind: 'not-eligible', reason: 'ownership' });
  expect(signal?.aborted).toBe(true);
});

test('gives every request of a healthy attempt a signal that is not aborted', async () => {
  const { input } = await setup({ evidence: 'changes' });
  const states: boolean[] = [];
  const wrap =
    (fetch: PipelineInput['githubFetch']): PipelineInput['githubFetch'] =>
    async (url, init) => {
      states.push(init.signal?.aborted ?? true);
      return fetch(url, init);
    };
  const result = await runReview({
    ...input,
    githubFetch: wrap(input.githubFetch),
    publicFetch: wrap(input.publicFetch),
  });
  expect(result.kind).toBe('handed-off');
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((aborted) => aborted === false)).toBe(true);
});

test('gives the snapshot, research, and review the attempt signal', async () => {
  vi.mocked(researchModule.runResearch).mockClear();
  vi.mocked(assessmentModule.reviewPacket).mockClear();
  const { input, reads } = await setup({ evidence: 'changes' });
  const signals: (AbortSignal | undefined)[] = [];
  const snapshotRead = reads.readRepository;
  reads.readRepository = async (repo, signal) => {
    signals.push(signal);
    return snapshotRead(repo, signal);
  };
  await runReview(input);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[0]?.aborted).toBe(false);
  expect(researchModule.runResearch).toHaveBeenCalledWith(
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(assessmentModule.reviewPacket).toHaveBeenCalledWith(
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  // One signal for the whole attempt.
  const [research] = vi.mocked(researchModule.runResearch).mock.calls;
  const [review] = vi.mocked(assessmentModule.reviewPacket).mock.calls;
  expect(research[0].signal).toBe(signals[0]);
  expect(review[0].signal).toBe(signals[0]);
});

test('ends the attempt signal when the head moves, and stops the ownership watcher either way', async () => {
  const clear = vi.spyOn(globalThis, 'clearInterval');
  try {
    const { input } = await setup({ pullRequestHeads: [HEAD, HEAD, NEXT] });
    let signal: AbortSignal | undefined;
    const base = input.githubFetch;
    const result = await runReview({
      ...input,
      githubFetch: async (url, init) => {
        signal ??= init.signal ?? undefined;
        return base(url, init);
      },
    });
    expect(result).toMatchObject({ kind: 'handed-off', outcome: 'stale' });
    expect(clear).toHaveBeenCalledTimes(1);
    // The head moved at the pre-research recheck, so the attempt's signal is aborted.
    expect(signal?.aborted).toBe(true);
  } finally {
    clear.mockRestore();
  }
});
