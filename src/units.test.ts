import { expect, test } from 'vite-plus/test';
import {
  validateReviewPacket,
  type PacketChange,
  type PacketExpected,
  type ReviewPacket,
  type EvidenceReason,
  PACKET_LIMITS,
} from './schema.js';
import { formDecisionUnits } from './units.js';
import { evaluateUnitPolicy, summarizeDecisionCoverage } from './units.js';
import { parseReviewConfig } from './config.js';
import type { AssessmentState } from './policy.js';

const repository = { id: 101, owner: 'example', name: 'consumer' };
const BASE = 'b'.repeat(40),
  HEAD = 'a'.repeat(40);
const ecosystems = ['npm', 'actions', 'uv'] as const;
type NpmChange = Exclude<Extract<PacketChange, { ecosystem: 'npm' }>, { basis: 'declaration' }>;
type UvChange = Extract<PacketChange, { ecosystem: 'uv' }>;
type ActionChange = Extract<PacketChange, { ecosystem: 'actions' }>;
function evidence(ecosystem: PacketChange['ecosystem']) {
  return Object.fromEntries(
    ['upstream', 'vulnerability', 'malware', ...(ecosystem === 'npm' ? ['installScript'] : [])].map(
      (category) => [
        category,
        { status: 'unavailable' as const, reasons: ['missing' as const], sourceIds: [] },
      ],
    ),
  );
}
function npm(id: string): NpmChange {
  const side = (version: string) => ({
    root: '.',
    name: id,
    lockPath: `node_modules/${id}`,
    version,
    source: { kind: 'registry' as const, identity: 'https://registry.npmjs.org' },
    sourceId: '',
  });
  return {
    id,
    ecosystem: 'npm',
    kind: 'update',
    role: 'direct',
    from: side('1.0.0'),
    to: side('2.0.0'),
    evidence: evidence('npm'),
  };
}
function uv(id: string): UvChange {
  const side = (version: string) => ({
    root: '.',
    name: id,
    version,
    marker: null,
    extras: [],
    groups: [],
    source: { kind: 'registry' as const, identity: 'https://pypi.org/simple' },
    sourceId: '',
  });
  return {
    id,
    ecosystem: 'uv',
    kind: 'update',
    role: 'transitive',
    from: side('1.0.0'),
    to: side('2.0.0'),
    evidence: evidence('uv'),
  };
}
function action(id: string, stepIndex: number): ActionChange {
  const side = (ref: string) => ({
    workflow: '.github/workflows/ci.yml',
    jobId: 'test',
    stepIndex,
    action: 'example/setup',
    ref,
    refKind: 'tag' as const,
    sourceId: '',
  });
  return {
    id,
    ecosystem: 'actions',
    kind: 'update',
    role: 'direct',
    from: side('v1'),
    to: side('v2'),
    evidence: evidence('actions'),
  };
}
function fixture(changes: PacketChange[] = []) {
  const binding: PacketExpected['binding'] = {
    repository,
    workflow: { id: 301, path: '.github/workflows/ci.yml' },
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headRepository: repository,
    headSha: HEAD,
    baseRef: 'main',
    baseSha: BASE,
    mergeBaseSha: BASE,
    actorId: 201,
    conclusion: 'success',
    identity: [101, 301, 401, 1, 42, HEAD],
  };
  const expected: PacketExpected = {
    binding,
    baseSha: BASE,
    contextRevision: { repository, sha: 'c'.repeat(40) },
    context: { ok: true, status: 'disabled', dependencies: [], reasons: [] },
  };
  const coverageFor = (ecosystem: PacketChange['ecosystem']): ReviewPacket['coverage']['npm'] => ({
    status: changes.some((c) => c.ecosystem === ecosystem) ? 'complete' : 'not_applicable',
    reasons: [],
    sourceIds: ['inventory'],
  });
  const packet: ReviewPacket = {
    version: 1,
    ...structuredClone(expected),
    changes,
    relationships: [],
    reachability: [],
    findings: [],
    coverage: { npm: coverageFor('npm'), actions: coverageFor('actions'), uv: coverageFor('uv') },
    sources: [
      {
        id: 'inventory',
        kind: 'file-list',
        ecosystems: [...ecosystems],
        memberIds: [],
        status: 'available',
        reasons: [],
        provenance: {
          kind: 'inventory',
          repository,
          baseSha: BASE,
          headSha: HEAD,
          absentEcosystems: ecosystems.filter((e) => !changes.some((c) => c.ecosystem === e)),
        },
      },
    ],
  };
  for (const [index, c] of changes.entries())
    for (const revision of ['base', 'head'] as const) {
      const side = revision === 'base' ? c.from : c.to;
      if (!side) continue;
      const path =
        'workflow' in side
          ? side.workflow
          : (side.root === '.' ? '' : side.root + '/') +
            (c.ecosystem === 'npm'
              ? 'basis' in c
                ? 'package.json'
                : 'package-lock.json'
              : 'uv.lock');
      side.sourceId = JSON.stringify([c.ecosystem, path, revision, Math.floor(index / 32)]);
      let source = packet.sources.find((s) => s.id === side.sourceId);
      if (!source) {
        source = {
          id: side.sourceId,
          kind: 'file',
          ecosystems: [c.ecosystem],
          memberIds: [],
          status: 'available',
          reasons: [],
          provenance: {
            kind: 'file',
            repository,
            revision,
            sha: revision === 'base' ? BASE : HEAD,
            path,
          },
        };
        packet.sources.push(source);
      }
      source.memberIds.push(c.id);
    }
  return { packet, expected };
}
function accepted(f: ReturnType<typeof fixture>) {
  const result = validateReviewPacket(f.packet, f.expected);
  expect(result.ok, JSON.stringify(result.ok ? 'accepted' : result.error)).toBe(true);
  if (!result.ok) throw new Error('expected valid synthetic packet');
  return result.packet;
}

function declarationChange(): Extract<PacketChange, { basis: 'declaration' }> {
  const side = (specifier: string) => ({
    root: '.',
    name: 'range-only',
    specifiers: { dependencies: specifier },
    sourceId: '',
  });
  return {
    id: 'declaration',
    ecosystem: 'npm',
    basis: 'declaration',
    kind: 'update',
    role: 'direct',
    evidence: {},
    from: side('^1'),
    to: side('^2'),
  };
}

