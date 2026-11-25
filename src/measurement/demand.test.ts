import { expect, test } from 'vite-plus/test';
import {
  coverageCounts,
  createDemandRecorder,
  labelReader,
  labelShare,
  readerShare,
} from './demand.js';
import { buildRegister, limit, REGISTER } from '../limits.js';
import { scaledDefinitions } from './scale.js';

const fakeFetch =
  (body = 'abc', status = 200) =>
  async (_url: string, _init: RequestInit) =>
    new Response(body, { status });

test('attributes requests to the research stage in progress', async () => {
  let t = 0;
  const now = () => t;
  const recorder = createDemandRecorder(now);
  const fetch = recorder.wrap(fakeFetch());
  const url = 'https://api.github.com/repos/o/r';

  await fetch(url, {});
  await fetch(url, {});
  recorder.observe({ kind: 'stage-start', stage: 'upstream' });
  await fetch(url, {});
  recorder.observe({ kind: 'stage-end', stage: 'upstream', outcome: 'enriched', reason: null });
  await fetch(url, {});

  const report = recorder.report({});
  expect(Object.keys(report.byPhaseHost).sort()).toEqual([
    'post-research api.github.com',
    'pre-research api.github.com',
    'upstream api.github.com',
  ]);
  expect(report.byPhaseHost['pre-research api.github.com']?.requests).toBe(2);
  expect(report.byPhaseHost['upstream api.github.com']?.requests).toBe(1);
  expect(report.byPhaseHost['post-research api.github.com']?.requests).toBe(1);
  expect(report.totalRequests).toBe(4);
});

test('counts repeated full URLs, distinguishing query strings', async () => {
  const recorder = createDemandRecorder(() => 0);
  const fetch = recorder.wrap(fakeFetch());

  await fetch('https://api.github.com/advisories?type=malware&affects=a@1', {});
  await fetch('https://api.github.com/advisories?type=malware&affects=a@1', {});
  await fetch('https://api.github.com/advisories?type=reviewed&affects=a@1', {});

  expect(recorder.report({}).repeatedUrlRequests).toBe(1);
});

test('records stage outcomes, reasons, and durations', () => {
  let t = 0;
  const recorder = createDemandRecorder(() => t);

  recorder.observe({ kind: 'stage-start', stage: 'upstream' });
  t = 50;
  recorder.observe({
    kind: 'stage-end',
    stage: 'upstream',
    outcome: 'unavailable',
    reason: 'budget',
  });

  expect(recorder.report({}).stages).toEqual([
    { stage: 'upstream', outcome: 'unavailable', reason: 'budget', ms: 50 },
  ]);
});

test('never records headers, bodies, or URLs', async () => {
  const recorder = createDemandRecorder(() => 0);
  const fetch = recorder.wrap(fakeFetch('SECRET-BODY'));

  await fetch('https://registry.npmjs.org/pkg?q=SECRET-QUERY', {
    headers: { authorization: 'Bearer SECRET-TOKEN' },
  });

  const report = recorder.report({});
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain('SECRET-BODY');
  expect(serialized).not.toContain('SECRET-TOKEN');
  expect(serialized).not.toContain('SECRET-QUERY');
  expect(report.byPhaseHost['pre-research registry.npmjs.org']?.bytes).toBe(11);
});

test('returns the original response and rethrows fetch errors', async () => {
  const response = new Response('abc', { status: 200 });
  const ok = createDemandRecorder(() => 0).wrap(async () => response);
  expect(await ok('https://registry.npmjs.org/pkg', {})).toBe(response);

  const recorder = createDemandRecorder(() => 0);
  const failing = recorder.wrap(async () => {
    throw new Error('network down');
  });
  await expect(failing('https://registry.npmjs.org/pkg', {})).rejects.toThrow('network down');
  expect(recorder.report({}).byPhaseHost['pre-research registry.npmjs.org']?.statuses).toEqual({
    error: 1,
  });
});

test('attributes each request to the share its fetch was labeled with', async () => {
  const recorder = createDemandRecorder(() => 0);
  const base = recorder.wrap(fakeFetch());
  const url = 'https://api.github.com/repos/o/r';

  await labelShare('session', base)(url, {});
  await labelShare('session', base)(url, {});
  await labelShare('transport', base)(url, {});
  await base(url, {});

  const { byShare } = recorder.report({});
  expect(Object.keys(byShare).sort()).toEqual(['session', 'transport', 'unattributed']);
  expect(byShare.session?.requests).toBe(2);
  expect(byShare.transport?.requests).toBe(1);
  expect(byShare.unattributed?.requests).toBe(1);
});

