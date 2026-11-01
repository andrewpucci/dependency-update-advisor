import { expect, test } from 'vite-plus/test';
import { createGithubReadSession } from '../github-read.js';
import { collectNpmInventory } from './npm.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits, summarizeDecisionCoverage } from '../units.js';
import { parseReviewConfig } from '../config.js';
import { npmScenario } from '../../tests/parity/npm-inventory.js';

async function collect(additions = 20, rangeChange = false, comparison = 'empty') {
  const fixture = npmScenario(additions, rangeChange, comparison);
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
