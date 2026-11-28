import { isDeepStrictEqual } from 'node:util';
import { parseReviewConfig, type ConfigResult } from '../config.js';
import { limit } from '../limits.js';
import type { AssessmentState } from '../policy.js';
import { formDecisionUnits, summarizeDecisionCoverage, type UnitInventory } from '../units.js';
import {
  ANALYSIS_LIMITS,
  prepareAnalysisRun,
  prepareRunBatch,
  type PreparationResult,
  type ValidatedAssessment,
} from './contract.js';
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
const MAX_CALLS = limit('analysis.maxCalls');
const MAX_CONCURRENT_CALLS = limit('analysis.maxConcurrentCalls');
const PUBLICATION_RESERVE_MS = limit('analysis.publicationReserveMs');
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
    typeof options !== 'object' ||
    options === null ||
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
  // Analysis gets the job time that remains: the caller's deadline, which already leaves the final
  // freshness allowance, less the publication reserve. No cap from its own start shortens it, so
  // time evidence left unspent goes to analysis; limit:analysis.maxAnalysisMs is the least it gets.
  const deadlineMs = selectedOptions.deadlineMs - PUBLICATION_RESERVE_MS;
  const { records, dispatched, splits, maxSplitDepth, durations } = await scheduleBatches(
    snapshot,
    { ...selectedOptions, deadlineMs },
    analyze,
    now,
    unitIds,
  );
  const order = new Map(unitIds.map((id, index) => [id, index]));
  records.sort((a, b) => order.get(a.unitId)! - order.get(b.unitId)!);
  const stateCounts = { assessed: 0, unavailable: 0, rejected: 0, unattempted: 0 };
  for (const record of records) stateCounts[record.state.state]++;
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
      maxSplitDepth,
      callDurationsMs: durations,
      stateCounts,
      failureCategories: [
        ...new Set(records.flatMap((record) => (record.category ? [record.category] : []))),
      ].sort(),
    },
    analysisUnavailable: records.length > 0 && stateCounts.assessed === 0,
  };
}

type BatchOutcome = MistralResult | 'cancelled' | 'deadline' | 'transport';
type TimedOutcome = Readonly<{ outcome: BatchOutcome; durationMs: number }>;
/** A queued batch and the truncation splits above it; first-level batches are depth 0. */
type QueueEntry = Readonly<{ ids: string[]; depth: number }>;
type WaveEntry = QueueEntry & Readonly<{ batchId: string; pending: Promise<TimedOutcome> }>;
type ScheduleState = {
  queue: QueueEntry[];
  records: UnitRecord[];
  calls: number;
  dispatched: number;
  splits: number;
  maxSplitDepth: number;
  durations: number[];
  run?: ReturnType<typeof prepareAnalysisRun>;
};

async function scheduleBatches(
  snapshot: BatchInput,
  options: MistralOptions,
  analyze: typeof analyzeMistralBatch,
  now: () => number,
  unitIds: string[],
) {
  const state: ScheduleState = {
    queue: [],
    records: [],
    calls: 0,
    dispatched: 0,
    splits: 0,
    maxSplitDepth: 0,
    durations: [],
  };
  for (let index = 0; index < unitIds.length; index += ANALYSIS_LIMITS.maxUnits)
    state.queue.push({ ids: unitIds.slice(index, index + ANALYSIS_LIMITS.maxUnits), depth: 0 });
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
    wave.length < MAX_CONCURRENT_CALLS &&
    state.queue.length &&
    state.calls < MAX_CALLS &&
    now() < options.deadlineMs &&
    !options.signal?.aborted
  ) {
    const entry = state.queue.shift()!;
    const { ids, depth } = entry;
    const prepared = prepareBatch(state, snapshot, ids);
    if (prepared.kind !== 'prepared') {
      if (prepared.category === 'budget' && ids.length > 1 && !prepared.runWide) {
        state.queue.unshift(...splitAt(ids, depth));
      } else {
        state.records.push(...unresolved(ids, 'unavailable', false, prepared.category, null));
        if (prepared.category !== 'budget') return { wave, preparationFailure: prepared.category };
      }
      continue;
    }
    if (now() >= options.deadlineMs || options.signal?.aborted) {
      state.queue.unshift(entry);
      break;
    }
    state.calls++;
    wave.push({
      ids,
      depth,
      batchId: prepared.batch.batchId,
      pending: timedCall(prepared.batch, options, analyze, now),
    });
  }
  return { wave, preparationFailure: undefined };
}

