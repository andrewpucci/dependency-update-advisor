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
  comment: 'none' | 'eligible';
}>;
export type HandoffResult =
  | Readonly<{ kind: 'ready'; handoff: ReviewHandoff }>
  | Readonly<{ kind: 'stale' }>;

/** Maps an owned outcome to publication intent without receiving a write capability. */
export async function createReviewHandoff(
  claims: ClaimStore,
  claim: OwnedClaim,
  kind: ReviewOutcomeKind,
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
    }),
  };
}

export type RehearsalSink = Readonly<{
  record: (handoff: ReviewHandoff) => boolean;
  traces: () => readonly Readonly<{ kind: ReviewOutcomeKind; status: string; comment: string }>[];
}>;

/** A bounded local sink deliberately rejects every usable App token and has no client fallback. */
export function createRehearsalSink(appToken: string | null): RehearsalSink | null {
  if (appToken) return null;
  const traces: { kind: ReviewOutcomeKind; status: string; comment: string }[] = [];
  return Object.freeze({
    record: (handoff) => {
      if (traces.length >= 32) return false;
      traces.push({ kind: handoff.kind, status: handoff.status, comment: handoff.comment });
      return true;
    },
    traces: () => Object.freeze(traces.map((trace) => Object.freeze({ ...trace }))),
  });
}
