import { DECIMAL_RADIX } from './format.js';
import { limit } from './limits.js';

/** The runner's wall-clock limit for the job, mirroring the workflow's `timeout-minutes`. */
export const JOB_BUDGET_MS = limit('job.budget');
/**
 * Time the runner spends before `runStartup` takes its job start: the app-token step, action
 * download, Node load, and self-check. It is an allowance, not a measurement.
 */
export const PRE_STARTUP_ALLOWANCE_MS = limit('job.preStartupAllowance');
/**
 * The job window measured from the startup job start. The freshness reads and the analysis
 * deadline read this, never `JOB_BUDGET_MS` directly; analysis and publication reserve their own
 * time inside it.
 */
export const JOB_WINDOW_MS = limit('job.window');
/**
 * Reserved at the end of the job window for the final freshness re-verification: three sequential
 * reads (run, pull request, comparison) at the request timeout. Analysis must end before it.
 */
export const FRESHNESS_ALLOWANCE_MS = limit('job.freshnessAllowance');

/** Bounds for all pre-analysis evidence reads. Time is shared; every reader gets what remains. */
export const EVIDENCE_READ_ENVELOPE = Object.freeze({
  maxRequests: limit('evidence.envelope.maxRequests'),
  maxResponseBytes: limit('evidence.envelope.maxResponseBytes'),
  maxTotalBytes: limit('evidence.envelope.maxTotalBytes'),
  requestTimeoutMs: limit('evidence.envelope.requestTimeoutMs'),
  totalTimeoutMs: limit('evidence.envelope.totalTimeoutMs'),
});

/**
 * How the envelope is divided between readers. A larger pull request exhausts a share and ends
 * incomplete with a `budget` reason; no reader borrows from another.
 */
export const EVIDENCE_READ_ALLOCATION = Object.freeze({
  // The snapshot covers C1's 128 excerpt files with their directories; freshness reads are
  // reserved separately so a heavy snapshot can never starve the checks that keep a result valid.
  transport: Object.freeze({
    maxRequests: limit('evidence.allocation.transport.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.transport.maxTotalBytes'),
    snapshot: Object.freeze({
      maxRequests: limit('evidence.allocation.transport.snapshot.maxRequests'),
      maxTotalBytes: limit('evidence.allocation.transport.snapshot.maxTotalBytes'),
    }),
    freshness: Object.freeze({
      maxRequests: limit('evidence.allocation.transport.freshness.maxRequests'),
      maxTotalBytes: limit('evidence.allocation.transport.freshness.maxTotalBytes'),
    }),
  }),
  session: Object.freeze({
    maxRequests: limit('evidence.allocation.session.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.session.maxTotalBytes'),
  }),
  registry: Object.freeze({
    maxRequests: limit('evidence.allocation.registry.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.registry.maxTotalBytes'),
  }),
  // Research reads scale with the group: measured at about 7 upstream (5 GitHub plus 2 registry),
  // 2 advisory, and 1 each malware and publish-time request per extra npm package, so these cover
  // a group of 32 npm packages. pip and Actions malware lookups take at least 2 requests (stored-name
  // discovery, then the versioned query) and Actions reviewed lookups 3 per update, so the malware
  // share covers about 20 such packages and the advisory share about 26 Actions updates; S1's
  // Package Name Form Amendment states this limit.
  upstream: Object.freeze({
    maxRequests: limit('evidence.allocation.upstream.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.upstream.maxTotalBytes'),
  }),
  advisory: Object.freeze({
    maxRequests: limit('evidence.allocation.advisory.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.advisory.maxTotalBytes'),
  }),
  signals: Object.freeze({
    maxRequests: limit('evidence.allocation.signals.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.signals.maxTotalBytes'),
    readers: Object.freeze({
      malware: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.malware.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.malware.maxTotalBytes'),
      }),
      publishTimes: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.publishTimes.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.publishTimes.maxTotalBytes'),
      }),
      registry: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.registry.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.registry.maxTotalBytes'),
      }),
      metadata: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.metadata.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.metadata.maxTotalBytes'),
      }),
      upstream: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.upstream.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.upstream.maxTotalBytes'),
      }),
    }),
  }),
});

