import { expect, test } from 'vite-plus/test';
import { collectNpmInventory } from './npm.js';
import type { GithubReadSession } from '../github-read.js';
import { npmScenario } from '../../tests/parity/npm-inventory.js';
import { proveNpmRelationships } from './npm-graph.js';

const limits = { maxGraphWork: 100_000, maxRetainedBytes: 2_000_000 };
const pkg = (version: string, extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/fixture/-/fixture-${version}.tgz`,
  ...extra,
});
async function graphFixture(
  head: Record<string, unknown> = {},
  base: Record<string, unknown> = {},
  dependencies = { anchor: '^1' },
) {
  const { binding } = npmScenario();
  const packages = (side: 'base' | 'head') => ({
    '': { dependencies },
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
      files: [{ path: 'package-lock.json', previousPath: null, status: 'modified', blobSha: null }],
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
            path === 'package.json'
              ? { dependencies }
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
      roots: ['.'],
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
