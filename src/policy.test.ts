import { describe, expect, test } from 'vite-plus/test';
import {
  DEFAULT_VERDICTS,
  parseReviewConfig,
  type PolicyOverrides,
  type Verdict,
} from './config.js';
import {
  evaluatePolicy,
  summarizePolicy,
  type AssessmentState,
  type Finding,
  type PolicyUnit,
} from './policy.js';

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

  test.each(['publishtime', 'license', '', null])(
    'treats failed source with unrecognized signal %j as a required gap',
    (signal) => {
      const source = {
        id: 'lookup',
        signal,
        status: 'unavailable',
        reason: 'Lookup failed',
        coverageLimits: ['Missing data'],
      } as PolicyUnit['sources'][number];
      const result = evaluate([unit([], [source])]);
      expect(result.units[0].uncheckedSignals).toEqual([]);
      expect(result.units[0].gaps).toMatchObject([{ sourceId: 'lookup' }]);
      expect(result.units[0].rules.map((trace) => trace.rule)).toEqual(['incompleteEvidence']);
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

  test.each([
    ['vulnerability', 'affected'],
    ['malware', 'affects-proposed'],
    ['malware', undefined],
  ])('rejects %s advisory with unrecognized applicability %j', (kind, applicability) => {
    const advisory = { ...fact, kind, severity: 'high', applicability } as Finding;
    expect(() => evaluate([unit([advisory])])).toThrow('Invalid advisory applicability');
  });

  test.each(['Malware', 'unknownKind', undefined])(
    'rejects unrecognized finding kind %j',
    (kind) => {
      const finding = { ...fact, kind } as unknown as Finding;
      expect(() => evaluate([unit([finding])])).toThrow('Invalid finding kind');
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

describe('unresolved-decision handoff', () => {
  const assessed: AssessmentState = { state: 'assessed' };
  const unavailable: AssessmentState = {
    state: 'unavailable',
    reason: 'Analysis unavailable',
    nextAction: 'Retry the analysis',
    coverageLimits: ['Batch unavailable'],
  };

  test('an assessed relaxed gap preserves incomplete coverage and supplies no execution state', () => {
    const policy = evaluate(
      [exampleUnit(examples[0])],
      configured({ incompleteEvidence: 'merge' }),
    );
    const result = summarizePolicy(policy, { 'unit-a': assessed });
    expect(result.decision).toBe('merge');
    expect(result.unresolvedUnits).toEqual([]);
    expect(result.units).toEqual(policy.units);
    expect(result.units[0].gaps).toHaveLength(1);
    expect(result).not.toHaveProperty('executionStatus');
    expect(result).not.toHaveProperty('success');
  });

  test('a tightened coverage gap supplies a ceiling but no verified finding or assessment', () => {
    const policy = evaluate(
      [exampleUnit(examples[0])],
      configured({ incompleteEvidence: 'do_not_merge' }),
    );
    expect(policy.effectiveCeiling).toBe('do_not_merge');
    expect(summarizePolicy(policy, {}).decision).toBe('decision_incomplete');
    expect(summarizePolicy(policy, { 'unit-a': assessed }).decision).toBe('do_not_merge');
    expect(summarizePolicy(policy, {}).units[0].findings).toEqual([]);
  });

  test('unchecked signals pass through without making an assessed unit unresolved', () => {
    const policy = evaluate([
      unit(
        [],
        [
          {
            id: 'publisher',
            signal: 'publisher',
            status: 'failed',
            reason: 'Lookup unavailable',
            coverageLimits: [],
          },
        ],
      ),
    ]);
    const result = summarizePolicy(policy, { 'unit-a': assessed });
    expect(result.decision).toBe('merge');
    expect(result.unresolvedUnits).toEqual([]);
    expect(result.units[0].uncheckedSignals).toEqual(policy.units[0].uncheckedSignals);
  });

  test.each(['unavailable', 'unattempted', 'rejected'] as const)(
    'all named overrides relaxed cannot assess a %s unit',
    (state) => {
      const overrides = Object.fromEntries(
        Object.keys(DEFAULT_VERDICTS).map((rule) => [rule, 'merge']),
      ) as PolicyOverrides;
      const policy = evaluate([exampleUnit(examples[1])], configured(overrides));
      const assessment: AssessmentState = { ...unavailable, state };
      const result = summarizePolicy(policy, { 'unit-a': assessment });
      expect(result.decision).toBe('decision_incomplete');
      expect(result.unresolvedUnits).toEqual([
        {
          unitId: 'unit-a',
          state,
          reason: unavailable.reason,
          nextAction: unavailable.nextAction,
          coverageLimits: ['Synthetic coverage limit', 'Batch unavailable'],
        },
      ]);
      expect(result.units[0].findings).toEqual(policy.units[0].findings);
    },
  );

  test('omitted assessment retains unit evidence limits and a concrete next action', () => {
    const policy = evaluate([exampleUnit(examples[0])]);
    const result = summarizePolicy(policy, {});
    expect(result.decision).toBe('decision_incomplete');
    expect(result.unresolvedUnits).toMatchObject([
      {
        unitId: 'unit-a',
        state: 'missing',
        coverageLimits: ['Synthetic coverage limit', 'Advisories unchecked'],
      },
    ]);
    expect(result.unresolvedUnits[0].reason).not.toBe('');
    expect(result.unresolvedUnits[0].nextAction).not.toBe('');
    expect(result.units[0].gaps).toEqual(policy.units[0].gaps);
  });

  test.each(['vulnerability', 'malware'] as const)(
    'effective %s hold retains every unresolved unit when all analysis is unavailable',
    (kind) => {
      const finding: Finding =
        kind === 'vulnerability'
          ? examples[1].finding!
          : { ...fact, kind: 'malware', applicability: 'affects_proposed' };
      const blocked = unit([finding]);
      const second = {
        ...exampleUnit(examples[0]),
        id: 'unit-uv',
        members: [{ ...member, ecosystem: 'uv' as const }],
      };
      const third = {
        ...unit([{ ...fact, kind: 'informational', detail: 'Retained evidence' }]),
        id: 'unit-actions',
        members: [{ ...member, ecosystem: 'actions' as const }],
      };
      const policy = evaluate([blocked, second, third]);
      const result = summarizePolicy(policy, {
        'unit-a': unavailable,
        'unit-uv': unavailable,
        'unit-actions': unavailable,
      });
      expect(result.decision).toBe('do_not_merge');
      expect(result.unresolvedUnits.map((value) => value.unitId)).toEqual([
        'unit-a',
        'unit-uv',
        'unit-actions',
      ]);
      expect(result.units).toEqual(policy.units);
      expect(result.units.flatMap((value) => value.findings)).toEqual([finding, third.findings[0]]);
      expect(result.unresolvedUnits[1].coverageLimits).toContain('Advisories unchecked');
      expect(result).not.toHaveProperty('analysis_unavailable');
    },
  );

  test('relaxing the only blocker retains the finding and exposes another unresolved unit', () => {
    const other = { ...unit(), id: 'other-unit' };
    const policy = evaluate(
      [exampleUnit(examples[1]), other],
      configured({ highOrCriticalVulnerability: 'merge' }),
    );
    const result = summarizePolicy(policy, { 'unit-a': assessed, 'other-unit': unavailable });
    expect(result.decision).toBe('decision_incomplete');
    expect(result.units[0].findings).toEqual(policy.units[0].findings);
    expect(result.unresolvedUnits.map((value) => value.unitId)).toEqual(['other-unit']);
  });

  test('complete validated assessments combine with unit ceilings and stricter advice', () => {
    const policy = evaluate([unit(), { ...exampleUnit(examples[4]), id: 'followups' }]);
    expect(summarizePolicy(policy, { 'unit-a': assessed, followups: assessed }).decision).toBe(
      'merge_with_followups',
    );
    expect(
      summarizePolicy(policy, {
        'unit-a': { state: 'assessed', verdict: 'do_not_merge' },
        followups: assessed,
      }).decision,
    ).toBe('do_not_merge');
    expect(
      summarizePolicy(evaluate([unit()]), {
        'unit-a': { state: 'assessed', verdict: 'merge_with_followups' },
      }).decision,
    ).toBe('merge_with_followups');
    expect(
      summarizePolicy(policy, {
        'unit-a': assessed,
        followups: { state: 'assessed', verdict: 'merge' },
      }).decision,
    ).toBe('merge_with_followups');
  });

  test('a model hold cannot replace an unresolved decision when no policy hold exists', () => {
    const policy = evaluate([unit(), { ...unit(), id: 'other' }]);
    expect(
      summarizePolicy(policy, {
        'unit-a': { state: 'assessed', verdict: 'do_not_merge' },
        other: unavailable,
      }).decision,
    ).toBe('decision_incomplete');
  });

  test('an unavailable unit is not made assessed by another ecosystem or inherited record key', () => {
    const policy = evaluate([
      { ...unit(), id: 'constructor' },
      { ...unit(), id: 'unit-uv', members: [{ ...member, ecosystem: 'uv' as const }] },
    ]);
    const result = summarizePolicy(policy, { 'unit-uv': assessed });
    expect(result.decision).toBe('decision_incomplete');
    expect(result.unresolvedUnits.map((value) => value.unitId)).toEqual(['constructor']);
  });

  test('snapshots frozen inputs and assessments without cross-call output leakage', () => {
    const policy = freeze(evaluate([exampleUnit(examples[1]), { ...unit(), id: 'other' }]));
    const assessments = freeze({
      'unit-a': unavailable,
      other: { state: 'assessed' as const, verdict: 'merge' as const },
    });
    const before = JSON.stringify({ policy, assessments });
    const first = summarizePolicy(policy, assessments);
    const second = summarizePolicy(policy, assessments);
    expect(first).toEqual(second);
    Object.assign(first.units[0].findings[0].remediation, { 0: 'Changed output' });
    Object.assign(first.unresolvedUnits[0].coverageLimits, { 0: 'Changed output' });
    expect(summarizePolicy(policy, assessments)).toEqual(second);
    expect(JSON.stringify({ policy, assessments })).toBe(before);
    expect(first.assessments).toEqual([
      { unitId: 'unit-a', ...unavailable },
      { unitId: 'other', state: 'assessed', verdict: 'merge' },
    ]);
  });
});

function configured(overrides: PolicyOverrides = {}, minimumReleaseAgeDays?: number) {
  return JSON.stringify({
    version: 1,
    policy: {
      verdicts: overrides,
      ...(minimumReleaseAgeDays === undefined ? {} : { minimumReleaseAgeDays }),
    },
  });
}

describe('local overrides and provenance', () => {
  const combinations = examples.flatMap((example) =>
    (['merge', 'merge_with_followups', 'do_not_merge'] as const).map((verdict) => ({
      ...example,
      verdict,
    })),
  );
  test.each(combinations)('$rule → $verdict replaces only that rule', (example) => {
    const input = exampleUnit(example);
    const result = evaluate([input], configured({ [example.rule]: example.verdict }));
    expect(result.defaultCeiling).toBe(DEFAULT_VERDICTS[example.rule]);
    expect(result.effectiveCeiling).toBe(example.verdict);
    expect(result.units[0].defaultCeiling).toBe(DEFAULT_VERDICTS[example.rule]);
    expect(result.units[0].effectiveCeiling).toBe(example.verdict);
    expect(result.policy.verdicts).toEqual({
      ...DEFAULT_VERDICTS,
      [example.rule]: example.verdict,
    });
    expect(result.policy.overrides).toEqual({ [example.rule]: example.verdict });
    expect(result.units[0].rules[0]).toMatchObject({
      unitId: input.id,
      rule: example.rule,
      defaultVerdict: DEFAULT_VERDICTS[example.rule],
      effectiveVerdict: example.verdict,
      explicitlyConfigured: true,
      fixed: false,
      configField: `.github/dependabot-review.json#policy.verdicts.${example.rule}`,
    });
    expect(result.units[0]).toMatchObject(input);
  });

  test('independent incompatibility still holds a relaxed high advisory', () => {
    const vulnerability = examples[1].finding!;
    const incompatible = examples[3].finding!;
    const result = evaluate(
      [unit([vulnerability, { ...incompatible, id: 'migration' }])],
      configured({ highOrCriticalVulnerability: 'merge' }),
    );
    expect(result.defaultCeiling).toBe('do_not_merge');
    expect(result.effectiveCeiling).toBe('do_not_merge');
    expect(result.units[0].rules.map((trace) => trace.effectiveVerdict)).toEqual([
      'merge',
      'do_not_merge',
    ]);
    expect(result.units[0].findings[0]).toEqual(vulnerability);
  });

  test('tightened evidence wins over a relaxed vulnerability without changing coverage', () => {
    const input = { ...exampleUnit(examples[0]), findings: [examples[1].finding!] };
    const result = evaluate(
      [input],
      configured({ incompleteEvidence: 'do_not_merge', highOrCriticalVulnerability: 'merge' }),
    );
    expect(result.effectiveCeiling).toBe('do_not_merge');
    expect(result.units[0].gaps).toHaveLength(1);
    expect(result.units[0].sources).toEqual(input.sources);
    expect(result.units[0].findings).toEqual(input.findings);
  });

  test('equal-to-default and non-applicable overrides remain explicit without invented applications', () => {
    const result = evaluate(
      [exampleUnit(examples[1])],
      configured({ highOrCriticalVulnerability: 'do_not_merge', licenseChange: 'merge' }, 1),
    );
    expect(result.policy.overrides).toEqual({
      highOrCriticalVulnerability: 'do_not_merge',
      licenseChange: 'merge',
    });
    expect(result.units[0].rules).toHaveLength(1);
    expect(result.units[0].rules[0].explicitlyConfigured).toBe(true);
    expect(result.policy.minimumReleaseAgeDaysExplicit).toBe(true);
    expect(result.policy.minimumReleaseAgeDaysField).toBe(
      '.github/dependabot-review.json#policy.minimumReleaseAgeDays',
    );
    expect(evaluate([unit()]).policy.minimumReleaseAgeDaysExplicit).toBe(false);
    expect(evaluate([unit()]).policy.minimumReleaseAgeDaysField).toBeUndefined();
  });

  test.each([
    { age: 7 * day - 1, matches: true },
    { age: 7 * day, matches: false },
    { age: 7 * day + 1, matches: false },
  ])('configured seven-day window has exclusive boundary $age', ({ age, matches }) => {
    const result = evaluate(
      [unit([{ ...fact, kind: 'releaseMetadata', publishedAt: now - age }])],
      configured({}, 7),
    );
    expect(result.policy.minimumReleaseAgeDays).toBe(7);
    expect(result.units[0].rules).toHaveLength(matches ? 1 : 0);
    if (matches) expect(result.units[0].rules[0].recheckAt).toBe(now - age + 7 * day);
  });

  test('configured window and verdict keep the security-fix exemption and independent deprecation', () => {
    const findings: Finding[] = [
      {
        ...fact,
        kind: 'releaseMetadata',
        publishedAt: now,
        deprecated: { marker: 'yanked', reason: 'Registry removal' },
      },
      {
        ...fact,
        id: 'fix',
        kind: 'vulnerability',
        severity: 'high',
        applicability: 'resolved_by_proposed',
      },
    ];
    const result = evaluate([unit(findings)], configured({ recentRelease: 'do_not_merge' }, 30));
    expect(result.effectiveCeiling).toBe('merge_with_followups');
    expect(result.units[0].rules.map((trace) => trace.rule)).toEqual(['deprecatedRelease']);
    expect(result.units[0].releaseExemptions[0].advisoryIds).toEqual(['fix']);
  });

  test('fixed malware hold survives all named rules relaxed and has no config source', () => {
    const allMerge = Object.fromEntries(
      Object.keys(DEFAULT_VERDICTS).map((rule) => [rule, 'merge']),
    ) as PolicyOverrides;
    const input = unit([
      { ...fact, kind: 'malware', applicability: 'affects_proposed' },
      examples[1].finding!,
    ]);
    const result = evaluate([input], configured(allMerge));
    expect(result.effectiveCeiling).toBe('do_not_merge');
    expect(result.units[0].rules[0]).toMatchObject({
      rule: 'maliciousPackage',
      defaultVerdict: 'do_not_merge',
      effectiveVerdict: 'do_not_merge',
      fixed: true,
      explicitlyConfigured: false,
    });
    expect(result.units[0].rules[0].configField).toBeUndefined();
    expect(result.units[0].rules[1].effectiveVerdict).toBe('merge');
    expect(result.units[0].findings).toEqual(input.findings);
  });

  test('finding, source, and mixed-ecosystem unit permutations preserve all ceilings', () => {
    const first = {
      ...exampleUnit(examples[0]),
      findings: [examples[1].finding!, examples[3].finding!],
      sources: [
        ...exampleUnit(examples[0]).sources,
        {
          id: 'inventory',
          status: 'partial',
          reason: 'Partial inventory',
          coverageLimits: ['Inventory gap'],
        },
      ],
    };
    const second = {
      ...exampleUnit(examples[7]),
      id: 'unit-uv',
      members: [{ ...member, ecosystem: 'uv' as const }],
    };
    const third = {
      ...exampleUnit(examples[4]),
      id: 'unit-actions',
      members: [{ ...member, ecosystem: 'actions' as const }],
    };
    const text = configured({
      highOrCriticalVulnerability: 'merge',
      incompatibleMigration: 'merge_with_followups',
      licenseChange: 'do_not_merge',
    });
    const reference = evaluate([first, second, third], text);
    for (const inputs of [
      [third, second, first],
      [second, first, third],
    ]) {
      const result = evaluate(
        inputs.map((input) => ({
          ...input,
          findings: [...input.findings].reverse(),
          sources: [...input.sources].reverse(),
        })),
        text,
      );
      expect(result.effectiveCeiling).toBe(reference.effectiveCeiling);
      expect(result.defaultCeiling).toBe(reference.defaultCeiling);
      for (const value of result.units) {
        const expected = reference.units.find((other) => other.id === value.id)!;
        expect(value.defaultCeiling).toBe(expected.defaultCeiling);
        expect(value.effectiveCeiling).toBe(expected.effectiveCeiling);
        expect([...value.gaps].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
          [...expected.gaps].sort((a, b) => a.id.localeCompare(b.id)),
        );
      }
    }
  });

  test('frozen config and evidence are retained and output changes cannot leak across calls', () => {
    const inputs = freeze([exampleUnit(examples[1])]);
    const config = freeze(
      parseReviewConfig(configured({ highOrCriticalVulnerability: 'merge' }, 7)),
    );
    const before = JSON.stringify({ inputs, config });
    const first = evaluatePolicy(config, inputs, now);
    const second = evaluatePolicy(config, inputs, now);
    if (!first.ok || !second.ok) throw new Error('expected policy');
    expect(first).toEqual(second);
    Object.assign(first.policy.verdicts, {
      highOrCriticalVulnerability: 'do_not_merge' as Verdict,
    });
    Object.assign(first.policy.overrides, {
      highOrCriticalVulnerability: 'do_not_merge' as Verdict,
    });
    Object.assign(first.units[0].findings[0].remediation, { 0: 'Modified output' });
    expect(evaluatePolicy(config, inputs, now)).toEqual(second);
    expect(evaluate([unit()]).policy.verdicts).toEqual(DEFAULT_VERDICTS);
    expect(JSON.stringify({ inputs, config })).toBe(before);
  });
});
