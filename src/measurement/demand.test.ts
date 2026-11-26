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
import type { ChangeEvidence, EvidenceReason, EvidenceStatus, PacketChange } from '../schema.js';

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

test('keeps the reader limit research names for a stopped stage', () => {
  const recorder = createDemandRecorder(() => 0);
  recorder.observe({ kind: 'stage-start', stage: 'upstream' });
  recorder.observe({
    kind: 'stage-end',
    stage: 'upstream',
    outcome: 'unavailable',
    reason: 'budget',
    limit: 'npm.maxRetainedBytes',
  });
  recorder.observe({ kind: 'stage-start', stage: 'advisories' });
  recorder.observe({ kind: 'stage-end', stage: 'advisories', outcome: 'enriched', reason: null });
  expect(recorder.report({}).stages).toEqual([
    {
      stage: 'upstream',
      outcome: 'unavailable',
      reason: 'budget',
      limit: 'npm.maxRetainedBytes',
      ms: 0,
    },
    { stage: 'advisories', outcome: 'enriched', reason: null, ms: 0 },
  ]);
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

/** 2026-11-25T00:00:00Z, and a reset half an hour after it, in the header's Unix seconds. */
const WALL = Date.UTC(2026, 10, 25);
const RESET = String(WALL / 1000 + 30 * 60);
const quotaHeaders = (remaining: string, reset = RESET, extra: Record<string, string> = {}) => ({
  headers: { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': reset, ...extra },
});

test('reports research GitHub requests against the R1 ceiling, with refusals and the last quota', async () => {
  const recorder = createDemandRecorder(() => 0, { wallNow: () => WALL });
  let remaining = 100;
  const fetch = recorder.wrap(async (url) =>
    new URL(url).host === 'api.github.com'
      ? new Response('{}', quotaHeaders(String(remaining--)))
      : new Response('{}', quotaHeaders('0')),
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
    lastReset: '2026-11-25T00:30:00.000Z',
    windows: 1,
    risesWithinWindow: 0,
    ignoredReadings: 0,
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
    lastReset: null,
    windows: 0,
    risesWithinWindow: 0,
    ignoredReadings: 0,
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

test('counts only research-stage GitHub requests and keeps the lowest quota in the window', async () => {
  const recorder = createDemandRecorder(() => 0, { wallNow: () => WALL });
  const remaining = ['40', '30', '35', '50'];
  let call = 0;
  const fetch = recorder.wrap(
    async () => new Response('{}', quotaHeaders(remaining[call++] ?? '0')),
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
  // Within one window the report never rises: 35 and 50 arrived after 30 for the same reset.
  expect(report.github).toMatchObject({ lastRemaining: 30, windows: 1, risesWithinWindow: 2 });
});

test('reports the quota as the guard reads it: core only, lowest per window, raised by a reset (#438)', async () => {
  const wall = { now: WALL };
  const later = String(Number(RESET) + 60 * 60);
  // Out of completion order, with other resources, another host, and invalid resets mixed in.
  const sequence: [string, ResponseInit][] = [
    ['https://api.github.com/a', quotaHeaders('97')],
    ['https://api.github.com/b', quotaHeaders('99')],
    [
      'https://api.github.com/c',
      quotaHeaders('4990', later, { 'x-ratelimit-resource': 'graphql' }),
    ],
    ['https://api.github.com/d', quotaHeaders('29', RESET, { 'x-ratelimit-resource': 'search' })],
    ['https://codeload.github.com/o/r', quotaHeaders('4999', later)],
    ['https://api.github.com/e', quotaHeaders('650', String(WALL / 1000 - 1))],
    ['https://api.github.com/f', quotaHeaders('96', RESET, { 'x-ratelimit-resource': 'core' })],
    ['https://api.github.com/g', quotaHeaders('98')],
  ];
  const responses = new Map(sequence);
  const recorder = createDemandRecorder(() => 0, { wallNow: () => wall.now });
  const fetch = recorder.wrap(async (url) => new Response('{}', responses.get(url)));
  const seen: (number | null)[] = [];
  for (const [url] of sequence) {
    await fetch(url, {});
    seen.push(recorder.report({}).github.lastRemaining);
  }
  expect(seen).toEqual([97, 97, 97, 97, 97, 97, 96, 96]);
  expect(recorder.report({}).github).toMatchObject({
    lastReset: '2026-11-25T00:30:00.000Z',
    windows: 1,
    risesWithinWindow: 2,
    ignoredReadings: 3,
  });

  // The next window's reading raises it; a late reading from the old window does not.
  wall.now = WALL + 31 * 60 * 1000;
  responses.set('https://api.github.com/h', quotaHeaders('3'));
  responses.set('https://api.github.com/i', quotaHeaders('999', later));
  await fetch('https://api.github.com/h', {});
  await fetch('https://api.github.com/i', {});
  expect(recorder.report({}).github).toMatchObject({
    lastRemaining: 999,
    lastReset: '2026-11-25T01:30:00.000Z',
    windows: 2,
    ignoredReadings: 4,
  });
  expect(recorder.report({}).github.trace).toBeUndefined();
});

test('a quota trace lists GitHub rate-limit headers in completion order, without URLs', async () => {
  const recorder = createDemandRecorder(() => 0, { wallNow: () => WALL, trace: true });
  const gates = new Map<string, () => void>();
  const fetch = recorder.wrap(async (url) => {
    await new Promise<void>((resolve) => gates.set(url, resolve));
    return new Response('{}', {
      status: url.endsWith('/b') ? 404 : 200,
      headers: {
        ...quotaHeaders(url.endsWith('/a') ? '99' : '98').headers,
        'x-ratelimit-resource': 'core',
        'x-ratelimit-limit': '1000',
        'x-ratelimit-used': url.endsWith('/a') ? '1' : '2',
      },
    });
  });
  recorder.observe({ kind: 'stage-start', stage: 'upstream' });
  const first = fetch('https://api.github.com/repos/secret/a', {});
  const second = fetch('https://api.github.com/repos/secret/b', {});
  const npm = fetch('https://registry.npmjs.org/secret', {});
  await Promise.resolve();
  gates.get('https://api.github.com/repos/secret/b')!();
  await second;
  gates.get('https://api.github.com/repos/secret/a')!();
  gates.get('https://registry.npmjs.org/secret')!();
  await Promise.all([first, npm]);
  const report = recorder.report({});
  expect(report.github.trace).toEqual([
    {
      started: 2,
      phase: 'upstream',
      status: '404',
      resource: 'core',
      limit: '1000',
      remaining: '98',
      used: '2',
      reset: RESET,
    },
    {
      started: 1,
      phase: 'upstream',
      status: '200',
      resource: 'core',
      limit: '1000',
      remaining: '99',
      used: '1',
      reset: RESET,
    },
  ]);
  expect(JSON.stringify(report)).not.toContain('secret');
});

test('counts members by evidence status and reason per category, skipping declarations', () => {
  const evidence = (status: EvidenceStatus, reasons: EvidenceReason[] = []): ChangeEvidence => ({
    status,
    reasons,
    sourceIds: [],
  });
  const member = (id: string, evidence: Record<string, ChangeEvidence>): PacketChange => ({
    id,
    kind: 'update',
    role: 'transitive',
    ecosystem: 'npm',
    from: null,
    to: null,
    evidence,
  });
  const declaration: PacketChange = {
    id: 'declaration',
    kind: 'update',
    role: 'direct',
    ecosystem: 'npm',
    basis: 'declaration',
    from: null,
    to: null,
    evidence: { vulnerability: evidence('unavailable', ['missing']) },
  };
  const coverage = coverageCounts([
    member('a', { vulnerability: evidence('available'), malware: evidence('available') }),
    member('b', {
      vulnerability: evidence('unavailable', ['budget']),
      malware: evidence('partial', ['budget', 'timeout', 'budget']),
    }),
    member('c', { vulnerability: evidence('unavailable', ['budget']) }),
    declaration,
  ]);

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
