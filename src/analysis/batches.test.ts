import { expect, test } from 'vite-plus/test';
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
