import { expect, test, vi } from 'vite-plus/test';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analysisScenario,
  analysisWithContext,
  capabilityDocument,
} from '../../tests/parity/analysis.js';
import { collectSourceContext } from '../context.js';
import { parseReviewConfig } from '../config.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits } from '../units.js';
import { ANALYSIS_LIMITS, prepareAnalysisBatch, preparedSnapshot } from './contract.js';
import { analyzeMistralBatch } from './mistral.js';

const options = { apiKey: 'SYNTHETIC_MODEL_KEY', deadlineMs: 1000 };

test.each(['available', 'disabled', 'unmatched', 'partial'] as const)(
  'real C2 %s flows through actual POST disclosure and normalized capability advice',
  async (mode) => {
    const { batch, context } = await analysisWithContext(mode);
    const { document, feature, member } = capabilityDocument(batch);
    if (mode !== 'available') {
      document.assessments.find((row) => row.newFunctionality.length)!.newFunctionality = [
        { ...feature, usefulness: 'not_relevant', contextId: null, action: null },
      ];
    }
    const fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(document) },
          },
        ],
      }),
    );
    const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') throw new Error('fixture');
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const wire = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    expect(wire.context.status).toBe(context.status);
    const capability = result.assessments.flatMap((row) => row.newFunctionality)[0]!;
    expect(capability.memberId).toBe(member.id);
    if (mode === 'disabled' || mode === 'unmatched') {
      expect(String(init.body)).not.toContain('import orbit');
      expect(String(init.body)).not.toContain('src/usage.ts');
      expect(wire.context.facts).toEqual([]);
      expect(capability).toMatchObject({
        contextId: null,
        contextPath: null,
        contextStatus: mode === 'disabled' ? 'disabled' : 'unavailable',
      });
    } else {
      expect(String(init.body)).toContain('src/usage.ts');
      expect(
        wire.context.facts.some((fact: { excerpt: string }) =>
          fact.excerpt.includes('import orbit'),
        ),
      ).toBe(true);
      if (mode === 'available')
        expect(capability).toMatchObject({
          contextPath: 'src/usage.ts',
          contextStatus: 'available',
        });
      else expect(capability).toMatchObject({ contextStatus: 'partial', contextPath: null });
    }
    expect(JSON.stringify(result.diagnostics)).not.toContain('src/usage.ts');
    expect(JSON.stringify(result.diagnostics)).not.toContain('import orbit');
    expect(preparedSnapshot(batch)!.contexts.every((fact) => fact.value.memberId !== '')).toBe(
      true,
    );
  },
);

test('real C2 configuration/path failure cannot form a T4-backed analysis request', async () => {
  const { input, scenario } = await analysisScenario();
  const root = await fs.mkdtemp(join(tmpdir(), 'analysis-failed-context-'));
  try {
    const config = parseReviewConfig(
      JSON.stringify({
        version: 1,
        analysis: { provider: 'mistral', model: 'synthetic-model' },
        context: { sendSourceExcerptsToModel: true, excerptFiles: ['../outside.ts'] },
      }),
    );
    const context = await collectSourceContext({
      config,
      checkoutRoot: root,
      visibility: 'private',
      dependencies: [],
      trackedFiles: (async function* () {})(),
    });
    expect(context.ok).toBe(false);
    const accepted = validateReviewPacket(
      { ...input.inventory.packet, context },
      scenario.fixture.expected,
    );
    expect(accepted.ok).toBe(false);
    const fetch = vi.fn(async () => {
      throw new Error('must not dispatch');
    });
    if (accepted.ok) {
      const prepared = prepareAnalysisBatch({
        ...input,
        config,
        inventory: formDecisionUnits(accepted.packet),
        limits: ANALYSIS_LIMITS,
      });
      if (prepared.kind === 'prepared')
        await analyzeMistralBatch(prepared.batch, options, { fetch, now: () => 0 });
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
