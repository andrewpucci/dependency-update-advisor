import { analyzeDecisionUnits, type UnitRecord } from './analysis/batches.js';
import type { ConfigResult } from './config.js';
import type { PacketResult } from './schema.js';
import { formDecisionUnits } from './units.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
export type AssessmentResult =
  | Readonly<{ kind: 'complete'; records: readonly UnitRecord[]; analysisUnavailable: false }>
  | Readonly<{ kind: 'incomplete-evidence' | 'model-unavailable' | 'internal-failure' }>;
export type AssessmentInput = Readonly<{
  packet: Packet;
  config: ConfigResult;
  apiKey: string | null;
  evaluatedAt: number;
  deadlineMs: number;
  signal?: AbortSignal;
}>;

/** Uses the established M2 batching contract; no raw model data crosses this boundary. */
export async function assessReviewPacket(input: AssessmentInput): Promise<AssessmentResult> {
  if (!input.config.ok) return { kind: 'internal-failure' };
  if (!input.apiKey) return { kind: 'model-unavailable' };
  try {
    const result = await analyzeDecisionUnits(
      {
        inventory: formDecisionUnits(input.packet),
        config: input.config,
        evaluatedAt: input.evaluatedAt,
      },
      { apiKey: input.apiKey, deadlineMs: input.deadlineMs, signal: input.signal },
    );
    if (!result.ok) return { kind: 'internal-failure' };
    if (result.analysisUnavailable) return { kind: 'model-unavailable' };
    if (result.coverage.outcome.kind === 'decision_incomplete')
      return { kind: 'incomplete-evidence' };
    return { kind: 'complete', records: result.records, analysisUnavailable: false };
  } catch {
    return { kind: 'internal-failure' };
  }
}
