import { satisfies } from 'semver';
import { expect, test } from 'vite-plus/test';
import { githubUrl } from '../../src/evidence/advisory-read.js';
import { limit } from '../../src/limits.js';
import type { TagCandidate } from '../../src/measurement/targets.js';
import { runProbe, type ProbeInput, type Target } from '../../scripts/measure-batching/probe.js';

const MAX_BATCH = limit('probe.batching.maxBatchTargets');
const MAX_TAGS = limit('probe.batching.maxTagsPerQuery');
const MAX_REQUESTS = limit('probe.batching.maxRequests');
const URL_CAP = limit('advisory.discovery.urlBytes');
const FIRST_URL_CAP = URL_CAP - limit('advisory.discovery.cursorHeadroomBytes');
const PAGE_SIZE = limit('github.pageSize');
/** The halving batch sizes below the maximum, as the probe sends them. */
const HALVED = [2, 4, 8, 16, 32, 64, 128, 256, 512].map((d) => Math.floor(MAX_BATCH / d));

type Advisory = {
  id: string;
  type: 'reviewed' | 'malware';
  packages: [ecosystem: string, name: string][];
  /** An npm range the queried version must satisfy; absent matches any version. */
  range?: string;
};

type Call = {
  method: string;
  path: string;
  affects: string[];
  perPage: number;
  aliases: number;
  urlLength: number;
  /** The continuation cursor, or null on a first page. */
  after: string | null;
};

type FakeOptions = {
  advisories?: Advisory[];
  /** The first malware advisory GitHub lists, for the seed. */
  malwareSeed?: { name: string; range: string } | null;
  /** Repositories and tags that exist, as `owner/name@tag`. */
  tags?: string[];
  /** Repositories GraphQL reports missing: a null alias with a NOT_FOUND error naming it. */
  missingRepos?: string[];
  /** Drop or add advisories for one query, given its `affects` list. */
  answer?: (affects: string[], found: Advisory[]) => Advisory[];
  /** A status to answer a query with instead of 200. */
  status?: (call: Call) => number | undefined;
  /** Throw instead of answering. */
  throws?: (call: Call) => boolean;
  /** Answer 414 to a URL longer than this, as GitHub does to one too long. */
  maxUrlLength?: number;
};

const raw = (a: Advisory) => ({
  ghsa_id: a.id,
  type: a.type,
  vulnerabilities: a.packages.map(([ecosystem, name]) => ({
    package: { ecosystem, name },
    vulnerable_version_range: a.range ?? '>= 0',
  })),
});

const json = (status: number, body: unknown, link?: string) =>
  new Response(JSON.stringify(body), { status, headers: link ? { link } : {} });

function splitAffect(entry: string): [name: string, version: string | null] {
  const at = entry.lastIndexOf('@');
  return at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : [entry, null];
}

/** A fake GitHub advisory and GraphQL API that matches `affects` entries the way GitHub does. */
function fakeGitHub(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const advisories = options.advisories ?? [];
  const tags = new Set(options.tags ?? []);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const variables = (body?.variables ?? {}) as Record<string, string>;
    const call: Call = {
      method,
      path: url.pathname,
      affects: (url.searchParams.get('affects') ?? '').split(',').filter(Boolean),
      perPage: Number(url.searchParams.get('per_page')),
      aliases: Object.keys(variables).length / 3,
      urlLength: String(input).length,
      after: url.searchParams.get('after'),
    };
    calls.push(call);
    if (options.throws?.(call)) throw new TypeError('fetch failed');
    if (call.urlLength > (options.maxUrlLength ?? Infinity))
      return json(414, { message: 'URI Too Long' });
    const status = options.status?.(call);
    if (status) return json(status, { message: 'failed' });
    if (url.pathname === '/graphql') {
      const data: Record<string, unknown> = { rateLimit: { cost: 1 } };
      const errors: unknown[] = [];
      for (let i = 0; i < call.aliases; i += 1) {
        const repository = `${variables[`o${i}`]}/${variables[`n${i}`]}`;
        if (options.missingRepos?.includes(repository)) {
          data[`c${i}`] = null;
          errors.push({ type: 'NOT_FOUND', path: [`c${i}`], message: 'Could not resolve' });
          continue;
        }
        const tag = variables[`q${i}`].replace('refs/tags/', '');
        data[`c${i}`] = {
          nameWithOwner: repository,
          ref: tags.has(`${repository}@${tag}`) ? { target: { oid: 'abc' } } : null,
        };
      }
      return json(200, errors.length ? { data, errors } : { data });
    }
    const type = url.searchParams.get('type');
    if (!url.searchParams.has('affects')) {
      const seed = options.malwareSeed;
      return json(
        200,
        seed
          ? [
              raw({
                id: 'GHSA-seed',
                type: 'malware',
                packages: [['npm', seed.name]],
                range: seed.range,
              }),
            ]
          : [],
      );
    }
    const ecosystem = url.searchParams.get('ecosystem');
    let found = advisories.filter(
      (a) =>
        a.type === type &&
        call.affects.some((entry) => {
          const [name, version] = splitAffect(entry);
          return (
            a.packages.some(([e, n]) => e === ecosystem && n === name) &&
            (version === null || a.range === undefined || satisfies(version, a.range))
          );
        }),
    );
    found = options.answer?.(call.affects, found) ?? found;
    // GitHub pages advisories with an opaque `after` cursor, which lengthens each next URL.
    const offset = call.after
      ? Number(Buffer.from(call.after, 'base64').toString().split(':')[2])
      : 0;
    const slice = found.slice(offset, offset + call.perPage);
    let link: string | undefined;
    if (offset + call.perPage < found.length) {
      const next = new URL(url);
      const cursor = `cursor:v2:${offset + call.perPage}:${'Y'.repeat(40)}`;
      next.searchParams.set('after', Buffer.from(cursor).toString('base64'));
      link = `<${next.href}>; rel="next"`;
    }
    return json(200, slice.map(raw), link);
  };
  return { fetch, calls };
}

