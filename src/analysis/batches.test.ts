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

test('completion order does not change dispatched batches, concurrency, or final states', async () => {
  const { input } = await analysisScenario({ inventory: { children: 20 } });
  const { formDecisionUnits } = await import('../units.js');
  const inventory = formDecisionUnits({ ...input.inventory.packet, relationships: [] });
  expect(inventory.units.length).toBeGreaterThan(16);
  const run = async (order: 'forward' | 'reverse') => {
    const dispatched: string[] = [];
    const pending: Array<() => void> = [];
    let maxInFlight = 0;
    let done = false;
    const running = analyzeDecisionUnits(
      { ...input, inventory },
      { apiKey: 'test-key', deadlineMs: 700_000 },
      {
        now: () => 0,
        analyze: async (batch, options) => {
          dispatched.push(batch.batchId);
          await new Promise<void>((resolve) => pending.push(resolve));
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
    ).finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      maxInFlight = Math.max(maxInFlight, pending.length);
      const wave = pending.splice(0);
      (order === 'forward' ? wave : wave.reverse()).forEach((release) => release());
    }
    const result = await running;
    if (!result.ok) throw new Error('fixture failed');
    return { dispatched, maxInFlight, records: result.records };
  };
  const forward = await run('forward');
  const reverse = await run('reverse');
  expect(forward.dispatched.length).toBeGreaterThan(2);
  expect(forward.maxInFlight).toBe(2);
  expect(reverse.maxInFlight).toBe(2);
  expect(reverse.dispatched).toEqual(forward.dispatched);
  expect(reverse.records).toEqual(forward.records);
  expect(forward.records.map((record) => record.unitId)).toEqual(
    inventory.units.map((unit) => unit.id),
  );
  expect(forward.records.every((record) => record.state.state === 'assessed')).toBe(true);
});

test('options that are not an object are rejected before dispatch', async () => {
  const { input } = await analysisScenario();
  const analyze = vi.fn();
  const result = await analyzeDecisionUnits(input, undefined as never, { now: () => 0, analyze });
  expect(result).toMatchObject({ ok: false, category: 'configuration' });
  expect(analyze).not.toHaveBeenCalled();
});

test('an unsent request that settles after the deadline stays unattempted by the provider', async () => {
  const { input } = await analysisScenario();
  let time = 0;
  const result = await analyzeDecisionUnits(
    input,
    { deadlineMs: 700_000 },
    {
      now: () => time,
      analyze: async (batch, options) => {
        const outcome = await analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: vi.fn(),
        });
        time = 1_000_000;
        return outcome;
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(
    result.records.every(
      (record) =>
        record.state.state === 'unavailable' &&
        !record.attempted &&
        record.category === 'configuration',
    ),
  ).toBe(true);
  expect(result.diagnostics.callsDispatched).toBe(0);
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
  const unattempted = result.records.filter((record) => record.state.state === 'unattempted');
  expect(unattempted.length).toBeGreaterThan(0);
  expect(
    unattempted.every((record) => !record.attempted && record.category === 'call_budget'),
  ).toBe(true);
  expect(result.diagnostics.failureCategories).toContain('call_budget');
  expect(result.diagnostics.failureCategories).not.toContain('budget');
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
      (record) => record.state.state === 'unavailable' && record.category === 'http-other',
    ),
  ).toBe(true);
  expect(result.diagnostics.truncationSplits).toBe(0);
});

test('preparation budget re-packs locally without spending a model call', async () => {
  const { input } = await analysisScenario();
  const contract = await import('./contract.js');
  const prepare = contract.prepareRunBatch;
  const spy = vi.spyOn(contract, 'prepareRunBatch').mockImplementation((run, value) => {
    const ids = value as string[];
    return ids.length > 1
      ? { kind: 'invalid', category: 'budget', attempted: false }
      : prepare(run, value);
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

test('a unit too large to prepare alone reports budget without a call', async () => {
  const { input } = await analysisScenario();
  const contract = await import('./contract.js');
  const spy = vi
    .spyOn(contract, 'prepareRunBatch')
    .mockReturnValue({ kind: 'invalid', category: 'budget', attempted: false });
  const analyze = vi.fn();
  try {
    const result = await analyzeDecisionUnits(
      input,
      { apiKey: 'test-key', deadlineMs: 700_000 },
      { now: () => 0, analyze },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixture failed');
    expect(analyze).not.toHaveBeenCalled();
    expect(
      result.records.every(
        (record) =>
          record.state.state === 'unavailable' && !record.attempted && record.category === 'budget',
      ),
    ).toBe(true);
    expect(result.diagnostics.failureCategories).toEqual(['budget']);
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

test('an unbound result keeps its reported attempted flag', async () => {
  const { input } = await analysisScenario();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test-key', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: async (batch) => {
        const result = await analyzeMistralBatch(batch, { deadlineMs: 700_000 });
        if (result.kind !== 'unavailable' || result.attempted) throw new Error('fixture failed');
        return { ...result, batchId: 'other-batch' };
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture failed');
  expect(result.diagnostics.callsDispatched).toBe(0);
  expect(
    result.records.every(
      (record) =>
        record.state.state === 'rejected' && !record.attempted && record.category === 'reference',
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
  ['http-auth', true, 'unavailable'],
  ['http-rate-limit', true, 'unavailable'],
  ['http-server', true, 'unavailable'],
  ['http-other', true, 'unavailable'],
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

test('run-wide preparation checks happen once regardless of batch count', async () => {
  const { input } = await analysisScenario({ inventory: { children: 20 } });
  const units = await import('../units.js');
  const inventory = units.formDecisionUnits({ ...input.inventory.packet, relationships: [] });
  const spy = vi.spyOn(units, 'evaluateUnitPolicy');
  const analyze = vi.fn(async () => ({ kind: 'unavailable', category: 'http-server' }) as never);
  try {
    const result = await analyzeDecisionUnits(
      { ...input, inventory },
      { apiKey: 'test-key', deadlineMs: 700_000 },
      { now: () => 0, analyze },
    );
    expect(result.ok).toBe(true);
    expect(analyze.mock.calls.length).toBeGreaterThan(2);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

test('a run-wide budget failure prepares once and leaves every unit unavailable without a call', async () => {
  const { input } = await analysisScenario({ inventory: { children: 20 } });
  const units = await import('../units.js');
  const inventory = units.formDecisionUnits({ ...input.inventory.packet, relationships: [] });
  const contract = await import('./contract.js');
  const run = vi
    .spyOn(contract, 'prepareAnalysisRun')
    .mockReturnValue({ kind: 'invalid', category: 'budget', attempted: false });
  const batch = vi.spyOn(contract, 'prepareRunBatch');
  const analyze = vi.fn();
  try {
    const result = await analyzeDecisionUnits(
      { ...input, inventory },
      { apiKey: 'test-key', deadlineMs: 700_000 },
      { now: () => 0, analyze },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixture failed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(batch).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(result.records).toHaveLength(inventory.units.length);
    expect(
      result.records.every(
        (record) =>
          record.state.state === 'unavailable' && !record.attempted && record.category === 'budget',
      ),
    ).toBe(true);
  } finally {
    run.mockRestore();
    batch.mockRestore();
  }
});
