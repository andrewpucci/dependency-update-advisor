/**
 * The targets a demand measurement's advisory and malware readers settle, and the tag candidates
 * it requested, parsed from the request URLs the run observes (#388, C1 of the batching track).
 * A settled target comes from a versioned GitHub advisory query: an npm reviewed or malware query,
 * an Actions reviewed query, or a `pip` or Actions malware query. Package-only discovery queries
 * and OSV lookups settle nothing here: `pip` reviewed lookups are not batched (Batching
 * Reconciliation Amendment D1).
 */

export type TargetEcosystem = 'npm' | 'pip' | 'actions';
export type TargetType = 'reviewed' | 'malware';
export type Side = 'base' | 'head';

export type ParsedTarget = Readonly<{
  ecosystem: TargetEcosystem;
  name: string;
  version: string;
  type: TargetType;
}>;
export type SettledTarget = ParsedTarget & Readonly<{ side: Side }>;
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
 * The one target a versioned GitHub advisory query settles, or null for any other URL: a
 * discovery query (an `affects` entry with no version), an OSV query, or anything else.
 *
 * A `pip` or Actions versioned query lists every stored form of one target's name at its version.
 * Its target name is the forms' shared canonical name: for `pip` that is the normalized name the
 * reader sends; for Actions it is the forms' common spelling, or the lowercase name when the
 * stored forms differ only in case.
 */
export function parseAdvisoryTarget(url: string): ParsedTarget | null {
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
  const eco = ecosystem as TargetEcosystem;
  const entries = affects.split(',').map(splitAffect);
  if (entries.some((entry) => entry === null)) return null;
  const pairs = entries as { name: string; version: string }[];
  const version = pairs[0].version;
  if (pairs.some((pair) => pair.version !== version)) return null;
  if (eco === 'npm' && pairs.length !== 1) return null;
  const names = new Set(pairs.map((pair) => pair.name));
  const canon = new Set(pairs.map((pair) => canonical(eco, pair.name)));
  if (canon.size !== 1) return null;
  const name = eco === 'pip' || names.size > 1 ? [...canon][0] : pairs[0].name;
  return { ecosystem: eco, name, version, type: type as TargetType };
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

/**
 * One settled target per side for each lookup whose versioned URL this run requested. Advisory
 * reads are shared across sides, so one request can settle a target on both.
 */
export function settledTargets(
  lookups: Iterable<Readonly<{ side: Side; url: string | null }>>,
  requested: ReadonlySet<string>,
): SettledTarget[] {
  const targets: SettledTarget[] = [];
  for (const { side, url } of lookups) {
    if (url === null || !requested.has(url)) continue;
    const target = parseAdvisoryTarget(url);
    if (target) targets.push({ ...target, side });
  }
  return byKey(targets);
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