/** Advisories for every seed, so the fixed seeds are positives as they are on GitHub. */
const SEED_ADVISORIES: Advisory[] = [
  {
    id: 'GHSA-lodash',
    type: 'reviewed',
    packages: [
      ['npm', 'lodash'],
      ['rubygems', 'lodash-rails'],
    ],
  },
  { id: 'GHSA-babel', type: 'reviewed', packages: [['npm', '@babel/traverse']] },
  { id: 'GHSA-tj', type: 'reviewed', packages: [['actions', 'tj-actions/changed-files']] },
  { id: 'GHSA-tjm', type: 'malware', packages: [['actions', 'tj-actions/changed-files']] },
  { id: 'GHSA-flo', type: 'malware', packages: [['pip', 'flo_pro_adk']] },
];

const SEED = { name: 'evil-pkg', range: '>= 1.0.0, < 2.0.0' };
const SEED_ADVISORY: Advisory = {
  id: 'GHSA-seed',
  type: 'malware',
  packages: [['npm', 'evil-pkg']],
  range: '>=1.0.0 <2.0.0',
};

const npmTarget = (name: string, type: Target['type'] = 'reviewed'): Target => ({
  ecosystem: 'npm',
  name,
  version: '1.0.0',
  type,
});

const probe = (fake: ReturnType<typeof fakeGitHub>, input: Partial<ProbeInput> = {}) =>
  runProbe({ token: 'ghp_test', fetch: fake.fetch, input: { targets: [], tags: [], ...input } });

const tag = (repository: string, tagName: string, status: string): TagCandidate => ({
  repository,
  tag: tagName,
  status,
});

test('a run where every batch matches its per-target answers is complete and equivalent', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    tags: ['vitejs/vite@v5.0.0'],
  });
  const report = await probe(fake, {
    tags: [tag('vitejs/vite', 'v5.0.0', '200'), tag('vitejs/vite', 'v9.9.9', '404')],
  });
  expect(report).toMatchObject({
    verdict: 'complete',
    equivalent: true,
    incomplete: {},
    disagreements: {},
    malwareSeed: 'chosen',
  });
  expect(report.stopped).toBeUndefined();
  expect(report.npm.map((s) => s.singletonPositives)).toEqual([2, 1]);
  expect(report.discovery.map((s) => s.perTargetHits)).toEqual([1, 1, 1]);
  expect(report.tags?.agreements).toEqual({ agree: 2 });
});

const manyPositives = (count: number) => {
  const targets = Array.from({ length: count }, (_, i) => npmTarget(`pos-${i}`));
  const advisories: Advisory[] = targets.map((t, i) => ({
    id: `GHSA-pos-${i}`,
    type: 'reviewed',
    packages: [['npm', t.name]],
  }));
  return { targets, advisories };
};

test('the sweep checks every positive, beyond the one positive each batch size carries', async () => {
  const { targets, advisories } = manyPositives(30);
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY, ...advisories],
    malwareSeed: SEED,
  });
  const report = await probe(fake, { targets });
  expect(report.npm[0]).toMatchObject({ singletonPositives: 32, positivesUnchecked: 0 });
  expect(report.verdict).toBe('complete');
});