test('declarations are standalone unassessed work without version research gaps', () => {
  const f = fixture([declarationChange()]);
  const units = formDecisionUnits(accepted(f));
  expect(units.units).toHaveLength(1);
  expect(units.units[0].members).toEqual([
    { id: 'declaration', ecosystem: 'npm', name: 'range-only' },
  ]);
  expect(units.units[0].evidenceLinks).toEqual([]);
  expect(units.units[0].sources).toEqual([]);
  const coverage = summarizeDecisionCoverage(units, parseReviewConfig('{"version":1}'), 0);
  if (!coverage.ok) throw new Error('expected coverage');
  expect(coverage.outcome).toEqual({ kind: 'decision_incomplete' });
  expect(coverage.policyProvenance.assessments.unresolvedUnits[0].state).toBe('unattempted');
  expect(coverage.policyProvenance.assessments.units[0].gaps).toEqual([]);
});

test('declaration units cannot suppress or change a resolved direct group', () => {
  const original = groupFixture();
  const baseline = formDecisionUnits(accepted(original));
  const f = fixture([...original.packet.changes, declarationChange()]);
  relate(f, 0, 1);
  const result = formDecisionUnits(accepted(f));
  expect(result.units.filter((u) => u.kind === 'direct_group')).toEqual(baseline.units);
  expect(result.units.find((u) => u.memberIds.includes('declaration'))?.kind).toBe('standalone');
});

test('partitions mixed exact changes without merging repeated names, occurrences, or variants', () => {
  const a = npm('a'),
    b = npm('b'),
    python = uv('python');
  b.from!.name = b.to!.name = a.to!.name;
  const variant = structuredClone(python);
  variant.id = 'variant';
  variant.from!.marker = variant.to!.marker = "python_version >= '3.13'";
  const f = fixture([a, b, python, variant, action('action-one', 0), action('action-two', 1)]);
  const result = formDecisionUnits(accepted(f));
  expect(result.units).toHaveLength(6);
  expect(result.units.flatMap((u) => u.memberIds).sort()).toEqual(
    f.packet.changes.map((c) => c.id).sort(),
  );
  expect(
    result.units.every(
      (u) => u.kind === 'standalone' && u.anchorId === null && u.memberCount === 1,
    ),
  ).toBe(true);
});

test('keeps twenty additions, removed-only inventory, and empty inventory explicit', () => {
  const additions = Array.from({ length: 20 }, (_, i) => ({
    ...npm(`added-${i}`),
    kind: 'addition' as const,
    from: null,
  }));
  expect(formDecisionUnits(accepted(fixture(additions))).units).toHaveLength(20);
  const removed = { ...npm('removed'), kind: 'removal' as const, to: null };
  const result = formDecisionUnits(accepted(fixture([removed])));
  expect(result.packet.changes[0]).toMatchObject({ kind: 'removal', to: null });
  expect(formDecisionUnits(accepted(fixture())).units).toEqual([]);
});

test('identity/order are stable under permutations and bound to both revisions', () => {
  const f = fixture([npm('z'), npm('a')]);
  const original = formDecisionUnits(accepted(f));
  f.packet.changes.reverse();
  f.packet.sources.reverse();
  expect(formDecisionUnits(accepted(f)).units).toEqual(original.units);
  f.packet.baseSha = f.expected.baseSha = 'd'.repeat(40);
  f.packet.binding = { ...f.packet.binding, baseSha: f.packet.baseSha };
  f.expected.binding = structuredClone(f.packet.binding);
  for (const source of f.packet.sources) {
    if (source.provenance.kind === 'inventory') source.provenance.baseSha = f.packet.baseSha;
    if (source.provenance.kind === 'file' && source.provenance.revision === 'base')
      source.provenance.sha = f.packet.baseSha;
  }
  expect(formDecisionUnits(accepted(f)).units.map((u) => u.id)).not.toEqual(
    original.units.map((u) => u.id),
  );
});

test('formation detaches and freezes output without mutating a validated packet', () => {
  const packet = accepted(fixture([npm('one')]));
  const result = formDecisionUnits(packet);
  expect(result.packet).toEqual(packet);
  expect(result.packet).not.toBe(packet);
  expect(Object.isFrozen(result.units[0].memberIds)).toBe(true);
  expect(() => {
    (result.units as unknown[]).pop();
  }).toThrow();
  expect(formDecisionUnits(packet)).toEqual(result);
});

function relate(
  f: ReturnType<typeof fixture>,
  fromIndex: number,
  toIndex: number,
  side: 'base' | 'head' = 'head',
) {
  const from = f.packet.changes[fromIndex],
    to = f.packet.changes[toIndex];
  const start = side === 'head' ? from.to : from.from,
    end = side === 'head' ? to.to : to.from;
  if (from.ecosystem === 'npm' && start && end && 'lockPath' in start && 'lockPath' in end)
    f.packet.relationships.push({
      ecosystem: 'npm',
      fromId: from.id,
      toId: to.id,
      side,
      sourceId: start.sourceId,
      path: [start, end],
    });
  else if (from.ecosystem === 'uv' && start && end && 'marker' in start && 'marker' in end)
    f.packet.relationships.push({
      ecosystem: 'uv',
      fromId: from.id,
      toId: to.id,
      side,
      sourceId: start.sourceId,
      path: [start, end],
    });
  else throw new Error('expected same-ecosystem lock instances');
}
function groupFixture(ecosystem: 'npm' | 'uv' = 'npm') {
  const changes = ecosystem === 'npm' ? [npm('anchor'), npm('child')] : [uv('anchor'), uv('child')];
  changes[0].role = 'direct';
  changes[1].role = 'transitive';
  const f = fixture(changes);
  relate(f, 0, 1);
  return f;
}

test.each(['npm', 'uv'] as const)(
  'groups a proven %s relationship exactly once with stable proof keys',
  (ecosystem) => {
    const f = groupFixture(ecosystem);
    const first = formDecisionUnits(accepted(f));
    expect(first.units).toHaveLength(1);
    expect(first.units[0]).toMatchObject({
      kind: 'direct_group',
      anchorId: 'anchor',
      memberIds: ['anchor', 'child'],
      memberCount: 2,
    });
    expect(first.units[0].proofKeys).toHaveLength(1);
    f.packet.changes.reverse();
    f.packet.sources.reverse();
    expect(formDecisionUnits(accepted(f)).units).toEqual(first.units);
  },
);

