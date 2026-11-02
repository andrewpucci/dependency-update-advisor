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
  const discovery: { -readonly [K in keyof GithubDiscovery]: GithubDiscovery[K] } = {
    kind: 'available',
    binding: structuredClone(binding),
    files: [{ path: workflow, previousPath: null, status: 'modified', blobSha: null }],
    complete: true,
    reasons: [],
  };
  const comparison: { -readonly [K in keyof GithubComparison]: GithubComparison[K] } = {
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

test.each(['added', 'removed'] as const)(
  'accounts for an entire %s workflow with a null side',
  async (status) => {
    const f = fixture();
    f.discovery.files = [{ path: workflow, previousPath: null, status, blobSha: null }];
    const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
    expect(result.coverage.status).toBe('complete');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].kind).toBe(status === 'added' ? 'addition' : 'removal');
    expect(status === 'added' ? result.changes[0].from : result.changes[0].to).toBeNull();
  },
);
test('preserves rename provenance and never reads the outside side of directory moves', async () => {
  const previous = '.github/workflows/previous.yaml';
  const f = fixture();
  f.discovery.files = [
    { path: workflow, previousPath: previous, status: 'renamed', blobSha: null },
  ];
  f.files[`base:${previous}`] = yaml('v1');
  const renamed = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(renamed.coverage.status).toBe('complete');
  expect(renamed.changes[0]).toMatchObject({
    kind: 'update',
    from: { workflow: previous },
    to: { workflow },
  });
  for (const into of [true, false]) {
    const move = fixture();
    move.discovery.files = [
      {
        path: into ? workflow : 'archived/build.yml',
        previousPath: into ? 'archived/build.yml' : workflow,
        status: 'renamed',
        blobSha: null,
      },
    ];
    const result = inventory(await collectActionsInventory(move.input, { session: move.session }));
    expect(result.coverage.status).toBe('complete');
    expect(result.changes[0].kind).toBe(into ? 'addition' : 'removal');
    expect(move.calls.some((c) => c.includes('archived/'))).toBe(false);
    expect(into ? result.changes[0].from : result.changes[0].to).toBeNull();
  }
});
test.each(['action.yml', 'action.yaml', '.github/actions/nested/action.yml'])(
  'reports unsupported action definitions without reads: %s',
  async (path) => {
    const f = fixture();
    f.discovery.files = [{ path, previousPath: null, status: 'modified', blobSha: null }];
    const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['unsupported'] });
    expect(f.calls).toEqual(['discover', 'comparison']);
  },
);
test('a renamed-away action definition stays a gap beside readable workflow changes', async () => {
  const f = fixture();
  f.discovery.files = [
    ...f.discovery.files,
    { path: 'archive.yml', previousPath: 'action.yml', status: 'renamed', blobSha: null },
  ];
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('partial');
  expect(result.changes).toHaveLength(1);
});
test('distinguishes complete absence of relevant paths from incomplete discovery', async () => {
  const f = fixture();
  f.discovery.files = [];
  expect(
    inventory(await collectActionsInventory(f.input, { session: f.session })).coverage.status,
  ).toBe('not_applicable');
  f.discovery.complete = false;
  f.discovery.reasons = ['truncated'];
  expect(
    inventory(await collectActionsInventory(f.input, { session: f.session })).coverage,
  ).toMatchObject({ status: 'partial', reasons: ['truncated'] });
});
test('unreadable, syntactically malformed or unexpectedly absent sides are never proven removals', async () => {
  for (const bad of [
    'jobs: [',
    'jobs: { build: { steps: [{ uses: 42 }] } }',
    undefined,
    'forbidden',
  ] as const) {
    const f = fixture();
    if (bad === undefined) delete f.files[`head:${workflow}`];
    else
      f.files[`head:${workflow}`] =
        bad === 'forbidden'
          ? {
              kind: 'unavailable',
              reason: 'permission',
              side: 'head',
              path: workflow,
              repository,
              commitSha: HEAD,
            }
          : bad;
    const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
    expect(result.coverage.status).toBe('partial');
    expect(result.changes).toHaveLength(0);
    expect(result.workflows.some((w) => w.side === 'base' && w.jobs.length === 1)).toBe(true);
  }
});

test('unique step IDs preserve correspondence across insertions and reordered duplicate actions', async () => {
  const f = fixture();
  f.files[`base:${workflow}`] =
    'jobs: { build: { steps: [{ id: first, uses: example/action@v1 }, { id: second, uses: example/action@v1 }] } }';
  f.files[`head:${workflow}`] =
    'jobs: { build: { steps: [{ run: echo hello }, { id: second, uses: example/action@v1 }, { id: first, uses: example/action@v2 }] } }';
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({
    kind: 'update',
    from: { stepIndex: 0, ref: 'v1' },
    to: { stepIndex: 2, ref: 'v2' },
  });
});
test.each([
  'jobs: { build: { steps: [{ run: echo inserted }, { uses: example/action@v2 }] } }',
  'jobs: { build: { steps: [{ uses: example/other@v2 }, { uses: example/action@v2 }] } }',
])('unproved index correspondence retains sides and a pairing gap', async (head) => {
  const f = fixture();
  f.files[`head:${workflow}`] = head;
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('partial');
  expect(result.coverage.reasons).toContain('conflict');
  expect(result.changes.every((c) => c.kind !== 'update')).toBe(true);
  expect(result.changes.filter((c) => c.from).length).toBe(1);
});
test('identity replacements and changed job IDs never become version updates', async () => {
  for (const head of [
    'jobs: { build: { steps: [{ uses: example/other@v2 }] } }',
    'jobs: { renamed: { steps: [{ uses: example/action@v2 }] } }',
  ]) {
    const f = fixture();
    f.files[`head:${workflow}`] = head;
    const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
    expect(result.changes.map((c) => c.kind).sort()).toEqual(['addition', 'removal']);
  }
});
test('reordered discovery and job maps preserve IDs, counts and provenance', async () => {
  const f = fixture(),
    other = '.github/workflows/other.yml';
  f.discovery.files = [
    ...f.discovery.files,
    { path: other, previousPath: null, status: 'modified', blobSha: null },
  ];
  f.files[`base:${other}`] =
    'jobs: { z: { uses: example/repo/.github/workflows/a.yml@v1 }, a: { uses: example/repo/.github/workflows/a.yml@v1 } }';
  f.files[`head:${other}`] =
    'jobs: { a: { uses: example/repo/.github/workflows/a.yml@v2 }, z: { uses: example/repo/.github/workflows/a.yml@v2 } }';
  const first = await collectActionsInventory(f.input, { session: f.session });
  f.discovery.files = [...f.discovery.files].reverse();
  f.files[`base:${other}`] = (f.files[`head:${other}`] as string).replaceAll('@v2', '@v1');
  f.files[`head:${other}`] =
    'jobs: { z: { uses: example/repo/.github/workflows/a.yml@v2 }, a: { uses: example/repo/.github/workflows/a.yml@v2 } }';
  expect(await collectActionsInventory(f.input, { session: f.session })).toEqual(first);
});