test('a positive missed only in a batch is found by the sweep', async () => {
  const { targets, advisories } = manyPositives(30);
  // pos-25 is never the positive placed last in a batch size, so only the sweep carries it.
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY, ...advisories],
    malwareSeed: SEED,
    answer: (affects, found) =>
      affects.length > 1 ? found.filter((a) => a.id !== 'GHSA-pos-25') : found,
  });
  const report = await probe(fake, { targets });
  expect(report.npm[0].sizes.every((s) => !s.gaps?.absent)).toBe(true);
  expect(report.npm[0].sweep.every((s) => s.gaps.absent === 1)).toBe(true);
  expect(report.disagreements['npm-absent']).toBe(report.npm[0].sweep.length);
  expect(report.equivalent).toBe(false);
});

test('a batch returning a match the singleton lacked is a disagreement when it would be attributed', async () => {
  const extra: Advisory = { id: 'GHSA-extra', type: 'reviewed', packages: [['npm', 'lodash']] };
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    answer: (affects, found) =>
      affects.length > 1 && affects.includes('lodash@4.17.20') ? [...found, extra] : found,
  });
  const report = await probe(fake);
  expect(report.npm[0].sweep[0].extras).toEqual({ attributable: 1 });
  expect(report.disagreements['npm-extra-attributable']).toBeGreaterThan(0);
  expect(report).toMatchObject({ verdict: 'complete', equivalent: false });
});

test('a failed batch answer is incomplete, never a coverage gap', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    status: (call) => (call.affects.length >= MAX_BATCH / 4 ? 502 : undefined),
  });
  const report = await probe(fake);
  const failed = report.npm[0].sizes.filter((s) => !s.complete);
  expect(failed.map((s) => [s.size, s.overUrlCap])).toEqual([
    [MAX_BATCH + 1, true],
    [MAX_BATCH, true],
    [MAX_BATCH / 2, true],
    [MAX_BATCH / 4, true],
  ]);
  expect(failed.every((s) => s.gaps === null && s.extras === null)).toBe(true);
  expect(report.disagreements).toEqual({});
  // A failure other than a 414 counts even over the URL cap; above the maximum it is not counted.
  expect(report.incomplete).toEqual({ npmBatch: 6 });
  expect(report.overUrlCap).toEqual({});
  expect(report).toMatchObject({ verdict: 'incomplete', equivalent: null });
});

test('a failed discovery batch is incomplete, never a coverage gap', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    status: (call) => (call.affects.length > 9 ? 502 : undefined),
  });
  const report = await probe(fake);
  const pip = report.discovery[2];
  expect(pip).toMatchObject({ batchComplete: false, gaps: null, extras: null });
  expect(report.disagreements).toEqual({});
  expect(report.incomplete.discoveryBatch).toBe(1);
});

test('npm batches reach the register maximum and one more, and the sweep splits a larger group at the maximum', async () => {
  const targets = Array.from({ length: MAX_BATCH + 1 }, (_, i) => npmTarget(`neg-${i}`));
  const fake = fakeGitHub({ advisories: [...SEED_ADVISORIES, SEED_ADVISORY], malwareSeed: SEED });
  const report = await probe(fake, { targets });
  const versioned = fake.calls.filter(
    (c) => c.path === '/advisories' && c.affects.some((a) => a.lastIndexOf('@') > 0),
  );
  const sizes = versioned.map((c) => c.affects.length);
  expect(Math.max(...sizes)).toBe(MAX_BATCH + 1);
  // One batch per advisory type goes above the maximum; nothing else does.
  expect(sizes.filter((s) => s > MAX_BATCH)).toEqual([MAX_BATCH + 1, MAX_BATCH + 1]);
  expect(report.npm[0].sizes.map((s) => s.size)).toEqual([MAX_BATCH + 1, MAX_BATCH, ...HALVED]);
  expect(HALVED.at(-1)).toBe(1);
  // Reviewed: the extra targets plus two seeds split into sweep batches of at most the maximum,
  // each within the URL cap, together carrying every target once.
  for (const sweep of report.npm[0].sweep) {
    expect(sweep.batches).toBeGreaterThan(1);
    expect(sweep.results.every((r) => r.targets <= MAX_BATCH && r.urlLength <= URL_CAP)).toBe(true);
    expect(sweep.results.reduce((sum, r) => sum + r.targets, 0)).toBe(MAX_BATCH + 3);
  }
  expect(report.npm[1].sweep.every((s) => s.batches === 1)).toBe(true);
  expect(report.verdict).toBe('complete');
});

test('tag queries carry at most the register maximum, and one more candidate starts a second query', async () => {
  const tags = Array.from({ length: MAX_TAGS + 1 }, (_, i) =>
    tag(`owner/repo-${i}`, `v${i}`, '404'),
  );
  const fake = fakeGitHub({ advisories: [...SEED_ADVISORIES, SEED_ADVISORY], malwareSeed: SEED });
  const report = await probe(fake, { tags });
  const graphql = fake.calls.filter((c) => c.path === '/graphql').map((c) => c.aliases);
  expect(graphql.slice(0, 2)).toEqual([MAX_TAGS, 1]);
  expect(Math.max(...graphql)).toBe(MAX_TAGS);
  expect(report.tags?.sizes.map((s) => s.size)).toEqual([MAX_TAGS, 50, 25, 12, 6, 3, 1]);
  expect(report.tags?.agreements).toEqual({ agree: MAX_TAGS + 1 });
});

