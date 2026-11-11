import { expect, test } from 'vite-plus/test';
import { reconcileUvGraph } from './uv-graph.js';
import {
  uvGraphFixture,
  uvLock,
  uvPackage,
  uvManifest,
  uvPacket,
} from '../../tests/parity/uv-graph.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits } from '../units.js';
function tree(v: string, marker: string | null = null) {
  const fields = `${marker ? `resolution-markers=["${marker}"]\n` : ''}dependencies=[{name="child"${marker ? `,marker="${marker}"` : ''}}]\n`;
  let lock =
    uvLock(v, fields) + uvPackage('child', v, marker ? `resolution-markers=["${marker}"]\n` : '');
  if (marker)
    lock = lock
      .replace('dependencies=[{name="orbit"}]', `dependencies=[{name="orbit",marker="${marker}"}]`)
      .replace('specifier=">=1"}', `specifier=">=1",marker="${marker}"}`);
  return lock;
}
function accepted(r: ReturnType<typeof reconcileUvGraph>) {
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  const { packet, expected } = uvPacket(r),
    p = validateReviewPacket(packet, expected);
  expect(p.ok, JSON.stringify(p)).toBe(true);
  if (!p.ok) throw new Error('valid packet');
  return { r, units: formDecisionUnits(p.packet) };
}
test.each([null, "sys_platform == 'linux'"])(
  'exact ordinary path groups through real T4/T5; marker %s',
  async (marker) => {
    const manifest = marker ? uvManifest.replace('orbit>=1', `orbit>=1; ${marker}`) : uvManifest;
    const { r, units } = accepted(
      reconcileUvGraph(
        await uvGraphFixture({
          'base:pyproject.toml': manifest,
          'head:pyproject.toml': manifest,
          'base:uv.lock': tree('1', marker),
          'head:uv.lock': tree('2', marker),
        }),
      ),
    );
    expect(r.coverage.status).toBe('complete');
    expect(r.relationships).toHaveLength(1);
    expect(r.relationships[0].path.map((p) => ('name' in p ? p.name : ''))).toEqual([
      'orbit',
      'child',
    ]);
    expect(units.units).toHaveLength(1);
    expect(units.units[0].kind).toBe('direct_group');
  },
);
test('conditional edge context absent from a path identity stays standalone without failing inventory', async () => {
  const m = "sys_platform == 'linux'",
    manifest = uvManifest.replace('orbit>=1', `orbit>=1; ${m}`);
  const { r, units } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({
        'base:pyproject.toml': manifest,
        'head:pyproject.toml': manifest,
        'base:uv.lock': tree('1', m).replace(
          uvPackage('child', '1', `resolution-markers=["${m}"]\n`),
          uvPackage('child', '1'),
        ),
        'head:uv.lock': tree('2', m).replace(
          uvPackage('child', '2', `resolution-markers=["${m}"]\n`),
          uvPackage('child', '2'),
        ),
      }),
    ),
  );
  expect(r.coverage.status).toBe('complete');
  expect(r.relationships).toEqual([]);
  expect(units.units.every((u) => u.kind === 'standalone')).toBe(true);
});
test('removed transitive changes use only a base-side path', async () => {
  const { r, units } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({ 'base:uv.lock': tree('1'), 'head:uv.lock': uvLock('2') }),
    ),
  );
  expect(r.coverage.status).toBe('complete');
  expect(r.relationships).toHaveLength(1);
  expect(r.relationships[0].side).toBe('base');
  expect(units.units).toHaveLength(1);
});
const multiManifest = uvManifest.replace('["orbit>=1"]', '["orbit>=1","other>=1"]');
function multiLock(v: string, other = '', extra = '', orbitDeps = '{name="child"}') {
  return (
    tree(v)
      .replace('dependencies=[{name="orbit"}]', 'dependencies=[{name="orbit"},{name="other"}]')
      .replace(
        'requires-dist=[{name="orbit",specifier=">=1"}]',
        'requires-dist=[{name="orbit",specifier=">=1"},{name="other",specifier=">=1"}]',
      )
      .replace('dependencies=[{name="child"}]', `dependencies=[${orbitDeps}]`) +
    uvPackage('other', v, other) +
    extra
  );
}
async function multiFixture(
  other = (_v: string) => '',
  extra = (_v: string) => '',
  orbitDeps = '{name="child"}',
) {
  return reconcileUvGraph(
    await uvGraphFixture({
      'base:pyproject.toml': multiManifest,
      'head:pyproject.toml': multiManifest,
      'base:uv.lock': multiLock('1', other('1'), extra('1'), orbitDeps),
      'head:uv.lock': multiLock('2', other('2'), extra('2'), orbitDeps),
    }),
  );
}
const vkey = (v: { side: string; anchorId: string; memberId: string | null; outcome: string }) =>
  [v.side, v.anchorId, v.memberId, v.outcome].join('|');