test.each([
  ['second_direct', 'independent_change'],
  ['removed_direct', 'multiple_direct_changes'],
  ['unknown', 'unknown_role'],
  ['partial', 'inventory_incomplete'],
  ['no_proof', 'missing_relationship'],
  ['wrong_side', 'missing_relationship'],
] as const)('keeps members standalone for %s without losing a change', (mode, reason) => {
  const f = groupFixture();
  if (mode === 'second_direct') f.packet.changes[1].role = 'direct';
  if (mode === 'removed_direct' || mode === 'unknown') {
    const extra = npm('extra');
    extra.role = mode === 'unknown' ? 'unknown' : 'direct';
    if (mode === 'removed_direct') {
      extra.to = null;
      extra.kind = 'removal';
    }
    const replacement = fixture([...f.packet.changes, extra]);
    f.packet = replacement.packet;
    f.expected = replacement.expected;
    relate(f, 0, 1);
  }
  if (mode === 'partial')
    f.packet.coverage.npm = { status: 'partial', reasons: ['truncated'], sourceIds: [] };
  if (mode === 'no_proof') f.packet.relationships = [];
  if (mode === 'wrong_side') {
    f.packet.relationships = [];
    relate(f, 0, 1, 'base');
  }
  const result = formDecisionUnits(accepted(f));
  expect(result.units.every((u) => u.kind === 'standalone')).toBe(true);
  expect(result.units.flatMap((u) => u.memberIds).sort()).toEqual(
    f.packet.changes.map((c) => c.id).sort(),
  );
  const child = result.units.find((u) => u.memberIds.includes('child'))!;
  expect(child.relationship.reason).toBe(reason);
  expect(child.relationship.nextAction).toBeTruthy();
});

test('groups a removed member through the base while leaving unrelated roots separate', () => {
  const anchor = npm('anchor'),
    removed = npm('removed'),
    other = npm('other');
  removed.role = 'transitive';
  removed.kind = 'removal';
  removed.to = null;
  other.from!.root = other.to!.root = 'packages/other';
  const f = fixture([anchor, removed, other]);
  relate(f, 0, 1, 'base');
  const result = formDecisionUnits(accepted(f));
  expect(result.units).toHaveLength(2);
  expect(result.units.find((u) => u.kind === 'direct_group')!.memberIds).toEqual([
    'anchor',
    'removed',
  ]);
});

test('multiple proofs to the same anchor preserve one group, not extra assessments', () => {
  const f = groupFixture();
  const proof = structuredClone(f.packet.relationships[0]);
  if (proof.ecosystem !== 'npm') throw new Error('expected npm proof');
  proof.path.splice(1, 0, {
    ...proof.path[0],
    name: 'unchanged',
    lockPath: 'node_modules/unchanged',
  });
  f.packet.relationships.push(proof);
  const first = formDecisionUnits(accepted(f));
  expect(first.units).toHaveLength(1);
  expect(first.units[0].proofKeys).toHaveLength(2);
  f.packet.relationships.reverse();
  expect(formDecisionUnits(accepted(f)).units).toEqual(first.units);
});

type Outcome = 'unreachable' | 'unknown' | 'unsupported' | 'failed' | 'truncated';
function verdict(
  f: ReturnType<typeof fixture>,
  anchorId: string,
  memberId: string | null,
  side: 'base' | 'head',
  outcome: Outcome = 'unreachable',
  reasons: EvidenceReason[] = [],
) {
  const anchor = f.packet.changes.find((c) => c.id === anchorId);
  if (!anchor || anchor.ecosystem === 'actions') throw new Error('lock anchor required');
  const step = side === 'head' ? anchor.to : anchor.from;
  if (!step) throw new Error('anchor has no ' + side + ' instance');
  f.packet.reachability.push({
    ecosystem: anchor.ecosystem,
    side,
    sourceId: step.sourceId,
    anchorId,
    memberId,
    outcome,
    reasons,
  });
}
const verdictKey = (v: ReviewPacket['reachability'][number]) =>
  JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))));
function multiAnchor(extra: PacketChange[] = []) {
  const updated = npm('A'),
    removed = { ...npm('R'), kind: 'removal' as const, to: null },
    added = { ...npm('D'), kind: 'addition' as const, from: null },
    member = npm('M');
  member.role = 'transitive';
  const f = fixture([updated, removed, added, member, ...extra]);
  relate(f, 0, 3);
  return f;
}
function completeVerdicts(f: ReturnType<typeof fixture>) {
  verdict(f, 'R', 'M', 'base');
  verdict(f, 'D', 'M', 'head');
}
function unit(f: ReturnType<typeof fixture>, memberId: string) {
  return formDecisionUnits(accepted(f)).units.find((u) => u.memberIds.includes(memberId))!;
}

test('groups under the one reachable anchor when every other candidate is proven unreachable', () => {
  const f = multiAnchor();
  completeVerdicts(f);
  const result = formDecisionUnits(accepted(f));
  const group = result.units.find((u) => u.kind === 'direct_group')!;
  expect(group).toMatchObject({ anchorId: 'A', memberIds: ['A', 'M'], memberCount: 2 });
  expect(group.proofKeys).toHaveLength(1);
  expect(group.verdictKeys).toEqual(f.packet.reachability.map(verdictKey).sort());
  expect(group.relationshipLimits).toEqual([]);
  expect(result.units.filter((u) => u.kind === 'standalone').map((u) => u.memberIds)).toEqual(
    expect.arrayContaining([['R'], ['D']]),
  );
  expect(result.units.flatMap((u) => u.memberIds).sort()).toEqual(['A', 'D', 'M', 'R']);
});

