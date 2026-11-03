import { validateReviewPacket, type PacketSource } from '../../src/schema.js';
import { createGithubReadSession, type JsonValue } from '../../src/github-read.js';
import { collectNpmInventory } from '../../src/evidence/npm.js';
import { proveNpmRelationships } from '../../src/evidence/npm-graph.js';
import type { PublicPackageIdentity, AdvisoryInput } from '../../src/evidence/advisories.js';
import { npmScenario } from './npm-inventory.js';
import { uvMetadataScenario } from './uv-metadata.js';
import { uvManifest, uvLock, uvPacket } from './uv-graph.js';
import { collectUvMetadata } from '../../src/evidence/uv.js';
import { reconcileUvGraph } from '../../src/evidence/uv-graph.js';
import { actionsScenario } from './actions-inventory.js';
import { collectActionsInventory } from '../../src/evidence/actions.js';
import type { ActionVersionMapping } from '../../src/evidence/advisories.js';

export const advisoryTestLimits = {
  maxRequests: 1000,
  maxPages: 1000,
  maxResponseBytes: 500_000,
  maxTotalBytes: 10_000_000,
  maxJsonEntries: 500_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 2_000_000,
  maxFindings: 512,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 30_000,
};
export const syntheticAdvisory = {
  ghsa_id: 'GHSA-aaaa-bbbb-cccc',
  html_url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  summary: 'Synthetic vulnerability',
  type: 'reviewed',
  severity: 'high',
  withdrawn_at: null,
  vulnerabilities: [
    { package: { ecosystem: 'npm', name: 'fixture-anchor' }, vulnerable_version_range: '>=1.1.0' },
  ],
};

/** Invented proof data exercises S1's trusted producer boundary; no public identity was fetched. */
export function syntheticPublicProofs(changes: AdvisoryInput['changes']) {
  const sources: PacketSource[] = [],
    publicIdentities: PublicPackageIdentity[] = [];
  for (const c of changes)
    for (const side of ['base', 'head'] as const) {
      const s = side === 'base' ? c.from : c.to;
      if (!s || !('source' in s) || c.ecosystem === 'actions') continue;
      const id = `synthetic-public:${c.id}:${side}`;
      const origin = c.ecosystem === 'npm' ? 'https://registry.npmjs.org' : 'https://pypi.org';
      sources.push({
        id,
        kind: 'metadata',
        ecosystems: [c.ecosystem],
        memberIds: [c.id],
        status: 'available',
        reasons: [],
        provenance: {
          kind: 'upstream',
          url: `${origin}/${encodeURIComponent(s.name)}/${encodeURIComponent(s.version)}`,
          title: 'Synthetic exact public metadata proof',
          excerpt: 'Invented producer proof for tests.',
          excerptTruncated: false,
          subjects: [{ memberId: c.id, side, value: s.version }],
          range: {
            from: side === 'base' ? s.version : null,
            to: side === 'head' ? s.version : null,
          },
        },
      });
      publicIdentities.push({
        memberId: c.id,
        side,
        ecosystem: c.ecosystem,
        name: s.name,
        version: s.version,
        sourceIdentity: s.source.identity,
        sourceIds: [id],
      });
    }
  return { sources, publicIdentities };
}
export async function collectAdvisoryNpm(
  mode = 'empty',
  additions = 1,
  rows?: Readonly<Record<string, JsonValue>>[],
) {
  const fixture = npmScenario(additions, false, mode);
  const opened = await createGithubReadSession(
    {
      binding: fixture.binding,
      limits: {
        ...advisoryTestLimits,
        maxFiles: 1000,
        maxFileBytes: 500_000,
      },
    },
    {
      now: () => 0,
      fetch: async (url, init) =>
        rows && url.includes('/dependency-graph/compare/')
          ? Response.json(rows)
          : fixture.fetch(url, init),
    },
  );
  if (opened.kind !== 'ready') throw new Error('expected actual D1 session');
  try {
    const inventory = await collectNpmInventory(
      {
        binding: fixture.binding,
        roots: ['.'],
        configRevision: fixture.expected.contextRevision,
        limits: { ...advisoryTestLimits, maxFileBytes: 500_000, maxRoots: 10 },
      },
      { session: opened.session },
    );
    if (inventory.kind !== 'inventory') throw new Error('expected actual N1 inventory');
    const comparison = await opened.session.readComparison();
    const proofs = syntheticPublicProofs(inventory.changes);
    const input: AdvisoryInput = {
      binding: inventory.binding,
      changes: inventory.changes,
      sources: [...inventory.sources, ...proofs.sources],
      publicIdentities: proofs.publicIdentities,
      findings: [],
      comparisons: [comparison],
      limits: advisoryTestLimits,
    };
    return { fixture, inventory, comparison, input };
  } finally {
    opened.session.close();
  }
}

