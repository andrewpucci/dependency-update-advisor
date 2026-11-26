/**
 * The pure comparisons behind the batching equivalence probe (#389, C2 of the batching track).
 * Each compares what a batch returned with what per-target queries returned for the same targets,
 * and reports every way the batch falls short. A batch path may be enabled only once a probe over
 * real targets reports none (S1 Batched Lookup Amendment, Verification; Batching Reconciliation
 * Amendment D3).
 */

import { minVersion, satisfies, validRange } from 'semver';
import { canonicalName, type AdvisoryTarget } from '../evidence/advisory-read.js';
import { HTTP_STATUS } from '../format.js';

export type Ecosystem = AdvisoryTarget['ecosystem'];

const FOUND = String(HTTP_STATUS.ok);
const MISSING = String(HTTP_STATUS.notFound);

/** The parts of a GitHub global advisory the comparisons read: its id and the packages it names. */
export type AdvisoryNames = Readonly<{
  id: string;
  packages: readonly Readonly<{ ecosystem: string; name: string }>[];
}>;

/**
 * The id and named packages of a raw GitHub global advisory, or null when it has no usable id or a
 * `vulnerabilities` entry is malformed. A malformed entry makes any batch comparison untrusted.
 */
export function advisoryNames(value: unknown): AdvisoryNames | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { ghsa_id?: unknown; vulnerabilities?: unknown };
  if (typeof record.ghsa_id !== 'string' || !Array.isArray(record.vulnerabilities)) return null;
  const packages: { ecosystem: string; name: string }[] = [];
  for (const entry of record.vulnerabilities as unknown[]) {
    const pkg = (entry as { package?: { ecosystem?: unknown; name?: unknown } } | null)?.package;
    if (typeof pkg?.ecosystem !== 'string' || typeof pkg.name !== 'string') return null;
    packages.push({ ecosystem: pkg.ecosystem, name: pkg.name });
  }
  return { id: record.ghsa_id, packages };
}

const namesIn = (record: AdvisoryNames, ecosystem: Ecosystem): string[] =>
  record.packages.filter((p) => p.ecosystem === ecosystem).map((p) => p.name);

export type CoverageGap = Readonly<{
  target: string;
  item: string;
  /** `absent`: the batch did not return it. `unnamed`: returned, but not naming the target. */
  kind: 'absent' | 'unnamed';
}>;

/**
 * Every singleton match a versioned npm batch misses. A match is covered only when the batch
 * returns the same advisory and that advisory names the target's package, in the batch's
 * ecosystem, exactly as the query sent it (Batched Lookup Amendment items 4 and 6).
 */
export function advisoryBatchCovers(
  ecosystem: Ecosystem,
  singletons: readonly Readonly<{ name: string; ids: readonly string[] }>[],
  batch: readonly AdvisoryNames[],
): CoverageGap[] {
  const byId = new Map(batch.map((record) => [record.id, record]));
  const gaps: CoverageGap[] = [];
  for (const { name, ids } of singletons)
    for (const id of ids) {
      const record = byId.get(id);
      if (!record) gaps.push({ target: name, item: id, kind: 'absent' });
      else if (!namesIn(record, ecosystem).includes(name))
        gaps.push({ target: name, item: id, kind: 'unnamed' });
    }
  return gaps;
}

/**
 * A batch answer the per-target queries lacked: the reverse direction of a coverage check.
 * `attributable`: a record naming exactly one batched package, which Batched Lookup Amendment
 * item 5 would attribute to it with no singleton query. `shared`: a record naming two or more,
 * whose singleton queries decide. `form`: a stored form per-target discovery did not find.
 */
export type ExtraMatch = Readonly<{
  target: string;
  item: string;
  kind: 'attributable' | 'shared' | 'form';
}>;

/**
 * Every record a versioned npm batch returns for a batched package that none of that package's
 * singleton queries returned. `ids` is null for a target whose singleton did not complete; a
 * package with any such target has no known answer and is not judged. Names are compared exactly,
 * in the batch's ecosystem, as the clearing and attribution rules do (items 4 to 6).
 */
export function advisoryBatchExtras(
  ecosystem: Ecosystem,
  targets: readonly Readonly<{ name: string; ids: readonly string[] | null }>[],
  batch: readonly AdvisoryNames[],
): ExtraMatch[] {
  const expected = new Map<string, Set<string> | null>();
  for (const { name, ids } of targets) {
    const prior = expected.get(name);
    if (prior === null) continue;
    expected.set(name, ids === null ? null : new Set([...(prior ?? []), ...ids]));
  }
  const extras: ExtraMatch[] = [];
  for (const record of batch) {
    const named = [...new Set(namesIn(record, ecosystem).filter((n) => expected.has(n)))];
    const kind = named.length === 1 ? 'attributable' : 'shared';
    for (const name of named)
      if (expected.get(name)?.has(record.id) === false)
        extras.push({ target: name, item: record.id, kind });
  }
  return extras;
}

