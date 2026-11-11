import { reviewPacket, type AssessmentInput } from './assessment.js';
import { EVIDENCE_READ_ENVELOPE, JOB_BUDGET_MS } from './budget.js';
import {
  createEvidenceCollectors,
  openEvidenceSession,
  type EvidenceSessionResult,
} from './collection.js';
import {
  reverifyReviewBinding,
  verifyCiEvent,
  type EventReads,
  type RepositoryIdentity,
  type ReviewBinding,
} from './event.js';
import { createReviewHandoff, type RehearsalSink, type ReviewHandoff } from './handoff.js';
import { guardedFetch } from './adapters.js';
import { assembleReviewPacket, type PacketGap } from './packet.js';
import type { DroppedOptional } from './optional-evidence.js';
import { runResearch } from './research.js';
import type { ClaimStore, InternalFailureStage, OwnedClaim, ReviewOutcomeKind } from './review.js';
import { withTrustedSnapshot, type SnapshotReads } from './snapshot.js';

/** How often a pending request is checked against ownership; shorter than any request timeout. */
const OWNERSHIP_WATCH_MS = 2_000;

export type PipelineInput = Readonly<{
  /** The trusted workflow_run event with its expected repository and workflow. */
  event: unknown;
  repository: RepositoryIdentity;
  /** Null means no model is configured; no collector or model request is made. */
  llmApiKey: string | null;
  eventReads: EventReads;
  snapshotReads: SnapshotReads;
  claims: ClaimStore;
  sink: RehearsalSink;
  /** Authenticated fetch for the consumer repository; the only holder of the read token. */
  githubFetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Fetch for public registries and advisory sources; only api.github.com carries a credential. */
  publicFetch: (url: string, init: RequestInit) => Promise<Response>;
  model?: AssessmentInput['model'];
  /** Monotonic milliseconds. */
  now: () => number;
  /** Epoch milliseconds used for policy evaluation and the review timestamp. */
  evaluationTime: number;
  temporaryRoot?: () => Promise<string>;
  /** How often a pending request is checked against ownership; defaults to two seconds. */
  ownershipWatchMs?: number;
}>;
export type PipelineResult =
  | Readonly<{ kind: 'skipped'; reason: 'ineligible' | 'obsolete' | 'duplicate' }>
  /** Identity could not be verified or ownership was never held or was lost: nothing is publishable. */
  | Readonly<{ kind: 'not-eligible'; reason: 'verification' | 'ownership' }>
  /** The no-write sink failed after a valid handoff was built; it is not publishable. */
  | Readonly<{ kind: 'failed'; outcome: 'internal-failure'; stage: 'handoff' }>
  | Readonly<{
      kind: 'handed-off';
      outcome: ReviewOutcomeKind;
      handoff: ReviewHandoff;
      /** A comment-ready body, only for a complete or accurately rendered incomplete review. */
      body: string | null;
      recorded: boolean;
    }>;

type OutcomeDetail = Readonly<{
  body: string | null;
  /** Sources that gave no usable evidence, when no packet could be rendered. */
  gaps?: readonly PacketGap[];
  /** Optional evidence that fit the packet only after a conservative budget drop. */
  droppedOptional?: readonly DroppedOptional[];
}>;
type Outcome =
  | (OutcomeDetail &
      Readonly<{ kind: Exclude<ReviewOutcomeKind, 'internal-failure'>; stage?: never }>)
  | (OutcomeDetail & Readonly<{ kind: 'internal-failure'; stage: InternalFailureStage }>);

/** A boundary failure whose stage is a literal chosen by this module, never derived from the error. */
class StageFailure extends Error {
  constructor(readonly stage: InternalFailureStage) {
    super(stage);
  }
}

/** Runs one boundary, reporting any exception from it as that stage's fixed failure. */
async function inStage<T>(stage: InternalFailureStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof StageFailure ? error : new StageFailure(stage);
  }
}

/** `stale` proves the head moved or ownership ended; `error` only means it could not be verified. */
type Freshness = 'current' | 'stale' | 'error';

function stopped(state: 'stale' | 'error'): Outcome {
  return state === 'stale'
    ? { kind: 'stale', body: null }
    : { kind: 'internal-failure', stage: 'unclassified', body: null };
}

/** T4 requires exactly one context entry per change, so every change is named, Actions included. */
function dependencyIdentities(changes: readonly unknown[]): { id: string; name: string }[] {
  const identities: { id: string; name: string }[] = [];
  for (const change of changes) {
    const value = change as {
      id?: unknown;
      to?: { name?: unknown; action?: unknown } | null;
      from?: { name?: unknown; action?: unknown } | null;
    };
    const instance = value.to ?? value.from;
    const name = instance?.name ?? instance?.action;
    if (typeof value.id === 'string' && typeof name === 'string')
      identities.push({ id: value.id, name });
  }
  return identities;
}

