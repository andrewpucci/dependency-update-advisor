/**
 * The pure comparisons behind the batching equivalence probe (#389, C2 of the batching track).
 * Each compares what a batch returned with what per-target queries returned for the same targets,
 * and reports every way the batch falls short. A batch path may be enabled only once a probe over
 * real targets reports none (S1 Batched Lookup Amendment, Verification; Batching Reconciliation
 * Amendment D3).
 */

import { HTTP_STATUS } from '../format.js';

export type Ecosystem = 'npm' | 'pip' | 'actions';

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

/** The reader's name comparison (S1 Package Name Form Amendment item 6). */
export function canonicalName(ecosystem: Ecosystem, name: string): string {
  if (ecosystem === 'pip') return name.toLowerCase().replace(/[-_.]+/gu, '-');
  return ecosystem === 'actions' ? name.toLowerCase() : name;
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
  const body = response as { data?: unknown; errors?: unknown } | null;
  const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]) : [];
  const paths = errors.map((e) => (e as { path?: unknown } | null)?.path);
  if (!body?.data || typeof body.data !== 'object' || paths.some((p) => !Array.isArray(p)))
    return answers;
  const named = new Set(paths.map((p) => String((p as unknown[])[0])));
  const data = body.data as Record<string, unknown>;
  for (const { alias, repository } of aliases)
    answers.set(alias, named.has(alias) ? 'error' : aliasAnswer(data[alias], repository));
  return answers;
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

/** Sizes from `max` down to one, each half the last (rounded down): the probe's batch sizes. */
export function halvingSizes(max: number): number[] {
  const sizes: number[] = [];
  for (let size = max; size >= 1; size = Math.floor(size / 2)) sizes.push(size);
  return sizes;
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