/**
 * Bounds for the run-scoped research cache. An entry is at most one response, and the cache never
 * holds more than the registry and research shares that fill it can fetch.
 */
export const RESEARCH_CACHE_LIMITS = Object.freeze({
  maxEntryBytes: limit('research.cache.maxEntryBytes'),
  maxTotalBytes: limit('research.cache.maxTotalBytes'),
});

const SIGNAL_READERS = ['malware', 'publishTimes', 'registry', 'metadata', 'upstream'] as const;
type SignalReader = (typeof SIGNAL_READERS)[number];
const ROLE_UNITS = ['direct', 'transitive', 'added', 'removed'] as const;
type RoleUnit = (typeof ROLE_UNITS)[number];

/** Member counts a share scales with, taken only from the packet's resolved changes. */
export type ResearchShareUnits = Readonly<
  Record<RoleUnit, number> & { eligible: Readonly<Record<SignalReader, number>> }
>;
type ShareDimensionParameters = Readonly<{
  base: number;
  ceiling: number;
  rates: Readonly<Partial<Record<RoleUnit | 'eligible', number>>>;
}>;
type ShareParameters = Readonly<{
  requests: ShareDimensionParameters;
  bytes: ShareDimensionParameters;
}>;
export type ResearchShareParameters = Readonly<{
  upstream: ShareParameters;
  advisory: ShareParameters;
  signals: Readonly<Record<SignalReader, ShareParameters>>;
}>;
export type ResearchShare = Readonly<{ maxRequests: number; maxTotalBytes: number }>;
export type ResearchShares = Readonly<{
  upstream: ResearchShare;
  advisory: ResearchShare;
  signals: ResearchShare & { readers: Readonly<Record<SignalReader, ResearchShare>> };
}>;

type ScaledShare = 'upstream' | 'advisory' | `signals.${SignalReader}`;

function dimensionParameters(
  share: ScaledShare,
  dimension: 'requests' | 'bytes',
  ceiling: number,
): ShareDimensionParameters {
  const units = share.startsWith('signals.') ? [...ROLE_UNITS, 'eligible' as const] : ROLE_UNITS;
  return {
    base: limit(`research.share.${share}.${dimension}.base`),
    ceiling,
    rates: Object.fromEntries(
      units.map((unit) => [unit, limit(`research.share.${share}.${dimension}.rate.${unit}`)]),
    ),
  };
}

function shareParameters(share: ScaledShare, ceiling: ResearchShare): ShareParameters {
  return {
    requests: dimensionParameters(share, 'requests', ceiling.maxRequests),
    bytes: dimensionParameters(share, 'bytes', ceiling.maxTotalBytes),
  };
}

/** The register's scaled-share parameters; the allocation entries are the ceilings. */
export const RESEARCH_SHARE_PARAMETERS: ResearchShareParameters = Object.freeze({
  upstream: shareParameters('upstream', EVIDENCE_READ_ALLOCATION.upstream),
  advisory: shareParameters('advisory', EVIDENCE_READ_ALLOCATION.advisory),
  signals: Object.freeze(
    Object.fromEntries(
      SIGNAL_READERS.map((reader) => [
        reader,
        shareParameters(`signals.${reader}`, EVIDENCE_READ_ALLOCATION.signals.readers[reader]),
      ]),
    ) as Record<SignalReader, ShareParameters>,
  ),
});

type ChangeFacts = Readonly<{
  ecosystem: string;
  role: string;
  kind: string;
  basis?: unknown;
}>;

/**
 * Counts the members research scales with. Declaration (`basis`) records are not members; an
 * `unknown` role counts as transitive; additions and removals come from `kind`.
 */
