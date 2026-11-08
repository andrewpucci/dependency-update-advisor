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
  if (unitIds.length > ANALYSIS_LIMITS.maxUnits)
    return { ok: false as const, category: 'input' as const };
  let records: UnitRecord[] = [];
  if (unitIds.length) {
    const prepared = prepareAnalysisBatch({ ...snapshot, unitIds, limits: ANALYSIS_LIMITS });
    if (prepared.kind !== 'prepared') {
      records = unresolved(unitIds, 'unavailable', false, prepared.category, null);
    } else {
      const result: MistralResult = await analyze(prepared.batch, {
        ...options,
        deadlineMs: Math.min(options.deadlineMs - 60_000, now() + 600_000),
      });
      const bound =
        'batchId' in result &&
        result.batchId === prepared.batch.batchId &&
        'unitIds' in result &&
        JSON.stringify(result.unitIds) === JSON.stringify(unitIds);
      if (!bound)
        records = unresolved(unitIds, 'rejected', true, 'reference', prepared.batch.batchId);
      else if (
        result.kind === 'validated' &&
        result.assessments.length === unitIds.length &&
        result.assessments.every((assessment, index) => assessment.unitId === unitIds[index])
      ) {
        records = result.assessments.map((assessment) => ({
          unitId: assessment.unitId,
          state: { state: 'assessed', verdict: assessment.verdict },
          attempted: true,
          category: null,
          batchId: prepared.batch.batchId,
          assessment,
        }));
      } else {
        const category = result.kind === 'validated' ? 'reference' : result.category;
        const attempted = result.kind === 'validated' ? true : result.attempted;
        const state =
          attempted && ['envelope', 'json', 'schema', 'reference', 'policy'].includes(category)
            ? 'rejected'
            : !attempted && ['cancelled', 'deadline'].includes(category)
              ? 'unattempted'
              : 'unavailable';
        records = unresolved(unitIds, state, attempted, category, prepared.batch.batchId);
      }
    }
  }
  const states = Object.fromEntries(records.map((record) => [record.unitId, record.state]));
  const coverage = summarizeDecisionCoverage(
    snapshot.inventory,
    snapshot.config,
    snapshot.evaluatedAt,
    states,
  );
  if (!coverage.ok) return { ok: false as const, category: 'configuration' as const };
  return {
    ok: true as const,
    records,
    coverage,
    analysisUnavailable:
      records.length > 0 && records.every((record) => record.state.state !== 'assessed'),
  };
}

function unresolved(
  unitIds: readonly string[],
  state: 'unavailable' | 'unattempted' | 'rejected',
  attempted: boolean,
  category: string,
  batchId: string | null,
): UnitRecord[] {
  return unitIds.map((unitId) => ({
    unitId,
    state: {
      state,
      reason: 'Analysis did not produce a validated assessment.',
      nextAction: 'Re-run dependency analysis.',
      coverageLimits: ['Model assessment unavailable.'],
    },
    attempted,
    category,
    batchId,
    assessment: null,
  }));
}
