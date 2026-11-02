import { expect, test } from 'vite-plus/test';
import { collectActionsInventory } from './actions.js';
import type {
  GithubReadSession,
  GithubDiscovery,
  GithubFileResult,
  GithubComparison,
} from '../github-read.js';
import type { ReviewBinding } from '../event.js';

const repository = { id: 101, owner: 'example', name: 'consumer' };
const BASE = 'b'.repeat(40),
  HEAD = 'a'.repeat(40);
const binding: ReviewBinding = {
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
const workflow = '.github/workflows/example.yml';
function yaml(ref: string) {
  return `jobs:\n  build:\n    steps:\n      - uses: example/action@${ref}\n`;
}
function fixture() {
  const input = {
    binding: structuredClone(binding),
    limits: {
      maxFileBytes: 100_000,
      maxWorkflows: 20,
      maxYamlNodes: 100_000,
      maxYamlDepth: 32,
      maxAliasExpansions: 100,
      maxOccurrences: 1000,
      maxRetainedBytes: 1_000_000,
    },
  };
  const discovery: GithubDiscovery = {
    kind: 'available',
    binding: structuredClone(binding),
    files: [{ path: workflow, previousPath: null, status: 'modified', blobSha: null }],
    complete: true,
    reasons: [],
  };
  const comparison: GithubComparison = {
    kind: 'available',
    repository,
    baseSha: BASE,
    headRepository: repository,
    headSha: HEAD,
    mergeBaseSha: BASE,
    records: [],
    reasons: [],
  };
  const files: Record<string, string | GithubFileResult> = {
    [`base:${workflow}`]: yaml('v1'),
    [`head:${workflow}`]: yaml('v2'),
  };
  const calls: string[] = [];
  const session: GithubReadSession = {
    discoverFiles: async () => {
      calls.push('discover');
      return discovery;
    },
    readFile: async (request) => {
      const { side, path } = request as { side: 'base' | 'head'; path: string };
      calls.push(`${side}:${path}`);
      const value = files[`${side}:${path}`];
      const provenance = { side, path, repository, commitSha: side === 'base' ? BASE : HEAD };
      if (value === undefined) return { ...provenance, kind: 'absent', treeSha: 'd'.repeat(40) };
      if (typeof value !== 'string') return value;
      return {
        ...provenance,
        kind: 'available',
        blobSha: 'e'.repeat(40),
        bytes: new TextEncoder().encode(value),
      };
    },
    readComparison: async () => {
      calls.push('comparison');
      return comparison;
    },
    close: () => {
      calls.push('close');
    },
  };
  return { input, discovery, comparison, files, calls, session };
}
type Inventory = Extract<
  Awaited<ReturnType<typeof collectActionsInventory>>,
  { kind: 'inventory' }
>;
function inventory(value: Awaited<ReturnType<typeof collectActionsInventory>>): Inventory {
  expect(value.kind).toBe('inventory');
  if (value.kind !== 'inventory') throw new Error('expected inventory');
  return value;
}
test('collects an exact immutable step update despite an empty comparison', async () => {
  const f = fixture(),
    result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({
    ecosystem: 'actions',
    kind: 'update',
    role: 'direct',
    from: {
      workflow,
      jobId: 'build',
      stepIndex: 0,
      action: 'example/action',
      ref: 'v1',
      refKind: 'unknown',
    },
    to: { workflow, jobId: 'build', stepIndex: 0, ref: 'v2' },
    evidence: { vulnerability: { status: 'unavailable', reasons: ['missing'], sourceIds: [] } },
  });
  expect(f.calls).toEqual(['discover', `base:${workflow}`, `head:${workflow}`, 'comparison']);
  expect(
    result.sources.some((s) => s.provenance.kind === 'file' && s.provenance.sha === BASE),
  ).toBe(true);
});
test('collects a reusable workflow update with explicit job-level locations', async () => {
  const f = fixture();
  for (const [side, ref] of [
    ['base', 'main'],
    ['head', 'v2'],
  ])
    f.files[`${side}:${workflow}`] =
      `jobs:\n  reuse:\n    uses: example/repo/.github/workflows/reuse.yml@${ref}\n`;
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.changes[0]).toMatchObject({
    kind: 'update',
    from: { stepIndex: null, ref: 'main' },
    to: { stepIndex: null, ref: 'v2' },
  });
});
test('invalid input makes no reads; obsolete discovery returns no usable inventory', async () => {
  const f = fixture();
  expect(await collectActionsInventory({ ...f.input, limits: {} }, { session: f.session })).toEqual(
    { kind: 'invalid' },
  );
  expect(f.calls).toEqual([]);
  expect(
    await collectActionsInventory(f.input, {
      session: { ...f.session, discoverFiles: async () => ({ ...f.discovery, kind: 'obsolete' }) },
    }),
  ).toEqual({ kind: 'obsolete' });
});
test('refuses conflicting immutable file provenance without relabeling it', async () => {
  const f = fixture();
  f.files[`base:${workflow}`] = {
    kind: 'available',
    side: 'head',
    path: workflow,
    repository,
    commitSha: HEAD,
    blobSha: 'e'.repeat(40),
    bytes: new TextEncoder().encode(yaml('v1')),
  };
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('partial');
  expect(result.coverage.reasons).toContain('conflict');
  expect(result.changes).toHaveLength(0);
});
