import { expect, test } from 'vite-plus/test';
import { createGithubReadSession } from '../github-read.js';
import { collectUvMetadata } from './uv.js';
import { reconcileUvGraph } from './uv-graph.js';
import { collectNpmInventory } from './npm.js';
import { collectActionsInventory } from './actions.js';
import {
  validateReviewPacket,
  type ReviewPacket,
  type PacketSource,
  type SourceSubject,
} from '../schema.js';
import { formDecisionUnits, summarizeDecisionCoverage } from '../units.js';
import { parseReviewConfig } from '../config.js';
import { uvLock, uvManifest, uvPackage, uvPacket } from '../../tests/parity/uv-graph.js';
import { uvMetadataScenario, type UvComparisonMode } from '../../tests/parity/uv-metadata.js';
async function collect(
  mode: UvComparisonMode,
  options: Parameters<typeof uvMetadataScenario>[1] = {},
) {
  const fixture = uvMetadataScenario(mode, options);
  const opened = await createGithubReadSession(
    { binding: fixture.input.binding, limits: fixture.readLimits },
    { fetch: fixture.fetch, now: () => performance.now() },
  );
  expect(opened.kind).toBe('ready');
  if (opened.kind !== 'ready') throw new Error('expected real D1 session');
  try {
    const result = await collectUvMetadata(fixture.input, { session: opened.session });
    expect(result.kind).toBe('metadata');
    if (result.kind !== 'metadata') throw new Error('expected U1 metadata');
    return { result, requests: fixture.requests };
  } finally {
    opened.session.close();
  }
}
test.each([
  'empty',
  'omission',
  'permission403',
  'unknown403',
  'rate403',
  'rate429',
  'partial',
] as const)('real D1/U1 preserves invented file evidence through %s comparison', async (mode) => {
  const baseline = (await collect('empty')).result,
    { result, requests } = await collect(mode);
  expect(result.roots).toEqual(baseline.roots);
  expect(result.sources).toEqual(baseline.sources);
  expect(result.gaps).toEqual([]);
  expect(result.roots[0].base.lock.data?.revision).toBe(3);
  expect(result.roots[0].head.lock.data?.revision).toBe(5);
  const manifest = result.roots[0].head.manifest.data!,
    lock = result.roots[0].head.lock.data!;
  expect(manifest.optionalDependencies.map((x) => x.extra)).toEqual([
    'cli',
    'docs',
    'empty',
    'web',
  ]);
  expect(manifest.dependencies.map((x) => [x.name, x.position])).toEqual([
    ['orbit-core', 0],
    ['orbit-core', 1],
  ]);
  expect(lock.packages.filter((p) => p.name === 'orbit-core').map((p) => p.version)).toEqual([
    '1.0',
    '2.0',
  ]);
  expect(lock.packages.find((p) => !p.external)?.dependencies?.[0]).toMatchObject({
    version: '1.0',
    marker: "python_version < '3.13'",
  });
  expect(
    lock.packages.find((p) => !p.external)?.optionalDependencies?.find((x) => x.extra === 'empty')
      ?.declarations,
  ).toEqual([]);
  expect(
    result.roots[0].base.lock.data?.packages
      .find((p) => !p.external)
      ?.optionalDependencies?.some((x) => x.extra === 'empty'),
  ).toBe(false);
  const status = {
    empty: 'available',
    omission: 'available',
    permission403: 'unavailable',
    unknown403: 'unavailable',
    rate403: 'unavailable',
    rate429: 'unavailable',
    partial: 'partial',
  }[mode];
  const reasons = {
    empty: [],
    omission: [],
    permission403: ['permission'],
    unknown403: ['unknown'],
    rate403: ['rate_limit'],
    rate429: ['rate_limit'],
    partial: ['malformed'],
  }[mode];
  expect(result.comparison).toEqual({ status, reasons });
  expect(JSON.stringify(result)).not.toContain('vulnerabilities');
  expect(requests.some((url) => url.includes('/dependency-graph/compare/'))).toBe(true);
  expect(
    requests.every((url) => url.startsWith('https://api.github.com/repos/example/consumer/')),
  ).toBe(true);
});
test.each(['missing', 'malformed', 'unsupported'] as const)(
  'real D1/U1 retains supported base and head manifest with %s head companion',
  async (headLock) => {
    const { result } = await collect('permission403', { headLock });
    expect(result.roots[0].base.state).toBe('present');
    expect(result.roots[0].head.manifest.state).toBe('present');
    expect(result.roots[0].head.state).toBe('partial');
    expect(result.gaps).toContainEqual({
      root: '.',
      side: 'head',
      path: 'uv.lock',
      entry: null,
      reason: headLock === 'missing' ? 'missing' : headLock,
    });
    expect(result.comparison).toEqual({ status: 'unavailable', reasons: ['permission'] });
  },
);
test('actual discovery permission failure preserves trusted-root snapshots and independent comparison limits', async () => {
  const { result } = await collect('unknown403', { discoveryFailure: true });
  expect(result.discovery).toMatchObject({
    status: 'unavailable',
    complete: false,
    applicable: true,
    reasons: ['permission'],
  });
  expect(result.roots[0].head.state).toBe('present');
  expect(result.gaps).toContainEqual({
    root: null,
    side: null,
    path: null,
    entry: null,
    reason: 'permission',
  });
  expect(result.comparison).toEqual({ status: 'unavailable', reasons: ['unknown'] });
});