test('at the register request cap the next request is not sent and the report keeps what was measured', async () => {
  const targets = Array.from({ length: MAX_REQUESTS }, (_, i) => npmTarget(`neg-${i}`));
  const fake = fakeGitHub({ advisories: SEED_ADVISORIES, malwareSeed: SEED });
  const report = await probe(fake, { targets });
  expect(fake.calls).toHaveLength(MAX_REQUESTS);
  expect(report).toMatchObject({
    stopped: 'budget',
    requests: MAX_REQUESTS,
    verdict: 'incomplete',
    equivalent: null,
  });
  expect(report.malwareSeed).toBe('chosen');
  expect(report.npm).toHaveLength(1);
  expect(report.npm[0]).toMatchObject({ targets: MAX_REQUESTS + 2, singletonIncomplete: 0 });
});

test('a request error stops the run but keeps every section it reached', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    throws: (call) => call.path === '/graphql',
  });
  const report = await probe(fake, { tags: [tag('vitejs/vite', 'v5.0.0', '404')] });
  expect(report).toMatchObject({ stopped: 'error', error: 'TypeError', verdict: 'incomplete' });
  expect(report.npm.map((s) => s.singletonPositives)).toEqual([2, 1]);
  expect(report.discovery).toHaveLength(3);
  expect(report.tags?.candidates).toBe(1);
  expect(JSON.stringify(report)).not.toContain('fetch failed');
});

test('REST statuses decide only when found or missing; both is a named conflict, not a gap', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    tags: ['vitejs/vite@v5.0.0'],
  });
  const report = await probe(fake, {
    tags: [
      // A failed read beside a decisive 404 is ignored.
      tag('vitejs/vite', 'v1.0.0', '404'),
      tag('vitejs/vite', 'v1.0.0', '502'),
      // Found and missing: REST changed its answer.
      tag('vitejs/vite', 'v5.0.0', '404'),
      tag('vitejs/vite', 'v5.0.0', '200'),
      // No decisive status at all.
      tag('vitejs/vite', 'v2.0.0', '502'),
    ],
  });
  expect(report.tags).toMatchObject({
    candidates: 3,
    restConflicts: 1,
    agreements: { agree: 1, 'rest-conflict': 1, 'rest-other': 1 },
  });
  expect(report.disagreements).toEqual({});
  expect(report.incomplete).toEqual({ tagRestConflict: 1, tagRestOther: 1 });
  expect(report).toMatchObject({ verdict: 'incomplete', equivalent: null });
});

test('a GraphQL error naming one alias leaves that candidate uncompared', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    missingRepos: ['gone/repo'],
  });
  const report = await probe(fake, {
    tags: [tag('gone/repo', 'v1.0.0', '404'), tag('vitejs/vite', 'v9.9.9', '404')],
  });
  expect(report.tags?.agreements).toEqual({ agree: 1, 'graphql-error': 1 });
  expect(report.disagreements).toEqual({});
  expect(report.incomplete).toEqual({ tagGraphqlError: 1 });
  expect(report).toMatchObject({ verdict: 'incomplete', equivalent: null });
});

const isVersioned = (call: Call) =>
  call.affects.length > 0 && call.affects.every((a) => a.lastIndexOf('@') > 0);

test('failed npm batches and sweep batches, and a positive no batch checked, are each counted', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    status: (call) => (isVersioned(call) && call.affects.length > 1 ? 502 : undefined),
  });
  const report = await probe(fake);
  // Nine sizes per type fail (the one above the maximum is not counted, and size one succeeds),
  // over the URL cap or not, and so does each type's batch at the proposed maximum. Reviewed's
  // sweep batch of two fails at each page size, so @babel/traverse is never checked.
  expect(report.incomplete).toEqual({
    npmBatch: 18,
    npmMaxFitIncomplete: 2,
    npmSweepBatch: 7,
    npmPositiveUnchecked: 1,
  });
  expect(report.overUrlCap).toEqual({});
  expect(report.npm[0].positivesUnchecked).toBe(1);
  expect(report.disagreements).toEqual({});
});