const idFor = (
  r: { changes: readonly { id: string; to: unknown; from: unknown }[] },
  name: string,
) => r.changes.find((c) => ((c.to ?? c.from) as { name: string }).name === name)!.id;

test('multiple changed direct dependencies with proven absence keep one proof and no blanket diagnostic', async () => {
  const { r } = accepted(await multiFixture());
  expect(r.relationships).toHaveLength(1);
  expect(r.observations.some((o) => o.reason === 'multiple_direct_changes')).toBe(false);
});
test('one reachable anchor groups when every other candidate is proven unreachable on each side', async () => {
  const { r, units } = accepted(await multiFixture());
  const [orbit, other, child] = ['orbit', 'other', 'child'].map((n) => idFor(r, n));
  expect(r.coverage.status).toBe('complete');
  expect(r.relationships.map((p) => [p.fromId, p.toId, p.side])).toEqual([[orbit, child, 'head']]);
  expect(r.optionalRelationships).toEqual([]);
  expect(r.reachability.map(vkey).sort()).toEqual(
    [`base|${other}|${child}|unreachable`, `head|${other}|${child}|unreachable`].sort(),
  );
  expect(units.units.find((u) => u.kind === 'direct_group')).toMatchObject({
    anchorId: orbit,
    memberIds: [orbit, child].sort(),
  });
});

test('an edge guarded by a platform marker still counts as reachability, never absence', async () => {
  const marker = `sys_platform == 'win32'`;
  const { r, units } = accepted(
    await multiFixture(
      () => `dependencies=[{name="child",marker="${marker}"}]\n`,
      (v) => uvPackage('solo', v),
      '{name="child"},{name="solo"}',
    ),
  );
  const [other, child] = ['other', 'child'].map((n) => idFor(r, n));
  expect(r.reachability.some((v) => v.anchorId === other && v.memberId === child)).toBe(false);
  expect(r.optionalRelationships.map((p) => p.toId)).toEqual([child]);
  expect(
    r.observations.some((o) => o.reason === 'ambiguous_anchors' && o.memberIds.includes(child)),
  ).toBe(true);
  expect(units.units.find((u) => u.memberIds.includes(child))).toMatchObject({
    kind: 'standalone',
    relationship: { reason: 'ambiguous_anchors' },
  });
});

test('an optional-dependency extra edge counts as reachability, never absence', async () => {
  const { r } = accepted(
    await multiFixture(
      () => '[package.optional-dependencies]\nfeature=[{name="child"}]\n',
      (v) => uvPackage('solo', v),
      '{name="child"},{name="solo"}',
    ),
  );
  const [other, child] = ['other', 'child'].map((n) => idFor(r, n));
  expect(r.reachability.some((v) => v.anchorId === other && v.memberId === child)).toBe(false);
  expect(r.optionalRelationships.map((p) => p.toId)).toEqual([child]);
});

test('absence on one side only is not enough when the other side can reach the member', async () => {
  const { r, units } = accepted(
    await multiFixture((v) => (v === '1' ? 'dependencies=[{name="child"}]\n' : '')),
  );
  const [other, child] = ['other', 'child'].map((n) => idFor(r, n));
  expect(r.reachability.map(vkey)).toEqual([`head|${other}|${child}|unreachable`]);
  expect(units.units.find((u) => u.memberIds.includes(child))!.relationship.reason).toBe(
    'reachability_unproven',
  );
});