type HandoffOptions = {
  count?: number;
  unchanged?: boolean;
  headLock?: 'missing' | 'malformed' | 'unsupported';
  text?: string;
};
async function handoff(mode: UvComparisonMode = 'permission403', options: HandoffOptions = {}) {
  const count = options.count ?? 2;
  const dependencies = Array.from({ length: count - 1 }, (_, i) => `{name="leaf-${i}"}`).join(',');
  const locked = (v: string) =>
    uvLock(v, `dependencies=[${dependencies}]\n`) +
    Array.from({ length: count - 1 }, (_, i) => uvPackage(`leaf-${i}`, v)).join('');
  const manifest = { dependencies: { 'npm-leaf': '^1.0.0' } };
  const npm = (version: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': manifest,
        'node_modules/npm-leaf': {
          version,
          resolved: `https://registry.npmjs.org/npm-leaf/-/npm-leaf-${version}.tgz`,
        },
      },
    });
  const workflow = (ref: string) =>
    `jobs:\n  build:\n    steps:\n      - uses: example/action@${ref}\n`;
  const f = uvMetadataScenario(mode, {
    headLock: options.headLock,
    files: {
      base: {
        'pyproject.toml': uvManifest,
        'uv.lock': locked('1'),
        'package.json': JSON.stringify(manifest),
        'package-lock.json': npm('1.0.0'),
        '.github/workflows/example.yml': workflow('1'.repeat(40)),
      },
      head: {
        'pyproject.toml': uvManifest,
        'uv.lock': locked(options.unchanged ? '1' : '2').replace('revision=3', 'revision=5'),
        'package.json': JSON.stringify(manifest),
        'package-lock.json': npm('1.0.1'),
        '.github/workflows/example.yml': workflow('2'.repeat(40)),
      },
    },
  });
  const opened = await createGithubReadSession(
    {
      binding: f.input.binding,
      limits: { ...f.readLimits, maxRequests: 200, maxJsonEntries: 100000 },
    },
    { fetch: f.fetch, now: () => 0 },
  );
  expect(opened.kind).toBe('ready');
  if (opened.kind !== 'ready') throw new Error('real D1');
  try {
    const metadata = await collectUvMetadata(f.input, { session: opened.session });
    const uv = reconcileUvGraph({
      binding: f.input.binding,
      metadata,
      limits: { maxGraphWork: 10_000_000, maxRetainedBytes: 2_000_000 },
      ...(options.text
        ? {
            corroboration: {
              status: 'available',
              repository: f.input.binding.repository,
              pullNumber: 42,
              headSha: f.input.binding.headSha,
              text: options.text,
            },
          }
        : {}),
    });
    const npmResult = await collectNpmInventory(
      {
        binding: f.input.binding,
        roots: ['.'],
        configRevision: f.input.configRevision,
        limits: {
          maxFileBytes: 100000,
          maxJsonEntries: 100000,
          maxJsonDepth: 32,
          maxRoots: 20,
          maxRetainedBytes: 2_000_000,
        },
      },
      { session: opened.session },
    );
    const actions = await collectActionsInventory(
      {
        binding: f.input.binding,
        limits: {
          maxFileBytes: 100000,
          maxWorkflows: 20,
          maxYamlNodes: 100000,
          maxYamlDepth: 32,
          maxAliasExpansions: 100,
          maxOccurrences: 1000,
          maxRetainedBytes: 2_000_000,
        },
      },
      { session: opened.session },
    );
    expect(uv.kind).toBe('inventory');
    expect(npmResult.kind).toBe('inventory');
    expect(actions.kind).toBe('inventory');
    if (uv.kind !== 'inventory' || npmResult.kind !== 'inventory' || actions.kind !== 'inventory')
      throw new Error('invented collector handoff');
    const context = { ok: true, status: 'disabled', dependencies: [], reasons: [] };
    const expected = {
      binding: f.input.binding,
      baseSha: f.input.binding.baseSha,
      contextRevision: f.input.configRevision,
      context,
    };
    const candidate = {
      version: 1,
      ...expected,
      coverage: { uv: uv.coverage, npm: npmResult.coverage, actions: actions.coverage },
      changes: [...uv.changes, ...npmResult.changes, ...actions.changes],
      sources: [...uv.sources, ...npmResult.sources, ...actions.sources],
      relationships: uv.relationships,
      findings: uv.findings,
    };
    return {
      uv,
      npm: npmResult,
      actions,
      metadata,
      candidate,
      expected,
      validated: validateReviewPacket(candidate, expected),
      requests: f.requests,
    };
  } finally {
    opened.session.close();
  }
}
test.each([
  'empty',
  'omission',
  'permission403',
  'unknown403',
  'rate403',
  'rate429',
  'partial',
] as const)(
  'real D1/U1/U2 and other collectors preserve mixed packet accounting through %s comparison',
  async (mode) => {
    const h = await handoff(mode);
    expect(h.validated.ok, JSON.stringify(h.validated)).toBe(true);
    if (!h.validated.ok) throw new Error('T4');
    expect(h.uv.coverage.status).toBe('complete');
    expect(h.npm.coverage.status).toBe(
      mode === 'omission' || mode === 'partial' ? 'partial' : 'complete',
    );
    expect(h.actions.coverage.status).toBe('complete');
    expect(h.candidate.changes).toHaveLength(4);
    const units = formDecisionUnits(h.validated.packet);
    expect(units.units).toHaveLength(3);
    expect(units.units.flatMap((u) => u.memberIds).sort()).toEqual(
      h.candidate.changes.map((c) => c.id).sort(),
    );
    expect(h.requests.some((p) => p.includes('/git/trees/'))).toBe(true);
    expect(
      h.requests.every((p) => p.startsWith('https://api.github.com/repos/example/consumer/')),
    ).toBe(true);
  },
);
test.each(['missing', 'malformed', 'unsupported'] as const)(
  'zero known uv changes with %s head lock cannot hide behind complete other slots',
  async (headLock) => {
    const h = await handoff('permission403', { headLock });
    expect(h.validated.ok, JSON.stringify(h.validated)).toBe(true);
    if (!h.validated.ok) throw new Error('T4');
    expect(h.uv.changes).toHaveLength(0);
    expect(h.npm.coverage.status).toBe('complete');
    expect(h.actions.coverage.status).toBe('complete');
    const inventory = formDecisionUnits(h.validated.packet),
      states = Object.fromEntries(
        inventory.units.map((u) => [
          u.id,
          { state: 'assessed' as const, verdict: 'merge' as const },
        ]),
      );
    const coverage = summarizeDecisionCoverage(
      inventory,
      parseReviewConfig('{"version":1}'),
      0,
      states,
    );
    expect(coverage).toMatchObject({
      ok: true,
      outcome: { kind: 'decision_incomplete' },
      counts: { unresolvedUnits: 0 },
    });
    if (coverage.ok) expect(coverage.inventoryGaps.some((g) => g.ecosystem === 'uv')).toBe(true);
  },
);
test.each([126, 127])(
  'real mixed T4 accepts only the combined ceiling with %s uv changes',
  async (count) => {
    const h = await handoff('permission403', { count });
    expect(h.uv.changes).toHaveLength(count);
    expect(h.candidate.changes).toHaveLength(count + 2);
    expect(h.validated.ok).toBe(count === 126);
  },
);
test('zero-member prose conflict survives the actual mixed collector handoff', async () => {
  const h = await handoff('permission403', { unchanged: true, text: 'Resolved uv changes: 1.' });
  expect(h.validated.ok, JSON.stringify(h.validated)).toBe(true);
  expect(h.uv.coverage).toMatchObject({ status: 'partial', reasons: ['conflict'] });
  expect(h.uv.changes).toEqual([]);
  expect(h.uv.sources.find((s) => s.kind === 'dependabot')).toMatchObject({
    status: 'unavailable',
    memberIds: [],
    provenance: { kind: 'unavailable' },
  });
});

