import type { ConfigResult } from '../config.js';
import type { AssessmentState } from '../policy.js';
import { summarizeDecisionCoverage, type UnitInventory } from '../units.js';
import { ANALYSIS_LIMITS, prepareAnalysisBatch, type ValidatedAssessment } from './contract.js';
import { analyzeMistralBatch, type MistralOptions, type MistralResult } from './mistral.js';

export type BatchInput = Readonly<{
  inventory: UnitInventory;
  config: ConfigResult;
  evaluatedAt: number;
}>;
export type UnitRecord = Readonly<{
  unitId: string;
  state: AssessmentState;
  attempted: boolean;
  category: string | null;
  batchId: string | null;
  assessment: ValidatedAssessment | null;
}>;
type Dependencies = Readonly<{
  now: () => number;
  analyze: typeof analyzeMistralBatch;
}>;

/** Analyze an immutable inventory; deadlineMs is in the monotonic clock domain. */
export async function analyzeDecisionUnits(
  input: BatchInput,
  options: MistralOptions,
  dependencies: Partial<Dependencies> = {},
) {
  const snapshot = structuredClone(input);
  const now = dependencies.now ?? (() => performance.now());
  const analyze = dependencies.analyze ?? analyzeMistralBatch;
  const unitIds = snapshot.inventory.units.map((unit) => unit.id);
  if (!unitIds.length || unitIds.length > ANALYSIS_LIMITS.maxUnits)
    return { ok: false as const, category: 'input' as const };
  const prepared = prepareAnalysisBatch({ ...snapshot, unitIds, limits: ANALYSIS_LIMITS });
  if (prepared.kind !== 'prepared') return { ok: false as const, category: prepared.category };
  const result: MistralResult = await analyze(prepared.batch, {
    ...options,
    deadlineMs: Math.min(options.deadlineMs - 60_000, now() + 600_000),
  });
  if (
    result.kind !== 'validated' ||
    result.batchId !== prepared.batch.batchId ||
    JSON.stringify(result.unitIds) !== JSON.stringify(unitIds) ||
    result.assessments.length !== unitIds.length ||
    result.assessments.some((assessment, index) => assessment.unitId !== unitIds[index])
  )
    return { ok: false as const, category: 'reference' as const };
  const records: UnitRecord[] = result.assessments.map((assessment) => ({
    unitId: assessment.unitId,
    state: { state: 'assessed', verdict: assessment.verdict },
    attempted: true,
    category: null,
    batchId: prepared.batch.batchId,
    assessment,
  }));
  const states = Object.fromEntries(records.map((record) => [record.unitId, record.state]));
  const coverage = summarizeDecisionCoverage(
    snapshot.inventory,
    snapshot.config,
    snapshot.evaluatedAt,
    states,
  );
  if (!coverage.ok) return { ok: false as const, category: 'configuration' as const };
  return { ok: true as const, records, coverage };
}
