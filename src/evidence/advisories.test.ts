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
async function fixture(both = false) {
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
    const publicIdentities = inventory.changes.flatMap((c) =>
      (['head', ...(both ? ['base' as const] : [])] as const).flatMap((side) => {
        if (c.ecosystem !== 'npm' || 'basis' in c) return [];
        const s = side === 'head' ? c.to : c.from;
        if (!s) return [];
        const id = 'public:' + c.id + ':' + side;
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
            subjects: [{ memberId: c.id, side, value: s.version }],
            range: {
              from: side === 'base' ? s.version : null,
              to: side === 'head' ? s.version : null,
            },
          },
        });
        return [
          {
            memberId: c.id,
            side,
            ecosystem: 'npm' as const,
            name: s.name,
            version: s.version,
            sourceIdentity: s.source.identity,
            sourceIds: [id],
          },
        ];
      }),
    );
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
    // The review renderer refuses a blocking finding that names no remediation or validation step.
    for (const finding of output.findings) {
      expect(finding.remediation.length).toBeGreaterThan(0);
      expect(finding.validation.length).toBeGreaterThan(0);
      expect(finding.remediation.join(' ')).toContain('fixture-anchor');
    }
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

test.each([
  ['empty', 'hit', 'affects_proposed', true],
  ['hit', 'hit', 'affects_proposed', false],
  ['fail', 'hit', 'affects_proposed', false],
  ['hit', 'empty', 'resolved_by_proposed', false],
  ['hit', 'fail', null, false],
  ['empty', 'empty', null, false],
] as const)(
  'base %s / head %s retains only proved conclusions',
  async (base, head, applicability, introduced) => {
    const { input, f, inventory } = await fixture(true);
    const reader = createAdvisoryReader(advisoryLimits, {
      now: () => 0,
      fetch: async (url) => {
        const query = new URL(url).searchParams.get('affects')!;
        if (!query.startsWith('fixture-anchor@')) return Response.json([]);
        const mode = query.endsWith('@1.0.0') ? base : head;
        return mode === 'fail'
          ? Response.json({}, { status: 500 })
          : Response.json(mode === 'hit' ? [advisory] : []);
      },
    });

    if (reader.kind !== 'ready') throw new Error('reader');
    const output = await enrichAdvisories(input, { reader });
    reader.close();
    if (output.kind !== 'enriched') throw new Error('evidence');
    expect(output.findings).toHaveLength(applicability ? 1 : 0);
    if (applicability) {
      expect(output.findings[0]).toMatchObject({ applicability });
      expect(output.findings[0].rationale.includes('introduces')).toBe(introduced);
    }
    expect(output.changes[0].evidence.vulnerability.status).toBe(
      head === 'fail' ? 'unavailable' : 'available',
    );
    const accepted = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes: output.changes,
        sources: [...output.sources, f.absent],
        findings: output.findings,
        relationships: [],
        coverage: {
          npm: inventory.coverage,
          actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        },
      },
      f.expected,
    );
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  },
);

test('bounded comparison positives survive a failed global lookup with an explicit gap', async () => {
  const { input, f } = await fixture();
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => Response.json({}, { status: 500 }),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const comparisons = [
    {
      kind: 'available' as const,
      repository: f.binding.repository,
      headRepository: f.binding.headRepository,
      baseSha: f.binding.baseSha,
      headSha: f.binding.headSha,
      mergeBaseSha: f.binding.mergeBaseSha,
      reasons: [],
      records: [
        {
          manifest: 'package-lock.json',
          ecosystem: 'npm',
          name: 'fixture-anchor',
          version: '1.1.0',
          change_type: 'added',
          vulnerabilities: [
            {
              severity: 'high',
              advisory_ghsa_id: advisory.ghsa_id,
              advisory_url: advisory.html_url,
              advisory_summary: advisory.summary,
            },
          ],
        },
      ],
    },
  ];
  const output = await enrichAdvisories({ ...input, comparisons }, { reader });
  reader.close();
  if (output.kind !== 'enriched') throw new Error('evidence');
  expect(output.findings).toHaveLength(1);
  expect(output.findings[0]).toMatchObject({ applicability: 'affects_proposed', severity: 'high' });
  expect(output.changes[0].evidence.vulnerability.status).toBe('partial');
});

