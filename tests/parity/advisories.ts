import type { PacketChange, PacketSource } from '../../src/schema.js';
import { createGithubReadSession, type JsonValue } from '../../src/github-read.js';
import { collectNpmInventory } from '../../src/evidence/npm.js';
import type { PublicPackageIdentity, AdvisoryInput } from '../../src/evidence/advisories.js';
import { npmScenario } from './npm-inventory.js';

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
export function syntheticPublicProofs(changes: readonly PacketChange[]) {
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
