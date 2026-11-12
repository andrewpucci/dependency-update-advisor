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

test('keeps a fixed internal-failure stage in the bounded rehearsal trace', async () => {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const result = await createReviewHandoff(claims, claimed, 'internal-failure', {
    body: false,
    gaps: [],
    stage: 'handoff',
  });
  if (result.kind !== 'ready') throw new Error('expected handoff');
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  expect(sink.record(result.handoff)).toBe(true);
  expect(sink.traces()[0]).toMatchObject({ kind: 'internal-failure', stage: 'handoff' });
});

test('maps an invalid internal-failure stage to the fixed catch-all', async () => {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const result = await createReviewHandoff(claims, claimed, 'internal-failure', {
    body: false,
    gaps: [],
    stage: 'sentinel-invalid-stage' as never,
  });
  if (result.kind !== 'ready') throw new Error('expected handoff');
  expect(result.handoff).toMatchObject({ kind: 'internal-failure', stage: 'unclassified' });
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
      body: 'absent',
      gaps: [],
      droppedOptional: { reachability: 0, proof: 0 },
    },
  ]);
});

test('bounds the rehearsal trace at 32 records and refuses the next', async () => {
  const claims = createTestClaimStore();
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const result = await createReviewHandoff(claims, claimed, 'complete');
  if (result.kind !== 'ready') throw new Error('expected handoff');
  for (let index = 0; index < 32; index += 1) expect(sink.record(result.handoff)).toBe(true);
  expect(sink.record(result.handoff)).toBe(false);
  expect(sink.traces()).toHaveLength(32);
});

test('records whether a body exists and which sources gave no usable evidence', async () => {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const gaps = [{ source: 'npm', reason: 'budget' }] as const;
  const result = await createReviewHandoff(claims, claimed, 'incomplete-evidence', {
    body: true,
    gaps,
  });
  if (result.kind !== 'ready') throw new Error('expected handoff');
  expect(result.handoff).toMatchObject({
    kind: 'incomplete-evidence',
    status: 'failure',
    // What an outcome may eventually do stays the spec's table; the body is reported separately.
    comment: 'eligible',
    body: 'present',
    gaps: [{ source: 'npm', reason: 'budget' }],
  });
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  sink.record(result.handoff);
  expect(sink.traces()[0]).toMatchObject({
    body: 'present',
    gaps: [{ source: 'npm', reason: 'budget' }],
  });
  expect(Object.isFrozen(result.handoff.gaps)).toBe(true);
  expect(Object.isFrozen(sink.traces()[0].gaps)).toBe(true);
});

test('records bounded counts when packet fitting drops optional evidence', async () => {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const result = await createReviewHandoff(claims, claimed, 'complete', {
    body: true,
    gaps: [],
    droppedOptional: [
      { kind: 'reachability', ecosystem: 'npm', key: 'one' },
      { kind: 'proof', ecosystem: 'uv', key: 'two' },
      { kind: 'reachability', ecosystem: 'npm', key: 'three' },
    ],
  });
  if (result.kind !== 'ready') throw new Error('expected handoff');
  expect(result.handoff.droppedOptional).toEqual({ reachability: 2, proof: 1 });
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  sink.record(result.handoff);
  expect(sink.traces()[0].droppedOptional).toEqual({ reachability: 2, proof: 1 });
});

test('defaults to no body and no gaps, and keeps at most four gaps', async () => {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const plain = await createReviewHandoff(claims, claimed, 'stale');
  if (plain.kind !== 'ready') throw new Error('expected handoff');
  expect(plain.handoff).toMatchObject({
    body: 'absent',
    gaps: [],
    droppedOptional: { reachability: 0, proof: 0 },
  });
  const many = await createReviewHandoff(claims, claimed, 'incomplete-evidence', {
    body: false,
    gaps: Array.from({ length: 9 }, () => ({ source: 'uv' as const, reason: 'unknown' as const })),
  });
  if (many.kind !== 'ready') throw new Error('expected handoff');
  expect(many.handoff.gaps).toHaveLength(4);
});

