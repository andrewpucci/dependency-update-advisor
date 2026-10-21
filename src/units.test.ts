import { expect, test } from 'vite-plus/test';
import {
  validateReviewPacket,
  type PacketChange,
  type PacketExpected,
  type ReviewPacket,
} from './schema.js';
import { formDecisionUnits } from './units.js';
import { evaluateUnitPolicy, summarizeDecisionCoverage } from './units.js';
import { parseReviewConfig } from './config.js';
import type { AssessmentState } from './policy.js';

const repository = { id: 101, owner: 'example', name: 'consumer' };
const BASE = 'b'.repeat(40),
  HEAD = 'a'.repeat(40);
const ecosystems = ['npm', 'actions', 'uv'] as const;
type NpmChange = Extract<PacketChange, { ecosystem: 'npm' }>;
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
            (c.ecosystem === 'npm' ? 'package-lock.json' : 'uv.lock');
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

test.each(['second_direct', 'removed_direct', 'unknown', 'partial', 'no_proof', 'wrong_side'])(
  'keeps members standalone for %s without losing a change',
  (mode) => {
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
    expect(
      result.units.find((u) => u.memberIds.includes('child'))!.relationship.nextAction,
    ).toBeTruthy();
  },
);

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

function available(f: ReturnType<typeof fixture>, id: string, categories?: string[]) {
  const change = f.packet.changes.find((c) => c.id === id)!;
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
