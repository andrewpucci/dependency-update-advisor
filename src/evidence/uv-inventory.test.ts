import { expect, test } from 'vite-plus/test';
import { reconcileUvGraph } from './uv-graph.js';
import { validateReviewPacket } from '../schema.js';
import {
  uvGraphFixture,
  uvLock,
  uvPackage,
  uvPacket,
  uvManifest,
} from '../../tests/parity/uv-graph.js';

test('unchanged variants are removed before uniquely pairing remaining exact families', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'base:uv.lock': uvLock('1') + uvPackage('orbit', '9'),
      'head:uv.lock': uvLock('2') + uvPackage('orbit', '9'),
    }),
  );
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.changes).toHaveLength(1);
  expect(r.changes[0]).toMatchObject({
    kind: 'update',
    from: { version: '1' },
    to: { version: '2' },
  });
});
test('ambiguous versions remain four exact unmatched records rather than invented pairs', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'base:uv.lock': uvLock('1') + uvPackage('orbit', '3'),
      'head:uv.lock': uvLock('2') + uvPackage('orbit', '4'),
    }),
  );
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.changes.filter((c) => c.kind === 'removal')).toHaveLength(2);
  expect(r.changes.filter((c) => c.kind === 'addition')).toHaveLength(2);
  expect(r.observations.some((o) => o.reason === 'ambiguous_pairing')).toBe(true);
});
test('same-version source changes remain separate attributable sides', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'head:uv.lock': uvLock('1').replace(
        'https://pypi.org/simple',
        'https://index.example.test/simple',
      ),
    }),
  );
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.changes.map((c) => c.kind).sort()).toEqual(['addition', 'removal']);
  expect(r.coverage.status).toBe('complete');
});
test('a marker-context transition is not collapsed into a same-name migration', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({
      'base:uv.lock': uvLock('1', `resolution-markers=["python_version < '3.13'"]\n`),
      'head:uv.lock': uvLock('1', `resolution-markers=["python_version >= '3.13'"]\n`),
    }),
  );
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.changes.map((c) => c.kind).sort()).toEqual(['addition', 'removal']);
  expect(
    r.changes
      .flatMap((c) => [c.from?.marker, c.to?.marker])
      .filter(Boolean)
      .sort(),
  ).toEqual([
    JSON.stringify(["python_version < '3.13'"]),
    JSON.stringify(["python_version >= '3.13'"]),
  ]);
});
test.each(['base', 'head'] as const)(
  'a proven absent %s root permits exact one-sided changes',
  async (side) => {
    const r = reconcileUvGraph(
      await uvGraphFixture({ [`${side}:pyproject.toml`]: null, [`${side}:uv.lock`]: null }),
    );
    expect(r.kind).toBe('inventory');
    if (r.kind !== 'inventory') throw new Error('inventory');
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].kind).toBe(side === 'base' ? 'addition' : 'removal');
    expect(r.coverage.status).toBe('complete');
    const { packet, expected } = uvPacket(r);
    expect(validateReviewPacket(packet, expected).ok).toBe(true);
  },
);
test('missing opposing lock data preserves known observations without fabricated removals', async () => {
  const r = reconcileUvGraph(await uvGraphFixture({ 'head:uv.lock': null }));
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.changes).toEqual([]);
  expect(r.coverage.status).toBe('partial');
  expect(r.observations.some((o) => o.kind === 'package' && o.side === 'base')).toBe(true);
});
test('an edge-only rewrite and a new declared empty extra cannot become complete zero changes', async () => {
  const r = reconcileUvGraph(
    await uvGraphFixture({ 'head:uv.lock': uvLock('1', 'dependencies=[{name="unknown"}]\n') }),
  );
  expect(r).toMatchObject({ kind: 'inventory', coverage: { status: 'partial' } });
  const extra = reconcileUvGraph(
    await uvGraphFixture({
      'head:pyproject.toml': uvManifest + '[project.optional-dependencies]\nempty=[]\n',
      'head:uv.lock': uvLock('1').replace(
        '[package.metadata]',
        '[package.metadata]\nprovides-extras=["empty"]',
      ),
    }),
  );
  expect(extra).toMatchObject({ kind: 'inventory', changes: [], coverage: { status: 'partial' } });
});

