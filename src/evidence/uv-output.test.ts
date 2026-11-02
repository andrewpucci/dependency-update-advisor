import { expect, test } from 'vite-plus/test';
import { reconcileUvGraph } from './uv-graph.js';
import { validateReviewPacket } from '../schema.js';
import { uvGraphFixture, uvLock, uvPackage, uvPacket } from '../../tests/parity/uv-graph.js';

export function manyUvFiles(count: number) {
  const deps = Array.from({ length: count - 1 }, (_, i) => `{name="leaf-${i}"}`).join(',');
  const lock = (v: string) =>
    uvLock(v, `dependencies=[${deps}]\n`) +
    Array.from({ length: count - 1 }, (_, i) => uvPackage(`leaf-${i}`, v)).join('');
  return { 'base:uv.lock': lock('1'), 'head:uv.lock': lock('2') };
}
test('splits more than 32 changes into exact source memberships accepted by real T4', async () => {
  const r = reconcileUvGraph(await uvGraphFixture(manyUvFiles(35)));
  expect(r.kind).toBe('inventory');
  if (r.kind !== 'inventory') throw new Error('inventory');
  expect(r.changes).toHaveLength(35);
  expect(r.sources.every((s) => s.memberIds.length <= 32)).toBe(true);
  for (const c of r.changes)
    for (const side of [c.from, c.to])
      if (side) expect(r.sources.find((s) => s.id === side.sourceId)?.memberIds).toContain(c.id);
  const { packet, expected } = uvPacket(r),
    p = validateReviewPacket(packet, expected);
  expect(p.ok, JSON.stringify(p)).toBe(true);
});
test.each([128, 129])(
  'retains %s known changes for authoritative combined packet accounting',
  async (count) => {
    const input = await uvGraphFixture(manyUvFiles(count));
    input.limits.maxGraphWork = 10_000_000;
    const r = reconcileUvGraph(input);
    expect(r.kind).toBe('inventory');
    if (r.kind !== 'inventory') throw new Error('inventory');
    expect(r.changes).toHaveLength(count);
    const { packet, expected } = uvPacket(r);
    expect(validateReviewPacket(packet, expected).ok).toBe(count === 128);
  },
);
test('output and identities are invariant under unordered snapshot permutations', async () => {
  const input = await uvGraphFixture(manyUvFiles(3)),
    r = reconcileUvGraph(input);
  const copy = JSON.parse(JSON.stringify(input));
  copy.metadata.sources.reverse();
  copy.metadata.roots[0].base.lock.data.packages.reverse();
  copy.metadata.roots[0].head.lock.data.packages.reverse();
  expect(reconcileUvGraph(copy)).toEqual(r);
});
test('all failed reads produce unavailable inventory rather than partial empty success', async () => {
  const input = await uvGraphFixture({
    'base:uv.lock': 'not toml',
    'head:uv.lock': 'not toml',
    'base:pyproject.toml': 'not toml',
    'head:pyproject.toml': 'not toml',
  });
  expect(reconcileUvGraph(input)).toMatchObject({
    kind: 'inventory',
    changes: [],
    coverage: { status: 'unavailable' },
  });
});
test('budget exhaustion cannot return a deceptively usable change prefix', async () => {
  const input = await uvGraphFixture(manyUvFiles(35));
  expect(
    reconcileUvGraph({ ...input, limits: { ...input.limits, maxRetainedBytes: 10_000 } }),
  ).toEqual({ kind: 'unavailable', reason: 'budget' });
});
test('serialized output bytes are enforced inclusively without trimming observations', async () => {
  const input = await uvGraphFixture(),
    result = reconcileUvGraph(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('inventory');
  const size = Buffer.byteLength(JSON.stringify(result));
  expect(
    reconcileUvGraph({ ...input, limits: { ...input.limits, maxRetainedBytes: size } }),
  ).toEqual(result);
  expect(
    reconcileUvGraph({ ...input, limits: { ...input.limits, maxRetainedBytes: size - 1 } }),
  ).toEqual({ kind: 'unavailable', reason: 'budget' });
});
test('unknown normalized fields and cyclic or sparse inputs are rejected without diagnostic leakage', async () => {
  const input = await uvGraphFixture();
  const copy = JSON.parse(JSON.stringify(input));
  copy.metadata.roots[0].head.lock.data.packages[0].unknown = 'sensitive-untrusted';
  const result = reconcileUvGraph(copy);
  expect(result).toEqual({ kind: 'invalid' });
  expect(JSON.stringify(result)).not.toContain('sensitive-untrusted');
  const cycle: Record<string, unknown> = { ...input };
  cycle.cycle = cycle;
  expect(reconcileUvGraph(cycle)).toEqual({ kind: 'invalid' });
  const sparse = JSON.parse(JSON.stringify(input));
  sparse.metadata.roots[0].head.lock.data.packages = Array(3);
  expect(reconcileUvGraph(sparse)).toEqual({ kind: 'invalid' });
});
test('inconsistent root state and hostile data cannot manufacture complete inventory', async () => {
  const input = await uvGraphFixture(),
    copy = JSON.parse(JSON.stringify(input));
  copy.metadata.roots[0].head.state = 'absent';
  expect(reconcileUvGraph(copy)).toEqual({ kind: 'invalid' });
  let calls = 0;
  const hostile = { ...input };
  Object.defineProperty(hostile, 'metadata', {
    get() {
      calls++;
      return input.metadata;
    },
    enumerable: true,
  });
  expect(reconcileUvGraph(hostile)).toEqual({ kind: 'invalid' });
  expect(calls).toBe(0);
  const proxy = new Proxy(input, {});
  expect(reconcileUvGraph(proxy)).toEqual({ kind: 'invalid' });
});