test.each([
  ['missing removal base verdict', 'R'],
  ['missing addition head verdict', 'D'],
] as const)('keeps the member standalone for a %s', (_label, omitted) => {
  const f = multiAnchor();
  if (omitted !== 'R') verdict(f, 'R', 'M', 'base');
  if (omitted !== 'D') verdict(f, 'D', 'M', 'head');
  const m = unit(f, 'M');
  expect(m).toMatchObject({ kind: 'standalone', memberIds: ['M'] });
  expect(m.relationship.reason).toBe('reachability_unproven');
  expect(m.relationship.nextAction).toBeTruthy();
  expect(m.verdictKeys).toEqual([]);
  expect(m.relationshipLimits.join()).toContain(omitted);
});

test.each([
  ['unknown', ['unknown']],
  ['unsupported', ['unsupported']],
  ['failed', ['timeout']],
  ['truncated', ['truncated']],
] as const)(
  'a %s verdict never proves absence and stays an attributable limit',
  (outcome, reasons) => {
    const f = multiAnchor();
    verdict(f, 'D', 'M', 'head');
    verdict(f, 'R', 'M', 'base', outcome, [...reasons]);
    const m = unit(f, 'M');
    expect(m.relationship.reason).toBe('reachability_unproven');
    expect(m.relationshipLimits.join()).toContain(outcome);
    expect(m.relationshipLimits.join()).toContain(reasons[0]);
  },
);

test('a scope record leaves every member of that anchor unproven', () => {
  const f = multiAnchor();
  verdict(f, 'D', 'M', 'head');
  verdict(f, 'R', null, 'base', 'truncated', ['budget']);
  const m = unit(f, 'M');
  expect(m.relationship.reason).toBe('reachability_unproven');
  expect(m.relationshipLimits).toEqual([
    JSON.stringify(['reachability', 'M', 'R', 'base', 'truncated', ['budget']]),
  ]);
});

test('relationship limits are informational and never become C3 evidence sources or limits', () => {
  const f = multiAnchor();
  verdict(f, 'D', 'M', 'head');
  const withLimit = unit(f, 'M');
  expect(withLimit.relationshipLimits.length).toBeGreaterThan(0);
  const categories = Object.keys(f.packet.changes.find((c) => c.id === 'M')!.evidence);
  for (const entry of [...withLimit.sources.map((x) => x.id), ...withLimit.coverageLimits]) {
    const [memberId, category] = JSON.parse(entry) as [string, string];
    expect([memberId, categories.includes(category)]).toEqual(['M', true]);
  }
});

test('an updated candidate needs verdicts on both sides the member uses', () => {
  const f = multiAnchor([npm('U')]);
  completeVerdicts(f);
  verdict(f, 'U', 'M', 'head');
  expect(unit(f, 'M').relationship.reason).toBe('reachability_unproven');
  verdict(f, 'U', 'M', 'base');
  expect(unit(f, 'M')).toMatchObject({ kind: 'direct_group', anchorId: 'A' });
});

test('a removed direct blocks head-only members and an added direct blocks base-only members', () => {
  const rename = fixture([
    { ...npm('R'), kind: 'removal' as const, to: null },
    { ...npm('D'), kind: 'addition' as const, from: null },
    npm('U'),
    { ...npm('N'), kind: 'addition' as const, from: null, role: 'transitive' as const },
  ]);
  relate(rename, 1, 3);
  verdict(rename, 'U', 'N', 'head');
  const added = unit(rename, 'N');
  expect(added.relationship.reason).toBe('reachability_unproven');
  expect(added.relationshipLimits).toEqual([JSON.stringify(['blocked', 'N', 'R'])]);
  const reverse = fixture([
    { ...npm('R'), kind: 'removal' as const, to: null },
    { ...npm('D'), kind: 'addition' as const, from: null },
    npm('U'),
    { ...npm('G'), kind: 'removal' as const, to: null, role: 'transitive' as const },
  ]);
  relate(reverse, 0, 3, 'base');
  verdict(reverse, 'U', 'G', 'base');
  const removed = unit(reverse, 'G');
  expect(removed.relationship.reason).toBe('reachability_unproven');
  expect(removed.relationshipLimits).toEqual([JSON.stringify(['blocked', 'G', 'D'])]);
});

test('two candidates with a positive proof leave the member ambiguous and cite both proofs', () => {
  const f = multiAnchor();
  completeVerdicts(f);
  f.packet.reachability = [];
  verdict(f, 'R', 'M', 'base');
  relate(f, 2, 3);
  const m = unit(f, 'M');
  expect(m).toMatchObject({ kind: 'standalone' });
  expect(m.relationship.reason).toBe('ambiguous_anchors');
  expect(m.relationshipLimits).toHaveLength(2);
  expect(m.proofKeys).toEqual([]);
});

test('several groups form in one root and one member keeps its single unit', () => {
  const f = fixture([npm('A1'), npm('A2'), npm('M1'), npm('M2'), npm('M3')]);
  for (const id of ['M1', 'M2', 'M3'])
    f.packet.changes.find((c) => c.id === id)!.role = 'transitive';
  relate(f, 0, 2);
  relate(f, 1, 3);
  relate(f, 0, 4);
  relate(f, 1, 4);
  for (const [anchor, member] of [
    ['A2', 'M1'],
    ['A1', 'M2'],
  ])
    for (const side of ['base', 'head'] as const) verdict(f, anchor, member, side);
  const units = formDecisionUnits(accepted(f)).units;
  expect(units.filter((u) => u.kind === 'direct_group').map((u) => u.memberIds)).toEqual(
    expect.arrayContaining([
      ['A1', 'M1'],
      ['A2', 'M2'],
    ]),
  );
  expect(units.find((u) => u.memberIds.includes('M3'))).toMatchObject({
    kind: 'standalone',
    relationship: { reason: 'ambiguous_anchors' },
  });
  expect(units.flatMap((u) => u.memberIds).sort()).toEqual(['A1', 'A2', 'M1', 'M2', 'M3'].sort());
});

test('a candidate in another root is not counted against the member', () => {
  const other = npm('X');
  other.from!.root = other.to!.root = 'packages/other';
  const f = multiAnchor([other]);
  completeVerdicts(f);
  expect(unit(f, 'M')).toMatchObject({ kind: 'direct_group', anchorId: 'A' });
});

test('a root-moving candidate counts only on the side naming the member root', () => {
  const mover = npm('X');
  mover.to!.root = 'packages/other';
  const f = multiAnchor([mover]);
  completeVerdicts(f);
  expect(unit(f, 'M').relationship.reason).toBe('reachability_unproven');
  verdict(f, 'X', 'M', 'base');
  expect(unit(f, 'M')).toMatchObject({ kind: 'direct_group', anchorId: 'A' });
});

