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

test.each([
  'pypi-provenance',
  'trust-downgrade',
  'artifact-mismatch',
  'artifact-mixed',
  'yanked',
] as const)('real uv artifact %s handoff stays bound to the complete locked set', async (mode) => {
  const r = await policySignalScenario({ mode });
  if (!r.policy.ok) throw new Error('policy');
  const uv = r.result.changes.find((c) => c.ecosystem === 'uv')!;
  expect(r.requests.some((url) => new URL(url).pathname.startsWith('/integrity/'))).toBe(
    mode !== 'artifact-mismatch',
  );
  const findings = r.result.findings.filter((f) => f.memberId === uv.id);
  if (mode === 'trust-downgrade')
    expect(
      findings.some((f) => f.kind === 'supplyChainChange' && f.change === 'trust_downgrade'),
    ).toBe(true);
  if (mode === 'pypi-provenance')
    expect(findings.some((f) => f.kind === 'supplyChainChange' && f.change === 'publisher')).toBe(
      true,
    );
  if (mode === 'artifact-mismatch' || mode === 'artifact-mixed') {
    expect(uv.evidence.trust.status).not.toBe('available');
    expect(
      findings.some((f) => f.kind === 'supplyChainChange' && f.change === 'trust_downgrade'),
    ).toBe(false);
  }
  if (mode === 'yanked')
    expect(
      findings.some((f) => f.kind === 'releaseMetadata' && f.deprecated?.marker === 'yanked'),
    ).toBe(true);
  expect(
    r.result.changes
      .filter((c) => c.ecosystem === 'npm')
      .every((c) => c.evidence.malware.status === 'available'),
  ).toBe(true);
});
test.each(['owner', 'mutable'] as const)(
  'actual X1 %s workflow edit yields attributed supply-chain evidence',
  async (actionChange) => {
    const r = await policySignalScenario({
      inventory: { actionChange, extras: true, declaration: true },
    });
    if (actionChange === 'mutable')
      expect(
        r.result.findings.some(
          (f) => f.kind === 'supplyChainChange' && f.change === 'mutable_action_ref',
        ),
      ).toBe(true);
    else {
      const actions = r.result.changes.filter((c) => c.ecosystem === 'actions');
      expect(actions.some((c) => c.kind === 'addition')).toBe(true);
      expect(actions.some((c) => c.kind === 'removal')).toBe(true);
      expect(
        r.result.findings.some(
          (f) => f.kind === 'supplyChainChange' && f.change === 'action_identity',
        ),
      ).toBe(false);
    }
    expect(
      r.result.changes
        .filter((c) => 'basis' in c)
        .every((c) => Object.keys(c.evidence).length === 0),
    ).toBe(true);
    expect(
      r.result.findings
        .filter((f) => f.kind === 'malware')
        .every((f) => r.result.changes.find((c) => c.id === f.memberId)?.to),
    ).toBe(true);
  },
);
test('mixed unsupported Actions and uv variants preserve separate per-member evidence', async () => {
  const r = await policySignalScenario({
    inventory: { actionsSubpath: true, uvVariants: true, uvArtifacts: true },
  });
  expect(r.result.changes.find((c) => c.ecosystem === 'actions')?.evidence.malware.status).toBe(
    'unavailable',
  );
  expect(r.result.changes.filter((c) => c.ecosystem === 'uv')).toHaveLength(2);
  expect(
    r.result.changes
      .filter((c) => c.ecosystem === 'npm')
      .every((c) => c.evidence.malware.status === 'available'),
  ).toBe(true);
});
test.each([124, 125])(
  'rich mixed %s-child research fails closed at independent source/output caps',
  async (children) => {
    await expect(
      policySignalScenario({ inventory: { children, lifecycle: false } }),
    ).rejects.toThrow('{"kind":"unavailable","reason":"budget"}');
  },
);
test('uv members sharing one lockfile read it once per side', async () => {
  const r = await policySignalScenario({ inventory: { uvVariants: true, uvArtifacts: true } });
  const uv = r.result.changes.filter((c) => c.ecosystem === 'uv' && !('basis' in c));
  expect(uv.length).toBeGreaterThan(1);
  expect(r.lockReads).toEqual([
    { side: 'base', path: 'uv.lock' },
    { side: 'head', path: 'uv.lock' },
  ]);
});