test('a nested label keeps the outermost share', async () => {
  const recorder = createDemandRecorder(() => 0);
  const base = recorder.wrap(fakeFetch());
  // The upstream reader builds its own npm registry reader; its reads count against upstream.
  await labelShare('upstream', labelShare('signals.registry', base))(
    'https://registry.npmjs.org/a',
    {},
  );

  expect(Object.keys(recorder.report({}).byShare)).toEqual(['upstream']);
});

test('concurrent requests keep their own labels', async () => {
  const recorder = createDemandRecorder(() => 0);
  const releases: (() => void)[] = [];
  const base = recorder.wrap(async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response('abc');
  });
  const url = 'https://registry.npmjs.org/a';
  const pending = [
    labelShare('advisory', base)(url, {}),
    labelShare('signals.malware', base)(url, {}),
    labelShare('signals.malware', base)(url, {}),
  ];
  while (releases.length < 3) await Promise.resolve();
  for (const release of releases.reverse()) release();
  await Promise.all(pending);

  const { byShare } = recorder.report({});
  expect(byShare.advisory?.requests).toBe(1);
  expect(byShare['signals.malware']?.requests).toBe(2);
});

test('maps each research reader to the share it reads against', () => {
  expect(readerShare('upstream', 'upstream')).toBe('upstream');
  expect(readerShare('upstream', 'signals')).toBe('signals.upstream');
  expect(readerShare('advisory', 'advisories')).toBe('advisory');
  expect(readerShare('malware', 'signals')).toBe('signals.malware');
  expect(readerShare('publishTimes', 'signals')).toBe('signals.publishTimes');
  expect(readerShare('metadata', 'pre-research')).toBe('signals.metadata');
  expect(readerShare('npmRegistry', 'signals')).toBe('signals.registry');
  // Outside the signals stage the registry reader belongs to collection's registry share or to
  // the upstream reader that built it, so it adds no label of its own.
  expect(readerShare('npmRegistry', 'pre-research')).toBeNull();
  expect(readerShare('npmRegistry', 'upstream')).toBeNull();
});

test('reports a stage that stopped short of its demand as censored', () => {
  const recorder = createDemandRecorder(() => 0);
  const end = (stage: 'upstream' | 'advisories' | 'signals' | 'revalidation', reason: any) => {
    recorder.observe({ kind: 'stage-start', stage });
    recorder.observe({ kind: 'stage-end', stage, outcome: 'unavailable', reason });
  };
  end('upstream', 'budget');
  end('advisories', 'malformed');
  end('signals', 'timeout');
  end('revalidation', 'rate_limit');

  expect(recorder.report({}).censored).toEqual([
    { stage: 'upstream', reason: 'budget' },
    { stage: 'signals', reason: 'timeout' },
    { stage: 'revalidation', reason: 'rate_limit' },
  ]);
});

test('an enriched run is not censored', () => {
  const recorder = createDemandRecorder(() => 0);
  recorder.observe({ kind: 'stage-start', stage: 'upstream' });
  recorder.observe({ kind: 'stage-end', stage: 'upstream', outcome: 'enriched', reason: null });
  expect(recorder.report({}).censored).toEqual([]);
});

test('a labeled reader factory reads against the share for the phase it was built in', async () => {
  const recorder = createDemandRecorder(() => 0);
  const base = recorder.wrap(fakeFetch());
  const factory = (_limits: null, deps: { fetch: typeof base }) => deps.fetch;
  const build = labelReader('upstream', factory, recorder.phase);
  const registry = labelReader('npmRegistry', factory, recorder.phase);
  const url = 'https://registry.npmjs.org/a';

  const upstream = build(null, { fetch: base });
  const collection = registry(null, { fetch: base });
  recorder.observe({ kind: 'stage-start', stage: 'signals' });
  const signals = build(null, { fetch: base });
  await upstream(url, {});
  await collection(url, {});
  await signals(url, {});

  expect(Object.keys(recorder.report({}).byShare).sort()).toEqual([
    'signals.upstream',
    'unattributed',
    'upstream',
  ]);
});