test('sizes GitHub rejects as too long are reported as rejected and do not block complete', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    maxUrlLength: URL_CAP,
  });
  const report = await probe(fake);
  const rejected = report.npm[0].sizes.filter((s) => s.status === 414);
  expect(rejected.map((s) => s.size)).toEqual([
    MAX_BATCH + 1,
    MAX_BATCH,
    MAX_BATCH / 2,
    MAX_BATCH / 4,
  ]);
  expect(rejected.every((s) => s.rejected && s.overUrlCap && s.urlLength > URL_CAP)).toBe(true);
  expect(report.npm.every((s) => s.maxFit?.complete && s.maxFit.positiveLast)).toBe(true);
  // The batch above the documented maximum is recorded but not counted.
  expect(report.overUrlCap).toEqual({ npmBatchRejected: 6 });
  expect(report).toMatchObject({ verdict: 'complete', equivalent: true, incomplete: {} });
});

test('a 414 to a size that fits the URL cap still leaves the run incomplete', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    status: (call) => (isVersioned(call) && call.affects.length === HALVED[3] ? 414 : undefined),
  });
  const report = await probe(fake);
  expect(report.npm[0].sizes.find((s) => s.size === HALVED[3])).toMatchObject({
    overUrlCap: false,
    rejected: true,
  });
  expect(report.npm.every((s) => s.maxFitTargets !== HALVED[3])).toBe(true);
  expect(report.incomplete).toEqual({ npmBatchUrlTooLong: 2 });
  expect(report.verdict).toBe('incomplete');
});

/** A corpus like L8's reviewed group: many scoped names, a few of them positives. */
const longCorpus = (count: number, positives: number) => {
  const targets = Array.from({ length: count }, (_, i) =>
    npmTarget(`@corpus-scope-${i}/a-longer-package-name-${i}`),
  );
  const advisories: Advisory[] = targets.slice(0, positives).map((t, i) => ({
    id: `GHSA-long-${i}`,
    type: 'reviewed',
    packages: [['npm', t.name]],
  }));
  return {
    targets,
    advisories,
    positives: new Set(targets.slice(0, positives).map((t) => t.name)),
  };
};

/** The distinct sweep batches sent at the smallest page size, which only the sweep uses. */
const sweepBatches = (calls: readonly Call[]) => [
  ...new Map(
    calls.filter((c) => c.perPage === 1 && isVersioned(c)).map((c) => [c.affects.join(','), c]),
  ).values(),
];

test('the sweep splits a group by URL length, so every batch fits and every positive is checked', async () => {
  const corpus = longCorpus(278, 15);
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY, ...corpus.advisories],
    malwareSeed: SEED,
    maxUrlLength: URL_CAP,
  });
  const report = await probe(fake, { targets: corpus.targets });
  const [reviewed] = report.npm;
  expect(reviewed).toMatchObject({ singletonPositives: 17, positivesUnchecked: 0 });
  expect(reviewed.sweep).toHaveLength(7);
  for (const sweep of reviewed.sweep) {
    expect(sweep.batches).toBeGreaterThan(1);
    expect(sweep.complete).toBe(true);
    expect(sweep.results.every((r) => r.status === 200 && r.urlLength <= URL_CAP)).toBe(true);
  }
  // Every sweep batch carries a positive, and each batch's positives come last.
  const isPositive = (entry: string) =>
    corpus.positives.has(entry.slice(0, entry.lastIndexOf('@'))) ||
    ['lodash@4.17.20', '@babel/traverse@7.22.0'].includes(entry);
  const batches = sweepBatches(fake.calls).filter((c) =>
    c.affects.some((a) => a.startsWith('@corpus')),
  );
  expect(batches).toHaveLength(reviewed.sweep[0].batches);
  for (const { affects } of batches) {
    const first = affects.findIndex(isPositive);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(affects.slice(first).every(isPositive)).toBe(true);
  }
  expect(report).toMatchObject({ verdict: 'complete', equivalent: true, incomplete: {} });
});

test('a sweep batch GitHub rejects as too long is recorded and counted apart from other failures', async () => {
  const corpus = longCorpus(278, 15);
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY, ...corpus.advisories],
    malwareSeed: SEED,
    // Shorter than the cap: the longest sweep batches are rejected as GitHub would.
    maxUrlLength: URL_CAP / 2,
  });
  const report = await probe(fake, { targets: corpus.targets });
  const results = report.npm[0].sweep.flatMap((s) => s.results);
  const tooLong = results.filter((r) => r.urlLength > URL_CAP / 2);
  expect(tooLong.length).toBeGreaterThan(0);
  expect(tooLong.every((r) => r.status === 414 && !r.complete)).toBe(true);
  expect(results.filter((r) => r.status !== 414).every((r) => r.status === 200)).toBe(true);
  expect(report.incomplete.npmSweepBatchRejected).toBe(tooLong.length);
  expect(report.incomplete.npmSweepBatch).toBeUndefined();
  expect(report.verdict).toBe('incomplete');
});