export function researchShareUnits(changes: readonly ChangeFacts[]): ResearchShareUnits {
  const members = changes.filter((change) => !('basis' in change));
  const count = (keep: (change: ChangeFacts) => boolean) => members.filter(keep).length;
  const npm = count((change) => change.ecosystem === 'npm');
  return {
    direct: count((change) => change.role === 'direct'),
    transitive: count((change) => change.role !== 'direct'),
    added: count((change) => change.kind === 'addition'),
    removed: count((change) => change.kind === 'removal'),
    eligible: {
      malware: members.length,
      publishTimes: npm,
      registry: npm,
      metadata: count((change) => change.ecosystem === 'uv'),
      upstream: count((change) => change.ecosystem === 'actions'),
    },
  };
}

const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/u;
const DECIMAL_BASE = BigInt(DECIMAL_RADIX);

/** A non-negative parameter as an exact decimal: its digits and how many are after the point. */
function exactDecimal(name: string, value: number): { digits: bigint; places: number } {
  const written = String(value);
  if (!Number.isFinite(value) || !PLAIN_DECIMAL.test(written))
    throw new Error(`invalid share parameter: ${name}`);
  const [whole, fraction = ''] = written.split('.');
  return { digits: BigInt(whole + fraction), places: fraction.length };
}

/**
 * `base + Σ rate × count`, rounded up, computed on exact decimals so a rate such as 1.1 never
 * picks up a binary rounding error that would push the share over a whole number.
 */
function scaled(
  parameters: ShareDimensionParameters,
  units: ResearchShareUnits,
  eligible: number,
  floor: number,
): number {
  const terms = [
    { ...exactDecimal('base', parameters.base), count: 1n },
    ...Object.entries(parameters.rates).map(([unit, rate]) => ({
      ...exactDecimal(unit, rate ?? 0),
      count: BigInt(unit === 'eligible' ? eligible : units[unit as RoleUnit]),
    })),
  ];
  const places = Math.max(...terms.map((term) => term.places));
  const scale = DECIMAL_BASE ** BigInt(places);
  const numerator = terms.reduce(
    (sum, term) => sum + term.digits * term.count * DECIMAL_BASE ** BigInt(places - term.places),
    0n,
  );
  const total = Number((numerator + scale - 1n) / scale);
  return Math.min(parameters.ceiling, Math.max(floor, total));
}

function share(
  parameters: ShareParameters,
  units: ResearchShareUnits,
  eligible = 0,
): ResearchShare {
  const responseFloor = Math.min(EVIDENCE_READ_ENVELOPE.maxResponseBytes, parameters.bytes.ceiling);
  return {
    maxRequests: scaled(parameters.requests, units, eligible, 1),
    maxTotalBytes: scaled(parameters.bytes, units, eligible, responseFloor),
  };
}

/**
 * Each research share for a change of this size: `min(ceiling, base + Σ rate × count)`, rounded
 * up, with a request floor of one and a byte floor of one full response. The signals stage share is
 * the sum of its readers' shares.
 */
export function researchShares(
  units: ResearchShareUnits,
  parameters: ResearchShareParameters = RESEARCH_SHARE_PARAMETERS,
): ResearchShares {
  const readers = Object.fromEntries(
    SIGNAL_READERS.map((reader) => [
      reader,
      share(parameters.signals[reader], units, units.eligible[reader]),
    ]),
  ) as Record<SignalReader, ResearchShare>;
  const total = (field: keyof ResearchShare) =>
    Object.values(readers).reduce((sum, reader) => sum + reader[field], 0);
  return {
    upstream: share(parameters.upstream, units),
    advisory: share(parameters.advisory, units),
    signals: {
      maxRequests: total('maxRequests'),
      maxTotalBytes: total('maxTotalBytes'),
      readers,
    },
  };
}