/**
 * Drives one review attempt: verify the event, own the attempt, build the trusted snapshot,
 * collect and research evidence, assess, and record a redacted publication handoff. Nothing is
 * published; the App token never enters this function.
 */
export async function runReview(input: PipelineInput): Promise<PipelineResult> {
  const started = input.now();
  const verified = await verifyCiEvent(input.event, input.eventReads);
  if (verified.kind === 'skip') return { kind: 'skipped', reason: verified.reason };
  if (verified.kind === 'error') return { kind: 'not-eligible', reason: 'verification' };
  const binding = verified.binding;

  const claimed = await input.claims.claim(binding.identity);
  if (claimed.kind === 'duplicate') return { kind: 'skipped', reason: 'duplicate' };
  const claim: OwnedClaim = claimed;

  let state: Freshness = 'current';
  /** Ends every request of this attempt, including ones already in flight. */
  const attempt = new AbortController();
  /** Ownership alone is a cheap read, so it is checked before each request and on a timer. */
  const owns = async (): Promise<boolean> => {
    const owner = await input.claims.read(claim);
    const mine =
      owner.kind === 'owned' &&
      owner.owner === claim.owner &&
      owner.generation === claim.generation;
    if (!mine) {
      state = 'stale';
      attempt.abort();
    }
    return mine;
  };
  /** Ownership and the PR head must both still hold before anything may be handed off. */
  const stillCurrent = async (): Promise<Freshness> => {
    if (!(await owns())) return 'stale';
    const fresh = await reverifyReviewBinding(binding, input.eventReads);
    if (fresh.kind === 'fresh') return (state = 'current');
    state = fresh.kind === 'obsolete' ? 'stale' : 'error';
    attempt.abort();
    return state;
  };
  const guard = (fetch: PipelineInput['githubFetch']) => guardedFetch(fetch, attempt, owns);

  const evaluate = async (): Promise<Outcome> => {
    const entry = await stillCurrent();
    if (entry !== 'current')
      return entry === 'stale'
        ? { kind: 'stale', body: null }
        : { kind: 'internal-failure', stage: 'unclassified', body: null };
    // With no model configured, no snapshot, collector, or model request is made.
    if (!input.llmApiKey) return { kind: 'model-unavailable', body: null };
    return evaluateEvidence(
      { ...input, githubFetch: guard(input.githubFetch), publicFetch: guard(input.publicFetch) },
      binding,
      started,
      attempt.signal,
      () => state,
      stillCurrent,
    );
  };

  let outcome: Outcome;
  // Ownership is also watched while a request is pending, so a lost attempt stops its work.
  const watcher = setInterval(
    () => void owns().catch(() => undefined),
    input.ownershipWatchMs ?? OWNERSHIP_WATCH_MS,
  );
  watcher.unref();
  try {
    outcome = await evaluate();
  } catch {
    outcome = { kind: 'internal-failure', stage: 'unclassified', body: null };
  } finally {
    clearInterval(watcher);
  }
  // A result is only publishable if the attempt is still the owner's, on the same PR head. A
  // freshness read that fails is a failure to verify, not proof the head moved.
  if (outcome.kind !== 'stale') {
    const final = await stillCurrent().catch(() => 'error' as const);
    if (final !== 'current') outcome = stopped(final);
  }

  try {
    const handoff = await createReviewHandoff(input.claims, claim, outcome.kind, {
      body: outcome.body !== null,
      gaps: outcome.gaps ?? [],
      droppedOptional: outcome.droppedOptional ?? [],
      ...(outcome.kind === 'internal-failure' ? { stage: outcome.stage } : {}),
    });
    if (handoff.kind !== 'ready') return { kind: 'not-eligible', reason: 'ownership' };
    return {
      kind: 'handed-off',
      outcome: outcome.kind,
      handoff: handoff.handoff,
      body: outcome.body,
      recorded: input.sink.record(handoff.handoff),
    };
  } catch {
    return { kind: 'failed', outcome: 'internal-failure', stage: 'handoff' };
  }
}

