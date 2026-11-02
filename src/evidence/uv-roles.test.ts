import { expect, test } from 'vite-plus/test';
import { reconcileUvGraph } from './uv-graph.js';
import { uvGraphFixture, uvLock, uvManifest, uvPackage } from '../../tests/parity/uv-graph.js';

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

function extrasManifest(core = false) {
  return `[project]\nname="project"\nrequires-python=">=3.11"\ndependencies=${core ? '["orbit[fast]>=1"]' : '[]'}\n[project.optional-dependencies]\ndocs=["orbit[fast]>=1"]\nempty=[]\ncli=[]\nweb=[]\n`;
}
function extrasLock(version: string, core = false) {
  const edge = '{name="orbit",extra=["fast"]}';
  return `version=1\nrevision=3\nrequires-python=">=3.11"\n[[package]]\nname="project"\nsource={editable="."}\n${core ? `dependencies=[${edge}]\n` : ''}[package.optional-dependencies]\ndocs=[${edge}]\n[package.metadata]\nprovides-extras=["docs","empty","cli","web"]\nrequires-dist=[${core ? '{name="orbit",extras=["fast"],specifier=">=1"},' : ''}{name="orbit",extras=["fast"],specifier=">=1",marker="extra == 'docs'"}]\n${uvPackage('orbit', version, '[package.optional-dependencies]\nfast=[{name="child"}]\n')}${uvPackage('child', version)}`;
}
test.each([false, true])(
  'project extras and requested package extras remain distinct; core %s',
  async (core) => {
    const r = reconcileUvGraph(
      await uvGraphFixture({
        'base:pyproject.toml': extrasManifest(core),
        'head:pyproject.toml': extrasManifest(core),
        'base:uv.lock': extrasLock('1', core),
        'head:uv.lock': extrasLock('2', core),
      }),
    );
    expect(r.kind).toBe('inventory');
    if (r.kind !== 'inventory') throw new Error('inventory');
    expect(r.coverage.status).toBe('complete');
    expect(r.changes).toHaveLength(2);
    expect(r.changes.find((c) => c.to?.name === 'orbit')).toMatchObject({
      role: 'direct',
      to: { extras: core ? [] : ['docs'] },
    });
    expect(r.changes.find((c) => c.to?.name === 'child')).toMatchObject({
      role: 'transitive',
      to: { extras: core ? [] : ['docs'] },
    });
  },
);
test('ordinary transitive reachability terminates on a cycle and excludes direct membership', async () => {
  const files = {
    'base:uv.lock':
      uvLock('1', 'dependencies=[{name="child"}]\n') +
      uvPackage('child', '1', 'dependencies=[{name="orbit"}]\n'),
    'head:uv.lock':
      uvLock('2', 'dependencies=[{name="child"}]\n') +
      uvPackage('child', '2', 'dependencies=[{name="orbit"}]\n'),
  };
  const r = reconcileUvGraph(await uvGraphFixture(files));
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.coverage.status).toBe('complete');
  expect(r.changes.find((c) => c.to?.name === 'child')?.role).toBe('transitive');
});
test('a core-to-extra membership shift is an equal-version update, not a vanished package', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'base:pyproject.toml': extrasManifest(true),
      'head:pyproject.toml': extrasManifest(false),
      'base:uv.lock': extrasLock('1', true),
      'head:uv.lock': extrasLock('1', false),
    }),
  );
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.coverage.status).toBe('complete');
  expect(r.changes).toHaveLength(2);
  for (const c of r.changes)
    expect(c).toMatchObject({
      kind: 'update',
      from: { version: '1', extras: [] },
      to: { version: '1', extras: ['docs'] },
    });
});
test('unresolved selectors leave extra membership incomplete rather than hiding an ordinary path', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'base:pyproject.toml': extrasManifest(),
      'head:pyproject.toml': extrasManifest(),
      'base:uv.lock': extrasLock('1'),
      'head:uv.lock': extrasLock('2').replace(
        'fast=[{name="child"}]',
        'fast=[{name="child"},{name="missing"}]',
      ),
    }),
  );
  expect(r).toMatchObject({ kind: 'inventory', coverage: { status: 'partial' } });
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
