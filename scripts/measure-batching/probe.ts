/**
 * The batching equivalence probe (#389, C2 of the batching track; follow-ups #440): replays C1's
 * recorded targets and tag candidates both ways, per target and batched, with no model call and no
 * write. `run.batching.ts` runs it with the user's token; tests run it against a fake GitHub.
 * The report holds counts, sizes, and disagreements by kind only: no token, URL query, or
 * response body, and no package or tag name. Every request counts against
 * `probe.batching.maxRequests`. A run that spends it, or that a request error stops, keeps what it
 * measured and says why it stopped.
 */
import {
  AdvisoryFailure,
  canonicalName,
  discoverySpellings,
  discoveryUrls,
  githubUrl,
  type QueryKind,
} from '../../src/evidence/advisory-read.js';
import { HTTP_STATUS } from '../../src/format.js';
import { limit } from '../../src/limits.js';
import {
  advisoryBatchCovers,
  advisoryBatchExtras,
  advisoryNames,
  BudgetSpent,
  countBy,
  discoveryBatchCovers,
  discoveryBatchExtras,
  distinctTags,
  graphqlAnswered,
  graphqlAnswers,
  halvingSizes,
  requestBudget,
  strayRecords,
  sweepChunks,
  tagAgreement,
  versionInRange,
  type AdvisoryNames,
  type Ecosystem,
} from '../../src/measurement/batching.js';
import type { TagCandidate } from '../../src/measurement/targets.js';

export type Target = { ecosystem: Ecosystem; name: string; version: string; type: QueryKind };
export type ProbeInput = { targets: readonly Target[]; tags: readonly TagCandidate[] };
export type ProbeDeps = { token: string; fetch: typeof fetch; input: ProbeInput };

const API = 'https://api.github.com';
const PAGE_SIZE = limit('github.pageSize');
const MAX_BATCH = limit('probe.batching.maxBatchTargets');
const MAX_TAGS = limit('probe.batching.maxTagsPerQuery');
/**
 * The reader's discovery URL cap, a stand-in for the npm batch URL bound S1 leaves Ask first: the
 * longest URL GitHub is known to accept (S1 Package Name Form). A batch's first URL leaves the
 * cursor headroom under it, as discovery's does, so every continuation URL stays within it.
 */
const URL_CAP = limit('advisory.discovery.urlBytes');
const FIRST_URL_CAP = URL_CAP - limit('advisory.discovery.cursorHeadroomBytes');

/** The fixed seeds (#389 as reconciled by D4): known positives and a three-separator name. */
export const SEEDS: readonly Target[] = [
  { ecosystem: 'npm', name: 'lodash', version: '4.17.20', type: 'reviewed' },
  { ecosystem: 'npm', name: '@babel/traverse', version: '7.22.0', type: 'reviewed' },
  { ecosystem: 'actions', name: 'tj-actions/changed-files', version: '45.0.7', type: 'reviewed' },
  { ecosystem: 'actions', name: 'tj-actions/changed-files', version: '45.0.7', type: 'malware' },
  { ecosystem: 'pip', name: 'flo-pro-adk', version: '1.0.0', type: 'malware' },
  { ecosystem: 'pip', name: 'google-cloud-bigquery-storage', version: '1.0.0', type: 'malware' },
];

type Counts = Record<string, number>;

/** One run's request budget and the reasons it is incomplete or not equivalent, by kind. */
type Run = {
  token: string;
  fetch: typeof fetch;
  budget: ReturnType<typeof requestBudget>;
  incomplete: Counts;
  disagreements: Counts;
  overUrlCap: Counts;
};

function bump(counts: Counts, key: string, by = 1): void {
  if (by) counts[key] = (counts[key] ?? 0) + by;
}

function add(into: Counts, counts: Counts): Counts {
  for (const [key, by] of Object.entries(counts)) bump(into, key, by);
  return into;
}

type Page = { status: number; bytes: number; data: unknown; link: string | null };

