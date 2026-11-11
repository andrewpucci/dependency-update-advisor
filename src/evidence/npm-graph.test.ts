import { expect, test } from 'vite-plus/test';
import { collectNpmInventory } from './npm.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits } from '../units.js';
import type { GithubReadSession } from '../github-read.js';
import { npmScenario } from '../../tests/parity/npm-inventory.js';
import { proveNpmRelationships, enrichNpmEvidence } from './npm-graph.js';

const limits = { maxGraphWork: 100_000, maxRetainedBytes: 2_000_000 };
const pkg = (version: string, extra = {}) => ({
  version,
  integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64'),
  resolved: `https://registry.npmjs.org/fixture/-/fixture-${version}.tgz`,
  ...extra,
});
async function graphFixture(
  head: Record<string, unknown> = {},
  base: Record<string, unknown> = {},
  dependencies: Record<string, string> = { anchor: '^1' },
  baseDependencies = dependencies,
  root = '.',
) {
  const { binding } = npmScenario();
  const packages = (side: 'base' | 'head') => ({
    '': { dependencies: side === 'base' ? baseDependencies : dependencies },
    'node_modules/anchor': pkg(side === 'base' ? '1.0.0' : '1.1.0', {
      dependencies: { child: '^1' },
    }),
    'node_modules/child': pkg(side === 'base' ? '1.0.0' : '1.1.0'),
    ...(side === 'head' ? head : base),
  });
  const session: GithubReadSession = {
    discoverFiles: async () => ({
      kind: 'available',
      binding,
      complete: true,
      reasons: [],
      files: [
        {
          path: (root === '.' ? '' : root + '/') + 'package-lock.json',
          previousPath: null,
          status: 'modified',
          blobSha: null,
        },
      ],
    }),
    readFile: async (value) => {
      const { side, path } = value as { side: 'base' | 'head'; path: string };
      return {
        kind: 'available',
        side,
        path,
        repository: binding.repository,
        commitSha: side === 'base' ? binding.baseSha : binding.headSha,
        blobSha: 'e'.repeat(40),
        bytes: Buffer.from(
          JSON.stringify(
            path.endsWith('package.json')
              ? { dependencies: side === 'base' ? baseDependencies : dependencies }
              : {
                  lockfileVersion: 3,
                  packages: packages(side),
                },
          ),
        ),
      };
    },
    readComparison: async () => ({
      kind: 'available',
      repository: binding.repository,
      headRepository: binding.headRepository,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      mergeBaseSha: binding.mergeBaseSha,
      reasons: [],
      records: [],
    }),
    close: () => {},
  };
  const inventory = await collectNpmInventory(
    {
      binding,
      roots: [root],
      configRevision: { repository: binding.repository, sha: 'c'.repeat(40) },
      limits: {
        maxFileBytes: 500_000,
        maxJsonEntries: 100_000,
        maxJsonDepth: 32,
        maxRoots: 10,
        maxRetainedBytes: 2_000_000,
      },
    },
    { session },
  );
  if (inventory.kind !== 'inventory') throw new Error('expected inventory');
  return { inventory, binding, limits };
}

