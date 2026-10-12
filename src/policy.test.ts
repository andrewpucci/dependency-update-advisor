import { describe, expect, test } from 'vite-plus/test';
import { DEFAULT_VERDICTS, parseReviewConfig } from './config.js';
import { evaluatePolicy, type Finding, type PolicyUnit } from './policy.js';

const day = 86_400_000;
const now = Date.parse('2026-10-01T12:00:00Z');
const member = {
  id: 'package-a',
  ecosystem: 'npm' as const,
  name: 'synthetic-a',
  currentVersion: '1.0.0',
  proposedVersion: '2.0.0',
};
const fact = {
  id: 'finding-a',
  memberId: member.id,
  references: ['https://example.invalid/evidence'],
  rationale: 'Verified synthetic change',
  remediation: ['Review the change'],
  validation: ['Run consumer tests'],
};
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function unit(findings: readonly Finding[] = [], sources: PolicyUnit['sources'] = []): PolicyUnit {
  return {
    id: 'unit-a',
    members: [member],
    findings,
    sources,
    coverageLimits: ['Synthetic coverage limit'],
  };
}
function evaluate(units: readonly PolicyUnit[], text = '{"version":1}') {
  const result = evaluatePolicy(parseReviewConfig(text), units, now);
  if (!result.ok) throw new Error('expected policy success');
  return result;
}
const examples: { rule: keyof typeof DEFAULT_VERDICTS; finding?: Finding }[] = [
  { rule: 'incompleteEvidence' },
  {
    rule: 'highOrCriticalVulnerability',
    finding: {
      ...fact,
      kind: 'vulnerability',
      severity: 'high',
      applicability: 'affects_proposed',
      affectedRange: '>=2',
    },
  },
  {
    rule: 'moderateOrLowVulnerability',
    finding: {
      ...fact,
      kind: 'vulnerability',
      severity: 'moderate',
      applicability: 'affects_proposed',
    },
  },
  { rule: 'incompatibleMigration', finding: { ...fact, kind: 'incompatibleMigration' } },
  { rule: 'applicableCodemod', finding: { ...fact, kind: 'applicableCodemod' } },
  {
    rule: 'compatibilityUncertainty',
    finding: { ...fact, kind: 'compatibilityUncertainty', change: 'raised_runtime_floor' },
  },
  {
    rule: 'supplyChainChange',
    finding: { ...fact, kind: 'supplyChainChange', change: 'install_script' },
  },
  {
    rule: 'licenseChange',
    finding: {
      ...fact,
      kind: 'licenseChange',
      currentLicense: 'MIT',
      proposedLicense: 'Apache-2.0',
    },
  },
  {
    rule: 'recentRelease',
    finding: { ...fact, kind: 'releaseMetadata', publishedAt: now - day + 1 },
  },
  {
    rule: 'deprecatedRelease',
    finding: {
      ...fact,
      kind: 'releaseMetadata',
      deprecated: { marker: 'deprecated', reason: 'Use the maintained replacement' },
    },
  },
];
function exampleUnit(example: (typeof examples)[number]) {
  return unit(
    example.finding ? [example.finding] : [],
    example.finding
      ? []
      : [
          {
            id: 'advisories',
            status: 'unavailable',
            reason: 'Lookup failed',
            coverageLimits: ['Advisories unchecked'],
          },
        ],
  );
}