test('a target whose URL alone is over the cap is skipped as unsupported, not left unchecked', async () => {
  const name = `long-${'x'.repeat(URL_CAP)}`;
  const advisory: Advisory = { id: 'GHSA-long', type: 'reviewed', packages: [['npm', name]] };
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY, advisory],
    malwareSeed: SEED,
    // Its singleton is answered, so it is a known positive; every batch carrying it is too long.
    status: (call) => (call.affects.length > 1 && call.urlLength > URL_CAP ? 414 : undefined),
  });
  const report = await probe(fake, { targets: [npmTarget(name)] });
  expect(report.npm[0]).toMatchObject({
    singletonPositives: 3,
    skippedUnsupported: 1,
    positivesUnchecked: 0,
  });
  const swept = sweepBatches(fake.calls).flatMap((c) => c.affects);
  expect(swept.some((a) => a.startsWith('long-'))).toBe(false);
  expect(report).toMatchObject({ verdict: 'complete', incomplete: {} });
});

test('a failed singleton is counted and leaves its package unjudged in both directions', async () => {
  // pkgx@1.0.0's singleton fails, and it precedes pkgx@2.0.0, whose singleton completes empty.
  const pkgx: Advisory = {
    id: 'GHSA-pkgx',
    type: 'reviewed',
    packages: [['npm', 'pkgx']],
    range: '<2.0.0',
  };
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY, pkgx],
    malwareSeed: SEED,
    status: (call) =>
      call.affects.length === 1 && ['pkgx@1.0.0', 'lodash@4.17.20'].includes(call.affects[0])
        ? 502
        : undefined,
  });
  const report = await probe(fake, {
    targets: [npmTarget('pkgx'), { ...npmTarget('pkgx'), version: '2.0.0' }],
  });
  expect(report.npm[0]).toMatchObject({ singletonIncomplete: 2, singletonPositives: 1 });
  expect(report.incomplete).toEqual({ npmSingleton: 2 });
  expect(report.disagreements).toEqual({});
});

const FLO_BATCH = (affects: string[]) => affects.includes('flo_pro_adk') && affects.length > 9;

test('a failed per-target discovery is counted and never compared with the batch', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    status: (call) =>
      call.affects.includes('flo_pro_adk') && call.affects.length === 9 ? 502 : undefined,
  });
  const report = await probe(fake);
  expect(report.discovery[2]).toMatchObject({ perTargetIncomplete: 1, batchComplete: true });
  expect(report.incomplete).toEqual({ discoveryPerTarget: 1, discoveryNoHits: 1 });
  expect(report.disagreements).toEqual({});
});

test('a stored form the discovery batch misses is a disagreement', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    answer: (affects, found) =>
      FLO_BATCH(affects) ? found.filter((a) => a.id !== 'GHSA-flo') : found,
  });
  const report = await probe(fake);
  expect(report.disagreements).toEqual({ 'discovery-absent': 1 });
  expect(report.incomplete).toEqual({});
  expect(report.equivalent).toBe(false);
});

test('a stored form only the discovery batch returns is a disagreement', async () => {
  const extra: Advisory = { id: 'GHSA-flo2', type: 'malware', packages: [['pip', 'Flo.Pro.Adk']] };
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    answer: (affects, found) => (FLO_BATCH(affects) ? [...found, extra] : found),
  });
  const report = await probe(fake);
  expect(report.discovery[2].extras).toEqual({ form: 1 });
  expect(report.disagreements).toEqual({ 'discovery-extra-form': 1 });
  expect(report.equivalent).toBe(false);
});

test('a batch record naming two batched packages is counted but is not a disagreement', async () => {
  const shared: Advisory = {
    id: 'GHSA-shared',
    type: 'reviewed',
    packages: [
      ['npm', 'lodash'],
      ['npm', '@babel/traverse'],
    ],
  };
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    answer: (affects, found) =>
      affects.length > 1 &&
      affects.includes('lodash@4.17.20') &&
      affects.includes('@babel/traverse@7.22.0')
        ? [...found, shared]
        : found,
  });
  const report = await probe(fake);
  expect(report.npm[0].sweep[0].extras).toEqual({ shared: 2 });
  expect(report.disagreements).toEqual({});
  expect(report).toMatchObject({ verdict: 'complete', equivalent: true });
});

test('a section with no known positive or no discovery hit leaves the run incomplete', async () => {
  const fake = fakeGitHub({
    advisories: SEED_ADVISORIES.filter((a) => a.id !== 'GHSA-tjm'),
    malwareSeed: null,
  });
  const report = await probe(fake);
  expect(report.incomplete).toEqual({ malwareSeed: 1, npmNoPositives: 1, discoveryNoHits: 1 });
});