test('a selector that resolves to no lock package makes the anchor non-proving, never unreachable', async () => {
  const { r, units } = accepted(await multiFixture(() => 'dependencies=[{name="ghost"}]\n'));
  const [other, child] = ['other', 'child'].map((n) => idFor(r, n));
  expect(r.coverage.status).toBe('complete');
  expect(r.reachability.some((v) => v.outcome === 'unreachable')).toBe(false);
  expect(
    r.reachability.filter((v) => v.anchorId === other).map((v) => [v.side, v.memberId, v.outcome]),
  ).toEqual(
    expect.arrayContaining([
      ['base', null, 'unknown'],
      ['head', null, 'unknown'],
    ]),
  );
  expect(units.units.find((u) => u.memberIds.includes(child))!.relationship.reason).toBe(
    'reachability_unproven',
  );
});

test('a direct removal beside an update groups only with its base-side absence proof', async () => {
  const { r, units } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({
        'base:pyproject.toml': multiManifest,
        'head:pyproject.toml': uvManifest,
        'base:uv.lock': multiLock('1'),
        'head:uv.lock': tree('2'),
      }),
    ),
  );
  const [other, child] = ['other', 'child'].map((n) => idFor(r, n));
  expect(r.reachability.map(vkey)).toEqual([`base|${other}|${child}|unreachable`]);
  expect(units.units.find((u) => u.kind === 'direct_group')).toBeDefined();
});

test('truncating graph work never invents absence and reports the cut as a limit', async () => {
  const files = {
    'base:pyproject.toml': multiManifest,
    'head:pyproject.toml': multiManifest,
    'base:uv.lock': multiLock('1'),
    'head:uv.lock': multiLock('2'),
  };
  const input = await uvGraphFixture(files);
  const full = reconcileUvGraph(input);
  if (full.kind !== 'inventory') throw new Error('expected inventory');
  const fullAbsent = new Set(
    full.reachability.filter((v) => v.outcome === 'unreachable').map(vkey),
  );
  const at = (maxGraphWork: number) =>
    reconcileUvGraph({ ...input, limits: { ...input.limits, maxGraphWork } });
  let low = 1,
    high = 1_000_000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (at(mid).kind === 'inventory') high = mid;
    else low = mid + 1;
  }
  let sawTruncation = false,
    sawBudgetMarker = false;
  for (let work = low; work < low + 600; work += 1) {
    const result = at(work);
    if (result.kind !== 'inventory') continue;
    for (const v of result.reachability) {
      if (v.outcome === 'unreachable') expect(fullAbsent.has(vkey(v))).toBe(true);
      if (v.outcome === 'truncated') {
        sawTruncation = true;
        expect(v.reasons).toContain('budget');
        expect(v.memberId).toBeNull();
      }
    }
    if (result.observations.some((o) => o.kind === 'relationship' && o.reason === 'budget'))
      sawBudgetMarker = true;
  }
  expect(sawBudgetMarker).toBe(true);
  expect(sawTruncation).toBe(true);
});

