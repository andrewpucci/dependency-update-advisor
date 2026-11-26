/**
 * The targets a demand measurement's advisory and malware readers settle, and the tag candidates
 * it requested, from the readers' own reads and the request URLs the run observes (#388, C1 of the
 * batching track). A settled target comes from a versioned GitHub advisory query: an
 * npm reviewed or malware query, an Actions reviewed query, or a `pip` or Actions malware query.
 * Package-only discovery queries and OSV lookups settle nothing here: `pip` reviewed lookups are
 * not batched (Batching Reconciliation Amendment D1).
 */

import type { AdvisoryLookup, AdvisoryReader } from '../evidence/advisory-read.js';
import type {
  AdvisoryInput,
  prepareAdvisoryInput,
  resolveAdvisoryTarget,
} from '../evidence/advisories.js';

/** The stage's own input check and target resolver, passed in so a mocked module can supply them. */
export type TargetResolver = Readonly<{
  prepareAdvisoryInput: typeof prepareAdvisoryInput;
  resolveAdvisoryTarget: typeof resolveAdvisoryTarget;
}>;

export type TargetEcosystem = 'npm' | 'pip' | 'actions';
export type TargetType = 'reviewed' | 'malware';
export type Side = 'base' | 'head';

/** What a versioned advisory query's URL says about the one target it settles. */
export type VersionedQuery = Readonly<{
  ecosystem: TargetEcosystem;
  type: TargetType;
  version: string;
  /** The names in `affects`: the target's own name, or the stored forms discovery found. */
  names: readonly string[];
}>;
export type ReaderTarget = Readonly<{ ecosystem: string; name: string; version: string }>;
export type SettledTarget = Readonly<{
  ecosystem: TargetEcosystem;
  name: string;
  version: string;
  type: TargetType;
  side: Side;
  /**
   * False when any read of this target did not complete (an HTTP error, 429, network failure, or
   * any other incomplete read): C2 replays it but cannot treat its answer as known. This is the
   * reader's own result, before the stage reconciles, compares, or rolls back its evidence.
   */
  complete: boolean;
}>;
export type TagCandidate = Readonly<{ repository: string; tag: string; status: string }>;

const API_ORIGIN = 'https://api.github.com';
const ECOSYSTEMS: readonly string[] = ['npm', 'pip', 'actions'];
const TYPES: readonly string[] = ['reviewed', 'malware'];
const TAG_REF = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/tags\/(.+)$/u;

/** The reader's name comparison (S1 Package Name Form Amendment item 6). */
function canonical(ecosystem: TargetEcosystem, name: string): string {
  if (ecosystem === 'pip') return name.toLowerCase().replace(/[-_.]+/gu, '-');
  return ecosystem === 'actions' ? name.toLowerCase() : name;
}

/** `name@version`, split at the last `@` so a scoped npm name keeps its leading one. */
function splitAffect(entry: string): { name: string; version: string } | null {
  const at = entry.lastIndexOf('@');
  if (at <= 0 || at === entry.length - 1) return null;
  return { name: entry.slice(0, at), version: entry.slice(at + 1) };
}

/**
 * The versioned GitHub advisory query a URL is, or null for any other URL: a discovery query (an
 * `affects` entry with no version), an OSV query, a query at more than one version or, for npm,
 * more than one name, or anything else.
 */
export function parseVersionedQuery(url: string): VersionedQuery | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== API_ORIGIN || parsed.pathname !== '/advisories' || parsed.hash) return null;
  const params = parsed.searchParams;
  const ecosystem = params.get('ecosystem') ?? '';
  const type = params.get('type') ?? '';
  const affects = params.get('affects');
  if (!ECOSYSTEMS.includes(ecosystem) || !TYPES.includes(type) || !affects) return null;
  const entries = affects.split(',').map(splitAffect);
  if (entries.some((entry) => entry === null)) return null;
  const pairs = entries as { name: string; version: string }[];
  const version = pairs[0].version;
  if (pairs.some((pair) => pair.version !== version)) return null;
  if (ecosystem === 'npm' && pairs.length !== 1) return null;
  return {
    ecosystem: ecosystem as TargetEcosystem,
    type: type as TargetType,
    version,
    names: pairs.map((pair) => pair.name),
  };
}

/**
 * The target a lookup settled, named as the reader looked it up, or null when its URL is not a
 * versioned query for that target. GitHub's stored forms can differ from the target's name in case
 * and separators, so the name comes from the reader's target, never from the URL.
 */
export function settledTarget(
  url: string,
  target: ReaderTarget,
  side: Side,
  complete: boolean,
): SettledTarget | null {
  const query = parseVersionedQuery(url);
  if (!query || query.ecosystem !== target.ecosystem || query.version !== target.version)
    return null;
  const expected = canonical(query.ecosystem, target.name);
  if (query.names.some((name) => canonical(query.ecosystem, name) !== expected)) return null;
  return {
    ecosystem: query.ecosystem,
    name: target.name,
    version: target.version,
    type: query.type,
    side,
    complete,
  };
}