async function internalFailureHandoff(stage: 'freshness' | 'snapshot') {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 42, 'a'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const result = await createReviewHandoff(claims, claimed, 'internal-failure', {
    body: false,
    gaps: [],
    stage,
  });
  if (result.kind !== 'ready') throw new Error('expected handoff');
  return result.handoff;
}

test('keeps the fixed freshness detail in the trace, frozen, and off the handoff', async () => {
  const handoff = await internalFailureHandoff('freshness');
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  const detail = { field: 'run', reason: 'budget' } as const;
  expect(sink.record(handoff, detail)).toBe(true);
  expect(sink.traces()[0]).toMatchObject({
    kind: 'internal-failure',
    stage: 'freshness',
    detail: { field: 'run', reason: 'budget' },
  });
  expect(Object.isFrozen(sink.traces()[0]?.detail)).toBe(true);
  expect(sink.traces()[0]?.detail).not.toBe(detail);
  expect(handoff).not.toHaveProperty('detail');
  expect(handoff).not.toHaveProperty('field');
});

test('records the detail only for a freshness internal failure', async () => {
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  const detail = { field: 'run', reason: 'budget' } as const;
  sink.record(await internalFailureHandoff('snapshot'), detail);
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 43, 'b'.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const complete = await createReviewHandoff(claims, claimed, 'complete', {
    body: true,
    gaps: [],
  });
  if (complete.kind !== 'ready') throw new Error('expected handoff');
  sink.record(complete.handoff, detail);
  expect(sink.traces()).toHaveLength(2);
  for (const trace of sink.traces()) expect(trace).not.toHaveProperty('detail');
});

test('copies only the fixed field and reason into the trace', async () => {
  const handoff = await internalFailureHandoff('freshness');
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  const detail = { field: 'run', reason: 'budget', extra: 'sentinel-extra' } as never;
  sink.record(handoff, detail);
  expect(sink.traces()[0]?.detail).toEqual({ field: 'run', reason: 'budget' });
});

async function handoffOf(kind: 'model-unavailable' | 'complete', head: string) {
  const claims = createTestClaimStore();
  const claimed = await claims.claim([101, 301, 401, 1, 44, head.repeat(40)]);
  if (claimed.kind !== 'owned') throw new Error('fixture must own');
  const result = await createReviewHandoff(claims, claimed, kind, { body: false, gaps: [] });
  if (result.kind !== 'ready') throw new Error('expected handoff');
  return result.handoff;
}

test('keeps the fixed model-unavailable reason in the trace, frozen, and off the handoff', async () => {
  const handoff = await handoffOf('model-unavailable', 'c');
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  expect(sink.record(handoff, { modelUnavailableReason: 'http-auth' })).toBe(true);
  expect(sink.traces()[0]).toMatchObject({
    kind: 'model-unavailable',
    modelUnavailableReason: 'http-auth',
  });
  expect(handoff).not.toHaveProperty('modelUnavailableReason');
  expect(handoff).not.toHaveProperty('reason');
  expect(sink.traces()[0]).not.toHaveProperty('detail');
});

test('narrows a stray model-unavailable reason to unknown and copies no other field', async () => {
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  sink.record(await handoffOf('model-unavailable', 'd'), {
    modelUnavailableReason: 'RAW_PROVIDER_TEXT',
    extra: 'sentinel-extra',
  } as never);
  const trace = sink.traces()[0];
  expect(trace).toMatchObject({ modelUnavailableReason: 'unknown' });
  expect(JSON.stringify(trace)).not.toContain('RAW_PROVIDER_TEXT');
  expect(JSON.stringify(trace)).not.toContain('sentinel-extra');
});

test('records the model-unavailable reason only for a model-unavailable outcome', async () => {
  const sink = createRehearsalSink(null);
  if (!sink) throw new Error('expected sink');
  sink.record(await handoffOf('complete', 'e'), { modelUnavailableReason: 'transport' });
  sink.record(await internalFailureHandoff('freshness'), { modelUnavailableReason: 'transport' });
  sink.record(await handoffOf('model-unavailable', 'f'), { field: 'run', reason: 'budget' });
  expect(sink.traces()).toHaveLength(3);
  for (const trace of sink.traces()) {
    expect(trace).not.toHaveProperty('modelUnavailableReason');
    expect(trace).not.toHaveProperty('detail');
  }
});
