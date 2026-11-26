import { AsyncLocalStorage } from 'node:async_hooks';
import { isGithubApi, quotaReading, type QuotaReading } from '../evidence/github-quota.js';
import { limit } from '../limits.js';
import type { ResearchObservation, ResearchStage } from '../research.js';
import type { DeepReadonly, PacketChange } from '../schema.js';

export type DemandPhase = ResearchStage | 'pre-research' | 'post-research';
export type DemandUnits = Readonly<Record<string, number>>;
export type DemandRow = {
  requests: number;
  bytes: number;
  maxMs: number;
  statuses: Record<string, number>;
};
/** A stage stop that left demand unserved, so the stage's counts are a floor, not its demand. */
export type Censored = { stage: ResearchStage; reason: string };
/** Per evidence category: members by status, and how often each reason appears among them. */
export type CategoryCoverage = {
  available: number;
  partial: number;
  unavailable: number;
  reasons: Record<string, number>;
};
export type DemandCoverage = Record<string, CategoryCoverage>;
export type DemandReport = {
  totalRequests: number;
  /** Requests whose full URL (including query string) was already requested earlier in this run. */
  repeatedUrlRequests: number;
  /** Key: `${phase} ${host}`. */
  byPhaseHost: Record<string, DemandRow>;
  /** Key: the share a request counts against (see `labelShare`), or `unattributed`. */
  byShare: Record<string, DemandRow>;
  stages: {
    stage: ResearchStage;
    outcome: 'enriched' | 'unavailable';
    reason: string | null;
    /** The reader limit that stopped the stage, when research names one. */
    limit?: string;
    ms: number;
  }[];
  censored: Censored[];
  units: DemandUnits;
  /**
   * Members' evidence states after research, per category. A share that stops single members
   * leaves every stage `enriched`; their `budget` reasons show here instead of in `censored`.
   */
  coverage: DemandCoverage;
  /**
   * Research's GitHub use against its approved ceiling, the quota guard's refusals, and the quota
   * GitHub reported, read by the guard's rules over all of the run's GitHub API responses.
   */
  github: {
    researchRequests: number;
    ceiling: number;
    refusals: number;
    /**
     * The lowest valid core `x-ratelimit-remaining` among the quota counters whose reset is still
     * in the future at the end of the run, by the guard's validity rules (`quotaReading`) and its
     * one estimate per counter (Q1), applied to every live GitHub API response the run made:
     * snapshot, session, and research alike. It is not the guard's estimate, which sees only
     * research responses and subtracts requests started since. Null with no live counter.
     */
    lastRemaining: number | null;
    /** That counter's reset as an ISO time, or null with no live counter. */
    lastReset: string | null;
    /**
     * Each quota counter seen this run, by reset, with its lowest reading, in order of reset. Two
     * counters whose resets differ by more than a few seconds, interleaving in the trace and
     * differing in `used`, are separate GitHub counters; resets a second apart are jitter.
     */
    counters: QuotaCounterReport[];
    /** Valid readings above an earlier reading with the same reset: non-monotonic steps. */
    risesWithinCounter: number;
    /**
     * GitHub API responses carrying `x-ratelimit-remaining` whose reading is not used: another
     * resource, an invalid remaining or reset, or a reset that is past or beyond the quota window.
     * A response without the header is not counted.
     */
    ignoredReadings: number;
    /** Present only when the recorder was built with `trace`; see `QuotaTraceEntry`. */
    trace?: QuotaTraceEntry[];
  };
};

/** One quota counter the run saw: its reset as an ISO time and the lowest remaining it reported. */
export type QuotaCounterReport = { reset: string; lowestRemaining: number };

/**
 * One GitHub API response's rate-limit headers, in the order responses completed. No URL, token,
 * or body: `started` is the request's start order among GitHub API requests, so a response that
 * started earlier but completed later shows as out of order, and `phase` is the phase when the
 * request started. A header value that is not a short lowercase token or digit string is reported
 * as `invalid`.
 */
export type QuotaTraceEntry = {
  started: number;
  phase: DemandPhase;
  status: string;
  resource: string | null;
  limit: string | null;
  remaining: string | null;
  used: string | null;
  reset: string | null;
};

export type DemandRecorderOptions = Readonly<{
  /** Wall time in Unix milliseconds, for judging reset headers; `Date.now` by default. */
  wallNow?: () => number;
  /** Adds `github.trace` to the report. */
  trace?: boolean;
}>;

type Sample = {
  phase: DemandPhase;
  share: string;
  host: string;
  url: string;
  status: string;
  bytes: number;
  ms: number;
};

