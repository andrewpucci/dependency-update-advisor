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
