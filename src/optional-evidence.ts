import { PACKET_LIMITS } from './schema.js';

/** One optional record the assembler dropped to keep a valid packet inside its budgets. */
export type DroppedOptional = Readonly<{
  kind: 'reachability' | 'proof';
  ecosystem: 'npm' | 'uv';
  key: string;
}>;
type Loose = Record<string, unknown>;
type Group = { key: string; ecosystem: 'npm' | 'uv'; records: Loose[]; bytes: number };
type Proof = { key: string; ecosystem: 'npm' | 'uv'; value: unknown; bytes: number };
export type OptionalInput = Readonly<{
  /** Packet text for empty optional arrays; the optional records are measured against it. */
  baseBytes: number;
  requiredProofs: readonly unknown[];
  optionalProofs: readonly unknown[];
  verdicts: readonly unknown[];
}>;

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const isLoose = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const lock = (value: unknown): value is 'npm' | 'uv' => value === 'npm' || value === 'uv';

/**
 * Fits optional reachability evidence into the packet-wide budgets. It replaces whole anchor/side pair
 * groups with one `truncated` scope record, then drops optional proofs, uv before npm and then by
 * descending canonical key. Required proofs, verdicts it cannot group, and all non-evidence stay.
 * A dropped record only ever degrades a member toward a standalone unit.
 */
export function fitOptionalEvidence(input: OptionalInput) {
  const fixed: unknown[] = [],
    groups = new Map<string, Group>();
  for (const v of input.verdicts) {
    if (
      isLoose(v) &&
      lock(v.ecosystem) &&
      typeof v.side === 'string' &&
      typeof v.anchorId === 'string' &&
      typeof v.sourceId === 'string' &&
      typeof v.memberId === 'string'
    ) {
      const key = JSON.stringify([v.ecosystem, v.side, v.anchorId]);
      const group = groups.get(key) ?? { key, ecosystem: v.ecosystem, records: [], bytes: 0 };
      group.records.push(v);
      group.bytes += size(v);
      groups.set(key, group);
    } else fixed.push(v);
  }
  const proofs: Proof[] = [],
    keptProofs: unknown[] = [];
  for (const p of input.optionalProofs) {
    if (
      isLoose(p) &&
      lock(p.ecosystem) &&
      typeof p.fromId === 'string' &&
      typeof p.toId === 'string' &&
      typeof p.side === 'string'
    )
      proofs.push({
        key: JSON.stringify([p.ecosystem, p.fromId, p.toId, p.side]),
        ecosystem: p.ecosystem,
        value: p,
        bytes: size(p),
      });
    else keptProofs.push(p);
  }
  const byKeyDescending = <T extends { key: string }>(a: T, b: T) =>
    a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  const pending = [...groups.values()].sort(byKeyDescending),
    droppable = [...proofs].sort(byKeyDescending);
  const scopes: unknown[] = [],
    dropped: DroppedOptional[] = [];
  let verdictCount = fixed.length + [...groups.values()].reduce((n, g) => n + g.records.length, 0),
    verdictBytes =
      fixed.reduce<number>((n, v) => n + size(v), 0) +
      [...groups.values()].reduce((n, g) => n + g.bytes, 0),
    proofCount = input.requiredProofs.length + keptProofs.length + proofs.length,
    proofBytes =
      input.requiredProofs.reduce<number>((n, p) => n + size(p), 0) +
      keptProofs.reduce<number>((n, p) => n + size(p), 0) +
      proofs.reduce((n, p) => n + p.bytes, 0);
  const total = () =>
    input.baseBytes +
    verdictBytes +
    Math.max(verdictCount - 1, 0) +
    proofBytes +
    Math.max(proofCount - 1, 0);
  const dropGroup = () => {
    const group = pending.shift()!;
    const first = group.records[0];
    const scope = {
      ecosystem: first.ecosystem,
      side: first.side,
      sourceId: first.sourceId,
      anchorId: first.anchorId,
      memberId: null,
      outcome: 'truncated',
      reasons: ['budget'],
    };
    scopes.push(scope);
    verdictCount += 1 - group.records.length;
    verdictBytes += size(scope) - group.bytes;
    groups.delete(group.key);
    dropped.push({ kind: 'reachability', ecosystem: group.ecosystem, key: group.key });
  };
  const dropProof = () => {
    const proof = droppable.shift()!;
    proofs.splice(proofs.indexOf(proof), 1);
    proofCount -= 1;
    proofBytes -= proof.bytes;
    dropped.push({ kind: 'proof', ecosystem: proof.ecosystem, key: proof.key });
  };
  while (verdictCount > PACKET_LIMITS.reachability && pending.length) dropGroup();
  while (proofCount > PACKET_LIMITS.relationships && droppable.length) dropProof();
  while (total() > PACKET_LIMITS.bytes && (pending.length || droppable.length))
    if (pending.length) dropGroup();
    else dropProof();
  return {
    /** Drops one more optional unit; false when none remain. Used if validation still reports a budget. */
    dropMore: () => {
      if (pending.length) dropGroup();
      else if (droppable.length) dropProof();
      else return false;
      return true;
    },
    current: () => ({
      reachability: [...fixed, ...scopes, ...[...groups.values()].flatMap((g) => g.records)],
      relationships: [...input.requiredProofs, ...keptProofs, ...proofs.map((p) => p.value)],
      dropped: [...dropped],
    }),
  };
}
