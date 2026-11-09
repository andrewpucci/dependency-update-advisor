import { expect, test } from 'vite-plus/test';
import { createRehearsalSink, createReviewHandoff } from './handoff.js';
import { createTestClaimStore } from './review.js';

test('keeps a fresh failure status-only and refuses a usable app token', async () => {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  await expect(createReviewHandoff(claims, claimed, 'invalid-config')).resolves.toMatchObject({
    kind: 'ready',
    handoff: { status: 'failure', comment: 'none' },
  });
  expect(createRehearsalSink('sentinel-app-token')).toBeNull();
});

test('records only bounded redacted intent and rejects a lost claim', async () => {
  const claims = createTestClaimStore();
  const first = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  const replacement = await claims.claim([101, 301, 402, 1, 42, 'b'.repeat(40)]);
  if (first.kind !== 'owned' || replacement.kind !== 'owned') throw new Error('fixture must own');
  await expect(createReviewHandoff(claims, first, 'complete')).resolves.toEqual({ kind: 'stale' });
  const result = await createReviewHandoff(claims, replacement, 'complete');
  if (result.kind !== 'ready') throw new Error('expected handoff');
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  expect(sink.record(result.handoff)).toBe(true);
  expect(sink.traces()).toEqual([
    {
      kind: 'complete',
      identity: [101, 301, 402, 1, 42, 'b'.repeat(40)],
      generation: 2,
      status: 'success',
      comment: 'eligible',
    },
  ]);
});