// Downstream-only fixtures prove assessment accounting; collectors never produce these research records.
function syntheticResearch(packet: ReviewPacket) {
  const kinds: Record<string, PacketSource['kind']> = {
    upstream: 'metadata',
    vulnerability: 'advisory',
    malware: 'malware',
    installScript: 'install-script',
  };
  for (const c of packet.changes)
    for (const category of Object.keys(c.evidence)) {
      const sourceId = `test-research:${c.id}:${category}`;
      const subjects: SourceSubject[] = [];
      for (const [side, s] of [
        ['base', c.from],
        ['head', c.to],
      ] as const) {
        if (!s || (category !== 'installScript' && side !== (c.to ? 'head' : 'base'))) continue;
        subjects.push({
          memberId: c.id,
          side,
          value: 'version' in s ? s.version : 'ref' in s ? s.ref : '',
        });
      }
      packet.sources.push({
        id: sourceId,
        kind: kinds[category],
        ecosystems: [c.ecosystem],
        memberIds: [c.id],
        status: 'available',
        reasons: [],
        provenance: {
          kind: 'upstream',
          url: 'https://example.test/synthetic-research',
          title: 'Invented downstream evidence',
          excerpt: 'Synthetic records only; no live research was performed.',
          excerptTruncated: false,
          range: null,
          subjects,
        },
      });
      c.evidence[category] = { status: 'available', reasons: [], sourceIds: [sourceId] };
    }
  return packet;
}
test('complete independent assessments resolve standalone units while preserving collector research limits', async () => {
  const h = await handoff();
  expect(h.validated.ok).toBe(true);
  if (!h.validated.ok) throw new Error('T4');
  const copy = syntheticResearch(structuredClone(h.validated.packet) as ReviewPacket);
  copy.relationships = [];
  const checked = validateReviewPacket(copy, h.expected);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  if (!checked.ok) throw new Error('T4');
  const inventory = formDecisionUnits(checked.packet),
    states = Object.fromEntries(
      inventory.units.map((u) => [u.id, { state: 'assessed' as const, verdict: 'merge' as const }]),
    );
  expect(inventory.units.every((u) => u.kind === 'standalone')).toBe(true);
  expect(
    summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0, states),
  ).toMatchObject({ ok: true, outcome: { kind: 'advice' }, counts: { unresolvedUnits: 0 } });
  expect(h.uv.changes[0].evidence.upstream.status).toBe('unavailable');
});

