import { expect, test } from 'vite-plus/test';
import { createGithubReadSession } from '../github-read.js';
import { collectNpmInventory } from './npm.js';
import { proveNpmRelationships, enrichNpmEvidence } from './npm-graph.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits, summarizeDecisionCoverage } from '../units.js';
import { parseReviewConfig } from '../config.js';
import { npmScenario } from '../../tests/parity/npm-inventory.js';

async function collect(
  additions = 20,
  rangeChange = false,
  comparison = 'empty',
  lifecycle: boolean | 'no-scripts' = false,
) {
  const fixture = npmScenario(additions, rangeChange, comparison, lifecycle);
  const ready = await createGithubReadSession(
    {
      binding: fixture.binding,
      limits: {
        maxRequests: 100,
        maxPages: 10,
        maxFiles: 1000,
        maxJsonEntries: 200_000,
        maxResponseBytes: 1_000_000,
        maxFileBytes: 500_000,
        maxTotalBytes: 10_000_000,
        maxRetainedBytes: 2_000_000,
        requestTimeoutMs: 1000,
        totalTimeoutMs: 30_000,
      },
    },
    { fetch: fixture.fetch, now: () => 0 },
  );
  expect(ready.kind).toBe('ready');
  if (ready.kind !== 'ready') throw new Error('expected D1 session');
  try {
    const result = await collectNpmInventory(
      {
        binding: ready.binding,
        roots: ['.'],
        configRevision: fixture.expected.contextRevision,
        limits: {
          maxFileBytes: 500_000,
          maxJsonDepth: 32,
          maxJsonEntries: 100_000,
          maxRoots: 10,
          maxRetainedBytes: 2_000_000,
        },
      },
      { session: ready.session },
    );
    expect(result.kind).toBe('inventory');
    if (result.kind !== 'inventory') throw new Error('expected N1 inventory');
    const candidate = {
      version: 1,
      ...fixture.expected,
      changes: result.changes,
      sources: [...result.sources, fixture.absent],
      findings: [],
      relationships: [],
      coverage: {
        npm: result.coverage,
        actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
      },
    };
    return {
      result,
      packet: validateReviewPacket(candidate, fixture.expected),
      fixture,
      candidate,
    };
  } finally {
    ready.session.close();
  }
}

test.each(['empty', 'omission', 'permission', 'rate_limit', 'unknown'])(
  'preserves twenty unpaired additions through real D1/T4/T5 with %s comparison',
  async (mode) => {
    const { result, packet, fixture } = await collect(20, false, mode);
    expect(packet.ok, JSON.stringify(packet)).toBe(true);
    if (!packet.ok) throw new Error('expected packet');
    const additions = packet.packet.changes.filter((c) => c.kind === 'addition');
    expect(additions).toHaveLength(20);
    expect(new Set(additions.map((c) => c.id)).size).toBe(20);
    expect(additions.every((c) => c.from === null && c.to && 'lockPath' in c.to)).toBe(true);
    expect(result.coverage.status).toBe('complete');
    expect(packet.packet.changes.filter((c) => c.kind === 'update')).toHaveLength(1);
    const units = formDecisionUnits(packet.packet);
    expect(units.units.flatMap((u) => u.memberIds).sort()).toEqual(
      packet.packet.changes.map((c) => c.id).sort(),
    );
    expect(fixture.requests.every((u) => u.startsWith('https://api.github.com/'))).toBe(true);
    expect(fixture.requests.at(-1)).toContain('/dependency-graph/compare/');
  },
);

test('a declaration-only packet has complete inventory without invented research gaps or a completed assessment', async () => {
  const { result, packet } = await collect(0, true);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({ basis: 'declaration', evidence: {} });
  expect(packet.ok).toBe(true);
  if (!packet.ok) throw new Error('expected packet');
  const coverage = summarizeDecisionCoverage(
    formDecisionUnits(packet.packet),
    parseReviewConfig('{"version":1}'),
    0,
  );
  expect(coverage.ok).toBe(true);
  if (!coverage.ok) throw new Error('expected coverage');
  expect(coverage.outcome).toEqual({ kind: 'decision_incomplete' });
  expect(coverage.policyProvenance.assessments.units[0].gaps).toEqual([]);
});

