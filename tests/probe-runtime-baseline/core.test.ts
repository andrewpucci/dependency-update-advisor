import { expect, test } from 'vite-plus/test';
import {
  baseline,
  footprint,
  reports,
  slowestStartup,
  startupMs,
} from '../../scripts/probe-runtime-baseline/core.js';

const line = (relaunched: boolean, maxRSS: number) =>
  `RUNTIME_BASELINE ${JSON.stringify({ relaunched, maxRSS })}`;

test('reads the parent and child reports from a run', () => {
  expect(reports(`noise\n${line(false, 10)}\nmore\n${line(true, 20)}\n`)).toEqual([
    { relaunched: false, maxRSS: 10 },
    { relaunched: true, maxRSS: 20 },
  ]);
});

test('the baseline is the largest parent plus child peak resident set', () => {
  const run = (parent: number, child: number) =>
    reports(`${line(false, parent)}\n${line(true, child)}`);
  expect(footprint(run(10, 20))).toBe(30);
  expect(baseline([run(10, 20), run(15, 30), run(5, 5)])).toBe(45);
});

test('a run missing its parent or its child gives no baseline', () => {
  expect(footprint(reports(line(true, 20)))).toBeNull();
  expect(
    baseline([reports(`${line(false, 1)}\n${line(true, 2)}`), reports(line(false, 1))]),
  ).toBeNull();
  expect(baseline([])).toBeNull();
});

test('the in-step startup runs from the parent start to the child exit, the slowest run kept', () => {
  const timed = (relaunched: boolean, startedAt: number, exitedAt: number) =>
    `RUNTIME_BASELINE ${JSON.stringify({ relaunched, maxRSS: 1, startedAt, exitedAt })}`;
  const run = (start: number, exit: number) =>
    reports(`${timed(false, start, start + 9_000)}\n${timed(true, start + 100, exit)}`);
  expect(startupMs(run(1_000, 1_750))).toBe(750);
  expect(slowestStartup([run(1_000, 1_750), run(5_000, 6_200)])).toBe(1_200);
  // A report from before the timing fields, or a missing process, gives no startup time.
  expect(startupMs(reports(`${line(false, 1)}\n${line(true, 2)}`))).toBeNull();
  expect(slowestStartup([run(1_000, 1_750), reports(line(false, 1))])).toBeNull();
  expect(slowestStartup([])).toBeNull();
});