export async function collectAdvisoryUv(registry = 'https://pypi.org/simple') {
  const replace = (version: string) =>
    uvLock(version).replaceAll('https://pypi.org/simple', registry);
  const fixture = uvMetadataScenario('permission403', {
    files: {
      base: { 'pyproject.toml': uvManifest, 'uv.lock': replace('1.0') },
      head: { 'pyproject.toml': uvManifest, 'uv.lock': replace('2.0rc1') },
    },
  });
  const opened = await createGithubReadSession(
    { binding: fixture.input.binding, limits: fixture.readLimits },
    { fetch: fixture.fetch, now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('D1');
  try {
    const metadata = await collectUvMetadata(fixture.input, { session: opened.session });
    const inventory = reconcileUvGraph({
      binding: fixture.input.binding,
      metadata,
      limits: { maxGraphWork: 1_000_000, maxRetainedBytes: 2_000_000 },
    });
    if (inventory.kind !== 'inventory') throw new Error('U2');
    const proofs = syntheticPublicProofs(inventory.changes);
    const input: AdvisoryInput = {
      binding: inventory.binding,
      changes: inventory.changes,
      sources: [...inventory.sources, ...proofs.sources],
      findings: inventory.findings,
      publicIdentities: proofs.publicIdentities,
      limits: advisoryTestLimits,
    };
    const scaffold = uvPacket(inventory);
    const validated = validateReviewPacket(scaffold.packet, scaffold.expected);
    if (!validated.ok) throw new Error('valid uv scaffold');
    return { fixture, inventory, input, expected: scaffold.expected, packet: validated.packet };
  } finally {
    opened.session.close();
  }
}

export async function collectAdvisoryActions(mapped = false) {
  const fixture = actionsScenario();
  const opened = await createGithubReadSession(
    { binding: fixture.binding, limits: fixture.readLimits },
    { fetch: fixture.fetch, now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('D1');
  try {
    const inventory = await collectActionsInventory(
      {
        binding: fixture.binding,
        limits: {
          maxFileBytes: 100_000,
          maxWorkflows: 20,
          maxYamlNodes: 100_000,
          maxYamlDepth: 32,
          maxAliasExpansions: 100,
          maxOccurrences: 1000,
          maxRetainedBytes: 2_000_000,
        },
      },
      { session: opened.session },
    );
    if (inventory.kind !== 'inventory') throw new Error('X1');
    const sources: PacketSource[] = [],
      actionVersions: ActionVersionMapping[] = [];
    if (mapped)
      for (const c of inventory.changes)
        for (const side of ['base', 'head'] as const) {
          const s = side === 'base' ? c.from : c.to;
          if (!s || !('action' in s)) continue;
          const name = s.action.split('/').slice(0, 2).join('/'),
            version = side === 'base' ? '1.0.0' : '2.0.0';
          const id = `synthetic-action-map:${c.id}:${side}`;
          sources.push({
            id,
            kind: 'release',
            ecosystems: ['actions'],
            memberIds: [c.id],
            status: 'available',
            reasons: [],
            provenance: {
              kind: 'upstream',
              url: `https://github.com/${name}/releases/tag/v${version}`,
              title: 'Synthetic mapping proof',
              excerpt: `Invented mapping: ${s.action}@${s.ref} to ${name}@${version}.`,
              excerptTruncated: false,
              subjects: [{ memberId: c.id, side, value: s.ref }],
              range: { from: side === 'base' ? s.ref : null, to: side === 'head' ? s.ref : null },
            },
          });
          actionVersions.push({
            memberId: c.id,
            side,
            action: s.action,
            ref: s.ref,
            name,
            version,
            sourceIds: [id],
          });
        }
    const input: AdvisoryInput = {
      binding: inventory.binding,
      changes: inventory.changes,
      sources: [...inventory.sources, ...sources],
      findings: [],
      publicIdentities: [],
      actionVersions,
      limits: advisoryTestLimits,
    };
    const absent: PacketSource = {
      id: 'absent-actions-others',
      kind: 'file-list',
      ecosystems: ['npm', 'uv'],
      memberIds: [],
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'inventory',
        repository: inventory.binding.repository,
        baseSha: inventory.binding.baseSha,
        headSha: inventory.binding.headSha,
        absentEcosystems: ['npm', 'uv'],
      },
    };
    const expected = {
      binding: inventory.binding,
      baseSha: inventory.binding.baseSha,
      contextRevision: { repository: inventory.binding.repository, sha: 'c'.repeat(40) },
      context: { ok: true as const, status: 'disabled' as const, dependencies: [], reasons: [] },
    };
    return { fixture, inventory, input, absent, expected };
  } finally {
    opened.session.close();
  }
}

export async function collectMixedAdvisoryInventories(children = 1) {
  const manifest = { dependencies: { 'fixture-anchor': '^1' } };
  const npm = (version: string) => {
    const node = (name: string, v: string) => ({
      version: v,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${v}.tgz`,
    });
    return JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': manifest,
        'node_modules/fixture-anchor': {
          ...node('fixture-anchor', version === '1' ? '1.0.0' : '1.1.0'),
          dependencies: Object.fromEntries(
            Array.from({ length: children }, (_, i) => [`fixture-child-${i}`, '*']),
          ),
        },
        ...Object.fromEntries(
          Array.from({ length: children }, (_, i) => [
            `node_modules/fixture-child-${i}`,
            node(`fixture-child-${i}`, `${version}.0.0`),
          ]),
        ),
      },
    });
  };
  const workflow = (ref: string) =>
    `jobs:\n  review:\n    steps:\n      - uses: fixture/action@${ref}\n`;
  const files = (head: boolean) => ({
    'pyproject.toml': uvManifest,
    'uv.lock': uvLock(head ? '2' : '1'),
    'package.json': JSON.stringify(manifest),
    'package-lock.json': npm(head ? '2' : '1'),
    '.github/workflows/example.yml': workflow((head ? '2' : '1').repeat(40)),
  });
  const fixture = uvMetadataScenario('permission403', {
    files: { base: files(false), head: files(true) },
  });
  const opened = await createGithubReadSession(
    {
      binding: fixture.input.binding,
      limits: { ...fixture.readLimits, maxRequests: 200, maxJsonEntries: 500_000 },
    },
    { fetch: fixture.fetch, now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('D1');
  try {
    const rawNpm = await collectNpmInventory(
      {
        binding: fixture.input.binding,
        roots: ['.'],
        configRevision: fixture.input.configRevision,
        limits: { ...advisoryTestLimits, maxFileBytes: 500_000, maxRoots: 10 },
      },
      { session: opened.session },
    );
    const npm = proveNpmRelationships({
      binding: fixture.input.binding,
      inventory: rawNpm,
      limits: { maxGraphWork: 1_000_000, maxRetainedBytes: 2_000_000 },
    });
    const actions = await collectActionsInventory(
      {
        binding: fixture.input.binding,
        limits: {
          maxFileBytes: 100_000,
          maxWorkflows: 20,
          maxYamlNodes: 100_000,
          maxYamlDepth: 32,
          maxAliasExpansions: 100,
          maxOccurrences: 1000,
          maxRetainedBytes: 2_000_000,
        },
      },
      { session: opened.session },
    );
    const metadata = await collectUvMetadata(fixture.input, { session: opened.session });
    const uv = reconcileUvGraph({
      binding: fixture.input.binding,
      metadata,
      limits: { maxGraphWork: 1_000_000, maxRetainedBytes: 2_000_000 },
    });
    if (npm.kind !== 'inventory' || actions.kind !== 'inventory' || uv.kind !== 'inventory')
      throw new Error('actual collectors');
    const changes = [...npm.changes, ...actions.changes, ...uv.changes];
    const proofs = syntheticPublicProofs(changes);
    const sources = [...npm.sources, ...actions.sources, ...uv.sources, ...proofs.sources];
    const input: AdvisoryInput = {
      binding: fixture.input.binding,
      changes,
      sources,
      findings: [...npm.findings, ...uv.findings],
      publicIdentities: proofs.publicIdentities,
      limits: advisoryTestLimits,
    };
    const expected = {
      binding: fixture.input.binding,
      baseSha: fixture.input.binding.baseSha,
      contextRevision: fixture.input.configRevision,
      context: { ok: true as const, status: 'disabled' as const, dependencies: [], reasons: [] },
    };
    return {
      fixture,
      input,
      expected,
      coverage: { npm: npm.coverage, actions: actions.coverage, uv: uv.coverage },
      relationships: [...npm.relationships, ...uv.relationships],
    };
  } finally {
    opened.session.close();
  }
}