test.each([
  [126, true],
  [127, false],
] as const)(
  'accepts a combined 128-record inventory (%s additions, declarations %s)',
  async (count, range) => {
    const f = await collect(count, range);
    expect(f.result.changes).toHaveLength(128);
    expect(f.packet.ok, JSON.stringify(f.packet)).toBe(true);
  },
);
test('129 records retain the full collector inventory and reject without a usable packet', async () => {
  const f = await collect(127, true);
  expect(f.result.changes).toHaveLength(129);
  expect(f.packet).toEqual({ ok: false, error: { category: 'budget', field: 'changes' } });
  expect(f.packet).not.toHaveProperty('packet');
});

test('mixed packets keep an independent Actions inventory gap visible', async () => {
  const f = await collect(1, true);
  const candidate = {
    ...f.candidate,
    sources: [
      ...f.candidate.sources,
      {
        id: 'actions-gap',
        kind: 'file-list',
        ecosystems: ['actions'],
        memberIds: [],
        status: 'unavailable',
        reasons: ['permission'],
        provenance: {
          kind: 'inventory',
          repository: f.fixture.binding.repository,
          baseSha: f.fixture.binding.baseSha,
          headSha: f.fixture.binding.headSha,
          absentEcosystems: [],
        },
      },
    ],
    coverage: {
      ...f.candidate.coverage,
      actions: { status: 'unavailable', reasons: ['permission'], sourceIds: ['actions-gap'] },
    },
  };
  const packet = validateReviewPacket(candidate, f.fixture.expected);
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (!packet.ok) throw new Error('expected mixed packet');
  const summary = summarizeDecisionCoverage(
    formDecisionUnits(packet.packet),
    parseReviewConfig('{"version":1}'),
    0,
  );
  expect(summary).toMatchObject({
    ok: true,
    inventoryGaps: [{ ecosystem: 'actions', reasons: ['permission'] }],
    outcome: { kind: 'decision_incomplete' },
  });
});

test('real N1 graph proofs validate through T4 and group exact changed members in T5', async () => {
  const f = await collect(2);
  const graph = proveNpmRelationships({
    inventory: f.result,
    binding: f.fixture.binding,
    limits: { maxGraphWork: 100_000, maxRetainedBytes: 2_000_000 },
  });
  expect(graph.kind).toBe('inventory');
  if (graph.kind !== 'inventory') throw new Error('expected graph');
  expect(graph.relationships).toHaveLength(2);
  const packet = validateReviewPacket(
    { ...f.candidate, relationships: graph.relationships, findings: graph.findings },
    f.fixture.expected,
  );
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (!packet.ok) throw new Error('expected packet');
  const units = formDecisionUnits(packet.packet);
  expect(units.units).toHaveLength(1);
  expect(units.units[0]).toMatchObject({ kind: 'direct_group', memberCount: 3 });
  expect(units.units[0].memberIds.slice().sort()).toEqual(f.result.changes.map((c) => c.id).sort());
  expect(graph.changes.every((c) => c.evidence.installScript.status === 'unavailable')).toBe(true);
});