const shareStore = new AsyncLocalStorage<string>();
const UNATTRIBUTED = 'unattributed';
const CENSORING_REASONS: readonly (string | null)[] = ['budget', 'timeout', 'rate_limit'];
const RESEARCH_PHASES: readonly DemandPhase[] = ['upstream', 'advisories', 'signals'];
const TRACE_VALUE = /^[a-z0-9_]+$/;

function traceValue(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= limit('measureDemand.quotaTraceValueUnits') && TRACE_VALUE.test(value)
    ? value
    : 'invalid';
}

/**
 * Counts every request made through `fetch` against `share`. When labels nest, the outermost one
 * wins: a reader that builds another reader spends its own share.
 */
export function labelShare<F extends (url: string, init: RequestInit) => Promise<Response>>(
  share: string,
  fetch: F,
): F {
  const labeled = (url: string, init: RequestInit) =>
    shareStore.getStore() === undefined
      ? shareStore.run(share, () => fetch(url, init))
      : fetch(url, init);
  return labeled as F;
}

export type ResearchReader =
  | 'upstream'
  | 'advisory'
  | 'malware'
  | 'publishTimes'
  | 'metadata'
  | 'npmRegistry';

/**
 * The evidence allocation share a research reader, created during `phase`, reads against, or null
 * when the reader adds no label: outside signals, the npm registry reader belongs to collection's
 * registry share or to the upstream reader that built it.
 */
