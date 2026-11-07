import { parseReviewConfig } from '../../src/config.js';
import { policySignalScenario, type SignalScenarioOptions } from './policy-signals.js';

/** Invented immutable inputs through actual collectors and T4/T5; no live services. */
export async function analysisScenario(options: SignalScenarioOptions = {}) {
  const scenario = await policySignalScenario(options);
  const config = parseReviewConfig(
    JSON.stringify({
      version: 1,
      analysis: { provider: 'mistral', model: 'synthetic-model' },
    }),
  );
  return {
    scenario,
    input: {
      inventory: scenario.units,
      config,
      evaluatedAt: Date.parse('2026-11-07T00:00:00Z'),
      unitIds: scenario.units.units.map((unit) => unit.id),
    },
  };
}