/** The repository and tag of a REST `git/ref/tags/...` request, each path segment decoded once. */
export function parseTagCandidate(url: string): { repository: string; tag: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== API_ORIGIN || parsed.search || parsed.hash) return null;
  const match = TAG_REF.exec(parsed.pathname);
  if (!match) return null;
  try {
    const tag = match[3].split('/').map(decodeURIComponent).join('/');
    return { repository: `${match[1]}/${match[2]}`, tag };
  } catch {
    return null;
  }
}

const byKey = <T>(values: Iterable<T>): T[] => {
  const seen = new Map<string, T>();
  for (const value of values) seen.set(JSON.stringify(value), value);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
};

/** One read an advisory or malware reader answered, as the reader itself reported it. */
export type ReaderRead = Readonly<{
  type: TargetType;
  url: string;
  target: ReaderTarget;
  complete: boolean;
  /** Settled from a batch: `url` is the unfetched query that would reproduce it. */
  batched?: true;
}>;
/** The sides each target was looked up for, keyed by `sideKey`. */
export type TargetSides = Map<string, Set<Side>>;

const sideKey = (type: TargetType, t: ReaderTarget) =>
  JSON.stringify([type, t.ecosystem, t.name, t.version]);

/**
 * Wraps a reader so every read it answers is kept with its own target, URL, and completeness:
 * the stage may later roll a member back or reconcile its lookup, which must not hide the read.
 */
export function recordReads<R extends AdvisoryReader>(
  reader: R,
  type: TargetType,
  reads: ReaderRead[],
): R {
  return {
    ...reader,
    read: async (value: unknown): Promise<AdvisoryLookup> => {
      const lookup = await reader.read(value);
      if (lookup.url)
        reads.push({
          type,
          url: lookup.url,
          target: lookup.target,
          complete: lookup.complete,
          ...(lookup.batched ? { batched: true as const } : {}),
        });
      return lookup;
    },
  };
}

/**
 * Adds the side each member's target is looked up for to `sides`, resolved the way the stage
 * resolves it: reviewed lookups check every existing side, malware lookups the proposed side (the
 * base side for a removal). Members the stage would skip, and invalid input, add nothing.
 */
export function addTargetSides(
  sides: TargetSides,
  value: unknown,
  type: TargetType,
  resolver: TargetResolver,
): void {
  const prepared = resolver.prepareAdvisoryInput(value as AdvisoryInput);
  if (!prepared.ok) return;
  const { input } = prepared;
  for (const change of input.changes) {
    if ('basis' in change) continue;
    for (const side of lookupSides(change, type)) {
      const target = resolver.resolveAdvisoryTarget(input, change as never, side);
      if (target) addSide(sides, sideKey(type, target), side);
    }
  }
}

/** Reviewed lookups check every existing side; a malware lookup checks the proposed one. */
function lookupSides(change: Readonly<{ from?: unknown; to?: unknown }>, type: TargetType): Side[] {
  if (type === 'malware') return [change.to ? 'head' : 'base'];
  const sides: Side[] = [];
  if (change.to) sides.push('head');
  if (change.from) sides.push('base');
  return sides;
}

function addSide(sides: TargetSides, key: string, side: Side): void {
  const known = sides.get(key) ?? new Set<Side>();
  known.add(side);
  sides.set(key, known);
}

/**
 * One settled target per side for each read whose versioned URL this run requested, or that a
 * batch this run sent settled, complete only when every read of it completed. Advisory reads are
 * shared across sides, so one request can settle a target on both.
 */
export function settledTargets(
  reads: Iterable<ReaderRead>,
  sides: TargetSides,
  requested: ReadonlySet<string>,
): SettledTarget[] {
  const targets = new Map<string, SettledTarget>();
  for (const { type, url, target, complete, batched } of reads) {
    if (!requested.has(url) && !batched) continue;
    for (const side of sides.get(sideKey(type, target)) ?? []) {
      const settled = settledTarget(url, target, side, complete);
      if (!settled || settled.type !== type) continue;
      const key = JSON.stringify({ ...settled, complete: null });
      const prior = targets.get(key);
      targets.set(key, { ...settled, complete: complete && (prior?.complete ?? true) });
    }
  }
  return byKey(targets.values());
}

/** The distinct tag candidates, with each REST status they answered, among this run's requests. */
export function tagCandidates(
  requests: Iterable<Readonly<{ url: string; status: string }>>,
): TagCandidate[] {
  const candidates: TagCandidate[] = [];
  for (const { url, status } of requests) {
    const candidate = parseTagCandidate(url);
    if (candidate) candidates.push({ ...candidate, status });
  }
  return byKey(candidates);
}
