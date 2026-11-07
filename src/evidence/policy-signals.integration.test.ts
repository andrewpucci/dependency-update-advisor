import { expect, test } from 'vite-plus/test';
import { policySignalScenario } from '../../tests/parity/policy-signals.js';

test.each([
  'clean',
  'malware',
  'malware-failed',
  'optional-failed',
  'recent',
  'boundary',
  'security-fix',
  'supply',
  'license',
  'deprecated',
] as const)('real npm collector/S2/S1/S3/T4/T5/C3 %s handoff', async (mode) => {
  const r = await policySignalScenario({ mode });
  expect(r.packet.ok, JSON.stringify(r.packet)).toBe(true);
  if (!r.packet.ok || !r.policy.ok) throw new Error('policy handoff');
  const npm = r.result.changes.filter((c) => c.ecosystem === 'npm' && !('basis' in c));
  expect(npm.map((c) => c.id)).toEqual(
    r.fixture.input.changes
      .filter((c) => c.ecosystem === 'npm' && !('basis' in c))
      .map((c) => c.id),
  );
  expect(r.upstream.publicIdentities.filter((p) => p.ecosystem === 'npm').length).toBeGreaterThan(
    0,
  );
  expect(r.requests.some((url) => new URL(url).searchParams.get('type') === 'malware')).toBe(true);
  if (mode === 'malware') expect(r.policy.defaultCeiling).toBe('do_not_merge');
  if (mode === 'malware-failed')
    expect(r.policy.units.some((u) => u.gaps.some((g) => g.sourceId.includes('malware')))).toBe(
      true,
    );
  if (mode === 'optional-failed') {
    expect(r.policy.units.flatMap((u) => u.gaps)).toEqual([]);
    expect(r.policy.units.flatMap((u) => u.uncheckedSignals).length).toBeGreaterThan(0);
  }
  const kinds = r.result.findings.map((f) => f.kind);
  if (mode === 'supply')
    expect(
      r.result.findings.some(
        (f) => f.kind === 'supplyChainChange' && f.change === 'trust_downgrade',
      ),
    ).toBe(true);
  if (mode === 'license')
    expect(
      r.result.findings.some(
        (f) =>
          f.kind === 'licenseChange' &&
          npm.some((c) => c.id === f.memberId && c.role === 'transitive'),
      ),
    ).toBe(true);
  if (mode === 'deprecated') expect(kinds).toContain('releaseMetadata');
  const recent = r.policy.units
    .flatMap((u) => u.rules)
    .filter((rule) => rule.rule === 'recentRelease');
  if (mode === 'recent') expect(recent.length).toBeGreaterThan(0);
  if (mode === 'boundary' || mode === 'clean') expect(recent).toHaveLength(0);
  if (mode === 'security-fix')
    expect(r.policy.units.flatMap((u) => u.releaseExemptions).length).toBeGreaterThan(0);
});