/**
 * Every stored form per-target discovery found that its discovery batch misses. A batch record
 * names a target when one of its entries in the query ecosystem matches the target canonically;
 * each form per-target discovery found must appear, spelled exactly, among the names the batch's
 * records give that target (Batching Reconciliation Amendment D3, Matching).
 */
export function discoveryBatchCovers(
  ecosystem: Ecosystem,
  perTarget: readonly Readonly<{ name: string; forms: readonly string[] }>[],
  batch: readonly AdvisoryNames[],
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const { name, forms } of perTarget) {
    const target = canonicalName(ecosystem, name);
    const named = new Set(
      batch.flatMap((record) =>
        namesIn(record, ecosystem).filter((n) => canonicalName(ecosystem, n) === target),
      ),
    );
    for (const form of forms)
      if (!named.has(form)) gaps.push({ target: name, item: form, kind: 'absent' });
  }
  return gaps;
}

/**
 * Every stored form a discovery batch gives a target that its per-target discovery did not find.
 * The batch's forms feed the versioned query, so an extra form changes what that query asks.
 */
export function discoveryBatchExtras(
  ecosystem: Ecosystem,
  perTarget: readonly Readonly<{ name: string; forms: readonly string[] }>[],
  batch: readonly AdvisoryNames[],
): ExtraMatch[] {
  const extras: ExtraMatch[] = [];
  for (const { name, forms } of perTarget) {
    const target = canonicalName(ecosystem, name);
    const named = new Set(
      batch.flatMap((record) =>
        namesIn(record, ecosystem).filter((n) => canonicalName(ecosystem, n) === target),
      ),
    );
    for (const form of named)
      if (!forms.includes(form)) extras.push({ target: name, item: form, kind: 'form' });
  }
  return extras;
}

/**
 * Batch records that name no batched target. Any one makes a discovery batch `malformed`
 * (Batching Reconciliation Amendment D3, Validation), and a versioned batch fall back.
 */
export function strayRecords(
  ecosystem: Ecosystem,
  targets: readonly string[],
  batch: readonly AdvisoryNames[],
): string[] {
  const wanted = new Set(targets.map((t) => canonicalName(ecosystem, t)));
  return batch
    .filter(
      (record) => !namesIn(record, ecosystem).some((n) => wanted.has(canonicalName(ecosystem, n))),
    )
    .map((record) => record.id);
}

/** GraphQL's answer for one candidate alias. `error` is never read as absence. */
export type GraphqlAnswer = 'found' | 'null' | 'error';

/**
 * Each alias's answer in a GraphQL tag existence response (Upstream Batched Tag Existence
 * Amendment items 2 and 4). An alias is `null` only when no error names it, its repository
 * resolved with the requested `nameWithOwner` ignoring case, and its `ref` is null. A response
 * error without a path, or no `data` object, makes every alias `error`.
 */
export function graphqlAnswers(
  response: unknown,
  aliases: readonly Readonly<{ alias: string; repository: string }>[],
): Map<string, GraphqlAnswer> {
  const answers = new Map<string, GraphqlAnswer>(aliases.map(({ alias }) => [alias, 'error']));
  if (!graphqlAnswered(response)) return answers;
  const body = response as { data: Record<string, unknown>; errors?: unknown };
  const errors = Array.isArray(body.errors) ? (body.errors as { path: unknown[] }[]) : [];
  const named = new Set(errors.map((e) => String(e.path[0])));
  const data = body.data;
  for (const { alias, repository } of aliases)
    answers.set(alias, named.has(alias) ? 'error' : aliasAnswer(data[alias], repository));
  return answers;
}

/**
 * Whether a GraphQL response answers per alias at all: it has a `data` object and every error has
 * a path. Otherwise the whole query failed (item 4) and no alias has an answer to compare.
 */
export function graphqlAnswered(response: unknown): boolean {
  const body = response as { data?: unknown; errors?: unknown } | null;
  if (!body?.data || typeof body.data !== 'object') return false;
  const errors = Array.isArray(body.errors) ? (body.errors as unknown[]) : [];
  return errors.every((e) => Array.isArray((e as { path?: unknown } | null)?.path));
}