// Run-wide checks happen on first use, so expired or empty work never reports a preparation failure.
function prepareBatch(
  state: ScheduleState,
  snapshot: BatchInput,
  ids: string[],
): PreparationResult & { runWide?: true } {
  const { inventory, config, evaluatedAt } = snapshot;
  state.run ??= prepareAnalysisRun({ inventory, config, evaluatedAt, limits: ANALYSIS_LIMITS });
  return state.run.kind === 'ready'
    ? prepareRunBatch(state.run.run, ids)
    : { ...state.run, runWide: true };
}

async function collectWave(state: ScheduleState, wave: WaveEntry[]) {
  const timed = await Promise.all(wave.map((item) => item.pending));
  const children: QueueEntry[] = [];
  for (let index = 0; index < wave.length; index++) {
    const { ids, depth, batchId } = wave[index];
    const { outcome: result, durationMs } = timed[index];
    // Durations follow wave order, never completion order, and cover exactly the dispatched calls.
    if (typeof result === 'string' || result.kind === 'validated' || result.attempted) {
      state.dispatched++;
      state.durations.push(durationMs);
    }
    if (typeof result === 'string') {
      state.records.push(...unresolved(ids, 'unavailable', true, result, batchId));
    } else if (isSplittable(result, ids, batchId)) {
      state.splits++;
      state.maxSplitDepth = Math.max(state.maxSplitDepth, depth + 1);
      children.push(...splitAt(ids, depth + 1));
    } else state.records.push(...mapResult(ids, batchId, result));
  }
  state.queue.unshift(...children);
}

function isBound(result: MistralResult, ids: readonly string[], batchId: string) {
  return (
    'batchId' in result &&
    result.batchId === batchId &&
    'unitIds' in result &&
    isDeepStrictEqual(result.unitIds, ids)
  );
}

function isSplittable(result: MistralResult, ids: string[], batchId: string) {
  return (
    result.kind === 'truncated' &&
    result.category === 'length' &&
    ids.length > 1 &&
    isBound(result, ids, batchId)
  );
}

function splitUnits(ids: string[]): [string[], string[]] {
  const midpoint = Math.floor(ids.length / 2);
  return [ids.slice(0, midpoint), ids.slice(midpoint)];
}

/** Splits a batch at the children's depth: a re-pack keeps its depth, a truncation adds one. */
function splitAt(ids: string[], depth: number): QueueEntry[] {
  return splitUnits(ids).map((child) => ({ ids: child, depth }));
}

function finishQueue(
  state: ScheduleState,
  preparationFailure: string | undefined,
  options: MistralOptions,
  now: () => number,
) {
  const category =
    preparationFailure ??
    (options.signal?.aborted
      ? 'cancelled'
      : now() >= options.deadlineMs
        ? 'deadline'
        : 'call_budget');
  const status = preparationFailure ? 'unavailable' : 'unattempted';
  for (const { ids } of state.queue)
    state.records.push(...unresolved(ids, status, false, category, null));
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
  const attempted = result.kind === 'validated' || result.attempted;
  if (!isBound(result, ids, batchId))
    return unresolved(ids, 'rejected', attempted, 'reference', batchId);
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
  const state =
    attempted && ['envelope', 'json', 'schema', 'reference', 'policy'].includes(category)
      ? 'rejected'
      : !attempted && ['cancelled', 'deadline'].includes(category)
        ? 'unattempted'
        : 'unavailable';
  return unresolved(ids, state, attempted, category, batchId);
}

/** Times one call on the injected monotonic clock, from just before M1 is invoked to settlement. */
async function timedCall(
  batch: Parameters<typeof analyzeMistralBatch>[0],
  options: MistralOptions,
  analyze: typeof analyzeMistralBatch,
  now: () => number,
): Promise<TimedOutcome> {
  const startedAt = now();
  const outcome = await boundedCall(batch, options, analyze, now);
  // Only an injected clock can turn non-finite mid-run; the field stays a non-negative integer.
  const elapsed = Math.trunc(now() - startedAt);
  return { outcome, durationMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0 };
}

async function boundedCall(
  batch: Parameters<typeof analyzeMistralBatch>[0],
  options: MistralOptions,
  analyze: typeof analyzeMistralBatch,
  now: () => number,
): Promise<BatchOutcome> {
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
    // A late result is ignored unless it reports that no request was sent.
    if (
      typeof result !== 'string' &&
      (result.kind === 'validated' || result.attempted) &&
      now() >= options.deadlineMs
    )
      return 'deadline';
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
