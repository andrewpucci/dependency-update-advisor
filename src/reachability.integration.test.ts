import { expect, test } from 'vite-plus/test';
import { npmScenario } from '../tests/parity/npm-inventory.js';
import { uvGraphFixture, uvLock, uvManifest, uvPackage } from '../tests/parity/uv-graph.js';
import type { GithubReadSession } from './github-read.js';
import { collectNpmInventory } from './evidence/npm.js';
import { proveNpmRelationships } from './evidence/npm-graph.js';
import { reconcileUvGraph } from './evidence/uv-graph.js';
import { assembleReviewPacket } from './packet.js';
import { formDecisionUnits } from './units.js';

/** Real N1/N2 and U1/U2 output for one multi-anchor PR per ecosystem, through T4 and T5. */
const pkg = (version: string, extra = {}) => ({
  version,
  integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64'),
  resolved: `https://registry.npmjs.org/fixture/-/fixture-${version}.tgz`,
  ...extra,
});
async function npmGraph() {
  const { binding, expected } = npmScenario();
  const manifest = { dependencies: { anchor: '^1', other: '^1' } };
  const lock = (version: string) => ({
    lockfileVersion: 3,
    packages: {
      '': manifest,
      'node_modules/anchor': pkg(version, { dependencies: { child: '^1', both: '^1' } }),
      'node_modules/other': pkg(version, { dependencies: { both: '^1' } }),
      'node_modules/child': pkg(version),
      'node_modules/both': pkg(version),
    },
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
      const version = side === 'base' ? '1.0.0' : '1.1.0';
      return {
        kind: 'available',
        side,
        path,
        repository: binding.repository,
        commitSha: side === 'base' ? binding.baseSha : binding.headSha,
        blobSha: 'e'.repeat(40),
        bytes: Buffer.from(
          JSON.stringify(path.endsWith('package.json') ? manifest : lock(version)),
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
  const limits = { maxGraphWork: 1_000_000, maxRetainedBytes: 4_000_000 };
  const inventory = await collectNpmInventory(
    {
      binding,
      roots: ['.'],
      configRevision: expected.contextRevision,
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
  const graph = proveNpmRelationships({ inventory, binding, limits });
  if (graph.kind !== 'inventory') throw new Error('expected an npm graph');
  return { graph, expected };
}
async function uvGraph() {
  const manifest = uvManifest.replace('["orbit>=1"]', '["orbit>=1","other>=1"]');
  const lock = (v: string) =>
    uvLock(v, 'dependencies=[{name="child"},{name="both"}]\n')
      .replace('dependencies=[{name="orbit"}]', 'dependencies=[{name="orbit"},{name="other"}]')
      .replace(
        'requires-dist=[{name="orbit",specifier=">=1"}]',
        'requires-dist=[{name="orbit",specifier=">=1"},{name="other",specifier=">=1"}]',
      ) +
    uvPackage('child', v) +
    uvPackage('both', v) +
    uvPackage('other', v, 'dependencies=[{name="both"}]\n');
  const graph = reconcileUvGraph(
    await uvGraphFixture({
      'base:pyproject.toml': manifest,
      'head:pyproject.toml': manifest,
      'base:uv.lock': lock('1'),
      'head:uv.lock': lock('2'),
    }),
  );
  if (graph.kind !== 'inventory') throw new Error('expected a uv graph');
  return graph;
}
type NpmResult = Awaited<ReturnType<typeof npmGraph>>['graph'];
type UvResult = Awaited<ReturnType<typeof uvGraph>>;
async function assemble(
  npm: NpmResult,
  uv: UvResult,
  expected: Awaited<ReturnType<typeof npmGraph>>['expected'],
  keepReachability = true,
) {
  const fragment = (ecosystem: 'npm' | 'uv', g: NpmResult | UvResult) => ({
    kind: 'complete' as const,
    ecosystem,
    coverage: g.coverage,
    changes: g.changes,
    sources: g.sources,
    findings: g.findings,
    relationships: g.relationships,
    ...(keepReachability
      ? { reachability: g.reachability, optionalRelationships: g.optionalRelationships }
      : {}),
  });
  const { binding, contextRevision } = expected;
  const result = await assembleReviewPacket({
    trusted: expected,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: {
      npm: async () => fragment('npm', npm),
      uv: async () => fragment('uv', uv),
      actions: async () => ({
        kind: 'complete',
        ecosystem: 'actions',
        coverage: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        changes: [],
        sources: [],
        findings: [],
        relationships: [],
      }),
    },
    inventorySource: {
      id: 'other',
      kind: 'file-list',
      ecosystems: ['actions'],
      memberIds: [],
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'inventory',
        repository: binding.repository,
        baseSha: binding.baseSha,
        headSha: binding.headSha,
        absentEcosystems: ['actions'],
      },
    },
  });
  expect(contextRevision).toBeDefined();
  if (result.kind !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}
const nameOf = (
  packet: { changes: readonly { id: string; from: unknown; to: unknown }[] },
  id: string,
) =>
  (
    (packet.changes.find((c) => c.id === id)!.to ??
      packet.changes.find((c) => c.id === id)!.from) as {
      name: string;
    }
  ).name;

test('multi-anchor npm and uv PRs group under their one reachable anchor, exactly once each', async () => {
  const { graph: npm, expected } = await npmGraph();
  const uv = await uvGraph();
  const { packet, droppedOptional } = await assemble(npm, uv, expected);
  expect(droppedOptional).toEqual([]);
  const { units } = formDecisionUnits(packet);
  const groups = units.filter((u) => u.kind === 'direct_group');
  expect(
    groups.map((u) => [u.ecosystem, u.memberIds.map((id) => nameOf(packet, id)).sort()]).sort(),
  ).toEqual([
    ['npm', ['anchor', 'child']],
    ['uv', ['child', 'orbit']],
  ]);
  for (const group of groups) {
    expect(group.proofKeys).toHaveLength(1);
    expect(group.verdictKeys.length).toBeGreaterThan(0);
  }
  expect(units.flatMap((u) => u.memberIds).sort()).toEqual(packet.changes.map((c) => c.id).sort());
  expect(packet.findings).toHaveLength(npm.findings.length + uv.findings.length);
});

test('a member reachable from both changed anchors stays standalone and ambiguous in each ecosystem', async () => {
  const { graph: npm, expected } = await npmGraph();
  const { packet } = await assemble(npm, await uvGraph(), expected);
  const { units } = formDecisionUnits(packet);
  for (const ecosystem of ['npm', 'uv'] as const) {
    const both = units.find(
      (u) => u.ecosystem === ecosystem && u.memberIds.some((id) => nameOf(packet, id) === 'both'),
    )!;
    expect(both.kind).toBe('standalone');
    expect(both.relationship.reason).toBe('ambiguous_anchors');
  }
});

test('empty reachability reproduces the legacy standalone units for the same PR', async () => {
  const { graph: npm, expected } = await npmGraph();
  const uv = await uvGraph();
  const { packet } = await assemble(npm, uv, expected, false);
  expect(packet.reachability).toEqual([]);
  const { units } = formDecisionUnits(packet);
  expect(units.every((u) => u.kind === 'standalone')).toBe(true);
  const members = units.filter((u) => u.relationship.reason === 'multiple_direct_changes');
  expect(members.map((u) => nameOf(packet, u.memberIds[0])).sort()).toEqual([
    'both',
    'both',
    'child',
    'child',
  ]);
});

test('every missing or dropped reachability record degrades to standalone, never a group', async () => {
  const { graph: npm, expected } = await npmGraph();
  const uv = await uvGraph();
  const groups = (units: ReturnType<typeof formDecisionUnits>['units']) =>
    units.filter((u) => u.kind === 'direct_group').length;
  const full = await assemble(npm, uv, expected);
  expect(groups(formDecisionUnits(full.packet).units)).toBe(2);
  const noVerdicts = await assemble(
    { ...npm, reachability: [] },
    { ...uv, reachability: [] },
    expected,
  );
  const none = formDecisionUnits(noVerdicts.packet).units;
  expect(groups(none)).toBe(0);
  expect(none.some((u) => u.relationship.reason === 'multiple_direct_changes')).toBe(true);
  const noSecondProofs = await assemble(
    { ...npm, optionalRelationships: [] },
    { ...uv, optionalRelationships: [] },
    expected,
  );
  const units = formDecisionUnits(noSecondProofs.packet).units;
  expect(groups(units)).toBe(2);
  const both = units.filter((u) =>
    u.memberIds.some((id) => nameOf(noSecondProofs.packet, id) === 'both'),
  );
  expect(both.map((u) => u.relationship.reason)).toEqual([
    'reachability_unproven',
    'reachability_unproven',
  ]);
  expect(units.flatMap((u) => u.memberIds).sort()).toEqual(
    noSecondProofs.packet.changes.map((c) => c.id).sort(),
  );
});

test('assembly and units are deterministic under input permutation', async () => {
  const { graph: npm, expected } = await npmGraph();
  const uv = await uvGraph();
  const first = formDecisionUnits((await assemble(npm, uv, expected)).packet).units;
  const permuted = (g: NpmResult | UvResult) => ({
    ...g,
    reachability: [...g.reachability].reverse(),
    changes: [...g.changes].reverse(),
    sources: [...g.sources].reverse(),
  });
  const second = formDecisionUnits(
    (await assemble(permuted(npm) as NpmResult, permuted(uv) as UvResult, expected)).packet,
  ).units;
  expect(second).toEqual(first);
});
