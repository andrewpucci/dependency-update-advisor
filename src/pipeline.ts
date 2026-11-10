import { reviewPacket, type AssessmentInput } from './assessment.js';
import { W2_ENVELOPE } from './budget.js';
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
import { assembleReviewPacket } from './packet.js';
import { runResearch } from './research.js';
import type { ClaimStore, OwnedClaim, ReviewOutcomeKind } from './review.js';
import { withTrustedSnapshot, type SnapshotReads } from './snapshot.js';

/** The job's wall-clock limit; analysis and publication reserve their own time inside it. */
const JOB_BUDGET_MS = 15 * 60 * 1_000;

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
  /** Credential-free fetch for public registries and advisory sources. */
  publicFetch: (url: string, init: RequestInit) => Promise<Response>;
  model?: AssessmentInput['model'];
  /** Monotonic milliseconds. */
  now: () => number;
  /** Epoch milliseconds used for policy evaluation and the review timestamp. */
  evaluationTime: number;
  temporaryRoot?: () => Promise<string>;
}>;
export type PipelineResult =
  | Readonly<{ kind: 'skipped'; reason: 'ineligible' | 'obsolete' | 'duplicate' }>
  /** Identity could not be verified or ownership was never held or was lost: nothing is publishable. */
  | Readonly<{ kind: 'not-eligible'; reason: 'verification' | 'ownership' }>
  | Readonly<{
      kind: 'handed-off';
      outcome: ReviewOutcomeKind;
      handoff: ReviewHandoff;
      /** A comment-ready body, only for a complete or accurately rendered incomplete review. */
      body: string | null;
      recorded: boolean;
    }>;

type Outcome = Readonly<{ kind: ReviewOutcomeKind; body: string | null }>;

/** `stale` proves the head moved or ownership ended; `error` only means it could not be verified. */
type Freshness = 'current' | 'stale' | 'error';

function stopped(state: 'stale' | 'error'): Outcome {
  return { kind: state === 'stale' ? 'stale' : 'internal-failure', body: null };
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
  /** Ownership and the PR head must both still hold before anything may be handed off. */
  const stillCurrent = async (): Promise<Freshness> => {
    const owner = await input.claims.read(claim);
    if (
      owner.kind !== 'owned' ||
      owner.owner !== claim.owner ||
      owner.generation !== claim.generation
    )
      return (state = 'stale');
    const fresh = await reverifyReviewBinding(binding, input.eventReads);
    if (fresh.kind === 'fresh') return (state = 'current');
    return (state = fresh.kind === 'obsolete' ? 'stale' : 'error');
  };

  const evaluate = async (): Promise<Outcome> => {
    const entry = await stillCurrent();
    if (entry !== 'current')
      return { kind: entry === 'stale' ? 'stale' : 'internal-failure', body: null };
    // With no model configured, no snapshot, collector, or model request is made.
    if (!input.llmApiKey) return { kind: 'model-unavailable', body: null };
    return evaluateEvidence(input, binding, started, () => state, stillCurrent);
  };

  let outcome: Outcome;
  try {
    outcome = await evaluate();
  } catch {
    outcome = { kind: 'internal-failure', body: null };
  }
  // A result is only publishable if the attempt is still the owner's, on the same PR head. A
  // freshness read that fails is a failure to verify, not proof the head moved.
  if (outcome.kind !== 'stale') {
    const final = await stillCurrent().catch(() => 'error' as const);
    if (final !== 'current') outcome = stopped(final);
  }

  const handoff = await createReviewHandoff(input.claims, claim, outcome.kind);
  if (handoff.kind !== 'ready') return { kind: 'not-eligible', reason: 'ownership' };
  return {
    kind: 'handed-off',
    outcome: outcome.kind,
    handoff: handoff.handoff,
    body: outcome.body,
    recorded: input.sink.record(handoff.handoff),
  };
}

async function evaluateEvidence(
  input: PipelineInput,
  binding: ReviewBinding,
  started: number,
  state: () => Freshness,
  /** Re-reads ownership and the PR head; anything but `current` means this attempt must stop. */
  recheck: () => Promise<Freshness>,
): Promise<Outcome> {
  const isCurrent = () => state() === 'current';
  let evidenceSession: EvidenceSessionResult['kind'] = 'ready';
  let npmInventory: unknown = null;
  const evidenceDeadline = started + W2_ENVELOPE.totalTimeoutMs;
  const snapshot = await withTrustedSnapshot(
    {
      repository: input.repository,
      reads: input.snapshotReads,
      isCurrent,
      temporaryRoot: input.temporaryRoot,
    },
    async (trusted): Promise<Outcome> => {
      const collectors = createEvidenceCollectors({
        binding,
        dependabot: await trusted.dependabotRoots(),
        registryFetch: input.publicFetch,
        onNpmInventory: (inventory) => (npmInventory = inventory),
        now: input.now,
        deadline: evidenceDeadline,
      });
      const base = {
        binding,
        baseSha: binding.baseSha,
        contextRevision: trusted.contextRevision,
      };
      const assembled = await assembleReviewPacket({
        trusted: base,
        collectContext: (changes) => trusted.collectContext(dependencyIdentities(changes)),
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
      });
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
      if (assembled.kind === 'incomplete') return { kind: 'incomplete-evidence', body: null };
      if (assembled.kind !== 'ready')
        return { kind: evidenceSession === 'obsolete' ? 'stale' : 'internal-failure', body: null };

      // Public research is only worth starting while this attempt still owns the current head.
      const beforeResearch = await recheck();
      if (beforeResearch !== 'current') return stopped(beforeResearch);
      const researched = await runResearch({
        packet: assembled.packet,
        trusted: { ...base, context: assembled.packet.context as never },
        npmInventory: npmInventory as never,
        comparison: null,
        fetch: input.publicFetch,
        now: input.now,
        deadline: evidenceDeadline,
        evaluationTime: input.evaluationTime,
      });
      if (researched.kind !== 'ready') return { kind: 'internal-failure', body: null };
      // The model is only called while the attempt is still the owner's.
      const beforeModel = await recheck();
      if (beforeModel !== 'current') return stopped(beforeModel);

      const reviewed = await reviewPacket({
        packet: researched.packet,
        config: trusted.config,
        apiKey: input.llmApiKey,
        evaluatedAt: input.evaluationTime,
        deadlineMs: started + JOB_BUDGET_MS,
        signalAttempts: researched.signalAttempts,
        researchIncomplete: researched.unavailable.length > 0,
        model: input.model,
      });
      return reviewed;
    },
  );
  if (snapshot.kind === 'ready') return snapshot.value;
  if (snapshot.kind === 'invalid-config') return { kind: 'invalid-config', body: null };
  return { kind: state() === 'stale' ? 'stale' : 'internal-failure', body: null };
}
