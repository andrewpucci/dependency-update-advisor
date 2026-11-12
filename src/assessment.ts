import { analyzeDecisionUnits, type UnitRecord } from './analysis/batches.js';
import { analyzeMistralBatch } from './analysis/mistral.js';
import type { ConfigResult } from './config.js';
import type { SignalAttempt } from './evidence/policy-signals.js';
import type { PacketGap } from './packet.js';
import { modelUnavailableReason, type ModelUnavailableReason } from './review.js';
import { renderDecisionBrief } from './reporting.js';
import type { PacketResult } from './schema.js';
import { formDecisionUnits, type DecisionCoverage } from './units.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
export type AssessmentResult =
  | Readonly<{
      kind: 'complete' | 'incomplete-evidence';
      records: readonly UnitRecord[];
      coverage: DecisionCoverage;
    }>
  | Readonly<{ kind: 'model-unavailable'; reason: ModelUnavailableReason }>
  | Readonly<{ kind: 'internal-failure' }>;
export type AssessmentInput = Readonly<{
  packet: Packet;
  config: ConfigResult;
  apiKey: string | null;
  evaluatedAt: number;
  deadlineMs: number;
  signal?: AbortSignal;
  /** Replaces the model transport and clock; defaults to the platform fetch and monotonic clock. */
  model?: Readonly<{ now: () => number; analyze: typeof analyzeMistralBatch }>;
}>;

/**
 * Required evidence is complete only when nothing is unresolved and no inventory or per-unit gap
 * remains. This is the same condition the review body states, so the two cannot disagree.
 */
function evidenceComplete(coverage: DecisionCoverage): boolean {
  return (
    coverage.outcome.kind !== 'decision_incomplete' &&
    coverage.counts.unresolvedUnits === 0 &&
    coverage.inventoryGaps.length === 0 &&
    !coverage.policyProvenance.assessments.units.some((unit) => unit.gaps.length > 0)
  );
}

/** Uses the established M2 batching contract; no raw model data crosses this boundary. */
export async function assessReviewPacket(input: AssessmentInput): Promise<AssessmentResult> {
  if (!input.config.ok) return { kind: 'internal-failure' };
  if (!input.apiKey) return { kind: 'model-unavailable', reason: 'no-key' };
  try {
    const model = input.model;
    const result = await analyzeDecisionUnits(
      {
        inventory: formDecisionUnits(input.packet),
        config: input.config,
        evaluatedAt: input.evaluatedAt,
      },
      { apiKey: input.apiKey, deadlineMs: input.deadlineMs, signal: input.signal },
      model ? { now: model.now, analyze: model.analyze } : {},
    );
    if (!result.ok) return { kind: 'internal-failure' };
    if (result.analysisUnavailable) {
      // Analysis is unavailable only when no unit was assessed, so every record is unresolved and
      // carries a category. Records are in inventory order; the first unit names the reason.
      return {
        kind: 'model-unavailable',
        reason: modelUnavailableReason(result.records[0]?.category),
      };
    }
    const kind = evidenceComplete(result.coverage) ? 'complete' : 'incomplete-evidence';
    return { kind, records: result.records, coverage: result.coverage };
  } catch {
    return { kind: 'internal-failure' };
  }
}

export type ReviewResult = Readonly<{
  /** A comment-ready body, present only when the renderer accepted a valid assessment. */
  body: string | null;
  /** Set when the brief was too large to render, which is a limit, not a defect. */
  gaps?: readonly PacketGap[];
}> &
  (
    | Readonly<{ kind: 'complete' | 'incomplete-evidence' | 'internal-failure'; reason?: never }>
    /** Why no model verdict exists; every `model-unavailable` result states one. */
    | Readonly<{ kind: 'model-unavailable'; reason: ModelUnavailableReason }>
  );
export type ReviewInput = AssessmentInput &
  Readonly<{
    signalAttempts: readonly SignalAttempt[];
    /** True when a research stage could not be established; success is then impossible. */
    researchIncomplete?: boolean;
  }>;

/**
 * Assesses the packet and renders its review body. The renderer runs only for a valid assessment;
 * a renderer failure becomes an internal failure with no body, so the prior comment is preserved.
 */
export async function reviewPacket(input: ReviewInput): Promise<ReviewResult> {
  const assessed = await assessReviewPacket(input);
  if (assessed.kind === 'model-unavailable')
    return { kind: 'model-unavailable', reason: assessed.reason, body: null };
  if (!('coverage' in assessed)) return { kind: 'internal-failure', body: null };
  try {
    const rendered = renderDecisionBrief({
      binding: input.packet.binding,
      signalBinding: input.packet.binding,
      generatedAt: new Date(input.evaluatedAt).toISOString(),
      coverage: assessed.coverage,
      records: assessed.records,
      analysisUnavailable: false,
      signalAttempts: input.signalAttempts,
    } as never);
    if (!rendered.ok)
      return rendered.category === 'size'
        ? { kind: 'internal-failure', body: null, gaps: [{ source: 'brief', reason: 'budget' }] }
        : { kind: 'internal-failure', body: null };
    return {
      kind: input.researchIncomplete ? 'incomplete-evidence' : assessed.kind,
      body: rendered.body,
    };
  } catch {
    return { kind: 'internal-failure', body: null };
  }
}
