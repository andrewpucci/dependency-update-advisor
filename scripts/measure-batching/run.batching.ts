/**
 * The batching equivalence probe (#389, C2 of the batching track): replays C1's recorded targets
 * and tag candidates both ways, per target and batched, with no model call and no write.
 * Usage: GITHUB_TOKEN=... npm run probe:batching
 * Optional: MEASURE_TARGETS_IN (a C1 targets file under `.context/`, from `MEASURE_TARGETS_OUT`),
 * PROBE_OUT (write the JSON report to this path). The fixed seeds always run.
 * The report holds counts, sizes, and disagreements by kind only: no token, URL query, or
 * response body, and no package or tag name. Every request counts against
 * `probe.batching.maxRequests`; a run that spends it says so and stops.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vite-plus/test';
import { HTTP_STATUS } from '../../src/format.js';
import { limit } from '../../src/limits.js';
import {
  advisoryBatchCovers,
  advisoryNames,
  BudgetSpent,
  canonicalName,
  countBy,
  discoveryBatchCovers,
  graphqlAnswers,
  halvingSizes,
  requestBudget,
  strayRecords,
  tagAnswersAgree,
  type AdvisoryNames,
  type Ecosystem,
} from '../../src/measurement/batching.js';
import type { SettledTarget, TagCandidate } from '../../src/measurement/targets.js';

type Type = 'reviewed' | 'malware';
type Target = { ecosystem: Ecosystem; name: string; version: string; type: Type };

const env = process.env;
const API = 'https://api.github.com';
const contextDir = fileURLToPath(new URL('../../.context/', import.meta.url));
const budget = requestBudget(limit('probe.batching.maxRequests'));
const PAGE_SIZE = limit('github.pageSize');
const DISCOVERY_PAGE = limit('advisory.discovery.pageSize');
const DISCOVERY_URL_CAP =
  limit('advisory.discovery.urlBytes') - limit('advisory.discovery.cursorHeadroomBytes');
const SPELLING_CEILING = limit('advisory.discovery.spellingCeiling');
const MAX_BATCH = limit('probe.batching.maxBatchTargets');
const MAX_TAGS = limit('probe.batching.maxTagsPerQuery');
const PIP_SEPARATORS = ['-', '_', '.'];

/** The fixed seeds (#389 as reconciled by D4): known positives and a three-separator name. */
const SEEDS: Target[] = [
  { ecosystem: 'npm', name: 'lodash', version: '4.17.20', type: 'reviewed' },
  { ecosystem: 'npm', name: '@babel/traverse', version: '7.22.0', type: 'reviewed' },
  { ecosystem: 'actions', name: 'tj-actions/changed-files', version: '45.0.7', type: 'reviewed' },
  { ecosystem: 'actions', name: 'tj-actions/changed-files', version: '45.0.7', type: 'malware' },
  { ecosystem: 'pip', name: 'flo-pro-adk', version: '1.0.0', type: 'malware' },
  { ecosystem: 'pip', name: 'google-cloud-bigquery-storage', version: '1.0.0', type: 'malware' },
];

function contextPath(value: string): string {
  const path = resolve(value);
  if (!path.startsWith(contextDir.endsWith(sep) ? contextDir : contextDir + sep))
    throw new Error('MEASURE_TARGETS_IN must be a path under .context/');
  return path;
}

type Page = { status: number; bytes: number; data: unknown; link: string | null };