function aliasAnswer(value: unknown, repository: string): GraphqlAnswer {
  const repo = value as { nameWithOwner?: unknown; ref?: unknown } | null | undefined;
  if (!repo || typeof repo.nameWithOwner !== 'string') return 'error';
  if (repo.nameWithOwner.toLowerCase() !== repository.toLowerCase()) return 'error';
  if (repo.ref === null) return 'null';
  return repo.ref && typeof repo.ref === 'object' ? 'found' : 'error';
}

export type TagAgreement =
  | 'agree'
  | 'rest-conflict'
  | 'rest-found-graphql-null'
  | 'rest-missing-graphql-found'
  | 'graphql-error'
  | 'rest-other';

/**
 * Whether a REST `git/ref` status and GraphQL's answer agree on one candidate: every REST 404 must
 * be a GraphQL null and every GraphQL null a REST 404 (Upstream Batched Tag Existence Amendment,
 * Verification). A REST status other than found or missing, or a GraphQL error, cannot agree.
 */
export function tagAnswersAgree(restStatus: string, graphql: GraphqlAnswer): TagAgreement {
  if (graphql === 'error') return 'graphql-error';
  if (restStatus === FOUND) return graphql === 'found' ? 'agree' : 'rest-found-graphql-null';
  if (restStatus !== MISSING) return 'rest-other';
  return graphql === 'null' ? 'agree' : 'rest-missing-graphql-found';
}

/**
 * The distinct tag candidates, each with every distinct REST status recorded for it, in first-seen
 * order. C1 records a candidate once per request, so one tag can carry two statuses.
 */
export function distinctTags(
  tags: Iterable<Readonly<{ repository: string; tag: string; status: string }>>,
): { repository: string; tag: string; statuses: string[] }[] {
  const byKey = new Map<string, { repository: string; tag: string; statuses: string[] }>();
  for (const { repository, tag, status } of tags) {
    const key = JSON.stringify([repository, tag]);
    const entry = byKey.get(key) ?? { repository, tag, statuses: [] };
    if (!entry.statuses.includes(status)) entry.statuses.push(status);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/**
 * One candidate's agreement over all its REST statuses. Statuses that conflict are reported as
 * such, never collapsed into one: GraphQL cannot agree with both.
 */
export function tagAgreement(statuses: readonly string[], graphql: GraphqlAnswer): TagAgreement {
  return statuses.length > 1 ? 'rest-conflict' : tagAnswersAgree(statuses[0] ?? '', graphql);
}

/**
 * A version inside a GitHub `vulnerable_version_range` (comma-separated npm comparators, such as
 * `>= 1.0.0, < 1.2.0`), or null when the range does not parse or holds no version.
 */
export function versionInRange(range: string): string | null {
  const comparators = range
    .split(',')
    .map((part) => part.trim().replace(/^([<>]=?|=)\s+/u, '$1'))
    .filter(Boolean);
  const npmRange = comparators.length ? validRange(comparators.join(' ')) : null;
  const version = npmRange ? minVersion(npmRange)?.version : null;
  return version && npmRange && satisfies(version, npmRange) ? version : null;
}

/** Sizes from `max` down to one, each half the last (rounded down): the probe's batch sizes. */
export function halvingSizes(max: number): number[] {
  const sizes: number[] = [];
  for (let size = max; size >= 1; size = Math.floor(size / 2)) sizes.push(size);
  return sizes;
}

/**
 * Every target split into as few batches of at most `max` as hold them all, with the positives
 * spread across the batches and placed last in each, so every positive is checked in a batch.
 */
export function sweepChunks(
  rest: readonly string[],
  positives: readonly string[],
  max: number,
): string[][] {
  const count = Math.ceil((rest.length + positives.length) / max);
  const tails = Array.from({ length: count }, (): string[] => []);
  positives.forEach((positive, i) => tails[i % count].push(positive));
  let next = 0;
  return tails.map((tail) => {
    const room = max - tail.length;
    const head = rest.slice(next, next + room);
    next += room;
    return [...head, ...tail];
  });
}

/** Thrown when the probe's request budget is spent. */
export class BudgetSpent extends Error {}

/** A request counter that refuses the request past `max`, before it is sent. */
export function requestBudget(max: number): { spend(): void; used(): number } {
  let used = 0;
  return {
    spend() {
      if (used >= max) throw new BudgetSpent('request budget spent');
      used += 1;
    },
    used: () => used,
  };
}

/** Counts by key, for counts-only output. */
export function countBy<T>(values: Iterable<T>, key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}