const n2Limits = {
  maxGraphWork: 500_000,
  maxRetainedBytes: 2_000_000,
  maxRequests: 300,
  maxResponseBytes: 50_000,
  maxTotalBytes: 5_000_000,
  maxJsonEntries: 100_000,
  maxJsonDepth: 32,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
async function enrich(
  f: Awaited<ReturnType<typeof collect>>,
  failChildren = false,
  noCommands = false,
) {
  const calls: string[] = [];
  const result = await enrichNpmEvidence(
    { inventory: f.result, binding: f.fixture.binding, limits: n2Limits },
    {
      now: () => 0,
      fetch: async (url) => {
        calls.push(url);
        const [name, version] = new URL(url).pathname.slice(1).split('/').map(decodeURIComponent);
        if (failChildren && name.startsWith('synthetic-child'))
          return new Response(null, { status: 403 });
        return new Response(
          JSON.stringify({
            _id: name + '@' + version,
            name,
            version,
            dist: { integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64') },
            scripts: noCommands
              ? {}
              : { install: version === '1.0.0' ? 'node old.js' : 'node new.js' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected N2 output');
  const candidate = {
    ...f.candidate,
    changes: result.changes,
    sources: [...result.sources, f.fixture.absent],
    relationships: result.relationships,
    findings: result.findings,
  };
  return { result, candidate, calls, packet: validateReviewPacket(candidate, f.fixture.expected) };
}

test('a grouped transitive install-script finding reaches T4, T5 and C3 with its own exact evidence', async () => {
  const f = await collect(2, false, 'empty', true);
  const n2 = await enrich(f);
  expect(n2.packet.ok, JSON.stringify(n2.packet)).toBe(true);
  if (!n2.packet.ok) throw new Error('expected packet');
  const inventory = formDecisionUnits(n2.packet.packet);
  expect(inventory.units).toHaveLength(1);
  expect(inventory.units[0].memberCount).toBe(3);
  const child = n2.result.changes.find((c) => c.role === 'transitive')!;
  expect(inventory.units[0].findings).toContainEqual(
    expect.objectContaining({
      kind: 'supplyChainChange',
      memberId: child.id,
      change: 'install_script',
    }),
  );
  const summary = summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0);
  expect(summary.ok).toBe(true);
  if (!summary.ok) throw new Error('expected summary');
  const finding = inventory.units[0].findings.find(
    (f) => f.kind === 'supplyChainChange' && f.memberId === child.id,
  )!;
  expect(summary.policyProvenance.assessments.units[0].rules).toContainEqual(
    expect.objectContaining({ findingId: finding.id, rule: 'supplyChainChange' }),
  );
});

test('a grouped member keeps its own failed lifecycle evidence despite successful anchor metadata', async () => {
  const f = await collect(2, false, 'permission', true);
  const n2 = await enrich(f, true);
  expect(n2.packet.ok, JSON.stringify(n2.packet)).toBe(true);
  if (!n2.packet.ok) throw new Error('expected packet');
  const inventory = formDecisionUnits(n2.packet.packet),
    unit = inventory.units[0];
  expect(unit.kind).toBe('direct_group');
  const child = n2.result.changes.find((c) => c.role === 'transitive')!;
  const link = unit.evidenceLinks.find(
    (l) => l.memberId === child.id && l.category === 'installScript',
  )!;
  expect(link).toMatchObject({ status: 'unavailable', reasons: ['permission'] });
  const anchor = n2.result.changes.find((c) => c.role === 'direct')!;
  expect(anchor.evidence.installScript.status).toBe('available');
  expect(unit.findings.some((f) => f.kind === 'supplyChainChange' && f.memberId === child.id)).toBe(
    false,
  );
  const summary = summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0);
  expect(summary.ok).toBe(true);
  if (!summary.ok) throw new Error('expected summary');
  expect(summary.policyProvenance.assessments.units[0].gaps).toContainEqual(
    expect.objectContaining({ sourceId: link.id, reason: 'permission' }),
  );
  expect(n2.result.comparison).toEqual(f.result.comparison);
});

test('ordinary omitted lock flags and no-command metadata validate without lifecycle research gaps', async () => {
  const f = await collect(1, false, 'empty', 'no-scripts');
  const n2 = await enrich(f, false, true);
  expect(n2.packet.ok, JSON.stringify(n2.packet)).toBe(true);
  if (!n2.packet.ok) throw new Error('expected packet');
  const inventory = formDecisionUnits(n2.packet.packet);
  expect(
    inventory.units[0].evidenceLinks
      .filter((l) => l.category === 'installScript')
      .every((l) => l.status === 'available'),
  ).toBe(true);
  expect(inventory.units[0].findings.every((f) => f.kind !== 'supplyChainChange')).toBe(true);
  expect(
    inventory.units[0].findings.some(
      (f) => f.kind === 'informational' && f.detail.includes('implicit'),
    ),
  ).toBe(true);
});

test.each(['empty', 'permission', 'rate_limit', 'unknown'])(
  'twenty additions survive real N1/N2/T4/T5 with %s comparison',
  async (comparison) => {
    const f = await collect(20, false, comparison, true);
    const n2 = await enrich(f);
    expect(n2.packet.ok, JSON.stringify(n2.packet)).toBe(true);
    if (!n2.packet.ok) throw new Error('expected packet');
    const inventory = formDecisionUnits(n2.packet.packet);
    expect(inventory.units).toHaveLength(1);
    expect(inventory.units[0].memberCount).toBe(21);
    expect(n2.result.changes.filter((c) => c.kind === 'addition' && c.from === null)).toHaveLength(
      20,
    );
    expect(inventory.units.flatMap((u) => u.memberIds).sort()).toEqual(
      f.result.changes.map((c) => c.id).sort(),
    );
    expect(n2.result.coverage).toEqual(f.result.coverage);
    expect(n2.result.comparison).toEqual(f.result.comparison);
  },
);

test('declarations beside a proven resolved group remain standalone with empty evidence', async () => {
  const f = await collect(2, true, 'empty', true);
  const n2 = await enrich(f);
  expect(n2.packet.ok, JSON.stringify(n2.packet)).toBe(true);
  if (!n2.packet.ok) throw new Error('expected packet');
  const inventory = formDecisionUnits(n2.packet.packet);
  expect(inventory.units).toHaveLength(2);
  const declaration = n2.result.changes.find((c) => 'basis' in c)!;
  expect(declaration.evidence).toEqual({});
  expect(inventory.units.find((u) => u.memberIds.includes(declaration.id))).toMatchObject({
    kind: 'standalone',
    memberCount: 1,
  });
  expect(n2.calls.some((url) => url.includes('%5E'))).toBe(false);
});

test('actual split N1 source records produce accepted proofs or explicit standalone limits', async () => {
  const f = await collect(40, false, 'empty', true);
  const n2 = await enrich(f);
  expect(n2.packet.ok, JSON.stringify(n2.packet)).toBe(true);
  if (!n2.packet.ok) throw new Error('expected packet');
  const inventory = formDecisionUnits(n2.packet.packet);
  expect(inventory.units.flatMap((u) => u.memberIds).sort()).toEqual(
    f.result.changes.map((c) => c.id).sort(),
  );
  expect(
    n2.result.findings.some(
      (f) => f.kind === 'informational' && f.detail.includes('lock-source membership'),
    ),
  ).toBe(true);
  expect(n2.result.changes.map((c) => [c.id, c.from?.sourceId, c.to?.sourceId])).toEqual(
    f.result.changes.map((c) => [c.id, c.from?.sourceId, c.to?.sourceId]),
  );
});

test('a complete npm lifecycle lookup never masks an independent Actions gap', async () => {
  const f = await collect(1, false, 'empty', true);
  const n2 = await enrich(f);
  const candidate = {
    ...n2.candidate,
    sources: [
      ...n2.candidate.sources,
      {
        id: 'actions-gap',
        kind: 'file-list',
        ecosystems: ['actions'],
        memberIds: [],
        status: 'unavailable',
        reasons: ['permission'],
        provenance: {
          kind: 'inventory',
          repository: f.fixture.binding.repository,
          baseSha: f.fixture.binding.baseSha,
          headSha: f.fixture.binding.headSha,
          absentEcosystems: [],
        },
      },
    ],
    coverage: {
      ...n2.candidate.coverage,
      actions: { status: 'unavailable', reasons: ['permission'], sourceIds: ['actions-gap'] },
    },
  };
  const packet = validateReviewPacket(candidate, f.fixture.expected);
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (!packet.ok) throw new Error('expected packet');
  const summary = summarizeDecisionCoverage(
    formDecisionUnits(packet.packet),
    parseReviewConfig('{"version":1}'),
    0,
  );
  expect(summary).toMatchObject({
    ok: true,
    inventoryGaps: [{ ecosystem: 'actions', reasons: ['permission'] }],
    outcome: { kind: 'decision_incomplete' },
  });
});

test('the real T4 boundary rejects a wrong-side lifecycle subject rather than treating N2 output as prevalidated', async () => {
  const f = await collect(1, false, 'empty', true);
  const n2 = await enrich(f);
  const sources = structuredClone([...n2.result.sources]);
  const candidate = { ...n2.candidate, sources: [...sources, f.fixture.absent] };
  const source = sources.find((s) => s.kind === 'install-script')!;
  if (source.provenance.kind !== 'upstream') throw new Error('expected upstream source');
  source.provenance.subjects[0].value = '9.9.9';
  const packet = validateReviewPacket(candidate, f.fixture.expected);
  expect(packet.ok).toBe(false);
  expect(packet).not.toHaveProperty('packet');
});
