import { expect, test } from 'vite-plus/test';
import type { ReachabilityVerdict, RelationshipProof } from '../schema.js';
import { fitRetained, scopeAll } from './optional-retained.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const pair = (anchorId: string, memberId: string, side: 'base' | 'head'): ReachabilityVerdict => ({
  ecosystem: 'npm',
  side,
  sourceId: 'lock',
  anchorId,
  memberId,
  outcome: 'unreachable',
  reasons: [],
});
const scope = (anchorId: string): ReachabilityVerdict => ({
  ecosystem: 'npm',
  side: 'head',
  sourceId: 'lock',
  anchorId,
  memberId: null,
  outcome: 'unknown',
  reasons: ['unknown'],
});
const proof = {
  fromId: 'a',
  toId: 'm',
  ecosystem: 'npm',
  side: 'head',
  sourceId: 'lock',
} as unknown;
function sample() {
  const verdicts = ['m1', 'm2', 'm3'].flatMap((m) => [pair('a', m, 'head'), pair('a', m, 'base')]);
  return {
    required: 'x'.repeat(200),
    reachability: [...verdicts, scope('b')],
    optionalRelationships: [proof as RelationshipProof],
  };
}
const fail = () => {
  throw new Error('core overflow');
};

test('returns the same result untouched when it fits', () => {
  const result = sample();
  expect(fitRetained(result, bytes(result), fail)).toBe(result);
});

test('scopeAll makes one truncated scope per anchor and side and keeps existing scope records', () => {
  const scoped = scopeAll(sample().reachability);
  expect(
    scoped.filter((v) => v.anchorId === 'a').map((v) => [v.side, v.memberId, v.outcome]),
  ).toEqual(
    expect.arrayContaining([
      ['head', null, 'truncated'],
      ['base', null, 'truncated'],
    ]),
  );
  expect(scoped).toHaveLength(3);
  expect(scoped).toContainEqual(scope('b'));
  expect(
    scoped.filter((v) => v.outcome === 'truncated').every((v) => v.reasons[0] === 'budget'),
  ).toBe(true);
});

test('degrades pair verdicts first, then second proofs, then scope records, never required content', () => {
  const result = sample();
  const core = { ...result, reachability: [], optionalRelationships: [] };
  const scopedOnly = { ...result, reachability: scopeAll(result.reachability) };
  const noProofs = { ...scopedOnly, optionalRelationships: [] };
  const first = fitRetained(result, bytes(scopedOnly), fail);
  expect(first.reachability).toEqual(scopeAll(result.reachability));
  expect(first.optionalRelationships).toHaveLength(1);
  const second = fitRetained(result, bytes(noProofs), fail);
  expect(second.optionalRelationships).toEqual([]);
  expect(second.reachability).toEqual(scopeAll(result.reachability));
  const third = fitRetained(result, bytes(core), fail);
  expect(third).toEqual(core);
  expect(third.required).toBe(result.required);
  expect(() => fitRetained(result, bytes(core) - 1, fail)).toThrow('core overflow');
});
