import { expect, test, vi } from 'vite-plus/test';
import { analyzeMistralBatch } from './analysis/mistral.js';
import { assessReviewPacket, reviewPacket } from './assessment.js';
import * as reportingModule from './reporting.js';

test('refuses an absent model credential before analysis input is constructed', async () => {
  const result = await assessReviewPacket({
    packet: {} as never,
    config: {
      ok: true,
      config: {} as never,
      origin: 'missing',
      overrides: {},
      minimumReleaseAgeDaysExplicit: false,
    },
    apiKey: null,
    evaluatedAt: 0,
    deadlineMs: 1,
  });
  expect(result).toEqual({ kind: 'model-unavailable' });
});

test('invalid config stays status-only without invoking model analysis', async () => {
  const result = await assessReviewPacket({
    packet: {} as never,
    config: {
      ok: false,
      error: { file: '.github/dependabot-review.json', category: 'json', field: '$' },
    },
    apiKey: 'sentinel-model-key',
    evaluatedAt: 0,
    deadlineMs: 1,
  });
  expect(result).toEqual({ kind: 'internal-failure' });
  expect(JSON.stringify(result)).not.toContain('sentinel-model-key');
});

const sentinel = 'sentinel-model-key';

async function fixture() {
  const { analysisDocument, analysisScenario } = await import('../tests/parity/analysis.js');
  const { scenario, input } = await analysisScenario();
  if (!scenario.packet.ok) throw new Error('fixture packet');
  type Batch = Parameters<typeof analyzeMistralBatch>[0];
  const respond = (content: (batch: Batch) => string) => ({
    now: () => 0,
    analyze: ((batch: Batch, options: Parameters<typeof analyzeMistralBatch>[1]) =>
      analyzeMistralBatch(batch, options, {
        now: () => 0,
        fetch: async () =>
          Response.json({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: content(batch) },
              },
            ],
          }),
      })) as typeof analyzeMistralBatch,
  });
  return {
    review: {
      packet: scenario.packet.packet,
      config: input.config,
      apiKey: sentinel,
      evaluatedAt: input.evaluatedAt,
      deadlineMs: 700_000,
      signalAttempts: scenario.result.attempts,
    },
    complete: respond((batch) => JSON.stringify(analysisDocument(batch as never))),
    garbage: respond(() => 'not json'),
  };
}

test('renders a comment body for a complete assessment without leaking the model key', async () => {
  const { review, complete } = await fixture();
  const result = await reviewPacket({ ...review, model: complete });
  expect(result.kind).toBe('complete');
  expect(result.body).toEqual(expect.stringContaining(review.packet.binding.headSha));
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('gives no body when the model result is unusable', async () => {
  const { review, garbage } = await fixture();
  const render = vi.spyOn(reportingModule, 'renderDecisionBrief');
  const result = await reviewPacket({ ...review, model: garbage });
  expect(result).toEqual({ kind: 'model-unavailable', body: null });
  expect(render).not.toHaveBeenCalled();
  render.mockRestore();
});

test('does not invoke the model or renderer without a key or with invalid config', async () => {
  const { review } = await fixture();
  const render = vi.spyOn(reportingModule, 'renderDecisionBrief');
  await expect(reviewPacket({ ...review, apiKey: null })).resolves.toEqual({
    kind: 'model-unavailable',
    body: null,
  });
  await expect(
    reviewPacket({
      ...review,
      config: { ok: false, error: { file: 'x', category: 'json', field: '$' } },
    }),
  ).resolves.toEqual({ kind: 'internal-failure', body: null });
  expect(render).not.toHaveBeenCalled();
  render.mockRestore();
});

test('turns a renderer failure into a status-only failure with no body', async () => {
  const { review, complete } = await fixture();
  const render = vi
    .spyOn(reportingModule, 'renderDecisionBrief')
    .mockReturnValueOnce({ ok: false, category: 'content' });
  const result = await reviewPacket({ ...review, model: complete });
  expect(result).toEqual({ kind: 'internal-failure', body: null });
  render.mockRestore();
});

test('turns a renderer exception into a status-only failure with no body', async () => {
  const { review, complete } = await fixture();
  const render = vi.spyOn(reportingModule, 'renderDecisionBrief').mockImplementationOnce(() => {
    throw new Error(sentinel);
  });
  const result = await reviewPacket({ ...review, model: complete });
  expect(result).toEqual({ kind: 'internal-failure', body: null });
  expect(JSON.stringify(result)).not.toContain(sentinel);
  render.mockRestore();
});

test('hands the renderer the packet binding, the signal attempts, and a UTC timestamp', async () => {
  const { review, complete } = await fixture();
  const render = vi.spyOn(reportingModule, 'renderDecisionBrief');
  await reviewPacket({ ...review, model: complete });
  expect(render).toHaveBeenCalledOnce();
  expect(render.mock.calls[0][0]).toMatchObject({
    binding: review.packet.binding,
    signalBinding: review.packet.binding,
    signalAttempts: review.signalAttempts,
    generatedAt: new Date(review.evaluatedAt).toISOString(),
    analysisUnavailable: false,
  });
  expect(review.signalAttempts.length).toBeGreaterThan(0);
  render.mockRestore();
});

test('invalid config never reaches model analysis', async () => {
  const { review, complete } = await fixture();
  const analyze = vi.fn(complete.analyze);
  await expect(
    reviewPacket({
      ...review,
      config: { ok: false, error: { file: 'x', category: 'json', field: '$' } },
      model: { now: complete.now, analyze },
    }),
  ).resolves.toEqual({ kind: 'internal-failure', body: null });
  expect(analyze).not.toHaveBeenCalled();
});
