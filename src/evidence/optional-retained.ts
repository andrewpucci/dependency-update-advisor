import type { ReachabilityVerdict, RelationshipProof } from '../schema.js';

/** The two optional evidence lists a collector may carry beyond its required inventory. */
export type OptionalEvidence = {
  reachability: readonly ReachabilityVerdict[];
  optionalRelationships: readonly RelationshipProof[];
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Replaces each anchor/side pair group with one truncated scope record; existing scope records stay. */
export function scopeAll(verdicts: readonly ReachabilityVerdict[]): ReachabilityVerdict[] {
  const kept: ReachabilityVerdict[] = [],
    groups = new Map<string, ReachabilityVerdict>();
  for (const v of verdicts) {
    if (v.memberId === null) kept.push(v);
    else groups.set(JSON.stringify([v.side, v.anchorId]), v);
  }
  return [
    ...kept,
    ...[...groups.values()].map((v): ReachabilityVerdict => ({
      ecosystem: v.ecosystem,
      side: v.side,
      sourceId: v.sourceId,
      anchorId: v.anchorId,
      memberId: null,
      outcome: 'truncated',
      reasons: ['budget'],
    })),
  ];
}
/**
 * Keeps a retained result inside the caller's byte limit by degrading optional evidence only, in this
 * order: pair groups become scope records, second proofs go, then the scope records go. Only a
 * required-content overflow calls `fail`. Every step moves a member toward a standalone unit.
 */
export function fitRetained<T extends OptionalEvidence>(
  result: T,
  limit: number,
  fail: () => never,
): T {
  if (bytes(result) <= limit) return result;
  let next: T = { ...result, reachability: scopeAll(result.reachability) };
  if (bytes(next) <= limit) return next;
  next = { ...next, optionalRelationships: [] };
  if (bytes(next) <= limit) return next;
  next = { ...next, reachability: [] };
  return bytes(next) <= limit ? next : fail();
}
