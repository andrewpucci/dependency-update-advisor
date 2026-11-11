import type { PacketGap } from './packet.js';
import type { DroppedOptional } from './optional-evidence.js';
import {
  reviewOutcome,
  type ClaimStore,
  type OwnedClaim,
  type ReviewOutcomeKind,
} from './review.js';

export type ReviewHandoff = Readonly<{
  kind: ReviewOutcomeKind;
  identity: OwnedClaim['identity'];
  generation: number;
  status: 'none' | 'failure' | 'success';
  /** What the outcome may eventually do; whether a body exists is reported separately. */
  comment: 'none' | 'eligible';
  body: 'present' | 'absent';
  /** Which sources gave no usable evidence and why; never error text. */
  gaps: readonly PacketGap[];
  /** Bounded, redacted accounting for optional packet evidence removed to meet a budget. */
  droppedOptional: OptionalEvidenceDropCounts;
}>;
export type OptionalEvidenceDropCounts = Readonly<{ reachability: number; proof: number }>;
/** What the pipeline knows about the result beyond its outcome kind. */
export type HandoffDetail = Readonly<{
  body: boolean;
  gaps: readonly PacketGap[];
  droppedOptional?: readonly DroppedOptional[];
}>;
const MAX_GAPS = 4;

function copyGaps(gaps: readonly PacketGap[]): readonly PacketGap[] {
  return Object.freeze(
    gaps.slice(0, MAX_GAPS).map(({ source, reason }) => Object.freeze({ source, reason })),
  );
}
function countDroppedOptional(dropped: readonly DroppedOptional[]): OptionalEvidenceDropCounts {
  let reachability = 0,
    proof = 0;
  for (const record of dropped)
    if (record.kind === 'reachability') reachability += 1;
    else proof += 1;
  return Object.freeze({ reachability, proof });
}
export type HandoffResult =
  | Readonly<{ kind: 'ready'; handoff: ReviewHandoff }>
  | Readonly<{ kind: 'stale' }>;

/** Maps an owned outcome to publication intent without receiving a write capability. */
export async function createReviewHandoff(
  claims: ClaimStore,
  claim: OwnedClaim,
  kind: ReviewOutcomeKind,
  detail: HandoffDetail = { body: false, gaps: [], droppedOptional: [] },
): Promise<HandoffResult> {
  const state = await claims.read(claim);
  if (
    state.kind !== 'owned' ||
    state.owner !== claim.owner ||
    state.generation !== claim.generation
  )
    return { kind: 'stale' };
  const outcome = reviewOutcome(kind);
  return {
    kind: 'ready',
    handoff: Object.freeze({
      kind,
      identity: claim.identity,
      generation: claim.generation,
      status: outcome.status,
      comment: outcome.comment,
      body: detail.body ? 'present' : 'absent',
      gaps: copyGaps(detail.gaps),
      droppedOptional: countDroppedOptional(detail.droppedOptional ?? []),
    }),
  };
}

export type RehearsalTrace = Readonly<{
  kind: ReviewOutcomeKind;
  identity: OwnedClaim['identity'];
  generation: number;
  status: ReviewHandoff['status'];
  comment: ReviewHandoff['comment'];
  body: ReviewHandoff['body'];
  gaps: ReviewHandoff['gaps'];
  droppedOptional: ReviewHandoff['droppedOptional'];
}>;
export type RehearsalSink = Readonly<{
  record: (handoff: ReviewHandoff) => boolean;
  traces: () => readonly RehearsalTrace[];
}>;

/** A bounded local sink deliberately rejects every usable App token and has no client fallback. */
export function createRehearsalSink(appToken: string | null): RehearsalSink | null {
  if (appToken) return null;
  const traces: RehearsalTrace[] = [];
  return Object.freeze({
    record: (handoff) => {
      if (traces.length >= 32) return false;
      traces.push(
        Object.freeze({
          kind: handoff.kind,
          identity: Object.freeze([...handoff.identity]) as OwnedClaim['identity'],
          generation: handoff.generation,
          status: handoff.status,
          comment: handoff.comment,
          body: handoff.body,
          gaps: copyGaps(handoff.gaps),
          droppedOptional: handoff.droppedOptional,
        }),
      );
      return true;
    },
    traces: () => Object.freeze([...traces]),
  });
}
