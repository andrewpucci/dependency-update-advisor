import { satisfies } from 'semver';
import { expect, test } from 'vite-plus/test';
import { limit } from '../../src/limits.js';
import type { TagCandidate } from '../../src/measurement/targets.js';
import { runProbe, type ProbeInput, type Target } from '../../scripts/measure-batching/probe.js';

const MAX_BATCH = limit('probe.batching.maxBatchTargets');
const MAX_TAGS = limit('probe.batching.maxTagsPerQuery');
const MAX_REQUESTS = limit('probe.batching.maxRequests');

type Advisory = {
  id: string;
  type: 'reviewed' | 'malware';
  packages: [ecosystem: string, name: string][];
  /** An npm range the queried version must satisfy; absent matches any version. */
  range?: string;
};

type Call = { method: string; path: string; affects: string[]; perPage: number; aliases: number };

type FakeOptions = {
  advisories?: Advisory[];
  /** The first malware advisory GitHub lists, for the seed. */
  malwareSeed?: { name: string; range: string } | null;
  /** Repositories and tags that exist, as `owner/name@tag`. */
  tags?: string[];
  /** Drop or add advisories for one query, given its `affects` list. */
  answer?: (affects: string[], found: Advisory[]) => Advisory[];
  /** A status to answer a query with instead of 200. */
  status?: (call: Call) => number | undefined;
  /** Throw instead of answering. */
  throws?: (call: Call) => boolean;
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
    };
    calls.push(call);
    if (options.throws?.(call)) throw new TypeError('fetch failed');
    const status = options.status?.(call);
    if (status) return json(status, { message: 'failed' });
    if (url.pathname === '/graphql') {
      const data: Record<string, unknown> = { rateLimit: { cost: 1 } };
      for (let i = 0; i < call.aliases; i += 1) {
        const repository = `${variables[`o${i}`]}/${variables[`n${i}`]}`;
        const tag = variables[`q${i}`].replace('refs/tags/', '');
        data[`c${i}`] = {
          nameWithOwner: repository,
          ref: tags.has(`${repository}@${tag}`) ? { target: { oid: 'abc' } } : null,
        };
      }
      return json(200, { data });
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
    const page = Number(url.searchParams.get('page') ?? '1');
    const slice = found.slice((page - 1) * call.perPage, page * call.perPage);
    let link: string | undefined;
    if (page * call.perPage < found.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
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
    status: (call) => (call.affects.length >= MAX_BATCH / 2 ? 502 : undefined),
  });
  const report = await probe(fake);
  const failed = report.npm[0].sizes.filter((s) => !s.complete);
  expect(failed.map((s) => s.size)).toEqual([MAX_BATCH + 1, MAX_BATCH, MAX_BATCH / 2]);
  expect(failed.every((s) => s.gaps === null && s.extras === null)).toBe(true);
  expect(report.disagreements).toEqual({});
  // The batch above the documented maximum is recorded but not counted.
  expect(report.incomplete).toEqual({ npmBatch: 4 });
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
  expect(report.npm[0].sizes.map((s) => s.size)).toEqual([
    MAX_BATCH + 1,
    MAX_BATCH,
    500,
    250,
    125,
    62,
    31,
    15,
    7,
    3,
    1,
  ]);
  // Reviewed: the extra targets plus two seeds need two sweep batches of at most the maximum.
  expect(report.npm[0].sweep.every((s) => s.batches === 2)).toBe(true);
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

test('conflicting REST statuses for one tag are reported, not collapsed', async () => {
  const fake = fakeGitHub({
    advisories: [...SEED_ADVISORIES, SEED_ADVISORY],
    malwareSeed: SEED,
    tags: ['vitejs/vite@v5.0.0'],
  });
  const report = await probe(fake, {
    tags: [tag('vitejs/vite', 'v5.0.0', '404'), tag('vitejs/vite', 'v5.0.0', '200')],
  });
  expect(report.tags).toMatchObject({
    candidates: 1,
    restConflicts: 1,
    agreements: { 'rest-conflict': 1 },
  });
  expect(report.disagreements).toEqual({ 'tag-rest-conflict': 1 });
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
