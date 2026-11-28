/**
 * Packet shapes for the heap probe (scripts/measure-heap/packet.ts), applied to a written dump of
 * `{ packet, expected, ... }`. They keep the packet valid under T4 and push one cost to its
 * structural limit:
 *
 * - `expansionShape`: the largest decision-unit expansion. Some npm transitive updates become
 *   direct anchors and the rest each prove a path from one of them, so every other anchor must be
 *   excluded by reachability. Each anchor's scope verdict has failed for every reason, which turns
 *   each exclusion into a relationship limit naming both ids and all ten reasons. Every evidence
 *   entry is partial for every reason, and every change id is padded to `idCodeUnits` with a
 *   three-byte character. With n eligible changes and k anchors the limits number (n − k)(k − 1) × 2, so k is the
 *   middle of n.
 * - `denseShape`: the most values per packet byte. Every 64-hex id becomes the shortest distinct
 *   hex string, so ids no longer outweigh the values that reference them.
 */
const REASONS = [
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
const PAD = 'あ';

type Side = { root: string; sourceId: string };
type Change = {
  id: string;
  ecosystem: string;
  role: string;
  kind: string;
  from: Side | null;
  to: Side | null;
  evidence: Record<string, { status: string; reasons: string[] }>;
};
type Source = {
  id: string;
  kind: string;
  ecosystems: string[];
  memberIds?: string[];
  provenance: { revision?: string; path?: string };
};
type Packet = {
  changes: Change[];
  sources: Source[];
  relationships: unknown[];
  reachability: unknown[];
};

export function expansionShape(dump: { packet: unknown }, idCodeUnits: number) {
  const packet = dump.packet as Packet;
  const eligible = packet.changes.filter(
    (c) =>
      c.ecosystem === 'npm' &&
      c.role === 'transitive' &&
      c.kind === 'update' &&
      c.to?.root === '.' &&
      c.from?.root === '.',
  );
  // (n − k)(k − 1) is largest at k = ⌈(n + 1) / 2⌉ for n eligible changes.
  const anchors = Math.ceil((eligible.length + 1) / 2);
  const bySource = new Map<string, Change[]>();
  for (const change of eligible)
    bySource.set(change.to!.sourceId, [...(bySource.get(change.to!.sourceId) ?? []), change]);
  const groups = [...bySource.values()];
  const perGroup = Math.ceil(anchors / groups.length);
  const chosen = groups.flatMap((group) => group.slice(0, perGroup)).slice(0, anchors);
  const transitive = eligible.filter((change) => !chosen.includes(change));
  for (const anchor of chosen) anchor.role = 'direct';
  const lockfiles = (revision: string) =>
    packet.sources.filter(
      (s) =>
        s.kind === 'file' &&
        s.provenance.revision === revision &&
        s.provenance.path === 'package-lock.json' &&
        s.ecosystems.includes('npm'),
    );
  packet.relationships = transitive.map((change) => {
    const anchor = chosen.find((a) => a.to!.sourceId === change.to!.sourceId)!;
    return {
      fromId: anchor.id,
      toId: change.id,
      ecosystem: 'npm',
      side: 'head',
      sourceId: anchor.to!.sourceId,
      path: [anchor.to, change.to],
    };
  });
  packet.reachability = chosen.flatMap((anchor) =>
    (['base', 'head'] as const).map((side) => {
      const files = lockfiles(side);
      const file = files.find((s) => s.memberIds?.includes(anchor.id)) ?? files[0]!;
      return {
        ecosystem: 'npm',
        side,
        sourceId: file.id,
        anchorId: anchor.id,
        memberId: null,
        outcome: 'failed',
        reasons: [...REASONS],
      };
    }),
  );
  for (const change of packet.changes)
    for (const entry of Object.values(change.evidence)) {
      entry.status = 'partial';
      entry.reasons = [...REASONS];
    }
  let text = JSON.stringify(dump);
  for (const { id } of packet.changes)
    text = text.replaceAll(`"${id}"`, `"${id}${PAD.repeat(idCodeUnits - id.length)}"`);
  return {
    text,
    anchors: chosen.length,
    transitive: transitive.length,
    limits: transitive.length * (chosen.length - 1) * 2,
  };
}

export function denseShape(text: string): string {
  const short = new Map<string, string>();
  return text.replace(/[0-9a-f]{64}/g, (hex) => {
    if (!short.has(hex)) short.set(hex, short.size.toString(16));
    return short.get(hex)!;
  });
}
