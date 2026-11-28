import { expect, test } from 'vite-plus/test';
import { baseline, footprint, reports } from '../../scripts/probe-runtime-baseline/core.js';

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
