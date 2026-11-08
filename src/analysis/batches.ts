import { isDeepStrictEqual } from 'node:util';
import { parseReviewConfig, type ConfigResult } from '../config.js';
import type { AssessmentState } from '../policy.js';
import { formDecisionUnits, summarizeDecisionCoverage, type UnitInventory } from '../units.js';
import { ANALYSIS_LIMITS, prepareAnalysisBatch, type ValidatedAssessment } from './contract.js';
import { analyzeMistralBatch, type MistralOptions, type MistralResult } from './mistral.js';
import { snapshotData } from './projection.js';

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
  const now = dependencies.now ?? (() => performance.now());
  const analyze = dependencies.analyze ?? analyzeMistralBatch;
  const start = now();
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(options.deadlineMs) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    return { ok: false as const, category: 'configuration' as const };
  const selectedOptions = {
    apiKey: options.apiKey,
    deadlineMs: options.deadlineMs,
    signal: options.signal,
  };
  let snapshot: BatchInput;
  try {
    snapshot = snapshotData(input) as BatchInput;
    if (
      !Number.isSafeInteger(snapshot.evaluatedAt) ||
      !isDeepStrictEqual(formDecisionUnits(snapshot.inventory.packet), snapshot.inventory)
    )
      return { ok: false as const, category: 'input' as const };
  } catch {
    return { ok: false as const, category: 'input' as const };
  }
  const parsedConfig = snapshot.config.ok
    ? parseReviewConfig(JSON.stringify(snapshot.config.config))
    : snapshot.config;
  const model =
    parsedConfig.ok &&
    snapshot.config.ok &&
    isDeepStrictEqual(parsedConfig.config, snapshot.config.config)
      ? (parsedConfig.config.analysis?.model ?? null)
      : null;
  const unitIds = snapshot.inventory.units.map((unit) => unit.id);
  const deadlineMs = Math.min(selectedOptions.deadlineMs - 60_000, start + 600_000);
  const { records, dispatched, splits } = await scheduleBatches(
    snapshot,
    { ...selectedOptions, deadlineMs },
    analyze,
    now,
    unitIds,
  );
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
    diagnostics: {
      provider: 'mistral' as const,
      model,
      headSha: snapshot.inventory.packet.binding.headSha,
      unitCount: unitIds.length,
      memberCount: snapshot.inventory.packet.changes.length,
      callsDispatched: dispatched,
      truncationSplits: splits,
      stateCounts: {
        assessed: records.filter((record) => record.state.state === 'assessed').length,
        unavailable: records.filter((record) => record.state.state === 'unavailable').length,
        rejected: records.filter((record) => record.state.state === 'rejected').length,
        unattempted: records.filter((record) => record.state.state === 'unattempted').length,
      },
      failureCategories: [
        ...new Set(records.flatMap((record) => (record.category ? [record.category] : []))),
      ].sort(),
    },
    analysisUnavailable:
      records.length > 0 && records.every((record) => record.state.state !== 'assessed'),
  };
}

type BatchOutcome = MistralResult | 'cancelled' | 'deadline' | 'transport';
type WaveEntry = Readonly<{ ids: string[]; batchId: string; pending: Promise<BatchOutcome> }>;
type ScheduleState = {
  queue: string[][];
  records: UnitRecord[];
  calls: number;
  dispatched: number;
  splits: number;
};

async function scheduleBatches(
  snapshot: BatchInput,
  options: MistralOptions,
  analyze: typeof analyzeMistralBatch,
  now: () => number,
  unitIds: string[],
) {
  const state: ScheduleState = { queue: [], records: [], calls: 0, dispatched: 0, splits: 0 };
  for (let index = 0; index < unitIds.length; index += ANALYSIS_LIMITS.maxUnits)
    state.queue.push(unitIds.slice(index, index + ANALYSIS_LIMITS.maxUnits));
  while (state.queue.length) {
    const { wave, preparationFailure } = prepareWave(state, snapshot, options, analyze, now);
    await collectWave(state, wave);
    if (preparationFailure || !wave.length) {
      finishQueue(state, preparationFailure, options, now);
      break;
    }
  }
  return state;
}