test.each([false, true])(
  'duplicate GHSA records are reconciled; conflict=%s retains independent findings',
  async (conflict) => {
    const { input, f, inventory } = await fixture();
    const independent = {
      ...advisory,
      ghsa_id: 'GHSA-dddd-eeee-ffff',
      html_url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
    };
    const reader = createAdvisoryReader(advisoryLimits, {
      now: () => 0,
      fetch: async (url) =>
        Response.json(
          new URL(url).searchParams.get('affects') === 'fixture-anchor@1.1.0'
            ? [advisory, { ...advisory, severity: conflict ? 'low' : 'high' }, independent]
            : [],
        ),
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const output = await enrichAdvisories(input, { reader });
    reader.close();
    if (output.kind !== 'enriched') throw new Error('enrichment');
    expect(output.findings).toHaveLength(conflict ? 1 : 2);
    expect(output.changes[0].evidence.vulnerability.status).toBe(
      conflict ? 'partial' : 'available',
    );
    const accepted = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes: output.changes,
        sources: [...output.sources, f.absent],
        findings: output.findings,
        relationships: [],
        coverage: {
          npm: inventory.coverage,
          actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        },
      },
      f.expected,
    );
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  },
);

test('retention limits preserve original findings and mark omitted new evidence as budget gaps', async () => {
  const { input } = await fixture();
  const old = {
    id: 'retained-original',
    memberId: input.changes[0].id,
    kind: 'informational' as const,
    detail: 'Original fact',
    references: [input.changes[0].to!.sourceId],
    rationale: 'Original fact',
    remediation: [],
    validation: [],
  };
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () =>
      Response.json([
        advisory,
        {
          ...advisory,
          ghsa_id: 'GHSA-dddd-eeee-ffff',
          html_url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
        },
      ]),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const output = await enrichAdvisories(
    { ...input, findings: [old], limits: { ...advisoryLimits, maxFindings: 1 } },
    { reader },
  );
  reader.close();
  expect(output.kind).toBe('enriched');
  if (output.kind !== 'enriched') throw new Error('enrichment');
  expect(output.findings).toContainEqual(old);
  expect(output.changes[0].evidence.vulnerability.reasons).toContain('budget');
});

test('input getters and conflicting eligibility proofs cannot run or disclose package names', async () => {
  const { input } = await fixture();
  let executed = 0,
    calls = 0;
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const hostile = Object.defineProperty({ ...input }, 'limits', {
    get() {
      executed++;
      return advisoryLimits;
    },
  });
  expect(await enrichAdvisories(hostile, { reader })).toEqual({ kind: 'invalid' });
  expect(executed).toBe(0);
  expect(
    await enrichAdvisories(
      {
        ...input,
        publicIdentities: [
          ...input.publicIdentities,
          { ...input.publicIdentities[0], name: 'private-name' },
        ],
      },
      { reader },
    ),
  ).toEqual({ kind: 'invalid' });
  reader.close();
  expect(calls).toBe(0);
});

test('duplicate semantic instances and dangling references fail before I/O', async () => {
  const { input } = await fixture();
  let calls = 0;
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const duplicate = { ...input.changes[0], id: 'duplicate-instance' };
  const sources = input.sources.map((s) =>
    s.kind === 'file' && s.memberIds.includes(input.changes[0].id)
      ? { ...s, memberIds: [...s.memberIds, duplicate.id] }
      : s,
  );
  expect(
    await enrichAdvisories(
      { ...input, changes: [...input.changes, duplicate], sources },
      { reader },
    ),
  ).toEqual({ kind: 'invalid' });
  expect(
    await enrichAdvisories(
      {
        ...input,
        publicIdentities: [{ ...input.publicIdentities[0], sourceIds: ['missing-proof'] }],
      },
      { reader },
    ),
  ).toEqual({ kind: 'invalid' });
  expect(calls).toBe(0);
  reader.close();
});