test.each([0, 1, 2] as const)(
  'empty reachability keeps the legacy multiple_direct_changes result with %i proofs',
  (proofs) => {
    const f = multiAnchor();
    f.packet.relationships = [];
    if (proofs >= 1) relate(f, 0, 3);
    if (proofs >= 2) relate(f, 2, 3);
    const m = unit(f, 'M');
    expect(m).toMatchObject({ kind: 'standalone', verdictKeys: [], relationshipLimits: [] });
    expect(m.relationship).toEqual({
      reason: 'multiple_direct_changes',
      nextAction:
        'Assess this change independently; current proofs cannot establish a unique changed anchor.',
    });
  },
);

test('earlier gates still win over reachability evidence', () => {
  const unknownRole = multiAnchor([{ ...npm('Q'), role: 'unknown' as const }]);
  completeVerdicts(unknownRole);
  expect(unit(unknownRole, 'M').relationship.reason).toBe('unknown_role');
  const partial = multiAnchor();
  completeVerdicts(partial);
  partial.packet.coverage.npm = { status: 'partial', reasons: ['truncated'], sourceIds: [] };
  expect(unit(partial, 'M').relationship.reason).toBe('inventory_incomplete');
});

test('multi-anchor grouping is deterministic under permutation and keeps uv variants exact', () => {
  const f = multiAnchor();
  completeVerdicts(f);
  const first = formDecisionUnits(accepted(f));
  f.packet.changes.reverse();
  f.packet.sources.reverse();
  f.packet.reachability.reverse();
  expect(formDecisionUnits(accepted(f)).units).toEqual(first.units);
  const a = uv('ua'),
    b = uv('ub'),
    m = uv('um');
  a.role = b.role = 'direct';
  const g = fixture([a, b, m]);
  relate(g, 0, 2);
  verdict(g, 'ub', 'um', 'head');
  verdict(g, 'ub', 'um', 'base');
  expect(unit(g, 'um')).toMatchObject({ kind: 'direct_group', anchorId: 'ua' });
});

function available(f: ReturnType<typeof fixture>, id: string, categories?: string[]) {
  const change = f.packet.changes.find((c) => c.id === id)!;
  if ('basis' in change) throw new Error('resolved fixture required');
  for (const category of categories ?? Object.keys(change.evidence)) {
    const sourceId = JSON.stringify([id, category]);
    const kinds = {
      upstream: 'release',
      vulnerability: 'advisory',
      malware: 'malware',
      installScript: 'install-script',
      publishTime: 'publishTime',
      deprecation: 'deprecation',
      trust: 'trust',
      publisher: 'publisher',
    } as const;
    const kind = kinds[category as keyof typeof kinds];
    if (!kind) throw new Error('unsupported fixture category');
    const sides =
      category === 'installScript'
        ? (['base', 'head'] as const)
        : ([change.to ? 'head' : 'base'] as const);
    f.packet.sources.push({
      id: sourceId,
      kind,
      ecosystems: [change.ecosystem],
      memberIds: [id],
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'upstream',
        url: `https://example.test/evidence/${encodeURIComponent(sourceId)}`,
        title: 'Synthetic evidence',
        excerpt: 'Bounded synthetic evidence.',
        excerptTruncated: false,
        range: {
          from: change.from ? ('ref' in change.from ? change.from.ref : change.from.version) : null,
          to: change.to ? ('ref' in change.to ? change.to.ref : change.to.version) : null,
        },
        ...(kind === 'advisory' || kind === 'malware'
          ? { advisoryId: 'GHSA-synthetic', affectedRange: '>=2.0.0' }
          : {}),
        subjects: sides.flatMap((side) => {
          const instance = side === 'base' ? change.from : change.to;
          return instance
            ? [{ memberId: id, side, value: 'ref' in instance ? instance.ref : instance.version }]
            : [];
        }),
      },
    });
    change.evidence[category] = { status: 'available', reasons: [], sourceIds: [sourceId] };
  }
}

test('projects member evidence without letting the anchor conceal required or optional failures', () => {
  const f = groupFixture();
  available(f, 'anchor');
  f.packet.changes[1].evidence.upstream = {
    status: 'partial',
    reasons: ['timeout', 'permission'],
    sourceIds: [],
  };
  f.packet.changes[1].evidence.publisher = {
    status: 'unavailable',
    reasons: ['missing'],
    sourceIds: [],
  };
  const inventory = formDecisionUnits(accepted(f));
  const policy = evaluateUnitPolicy(inventory, parseReviewConfig('{"version":1}'), 0);
  expect(policy.ok).toBe(true);
  if (!policy.ok) throw new Error('expected policy');
  expect(policy.units).toHaveLength(1);
  expect(policy.units[0].gaps).toHaveLength(4);
  expect(policy.units[0].uncheckedSignals).toHaveLength(1);
  const unit = inventory.units[0];
  expect(
    unit.evidenceLinks.find((link) => link.memberId === 'child' && link.category === 'upstream'),
  ).toMatchObject({
    reasons: ['permission', 'timeout'],
    sourceIds: [],
    status: 'partial',
  });
  expect(unit.sources.find((s) => s.id === JSON.stringify(['child', 'upstream']))!.reason).toBe(
    'permission',
  );
  expect(unit.sources.some((s) => s.status === 'group_backed')).toBe(false);
  expect(unit.sources.find((s) => s.id === JSON.stringify(['anchor', 'upstream']))!.reason).toBe(
    '',
  );
});

test('projects exact current/proposed identities for every ecosystem and null side', () => {
  const removed = npm('removed');
  removed.to = null;
  removed.kind = 'removal';
  const added = uv('added');
  added.from = null;
  added.kind = 'addition';
  const inventory = formDecisionUnits(accepted(fixture([removed, added, action('use', 1)])));
  const members = inventory.units.flatMap((u) => u.members);
  expect(members.find((m) => m.id === 'removed')).toEqual({
    id: 'removed',
    ecosystem: 'npm',
    name: 'removed',
    currentVersion: '1.0.0',
  });
  expect(members.find((m) => m.id === 'added')).toEqual({
    id: 'added',
    ecosystem: 'uv',
    name: 'added',
    proposedVersion: '2.0.0',
  });
  expect(members.find((m) => m.id === 'use')).toMatchObject({
    name: 'example/setup',
    currentVersion: 'v1',
    proposedVersion: 'v2',
  });
});

