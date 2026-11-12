import type { PacketGap } from './packet.js';
import type { DroppedOptional } from './optional-evidence.js';
import {
  internalFailureStage,
  reviewOutcome,
  type ClaimStore,
  type FreshnessDetail,
  type InternalFailureStage,
  type OwnedClaim,
  type ReviewOutcomeKind,
} from './review.js';

type ReviewHandoffBase = Readonly<{
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
export type ReviewHandoff =
  | (ReviewHandoffBase & Readonly<{ kind: 'internal-failure'; stage: InternalFailureStage }>)
  | (ReviewHandoffBase &
      Readonly<{ kind: Exclude<ReviewOutcomeKind, 'internal-failure'>; stage?: never }>);
export type OptionalEvidenceDropCounts = Readonly<{ reachability: number; proof: number }>;
/** What the pipeline knows about the result beyond its outcome kind. */
export type HandoffDetail = Readonly<{
  body: boolean;
  gaps: readonly PacketGap[];
  droppedOptional?: readonly DroppedOptional[];
  /** Required for internal failures; defaults to the safe catch-all for direct callers. */
  stage?: InternalFailureStage;
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
  const detailBase = {
    identity: claim.identity,
    generation: claim.generation,
    status: outcome.status,
    comment: outcome.comment,
    body: detail.body ? ('present' as const) : ('absent' as const),
    gaps: copyGaps(detail.gaps),
    droppedOptional: countDroppedOptional(detail.droppedOptional ?? []),
  };
  return {
    kind: 'ready',
    handoff: Object.freeze({
      kind,
      ...(kind === 'internal-failure' ? { stage: internalFailureStage(detail.stage) } : {}),
      ...detailBase,
    }) as ReviewHandoff,
  };
}

type RehearsalTraceBase = Readonly<{
  identity: OwnedClaim['identity'];
  generation: number;
  status: ReviewHandoff['status'];
  comment: ReviewHandoff['comment'];
  body: ReviewHandoff['body'];
  gaps: ReviewHandoff['gaps'];
  droppedOptional: ReviewHandoff['droppedOptional'];
}>;
export type RehearsalTrace =
  | (RehearsalTraceBase &
      Readonly<{
        kind: 'internal-failure';
        stage: InternalFailureStage;
        /** Only with the `freshness` stage: which check failed and why. */
        detail?: FreshnessDetail;
      }>)
  | (RehearsalTraceBase &
      Readonly<{
        kind: Exclude<ReviewOutcomeKind, 'internal-failure'>;
        stage?: never;
        detail?: never;
      }>);
export type RehearsalSink = Readonly<{
  /** `detail` is kept only for a `freshness` internal failure; it never enters the handoff. */
  record: (handoff: ReviewHandoff, detail?: FreshnessDetail) => boolean;
  traces: () => readonly RehearsalTrace[];
}>;

/** A bounded local sink deliberately rejects every usable App token and has no client fallback. */
export function createRehearsalSink(appToken: string | null): RehearsalSink | null {
  if (appToken) return null;
  const traces: RehearsalTrace[] = [];
  return Object.freeze({
    record: (handoff, detail) => {
      if (traces.length >= 32) return false;
      const traceBase = {
        identity: Object.freeze([...handoff.identity]) as OwnedClaim['identity'],
        generation: handoff.generation,
        status: handoff.status,
        comment: handoff.comment,
        body: handoff.body,
        gaps: copyGaps(handoff.gaps),
        droppedOptional: handoff.droppedOptional,
      };
      traces.push(
        Object.freeze({
          kind: handoff.kind,
          ...(handoff.kind === 'internal-failure' ? { stage: handoff.stage } : {}),
          ...(handoff.kind === 'internal-failure' && handoff.stage === 'freshness' && detail
            ? { detail: Object.freeze({ field: detail.field, reason: detail.reason }) }
            : {}),
          ...traceBase,
        }) as RehearsalTrace,
      );
      return true;
    },
    traces: () => Object.freeze([...traces]),
  });
}