function prepareWave(
  state: ScheduleState,
  snapshot: BatchInput,
  options: MistralOptions,
  analyze: typeof analyzeMistralBatch,
  now: () => number,
) {
  const wave: WaveEntry[] = [];
  while (
    wave.length < 2 &&
    state.queue.length &&
    state.calls < 32 &&
    now() < options.deadlineMs &&
    !options.signal?.aborted
  ) {
    const ids = state.queue.shift()!;
    const prepared = prepareAnalysisBatch({ ...snapshot, unitIds: ids, limits: ANALYSIS_LIMITS });
    if (prepared.kind !== 'prepared') {
      if (prepared.category === 'budget' && ids.length > 1) {
        state.queue.unshift(...splitUnits(ids));
      } else {
        state.records.push(...unresolved(ids, 'unavailable', false, prepared.category, null));
        if (prepared.category !== 'budget') return { wave, preparationFailure: prepared.category };
      }
      continue;
    }
    if (now() >= options.deadlineMs || options.signal?.aborted) {
      state.queue.unshift(ids);
      break;
    }
    state.calls++;
    wave.push({
      ids,
      batchId: prepared.batch.batchId,
      pending: boundedCall(prepared.batch, options, analyze, now),
    });
  }
  return { wave, preparationFailure: undefined };
}

async function collectWave(state: ScheduleState, wave: WaveEntry[]) {
  const results = await Promise.all(wave.map((item) => item.pending));
  const children: string[][] = [];
  for (let index = 0; index < wave.length; index++) {
    const { ids, batchId } = wave[index];
    const result = results[index];
    if (typeof result !== 'string' && (result.kind === 'validated' || result.attempted))
      state.dispatched++;
    if (typeof result === 'string') {
      state.dispatched++;
      state.records.push(...unresolved(ids, 'unavailable', true, result, batchId));
    } else if (isSplittable(result, ids, batchId)) {
      state.splits++;
      children.push(...splitUnits(ids));
    } else state.records.push(...mapResult(ids, batchId, result));
  }
  state.queue.unshift(...children);
}

function isSplittable(result: MistralResult, ids: string[], batchId: string) {
  return (
    result.kind === 'truncated' &&
    result.category === 'length' &&
    ids.length > 1 &&
    result.batchId === batchId &&
    JSON.stringify(result.unitIds) === JSON.stringify(ids)
  );
}

function splitUnits(ids: string[]): [string[], string[]] {
  const midpoint = Math.floor(ids.length / 2);
  return [ids.slice(0, midpoint), ids.slice(midpoint)];
}

function finishQueue(
  state: ScheduleState,
  preparationFailure: string | undefined,
  options: MistralOptions,
  now: () => number,
) {
  const category =
    preparationFailure ??
    (options.signal?.aborted ? 'cancelled' : now() >= options.deadlineMs ? 'deadline' : 'budget');
  const status = preparationFailure ? 'unavailable' : 'unattempted';
  for (const remaining of state.queue)
    state.records.push(...unresolved(remaining, status, false, category, null));
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

async function boundedCall(
  batch: Parameters<typeof analyzeMistralBatch>[0],
  options: MistralOptions,
  analyze: typeof analyzeMistralBatch,
  now: () => number,
): Promise<MistralResult | 'cancelled' | 'deadline' | 'transport'> {
  const controller = new AbortController();
  let stop: (reason: 'cancelled' | 'deadline') => void = () => {};
  const stopped = new Promise<'cancelled' | 'deadline'>((resolve) => {
    stop = (reason) => {
      resolve(reason);
      controller.abort();
    };
  });
  const cancel = () => stop('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('deadline'), Math.max(0, options.deadlineMs - now()));
  try {
    if (options.signal?.aborted) return 'cancelled';
    let pending: Promise<MistralResult | 'transport'>;
    try {
      pending = Promise.resolve(analyze(batch, { ...options, signal: controller.signal })).catch(
        () => 'transport' as const,
      );
    } catch {
      return 'transport';
    }
    const result = await Promise.race([pending, stopped]);
    if (typeof result !== 'string' && now() >= options.deadlineMs) return 'deadline';
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