test('preserves findings and fixed malware policy while named rules are relaxed', () => {
  const f = groupFixture();
  available(f, 'child', ['malware']);
  f.packet.findings = [
    {
      id: 'malicious',
      memberId: 'child',
      kind: 'malware',
      applicability: 'affects_proposed',
      references: [JSON.stringify(['child', 'malware'])],
      rationale: 'Synthetic verified malware.',
      remediation: ['Remove the package.'],
      validation: ['Re-run CI.'],
    },
  ];
  const inventory = formDecisionUnits(accepted(f));
  const policy = evaluateUnitPolicy(
    inventory,
    parseReviewConfig('{"version":1,"policy":{"verdicts":{"incompleteEvidence":"merge"}}}'),
    0,
  );
  if (!policy.ok) throw new Error('expected policy');
  expect(policy.effectiveCeiling).toBe('do_not_merge');
  expect(inventory.units[0].findings).toEqual(f.packet.findings);
  expect(
    inventory.units[0].evidenceLinks.some((link) =>
      link.sourceIds.includes(JSON.stringify(['child', 'malware'])),
    ),
  ).toBe(true);
});

test('failed config exposes no usable evaluation', () => {
  const result = evaluateUnitPolicy(
    formDecisionUnits(accepted(fixture([npm('one')]))),
    parseReviewConfig('{}'),
    0,
  );
  expect(result).toMatchObject({ ok: false });
  expect(result).not.toHaveProperty('units');
});

test('initial states are unattempted, but omitted post-analysis states stay missing', () => {
  const inventory = formDecisionUnits(accepted(fixture([npm('one')])));
  const config = parseReviewConfig('{"version":1}');
  const initial = summarizeDecisionCoverage(inventory, config, 0);
  const omitted = summarizeDecisionCoverage(inventory, config, 0, {});
  if (!initial.ok || !omitted.ok) throw new Error('expected coverage');
  expect(initial.outcome).toEqual({ kind: 'decision_incomplete' });
  expect(initial.policyProvenance.assessments.unresolvedUnits[0].state).toBe('unattempted');
  expect(omitted.policyProvenance.assessments.unresolvedUnits[0].state).toBe('missing');
  expect(initial.counts).toEqual({
    changedMembers: 1,
    units: 1,
    assessedUnits: 0,
    unresolvedUnits: 1,
    groupedUnits: 0,
    standaloneUnits: 1,
  });
});

test.each(['unavailable', 'unattempted', 'rejected'] as const)(
  'preserves assessed units alongside %s work',
  (state) => {
    const f = fixture([npm('one'), npm('two')]);
    available(f, 'one');
    available(f, 'two');
    const inventory = formDecisionUnits(accepted(f));
    const states: Record<string, AssessmentState> = {
      [inventory.units[0].id]: { state: 'assessed', verdict: 'merge' },
      [inventory.units[1].id]: {
        state,
        reason: 'Synthetic failure.',
        nextAction: 'Re-run CI.',
        coverageLimits: ['unit limit'],
      },
    };
    const result = summarizeDecisionCoverage(
      inventory,
      parseReviewConfig('{"version":1}'),
      0,
      states,
    );
    if (!result.ok) throw new Error('expected coverage');
    expect(result.outcome).toEqual({ kind: 'decision_incomplete' });
    expect(result.counts).toMatchObject({ assessedUnits: 1, unresolvedUnits: 1 });
    expect(result.policyProvenance.assessments.assessments[0].state).toBe('assessed');
    expect(result.policyProvenance.assessments.unresolvedUnits[0]).toMatchObject({
      state,
      nextAction: 'Re-run CI.',
      coverageLimits: ['unit limit'],
    });
  },
);

test('fully evidenced standalone units resolve missing grouping without inventing an evidence gap', () => {
  const child = npm('child');
  child.role = 'transitive';
  const f = fixture([child]);
  available(f, 'child');
  const inventory = formDecisionUnits(accepted(f));
  const result = summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0, {
    [inventory.units[0].id]: { state: 'assessed', verdict: 'merge' },
  });
  if (!result.ok) throw new Error('expected coverage');
  expect(result.outcome).toEqual({ kind: 'advice', verdict: 'merge' });
  expect(result.inventory.units[0].relationship.reason).toBe('no_direct_change');
  expect(result.policyProvenance.assessments.units[0].gaps).toEqual([]);
});

test.each(['none', 'model', 'verified'] as const)(
  'packet-wide gaps with %s hold have one authoritative outcome',
  (hold) => {
    const f = fixture([npm('one')]);
    available(f, 'one');
    f.packet.coverage.actions = { status: 'unavailable', reasons: ['permission'], sourceIds: [] };
    if (hold === 'verified')
      f.packet.findings.push({
        id: 'high',
        memberId: 'one',
        kind: 'vulnerability',
        severity: 'high',
        applicability: 'affects_proposed',
        references: [JSON.stringify(['one', 'vulnerability'])],
        rationale: 'Synthetic advisory.',
        remediation: ['Upgrade.'],
        validation: ['Re-run CI.'],
      });
    const inventory = formDecisionUnits(accepted(f));
    const result = summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0, {
      [inventory.units[0].id]: {
        state: 'assessed',
        verdict: hold === 'model' ? 'do_not_merge' : 'merge',
      },
    });
    if (!result.ok) throw new Error('expected coverage');
    expect(result.outcome).toEqual(
      hold === 'verified'
        ? { kind: 'advice', verdict: 'do_not_merge' }
        : { kind: 'decision_incomplete' },
    );
    expect(result).not.toHaveProperty('decision');
    expect(result.inventoryGaps).toMatchObject([{ ecosystem: 'actions', reasons: ['permission'] }]);
    expect(result.inventoryGaps[0].nextActions[0]).toContain('permission');
    expect(result.counts).toMatchObject({ assessedUnits: 1, unresolvedUnits: 0 });
  },
);

