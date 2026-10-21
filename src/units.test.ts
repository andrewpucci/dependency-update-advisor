import { expect, test } from 'vite-plus/test';
import {
  validateReviewPacket,
  type PacketChange,
  type PacketExpected,
  type ReviewPacket,
} from './schema.js';
import { formDecisionUnits } from './units.js';

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