async function send(run: Run, url: string, init: RequestInit = {}): Promise<Page> {
  run.budget.spend();
  const response = await run.fetch(url, {
    ...init,
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${run.token}`,
      accept: 'application/vnd.github+json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return {
    status: response.status,
    bytes: Buffer.byteLength(text),
    data,
    link: response.headers.get('link'),
  };
}

function nextLink(link: string | null): string | null {
  const match = link && /<([^>]+)>;\s*rel="next"/u.exec(link);
  return match && new URL(match[1]).origin === API ? match[1] : null;
}

type Query = {
  status: number;
  pages: number;
  maxPageBytes: number;
  /** The longest page URL sent, continuation cursors included. */
  maxUrlLength: number;
  records: AdvisoryNames[];
  malformed: number;
  /** False when a page failed, was not a list, or held a malformed record. */
  complete: boolean;
};

/** Every page of one advisory query; a non-200 page or a malformed record is kept as counts. */
async function query(run: Run, url: string): Promise<Query> {
  const result: Query = {
    status: 0,
    pages: 0,
    maxPageBytes: 0,
    maxUrlLength: 0,
    records: [],
    malformed: 0,
    complete: true,
  };
  for (let next: string | null = url; next;) {
    result.maxUrlLength = Math.max(result.maxUrlLength, next.length);
    const page = await send(run, next);
    result.status = page.status;
    result.pages += 1;
    result.maxPageBytes = Math.max(result.maxPageBytes, page.bytes);
    if (page.status !== HTTP_STATUS.ok || !Array.isArray(page.data)) {
      result.complete = false;
      break;
    }
    for (const value of page.data) {
      const names = advisoryNames(value);
      if (names) result.records.push(names);
      else {
        result.malformed += 1;
        result.complete = false;
      }
    }
    next = nextLink(page.link);
  }
  return result;
}

const advisoryUrl = (
  ecosystem: Ecosystem,
  affects: readonly string[],
  type: QueryKind,
  perPage: number,
) => githubUrl(ecosystem, affects, type, String(perPage));

const key = (t: Target) => JSON.stringify([t.ecosystem, t.name, t.version, t.type]);
const unique = (targets: readonly Target[]) => [
  ...new Map(targets.map((t) => [key(t), t])).values(),
];

export type SeedStatus = 'chosen' | 'none' | 'no-version-in-range';

type Vulnerability = {
  package?: { ecosystem?: unknown; name?: unknown };
  vulnerable_version_range?: unknown;
};

/**
 * The first npm malware advisory GitHub lists, as a seed at a version inside its range. A seed
 * outside its range could never hit, so none is used when no version in the range can be chosen.
 */
async function malwareSeed(run: Run): Promise<{ target: Target | null; status: SeedStatus }> {
  const page = await send(run, `${API}/advisories?type=malware&ecosystem=npm&per_page=1`);
  const first = Array.isArray(page.data) ? (page.data[0] as { vulnerabilities?: unknown }) : null;
  const entries = Array.isArray(first?.vulnerabilities)
    ? (first.vulnerabilities as (Vulnerability | null)[])
    : [];
  const entry = entries.find(
    (e) => e?.package?.ecosystem === 'npm' && typeof e.package.name === 'string',
  );
  const name = entry?.package?.name;
  if (typeof name !== 'string') return { target: null, status: 'none' };
  const range = entry?.vulnerable_version_range;
  const version = typeof range === 'string' ? versionInRange(range) : null;
  if (!version) return { target: null, status: 'no-version-in-range' };
  return { target: { ecosystem: 'npm', name, version, type: 'malware' }, status: 'chosen' };
}

const affect = (t: Target) => `${t.name}@${t.version}`;
/** A 4xx other than a rate limit (403, 429): GitHub refused the request itself, such as its size. */
const isRejected = (status: number) =>
  status >= HTTP_STATUS.clientErrorMin &&
  status < HTTP_STATUS.serverErrorMin &&
  status !== HTTP_STATUS.forbidden &&
  status !== HTTP_STATUS.tooManyRequests;
const overCap = (url: string) => url.length > URL_CAP;
/** Whether a versioned npm batch's first URL, at the longest `per_page` form, leaves the headroom. */
const fitsFirstUrl = (type: QueryKind, affects: readonly string[]) =>
  advisoryUrl('npm', affects, type, PAGE_SIZE).length <= FIRST_URL_CAP;
const packageOf = (entry: string) => entry.slice(0, entry.lastIndexOf('@'));

/** Each real target's singleton match ids, or null when its singleton did not complete. */
type Known = ReadonlyMap<string, readonly string[] | null>;

type Comparison = { gaps: Counts; extras: Counts; positives: string[] };

/**
 * Both directions for one complete versioned npm batch: singleton matches the batch misses, and
 * batch records the singletons lacked. Fillers are not real packages, so they expect no match.
 */
function compareNpm(affects: readonly string[], answer: Query, known: Known): Comparison {
  const carried = affects.filter((a) => known.get(a));
  const gaps = advisoryBatchCovers(
    'npm',
    carried.map((a) => ({ name: packageOf(a), ids: known.get(a) ?? [] })),
    answer.records,
  );
  const extras = advisoryBatchExtras(
    'npm',
    affects.map((a) => ({ name: packageOf(a), ids: known.has(a) ? (known.get(a) ?? null) : [] })),
    answer.records,
  );
  return {
    gaps: countBy(gaps, (g) => g.kind),
    extras: countBy(extras, (e) => e.kind),
    positives: carried.filter((a) => known.get(a)?.length),
  };
}

type NpmBatch = {
  size: number;
  urlLength: number;
  status: number;
  pages: number;
  records: number;
  malformed: number;
  complete: boolean;
  /** GitHub refused the query itself (a 4xx status), as it would a URL too long or too wide. */
  rejected: boolean;
  stray: number;
  /** Null when the batch did not complete: a failed answer is not compared. */
  gaps: Counts | null;
  extras: Counts | null;
  positiveLast: boolean;
  /** Above GitHub's documented `affects` maximum: recorded, never counted in the verdict. */
  overMaximum: boolean;
  /** Its URL is over the URL cap: a 414 is counted in `overUrlCap`, not the verdict. */
  overUrlCap: boolean;
};

/** One sweep batch; `urlLength` is its longest page URL, continuation cursors included. */
type SweepBatch = { targets: number; urlLength: number; status: number; complete: boolean };

type NpmSweep = {
  perPage: number;
  batches: number;
  /** Each batch's size, longest page URL, and last HTTP status, in the order sent. */
  results: SweepBatch[];
  pages: number;
  maxPageBytes: number;
  complete: boolean;
  stray: number;
  gaps: Counts;
  extras: Counts;
};

export type NpmSection = {
  type: QueryKind;
  targets: number;
  singletonIncomplete: number;
  singletonPositives: number;
  /** Positives no complete batch carried, so neither direction was checked for them. */
  positivesUnchecked: number;
  /** Targets whose URL alone does not fit: no batch can carry them, so none is compared. */
  skippedUnsupported: number;
  /**
   * The proposed maximum: the most targets a positive-last batch holds with its first URL, at the
   * longest `per_page` form, within the URL cap less the cursor headroom. Null with no positive;
   * zero when no positive fits alone.
   */
  maxFitTargets: number | null;
  /** The positive-last batch at `maxFitTargets`, which must complete for the run to. */
  maxFit: NpmBatch | null;
  sizes: NpmBatch[];
  sweep: NpmSweep[];
};

/** Records a compared batch's disagreements; only an attributable extra breaks equivalence. */
function tallyNpm(run: Run, comparison: Comparison, checked: Set<string>): void {
  for (const [kind, by] of Object.entries(comparison.gaps))
    bump(run.disagreements, `npm-${kind}`, by);
  bump(run.disagreements, 'npm-extra-attributable', comparison.extras.attributable ?? 0);
  for (const positive of comparison.positives) checked.add(positive);
}

/** Each target's singleton answer; one that did not complete is counted and has none. */
async function npmSingletons(run: Run, group: readonly Target[], section: NpmSection) {
  const known = new Map<string, string[] | null>();
  for (const t of group) {
    const answer = await query(run, advisoryUrl('npm', [affect(t)], section.type, PAGE_SIZE));
    known.set(affect(t), answer.complete ? answer.records.map((r) => r.id) : null);
    if (!answer.complete) {
      section.singletonIncomplete += 1;
      bump(run.incomplete, 'npmSingleton');
    }
  }
  return known;
}

type NpmPlan = {
  known: Known;
  positives: string[];
  rest: string[];
  checked: Set<string>;
  /** Targets no batch can carry within the URL cap, left out of the verdict as discovery does. */
  skipped: Set<string>;
};

// Nonexistent filler packages pad a batch past the real targets; GitHub ignores them.
const fill = (rest: readonly string[], size: number) =>
  Array.from({ length: size }, (_, i) => rest[i] ?? `dua-probe-filler-${i}@1.0.0`);
const batchOf = (rest: readonly string[], last: string | undefined, size: number) =>
  last ? [...fill(rest, size - 1), last] : fill(rest, size);

/**
 * Sends one positive-last batch and compares a complete answer. A batch above the documented
 * maximum is recorded, and nothing it returns is counted; the caller counts a failure.
 */
async function sendBatch(run: Run, plan: NpmPlan, section: NpmSection, affects: string[]) {
  const url = advisoryUrl('npm', affects, section.type, PAGE_SIZE);
  const answer = await query(run, url);
  const comparison = answer.complete ? compareNpm(affects, answer, plan.known) : null;
  const batch: NpmBatch = {
    size: affects.length,
    urlLength: url.length,
    status: answer.status,
    pages: answer.pages,
    records: answer.records.length,
    malformed: answer.malformed,
    complete: answer.complete,
    rejected: isRejected(answer.status),
    stray: strayRecords('npm', affects.map(packageOf), answer.records).length,
    gaps: comparison?.gaps ?? null,
    extras: comparison?.extras ?? null,
    positiveLast: plan.positives.includes(affects.at(-1) ?? ''),
    overMaximum: affects.length > MAX_BATCH,
    overUrlCap: overCap(url),
  };
  if (batch.overMaximum) return batch;
  if (comparison) tallyNpm(run, comparison, plan.checked);
  // A record naming no batched package makes the reader's batch fall back (item 6).
  bump(run.incomplete, 'npmStray', batch.stray);
  return batch;
}

/** Why a batch that did not complete is incomplete, or null when its failure is a measurement. */
function batchFailure(batch: NpmBatch): string | null {
  const tooLong = batch.status === HTTP_STATUS.uriTooLong;
  // GitHub refusing a URL over the cap is what the size sweep measures, not a comparison gap.
  if (tooLong && batch.overUrlCap) return null;
  if (tooLong) return 'npmBatchUrlTooLong';
  return batch.rejected ? 'npmBatchRefused' : 'npmBatch';
}

/** Batches at halving sizes from one above the maximum, each with one positive placed last. */
async function npmSizes(run: Run, plan: NpmPlan, section: NpmSection) {
  const { positives, rest } = plan;
  for (const size of [MAX_BATCH + 1, ...halvingSizes(MAX_BATCH)]) {
    const last: string | undefined =
      positives[section.sizes.length % Math.max(positives.length, 1)];
    const batch = await sendBatch(run, plan, section, batchOf(rest, last, size));
    section.sizes.push(batch);
    if (batch.complete || batch.overMaximum) continue;
    const failure = batchFailure(batch);
    if (failure) bump(run.incomplete, failure);
    else bump(run.overUrlCap, 'npmBatchRejected');
  }
}

/**
 * The positive-last batch at the proposed maximum (S1 Batched Lookup Amendment, Verification):
 * the most targets, up to the documented maximum, whose first URL leaves the cursor headroom.
 * It must complete; otherwise the run is incomplete.
 */
async function npmMaxFit(run: Run, plan: NpmPlan, section: NpmSection) {
  if (!plan.positives.length) return;
  const last = plan.positives.find((p) => fitsFirstUrl(section.type, [p]));
  let size = 0;
  while (last && size < MAX_BATCH && fitsFirstUrl(section.type, batchOf(plan.rest, last, size + 1)))
    size += 1;
  section.maxFitTargets = size;
  if (!last) {
    bump(run.incomplete, 'npmMaxFitIncomplete');
    return;
  }
  section.maxFit = await sendBatch(run, plan, section, batchOf(plan.rest, last, size));
  if (!section.maxFit.complete) bump(run.incomplete, 'npmMaxFitIncomplete');
}

/**
 * Every target, in batches of at most the maximum whose first URL leaves the cursor headroom under
 * the URL cap, at each page size, compared both ways. The fit is measured at the largest page
 * size, whose URL is the longest.
 */
async function npmSweep(run: Run, plan: NpmPlan, section: NpmSection) {
  const fits = (chunk: readonly string[]) => fitsFirstUrl(section.type, chunk);
  const { chunks, skipped } = sweepChunks(plan.rest, plan.positives, MAX_BATCH, fits);
  section.skippedUnsupported = skipped.length;
  for (const target of skipped) plan.skipped.add(target);
  for (const perPage of chunks.length ? halvingSizes(PAGE_SIZE) : []) {
    const sweep: NpmSweep = {
      perPage,
      batches: 0,
      results: [],
      pages: 0,
      maxPageBytes: 0,
      complete: true,
      stray: 0,
      gaps: {},
      extras: {},
    };
    section.sweep.push(sweep);
    for (const chunk of chunks) {
      const answer = await query(run, advisoryUrl('npm', chunk, section.type, perPage));
      sweep.batches += 1;
      sweep.results.push({
        targets: chunk.length,
        urlLength: answer.maxUrlLength,
        status: answer.status,
        complete: answer.complete,
      });
      sweep.pages += answer.pages;
      sweep.maxPageBytes = Math.max(sweep.maxPageBytes, answer.maxPageBytes);
      if (!answer.complete) {
        sweep.complete = false;
        const tooLong = answer.status === HTTP_STATUS.uriTooLong;
        bump(run.incomplete, tooLong ? 'npmSweepBatchRejected' : 'npmSweepBatch');
        continue;
      }
      const stray = strayRecords('npm', chunk.map(packageOf), answer.records).length;
      sweep.stray += stray;
      bump(run.incomplete, 'npmStray', stray);
      const comparison = compareNpm(chunk, answer, plan.known);
      add(sweep.gaps, comparison.gaps);
      add(sweep.extras, comparison.extras);
      tallyNpm(run, comparison, plan.checked);
    }
  }
}

/**
 * npm: singleton queries versus versioned batches at halving sizes, with a positive last, then a
 * sweep that carries every target at each page size and checks both directions on every batch.
 * A singleton that did not complete has no known answer, so it is counted and never compared.
 */
async function probeNpm(run: Run, targets: readonly Target[], section: NpmSection) {
  const group = targets.filter((t) => t.ecosystem === 'npm' && t.type === section.type);
  section.targets = group.length;
  const known = await npmSingletons(run, group, section);
  const positives = group.map(affect).filter((a) => known.get(a)?.length);
  section.singletonPositives = positives.length;
  // The spec's check needs known positives; without one, no batch can show it keeps a match.
  if (!positives.length) bump(run.incomplete, 'npmNoPositives');
  const rest = group.map(affect).filter((a) => !positives.includes(a));
  const plan: NpmPlan = { known, positives, rest, checked: new Set(), skipped: new Set() };
  await npmSizes(run, plan, section);
  await npmMaxFit(run, plan, section);
  await npmSweep(run, plan, section);
  section.positivesUnchecked = positives.filter(
    (p) => !plan.checked.has(p) && !plan.skipped.has(p),
  ).length;
  bump(run.incomplete, 'npmPositiveUnchecked', section.positivesUnchecked);
}

async function discover(run: Run, urls: readonly string[]) {
  const records: AdvisoryNames[] = [];
  let complete = true;
  for (const url of urls) {
    const answer = await query(run, url);
    records.push(...answer.records);
    complete &&= answer.complete;
  }
  return { records, complete };
}

export type DiscoverySection = {
  ecosystem: Ecosystem;
  type: QueryKind;
  targets: number;
  /** Targets the reader cannot discover either: over the spelling ceiling or the URL cap. */
  skippedUnsupported: number;
  perTargetHits: number;
  storedForms: number;
  perTargetIncomplete: number;
  batchRequests: number;
  batchComplete: boolean | null;
  stray: number | null;
  /** Null when the batch did not complete: a failed answer is not compared. */
  gaps: Counts | null;
  extras: Counts | null;
};

/** The reader's discovery URLs for one target, or null when the reader cannot discover it. */
function targetUrls(ecosystem: Ecosystem, type: QueryKind, name: string) {
  try {
    const spellings = discoverySpellings(ecosystem, name);
    return { spellings, urls: discoveryUrls(ecosystem, spellings, type) };
  } catch (error) {
    if (error instanceof AdvisoryFailure) return null;
    throw error;
  }
}

/** Discovery: per-target discovery versus one discovery batch per ecosystem and type. */
async function probeDiscovery(run: Run, targets: readonly Target[], section: DiscoverySection) {
  const { ecosystem, type } = section;
  // Discovery is package-only, so two versions of one package are one target.
  const group = [
    ...new Map(
      targets
        .filter((t) => t.ecosystem === ecosystem && t.type === type)
        .map((t) => [canonicalName(ecosystem, t.name), t]),
    ).values(),
  ];
  section.targets = group.length;
  const perTarget: { name: string; spellings: string[]; forms: string[]; complete: boolean }[] = [];
  for (const t of group) {
    const plan = targetUrls(ecosystem, type, t.name);
    if (!plan) {
      section.skippedUnsupported += 1;
      continue;
    }
    const found = await discover(run, plan.urls);
    const target = canonicalName(ecosystem, t.name);
    const forms = found.records.flatMap((r) =>
      r.packages
        .filter((p) => p.ecosystem === ecosystem && canonicalName(ecosystem, p.name) === target)
        .map((p) => p.name),
    );
    perTarget.push({
      name: t.name,
      spellings: plan.spellings,
      forms: [...new Set(forms)],
      complete: found.complete,
    });
    if (forms.length) section.perTargetHits += 1;
    section.storedForms += new Set(forms).size;
    if (!found.complete) {
      section.perTargetIncomplete += 1;
      bump(run.incomplete, 'discoveryPerTarget');
    }
  }
  if (!section.perTargetHits) bump(run.incomplete, 'discoveryNoHits');
  const urls = discoveryUrls(
    ecosystem,
    perTarget.flatMap((t) => t.spellings),
    type,
  );
  section.batchRequests = urls.length;
  if (!urls.length) return;
  const batch = await discover(run, urls);
  section.batchComplete = batch.complete;
  if (!batch.complete) {
    bump(run.incomplete, 'discoveryBatch');
    return;
  }
  // A per-target discovery that did not complete has no known answer to compare with.
  const known = perTarget.filter((t) => t.complete);
  const gaps = countBy(discoveryBatchCovers(ecosystem, known, batch.records), (g) => g.kind);
  const extras = countBy(discoveryBatchExtras(ecosystem, known, batch.records), (e) => e.kind);
  section.gaps = gaps;
  section.extras = extras;
  section.stray = strayRecords(
    ecosystem,
    perTarget.map((t) => t.name),
    batch.records,
  ).length;
  // A record naming no batched target makes the discovery batch `malformed` (D3, Validation).
  bump(run.incomplete, 'discoveryStray', section.stray);
  for (const [kind, by] of Object.entries(gaps)) bump(run.disagreements, `discovery-${kind}`, by);
  bump(run.disagreements, 'discovery-extra-form', extras.form ?? 0);
}

const tagQueryFields = (i: number) => `nameWithOwner ref(qualifiedName: $q${i}) { target { oid } }`;

async function graphqlTags(run: Run, candidates: readonly { repository: string; tag: string }[]) {
  const aliases = candidates.map((c, i) => ({ alias: `c${i}`, repository: c.repository }));
  const params = candidates.map((_, i) => `$o${i}: String!, $n${i}: String!, $q${i}: String!`);
  const fields = candidates.map(
    (_, i) => `c${i}: repository(owner: $o${i}, name: $n${i}) { ${tagQueryFields(i)} }`,
  );
  const variables: Record<string, string> = {};
  candidates.forEach((c, i) => {
    const [owner, name] = c.repository.split('/');
    Object.assign(variables, {
      [`o${i}`]: owner,
      [`n${i}`]: name,
      [`q${i}`]: `refs/tags/${c.tag}`,
    });
  });
  const body = JSON.stringify({
    query: `query(${params.join(', ')}) { ${fields.join(' ')} rateLimit { cost } }`,
    variables,
  });
  const page = await send(run, `${API}/graphql`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
  const cost =
    (page.data as { data?: { rateLimit?: { cost?: number } } } | null)?.data?.rateLimit?.cost ??
    null;
  return {
    status: page.status,
    bytes: page.bytes,
    cost,
    answered: page.status === HTTP_STATUS.ok && graphqlAnswered(page.data),
    answers: graphqlAnswers(page.data, aliases),
  };
}

export type TagSection = {
  candidates: number;
  /** Candidates C1 recorded as both found (200) and missing (404): REST itself changed. */
  restConflicts: number;
  /** Candidates in a query that failed as a whole, so they have no GraphQL answer. */
  unanswered: number;
  failedQueries: number;
  agreements: Counts;
  sizes: { size: number; status: number; bytes: number; cost: number | null; answered: boolean }[];
};

const TAG_DISAGREEMENTS = new Set(['rest-found-graphql-null', 'rest-missing-graphql-found']);

/**
 * Answers that leave a candidate uncompared, so the run is incomplete: a REST status that neither
 * finds nor misses the tag, REST answering both ways (instability, not a batch gap), and a GraphQL
 * error naming the alias, which the reader would send back to REST (item 4).
 */
const TAG_INCOMPLETE: Readonly<Record<string, string>> = {
  'rest-other': 'tagRestOther',
  'rest-conflict': 'tagRestConflict',
  'graphql-error': 'tagGraphqlError',
};

/** Tags: each candidate's recorded REST statuses versus GraphQL's answer, and cost per size. */
async function probeTags(run: Run, tags: readonly TagCandidate[], section: TagSection) {
  const candidates = distinctTags(tags);
  section.candidates = candidates.length;
  section.restConflicts = candidates.filter(
    (c) => tagAgreement(c.statuses, 'null') === 'rest-conflict',
  ).length;
  for (let i = 0; i < candidates.length; i += MAX_TAGS) {
    const chunk = candidates.slice(i, i + MAX_TAGS);
    const result = await graphqlTags(run, chunk);
    if (!result.answered) {
      section.failedQueries += 1;
      section.unanswered += chunk.length;
      bump(run.incomplete, 'tagUnanswered', chunk.length);
      continue;
    }
    chunk.forEach((c, j) => {
      const agreement = tagAgreement(c.statuses, result.answers.get(`c${j}`) ?? 'error');
      bump(section.agreements, agreement);
      if (TAG_DISAGREEMENTS.has(agreement)) bump(run.disagreements, `tag-${agreement}`);
      if (agreement in TAG_INCOMPLETE) bump(run.incomplete, TAG_INCOMPLETE[agreement]);
    });
  }
  for (const size of halvingSizes(MAX_TAGS).filter((s) => s <= candidates.length)) {
    const { status, bytes, cost, answered } = await graphqlTags(run, candidates.slice(0, size));
    section.sizes.push({ size, status, bytes, cost, answered });
  }
}

export type ProbeReport = {
  /** `complete` only when the run finished and every answer it needed was compared. */
  verdict: 'complete' | 'incomplete';
  /** True or false only for a complete run; an incomplete run proves neither. */
  equivalent: boolean | null;
  stopped?: 'budget' | 'error';
  /** The error's class name when `stopped` is `error`; never its message, which may hold a URL. */
  error?: string;
  incomplete: Counts;
  disagreements: Counts;
  /**
   * Batch sizes whose URL is over the URL cap and that GitHub refused with 414, as
   * `npmBatchRejected`. GitHub is not expected to accept them, so the verdict ignores them; any
   * other failure of such a size is counted in `incomplete`.
   */
  overUrlCap: Counts;
  probedAt: string;
  requests: number;
  inputTargets: number;
  malwareSeed: SeedStatus | null;
  npm: NpmSection[];
  discovery: DiscoverySection[];
  tags: TagSection | null;
};

const npmSection = (type: QueryKind): NpmSection => ({
  type,
  targets: 0,
  singletonIncomplete: 0,
  singletonPositives: 0,
  positivesUnchecked: 0,
  skippedUnsupported: 0,
  maxFitTargets: null,
  maxFit: null,
  sizes: [],
  sweep: [],
});

const discoverySection = (ecosystem: Ecosystem, type: QueryKind): DiscoverySection => ({
  ecosystem,
  type,
  targets: 0,
  skippedUnsupported: 0,
  perTargetHits: 0,
  storedForms: 0,
  perTargetIncomplete: 0,
  batchRequests: 0,
  batchComplete: null,
  stray: null,
  gaps: null,
  extras: null,
});

/** Every comparison in order, each section added to the report before it starts. */
async function probeAll(run: Run, input: ProbeInput, report: ProbeReport) {
  const seed = await malwareSeed(run);
  report.malwareSeed = seed.status;
  if (!seed.target) bump(run.incomplete, 'malwareSeed');
  const targets = unique([...input.targets, ...SEEDS, ...(seed.target ? [seed.target] : [])]);
  for (const type of ['reviewed', 'malware'] as const) {
    const section = npmSection(type);
    report.npm.push(section);
    await probeNpm(run, targets, section);
  }
  for (const [ecosystem, type] of [
    ['actions', 'reviewed'],
    ['actions', 'malware'],
    ['pip', 'malware'],
  ] as const) {
    const section = discoverySection(ecosystem, type);
    report.discovery.push(section);
    await probeDiscovery(run, targets, section);
  }
  report.tags = {
    candidates: 0,
    restConflicts: 0,
    unanswered: 0,
    failedQueries: 0,
    agreements: {},
    sizes: [],
  };
  await probeTags(run, input.tags, report.tags);
}

/**
 * Runs every comparison in order, adding each section to the report before it starts, so a run
 * stopped by the budget or a request error keeps every count it reached.
 */
export async function runProbe(deps: ProbeDeps): Promise<ProbeReport> {
  const run: Run = {
    token: deps.token,
    fetch: deps.fetch,
    budget: requestBudget(limit('probe.batching.maxRequests')),
    incomplete: {},
    disagreements: {},
    overUrlCap: {},
  };
  const report: ProbeReport = {
    verdict: 'incomplete',
    equivalent: null,
    incomplete: run.incomplete,
    disagreements: run.disagreements,
    overUrlCap: run.overUrlCap,
    probedAt: new Date().toISOString(),
    requests: 0,
    inputTargets: deps.input.targets.length,
    malwareSeed: null,
    npm: [],
    discovery: [],
    tags: null,
  };
  try {
    await probeAll(run, deps.input, report);
  } catch (error) {
    report.stopped = error instanceof BudgetSpent ? 'budget' : 'error';
    if (report.stopped === 'error') report.error = error instanceof Error ? error.name : 'unknown';
  }
  report.requests = run.budget.used();
  return judge(report);
}

/** Complete only when the run finished with nothing left uncompared; any disagreement is final. */
function judge(report: ProbeReport): ProbeReport {
  const complete = !report.stopped && Object.keys(report.incomplete).length === 0;
  report.verdict = complete ? 'complete' : 'incomplete';
  if (Object.keys(report.disagreements).length) report.equivalent = false;
  else report.equivalent = complete ? true : null;
  return report;
}