test('verified hold survives all unavailable analysis; relaxing only that finding retains unresolved work', () => {
  const f = fixture([npm('one'), npm('two')]);
  available(f, 'one');
  f.packet.findings.push({
    id: 'high',
    memberId: 'one',
    kind: 'vulnerability',
    severity: 'high',
    applicability: 'affects_proposed',
    references: [JSON.stringify(['one', 'vulnerability'])],
    rationale: 'Synthetic advisory.',
    remediation: ['Upgrade.'],
    validation: ['Re-run CI.'],
  });
  const inventory = formDecisionUnits(accepted(f));
  const states = Object.fromEntries(
    inventory.units.map((unit) => [
      unit.id,
      {
        state: 'unavailable' as const,
        reason: 'No model result.',
        nextAction: 'Re-run CI.',
        coverageLimits: [],
      },
    ]),
  );
  const held = summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0, states);
  const relaxed = summarizeDecisionCoverage(
    inventory,
    parseReviewConfig(
      '{"version":1,"policy":{"verdicts":{"highOrCriticalVulnerability":"merge"}}}',
    ),
    0,
    states,
  );
  if (!held.ok || !relaxed.ok) throw new Error('expected coverage');
  expect(held.outcome).toEqual({ kind: 'advice', verdict: 'do_not_merge' });
  expect(held.counts.unresolvedUnits).toBe(2);
  expect(relaxed.outcome).toEqual({ kind: 'decision_incomplete' });
  expect(relaxed.policyProvenance.assessments.units.flatMap((unit) => unit.findings)).toEqual(
    f.packet.findings,
  );
});

test('proven empty inventory has no merge verdict; failed empty inventory is incomplete', () => {
  const f = fixture();
  const config = parseReviewConfig('{"version":1}');
  const empty = summarizeDecisionCoverage(formDecisionUnits(accepted(f)), config, 0);
  if (!empty.ok) throw new Error('expected coverage');
  expect(empty.outcome).toEqual({ kind: 'empty_inventory' });
  expect(empty.counts.units).toBe(0);
  expect(empty.policyProvenance.assessments.assessments).toEqual([]);
  f.packet.coverage.uv = { status: 'unavailable', reasons: ['timeout'], sourceIds: [] };
  const unavailable = summarizeDecisionCoverage(formDecisionUnits(accepted(f)), config, 0);
  if (!unavailable.ok) throw new Error('expected coverage');
  expect(unavailable.outcome).toEqual({ kind: 'decision_incomplete' });
  expect(unavailable.inventoryGaps[0].ecosystem).toBe('uv');
});

test('assessed required gaps remain explicit even with relaxed advice; optional signals alone do not create gaps', () => {
  const f = fixture([npm('one')]);
  const inventory = formDecisionUnits(accepted(f));
  const config = parseReviewConfig(
    '{"version":1,"policy":{"verdicts":{"incompleteEvidence":"merge"}}}',
  );
  const result = summarizeDecisionCoverage(inventory, config, 0, {
    [inventory.units[0].id]: { state: 'assessed' },
  });
  if (!result.ok) throw new Error('expected coverage');
  expect(result.outcome).toEqual({ kind: 'advice', verdict: 'merge' });
  expect(result.policyProvenance.assessments.units[0].gaps).toHaveLength(4);
  expect(result).not.toHaveProperty('executionSuccess');
  available(f, 'one');
  f.packet.changes[0].evidence.trust = {
    status: 'unavailable',
    reasons: ['timeout'],
    sourceIds: [],
  };
  const complete = formDecisionUnits(accepted(f));
  const optional = summarizeDecisionCoverage(complete, config, 0, {
    [complete.units[0].id]: { state: 'assessed' },
  });
  if (!optional.ok) throw new Error('expected coverage');
  expect(optional.policyProvenance.assessments.units[0].gaps).toEqual([]);
  expect(optional.policyProvenance.assessments.units[0].uncheckedSignals).toHaveLength(1);
});

test('keeps the entire accepted 128-change inventory; T4 overflow has no usable packet', () => {
  const f = fixture(Array.from({ length: PACKET_LIMITS.changes }, (_, i) => npm(`package-${i}`)));
  const inventory = formDecisionUnits(accepted(f));
  expect(inventory.units).toHaveLength(128);
  const result = summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0);
  if (!result.ok) throw new Error('expected coverage');
  expect(result.counts).toMatchObject({ units: 128, changedMembers: 128, unresolvedUnits: 128 });
  const overflow = fixture([...f.packet.changes, npm('overflow')]);
  const rejected = validateReviewPacket(overflow.packet, overflow.expected);
  expect(rejected).toEqual({ ok: false, error: { category: 'budget', field: 'changes' } });
  expect(rejected).not.toHaveProperty('packet');
});

test.each(['proof_count', 'path_length'])(
  'retains maximum accepted %s without graph expansion',
  (limit) => {
    const f = groupFixture();
    const template = f.packet.relationships[0];
    if (template.ecosystem !== 'npm') throw new Error('expected npm proof');
    f.packet.relationships = Array.from(
      { length: limit === 'proof_count' ? PACKET_LIMITS.relationships : 1 },
      (_, i) => {
        const proof = structuredClone(template);
        const intermediates = Array.from(
          { length: limit === 'path_length' ? PACKET_LIMITS.pathInstances - 2 : 1 },
          (_, j) => ({
            ...proof.path[0],
            name: `middle-${i}-${j}`,
            lockPath: `node_modules/middle-${i}-${j}`,
          }),
        );
        proof.path.splice(1, 0, ...intermediates);
        return proof;
      },
    );
    const inventory = formDecisionUnits(accepted(f));
    expect(inventory.units).toHaveLength(1);
    expect(inventory.units[0].memberCount).toBe(2);
    expect(inventory.units[0].proofKeys).toHaveLength(limit === 'proof_count' ? 256 : 1);
    const states = {
      [inventory.units[0].id]: { state: 'assessed' as const, verdict: 'merge' as const },
    };
    const result = summarizeDecisionCoverage(
      inventory,
      parseReviewConfig('{"version":1}'),
      0,
      states,
    );
    if (!result.ok) throw new Error('expected coverage');
    expect(result.counts).toMatchObject({
      changedMembers: 2,
      units: 1,
      groupedUnits: 1,
      assessedUnits: 1,
    });
    expect(inventory.packet.context).toEqual({
      ok: true,
      status: 'disabled',
      dependencies: [],
      reasons: [],
    });
  },
);