test('source-split endpoints never emit a proof rejected by T4', async () => {
  const deps = Array.from({ length: 34 }, (_, i) => `{name="leaf-${i}"}`).join(',');
  const lock = (v: string) =>
    uvLock(v, `dependencies=[${deps}]\n`) +
    Array.from({ length: 34 }, (_, i) => uvPackage(`leaf-${i}`, v)).join('');
  const { r } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({ 'base:uv.lock': lock('1'), 'head:uv.lock': lock('2') }),
    ),
  );
  expect(r.changes).toHaveLength(35);
  expect(r.observations.some((o) => o.reason === 'source_split')).toBe(true);
  for (const proof of r.relationships)
    expect(proof.path.every((s) => s.sourceId === proof.sourceId)).toBe(true);
});
test('paths beyond the packet bound are unproven rather than truncated', async () => {
  const lock = (v: string) =>
    uvLock(v, 'dependencies=[{name="mid-0"}]\n') +
    Array.from({ length: 31 }, (_, i) =>
      uvPackage(
        `mid-${i}`,
        '9',
        `dependencies=[{name="${i === 30 ? 'child' : `mid-${i + 1}`}"}]\n`,
      ),
    ).join('') +
    uvPackage('child', v);
  const { r } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({ 'base:uv.lock': lock('1'), 'head:uv.lock': lock('2') }),
    ),
  );
  expect(r.coverage.status).toBe('complete');
  expect(r.relationships).toEqual([]);
  expect(r.observations.some((o) => o.reason === 'path_limit')).toBe(true);
});
test('unchanged direct sharers are explained without preventing the supported group', async () => {
  const manifest = uvManifest.replace('["orbit>=1"]', '["orbit>=1","other>=1"]');
  const lock = (v: string) =>
    tree(v)
      .replace('dependencies=[{name="orbit"}]', 'dependencies=[{name="orbit"},{name="other"}]')
      .replace(
        'requires-dist=[{name="orbit",specifier=">=1"}]',
        'requires-dist=[{name="orbit",specifier=">=1"},{name="other",specifier=">=1"}]',
      ) + uvPackage('other', '9', 'dependencies=[{name="child"}]\n');
  const { r, units } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({
        'base:pyproject.toml': manifest,
        'head:pyproject.toml': manifest,
        'base:uv.lock': lock('1'),
        'head:uv.lock': lock('2'),
      }),
    ),
  );
  expect(units.units).toHaveLength(1);
  expect(r.observations.some((o) => o.reason === 'shared')).toBe(true);
  expect(
    r.findings.some((f) => f.kind === 'informational' && f.detail.includes('exclusive ownership')),
  ).toBe(true);
});
test('a dependency optional-table path is preserved as reachability without a grouping proof', async () => {
  const manifest = uvManifest.replace('orbit>=1', 'orbit[fast]>=1');
  const lock = (v: string) =>
    uvLock(v, '[package.optional-dependencies]\nfast=[{name="child"}]\n')
      .replace('dependencies=[{name="orbit"}]', 'dependencies=[{name="orbit",extra=["fast"]}]')
      .replace('name="orbit",specifier', 'name="orbit",extras=["fast"],specifier') +
    uvPackage('child', v);
  const { r, units } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({
        'base:pyproject.toml': manifest,
        'head:pyproject.toml': manifest,
        'base:uv.lock': lock('1'),
        'head:uv.lock': lock('2'),
      }),
    ),
  );
  expect(r.coverage.status).toBe('complete');
  expect(r.changes.find((c) => c.to?.name === 'child')?.role).toBe('transitive');
  expect(r.relationships).toEqual([]);
  expect(units.units).toHaveLength(2);
});
test('cycles terminate and equivalent shortest paths choose canonical instance order', async () => {
  const lock = (v: string) =>
    uvLock(v, 'dependencies=[{name="b"},{name="a"}]\n') +
    uvPackage('b', '9', 'dependencies=[{name="child"}]\n') +
    uvPackage('a', '9', 'dependencies=[{name="orbit"},{name="child"}]\n') +
    uvPackage('child', v);
  const { r } = accepted(
    reconcileUvGraph(
      await uvGraphFixture({ 'base:uv.lock': lock('1'), 'head:uv.lock': lock('2') }),
    ),
  );
  expect(r.relationships[0].path.map((p) => ('name' in p ? p.name : ''))).toEqual([
    'orbit',
    'a',
    'child',
  ]);
});
test('optional proof-work exhaustion retains the entire usable inventory and an explicit limit', async () => {
  const input = await uvGraphFixture({ 'base:uv.lock': tree('1'), 'head:uv.lock': tree('2') });
  let low = 1,
    high = input.limits.maxGraphWork;
  while (low < high) {
    const mid = Math.floor((low + high) / 2),
      r = reconcileUvGraph({ ...input, limits: { ...input.limits, maxGraphWork: mid } });
    if (r.kind === 'inventory') high = mid;
    else low = mid + 1;
  }
  const { r } = accepted(
    reconcileUvGraph({ ...input, limits: { ...input.limits, maxGraphWork: low } }),
  );
  expect(r.changes).toHaveLength(2);
  expect(r.coverage.status).toBe('complete');
  expect(r.observations.some((o) => o.kind === 'relationship' && o.reason === 'budget')).toBe(true);
});