test('proves the exact changed head instance without mutating N1 inventory', async () => {
  const input = await graphFixture();
  const before = structuredClone(input.inventory);
  const result = proveNpmRelationships(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  const anchor = input.inventory.changes.find((c) => c.role === 'direct')!;
  const child = input.inventory.changes.find((c) => c.role === 'transitive')!;
  expect(result.relationships).toEqual([
    {
      fromId: anchor.id,
      toId: child.id,
      ecosystem: 'npm',
      side: 'head',
      sourceId: anchor.to!.sourceId,
      path: [anchor.to, child.to],
    },
  ]);
  expect(result.changes).toEqual(input.inventory.changes);
  expect(input.inventory).toEqual(before);
  expect(Object.isFrozen(result.relationships[0].path)).toBe(true);
});

test.each(['invalid', 'obsolete'] as const)('preserves the N1 %s outcome', (kind) => {
  const { binding } = npmScenario();
  expect(proveNpmRelationships({ binding, inventory: { kind }, limits })).toEqual({ kind });
});

test('rejects revision disagreement and invalid limits without useful evidence', async () => {
  const input = await graphFixture();
  expect(
    proveNpmRelationships({ ...input, binding: { ...input.binding, baseSha: 'd'.repeat(40) } }),
  ).toEqual({ kind: 'invalid' });
  expect(proveNpmRelationships({ ...input, limits: { ...limits, maxGraphWork: 0 } })).toEqual({
    kind: 'invalid',
  });
});

test('includes unchanged intermediate packages in a head proof', async () => {
  const shared = { 'node_modules/middle': pkg('1.0.0', { dependencies: { child: '^1' } }) };
  const input = await graphFixture(
    {
      ...shared,
      'node_modules/anchor': pkg('1.1.0', { dependencies: { middle: '^1' } }),
    },
    {
      ...shared,
      'node_modules/anchor': pkg('1.0.0', { dependencies: { middle: '^1' } }),
    },
  );
  const result = proveNpmRelationships(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  expect(result.relationships[0].path.map((p) => p.lockPath)).toEqual([
    'node_modules/anchor',
    'node_modules/middle',
    'node_modules/child',
  ]);
});

test('uses only the base lockfile to prove a removed transitive instance', async () => {
  const input = await graphFixture({ 'node_modules/child': undefined });
  const result = proveNpmRelationships(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  expect(result.relationships).toMatchObject([
    {
      side: 'base',
      path: [
        { name: 'anchor', version: '1.0.0' },
        { name: 'child', version: '1.0.0' },
      ],
    },
  ]);
});

test('partial inventory and missing snapshots never prove an absent relationship', async () => {
  const input = await graphFixture();
  for (const inventory of [
    { ...input.inventory, coverage: { ...input.inventory.coverage, status: 'partial' } },
    { ...input.inventory, roots: [] },
  ]) {
    const result = proveNpmRelationships({ ...input, inventory });
    expect(result.kind).toBe('inventory');
    if (result.kind === 'inventory') {
      expect(result.relationships).toEqual([]);
      expect(result.changes).toEqual(inventory.changes);
    }
  }
  expect(
    proveNpmRelationships({ ...input, inventory: { kind: 'unavailable', reason: 'permission' } }),
  ).toEqual({ kind: 'unavailable', reason: 'permission' });
  expect(proveNpmRelationships({ ...input, limits: { ...limits, maxGraphWork: 1 } })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});

test('proves installed optional edges with optional-map precedence', async () => {
  const input = await graphFixture({
    'node_modules/anchor': pkg('1.1.0', {
      dependencies: { child: 'git+https://example.com/unsupported' },
      optionalDependencies: { child: '^1', absent: '^1' },
    }),
  });
  const result = proveNpmRelationships(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  expect(result.relationships).toHaveLength(1);
  const optionalOnly = await graphFixture({
    'node_modules/anchor': pkg('1.1.0', {
      optionalDependencies: { child: '^1' },
    }),
  });
  const graph = proveNpmRelationships(optionalOnly);
  expect(graph.kind === 'inventory' && graph.relationships).toHaveLength(1);
});

test('never accepts unsupported edge specifiers merely because a same-name slot exists', async () => {
  for (const spec of [
    'git+https://example.com/child',
    'file:../child',
    'workspace:*',
    'https://example.com/child.tgz',
  ]) {
    const input = await graphFixture({
      'node_modules/anchor': pkg('1.1.0', { dependencies: { child: spec } }),
    });
    const result = proveNpmRelationships(input);
    expect(result.kind === 'inventory' && result.relationships).toEqual([]);
  }
});

test('nearest nested duplicate shadows a farther changed package', async () => {
  const nested = { 'node_modules/anchor/node_modules/child': pkg('1.0.0') };
  const input = await graphFixture(nested, nested);
  const result = proveNpmRelationships(input);
  expect(result.kind === 'inventory' && result.relationships).toEqual([]);
});

test('scoped enclosing slots look up hoisted packages without treating scope as a parent', async () => {
  const extra = {
    'node_modules/anchor/node_modules/@s/middle': pkg('1.0.0', { dependencies: { child: '^1' } }),
  };
  const input = await graphFixture(
    { ...extra, 'node_modules/anchor': pkg('1.1.0', { dependencies: { '@s/middle': '^1' } }) },
    { ...extra, 'node_modules/anchor': pkg('1.0.0', { dependencies: { '@s/middle': '^1' } }) },
  );
  const result = proveNpmRelationships(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  expect(result.relationships[0].path.map((p) => p.lockPath)).toEqual([
    'node_modules/anchor',
    'node_modules/anchor/node_modules/@s/middle',
    'node_modules/child',
  ]);
});

test('alias edges require the exact established target identity', async () => {
  for (const targetName of ['real-child', 'wrong-child']) {
    const input = await graphFixture(
      {
        'node_modules/anchor': pkg('1.1.0', { dependencies: { child: 'npm:real-child@^1' } }),
        'node_modules/child': pkg('1.1.0', { name: targetName }),
      },
      { 'node_modules/child': pkg('1.0.0', { name: targetName }) },
    );
    const result = proveNpmRelationships(input);
    expect(result.kind === 'inventory' && result.relationships.length).toBe(
      targetName === 'real-child' ? 1 : 0,
    );
  }
});

test('cycles and diamonds choose one shortest canonical path under input permutations', async () => {
  const extra = {
    'node_modules/left': pkg('1.0.0', { dependencies: { child: '^1', anchor: '^1' } }),
    'node_modules/right': pkg('1.0.0', { dependencies: { child: '^1' } }),
  };
  const input = await graphFixture(
    {
      ...extra,
      'node_modules/anchor': pkg('1.1.0', { dependencies: { right: '^1', left: '^1' } }),
    },
    {
      ...extra,
      'node_modules/anchor': pkg('1.0.0', { dependencies: { right: '^1', left: '^1' } }),
    },
  );
  const result = proveNpmRelationships(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  expect(result.relationships[0].path.map((p) => p.name)).toEqual(['anchor', 'left', 'child']);
  const reordered = {
    ...input,
    inventory: {
      ...input.inventory,
      roots: input.inventory.roots.map((root) => ({
        ...root,
        base: {
          ...root.base,
          packages: Object.fromEntries(Object.entries(root.base.packages).reverse()),
        },
        head: {
          ...root.head,
          packages: Object.fromEntries(Object.entries(root.head.packages).reverse()),
        },
      })),
    },
  };
  const reversed = proveNpmRelationships(reordered);
  expect(reversed.kind === 'inventory' && reversed.relationships).toEqual(result.relationships);
});

test('an unresolved nearer lookup position blocks a farther proven slot', async () => {
  const input = await graphFixture();
  const roots = input.inventory.roots.map((root) => ({
    ...root,
    head: {
      ...root.head,
      unresolvedPaths: ['node_modules/anchor/node_modules/child'],
    },
  }));
  const result = proveNpmRelationships({ ...input, inventory: { ...input.inventory, roots } });
  expect(result.kind === 'inventory' && result.relationships).toEqual([]);
});

test('sharing with an unchanged direct parent stays attributable without blocking the single changed anchor', async () => {
  const other = { 'node_modules/other': pkg('1.0.0', { dependencies: { child: '^1' } }) };
  const input = await graphFixture(other, other, { anchor: '^1', other: '^1' });
  const graph = proveNpmRelationships(input);
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  expect(graph.relationships).toHaveLength(1);
  expect(graph.findings).toContainEqual(
    expect.objectContaining({
      kind: 'informational',
      detail: expect.stringContaining('unchanged direct'),
    }),
  );
});

test('multiple changed anchors stay standalone with attributable diagnostics', async () => {
  const input = await graphFixture(
    { 'node_modules/other': pkg('1.1.0') },
    { 'node_modules/other': pkg('1.0.0') },
    { anchor: '^1', other: '^1' },
  );
  const graph = proveNpmRelationships(input);
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  expect(graph.relationships).toEqual([]);
  expect(graph.findings).toContainEqual(
    expect.objectContaining({ detail: expect.stringContaining('multiple changed direct') }),
  );
});

test('orphaned members keep a visible unproven path rather than an absence claim', async () => {
  const input = await graphFixture({ 'node_modules/anchor': pkg('1.1.0') });
  const graph = proveNpmRelationships(input);
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  expect(graph.relationships).toEqual([]);
  const member = input.inventory.changes.find((c) => c.role === 'transitive')!;
  expect(graph.findings).toContainEqual(
    expect.objectContaining({
      memberId: member.id,
      detail: expect.stringContaining('unproven'),
      references: [member.to!.sourceId],
    }),
  );
  expect(graph.coverage).toEqual(input.inventory.coverage);
});

test('a direct removal still counts beside a head-side direct update', async () => {
  const input = await graphFixture(
    { 'node_modules/other': undefined },
    { 'node_modules/other': pkg('1.0.0') },
    { anchor: '^1' },
    { anchor: '^1', other: '^1' },
  );
  const graph = proveNpmRelationships(input);
  expect(input.inventory.coverage.status).toBe('complete');
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  expect(graph.relationships).toEqual([]);
  expect(graph.findings).toContainEqual(
    expect.objectContaining({ detail: expect.stringContaining('multiple changed direct') }),
  );
});

const registryLimits = {
  maxRequests: 20,
  maxResponseBytes: 50_000,
  maxTotalBytes: 500_000,
  maxJsonEntries: 100_000,
  maxJsonDepth: 32,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
function registryFetch(calls: string[], scripts = {}) {
  return async (url: string) => {
    calls.push(url);
    const [name, version] = new URL(url).pathname.slice(1).split('/').map(decodeURIComponent);
    return new Response(
      JSON.stringify({
        _id: name + '@' + version,
        name,
        version,
        dist: { integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64') },
        scripts,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
}

test('one immutable N2 handoff composes proven paths and lifecycle evidence without changing other coverage', async () => {
  const input = await graphFixture();
  const calls: string[] = [];
  const result = await enrichNpmEvidence(
    { ...input, limits: { ...input.limits, ...registryLimits } },
    { now: () => 0, fetch: registryFetch(calls) },
  );
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected enriched result');
  expect(result.relationships).toHaveLength(1);
  expect(result.changes.every((c) => c.evidence.installScript.status === 'available')).toBe(true);
  expect(result.changes.every((c) => c.evidence.upstream.status === 'unavailable')).toBe(true);
  expect(result.coverage).toEqual(input.inventory.coverage);
  expect(result.comparison).toEqual(input.inventory.comparison);
  expect(result.changes.map((c) => [c.id, c.from, c.to])).toEqual(
    input.inventory.changes.map((c) => [c.id, c.from, c.to]),
  );
  expect(Object.isFrozen(result.changes[0].evidence)).toBe(true);
  expect(calls).toHaveLength(4);
});

test('a shared request budget leaves explicit lifecycle gaps without losing inventory', async () => {
  const input = await graphFixture();
  const calls: string[] = [];
  const result = await enrichNpmEvidence(
    { ...input, limits: { ...input.limits, ...registryLimits, maxRequests: 1 } },
    { now: () => 0, fetch: registryFetch(calls) },
  );
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected enriched result');
  expect(result.changes).toHaveLength(input.inventory.changes.length);
  expect(result.changes.some((c) => c.evidence.installScript.reasons.includes('budget'))).toBe(
    true,
  );
  expect(result.coverage).toEqual(input.inventory.coverage);
  expect(calls).toHaveLength(1);
});

test('snapshot/instance disagreement cannot send a registry request', async () => {
  const input = await graphFixture();
  const calls: string[] = [];
  const changes = input.inventory.changes.map((c) => ({
    ...c,
    to: c.to && { ...c.to, name: 'wrong-package' },
  }));
  const result = await enrichNpmEvidence(
    {
      ...input,
      inventory: { ...input.inventory, changes },
      limits: { ...input.limits, ...registryLimits },
    },
    { now: () => 0, fetch: registryFetch(calls) },
  );
  expect(result).toEqual({ kind: 'invalid' });
  expect(calls).toHaveLength(0);
});

test('split-source limits preserve exact endpoint identities and every input record', async () => {
  const extra = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => ['node_modules/extra-' + i, pkg('1.0.0')]),
  );
  const dependencies = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => ['extra-' + i, '^1']),
  );
  const input = await graphFixture({
    ...extra,
    'node_modules/anchor': pkg('1.1.0', { dependencies: { child: '^1', ...dependencies } }),
  });
  const result = proveNpmRelationships(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  expect(result.changes).toEqual(input.inventory.changes);
  expect(result.findings).toContainEqual(
    expect.objectContaining({ detail: expect.stringContaining('lock-source membership') }),
  );
  expect(
    result.relationships.every((proof) => proof.path[0].sourceId === proof.path.at(-1)!.sourceId),
  ).toBe(true);
});

test('an overlong path is never truncated into a packet proof', async () => {
  const extra: Record<string, unknown> = {};
  for (let i = 0; i < 32; i++)
    extra['node_modules/mid-' + i] = pkg('1.0.0', {
      dependencies: { [i === 31 ? 'child' : 'mid-' + (i + 1)]: '^1' },
    });
  const input = await graphFixture(
    { ...extra, 'node_modules/anchor': pkg('1.1.0', { dependencies: { 'mid-0': '^1' } }) },
    { ...extra, 'node_modules/anchor': pkg('1.0.0', { dependencies: { 'mid-0': '^1' } }) },
  );
  const graph = proveNpmRelationships(input);
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  expect(graph.relationships).toEqual([]);
  expect(graph.findings).toContainEqual(
    expect.objectContaining({ detail: expect.stringContaining('full path exceeds') }),
  );
});

test('packet overflow fails explicitly before registry reads, without exposing a trimmed inventory', async () => {
  const extra = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => ['node_modules/extra-' + i, pkg('1.0.0')]),
  );
  const input = await graphFixture(extra);
  expect(input.inventory.changes.length).toBeGreaterThan(128);
  const calls: string[] = [];
  const result = await enrichNpmEvidence(
    { ...input, limits: { ...input.limits, ...registryLimits } },
    { now: () => 0, fetch: registryFetch(calls) },
  );
  expect(result).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(calls).toHaveLength(0);
});

test('late retention overflow returns no partial enriched result', async () => {
  const input = await graphFixture();
  const graph = proveNpmRelationships(input);
  const minimum =
    Math.max(Buffer.byteLength(JSON.stringify(input)), Buffer.byteLength(JSON.stringify(graph))) +
    32;
  const calls: string[] = [];
  const result = await enrichNpmEvidence(
    { ...input, limits: { ...input.limits, ...registryLimits, maxRetainedBytes: minimum } },
    { now: () => 0, fetch: registryFetch(calls) },
  );
  expect(result).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(calls.length).toBeGreaterThan(0);
});

function validatedGraphUnits(
  input: Awaited<ReturnType<typeof graphFixture>>,
  graph: Extract<ReturnType<typeof proveNpmRelationships>, { kind: 'inventory' }>,
) {
  const fixture = npmScenario();
  const packet = validateReviewPacket(
    {
      version: 1,
      ...fixture.expected,
      changes: graph.changes,
      sources: [...graph.sources, fixture.absent],
      findings: graph.findings,
      relationships: graph.relationships,
      reachability: [],
      coverage: {
        npm: graph.coverage,
        actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
      },
    },
    fixture.expected,
  );
  expect(input.binding).toEqual(fixture.binding);
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (!packet.ok) throw new Error('expected packet');
  return formDecisionUnits(packet.packet);
}

test.each(['orphan', 'multi-anchor', 'unknown'] as const)(
  'the real unit boundary retains %s standalone relationships and exact member accounting',
  async (mode) => {
    const input =
      mode === 'multi-anchor'
        ? await graphFixture(
            { 'node_modules/other': pkg('1.1.0') },
            { 'node_modules/other': pkg('1.0.0') },
            { anchor: '^1', other: '^1' },
          )
        : await graphFixture(mode === 'orphan' ? { 'node_modules/anchor': pkg('1.1.0') } : {});
    const inventory =
      mode === 'unknown'
        ? {
            ...input.inventory,
            changes: input.inventory.changes.map((c) =>
              c.role === 'transitive' ? { ...c, role: 'unknown' as const } : c,
            ),
          }
        : input.inventory;
    const graph = proveNpmRelationships({ ...input, inventory });
    expect(graph.kind).toBe('inventory');
    if (graph.kind !== 'inventory') throw new Error('expected graph');
    const units = validatedGraphUnits(input, graph);
    expect(units.units.every((u) => u.kind === 'standalone')).toBe(true);
    expect(units.units.flatMap((u) => u.memberIds).sort()).toEqual(
      inventory.changes.map((c) => c.id).sort(),
    );
    expect(graph.changes.map((c) => c.evidence)).toEqual(inventory.changes.map((c) => c.evidence));
  },
);

test('known unchanged-parent sharing is accepted by T4 and preserved within a T5 group', async () => {
  const other = { 'node_modules/other': pkg('1.0.0', { dependencies: { child: '^1' } }) };
  const input = await graphFixture(other, other, { anchor: '^1', other: '^1' });
  const graph = proveNpmRelationships(input);
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  const units = validatedGraphUnits(input, graph);
  expect(units.units).toHaveLength(1);
  expect(
    units.units[0].findings.some(
      (f) => f.kind === 'informational' && f.detail.includes('unchanged direct'),
    ),
  ).toBe(true);
});

test('independent nested roots can never produce a cross-root proof', async () => {
  const first = await graphFixture(),
    nested = await graphFixture({}, {}, { anchor: '^1' }, { anchor: '^1' }, 'nested');
  const inventory = {
    ...first.inventory,
    changes: [...first.inventory.changes, ...nested.inventory.changes],
    roots: [...first.inventory.roots, ...nested.inventory.roots],
    sources: [
      ...first.inventory.sources,
      ...nested.inventory.sources.filter((s) => s.id !== 'npm:inventory'),
    ],
  };
  const graph = proveNpmRelationships({ ...first, inventory });
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  expect(graph.relationships).toHaveLength(2);
  expect(graph.relationships.every((p) => new Set(p.path.map((s) => s.root)).size === 1)).toBe(
    true,
  );
  const units = validatedGraphUnits(first, graph);
  expect(units.units).toHaveLength(2);
});

async function sharedNestedRoots() {
  const unchanged = { 'node_modules/anchor': pkg('1.0.0', { dependencies: { child: '^1' } }) };
  const nested = await graphFixture(
    { ...unchanged, 'node_modules/a2': pkg('1.1.0', { dependencies: { child: '^1' } }) },
    { ...unchanged, 'node_modules/a2': pkg('1.0.0', { dependencies: { child: '^1' } }) },
    { anchor: '^1', a2: '^1' },
    { anchor: '^1', a2: '^1' },
    'nested',
  );
  const first = await graphFixture();
  const inventory = {
    ...first.inventory,
    changes: [...first.inventory.changes, ...nested.inventory.changes],
    roots: [...first.inventory.roots, ...nested.inventory.roots],
    sources: [
      ...first.inventory.sources,
      ...nested.inventory.sources.filter((s) => s.id !== 'npm:inventory'),
    ],
  };
  return { input: { ...first, inventory }, nested };
}

test('a changed slot in another root never hides unchanged-direct sharing', async () => {
  const { input, nested } = await sharedNestedRoots();
  const graph = proveNpmRelationships(input);
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  const child = nested.inventory.changes.find((c) => c.role === 'transitive')!;
  expect(graph.relationships).toHaveLength(2);
  expect(graph.findings).toEqual([
    expect.objectContaining({
      memberId: child.id,
      detail: expect.stringContaining('unchanged direct'),
    }),
  ]);
});

test('relationship output survives root, source, and change order changes', async () => {
  const { input } = await sharedNestedRoots();
  const reversed = {
    ...input,
    inventory: {
      ...input.inventory,
      changes: [...input.inventory.changes].reverse(),
      sources: [...input.inventory.sources].reverse(),
      roots: [...input.inventory.roots].reverse(),
    },
  };
  const first = proveNpmRelationships(input);
  expect(first.kind).toBe('inventory');
  expect(proveNpmRelationships(reversed)).toEqual(first);
});

test('handoff identities and attempted requests survive input order changes and later input mutation', async () => {
  const input = await graphFixture();
  const reversed = {
    ...input,
    inventory: {
      ...input.inventory,
      changes: [...input.inventory.changes].reverse(),
      sources: [...input.inventory.sources].reverse(),
      roots: [...input.inventory.roots].reverse(),
    },
    limits: { ...input.limits, ...registryLimits },
  };
  const firstCalls: string[] = [],
    secondCalls: string[] = [];
  const first = await enrichNpmEvidence(
    { ...input, limits: reversed.limits },
    { now: () => 0, fetch: registryFetch(firstCalls) },
  );
  const second = await enrichNpmEvidence(reversed, {
    now: () => 0,
    fetch: registryFetch(secondCalls),
  });
  expect(second).toEqual(first);
  expect(secondCalls).toEqual(firstCalls);
  const mutable = structuredClone({ ...input, limits: reversed.limits });
  const promise = enrichNpmEvidence(mutable, { now: () => 0, fetch: registryFetch([]) });
  const node = mutable.inventory.roots[0].head.packages['node_modules/anchor'].instance!;
  node.version = '9.9.9';
  const result = await promise;
  expect(result).toEqual(first);
});

test.each(['^1.1.0-beta.1', 'next'])(
  'registry prerelease and tag specifiers retain a proven installed relationship (%s)',
  async (specifier) => {
    const input = await graphFixture({
      'node_modules/anchor': pkg('1.1.0', { dependencies: { child: specifier } }),
    });
    const graph = proveNpmRelationships(input);
    expect(graph.kind === 'inventory' && graph.relationships).toHaveLength(1);
  },
);

test('same-instance metadata-only changes preserve N1 gaps without invented resolved updates', async () => {
  const input = await graphFixture(
    { 'node_modules/child': pkg('1.0.0', { hasInstallScript: true }) },
    { 'node_modules/child': pkg('1.0.0') },
  );
  expect(input.inventory.coverage.status).toBe('partial');
  expect(input.inventory.gaps).toContainEqual(expect.objectContaining({ reason: 'unsupported' }));
  expect(input.inventory.changes).toHaveLength(1);
  const result = await enrichNpmEvidence(
    { ...input, limits: { ...input.limits, ...registryLimits } },
    { now: () => 0, fetch: registryFetch([]) },
  );
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected graph');
  expect(result.gaps).toEqual(input.inventory.gaps);
  expect(result.changes.map((c) => c.id)).toEqual(input.inventory.changes.map((c) => c.id));
  expect(result.relationships).toEqual([]);
  validatedGraphUnits(input, result);
});
