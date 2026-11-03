import { expect, test } from 'vite-plus/test';
import { createAdvisoryReader } from './advisory-read.js';
import { enrichAdvisories } from './advisories.js';
import { createGithubReadSession } from '../github-read.js';
import { collectNpmInventory } from './npm.js';
import { validateReviewPacket, type PacketSource } from '../schema.js';
import { npmScenario } from '../../tests/parity/npm-inventory.js';

export const advisoryLimits = {
  maxRequests: 20,
  maxPages: 20,
  maxResponseBytes: 50_000,
  maxTotalBytes: 500_000,
  maxJsonEntries: 20_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 500_000,
  maxFindings: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const advisory = {
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
async function fixture() {
  const f = npmScenario(1);
  const opened = await createGithubReadSession(
    {
      binding: f.binding,
      limits: {
        ...advisoryLimits,
        maxFiles: 100,
        maxFileBytes: 50_000,
      },
    },
    { fetch: f.fetch, now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('expected session');
  try {
    const inventory = await collectNpmInventory(
      {
        binding: f.binding,
        roots: ['.'],
        configRevision: f.expected.contextRevision,
        limits: {
          maxFileBytes: 50_000,
          maxJsonEntries: 20_000,
          maxJsonDepth: 32,
          maxRoots: 10,
          maxRetainedBytes: 500_000,
        },
      },
      { session: opened.session },
    );
    if (inventory.kind !== 'inventory') throw new Error('expected inventory');
    const proofs: PacketSource[] = [];
    const publicIdentities = inventory.changes.flatMap((c) => {
      if (c.ecosystem !== 'npm' || 'basis' in c || !c.to) return [];
      const s = c.to,
        id = 'public:' + c.id;
      proofs.push({
        id,
        kind: 'metadata',
        ecosystems: ['npm'],
        memberIds: [c.id],
        status: 'available',
        reasons: [],
        provenance: {
          kind: 'upstream',
          url: `https://registry.npmjs.org/${s.name}/${s.version}`,
          title: 'Synthetic public identity proof',
          excerpt: 'Synthetic exact public metadata.',
          excerptTruncated: false,
          subjects: [{ memberId: c.id, side: 'head', value: s.version }],
          range: { from: null, to: s.version },
        },
      });
      return [
        {
          memberId: c.id,
          side: 'head' as const,
          ecosystem: 'npm' as const,
          name: s.name,
          version: s.version,
          sourceIdentity: s.source.identity,
          sourceIds: [id],
        },
      ];
    });
    const input = {
      binding: f.binding,
      changes: inventory.changes,
      sources: [...inventory.sources, ...proofs],
      findings: [],
      publicIdentities,
      limits: advisoryLimits,
    };
    return { f, inventory, input };
  } finally {
    opened.session.close();
  }
}
test.each([true, false])(
  'exact npm %s evidence passes actual T4 without changing inventory',
  async (positive) => {
    const { f, inventory, input } = await fixture();
    const requests: { url: string; init: RequestInit }[] = [];
    const reader = createAdvisoryReader(advisoryLimits, {
      now: () => 0,
      fetch: async (url, init) => {
        requests.push({ url, init });
        const name = new URL(url).searchParams.get('affects');
        return Response.json(positive && name === 'fixture-anchor@1.1.0' ? [advisory] : []);
      },
    });
    if (reader.kind !== 'ready') throw new Error('expected reader');
    const output = await enrichAdvisories(input, { reader });
    reader.close();
    expect(output.kind).toBe('enriched');
    if (output.kind !== 'enriched') throw new Error('expected evidence');
    expect(output.findings).toHaveLength(positive ? 1 : 0);
    expect(output.changes.every((c) => c.evidence.vulnerability.status === 'available')).toBe(true);
    expect(inventory.changes.every((c) => c.evidence.vulnerability.status === 'unavailable')).toBe(
      true,
    );
    const { kind: _kind, lookups: _lookups, ...fields } = output;
    const accepted = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        ...fields,
        relationships: [],
        sources: [...output.sources, f.absent],
        coverage: {
          npm: inventory.coverage,
          actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        },
      },
      f.expected,
    );
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(Object.isFrozen(output.changes)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(new URL(requests[0].url).origin).toBe('https://api.github.com');
  },
);

test('missing public identity stays unknown without disclosing a guessed package', async () => {
  const { input } = await fixture();
  let calls = 0;
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('expected reader');
  const result = await enrichAdvisories({ ...input, publicIdentities: [] }, { reader });
  reader.close();
  expect(result.kind).toBe('enriched');
  if (result.kind === 'enriched')
    expect(result.changes[0].evidence.vulnerability).toMatchObject({
      status: 'unavailable',
      reasons: ['unsupported'],
    });
  expect(calls).toBe(0);
});
