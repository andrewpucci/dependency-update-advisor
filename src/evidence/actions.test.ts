import { expect, test } from 'vite-plus/test';
import { collectActionsInventory } from './actions.js';
import type {
  GithubReadSession,
  GithubDiscovery,
  GithubFileResult,
  GithubComparison,
} from '../github-read.js';
import type { ReviewBinding } from '../event.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits, summarizeDecisionCoverage } from '../units.js';
import { parseReviewConfig } from '../config.js';
import { collectNpmInventory } from './npm.js';

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

function comparisonRow(
  version: string,
  change_type = 'added',
  manifest = workflow,
  name = 'example/action',
) {
  return { ecosystem: 'actions', manifest, name, version, change_type };
}
test('comparison corroborates repeated exact occurrences only within its workflow', async () => {
  const f = fixture(),
    other = '.github/workflows/other.yml';
  f.discovery.files = [
    ...f.discovery.files,
    { path: other, previousPath: null, status: 'modified', blobSha: null },
  ];
  for (const path of [workflow, other]) {
    f.files[`base:${path}`] =
      'jobs: { build: { steps: [{ uses: example/action@v1 }, { uses: example/action@v1 }] } }';
    f.files[`head:${path}`] =
      'jobs: { build: { steps: [{ uses: example/action@v2 }, { uses: example/action@v2 }] } }';
  }
  f.comparison.records = [comparisonRow('2')];
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.changes).toHaveLength(4);
  const sources = result.sources.filter((s) => s.kind === 'comparison' && s.status === 'available');
  expect(sources).toHaveLength(1);
  expect(sources[0].memberIds).toHaveLength(2);
  expect(
    sources[0].memberIds.every((id) =>
      result.changes.some(
        (c) => c.id === id && c.to && 'workflow' in c.to && c.to.workflow === workflow,
      ),
    ),
  ).toBe(true);
  expect(result.changes.every((c) => c.to && 'ref' in c.to && c.to.ref === 'v2')).toBe(true);
});
test('comparison version mismatch is visible without lowering proven inventory coverage', async () => {
  const f = fixture();
  f.comparison.records = [comparisonRow('999')];
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.comparison.discrepancies).toEqual([
    { path: workflow, side: 'head', action: 'example/action', reason: 'conflict' },
  ]);
  expect(result.changes).toHaveLength(1);
});
test('an unmatched workflow/action/side is a conflict gap without a fabricated change', async () => {
  const f = fixture();
  f.comparison.records = [comparisonRow('2', 'added', workflow, 'example/missing')];
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['conflict'] });
  expect(result.changes).toHaveLength(1);
});
test.each(['permission', 'rate_limit', 'unknown'] as const)(
  'comparison %s remains independent from complete zero-change workflow inventory',
  async (reason) => {
    const f = fixture();
    f.files[`base:${workflow}`] = 'jobs: { build: { steps: [{ run: echo before }] } }';
    f.files[`head:${workflow}`] = 'jobs: { build: { steps: [{ run: echo after }] } }';
    f.comparison.kind = 'unavailable';
    f.comparison.reasons = [reason];
    const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
    expect(result.coverage.status).toBe('complete');
    expect(result.changes).toHaveLength(0);
    expect(result.comparison).toMatchObject({ status: 'unavailable', reasons: [reason] });
    expect(
      result.sources.some(
        (s) => s.kind === 'comparison' && s.status === 'unavailable' && s.reasons.includes(reason),
      ),
    ).toBe(true);
  },
);
test('comparison uses exact bound identities and full-SHA case corroboration', async () => {
  const f = fixture();
  f.files[`head:${workflow}`] = yaml('A'.repeat(40));
  f.comparison.records = [comparisonRow('a'.repeat(40))];
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.comparison.sourceIds).toHaveLength(1);
  expect(result.workflows.find((w) => w.side === 'head')?.jobs[0].steps?.[0].use).toMatchObject({
    ref: 'A'.repeat(40),
  });
  f.comparison.headSha = 'f'.repeat(40);
  const wrong = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(wrong.coverage.status).toBe('complete');
  expect(wrong.comparison).toMatchObject({ status: 'unavailable', reasons: ['conflict'] });
});
test('reordered comparison records preserve independent evidence and malformed rows remain safe', async () => {
  const f = fixture();
  f.comparison.records = [
    comparisonRow('1', 'removed'),
    comparisonRow('2'),
    { ecosystem: 'npm', manifest: 'package-lock.json' },
  ];
  const before = await collectActionsInventory(f.input, { session: f.session });
  f.comparison.records = [...f.comparison.records].reverse();
  expect(await collectActionsInventory(f.input, { session: f.session })).toEqual(before);
  f.comparison.records = [
    {
      ecosystem: 'actions',
      manifest: workflow,
      name: 'example/action',
      version: { secret: 'hidden' },
      change_type: 'added',
    },
  ];
  const bad = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(bad.comparison.reasons).toContain('malformed');
  expect(JSON.stringify(bad)).not.toContain('hidden');
});

