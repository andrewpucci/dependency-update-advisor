import { expect, test, vi } from 'vite-plus/test';
import { analysisDocument, analysisScenario } from '../../tests/parity/analysis.js';
import { analyzeMistralBatch } from './mistral.js';
import { analyzeDecisionUnits } from './batches.js';

test('retains assessments from an owned M1 batch in inventory order', async () => {
  const { input } = await analysisScenario();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(result.records.map((record) => record.unitId)).toEqual(input.unitIds);
  expect(result.records.every((record) => record.state.state === 'assessed')).toBe(true);
  expect(result.records.every((record) => record.assessment?.unitId === record.unitId)).toBe(true);
  expect(result.coverage.counts.assessedUnits).toBe(input.unitIds.length);
});

test('missing credentials yield unavailable records without discarding policy coverage', async () => {
  const { input } = await analysisScenario();
  const result = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(
    result.records.every((record) => record.state.state === 'unavailable' && !record.attempted),
  ).toBe(true);
  expect(result.analysisUnavailable).toBe(true);
  expect(result.coverage.counts.unresolvedUnits).toBe(input.unitIds.length);
});

test('malformed provider content is rejected without exposing it', async () => {
  const { input } = await analysisScenario();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: 'SECRET-SENTINEL' },
                },
              ],
            }),
        }),
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(
    result.records.every((record) => record.state.state === 'rejected' && record.attempted),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SECRET-SENTINEL');
});

test('packs a large inventory into bounded batches without losing units', async () => {
  const { input } = await analysisScenario({ inventory: { children: 12 } });
  const packet = { ...input.inventory.packet, relationships: [] };
  const { formDecisionUnits } = await import('../units.js');
  const inventory = formDecisionUnits(packet);
  expect(inventory.units.length).toBeGreaterThan(8);
  const batches: number[] = [];
  const result = await analyzeDecisionUnits(
    { ...input, inventory },
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) => {
        batches.push(batch.unitIds.length);
        return analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        });
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(batches.every((length) => length <= 8)).toBe(true);
  expect(result.records.map((record) => record.unitId)).toEqual(
    inventory.units.map((unit) => unit.id),
  );
  expect(result.records.every((record) => record.state.state === 'assessed')).toBe(true);
});

test('dispatches two batches in a wave and retains results in inventory order', async () => {
  const { input } = await analysisScenario({ inventory: { children: 12 } });
  const { formDecisionUnits } = await import('../units.js');
  const inventory = formDecisionUnits({ ...input.inventory.packet, relationships: [] });
  const release: Array<() => void> = [];
  const running = analyzeDecisionUnits(
    { ...input, inventory },
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: async (batch, options) => {
        await new Promise<void>((resolve) => release.push(resolve));
        return analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        });
      },
    },
  );
  await vi.waitFor(() => expect(release).toHaveLength(2), { timeout: 500 });
  release[1]();
  release[0]();
  const result = await running;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(result.records.map((record) => record.unitId)).toEqual(
    inventory.units.map((unit) => unit.id),
  );
});

test('splits only recognized length truncations down to successful single units', async () => {
  const { input } = await analysisScenario();
  const sizes: number[] = [];
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) => {
        sizes.push(batch.unitIds.length);
        return analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: batch.unitIds.length > 1 ? 'length' : 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        });
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(sizes[0]).toBeGreaterThan(1);
  expect(sizes.filter((size) => size === 1)).toHaveLength(input.unitIds.length);
  expect(result.records.every((record) => record.state.state === 'assessed')).toBe(true);
});

test('cancellation settles even if transport ignores the signal', async () => {
  const { input } = await analysisScenario();
  const controller = new AbortController();
  const running = analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000, signal: controller.signal },
    {
      now: () => 0,
      analyze: () => new Promise(() => {}),
    },
  );
  controller.abort();
  const result = await running;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(
    result.records.every((record) => record.state.state === 'unavailable' && record.attempted),
  ).toBe(true);
});

test('rejects a mismatched inventory before any request', async () => {
  const { input } = await analysisScenario();
  const analyze = vi.fn();
  const result = await analyzeDecisionUnits(
    { ...input, inventory: { ...input.inventory, units: [] } },
    { apiKey: 'test-key', deadlineMs: 700_000 },
    { now: () => 0, analyze },
  );
  expect(result).toMatchObject({ ok: false, category: 'input' });
  expect(analyze).not.toHaveBeenCalled();
});

test('a thrown transport exception is classified without exposing the error', async () => {
  const { input } = await analysisScenario();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: async () => {
        throw new Error('PRIVATE-SENTINEL');
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(result.records.every((record) => record.state.state === 'unavailable')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-SENTINEL');
});

test('a verified malware hold survives all unavailable model batches', async () => {
  const { input } = await analysisScenario({ mode: 'malware' });
  const result = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(result.analysisUnavailable).toBe(true);
  expect(result.coverage.outcome).toEqual({ kind: 'advice', verdict: 'do_not_merge' });
  expect(result.coverage.counts.unresolvedUnits).toBe(input.unitIds.length);
});

test('non-finite deadlines are rejected before dispatch', async () => {
  const { input } = await analysisScenario();
  const analyze = vi.fn();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: NaN },
    { now: () => 0, analyze },
  );
  expect(result).toMatchObject({ ok: false, category: 'configuration' });
  expect(analyze).not.toHaveBeenCalled();
});

