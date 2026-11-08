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
  const deadlineMs = Math.min(options.deadlineMs - 60_000, now() + 600_000);
  const queue: string[][] = [];
  for (let index = 0; index < unitIds.length; index += ANALYSIS_LIMITS.maxUnits)
    queue.push(unitIds.slice(index, index + ANALYSIS_LIMITS.maxUnits));
  const records: UnitRecord[] = [];
  let calls = 0;
  while (queue.length) {
    const wave: Array<{ ids: string[]; batchId: string; pending: Promise<MistralResult> }> = [];
    let preparationFailure: string | undefined;
    while (
      wave.length < 2 &&
      queue.length &&
      calls < 32 &&
      now() < deadlineMs &&
      !options.signal?.aborted
    ) {
      const ids = queue.shift()!;
      const prepared = prepareAnalysisBatch({ ...snapshot, unitIds: ids, limits: ANALYSIS_LIMITS });
      if (prepared.kind !== 'prepared') {
        if (prepared.category === 'budget' && ids.length > 1) {
          const midpoint = Math.floor(ids.length / 2);
          queue.unshift(ids.slice(0, midpoint), ids.slice(midpoint));
        } else {
          records.push(...unresolved(ids, 'unavailable', false, prepared.category, null));
          if (prepared.category !== 'budget') {
            preparationFailure = prepared.category;
            break;
          }
        }
        continue;
      }
      if (now() >= deadlineMs || options.signal?.aborted) {
        queue.unshift(ids);
        break;
      }
      calls++;
      wave.push({
        ids,
        batchId: prepared.batch.batchId,
        pending: analyze(prepared.batch, { ...options, deadlineMs }),
      });
    }
    const results = await Promise.all(wave.map((item) => item.pending));
    for (let index = 0; index < wave.length; index++)
      records.push(...mapResult(wave[index].ids, wave[index].batchId, results[index]));
    if (preparationFailure || !wave.length) {
      const category =
        preparationFailure ??
        (options.signal?.aborted ? 'cancelled' : now() >= deadlineMs ? 'deadline' : 'budget');
      const state = preparationFailure ? 'unavailable' : 'unattempted';
      for (const remaining of queue)
        records.push(...unresolved(remaining, state, false, category, null));
      break;
    }
  }
  records.sort((a, b) => unitIds.indexOf(a.unitId) - unitIds.indexOf(b.unitId));
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

function mapResult(ids: readonly string[], batchId: string, result: MistralResult): UnitRecord[] {
  const bound =
    'batchId' in result &&
    result.batchId === batchId &&
    'unitIds' in result &&
    JSON.stringify(result.unitIds) === JSON.stringify(ids);
  if (!bound) return unresolved(ids, 'rejected', true, 'reference', batchId);
  if (
    result.kind === 'validated' &&
    result.assessments.length === ids.length &&
    result.assessments.every((assessment, index) => assessment.unitId === ids[index])
  )
    return result.assessments.map((assessment) => ({
      unitId: assessment.unitId,
      state: { state: 'assessed', verdict: assessment.verdict },
      attempted: true,
      category: null,
      batchId,
      assessment,
    }));
  const category = result.kind === 'validated' ? 'reference' : result.category;
  const attempted = result.kind === 'validated' ? true : result.attempted;
  const state =
    attempted && ['envelope', 'json', 'schema', 'reference', 'policy'].includes(category)
      ? 'rejected'
      : !attempted && ['cancelled', 'deadline'].includes(category)
        ? 'unattempted'
        : 'unavailable';
  return unresolved(ids, state, attempted, category, batchId);
}
