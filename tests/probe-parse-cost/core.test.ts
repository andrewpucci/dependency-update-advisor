import { expect, test } from 'vite-plus/test';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import {
  CLAIM_SHAPES,
  COUNTERS,
  claimLine,
  dependabotDocument,
  doublingRatios,
  doublingSizes,
  entryCount,
  filled,
  jsonDocument,
  npmBudgetFindingId,
  npmProject,
  reportsBudget,
  smallestPassing,
  summarizeCounts,
  timingSummary,
  tomlDocument,
  uvProject,
  workflowDocument,
} from '../../scripts/probe-parse-cost/core.js';

test('entries are counted as the JSON readers count them: each property or element', () => {
  expect(entryCount('x')).toBe(0);
  expect(entryCount([])).toBe(0);
  expect(entryCount({ a: [1, 2], b: {} })).toBe(4);
});

test('a filled document repeats its unit as many times as fits, and never passes the budget', () => {
  expect(filled('[', 'a,', ']', 8)).toBe('[a,a,a,]');
  expect(() => filled('[', 'a,', ']', 3)).toThrow();
  const numbers = jsonDocument('numbers', 1000);
  expect(entryCount(JSON.parse(numbers))).toBe(Math.floor((1000 - 3) / 2) + 1);
  for (const shape of ['flat', 'objects'] as const) {
    const text = jsonDocument(shape, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.length).toBeGreaterThan(1000 - 3);
    expect(entryCount(JSON.parse(text))).toBe(Math.floor((1000 - 3) / 3) + 1);
  }
  for (const shape of ['integers', 'tables'] as const) {
    const text = tomlDocument(shape, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(Array.isArray(parse(text).a)).toBe(true);
  }
});

test('the YAML documents parse, and each fills its budget with one kind of unit', () => {
  const nodes = parseYaml(workflowDocument('nodes', 1000)) as { jobs: object; x: string[] };
  expect(nodes.jobs).toEqual({});
  expect(nodes.x.length).toBeGreaterThan(400);
  const aliases = parseYaml(workflowDocument('aliases', 1000), { maxAliasCount: -1 }) as {
    y: string[];
  };
  expect(aliases.y.every((value) => value === 'a')).toBe(true);
  const uses = parseYaml(workflowDocument('occurrences', 1000)) as {
    jobs: { j: { steps: { uses: string }[] } };
  };
  expect(uses.jobs.j.steps.every((step) => step.uses === 'a/b@c')).toBe(true);
  for (const shape of ['nodes', 'updates', 'roots'] as const) {
    const text = dependabotDocument(shape, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect((parseYaml(text) as { version: number }).version).toBe(2);
  }
  const roots = parseYaml(dependabotDocument('roots', 1000)) as {
    updates: { directories: string[] }[];
  };
  const directories = roots.updates[0]?.directories ?? [];
  expect(new Set(directories).size).toBe(directories.length);
});

test('a graph project differs between sides only in its last version and fits its budget', () => {
  for (const shape of ['chain', 'star'] as const) {
    const base = uvProject(shape, 4000, '1');
    const head = uvProject(shape, 4000, '2');
    expect(base.lock.length).toBeLessThanOrEqual(4000);
    expect(base.packages).toBe(head.packages);
    expect(base.lock).not.toBe(head.lock);
    expect(base.manifest).toBe(head.manifest);
    expect((parse(base.lock).package as unknown[]).length).toBe(base.packages + 1);
    const npm = npmProject(shape, 4000, '1.0.0', 'sha512-x');
    expect(npm.lock.length).toBeLessThanOrEqual(4000);
    expect(Object.keys(JSON.parse(npm.lock).packages)).toHaveLength(npm.packages + 1);
  }
});

test('the smallest passing value is found by doubling and bisection', async () => {
  expect(await smallestPassing((value) => value >= 37, 1000)).toBe(37);
  expect(await smallestPassing((value) => value >= 1, 1000)).toBe(1);
  expect(await smallestPassing((value) => value >= 1000, 1000)).toBe(1000);
  expect(await smallestPassing(() => false, 1000)).toBeNull();
});

test('claim lines have exactly the asked length', () => {
  for (const shape of CLAIM_SHAPES) expect(claimLine(shape, 100)).toHaveLength(100);
  expect(claimLine('bumps', 30).startsWith('Bumps a from 1 to 1')).toBe(true);
});

test('summaries give aggregates only', () => {
  expect(summarizeCounts([])).toEqual({ documents: 0, largest: 0 });
  expect(summarizeCounts([3, 9, 4])).toEqual({ documents: 3, largest: 9 });
  expect(timingSummary([3, 1, 2])).toEqual({ slowestMs: 3, medianMs: 2 });
  expect(() => timingSummary([])).toThrow();
  expect(doublingRatios([1, 2, 6])).toEqual([2, 3]);
});

test('doubling sizes halve below the cap and double above it', () => {
  expect(doublingSizes(1000, 2, 3)).toEqual([250, 500, 1000, 2000, 4000, 8000]);
  expect(doublingSizes(1001, 1, 0)).toEqual([500, 1001]);
});

test('a graph result reports budget only through a reason, a reason list or a budget finding', () => {
  expect(reportsBudget({ kind: 'unavailable', reason: 'budget' })).toBe(true);
  expect(() => reportsBudget({ kind: 'unavailable', reason: 'malformed' })).toThrow();
  expect(() => reportsBudget({ kind: 'roots' })).toThrow();
  expect(reportsBudget({ kind: 'inventory', changes: [] })).toBe(false);
  expect(reportsBudget({ kind: 'inventory', gaps: [{ reason: 'budget' }] })).toBe(true);
  expect(reportsBudget({ kind: 'inventory', coverage: { reasons: ['budget'] } })).toBe(true);
  expect(reportsBudget({ kind: 'inventory', notes: ['ran out of budget'] })).toBe(false);
  const finding = { memberId: 'm', id: npmBudgetFindingId('m') };
  expect(reportsBudget({ kind: 'inventory', findings: [finding] })).toBe(true);
  expect(npmBudgetFindingId('m')).not.toBe(npmBudgetFindingId('n'));
});

test('the counters are distinct', () => {
  expect(new Set(COUNTERS).size).toBe(COUNTERS.length);
});