test('retains a proven version pair beside irrelevant artifact metadata gap', async () => {
  const input = await uvGraphFixture({
    'head:uv.lock': uvLock(
      '2',
      'sdist={url="https://files.example.test/orbit.tar.gz",hash="unknown-hash-format"}\n',
    ),
  });
  expect(input.metadata.gaps).toHaveLength(1);
  expect(input.metadata.gaps[0].entry).toContain(':artifacts');
  const r = reconcileUvGraph(input);
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw Error('expected inventory');
  expect(r.coverage.status).toBe('partial');
  expect(r.changes).toHaveLength(1);
  expect(r.changes[0]).toMatchObject({
    kind: 'update',
    from: { name: 'orbit', version: '1' },
    to: { name: 'orbit', version: '2' },
  });
  const { packet, expected } = uvPacket(r);
  const accepted = validateReviewPacket(packet, expected);
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  expect(r.sources.some((s) => s.status === 'partial')).toBe(true);
  expect(r.sources.find((s) => s.id === r.changes[0].to!.sourceId)?.status).toBe('available');
});

test('a self-project selector condition rewrite is not complete zero-change inventory', async () => {
  const input = await uvGraphFixture({
    'head:uv.lock': uvLock('1').replace(
      'dependencies=[{name="orbit"}]',
      'dependencies=[{name="orbit",marker="sys_platform == \'linux\'"}]',
    ),
  });
  expect(input.metadata.gaps).toEqual([]);
  const r = reconcileUvGraph(input);
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw Error('expected inventory');
  expect(r.changes).toEqual([]);
  expect(r.coverage.status).toBe('partial');
  expect(r.observations.some((o) => o.reason === 'unrepresented_metadata')).toBe(true);
});

test('membership shift must not explain away an independent self-selector marker rewrite', async () => {
  const manifest = (core: boolean) =>
    `[project]\nname="project"\nrequires-python=">=3.11"\ndependencies=${core ? '["orbit>=1"]' : '[]'}\n[project.optional-dependencies]\ndocs=["orbit>=1"]\n`;
  const lock = (core: boolean) =>
    `version=1\nrevision=3\nrequires-python=">=3.11"\n[[package]]\nname="project"\nsource={editable="."}\n${core ? 'dependencies=[{name="orbit"}]\n' : ''}[package.optional-dependencies]\ndocs=[{name="orbit"${core ? '' : ',marker="sys_platform == \'linux\'"'}}]\n[package.metadata]\nprovides-extras=["docs"]\nrequires-dist=[${core ? '{name="orbit",specifier=">=1"},' : ''}{name="orbit",specifier=">=1",marker="extra == 'docs'"}]\n${uvPackage('orbit', '1')}`;
  const input = await uvGraphFixture({
    'base:pyproject.toml': manifest(true),
    'head:pyproject.toml': manifest(false),
    'base:uv.lock': lock(true),
    'head:uv.lock': lock(false),
  });
  expect(input.metadata.gaps).toEqual([]);
  const r = reconcileUvGraph(input);
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw Error('inventory');
  expect(r.changes).toHaveLength(1);
  expect(r.changes[0]).toMatchObject({
    from: { version: '1', extras: [] },
    to: { version: '1', extras: ['docs'] },
  });
  expect(r.coverage.status).toBe('partial');
  expect(
    r.observations.some(
      (o) => o.reason === 'unrepresented_metadata' && o.entry === 'project-selectors',
    ),
  ).toBe(true);
});
test('project selectors resolve against an artifact-only partial table like role mapping', async () => {
  const input = await uvGraphFixture({
    'head:uv.lock': uvLock(
      '2',
      'sdist={url="https://files.example.test/orbit.tar.gz",hash="unknown-hash-format"}\n',
    ).replace('dependencies=[{name="orbit"}]', 'dependencies=[{name="orbit",version="2"}]'),
  });
  expect(input.metadata.gaps.map((g) => g.entry)).toEqual([expect.stringContaining(':artifacts')]);
  const r = reconcileUvGraph(input);
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw Error('expected inventory');
  expect(r.changes).toMatchObject([{ kind: 'update', role: 'direct' }]);
  expect(r.gaps.some((g) => g.entry === 'project-selectors')).toBe(false);
});