async function uvOnly(f: ReturnType<typeof uvMetadataScenario>) {
  const opened = await createGithubReadSession(
    { binding: f.input.binding, limits: f.readLimits },
    { fetch: f.fetch, now: () => 0 },
  );
  expect(opened.kind).toBe('ready');
  if (opened.kind !== 'ready') throw new Error('D1');
  try {
    const metadata = await collectUvMetadata(f.input, { session: opened.session });
    const r = reconcileUvGraph({
      binding: f.input.binding,
      metadata,
      limits: { maxGraphWork: 1_000_000, maxRetainedBytes: 2_000_000 },
    });
    expect(r.kind).toBe('inventory');
    if (r.kind !== 'inventory') throw new Error('inventory');
    const { packet, expected } = uvPacket(r),
      validated = validateReviewPacket(packet, expected);
    expect(validated.ok, JSON.stringify(validated)).toBe(true);
    return { r, validated };
  } finally {
    opened.session.close();
  }
}
test('real revision-3/5 metadata preserves project extras and omitted empty lock entries', async () => {
  const manifest =
    '[project]\nname="project"\nrequires-python=">=3.11"\ndependencies=[]\n[project.optional-dependencies]\ndocs=["orbit>=1"]\nempty=[]\n';
  const lock = (v: string, revision: number) =>
    `version=1\nrevision=${revision}\nrequires-python=">=3.11"\n[[package]]\nname="project"\nsource={editable="."}\n[package.optional-dependencies]\ndocs=[{name="orbit"}]\n${revision === 5 ? 'empty=[]\n' : ''}[package.metadata]\nrequires-dist=[{name="orbit",specifier=">=1",marker="extra == 'docs'"}]\nprovides-extras=["docs","empty"]\n${uvPackage('orbit', v, 'dependencies=[{name="child"}]\n')}${uvPackage('child', v)}`;
  const { r, validated } = await uvOnly(
    uvMetadataScenario('permission403', {
      files: {
        base: { 'pyproject.toml': manifest, 'uv.lock': lock('1', 3) },
        head: { 'pyproject.toml': manifest, 'uv.lock': lock('2', 5) },
      },
    }),
  );
  expect(r.coverage.status).toBe('complete');
  expect(r.changes).toHaveLength(2);
  expect(r.changes.every((c) => c.to?.extras.join() === 'docs')).toBe(true);
  if (validated.ok) expect(formDecisionUnits(validated.packet).units).toHaveLength(1);
});
test('real previous/current rename paths preserve independent roots without inventing a migration', async () => {
  const { r } = await uvOnly(
    uvMetadataScenario('empty', {
      roots: ['old', 'new'],
      renames: { 'new/pyproject.toml': 'old/pyproject.toml', 'new/uv.lock': 'old/uv.lock' },
      files: {
        base: {
          'pyproject.toml': null,
          'uv.lock': null,
          'old/pyproject.toml': uvManifest,
          'old/uv.lock': uvLock('1'),
        },
        head: {
          'pyproject.toml': null,
          'uv.lock': null,
          'new/pyproject.toml': uvManifest,
          'new/uv.lock': uvLock('2'),
        },
      },
    }),
  );
  expect(r.coverage.status).toBe('complete');
  expect(r.changes).toHaveLength(2);
  expect(r.changes.map((c) => c.kind).sort()).toEqual(['addition', 'removal']);
  expect(r.changes.every((c) => c.from === null || c.to === null)).toBe(true);
  expect(r.relationships).toEqual([]);
  expect(r.fileIdentities.some((s) => s.kind === 'absence' && s.treeSha !== null)).toBe(true);
});