test('batch records naming no batched package are counted as incomplete', async () => {
  const npmStray: Advisory = {
    id: 'GHSA-npm-stray',
    type: 'reviewed',
    packages: [['npm', 'other']],
  };
  const pipStray: Advisory = {
    id: 'GHSA-pip-stray',
    type: 'malware',
    packages: [['pip', 'other']],
  };
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    answer: (affects, found) => {
      if (FLO_BATCH(affects)) return [...found, pipStray];
      return affects.includes('lodash@4.17.20') && affects.length > 1
        ? [...found, npmStray]
        : found;
    },
  });
  const report = await probe(fake);
  // lodash is last in the batches of 1,001 (not counted), 500, 125, 31, and 7 and at the proposed
  // maximum, and is in reviewed's sweep batch at each of its seven page sizes.
  expect(report.npm[0].sizes.filter((s) => s.stray).map((s) => s.size)).toEqual([
    MAX_BATCH + 1,
    MAX_BATCH / 2,
    MAX_BATCH / 8,
    HALVED[4],
    HALVED[6],
  ]);
  expect(report.npm[0].maxFit?.stray).toBe(1);
  expect(report.npm[0].sweep.every((s) => s.stray === 1)).toBe(true);
  expect(report.discovery[2].stray).toBe(1);
  expect(report.incomplete).toEqual({ npmStray: 12, discoveryStray: 1 });
});

test('discovery counts one target per canonical package name', async () => {
  const fake = fakeGitHub({ advisories: [...SEED_ADVISORIES, SEED_ADVISORY], malwareSeed: SEED });
  const tj = { ecosystem: 'actions', name: 'TJ-Actions/Changed-Files', type: 'reviewed' } as const;
  const report = await probe(fake, {
    targets: [
      { ...tj, version: '44.0.0' },
      { ...tj, version: '45.0.7' },
    ],
  });
  expect(report.discovery[0]).toMatchObject({ targets: 1, perTargetHits: 1 });
  expect(report.verdict).toBe('complete');
});

test('a GraphQL query that fails as a whole leaves its candidates unanswered, not disagreeing', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    status: (call) => (call.path === '/graphql' ? 502 : undefined),
  });
  const report = await probe(fake, { tags: [tag('vitejs/vite', 'v5.0.0', '404')] });
  expect(report.tags).toMatchObject({ unanswered: 1, failedQueries: 1, agreements: {} });
  expect(report.disagreements).toEqual({});
  expect(report.incomplete).toEqual({ tagUnanswered: 1 });
});

test('the malware seed is queried at a version inside its range', async () => {
  const seed = { name: 'evil-pkg', range: '< 2.0.0' };
  const advisory: Advisory = { ...SEED_ADVISORY, range: '<2.0.0' };
  const fake = fakeGitHub({ advisories: [...SEED_ADVISORIES, advisory], malwareSeed: seed });
  const report = await probe(fake);
  const singleton = fake.calls.find(
    (c) => c.affects.length === 1 && c.affects[0].startsWith('evil-pkg@'),
  );
  expect(satisfies(singleton?.affects[0].split('@')[1] ?? '', '<2.0.0')).toBe(true);
  expect(report.npm[1].singletonPositives).toBe(1);
});

test('a malware seed with no version in its range is reported and not used', async () => {
  const fake = fakeGitHub({
    advisories: SEED_ADVISORIES,
    malwareSeed: { name: 'evil-pkg', range: '>= 2.0.0, < 1.0.0' },
  });
  const report = await probe(fake);
  expect(report.malwareSeed).toBe('no-version-in-range');
  expect(fake.calls.some((c) => c.affects.some((a) => a.startsWith('evil-pkg')))).toBe(false);
  expect(report).toMatchObject({ verdict: 'incomplete', incomplete: { malwareSeed: 1 } });
});

/** The first URL of a versioned npm batch at the longest `per_page` form, as the probe sizes it. */
const batchUrlLength = (affects: string[], type: Target['type'] = 'reviewed') =>
  githubUrl('npm', affects, type, String(PAGE_SIZE)).length;

/** An npm package name whose one-target batch URL at the longest page size is `length` long. */
const nameForUrl = (length: number, type: Target['type'] = 'reviewed') => {
  const base = batchUrlLength(['m@1.0.0'], type);
  return `m${'x'.repeat(length - base)}`;
};

const firstPages = (calls: readonly Call[]) => calls.filter((c) => c.after === null);
const FILLER = /^dua-probe-filler-/u;