describe('default policy evaluation', () => {
  test('isolates per-unit ceilings and snapshots frozen nested inputs', () => {
    const blocked = exampleUnit(examples[1]);
    const clean = {
      ...unit(),
      id: 'clean-unit',
      members: [{ ...member, ecosystem: 'uv' as const }],
    };
    const inputs = freeze([blocked, clean]);
    const config = freeze(parseReviewConfig('{"version":1}'));
    const first = evaluatePolicy(config, inputs, now);
    const second = evaluatePolicy(config, inputs, now);
    if (!first.ok || !second.ok) throw new Error('expected policy');
    expect(first.units.map((value) => value.effectiveCeiling)).toEqual(['do_not_merge', 'merge']);
    expect(first.effectiveCeiling).toBe('do_not_merge');
    expect(first).toEqual(second);
    expect(first.units[0].findings[0]).not.toBe(inputs[0].findings[0]);
    expect(first.units[0].findings[0].remediation).not.toBe(inputs[0].findings[0].remediation);
    expect(first.policy.verdicts).not.toBe(second.policy.verdicts);
  });
  test.each(examples)('matches $rule and retains normalized facts', (example) => {
    const input = exampleUnit(example);
    const result = evaluate([input]);
    expect(result.defaultCeiling).toBe(DEFAULT_VERDICTS[example.rule]);
    expect(result.effectiveCeiling).toBe(result.defaultCeiling);
    expect(result.units[0]).toMatchObject(input);
    expect(result.units[0].rules).toMatchObject([
      {
        unitId: input.id,
        rule: example.rule,
        defaultVerdict: DEFAULT_VERDICTS[example.rule],
        effectiveVerdict: DEFAULT_VERDICTS[example.rule],
      },
    ]);
    if (example.finding) expect(result.units[0].rules[0].findingId).toBe(example.finding.id);
  });

  test.each([
    'available',
    'group_backed',
    'partial',
    'unavailable',
    'failed',
    'truncated',
    'unsupported',
    'unexpected',
  ])('handles required status %s without inventing a finding', (status) => {
    const result = evaluate([
      unit(
        [],
        [
          {
            id: 'vulnerability',
            status,
            reason: 'Synthetic status',
            coverageLimits: ['Limited inventory'],
          },
        ],
      ),
    ]);
    const complete = status === 'available' || status === 'group_backed';
    expect(result.effectiveCeiling).toBe(complete ? 'merge' : 'merge_with_followups');
    expect(result.units[0].gaps).toHaveLength(complete ? 0 : 1);
    expect(result.units[0].findings).toEqual([]);
  });

  test.each(['vulnerability', 'malware', 'installScripts'])(
    'failed %s coverage is a stable attributable gap',
    (id) => {
      const source = {
        id,
        status: 'unavailable',
        reason: 'Lookup failed',
        coverageLimits: ['Missing data'],
      };
      const first = evaluate([unit([], [source])]);
      const second = evaluate([unit([], [{ ...source, id: 'other' }, source])]);
      expect(first.units[0].gaps[0]).toEqual(second.units[0].gaps[1]);
      expect(first.units[0].gaps[0]).toMatchObject({
        unitId: 'unit-a',
        sourceId: id,
        reason: source.reason,
        coverageLimits: source.coverageLimits,
      });
    },
  );

  test.each(['publishTime', 'deprecation', 'trust', 'publisher'] as const)(
    'retains failed optional %s as unchecked',
    (signal) => {
      const source = {
        id: signal,
        signal,
        status: 'unavailable',
        reason: 'Lookup failed',
        coverageLimits: ['Optional metadata unavailable'],
      };
      const result = evaluate([unit([], [source])]);
      expect(result.effectiveCeiling).toBe('merge');
      expect(result.units[0].gaps).toEqual([]);
      expect(result.units[0].rules).toEqual([]);
      expect(result.units[0].uncheckedSignals).toMatchObject([
        { unitId: 'unit-a', sourceId: signal, signal, reason: source.reason },
      ]);
      expect(result.units[0].sources).toEqual([source]);
    },
  );

  test.each(['critical', 'high', 'moderate', 'low', undefined] as const)(
    'classifies advisory severity %s',
    (severity) => {
      const advisory: Finding = {
        ...fact,
        kind: 'vulnerability',
        severity,
        applicability: 'affects_proposed',
      };
      expect(evaluate([unit([advisory])]).effectiveCeiling).toBe(
        severity === 'critical' || severity === 'high' ? 'do_not_merge' : 'merge_with_followups',
      );
    },
  );

  test.each(['medium', 'unknown', 'HIGH', '', null])(
    'rejects unnormalized severity %j before relaxed advice',
    (severity) => {
      const advisory = {
        ...fact,
        kind: 'vulnerability',
        severity,
        applicability: 'affects_proposed',
      } as Finding;
      expect(() =>
        evaluate(
          [unit([advisory])],
          '{"version":1,"policy":{"verdicts":{"moderateOrLowVulnerability":"merge"}}}',
        ),
      ).toThrow('Invalid advisory severity');
    },
  );

  test.each(['resolved_by_proposed', 'unaffected', 'withdrawn'] as const)(
    'retains %s advisories without a vulnerability verdict',
    (applicability) => {
      const findings: Finding[] = [
        { ...fact, kind: 'vulnerability', severity: 'critical', applicability },
      ];
      const result = evaluate([unit(findings)]);
      expect(result.effectiveCeiling).toBe('merge');
      expect(result.units[0].findings).toEqual(findings);
    },
  );

  test.each(['raised_runtime_floor', 'tightened_peer_range', 'deprecated_workflow_input'] as const)(
    'keeps compatibility uncertainty %s distinct from incompatibility',
    (change) => {
      const uncertainty: Finding = { ...fact, kind: 'compatibilityUncertainty', change };
      expect(evaluate([unit([uncertainty])]).effectiveCeiling).toBe('merge_with_followups');
      const result = evaluate([
        unit([uncertainty, { ...fact, id: 'incompatible', kind: 'incompatibleMigration' }]),
      ]);
      expect(result.effectiveCeiling).toBe('do_not_merge');
      expect(result.units[0].findings).toHaveLength(2);
      expect(result.units[0].rules).toHaveLength(2);
    },
  );

  test.each([
    'install_script',
    'package_source',
    'publisher',
    'trust_downgrade',
    'action_identity',
    'mutable_action_ref',
  ] as const)('matches verified supply-chain change %s', (change) => {
    const finding: Finding = { ...fact, kind: 'supplyChainChange', change };
    expect(evaluate([unit([finding])]).units[0].rules[0].rule).toBe('supplyChainChange');
  });

  test('informational license and unchanged normalized license facts do not create rules', () => {
    const findings: Finding[] = [
      {
        ...fact,
        kind: 'informational',
        detail: 'Both versions have no trusted publishing or attestation',
      },
      { ...fact, id: 'license', kind: 'informational', detail: 'Unknown license' },
      {
        ...fact,
        id: 'same-license',
        kind: 'licenseChange',
        currentLicense: 'MIT OR Apache-2.0',
        proposedLicense: 'MIT OR Apache-2.0',
      },
    ];
    const result = evaluate([unit(findings)]);
    expect(result.effectiveCeiling).toBe('merge');
    expect(result.units[0].findings).toEqual(findings);
    expect(result.units[0].gaps).toEqual([]);
    expect(result.units[0].rules).toEqual([]);
  });

  test.each([
    { age: day - 1, matches: true },
    { age: day, matches: false },
    { age: day + 1, matches: false },
  ])('release age $age uses caller time and exclusive window', ({ age, matches }) => {
    const result = evaluate([unit([{ ...fact, kind: 'releaseMetadata', publishedAt: now - age }])]);
    expect(result.units[0].rules).toHaveLength(matches ? 1 : 0);
    if (matches) expect(result.units[0].rules[0].recheckAt).toBe(now - age + day);
  });

  test('security-fix exemption is member-specific and does not remove other rules', () => {
    const findings: Finding[] = [
      { ...fact, kind: 'releaseMetadata', publishedAt: now },
      {
        ...fact,
        id: 'resolved',
        kind: 'vulnerability',
        applicability: 'resolved_by_proposed',
        severity: 'high',
      },
      {
        ...fact,
        id: 'other-release',
        memberId: 'transitive',
        kind: 'releaseMetadata',
        publishedAt: now,
      },
      { ...fact, id: 'migration', kind: 'incompatibleMigration' },
    ];
    const result = evaluate([
      {
        ...unit(findings),
        members: [member, { ...member, id: 'transitive', name: 'synthetic-transitive' }],
      },
    ]);
    expect(result.units[0].releaseExemptions).toEqual([
      { unitId: 'unit-a', findingId: fact.id, memberId: member.id, advisoryIds: ['resolved'] },
    ]);
    expect(result.units[0].rules.map((trace) => trace.rule)).toEqual([
      'recentRelease',
      'incompatibleMigration',
    ]);
    expect(result.units[0].findings).toEqual(findings);
  });

  test('security fix outside the release window records no exemption', () => {
    const result = evaluate([
      unit([
        { ...fact, kind: 'releaseMetadata', publishedAt: now - day },
        {
          ...fact,
          id: 'resolved',
          kind: 'vulnerability',
          applicability: 'resolved_by_proposed',
          severity: 'high',
        },
      ]),
    ]);
    expect(result.units[0].releaseExemptions).toEqual([]);
    expect(result.units[0].rules).toEqual([]);
  });

  test.each(['deprecated', 'yanked'] as const)('retains registry %s reason', (marker) => {
    const finding: Finding = {
      ...fact,
      kind: 'releaseMetadata',
      deprecated: { marker, reason: 'Synthetic registry reason' },
    };
    const result = evaluate([unit([finding])]);
    expect(result.units[0].findings).toEqual([finding]);
    expect(result.units[0].rules[0].rule).toBe('deprecatedRelease');
  });

  test('malware is a fixed hold and withdrawn malware is retained without a hold', () => {
    const finding: Finding = { ...fact, kind: 'malware', applicability: 'affects_proposed' };
    const result = evaluate([unit([finding])]);
    expect(result.effectiveCeiling).toBe('do_not_merge');
    expect(result.units[0].rules[0]).toMatchObject({
      rule: 'maliciousPackage',
      fixed: true,
      effectiveVerdict: 'do_not_merge',
      explicitlyConfigured: false,
    });
    expect(evaluate([unit([{ ...finding, applicability: 'withdrawn' }])]).effectiveCeiling).toBe(
      'merge',
    );
  });

  test('defaults retain origin and no provider or source-excerpt metadata', () => {
    const units = [unit()];
    for (const text of ['{"version":1}', '{"version":1,"policy":{"verdicts":{}}}']) {
      const result = evaluate(units, text);
      expect(result.effectiveCeiling).toBe('merge');
      expect(result.policy.verdicts).toEqual(DEFAULT_VERDICTS);
      expect(result.policy.origin).toBe('file');
      expect(result.policy).not.toHaveProperty('analysis');
      expect(result.policy).not.toHaveProperty('context');
    }
    const config = parseReviewConfig('{"version":1}');
    if (!config.ok) throw new Error('expected config');
    const missing = evaluatePolicy({ ...config, origin: 'missing' }, units, now);
    expect(missing.ok && missing.policy.origin).toBe('missing');
    expect(evaluate([]).effectiveCeiling).toBe('merge');
  });

  test('failed config preserves safe diagnostic and supplies no policy', () => {
    const config = parseReviewConfig('{"version":2}');
    const result = evaluatePolicy(config, [unit()], now);
    expect(result).toEqual(config);
    expect(result).not.toHaveProperty('policy');
  });
});