export function readerShare(reader: ResearchReader, phase: DemandPhase): string | null {
  switch (reader) {
    case 'upstream':
      return phase === 'signals' ? 'signals.upstream' : 'upstream';
    case 'advisory':
      return 'advisory';
    case 'npmRegistry':
      return phase === 'signals' ? 'signals.registry' : null;
    default:
      return `signals.${reader}`;
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Wraps a research reader factory so the reader it builds reads against `readerShare(reader, phase)`,
 * with the phase taken when the reader is built.
 */
export function labelReader<L, D extends { fetch: FetchLike }, R>(
  reader: ResearchReader,
  factory: (limits: L, deps: D) => R,
  phase: () => DemandPhase,
): (limits: L, deps: D) => R {
  return (limits, deps) => {
    const share = readerShare(reader, phase());
    return factory(
      limits,
      share === null ? deps : { ...deps, fetch: labelShare(share, deps.fetch) },
    );
  };
}

const STATUSES = ['available', 'partial', 'unavailable'] as const;

/**
 * Counts members' evidence states by category. Declaration (`basis`) records are not members and
 * are skipped. A member with several reasons in one category counts once under each.
 */
export function coverageCounts(changes: readonly DeepReadonly<PacketChange>[]): DemandCoverage {
  const coverage: DemandCoverage = {};
  for (const change of changes) {
    if ('basis' in change) continue;
    for (const [category, evidence] of Object.entries(change.evidence)) {
      const row = (coverage[category] ??= {
        available: 0,
        partial: 0,
        unavailable: 0,
        reasons: {},
      });
      const status = STATUSES.find((candidate) => candidate === evidence.status);
      if (status) row[status] += 1;
      for (const reason of new Set(evidence.reasons))
        row.reasons[reason] = (row.reasons[reason] ?? 0) + 1;
    }
  }
  return coverage;
}

function addSample(table: Record<string, DemandRow>, key: string, sample: Sample): void {
  const row = (table[key] ??= { requests: 0, bytes: 0, maxMs: 0, statuses: {} });
  row.requests += 1;
  row.bytes += sample.bytes;
  row.maxMs = Math.max(row.maxMs, sample.ms);
  row.statuses[sample.status] = (row.statuses[sample.status] ?? 0) + 1;
}

export function createDemandRecorder(
  now: () => number,
  options: DemandRecorderOptions = {},
): {
  phase(): DemandPhase;
  observe(observation: ResearchObservation): void;
  wrap(
    fetch: (url: string, init: RequestInit) => Promise<Response>,
  ): (url: string, init: RequestInit) => Promise<Response>;
  report(
    units: DemandUnits,
    quota?: Readonly<{ refusals(): number }>,
    coverage?: DemandCoverage,
  ): DemandReport;
} {
  let phase: DemandPhase = 'pre-research';
  let stageStartedAt = 0;
  const samples: Sample[] = [];
  const stages: DemandReport['stages'] = [];
  const quotaOptions = {
    wallNow: options.wallNow ?? Date.now,
    windowMs: limit('research.githubQuota.windowMs'),
  };
  /** Lowest reading per counter, keyed by reset; counters are kept after they reset. */
  const quotaCounters = new Map<number, number>();
  let risesWithinCounter = 0;
  let ignoredReadings = 0;
  let githubStarted = 0;
  const trace: QuotaTraceEntry[] = [];

  // The guard's counter rule, without its count of requests started, since the recorder only
  // observes: each reset is its own counter, and within a counter only a lower remaining is kept.
  const readQuota = (
    url: string,
    response: Response,
    request: Readonly<{ started: number; phase: DemandPhase }>,
  ) => {
    if (options.trace) {
      const header = (name: string) => traceValue(response.headers.get(name));
      trace.push({
        ...request,
        status: String(response.status),
        resource: header('x-ratelimit-resource'),
        limit: header('x-ratelimit-limit'),
        remaining: header('x-ratelimit-remaining'),
        used: header('x-ratelimit-used'),
        reset: header('x-ratelimit-reset'),
      });
    }
    const reading = quotaReading(url, response, quotaOptions);
    if (!reading) {
      if (response.headers.has('x-ratelimit-remaining')) ignoredReadings += 1;
      return;
    }
    const lowest = quotaCounters.get(reading.reset);
    if (lowest !== undefined && reading.remaining > lowest) risesWithinCounter += 1;
    else quotaCounters.set(reading.reset, reading.remaining);
  };

  /** The lowest reading among counters whose reset is still in the future, with its reset. */
  const lowestLive = (): QuotaReading | null => {
    const now = quotaOptions.wallNow();
    let lowest: QuotaReading | null = null;
    for (const [reset, remaining] of quotaCounters) {
      if (reset <= now) continue;
      if (!lowest || remaining < lowest.remaining) lowest = { remaining, reset };
    }
    return lowest;
  };

  const observe = (observation: ResearchObservation) => {
    if (observation.kind === 'stage-start') {
      phase = observation.stage;
      stageStartedAt = now();
      return;
    }
    stages.push({
      stage: observation.stage,
      outcome: observation.outcome,
      reason: observation.reason,
      ...(observation.limit ? { limit: observation.limit } : {}),
      ms: Math.round(now() - stageStartedAt),
    });
    phase = 'post-research';
  };

  const wrap = (fetch: (url: string, init: RequestInit) => Promise<Response>) => {
    return async (url: string, init: RequestInit): Promise<Response> => {
      const share = shareStore.getStore() ?? UNATTRIBUTED;
      const sampleBase = { phase, share, host: new URL(url).host, url };
      const startedAt = now();
      const githubOrder = isGithubApi(url) ? ++githubStarted : 0;
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        samples.push({ ...sampleBase, status: 'error', bytes: 0, ms: now() - startedAt });
        throw error;
      }
      const ms = now() - startedAt;
      if (githubOrder > 0)
        readQuota(url, response, { started: githubOrder, phase: sampleBase.phase });
      const bytes = (await response.clone().arrayBuffer()).byteLength;
      samples.push({ ...sampleBase, status: String(response.status), bytes, ms });
      return response;
    };
  };

  const report = (
    units: DemandUnits,
    quota?: Readonly<{ refusals(): number }>,
    coverage: DemandCoverage = {},
  ): DemandReport => {
    const byPhaseHost: Record<string, DemandRow> = {};
    const byShare: Record<string, DemandRow> = {};
    const seenUrls = new Set<string>();
    let repeatedUrlRequests = 0;

    for (const sample of samples) {
      if (seenUrls.has(sample.url)) repeatedUrlRequests += 1;
      seenUrls.add(sample.url);
      addSample(byPhaseHost, `${sample.phase} ${sample.host}`, sample);
      addSample(byShare, sample.share, sample);
    }

    for (const row of [...Object.values(byPhaseHost), ...Object.values(byShare)])
      row.maxMs = Math.round(row.maxMs);
    const live = lowestLive();

    return {
      totalRequests: samples.length,
      repeatedUrlRequests,
      byPhaseHost,
      byShare,
      stages: stages.map((stage) => ({ ...stage })),
      censored: stages
        .filter((stage) => CENSORING_REASONS.includes(stage.reason))
        .map(({ stage, reason }) => ({ stage, reason: reason ?? '' })),
      units,
      coverage,
      github: {
        researchRequests: samples.filter(
          (sample) => isGithubApi(sample.url) && RESEARCH_PHASES.includes(sample.phase),
        ).length,
        ceiling: limit('research.githubQuota.researchCeiling'),
        refusals: quota?.refusals() ?? 0,
        lastRemaining: live?.remaining ?? null,
        lastReset: live ? new Date(live.reset).toISOString() : null,
        counters: [...quotaCounters]
          .sort(([a], [b]) => a - b)
          .map(([reset, lowestRemaining]) => ({
            reset: new Date(reset).toISOString(),
            lowestRemaining,
          })),
        risesWithinCounter,
        ignoredReadings,
        ...(options.trace ? { trace: trace.map((entry) => ({ ...entry })) } : {}),
      },
    };
  };

  return { phase: () => phase, observe, wrap, report };
}