test('a positive-last batch at the proposed maximum is sent and is the largest whose first URL fits', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    maxUrlLength: URL_CAP,
  });
  const report = await probe(fake);
  const [reviewed] = report.npm;
  const size = reviewed.maxFitTargets ?? 0;
  expect(size).toBeGreaterThan(1);
  expect(reviewed.maxFit).toMatchObject({ size, complete: true, positiveLast: true });
  expect(reviewed.maxFit?.urlLength).toBeLessThanOrEqual(FIRST_URL_CAP);
  const sent = firstPages(fake.calls).find(
    (c) =>
      c.perPage === PAGE_SIZE && c.affects.length === size && c.affects.some((a) => FILLER.test(a)),
  );
  expect(sent?.affects.at(-1)).toBe('lodash@4.17.20');
  // One more target would not leave the cursor headroom.
  const affects = sent?.affects ?? [];
  const larger = [
    ...affects.slice(0, -1),
    `dua-probe-filler-${size - 1}@1.0.0`,
    ...affects.slice(-1),
  ];
  expect(batchUrlLength(larger)).toBeGreaterThan(FIRST_URL_CAP);
  expect(report).toMatchObject({ verdict: 'complete', incomplete: {} });
});

test('the batch at the proposed maximum must complete for the run to be complete', async () => {
  // The proposed maximum is sent after the halving sizes; fail only a padded batch sent again.
  const seen = new Set<string>();
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    status: (call) => {
      if (!call.affects.some((a) => FILLER.test(a)) || call.after) return undefined;
      const key = `${call.perPage} ${call.affects.join()}`;
      if (seen.has(key)) return 502;
      seen.add(key);
      return undefined;
    },
  });
  const report = await probe(fake);
  expect(report.npm.map((s) => s.maxFit?.status)).toEqual([502, 502]);
  expect(report.npm.every((s) => s.sizes.every((b) => b.complete))).toBe(true);
  expect(report.incomplete).toEqual({ npmMaxFitIncomplete: 2 });
  expect(report.verdict).toBe('incomplete');
});

test('a URL of exactly the cap is inside it and one byte longer is over it', async () => {
  for (const [length, overUrlCap] of [
    [URL_CAP, false],
    [URL_CAP + 1, true],
  ] as const) {
    const name = nameForUrl(length, 'malware');
    const advisory: Advisory = { id: 'GHSA-edge', type: 'malware', packages: [['npm', name]] };
    let sent = 0;
    const fake = fakeGitHub({
      advisories: [...SEED_ADVISORIES, advisory],
      malwareSeed: null,
      // The singleton is answered; every batch after it that carries the target is refused.
      status: (call) =>
        call.affects.some((a) => a.startsWith(name)) && sent++ > 0 ? 414 : undefined,
    });
    const report = await probe(fake, { targets: [npmTarget(name, 'malware')] });
    const malware = report.npm[1];
    const one = malware.sizes.find((s) => s.size === 1);
    expect(one?.urlLength, String(length)).toBe(length);
    expect(one?.overUrlCap, String(length)).toBe(overUrlCap);
    expect(report.incomplete.npmBatchUrlTooLong, String(length)).toBe(overUrlCap ? undefined : 1);
  }
});

test('the sweep fits each first URL at the longest page size, leaving the cursor headroom', async () => {
  const fitting = nameForUrl(FIRST_URL_CAP);
  const tooLong = nameForUrl(FIRST_URL_CAP + 1);
  const fake = fakeGitHub({ advisories: [...SEED_ADVISORIES, SEED_ADVISORY], malwareSeed: SEED });
  const report = await probe(fake, { targets: [npmTarget(fitting), npmTarget(tooLong)] });
  expect(report.npm[0].skippedUnsupported).toBe(1);
  const swept = sweepBatches(fake.calls).flatMap((c) => c.affects);
  expect(swept).toContain(`${fitting}@1.0.0`);
  expect(swept).not.toContain(`${tooLong}@1.0.0`);
});

test('each sweep batch records its longest page URL, cursor included, and first URLs leave the headroom', async () => {
  const corpus = longCorpus(278, 15);
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY, ...corpus.advisories],
    malwareSeed: SEED,
    maxUrlLength: URL_CAP,
  });
  const report = await probe(fake, { targets: corpus.targets });
  const smallest = report.npm[0].sweep.at(-1);
  const batches = sweepBatches(fake.calls).filter((c) =>
    c.affects.some((a) => a.startsWith('@corpus')),
  );
  expect(batches.length).toBeGreaterThan(1);
  batches.forEach(({ affects }, i) => {
    const pages = fake.calls.filter((c) => c.perPage === 1 && c.affects.join() === affects.join());
    const first = pages.find((c) => c.after === null);
    expect(pages.length).toBeGreaterThan(1);
    expect(first?.urlLength).toBeLessThanOrEqual(FIRST_URL_CAP - 2);
    expect(smallest?.results[i].urlLength).toBe(Math.max(...pages.map((c) => c.urlLength)));
    expect(smallest?.results[i].urlLength).toBeGreaterThan(first?.urlLength ?? Infinity);
  });
});
