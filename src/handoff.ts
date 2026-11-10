import type { PacketGap } from './packet.js';
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
}>;
/** What the pipeline knows about the result beyond its outcome kind. */
export type HandoffDetail = Readonly<{ body: boolean; gaps: readonly PacketGap[] }>;
const MAX_GAPS = 4;

function copyGaps(gaps: readonly PacketGap[]): readonly PacketGap[] {
  return Object.freeze(
    gaps.slice(0, MAX_GAPS).map(({ source, reason }) => Object.freeze({ source, reason })),
  );
}
export type HandoffResult =
  | Readonly<{ kind: 'ready'; handoff: ReviewHandoff }>
  | Readonly<{ kind: 'stale' }>;

/** Maps an owned outcome to publication intent without receiving a write capability. */
export async function createReviewHandoff(
  claims: ClaimStore,
  claim: OwnedClaim,
  kind: ReviewOutcomeKind,
  detail: HandoffDetail = { body: false, gaps: [] },
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
        }),
      );
      return true;
    },
    traces: () => Object.freeze([...traces]),
  });
}
