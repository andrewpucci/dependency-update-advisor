import { expect, test } from 'vite-plus/test';
import { reconcileUvGraph } from './uv-graph.js';
import { uvGraphFixture, uvLock, uvPacket } from '../../tests/parity/uv-graph.js';
import { validateReviewPacket } from '../schema.js';

test('reconciles a direct registry update through real U1 and T4 without claiming research', async () => {
  const input = await uvGraphFixture();
  expect(input.metadata.gaps).toEqual([]);
  const result = reconcileUvGraph(input);
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected inventory');
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({
    kind: 'update',
    role: 'direct',
    from: { name: 'orbit', version: '1' },
    to: { version: '2' },
    evidence: {
      upstream: { status: 'unavailable' },
      vulnerability: { status: 'unavailable' },
      malware: { status: 'unavailable' },
    },
  });
  expect(result.coverage.status).toBe('complete');
  expect(result.comparison).toEqual({ status: 'unavailable', reasons: ['permission'] });
  const { packet, expected } = uvPacket(result);
  const validated = validateReviewPacket(packet, expected);
  expect(validated.ok, JSON.stringify(validated)).toBe(true);
  expect(Object.isFrozen(result.changes[0])).toBe(true);
  expect(reconcileUvGraph(input)).toEqual(result);
});
test('proves unchanged supported inventory without inventing a self-project dependency', async () => {
  const result = reconcileUvGraph(await uvGraphFixture({ 'head:uv.lock': uvLock('1') }));
  expect(result).toMatchObject({
    kind: 'inventory',
    changes: [],
    coverage: { status: 'complete' },
  });
});
test('rejects mismatched handoff identity and invalid limits without caller mutation', async () => {
  const input = await uvGraphFixture();
  expect(
    reconcileUvGraph({ ...input, binding: { ...input.binding, baseSha: 'f'.repeat(40) } }),
  ).toEqual({ kind: 'invalid' });
  for (const n of [0, -1, 1.1, Infinity, NaN])
    expect(reconcileUvGraph({ ...input, limits: { ...input.limits, maxGraphWork: n } })).toEqual({
      kind: 'invalid',
    });
  const changed = JSON.parse(JSON.stringify(input));
  changed.metadata.roots[0].head.lock.commitSha = 'f'.repeat(40);
  expect(reconcileUvGraph(changed)).toEqual({ kind: 'invalid' });
});
test('preserves U1 failure discriminants and reports bounded exhaustion', async () => {
  const input = await uvGraphFixture();
  for (const metadata of [
    { kind: 'invalid' },
    { kind: 'obsolete' },
    { kind: 'unavailable', reason: 'permission' },
  ])
    expect(reconcileUvGraph({ ...input, metadata })).toEqual(metadata);
  for (const metadata of [
    { kind: 'invalid', extra: { retained: true } },
    { kind: 'obsolete', reason: 'timeout' },
    { kind: 'unavailable', reason: 'permission', detail: 'x' },
  ])
    expect(reconcileUvGraph({ ...input, metadata })).toEqual({ kind: 'invalid' });
  expect(reconcileUvGraph({ ...input, limits: { ...input.limits, maxGraphWork: 1 } })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(reconcileUvGraph({ ...input, limits: { ...input.limits, maxRetainedBytes: 1 } })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});
