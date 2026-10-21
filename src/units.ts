import type { Ecosystem, PacketResult } from './schema.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
export type DecisionUnit = Readonly<{
  id: string;
  ecosystem: Ecosystem;
  kind: 'standalone' | 'direct_group';
  anchorId: string | null;
  memberIds: readonly string[];
  memberCount: number;
  proofKeys: readonly string[];
  relationship: Readonly<{ reason: string; nextAction: string }>;
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

/** Accepts only T4-validated packets from trusted orchestration; no validation or I/O occurs here.
 * IDs and ordering use canonical tuples and UTF-16 code-unit order. Returns a detached frozen snapshot.
 */
export function formDecisionUnits(input: Packet): UnitInventory {
  const packet = structuredClone(input);
  const units: DecisionUnit[] = packet.changes.map((c) => ({
    id: unitId(packet, c.ecosystem, 'standalone', null, [c.id]),
    ecosystem: c.ecosystem,
    kind: 'standalone',
    anchorId: null,
    memberIds: [c.id],
    memberCount: 1,
    proofKeys: [],
    relationship: {
      reason: 'independent_change',
      nextAction: 'Assess this change using its own evidence.',
    },
  }));
  units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return freeze({ packet, units });
}
