import { expect, test } from 'vite-plus/test';
import { createDemandRecorder } from './demand.js';

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
