import { expect, test, vi } from 'vite-plus/test';
import { analyzeMistralBatch } from './analysis/mistral.js';
import { assessReviewPacket, reviewPacket } from './assessment.js';
import type { MistralCategory } from './analysis/mistral.js';
import { MODEL_FAILURE_CATEGORIES } from './review.js';
import * as batchesModule from './analysis/batches.js';
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
  expect(result).toEqual({ kind: 'model-unavailable', reason: 'no-key' });
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

vi.mock('./analysis/batches.js', async (original) => {
  const actual = await original<typeof import('./analysis/batches.js')>();
  return { ...actual, analyzeDecisionUnits: vi.fn(actual.analyzeDecisionUnits) };
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
  expect(result).toEqual({ kind: 'model-unavailable', reason: 'json', body: null });
  expect(render).not.toHaveBeenCalled();
  render.mockRestore();
});

test('does not invoke the model or renderer without a key or with invalid config', async () => {
  const { review } = await fixture();
  const render = vi.spyOn(reportingModule, 'renderDecisionBrief');
  await expect(reviewPacket({ ...review, apiKey: null })).resolves.toEqual({
    kind: 'model-unavailable',
    reason: 'no-key',
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

test('does not report success when research could not establish its evidence', async () => {
  const { review, complete } = await fixture();
  const result = await reviewPacket({ ...review, researchIncomplete: true, model: complete });
  expect(result.kind).toBe('incomplete-evidence');
  expect(result.body).toEqual(expect.stringContaining(review.packet.binding.headSha));
});

test('names an oversized brief as a budget gap, and no other renderer failure', async () => {
  const { review, complete } = await fixture();
  const render = vi.spyOn(reportingModule, 'renderDecisionBrief');
  render.mockReturnValueOnce({ ok: false, category: 'size' });
  await expect(reviewPacket({ ...review, model: complete })).resolves.toEqual({
    kind: 'internal-failure',
    body: null,
    gaps: [{ source: 'brief', reason: 'budget' }],
  });
  for (const category of ['input', 'reference', 'content'] as const) {
    render.mockReturnValueOnce({ ok: false, category });
    await expect(reviewPacket({ ...review, model: complete })).resolves.toEqual({
      kind: 'internal-failure',
      body: null,
    });
  }
  render.mockRestore();
});

test.each([
  ['an unresolved unit', { counts: { unresolvedUnits: 1 } }],
  ['an inventory gap', { inventoryGaps: [{ ecosystem: 'npm' }] }],
])('is not complete with a do-not-merge verdict and %s', async (_label, change) => {
  const { review, complete } = await fixture();
  const actual =
    await vi.importActual<typeof import('./analysis/batches.js')>('./analysis/batches.js');
  vi.mocked(batchesModule.analyzeDecisionUnits).mockImplementationOnce(async (...args) => {
    const real = await actual.analyzeDecisionUnits(...args);
    if (!real.ok) return real;
    return {
      ...real,
      coverage: {
        ...real.coverage,
        // The verdict alone says "advice", which used to be read as a finished review.
        outcome: { kind: 'advice', verdict: 'do_not_merge' },
        inventoryGaps:
          'inventoryGaps' in change ? change.inventoryGaps : real.coverage.inventoryGaps,
        counts: {
          ...real.coverage.counts,
          ...('counts' in change ? change.counts : {}),
        },
      },
    } as never;
  });
  const result = await assessReviewPacket({ ...review, model: complete });
  expect(result.kind).toBe('incomplete-evidence');
});

test('is complete with a do-not-merge verdict when nothing is unresolved and nothing is missing', async () => {
  const { review, complete } = await fixture();
  const actual =
    await vi.importActual<typeof import('./analysis/batches.js')>('./analysis/batches.js');
  vi.mocked(batchesModule.analyzeDecisionUnits).mockImplementationOnce(async (...args) => {
    const real = await actual.analyzeDecisionUnits(...args);
    if (!real.ok) return real;
    return {
      ...real,
      coverage: {
        ...real.coverage,
        outcome: { kind: 'advice', verdict: 'do_not_merge' },
        inventoryGaps: [],
        counts: { ...real.coverage.counts, unresolvedUnits: 0 },
      },
    } as never;
  });
  const result = await assessReviewPacket({ ...review, model: complete });
  expect(result.kind).toBe('complete');
});

test('is not complete with a do-not-merge verdict and a gap in one unit', async () => {
  const { review, complete } = await fixture();
  const actual =
    await vi.importActual<typeof import('./analysis/batches.js')>('./analysis/batches.js');
  vi.mocked(batchesModule.analyzeDecisionUnits).mockImplementationOnce(async (...args) => {
    const real = await actual.analyzeDecisionUnits(...args);
    if (!real.ok) return real;
    const assessments = real.coverage.policyProvenance.assessments;
    return {
      ...real,
      coverage: {
        ...real.coverage,
        outcome: { kind: 'advice', verdict: 'do_not_merge' },
        inventoryGaps: [],
        counts: { ...real.coverage.counts, unresolvedUnits: 0 },
        policyProvenance: {
          ...real.coverage.policyProvenance,
          assessments: {
            ...assessments,
            units: assessments.units.map((unit, index) =>
              index === 0 ? { ...unit, gaps: [{ category: 'vulnerability' }] } : unit,
            ),
          },
        },
      },
    } as never;
  });
  const result = await assessReviewPacket({ ...review, model: complete });
  expect(result.kind).toBe('incomplete-evidence');
});

type FailedModel = NonNullable<Parameters<typeof reviewPacket>[0]['model']>;
/** A model seam whose every batch fails with the category the caller picks for that call. */
function failingModel(category: (call: number) => string): FailedModel {
  let call = 0;
  return {
    now: () => 0,
    analyze: (async (batch: { batchId: string; unitIds: readonly string[] }) => {
      const picked = category(call++);
      return {
        kind: 'failed',
        category: picked,
        attempted: true,
        batchId: batch.batchId,
        unitIds: batch.unitIds,
        diagnostics: { provider: 'mistral' },
      };
    }) as never,
  };
}

test.each([...MODEL_FAILURE_CATEGORIES])(
  'names the %s category as the fixed reason for an unavailable analysis',
  async (category) => {
    const { review } = await fixture();
    const result = await reviewPacket({ ...review, model: failingModel(() => category) });
    expect(result).toEqual({ kind: 'model-unavailable', reason: category, body: null });
    const assessed = await assessReviewPacket({ ...review, model: failingModel(() => category) });
    expect(assessed).toEqual({ kind: 'model-unavailable', reason: category });
  },
);

test('reports a category outside the closed list as unknown, never as the raw text', async () => {
  const { review } = await fixture();
  const raw = 'RAW_PROVIDER_TEXT sentinel-model-key';
  const result = await reviewPacket({ ...review, model: failingModel(() => raw) });
  expect(result).toEqual({ kind: 'model-unavailable', reason: 'unknown', body: null });
  expect(JSON.stringify(result)).not.toContain('RAW_PROVIDER_TEXT');
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('reports the first unit in inventory order, not the alphabetically first category', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { scenario, input } = await analysisScenario({ inventory: { children: 20 } });
  if (!scenario.packet.ok) throw new Error('fixture packet');
  const calls: string[] = [];
  const picked = (call: number) => {
    const category = call === 0 ? 'transport' : 'deadline';
    calls.push(category);
    return category;
  };
  const result = await assessReviewPacket({
    packet: scenario.packet.packet,
    config: input.config,
    apiKey: sentinel,
    evaluatedAt: input.evaluatedAt,
    deadlineMs: 700_000,
    model: failingModel(picked),
  });
  // At least two batches ran with different categories; the first batch holds the first unit.
  expect(new Set(calls).size).toBeGreaterThan(1);
  expect(result).toEqual({ kind: 'model-unavailable', reason: 'transport' });
});

test('carries no reason on any other outcome', async () => {
  const { review, complete } = await fixture();
  const done = await reviewPacket({ ...review, model: complete });
  expect(done).not.toHaveProperty('reason');
  const invalid = await reviewPacket({
    ...review,
    config: { ok: false, error: { file: 'x', category: 'json', field: '$' } },
  });
  expect(invalid).not.toHaveProperty('reason');
});

test('the closed reason list covers every category M1 can report', () => {
  // A compile-time check: a new MistralCategory missing from the list fails `npm run check`.
  const covered: [Exclude<MistralCategory, (typeof MODEL_FAILURE_CATEGORIES)[number]>] extends [
    never,
  ]
    ? true
    : false = true;
  expect(covered).toBe(true);
});
