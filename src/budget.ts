import { DECIMAL_RADIX } from './format.js';
import { limit, REGISTER } from './limits.js';

/** The runner's wall-clock limit for the job, mirroring the workflow's `timeout-minutes`. */
export const JOB_BUDGET_MS = limit('job.budget');
/**
 * Time the review step spends before `runStartup` takes its job start: Node load, the relaunch,
 * and the self-check. It is an allowance, not a measurement.
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
  // The snapshot covers C1's excerpt files (one blob read each) with their directories; freshness
  // reads are reserved separately so a heavy snapshot can never starve the checks that keep a
  // result valid.
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
  // Research shares scale with the change (`researchShares`, from the B12 fit), and these entries
  // are their ceilings; the collection registry share above scales the same way on npm members
  // (`collectionRegistryRequests`). An unpaginated, single-URL pip or Actions malware lookup takes
  // 2 requests (stored-name discovery, then the versioned query), and the malware ceiling is 2 per
  // packet change; long pip spelling sets or paginated lookups take more, and the fitted malware
  // share binds long before that ceiling. Actions reviewed lookups take 3 per update, so the
  // advisory ceiling, derived from the evidence deadline, covers about a third as many Actions
  // updates as it has requests (#467). S1's Package Name Form Amendment states the per-lookup costs.
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
    // A dimension the B12 fit keeps at its ceiling has no rate entries, so its rates are 0 (L11,
    // #383); `scaled` reads only the rates a dimension has.
    rates: Object.fromEntries(
      units.flatMap((unit) => {
        const rate = REGISTER.get(`research.share.${share}.${dimension}.rate.${unit}`);
        return rate === undefined ? [] : [[unit, rate.value]];
      }),
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
function exactShare(
  base: number,
  terms: readonly Readonly<{ name: string; rate: number; count: number }>[],
): number {
  const decimals = [
    { ...exactDecimal('base', base), count: 1n },
    ...terms.map((term) => ({ ...exactDecimal(term.name, term.rate), count: BigInt(term.count) })),
  ];
  const places = Math.max(...decimals.map((term) => term.places));
  const scale = DECIMAL_BASE ** BigInt(places);
  const numerator = decimals.reduce(
    (sum, term) => sum + term.digits * term.count * DECIMAL_BASE ** BigInt(places - term.places),
    0n,
  );
  return Number((numerator + scale - 1n) / scale);
}

function scaled(
  parameters: ShareDimensionParameters,
  units: ResearchShareUnits,
  eligible: number,
  floor: number,
): number {
  const total = exactShare(
    parameters.base,
    Object.entries(parameters.rates).map(([unit, rate]) => ({
      name: unit,
      rate: rate ?? 0,
      count: unit === 'eligible' ? eligible : units[unit as RoleUnit],
    })),
  );
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

export type CollectionRegistryShareParameters = Readonly<{
  base: number;
  ceiling: number;
  rates: Readonly<{ npm: number }>;
}>;

/** The register's collection registry request share, capped by the registry allocation. */
export const COLLECTION_REGISTRY_SHARE_PARAMETERS: CollectionRegistryShareParameters =
  Object.freeze({
    base: limit('collection.share.registry.requests.base'),
    ceiling: EVIDENCE_READ_ALLOCATION.registry.maxRequests,
    rates: Object.freeze({ npm: limit('collection.share.registry.requests.rate.npm') }),
  });

/**
 * The collection registry reader's request share for a trusted npm inventory of `npmMembers`
 * members: `min(ceiling, base + rate × npmMembers)`, rounded up, and at least 1. Its byte share
 * stays fixed. These reads go to the npm registry, never to the GitHub quota.
 */
export function collectionRegistryRequests(
  npmMembers: number,
  parameters: CollectionRegistryShareParameters = COLLECTION_REGISTRY_SHARE_PARAMETERS,
): number {
  if (!Number.isSafeInteger(npmMembers) || npmMembers < 0)
    throw new Error('collectionRegistryRequests: invalid npm member count');
  const total = exactShare(parameters.base, [
    { name: 'npm', rate: parameters.rates.npm, count: npmMembers },
  ]);
  return Math.min(parameters.ceiling, Math.max(1, total));
}
