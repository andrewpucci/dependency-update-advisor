import type { Ecosystem, PacketResult } from './schema.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
type Change = Packet['changes'][number];
export type GroupingReason =
  | 'independent_change'
  | 'actions_occurrence'
  | 'unknown_role'
  | 'inventory_incomplete'
  | 'multiple_direct_changes'
  | 'no_direct_change'
  | 'missing_relationship'
  | 'proven_relationship';
export type DecisionUnit = Readonly<{
  id: string;
  ecosystem: Ecosystem;
  kind: 'standalone' | 'direct_group';
  anchorId: string | null;
  memberIds: readonly string[];
  memberCount: number;
  proofKeys: readonly string[];
  relationship: Readonly<{ reason: GroupingReason; nextAction: string }>;
}>;
export type UnitInventory = Readonly<{
  packet: Packet;
  units: readonly DecisionUnit[];
}>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function unitId(
  packet: Packet,
  ecosystem: Ecosystem,
  kind: DecisionUnit['kind'],
  anchorId: string | null,
  memberIds: readonly string[],
) {
  const { repository, pullNumber, headSha } = packet.binding;
  return JSON.stringify([
    repository.id,
    repository.owner.toLowerCase(),
    repository.name.toLowerCase(),
    pullNumber,
    packet.baseSha,
    headSha,
    ecosystem,
    kind,
    anchorId,
    memberIds,
  ]);
}

function roots(change: Change): readonly string[] {
  return [
    ...new Set(
      [change.from, change.to].flatMap((side) => (side && 'root' in side ? [side.root] : [])),
    ),
  ];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
const actions: Record<GroupingReason, string> = {
  independent_change: 'Assess this change using its own evidence.',
  actions_occurrence: 'Assess this exact workflow occurrence using its own evidence.',
  unknown_role: 'Establish the dependency role or assess this change independently.',
  inventory_incomplete: 'Complete the ecosystem inventory; assess known changes independently.',
  multiple_direct_changes:
    'Assess this change independently; current proofs cannot establish a unique changed anchor.',
  no_direct_change: 'Assess this change independently; no changed direct anchor is established.',
  missing_relationship:
    'Obtain an applicable immutable lockfile path or assess this change independently.',
  proven_relationship:
    'Assess the group without substituting anchor evidence for any member lookup.',
};
function grouping(
  packet: Packet,
  change: Change,
): { anchorId: string | null; reason: GroupingReason; proofKeys: string[] } {
  // ponytail: scans stay bounded by 128 changes and 256 proofs; index only if those packet caps grow.
  const standalone = (reason: GroupingReason) => ({ anchorId: null, reason, proofKeys: [] });
  if (change.ecosystem === 'actions') return standalone('actions_occurrence');
  if (change.role === 'unknown') return standalone('unknown_role');
  if (change.role === 'direct') return standalone('independent_change');
  if (packet.coverage[change.ecosystem].status !== 'complete')
    return standalone('inventory_incomplete');
  const side = change.kind === 'removal' ? 'base' : 'head';
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return standalone('missing_relationship');
  const candidates = packet.changes.filter(
    (c) => c.ecosystem === change.ecosystem && roots(c).includes(instance.root),
  );
  if (candidates.some((c) => c.role === 'unknown')) return standalone('unknown_role');
  const anchors = candidates.filter((c) => c.role === 'direct');
  if (anchors.length !== 1)
    return standalone(anchors.length ? 'multiple_direct_changes' : 'no_direct_change');
  const proofs = packet.relationships.filter(
    (p) => p.fromId === anchors[0].id && p.toId === change.id && p.side === side,
  );
  if (!proofs.length) return standalone('missing_relationship');
  return {
    anchorId: anchors[0].id,
    reason: 'proven_relationship',
    proofKeys: proofs.map((p) => JSON.stringify(canonical(p))).sort(),
  };
}

/** Accepts only T4-validated packets from trusted orchestration; no validation or I/O occurs here.
 * IDs and ordering use canonical tuples and UTF-16 code-unit order. Returns a detached frozen snapshot.
 */
export function formDecisionUnits(input: Packet): UnitInventory {
  const packet = structuredClone(input);
  const assignments = new Map(packet.changes.map((c) => [c.id, grouping(packet, c)]));
  const groups = new Map<string, { members: string[]; proofs: string[] }>();
  for (const c of packet.changes) {
    const assignment = assignments.get(c.id)!;
    if (assignment.anchorId === null) continue;
    const group = groups.get(assignment.anchorId) ?? { members: [assignment.anchorId], proofs: [] };
    group.members.push(c.id);
    group.proofs.push(...assignment.proofKeys);
    groups.set(assignment.anchorId, group);
  }
  const units: DecisionUnit[] = packet.changes.flatMap((c) => {
    const assignment = assignments.get(c.id)!;
    if (assignment.anchorId !== null) return [];
    const group = groups.get(c.id),
      kind = group ? 'direct_group' : 'standalone';
    const memberIds = group ? group.members.sort() : [c.id];
    const anchorId = group ? c.id : null,
      reason = group ? 'proven_relationship' : assignment.reason;
    return [
      {
        id: unitId(packet, c.ecosystem, kind, anchorId, memberIds),
        ecosystem: c.ecosystem,
        kind,
        anchorId,
        memberIds,
        memberCount: memberIds.length,
        proofKeys: group ? group.proofs.sort() : [],
        relationship: { reason, nextAction: actions[reason] },
      },
    ];
  });
  units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return freeze({ packet, units });
}
