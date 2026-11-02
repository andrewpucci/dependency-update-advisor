import { expect, test } from 'vite-plus/test';
import { reconcileUvGraph } from './uv-graph.js';
import { uvGraphFixture, uvLock, uvManifest } from '../../tests/parity/uv-graph.js';

test('a specifier-only rewrite accompanying its exact direct lock change is an observation', async () => {
  const input = await uvGraphFixture({
    'head:pyproject.toml': uvManifest.replace('orbit>=1', 'orbit>=2'),
    'head:uv.lock': uvLock('2').replace('specifier=">=1"', 'specifier=">=2"'),
  });
  const r = reconcileUvGraph(input);
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.coverage.status).toBe('complete');
  expect(
    r.observations.some(
      (o) => o.reason === 'range_rewrite' && o.memberIds.includes(r.changes[0].id),
    ),
  ).toBe(true);
});
test('a declaration-only range change is visible even with zero resolved changes', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'head:pyproject.toml': uvManifest.replace('orbit>=1', 'orbit>=2'),
      'head:uv.lock': uvLock('1').replace('specifier=">=1"', 'specifier=">=2"'),
    }),
  );
  expect(r).toMatchObject({
    kind: 'inventory',
    changes: [],
    coverage: { status: 'partial', reasons: ['unsupported'] },
  });
});
test('a mismatched requires-dist mirror cannot establish a direct role or complete inventory', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'head:uv.lock': uvLock('2').replace('specifier=">=1"', 'specifier=">=99"'),
    }),
  );
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.coverage.status).toBe('partial');
  expect(r.changes[0].role).toBe('unknown');
  expect(r.gaps.some((g) => g.reason === 'conflict')).toBe(true);
});
test('a marker rewrite is not hidden by the accompanying range exception', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'head:pyproject.toml': uvManifest.replace('orbit>=1', "orbit>=2; sys_platform == 'linux'"),
      'head:uv.lock': uvLock('2').replace(
        'specifier=">=1"',
        'specifier=">=2",marker="sys_platform == \'linux\'"',
      ),
    }),
  );
  expect(r).toMatchObject({ kind: 'inventory', coverage: { status: 'partial' } });
});