test('reason vocabulary, optional signals, and permuted evidence retain precise attribution', () => {
  const reasons: EvidenceReason[] = [
    'permission',
    'rate_limit',
    'timeout',
    'missing',
    'malformed',
    'unsupported',
    'truncated',
    'budget',
    'conflict',
    'unknown',
  ];
  const f = fixture([npm('one')]);
  f.packet.changes[0].evidence.upstream.reasons = [...reasons].reverse();
  for (const signal of ['publishTime', 'deprecation', 'trust', 'publisher'])
    f.packet.changes[0].evidence[signal] = {
      status: 'unavailable',
      reasons: ['missing'],
      sourceIds: [],
    };
  const first = formDecisionUnits(accepted(f));
  f.packet.changes[0].evidence.upstream.reasons.reverse();
  f.packet.changes[0].evidence = Object.fromEntries(
    Object.entries(f.packet.changes[0].evidence).reverse(),
  );
  expect(formDecisionUnits(accepted(f)).units).toEqual(first.units);
  const result = evaluateUnitPolicy(first, parseReviewConfig('{"version":1}'), 0);
  if (!result.ok) throw new Error('expected policy');
  expect(first.units[0].evidenceLinks.find((l) => l.category === 'upstream')!.reasons).toEqual(
    reasons,
  );
  expect(result.units[0].uncheckedSignals.map((s) => s.signal).sort()).toEqual([
    'deprecation',
    'publishTime',
    'publisher',
    'trust',
  ]);
  expect(result.units[0].gaps).toHaveLength(4);
  expect(
    result.units[0].gaps.find((g) => g.sourceId === JSON.stringify(['one', 'upstream']))!
      .coverageLimits,
  ).toHaveLength(10);
});

test('a direct change moving roots counts in both roots and prevents an unjustified group', () => {
  const anchor = npm('anchor'),
    child = npm('child'),
    moved = npm('moved');
  child.role = 'transitive';
  moved.to!.root = 'other';
  const f = fixture([anchor, child, moved]);
  relate(f, 0, 1);
  const inventory = formDecisionUnits(accepted(f));
  expect(inventory.units).toHaveLength(3);
  expect(inventory.units.find((u) => u.memberIds.includes('child'))!.relationship.reason).toBe(
    'multiple_direct_changes',
  );
});

test('a root-moving anchor cannot combine base-root removals and head-root updates into one cross-root group', () => {
  const anchor = npm('anchor'),
    removed = npm('removed'),
    updated = npm('updated');
  anchor.to!.root = 'other';
  removed.role = 'transitive';
  removed.kind = 'removal';
  removed.to = null;
  updated.role = 'transitive';
  updated.from!.root = updated.to!.root = 'other';
  const f = fixture([anchor, removed, updated]);
  relate(f, 0, 1, 'base');
  relate(f, 0, 2);
  const result = formDecisionUnits(accepted(f));
  expect(result.units).toHaveLength(3);
  expect(result.units.every((unit) => unit.kind === 'standalone')).toBe(true);
});

test('changing group membership or only the head invalidates assessment identity', () => {
  const f = groupFixture();
  const original = formDecisionUnits(accepted(f)).units[0].id;
  const extra = npm('extra');
  extra.role = 'transitive';
  const expanded = fixture([...f.packet.changes, extra]);
  relate(expanded, 0, 1);
  relate(expanded, 0, 2);
  expect(formDecisionUnits(accepted(expanded)).units[0].id).not.toBe(original);
  const old = f.packet.binding;
  const binding: PacketExpected['binding'] = {
    ...old,
    headSha: 'e'.repeat(40),
    identity: [
      old.repository.id,
      old.workflow.id,
      old.runId,
      old.runAttempt,
      old.pullNumber,
      'e'.repeat(40),
    ],
  };
  f.packet.binding = binding;
  f.expected.binding = structuredClone(binding);
  for (const source of f.packet.sources) {
    if (source.provenance.kind === 'inventory') source.provenance.headSha = 'e'.repeat(40);
    if (source.provenance.kind === 'file' && source.provenance.revision === 'head')
      source.provenance.sha = 'e'.repeat(40);
  }
  expect(formDecisionUnits(accepted(f)).units[0].id).not.toBe(original);
});

test('coverage snapshots do not mutate config, assessment states, or prior results', () => {
  const inventory = formDecisionUnits(accepted(fixture([npm('one')])));
  const config = parseReviewConfig('{"version":1}');
  const state = {
    state: 'unavailable' as const,
    reason: 'Unavailable.',
    nextAction: 'Re-run CI.',
    coverageLimits: ['original'],
  };
  const states = { [inventory.units[0].id]: state };
  const result = summarizeDecisionCoverage(inventory, config, 0, states);
  if (!result.ok) throw new Error('expected coverage');
  state.coverageLimits.push('later');
  expect(result.policyProvenance.assessments.unresolvedUnits[0].coverageLimits).not.toContain(
    'later',
  );
  expect(Object.isFrozen(result.inventoryGaps)).toBe(true);
  expect(Object.isFrozen(config)).toBe(false);
  expect(summarizeDecisionCoverage(inventory, parseReviewConfig('{}'), 0)).toMatchObject({
    ok: false,
  });
  expect(summarizeDecisionCoverage(inventory, parseReviewConfig('{}'), 0)).not.toHaveProperty(
    'outcome',
  );
});

test('a model-only hold with another missing unit cannot become a verified blocker', () => {
  const f = fixture([npm('one'), npm('two')]);
  available(f, 'one');
  available(f, 'two');
  const inventory = formDecisionUnits(accepted(f));
  const result = summarizeDecisionCoverage(inventory, parseReviewConfig('{"version":1}'), 0, {
    [inventory.units[0].id]: { state: 'assessed', verdict: 'do_not_merge' },
  });
  if (!result.ok) throw new Error('expected coverage');
  expect(result.outcome).toEqual({ kind: 'decision_incomplete' });
  expect(result.counts).toMatchObject({ assessedUnits: 1, unresolvedUnits: 1 });
});
