import { expect, test } from 'vite-plus/test';
import {
  createTestClaimStore,
  reviewOutcome,
  type ClaimResult,
  type OwnedClaim,
  type ReviewIdentity,
} from './review.js';

const head = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);

const attempt = (runAttempt: number, sha = head): ReviewIdentity => [
  101,
  301,
  401,
  runAttempt,
  42,
  sha,
];

function owned(value: ClaimResult): OwnedClaim {
  expect(value.kind).toBe('owned');
  if (value.kind !== 'owned') throw new Error('expected owned claim');
  return value;
}

test('exclusively claims one attempt and rejects duplicate delivery', async () => {
  const claims = createTestClaimStore();
  const first = owned(await claims.claim(attempt(1)));

  expect(first).toMatchObject({ kind: 'owned', generation: 1, identity: attempt(1) });
  await expect(claims.claim(attempt(1))).resolves.toEqual({
    kind: 'duplicate',
    identity: attempt(1),
  });
  await expect(claims.read(first)).resolves.toEqual(first);
});

test('supersedes the earlier owner for a later eligible attempt on the same PR', async () => {
  const claims = createTestClaimStore();
  const first = owned(await claims.claim(attempt(1)));
  const second = owned(await claims.claim(attempt(2)));

  expect(second).toMatchObject({ kind: 'owned', generation: 2, identity: attempt(2) });
  await expect(claims.read(first)).resolves.toEqual({
    kind: 'lost',
    identity: attempt(1),
    generation: 1,
  });
  await expect(claims.read(second)).resolves.toEqual(second);
});

test('does not let an abandoned identity resume, but accepts a new eligible attempt', async () => {
  const claims = createTestClaimStore();
  const first = owned(await claims.claim(attempt(1)));

  await claims.abandon(first);
  await expect(claims.claim(attempt(1))).resolves.toEqual({
    kind: 'duplicate',
    identity: attempt(1),
  });
  await expect(claims.claim(attempt(2, nextHead))).resolves.toMatchObject({
    kind: 'owned',
    generation: 2,
    identity: attempt(2, nextHead),
  });
});

test.each([
  ['skipped', 'none', 'none'],
  ['stale', 'none', 'none'],
  ['invalid-config', 'failure', 'none'],
  ['incomplete-evidence', 'failure', 'eligible'],
  ['model-unavailable', 'failure', 'none'],
  ['complete', 'success', 'eligible'],
  ['internal-failure', 'failure', 'none'],
] as const)('%s has the contracted status and comment eligibility', (kind, status, comment) => {
  expect(reviewOutcome(kind)).toEqual({ kind, status, comment });
});
