import { expect, test } from 'vite-plus/test';
import { recordSignal, attachSignalCoverage } from './policy-signals-evidence.js';
import { upstreamScenario } from '../../tests/parity/upstream.js';
import type { PolicySignalInput, SignalEnrichment } from './policy-signals.js';
test('same observations deduplicate and oversized optional facts become explicit truncation', async () => {
  const f = await upstreamScenario(),
    change = structuredClone(f.input.changes[0]) as SignalEnrichment['changes'][number];
  const input = {
    ...f.input,
    evaluationTime: 0,
    limits: { ...f.advisoryLimits, maxAttempts: 100 },
  } as PolicySignalInput;
  const out: SignalEnrichment = {
    kind: 'enriched',
    binding: input.binding,
    changes: [change],
    sources: [],
    findings: [],
    attempts: [],
  };
  const known = { url: 'https://registry.npmjs.org/fixture/1.0.0', value: { identity: 'alice' } };
  const a = recordSignal(input, out, change, 'base', 'publisher', known);
  const b = recordSignal(input, out, change, 'base', 'publisher', known);
  expect(out.sources).toHaveLength(1);
  attachSignalCoverage(change, 'publisher', [a, b]);
  expect(change.evidence.publisher.sourceIds).toHaveLength(1);
  const truncated = recordSignal(input, out, change, 'head', 'publisher', {
    ...known,
    value: { identity: 'x'.repeat(1000) },
  });
  expect(truncated).toMatchObject({
    status: 'unavailable',
    reasons: ['truncated'],
    provenance: { kind: 'unavailable' },
  });
  attachSignalCoverage(change, 'publisher', [a, truncated]);
  expect(change.evidence.publisher.status).toBe('partial');
});