test('reports research GitHub requests against the R1 ceiling, with refusals and the last quota', async () => {
  const recorder = createDemandRecorder(() => 0);
  let remaining = 100;
  const fetch = recorder.wrap(async (url) =>
    new URL(url).host === 'api.github.com'
      ? new Response('{}', { headers: { 'x-ratelimit-remaining': String(remaining--) } })
      : new Response('{}', { headers: { 'x-ratelimit-remaining': '0' } }),
  );
  // A read before research spends quota but is not research's.
  await fetch('https://api.github.com/repos/o/r/pulls/1', {});
  recorder.observe({ kind: 'stage-start', stage: 'upstream' });
  await fetch('https://api.github.com/repos/o/r/releases', {});
  await fetch('https://api.github.com/repos/o/r/tags', {});
  // Another host's rate-limit header is never read as GitHub's quota.
  await fetch('https://registry.npmjs.org/pkg', {});
  recorder.observe({ kind: 'stage-end', stage: 'upstream', outcome: 'enriched', reason: null });

  const report = recorder.report({}, { refusals: () => 3 });
  expect(report.github).toEqual({
    researchRequests: 2,
    ceiling: limit('research.githubQuota.researchCeiling'),
    refusals: 3,
    lastRemaining: 98,
  });
  // No body, token, or URL reaches the report.
  expect(JSON.stringify(report)).not.toContain('repos/o/r');
});

test('without a guard, the report shows no refusals and no quota until GitHub reports one', () => {
  const report = createDemandRecorder(() => 0).report({});
  expect(report.github).toEqual({
    researchRequests: 0,
    ceiling: limit('research.githubQuota.researchCeiling'),
    refusals: 0,
    lastRemaining: null,
  });
});

test('the R1 ceiling is the sum of the research request ceilings and scales with them', () => {
  const sum = (register: ReadonlyMap<string, { value: number }>) =>
    [
      'evidence.allocation.upstream.maxRequests',
      'evidence.allocation.advisory.maxRequests',
      'evidence.allocation.signals.maxRequests',
    ].reduce((total, id) => total + (register.get(id)?.value ?? Number.NaN), 0);
  expect(limit('research.githubQuota.researchCeiling')).toBe(sum(REGISTER));
  const scaled = buildRegister(scaledDefinitions(REGISTER, 10));
  expect(scaled.get('research.githubQuota.researchCeiling')?.value).toBe(10 * sum(REGISTER));
});

test('counts only research-stage GitHub requests and keeps the latest reported quota', async () => {
  const recorder = createDemandRecorder(() => 0);
  const remaining = ['40', '30', '35', '50'];
  let call = 0;
  const fetch = recorder.wrap(
    async () =>
      new Response('{}', { headers: { 'x-ratelimit-remaining': remaining[call++] ?? '0' } }),
  );
  recorder.observe({ kind: 'stage-start', stage: 'upstream' });
  await fetch('https://api.github.com/repos/o/r/releases', {});
  recorder.observe({ kind: 'stage-end', stage: 'upstream', outcome: 'enriched', reason: null });
  // Between stages and after research, a GitHub read is not research's.
  await fetch('https://api.github.com/repos/o/r/pulls/1', {});
  recorder.observe({ kind: 'stage-start', stage: 'signals' });
  await fetch('https://api.github.com/advisories?type=malware', {});
  recorder.observe({ kind: 'stage-end', stage: 'signals', outcome: 'enriched', reason: null });
  await fetch('https://api.github.com/repos/o/r/pulls/1', {});
  const report = recorder.report({});
  expect(report.github.researchRequests).toBe(2);
  // The quota can rise when a window resets; the report keeps the latest, not the lowest.
  expect(report.github.lastRemaining).toBe(50);
});

test('counts members by evidence status and reason per category, skipping declarations', () => {
  const evidence = (status: string, reasons: string[] = []) => ({ status, reasons, sourceIds: [] });
  const coverage = coverageCounts([
    { evidence: { vulnerability: evidence('available'), malware: evidence('available') } },
    {
      evidence: {
        vulnerability: evidence('unavailable', ['budget']),
        malware: evidence('partial', ['budget', 'timeout', 'budget']),
      },
    },
    { evidence: { vulnerability: evidence('unavailable', ['budget']) } },
    { basis: 'declaration', evidence: { vulnerability: evidence('unavailable', ['missing']) } },
  ] as never);

  expect(coverage).toEqual({
    vulnerability: { available: 1, partial: 0, unavailable: 2, reasons: { budget: 2 } },
    malware: { available: 1, partial: 1, unavailable: 0, reasons: { budget: 1, timeout: 1 } },
  });
});

test('reports the coverage it is given, and none by default', () => {
  const recorder = createDemandRecorder(() => 0);
  const coverage = {
    malware: { available: 3, partial: 0, unavailable: 1, reasons: { budget: 1 } },
  };

  expect(recorder.report({}).coverage).toEqual({});
  expect(recorder.report({}, undefined, coverage).coverage).toEqual(coverage);
});
