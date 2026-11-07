import { expect, test } from 'vite-plus/test';
import { canonicalLicense, collectLicenseSignals } from './policy-signals-licenses.js';
import { upstreamScenario } from '../../tests/parity/upstream.js';
import type { PolicySignalInput, SignalEnrichment } from './policy-signals.js';
const limits = { maxBytes: 2048, maxTokens: 100, maxDepth: 20 };
test.each([
  ['MIT', ' (( MIT )) ', 'MIT'],
  ['MIT OR Apache-2.0', ' ( MIT OR Apache-2.0 ) ', '(MIT OR Apache-2.0)'],
  [
    '(MIT AND Apache-2.0) AND BSD-3-Clause',
    'MIT AND (Apache-2.0 AND BSD-3-Clause)',
    '(MIT AND Apache-2.0 AND BSD-3-Clause)',
  ],
  [
    'GPL-2.0+ WITH Classpath-exception-2.0',
    ' ( GPL-2.0+ WITH Classpath-exception-2.0 ) ',
    'GPL-2.0+ WITH Classpath-exception-2.0',
  ],
  ['LicenseRef-Custom', '(LicenseRef-Custom)', 'LicenseRef-Custom'],
  [
    'DocumentRef-Other:LicenseRef-Custom',
    '(DocumentRef-Other:LicenseRef-Custom)',
    'DocumentRef-Other:LicenseRef-Custom',
  ],
])('normalizes only formatting of %s', (a, b, normalized) => {
  expect(canonicalLicense(a, limits)).toEqual({ kind: 'known', value: normalized });
  expect(canonicalLicense(b, limits)).toEqual({ kind: 'known', value: normalized });
});
test('significant operators, exceptions, and version suffixes remain different', () => {
  for (const [a, b] of [
    ['MIT AND Apache-2.0', 'MIT OR Apache-2.0'],
    ['GPL-2.0-only', 'GPL-2.0-or-later'],
    ['GPL-2.0-only WITH Classpath-exception-2.0', 'GPL-2.0-only'],
  ])
    expect(canonicalLicense(a, limits)).not.toEqual(canonicalLicense(b, limits));
  for (const value of [
    'unknown',
    'see LICENSE.txt',
    'mit',
    undefined,
    '('.repeat(30) + 'MIT' + ')'.repeat(30),
  ])
    expect(canonicalLicense(value, limits).kind).toBe('unchecked');
});
test.each(['changed', 'formatting', 'failed'])(
  'license %s observations stay outside required evidence',
  async (mode) => {
    const f = await upstreamScenario();
    const change = structuredClone(f.input.changes[0]) as SignalEnrichment['changes'][number];
    const input = {
      ...f.input,
      evaluationTime: 0,
      limits: { ...f.advisoryLimits, maxAttempts: 100 },
    } as PolicySignalInput;
    const output: SignalEnrichment = {
      kind: 'enriched',
      binding: input.binding,
      changes: [change],
      sources: structuredClone(input.sources) as SignalEnrichment['sources'],
      findings: [],
      attempts: [],
    };
    const before = structuredClone(change.evidence);
    collectLicenseSignals(input, output, change, {
      base: {
        url: 'https://registry.npmjs.org/fixture/1.0.0',
        license: { kind: 'known', value: 'MIT' },
      },
      head: {
        url: mode === 'failed' ? null : 'https://registry.npmjs.org/fixture/2.0.0',
        license:
          mode === 'failed'
            ? { kind: 'unchecked', reason: 'permission' }
            : { kind: 'known', value: mode === 'changed' ? 'Apache-2.0' : ' (MIT) ' },
      },
    });
    expect(change.evidence).toEqual(before);
    expect(output.findings).toHaveLength(mode === 'changed' ? 1 : 0);
    const ids = new Set(Object.values(change.evidence).flatMap((e) => e.sourceIds));
    expect(output.attempts.every((a) => a.sourceIds.every((id) => !ids.has(id)))).toBe(true);
    if (mode === 'failed')
      expect(
        output.sources.some(
          (s) =>
            s.kind === 'metadata' && s.status === 'unavailable' && s.reasons.includes('permission'),
        ),
      ).toBe(true);
  },
);