function packet(
  result: Inventory,
  npm?: Extract<Awaited<ReturnType<typeof collectNpmInventory>>, { kind: 'inventory' }>,
) {
  const context = { ok: true, status: 'disabled', dependencies: [], reasons: [] };
  const expected = {
    binding,
    baseSha: BASE,
    contextRevision: { repository, sha: 'c'.repeat(40) },
    context,
  };
  const absent = {
    id: 'other',
    kind: 'file-list',
    ecosystems: npm ? ['uv'] : ['npm', 'uv'],
    memberIds: [],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'inventory',
      repository,
      baseSha: BASE,
      headSha: HEAD,
      absentEcosystems: npm ? ['uv'] : ['npm', 'uv'],
    },
  };
  const candidate = {
    version: 1,
    ...expected,
    changes: [...result.changes, ...(npm?.changes ?? [])],
    sources: [...result.sources, ...(npm?.sources ?? []), absent],
    coverage: {
      actions: result.coverage,
      npm: npm?.coverage ?? { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
      uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
    },
    findings: [],
    relationships: [],
  };
  return { candidate, expected, validated: validateReviewPacket(candidate, expected) };
}
function many(f: ReturnType<typeof fixture>, count: number) {
  for (const [side, ref] of [
    ['base', 'v1'],
    ['head', 'v2'],
  ]) {
    f.files[`${side}:${workflow}`] =
      `jobs:\n  build:\n    steps:\n${Array.from({ length: count }, () => `      - uses: example/action@${ref}`).join('\n')}\n`;
  }
}
test('T4 accepts repeated occurrences with bounded file and comparison source scopes; T5 keeps them standalone', async () => {
  const f = fixture();
  many(f, 65);
  f.comparison.records = [comparisonRow('2')];
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  const validated = packet(result).validated;
  expect(validated.ok, JSON.stringify(validated)).toBe(true);
  if (!validated.ok) throw new Error('expected packet');
  expect(result.sources.every((s) => s.memberIds.length <= 32)).toBe(true);
  const units = formDecisionUnits(validated.packet);
  expect(units.units).toHaveLength(65);
  expect(
    units.units.every(
      (u) => u.kind === 'standalone' && u.relationship.reason === 'actions_occurrence',
    ),
  ).toBe(true);
});
test('the existing combined 128-record ceiling accepts its boundary and rejects overflow without collector trimming', async () => {
  for (const count of [128, 129]) {
    const f = fixture();
    many(f, count);
    const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
    expect(result.changes).toHaveLength(count);
    expect(result.coverage.status).toBe('complete');
    expect(packet(result).validated.ok).toBe(count === 128);
  }
});
test('retention bounds preserve explicit incompleteness, valid packet references and a detached immutable result', async () => {
  const f = fixture();
  many(f, 6);
  const full = inventory(await collectActionsInventory(f.input, { session: f.session }));
  const fullSize = Buffer.byteLength(JSON.stringify(full));
  f.input.limits.maxRetainedBytes = fullSize;
  expect(await collectActionsInventory(f.input, { session: f.session })).toEqual(full);
  f.input.limits.maxRetainedBytes = fullSize - 1;
  const limited = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(limited.coverage).toMatchObject({ status: 'partial', reasons: ['budget'] });
  expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(fullSize - 1);
  expect(packet(limited).validated.ok).toBe(true);
  expect(Object.isFrozen(full)).toBe(true);
  expect(Object.isFrozen(full.changes[0].from)).toBe(true);
  expect(() => (full.changes as unknown[]).pop()).toThrow();
  Object.assign(f.input.binding.repository, { name: 'mutated' });
  expect(full.binding.repository.name).toBe('consumer');
  Object.assign(f.input.binding.repository, { name: 'consumer' });
  f.input.limits.maxRetainedBytes = 1;
  expect(await collectActionsInventory(f.input, { session: f.session })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});
test('occurrence and alias budgets accumulate across base/head files', async () => {
  const f = fixture();
  f.input.limits.maxOccurrences = 2;
  expect(
    inventory(await collectActionsInventory(f.input, { session: f.session })).coverage.status,
  ).toBe('complete');
  f.input.limits.maxOccurrences = 1;
  expect(
    inventory(await collectActionsInventory(f.input, { session: f.session })).coverage.reasons,
  ).toContain('budget');
  const aliases = fixture();
  aliases.input.limits.maxAliasExpansions = 1;
  for (const side of ['base', 'head'])
    aliases.files[`${side}:${workflow}`] =
      'jobs: { one: &job { steps: [{ uses: example/action@v1 }] }, two: *job }';
  expect(
    inventory(await collectActionsInventory(aliases.input, { session: aliases.session })).coverage
      .reasons,
  ).toContain('budget');
});
test('workflow limits and later read failures retain earlier changes', async () => {
  const f = fixture(),
    other = '.github/workflows/other.yml';
  f.discovery.files = [
    ...f.discovery.files,
    { path: other, previousPath: null, status: 'modified', blobSha: null },
  ];
  f.input.limits.maxWorkflows = 1;
  const limited = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(limited.changes).toHaveLength(1);
  expect(limited.coverage.reasons).toContain('budget');
  expect(f.calls.some((c) => c.includes(other))).toBe(false);
  f.input.limits.maxWorkflows = 2;
  const session = {
    ...f.session,
    readFile: async (request: unknown) => {
      if ((request as { path: string }).path === other) throw new Error('private raw response');
      return f.session.readFile(request);
    },
  };
  const failed = inventory(await collectActionsInventory(f.input, { session }));
  expect(failed.changes).toHaveLength(1);
  expect(failed.coverage.reasons).toContain('unknown');
  expect(JSON.stringify(failed)).not.toContain('private raw');
});
test('duplicate discovery cannot duplicate sources, and hostile input cannot execute getters', async () => {
  const f = fixture();
  f.discovery.files = [...f.discovery.files, ...f.discovery.files];
  const result = inventory(await collectActionsInventory(f.input, { session: f.session }));
  expect(result.coverage.reasons).toContain('conflict');
  expect(packet(result).validated.ok).toBe(true);
  let called = false;
  const bad = {
    ...f.input,
    get binding() {
      called = true;
      return binding;
    },
  };
  expect(await collectActionsInventory(bad, { session: f.session })).toEqual({ kind: 'invalid' });
  expect(called).toBe(false);
  expect(
    await collectActionsInventory({ ...f.input, prText: 'untrusted' }, { session: f.session }),
  ).toEqual({ kind: 'invalid' });
});

test.each([
  'maxFileBytes',
  'maxWorkflows',
  'maxYamlNodes',
  'maxYamlDepth',
  'maxAliasExpansions',
  'maxOccurrences',
  'maxRetainedBytes',
] as const)('rejects invalid %s before dispatch', async (field) => {
  for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    f.input.limits[field] = value;
    expect(await collectActionsInventory(f.input, { session: f.session })).toEqual({
      kind: 'invalid',
    });
    expect(f.calls).toEqual([]);
  }
});
test('real N1 plus Actions contributions preserve zero-member gaps and unperformed research through T4/T5', async () => {
  const f = fixture();
  const manifest = { dependencies: { widget: '^1' } };
  const npmSession: GithubReadSession = {
    ...f.session,
    discoverFiles: async () => ({
      ...f.discovery,
      files: [{ path: 'package-lock.json', previousPath: null, status: 'modified', blobSha: null }],
    }),
    readFile: async (request) => {
      const { side, path } = request as { side: 'base' | 'head'; path: string };
      const value =
        path === 'package.json'
          ? manifest
          : {
              lockfileVersion: 3,
              packages: {
                '': manifest,
                'node_modules/widget': {
                  version: side === 'base' ? '1.0.0' : '1.1.0',
                  resolved: `https://registry.npmjs.org/widget/-/widget-${side === 'base' ? '1.0.0' : '1.1.0'}.tgz`,
                },
              },
            };
      return {
        kind: 'available',
        side,
        path,
        repository,
        commitSha: side === 'base' ? BASE : HEAD,
        blobSha: 'e'.repeat(40),
        bytes: new TextEncoder().encode(JSON.stringify(value)),
      };
    },
  };
  const npm = await collectNpmInventory(
    {
      binding,
      roots: ['.'],
      configRevision: { repository, sha: 'c'.repeat(40) },
      limits: {
        maxFileBytes: 100_000,
        maxJsonEntries: 10000,
        maxJsonDepth: 32,
        maxRoots: 5,
        maxRetainedBytes: 1_000_000,
      },
    },
    { session: npmSession },
  );
  if (npm.kind !== 'inventory') throw new Error('expected N1 inventory');
  for (const gapOnly of [false, true]) {
    if (gapOnly) f.files[`head:${workflow}`] = 'jobs: [';
    const actions = inventory(await collectActionsInventory(f.input, { session: f.session }));
    const mixed = packet(actions, npm);
    expect(mixed.validated.ok, JSON.stringify(mixed.validated)).toBe(true);
    if (!mixed.validated.ok) throw new Error('expected mixed packet');
    const units = formDecisionUnits(mixed.validated.packet);
    const summary = summarizeDecisionCoverage(units, parseReviewConfig('{"version":1}'), 0);
    if (!summary.ok) throw new Error('expected summary');
    expect(summary.outcome.kind).toBe('decision_incomplete');
    expect(summary.inventoryGaps.some((g) => g.ecosystem === 'actions')).toBe(gapOnly);
    expect(mixed.validated.packet.coverage.npm.status).toBe('complete');
    const wrong = structuredClone(mixed.candidate);
    const action = wrong.changes.find((c) => c.ecosystem === 'actions');
    if (action?.from && action.to) {
      Object.assign(action.to, { sourceId: action.from.sourceId });
      expect(validateReviewPacket(wrong, mixed.expected).ok).toBe(false);
    }
  }
  for (const count of [127, 128]) {
    const actions = fixture();
    many(actions, count);
    const result = inventory(
      await collectActionsInventory(actions.input, { session: actions.session }),
    );
    expect(packet(result, npm).validated.ok).toBe(count === 127);
  }
});