async function send(token: string, url: string, init: RequestInit = {}): Promise<Page> {
  budget.spend();
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${token}`,
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
  records: AdvisoryNames[];
  malformed: number;
  /** False when a page failed, was not a list, or held a malformed record. */
  complete: boolean;
};

/** Every page of one advisory query; a non-200 page or a malformed record is kept as counts. */
async function query(token: string, url: string): Promise<Query> {
  const result: Query = {
    status: 0,
    pages: 0,
    maxPageBytes: 0,
    records: [],
    malformed: 0,
    complete: true,
  };
  for (let next: string | null = url; next;) {
    const page = await send(token, next);
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

function advisoryUrl(ecosystem: string, affects: readonly string[], type: Type, perPage: number) {
  const url = new URL(`${API}/advisories`);
  url.search = new URLSearchParams({
    ecosystem,
    affects: affects.join(','),
    type,
    per_page: String(perPage),
  }).toString();
  return url.href;
}

const key = (t: Target) => JSON.stringify([t.ecosystem, t.name, t.version, t.type]);
const unique = (targets: Target[]) => [...new Map(targets.map((t) => [key(t), t])).values()];

function loadInput(): { targets: Target[]; tags: TagCandidate[] } {
  if (!env.MEASURE_TARGETS_IN) return { targets: [], tags: [] };
  const file = JSON.parse(readFileSync(contextPath(env.MEASURE_TARGETS_IN), 'utf8')) as {
    targets?: SettledTarget[];
    tagCandidates?: TagCandidate[];
  };
  const targets = (file.targets ?? []).map(({ ecosystem, name, version, type }) => ({
    ecosystem,
    name,
    version,
    type,
  }));
  return { targets, tags: file.tagCandidates ?? [] };
}

/** The first npm malware advisory GitHub lists, as a versioned seed; its singleton says if it hits. */
async function malwareSeed(token: string): Promise<Target | null> {
  const page = await send(token, `${API}/advisories?type=malware&ecosystem=npm&per_page=1`);
  const first = Array.isArray(page.data) ? (page.data[0] as Record<string, unknown>) : null;
  const entry = (
    first?.vulnerabilities as
      | { package?: { name?: string }; vulnerable_version_range?: string }[]
      | undefined
  )?.[0];
  const name = entry?.package?.name;
  if (!name) return null;
  const version = /\d+\.\d+\.\d+/u.exec(entry.vulnerable_version_range ?? '')?.[0] ?? '1.0.0';
  return { ecosystem: 'npm', name, version, type: 'malware' };
}

const affect = (t: Target) => `${t.name}@${t.version}`;
const packageOf = (entry: string) => entry.slice(0, entry.lastIndexOf('@'));

type NpmSize = {
  size: number;
  urlLength: number;
  status: number;
  pages: number;
  records: number;
  malformed: number;
  complete: boolean;
  stray: number;
  gaps: Record<string, number>;
  positiveLast: boolean;
};

/** One versioned npm batch compared with the singleton answers of the real targets it carries. */
async function npmBatch(
  token: string,
  type: Type,
  affects: string[],
  singletons: ReadonlyMap<string, string[]>,
  positiveLast: boolean,
): Promise<NpmSize> {
  const url = advisoryUrl('npm', affects, type, PAGE_SIZE);
  const answer = await query(token, url);
  const carried = affects.filter((a) => singletons.has(a));
  const gaps = advisoryBatchCovers(
    'npm',
    carried.map((a) => ({ name: packageOf(a), ids: singletons.get(a) ?? [] })),
    answer.records,
  );
  return {
    size: affects.length,
    urlLength: url.length,
    status: answer.status,
    pages: answer.pages,
    records: answer.records.length,
    malformed: answer.malformed,
    complete: answer.complete,
    stray: strayRecords('npm', affects.map(packageOf), answer.records).length,
    gaps: countBy(gaps, (g) => g.kind),
    positiveLast,
  };
}

/**
 * npm: singleton queries versus versioned batches at halving sizes, with a positive last. A
 * singleton that did not complete has no known answer, so it is counted and never compared.
 */
async function probeNpm(token: string, targets: Target[], type: Type) {
  const group = targets.filter((t) => t.ecosystem === 'npm' && t.type === type);
  const singletons = new Map<string, string[]>();
  let singletonIncomplete = 0;
  for (const t of group) {
    const answer = await query(token, advisoryUrl('npm', [affect(t)], type, PAGE_SIZE));
    if (answer.complete)
      singletons.set(
        affect(t),
        answer.records.map((r) => r.id),
      );
    else singletonIncomplete += 1;
  }
  const positives = group.filter((t) => singletons.get(affect(t))?.length).map(affect);
  const rest = group.map(affect).filter((a) => !positives.includes(a));
  // Nonexistent filler packages pad a batch past the real targets; GitHub ignores them.
  const fill = (size: number) =>
    Array.from({ length: size }, (_, i) => rest[i] ?? `dua-probe-filler-${i}@1.0.0`);
  const sizes: NpmSize[] = [];
  for (const size of [MAX_BATCH + 1, ...halvingSizes(MAX_BATCH)]) {
    const last: string | undefined = positives[sizes.length % Math.max(positives.length, 1)];
    const affects = last ? [...fill(size - 1), last] : fill(size);
    sizes.push(await npmBatch(token, type, affects, singletons, last !== undefined));
  }
  const all = [...rest, ...positives].slice(0, MAX_BATCH);
  const perPage: { perPage: number; pages: number; maxPageBytes: number }[] = [];
  for (const size of all.length ? halvingSizes(PAGE_SIZE) : []) {
    const answer = await query(token, advisoryUrl('npm', all, type, size));
    perPage.push({ perPage: size, pages: answer.pages, maxPageBytes: answer.maxPageBytes });
  }
  return {
    type,
    targets: group.length,
    singletonIncomplete,
    singletonPositives: positives.length,
    sizes,
    perPage,
  };
}

/** Every spelling the reader's discovery sends for a target name (Package Name Form item 6). */
function spellings(ecosystem: Ecosystem, name: string): string[] {
  if (ecosystem !== 'pip') return [name];
  const parts = name.split('-');
  if (PIP_SEPARATORS.length ** (parts.length - 1) > SPELLING_CEILING) return [];
  let out = [parts[0]];
  for (const part of parts.slice(1))
    out = out.flatMap((s) => PIP_SEPARATORS.map((x) => s + x + part));
  return out;
}

/** Package-only discovery URLs under the cap, as the reader chunks them. */
function discoveryUrls(ecosystem: Ecosystem, type: Type, names: readonly string[]): string[] {
  const urls: string[] = [];
  let chunk: string[] = [];
  for (const name of names) {
    if (
      chunk.length &&
      advisoryUrl(ecosystem, [...chunk, name], type, DISCOVERY_PAGE).length > DISCOVERY_URL_CAP
    ) {
      urls.push(advisoryUrl(ecosystem, chunk, type, DISCOVERY_PAGE));
      chunk = [];
    }
    chunk.push(name);
  }
  if (chunk.length) urls.push(advisoryUrl(ecosystem, chunk, type, DISCOVERY_PAGE));
  return urls;
}

async function discover(token: string, ecosystem: Ecosystem, type: Type, names: string[]) {
  const records: AdvisoryNames[] = [];
  let complete = true;
  const urls = discoveryUrls(ecosystem, type, names);
  for (const url of urls) {
    const answer = await query(token, url);
    records.push(...answer.records);
    complete &&= answer.complete;
  }
  return { records, complete, requests: urls.length };
}

/** Discovery: per-target discovery versus one discovery batch per ecosystem and type. */
async function probeDiscovery(token: string, targets: Target[], ecosystem: Ecosystem, type: Type) {
  const group = unique(targets.filter((t) => t.ecosystem === ecosystem && t.type === type));
  const perTarget = [];
  let skipped = 0;
  for (const t of group) {
    const names = spellings(ecosystem, t.name);
    if (!names.length) {
      skipped += 1;
      continue;
    }
    const found = await discover(token, ecosystem, type, names);
    const target = canonicalName(ecosystem, t.name);
    const forms = found.records.flatMap((r) =>
      r.packages
        .filter((p) => p.ecosystem === ecosystem && canonicalName(ecosystem, p.name) === target)
        .map((p) => p.name),
    );
    perTarget.push({ name: t.name, forms: [...new Set(forms)], complete: found.complete });
  }
  const batch = await discover(
    token,
    ecosystem,
    type,
    perTarget.flatMap((t) => spellings(ecosystem, t.name)),
  );
  // A per-target discovery that did not complete has no known answer to compare with.
  const known = perTarget.filter((t) => t.complete);
  const gaps = discoveryBatchCovers(ecosystem, known, batch.records);
  return {
    ecosystem,
    type,
    targets: group.length,
    skippedOverSpellingCeiling: skipped,
    perTargetHits: perTarget.filter((t) => t.forms.length).length,
    storedForms: perTarget.reduce((n, t) => n + t.forms.length, 0),
    perTargetIncomplete: perTarget.filter((t) => !t.complete).length,
    batchRequests: batch.requests,
    batchComplete: batch.complete,
    stray: strayRecords(
      ecosystem,
      perTarget.map((t) => t.name),
      batch.records,
    ).length,
    gaps: countBy(gaps, (g) => g.kind),
  };
}

const tagQueryFields = (i: number) => `nameWithOwner ref(qualifiedName: $q${i}) { target { oid } }`;

async function graphqlTags(token: string, candidates: readonly TagCandidate[]) {
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
  const page = await send(token, `${API}/graphql`, {
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
    answers: graphqlAnswers(page.data, aliases),
  };
}

/** Tags: each candidate's recorded REST status versus GraphQL's answer, and cost per size. */
async function probeTags(token: string, tags: TagCandidate[]) {
  const candidates = [
    ...new Map(tags.map((t) => [JSON.stringify([t.repository, t.tag]), t])).values(),
  ];
  const agreements: string[] = [];
  for (let i = 0; i < candidates.length; i += MAX_TAGS) {
    const chunk = candidates.slice(i, i + MAX_TAGS);
    const { answers } = await graphqlTags(token, chunk);
    chunk.forEach((c, j) =>
      agreements.push(tagAnswersAgree(c.status, answers.get(`c${j}`) ?? 'error')),
    );
  }
  const sizes = [];
  for (const size of halvingSizes(MAX_TAGS).filter((s) => s <= candidates.length)) {
    const { status, bytes, cost } = await graphqlTags(token, candidates.slice(0, size));
    sizes.push({ size, status, bytes, cost });
  }
  return { candidates: candidates.length, agreements: countBy(agreements, (a) => a), sizes };
}

test('probe batching equivalence', async () => {
  const token = env.GITHUB_TOKEN ?? '';
  if (!token) throw new Error('GITHUB_TOKEN required');
  const input = loadInput();
  const report: Record<string, unknown> = { probedAt: new Date().toISOString() };
  try {
    const seed = await malwareSeed(token);
    const targets = unique([...input.targets, ...SEEDS, ...(seed ? [seed] : [])]);
    report.inputTargets = input.targets.length;
    report.npm = [
      await probeNpm(token, targets, 'reviewed'),
      await probeNpm(token, targets, 'malware'),
    ];
    report.discovery = [
      await probeDiscovery(token, targets, 'actions', 'reviewed'),
      await probeDiscovery(token, targets, 'actions', 'malware'),
      await probeDiscovery(token, targets, 'pip', 'malware'),
    ];
    report.tags = await probeTags(token, input.tags);
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
    report.stopped = 'budget';
  }
  report.requests = budget.used();
  const text = JSON.stringify(report, null, 2);
  if (env.PROBE_OUT) writeFileSync(env.PROBE_OUT, text + '\n');
  console.log(text);
});