async function evaluateEvidence(
  input: PipelineInput,
  binding: ReviewBinding,
  started: number,
  signal: AbortSignal,
  state: () => Freshness,
  /** Re-reads ownership and the PR head; anything but `current` means this attempt must stop. */
  recheck: () => Promise<Freshness>,
): Promise<Outcome> {
  const isCurrent = () => state() === 'current';
  let evidenceSession: EvidenceSessionResult['kind'] = 'ready';
  let npmInventory: unknown = null;
  const evidenceDeadline = started + EVIDENCE_READ_ENVELOPE.totalTimeoutMs;
  let snapshot: Awaited<ReturnType<typeof withTrustedSnapshot<Outcome>>>;
  try {
    snapshot = await withTrustedSnapshot(
      {
        repository: input.repository,
        reads: input.snapshotReads,
        signal,
        isCurrent,
        temporaryRoot: input.temporaryRoot,
      },
      async (trusted): Promise<Outcome> => {
        const collectors = createEvidenceCollectors({
          binding,
          dependabot: await trusted.dependabotRoots(),
          registryFetch: input.publicFetch,
          onNpmInventory: (inventory) => (npmInventory = inventory),
          signal,
          now: input.now,
          deadline: evidenceDeadline,
        });
        const base = {
          binding,
          baseSha: binding.baseSha,
          contextRevision: trusted.contextRevision,
        };
        const assembled = await inStage('packet', () =>
          assembleReviewPacket({
            trusted: base,
            collectContext: (changes) =>
              inStage('snapshot', () => trusted.collectContext(dependencyIdentities(changes))),
            isCurrent,
            openSession: async () => {
              const opened = await openEvidenceSession({
                binding,
                fetch: input.githubFetch,
                now: input.now,
                deadline: evidenceDeadline,
              });
              evidenceSession = opened.kind;
              if (opened.kind !== 'ready') throw new Error('no evidence session');
              return opened.session;
            },
            collectors,
            inventorySource: null,
          }),
        );
        if (assembled.kind === 'context-failure')
          // A consumer configuration fault stops the review; a failed or limited read is incomplete.
          return {
            kind:
              assembled.category === 'config' || assembled.category === 'path'
                ? 'invalid-config'
                : 'incomplete-evidence',
            body: null,
          };
        if (assembled.kind === 'stale') return { kind: 'stale', body: null };
        if (assembled.kind === 'incomplete')
          return { kind: 'incomplete-evidence', body: null, gaps: assembled.gaps };
        if (assembled.kind !== 'ready')
          return evidenceSession === 'obsolete'
            ? { kind: 'stale', body: null }
            : { kind: 'internal-failure', stage: 'packet', body: null };

        // Public research is only worth starting while this attempt still owns the current head.
        const beforeResearch = await recheck();
        if (beforeResearch !== 'current') return stopped(beforeResearch);
        const researched = await inStage('research', () =>
          runResearch({
            packet: assembled.packet,
            trusted: { ...base, context: assembled.packet.context as never },
            npmInventory: npmInventory as never,
            comparison: null,
            fetch: input.publicFetch,
            now: input.now,
            deadline: evidenceDeadline,
            evaluationTime: input.evaluationTime,
            signal,
          }),
        );
        if (researched.kind !== 'ready')
          return { kind: 'internal-failure', stage: 'research', body: null };
        // The model is only called while the attempt is still the owner's.
        const beforeModel = await recheck();
        if (beforeModel !== 'current') return stopped(beforeModel);

        const reviewed = await inStage('assessment', () =>
          reviewPacket({
            packet: researched.packet,
            config: trusted.config,
            apiKey: input.llmApiKey,
            evaluatedAt: input.evaluationTime,
            deadlineMs: started + JOB_BUDGET_MS,
            signalAttempts: researched.signalAttempts,
            researchIncomplete: researched.unavailable.length > 0,
            signal,
            model: input.model,
          }),
        );
        if (reviewed.kind === 'internal-failure')
          return {
            kind: 'internal-failure',
            stage: 'assessment',
            body: reviewed.body,
            ...(reviewed.gaps ? { gaps: reviewed.gaps } : {}),
            droppedOptional: assembled.droppedOptional,
          };
        return {
          kind: reviewed.kind,
          body: reviewed.body,
          ...(reviewed.gaps ? { gaps: reviewed.gaps } : {}),
          droppedOptional: assembled.droppedOptional,
        };
      },
    );
  } catch (error) {
    return {
      kind: 'internal-failure',
      stage: error instanceof StageFailure ? error.stage : 'unclassified',
      body: null,
    };
  }
  if (snapshot.kind === 'ready') return snapshot.value;
  if (snapshot.kind === 'invalid-config') return { kind: 'invalid-config', body: null };
  return state() === 'stale'
    ? { kind: 'stale', body: null }
    : { kind: 'internal-failure', stage: 'snapshot', body: null };
}