test('optional proof one-byte boundary preserves usable inventory', async () => {
  const lock = (v: string) => uvLock(v, 'dependencies=[{name="child"}]\n') + uvPackage('child', v);
  const input = await uvGraphFixture({ 'base:uv.lock': lock('1'), 'head:uv.lock': lock('2') });
  const full = reconcileUvGraph(input);
  expect(full.kind).toBe('inventory');
  const size = Buffer.byteLength(JSON.stringify(full));
  const limited = reconcileUvGraph({
    ...input,
    limits: { ...input.limits, maxRetainedBytes: size - 1 },
  });
  expect(limited.kind).toBe('inventory');
  if (limited.kind !== 'inventory') throw Error('inventory');
  expect(limited.changes).toHaveLength(2);
  expect(limited.observations.some((o) => o.kind === 'relationship' && o.reason === 'budget')).toBe(
    true,
  );
});

test('a same-package change in another root must not suppress an unchanged direct sharer', async () => {
  const manifest = uvManifest.replace('["orbit>=1"]', '["orbit>=1","other>=1"]');
  const lock = (v: string) =>
    uvLock(v, 'dependencies=[{name="child"}]\n')
      .replace('dependencies=[{name="orbit"}]', 'dependencies=[{name="orbit"},{name="other"}]')
      .replace(
        'requires-dist=[{name="orbit",specifier=">=1"}]',
        'requires-dist=[{name="orbit",specifier=">=1"},{name="other",specifier=">=1"}]',
      ) +
    uvPackage('child', v) +
    uvPackage('other', '9', 'dependencies=[{name="child"}]\n');
  const input = await uvGraphFixture({
    'base:pyproject.toml': manifest,
    'head:pyproject.toml': manifest,
    'base:uv.lock': lock('1'),
    'head:uv.lock': lock('2'),
    'base:nested/pyproject.toml': uvManifest.replaceAll('orbit', 'other'),
    'head:nested/pyproject.toml': uvManifest.replaceAll('orbit', 'other'),
    'base:nested/uv.lock': uvLock('8').replaceAll('orbit', 'other'),
    'head:nested/uv.lock': uvLock('9').replaceAll('orbit', 'other'),
  });
  expect(input.metadata.gaps).toEqual([]);
  const r = reconcileUvGraph(input);
  expect(r).toMatchObject({ kind: 'inventory', coverage: { status: 'complete' } });
  if (r.kind !== 'inventory') throw Error('inventory');
  expect(r.relationships).toHaveLength(1);
  expect(r.observations.some((o) => o.root === '.' && o.reason === 'shared')).toBe(true);
});
test('a sole reaching anchor whose only path crosses a marker-guarded edge does not group', async () => {
  const { r, units } = accepted(
    await multiFixture(
      () => `dependencies=[{name="child",marker="sys_platform == 'win32'"}]\n`,
      (v) => uvPackage('solo', v),
      '{name="solo"}',
    ),
  );
  const [orbit, solo, child] = ['orbit', 'solo', 'child'].map((n) => idFor(r, n));
  expect(r.relationships.some((p) => p.toId === child)).toBe(false);
  expect(r.reachability.some((v) => v.memberId === child)).toBe(false);
  expect(units.units.find((u) => u.memberIds.includes(child))).toMatchObject({
    kind: 'standalone',
  });
  expect(units.units.find((u) => u.memberIds.includes(solo))).toMatchObject({
    kind: 'direct_group',
    anchorId: orbit,
  });
});