test('request cap leaves split children explicit and retains earlier work', async () => {
  const { input } = await analysisScenario({ inventory: { children: 20 } });
  const { formDecisionUnits } = await import('../units.js');
  const inventory = formDecisionUnits({ ...input.inventory.packet, relationships: [] });
  let calls = 0;
  const result = await analyzeDecisionUnits(
    { ...input, inventory },
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) => {
        calls++;
        return analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: batch.unitIds.length > 1 ? 'length' : 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        });
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(calls).toBe(32);
  expect(result.diagnostics.callsDispatched).toBe(32);
  expect(result.records.some((record) => record.state.state === 'assessed')).toBe(true);
  expect(result.records.some((record) => record.state.state === 'unattempted')).toBe(true);
  expect(result.records.map((record) => record.unitId)).toEqual(
    inventory.units.map((unit) => unit.id),
  );
});

test('expired budget does not dispatch and reports unattempted work', async () => {
  const { input } = await analysisScenario();
  const analyze = vi.fn();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 60_000 },
    { now: () => 0, analyze },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(analyze).not.toHaveBeenCalled();
  expect(
    result.records.every(
      (record) => record.state.state === 'unattempted' && record.category === 'deadline',
    ),
  ).toBe(true);
  expect(result.diagnostics.callsDispatched).toBe(0);
});

test('HTTP failure never splits a batch', async () => {
  const { input } = await analysisScenario();
  let calls = 0;
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () => {
            calls++;
            return Response.json({ error: 'model_length' }, { status: 400 });
          },
        }),
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(calls).toBe(1);
  expect(
    result.records.every(
      (record) => record.state.state === 'unavailable' && record.category === 'http',
    ),
  ).toBe(true);
  expect(result.diagnostics.truncationSplits).toBe(0);
});

test('preparation budget re-packs locally without spending a model call', async () => {
  const { input } = await analysisScenario();
  const contract = await import('./contract.js');
  const prepare = contract.prepareAnalysisBatch;
  const spy = vi.spyOn(contract, 'prepareAnalysisBatch').mockImplementation((value) => {
    const ids = (value as { unitIds: string[] }).unitIds;
    return ids.length > 1
      ? { kind: 'invalid', category: 'budget', attempted: false }
      : prepare(value);
  });
  let calls = 0;
  try {
    const result = await analyzeDecisionUnits(
      input,
      { apiKey: 'test-key', deadlineMs: 700_000 },
      {
        now: () => 0,
        analyze: (batch, options) => {
          calls++;
          return analyzeMistralBatch(batch, options, {
            now: () => 0,
            fetch: async () =>
              Response.json({
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: {
                      role: 'assistant',
                      content: JSON.stringify(analysisDocument(batch)),
                    },
                  },
                ],
              }),
          });
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixture failed');
    expect(spy.mock.calls.length).toBeGreaterThan(calls);
    expect(calls).toBe(input.unitIds.length);
    expect(result.records.every((record) => record.state.state === 'assessed')).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test('a stale response cannot attach an assessment to the current batch', async () => {
  const { input } = await analysisScenario();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: async (batch, options) => {
        const result = await analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        });
        if (result.kind !== 'validated') throw new Error('fixture failed');
        return { ...result, batchId: 'other-batch' };
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(
    result.records.every(
      (record) => record.state.state === 'rejected' && record.assessment === null,
    ),
  ).toBe(true);
});

test('a proven empty inventory makes no call and is not analysis unavailable', async () => {
  const { input } = await analysisScenario();
  const { formDecisionUnits } = await import('../units.js');
  const packet = { ...input.inventory.packet, changes: [], relationships: [], findings: [] };
  const inventory = formDecisionUnits(packet);
  const analyze = vi.fn();
  const result = await analyzeDecisionUnits(
    { ...input, inventory },
    { deadlineMs: 700_000 },
    { now: () => 0, analyze },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(analyze).not.toHaveBeenCalled();
  expect(result.records).toEqual([]);
  expect(result.coverage.outcome).toEqual({ kind: 'empty_inventory' });
  expect(result.analysisUnavailable).toBe(false);
});

test.each([
  ['envelope', true, 'rejected'],
  ['json', true, 'rejected'],
  ['schema', true, 'rejected'],
  ['reference', true, 'rejected'],
  ['policy', true, 'rejected'],
  ['transport', true, 'unavailable'],
  ['http', true, 'unavailable'],
  ['media-type', true, 'unavailable'],
  ['response-size', true, 'unavailable'],
  ['encoding', true, 'unavailable'],
  ['deadline', true, 'unavailable'],
  ['cancelled', true, 'unavailable'],
  ['configuration', false, 'unavailable'],
  ['deadline', false, 'unattempted'],
  ['cancelled', false, 'unattempted'],
] as const)('maps %s attempted=%s to %s', async (category, attempted, expected) => {
  const { input } = await analysisScenario();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: async (batch) =>
        ({
          kind: attempted ? 'failed' : 'unavailable',
          category,
          attempted,
          batchId: batch.batchId,
          unitIds: batch.unitIds,
          diagnostics: {
            provider: 'mistral',
            model: 'synthetic-model',
            headSha: input.inventory.packet.binding.headSha,
            unitCount: batch.unitIds.length,
            memberCount: input.inventory.packet.changes.length,
            attempted,
            category,
          },
        }) as import('./mistral.js').MistralResult,
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(
    result.records.every(
      (record) =>
        record.state.state === expected &&
        record.attempted === attempted &&
        record.category === category,
    ),
  ).toBe(true);
});

test('single-unit length failures remain unavailable without another retry', async () => {
  const { input } = await analysisScenario();
  let calls = 0;
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () => {
            calls++;
            return Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'length',
                  message: { role: 'assistant', content: '{}' },
                },
              ],
            });
          },
        }),
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(calls).toBe(2 * input.unitIds.length - 1);
  expect(
    result.records.every(
      (record) => record.state.state === 'unavailable' && record.category === 'length',
    ),
  ).toBe(true);
  expect(result.analysisUnavailable).toBe(true);
});
