import {
  DEFAULT_VERDICTS,
  type ConfigResult,
  type PolicyOverrides,
  type PolicyRule,
  type Verdict,
} from './config.js';

export type Member = Readonly<{
  id: string;
  ecosystem: 'npm' | 'actions' | 'uv';
  name: string;
  currentVersion?: string;
  proposedVersion?: string;
}>;
type FindingFacts = Readonly<{
  id: string;
  memberId: string;
  references: readonly string[];
  rationale: string;
  remediation: readonly string[];
  validation: readonly string[];
}>;
const applicabilities: readonly string[] = [
  'affects_proposed',
  'resolved_by_proposed',
  'unaffected',
  'withdrawn',
];
type Applicability = 'affects_proposed' | 'resolved_by_proposed' | 'unaffected' | 'withdrawn';
export type Finding = FindingFacts &
  (
    | Readonly<{
        kind: 'vulnerability';
        severity?: 'critical' | 'high' | 'moderate' | 'low';
        applicability: Applicability;
        affectedRange?: string;
      }>
    | Readonly<{ kind: 'malware'; applicability: Applicability; affectedRange?: string }>
    | Readonly<{ kind: 'incompatibleMigration' | 'applicableCodemod' }>
    | Readonly<{
        kind: 'compatibilityUncertainty';
        change: 'raised_runtime_floor' | 'tightened_peer_range' | 'deprecated_workflow_input';
      }>
    | Readonly<{
        kind: 'supplyChainChange';
        change:
          | 'install_script'
          | 'package_source'
          | 'publisher'
          | 'trust_downgrade'
          | 'action_identity'
          | 'mutable_action_ref';
      }>
    | Readonly<{ kind: 'licenseChange'; currentLicense: string; proposedLicense: string }>
    | Readonly<{
        kind: 'releaseMetadata';
        publishedAt?: number;
        deprecated?: Readonly<{ marker: 'deprecated' | 'yanked'; reason?: string }>;
      }>
    | Readonly<{ kind: 'informational'; detail: string }>
  );
type OptionalSignal = 'publishTime' | 'deprecation' | 'trust' | 'publisher';
const optionalSignals: readonly string[] = ['publishTime', 'deprecation', 'trust', 'publisher'];
export type EvidenceSource = Readonly<{
  id: string;
  status: string;
  reason: string;
  coverageLimits: readonly string[];
  /** Only these optional lookups are unchecked signals; all other sources are required. */
  signal?: OptionalSignal;
}>;
export type PolicyUnit = Readonly<{
  id: string;
  members: readonly Member[];
  findings: readonly Finding[];
  sources: readonly EvidenceSource[];
  coverageLimits: readonly string[];
}>;
export type EvidenceGap = Readonly<{
  id: string;
  unitId: string;
  sourceId: string;
  status: string;
  reason: string;
  coverageLimits: readonly string[];
}>;
export type UncheckedSignal = EvidenceGap & Readonly<{ signal: OptionalSignal }>;
export type RuleTrace = Readonly<{
  unitId: string;
  findingId?: string;
  sourceId?: string;
  rule: PolicyRule | 'maliciousPackage';
  defaultVerdict: Verdict;
  effectiveVerdict: Verdict;
  explicitlyConfigured: boolean;
  fixed: boolean;
  configField?: string;
  /** UTC epoch milliseconds at which the release-age window ends. */
  recheckAt?: number;
}>;
export type EvaluatedUnit = PolicyUnit &
  Readonly<{
    rules: readonly RuleTrace[];
    gaps: readonly EvidenceGap[];
    uncheckedSignals: readonly UncheckedSignal[];
    releaseExemptions: readonly Readonly<{
      unitId: string;
      memberId: string;
      findingId: string;
      advisoryIds: readonly string[];
    }>[];
    defaultCeiling: Verdict;
    effectiveCeiling: Verdict;
  }>;
export type PolicyEvaluation = Readonly<{
  ok: true;
  policy: Readonly<{
    verdicts: Readonly<Record<PolicyRule, Verdict>>;
    overrides: Readonly<PolicyOverrides>;
    minimumReleaseAgeDays: number;
    minimumReleaseAgeDaysExplicit: boolean;
    minimumReleaseAgeDaysField?: string;
    origin: 'file' | 'missing';
  }>;
  units: readonly EvaluatedUnit[];
  defaultCeiling: Verdict;
  effectiveCeiling: Verdict;
}>;
type ConfigFailure = Readonly<{
  ok: false;
  error: Readonly<Extract<ConfigResult, { ok: false }>['error']>;
}>;
type PolicyConfig =
  | ConfigFailure
  | Readonly<{
      ok: true;
      config: Readonly<{
        policy: Readonly<{
          verdicts: Readonly<Record<PolicyRule, Verdict>>;
          minimumReleaseAgeDays: number;
        }>;
      }>;
      overrides: Readonly<PolicyOverrides>;
      minimumReleaseAgeDaysExplicit: boolean;
      origin: 'file' | 'missing';
    }>;
export type PolicyResult = PolicyEvaluation | ConfigFailure;

const precedence: Readonly<Record<Verdict, number>> = {
  merge: 0,
  merge_with_followups: 1,
  do_not_merge: 2,
};
function strictest(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce(
    (ceiling, verdict) => (precedence[verdict] > precedence[ceiling] ? verdict : ceiling),
    'merge',
  );
}

/** Inputs are caller-validated normalized facts. Times use UTC epoch milliseconds.
 * Invalid finding kind, advisory severity, or applicability throws; an unrecognized signal is a required gap.
 * Config failure returns its safe diagnostic without policy.
 * Snapshots inputs without reading files, the clock, or execution state.
 */
export function evaluatePolicy(
  config: PolicyConfig,
  units: readonly PolicyUnit[],
  evaluatedAt: number,
): PolicyResult {
  if (!config.ok) return { ok: false, error: { ...config.error } };
  const policy: PolicyEvaluation['policy'] = {
    verdicts: { ...config.config.policy.verdicts },
    overrides: { ...config.overrides },
    minimumReleaseAgeDays: config.config.policy.minimumReleaseAgeDays,
    minimumReleaseAgeDaysExplicit: config.minimumReleaseAgeDaysExplicit,
    ...(config.minimumReleaseAgeDaysExplicit
      ? {
          minimumReleaseAgeDaysField: '.github/dependabot-review.json#policy.minimumReleaseAgeDays',
        }
      : {}),
    origin: config.origin,
  };
  const evaluatedUnits = units.map((input) => {
    const unit = structuredClone(input);
    const rules: RuleTrace[] = [];
    const gaps: EvidenceGap[] = [];
    const uncheckedSignals: UncheckedSignal[] = [];
    const releaseExemptions: EvaluatedUnit['releaseExemptions'][number][] = [];
    function apply(
      rule: RuleTrace['rule'],
      identity: Pick<RuleTrace, 'findingId' | 'sourceId' | 'recheckAt'>,
    ) {
      const fixed = rule === 'maliciousPackage';
      const defaultVerdict = fixed ? 'do_not_merge' : DEFAULT_VERDICTS[rule];
      rules.push({
        unitId: unit.id,
        ...identity,
        rule,
        defaultVerdict,
        effectiveVerdict: fixed ? 'do_not_merge' : policy.verdicts[rule],
        explicitlyConfigured: !fixed && Object.hasOwn(policy.overrides, rule),
        ...(!fixed && Object.hasOwn(policy.overrides, rule)
          ? { configField: `.github/dependabot-review.json#policy.verdicts.${rule}` }
          : {}),
        fixed,
      });
    }
    for (const source of unit.sources) {
      if (source.status === 'available' || source.status === 'group_backed') continue;
      const gap: EvidenceGap = {
        id: JSON.stringify([unit.id, source.id]),
        unitId: unit.id,
        sourceId: source.id,
        status: source.status,
        reason: source.reason,
        coverageLimits: source.coverageLimits,
      };
      if (source.signal !== undefined && optionalSignals.includes(source.signal))
        uncheckedSignals.push({ ...gap, signal: source.signal });
      else {
        gaps.push(gap);
        apply('incompleteEvidence', { sourceId: source.id });
      }
    }
    for (const finding of unit.findings) {
      const identity = { findingId: finding.id };
      if (
        (finding.kind === 'vulnerability' || finding.kind === 'malware') &&
        !applicabilities.includes(finding.applicability)
      )
        throw new TypeError('Invalid advisory applicability');
      switch (finding.kind) {
        case 'vulnerability':
          if (
            finding.severity !== undefined &&
            !['critical', 'high', 'moderate', 'low'].includes(finding.severity)
          )
            throw new TypeError('Invalid advisory severity');
          if (finding.applicability === 'affects_proposed')
            apply(
              finding.severity === 'critical' || finding.severity === 'high'
                ? 'highOrCriticalVulnerability'
                : 'moderateOrLowVulnerability',
              identity,
            );
          break;
        case 'malware':
          if (finding.applicability === 'affects_proposed') apply('maliciousPackage', identity);
          break;
        case 'incompatibleMigration':
        case 'applicableCodemod':
        case 'compatibilityUncertainty':
        case 'supplyChainChange':
          apply(finding.kind, identity);
          break;
        case 'licenseChange':
          // Collectors supply normalized license expressions, not registry formatting.
          if (finding.currentLicense !== finding.proposedLicense) apply('licenseChange', identity);
          break;
        case 'releaseMetadata': {
          const fixes = unit.findings.filter(
            (advisory) =>
              advisory.kind === 'vulnerability' &&
              advisory.memberId === finding.memberId &&
              advisory.applicability === 'resolved_by_proposed',
          );
          const recheckAt =
            finding.publishedAt === undefined
              ? undefined
              : finding.publishedAt + policy.minimumReleaseAgeDays * 86_400_000;
          // Only a release inside the window can be exempted from recentRelease.
          if (recheckAt !== undefined && evaluatedAt < recheckAt) {
            if (fixes.length)
              releaseExemptions.push({
                unitId: unit.id,
                memberId: finding.memberId,
                findingId: finding.id,
                advisoryIds: fixes.map((advisory) => advisory.id),
              });
            else apply('recentRelease', { ...identity, recheckAt });
          }
          if (finding.deprecated) apply('deprecatedRelease', identity);
          break;
        }
        case 'informational':
          break;
        default:
          throw new TypeError('Invalid finding kind');
      }
    }
    return {
      ...unit,
      rules,
      gaps,
      uncheckedSignals,
      releaseExemptions,
      defaultCeiling: strictest(rules.map((trace) => trace.defaultVerdict)),
      effectiveCeiling: strictest(rules.map((trace) => trace.effectiveVerdict)),
    };
  });
  return {
    ok: true,
    policy,
    units: evaluatedUnits,
    defaultCeiling: strictest(evaluatedUnits.map((unit) => unit.defaultCeiling)),
    effectiveCeiling: strictest(evaluatedUnits.map((unit) => unit.effectiveCeiling)),
  };
}

export type AssessmentState =
  | Readonly<{ state: 'assessed'; verdict?: Verdict }>
  | Readonly<{
      state: 'unavailable' | 'unattempted' | 'rejected';
      reason: string;
      nextAction: string;
      coverageLimits: readonly string[];
    }>;
type MissingAssessment = Readonly<{
  state: 'missing';
  reason: string;
  nextAction: string;
  coverageLimits: readonly string[];
}>;
export type UnresolvedUnit = Readonly<{ unitId: string }> &
  (Exclude<AssessmentState, { state: 'assessed' }> | MissingAssessment);
export type PolicySummary = PolicyEvaluation &
  Readonly<{
    decision: Verdict | 'decision_incomplete';
    assessments: readonly (Readonly<{ unitId: string }> & (AssessmentState | MissingAssessment))[];
    unresolvedUnits: readonly UnresolvedUnit[];
  }>;

/** Uses only successful policy and caller-validated assessments keyed by unit ID.
 * Missing assessments remain unresolved. Only verified finding holds outrank that queue;
 * complete assessments are combined with their ceilings, never execution status.
 * Returns fresh snapshots; ID/reference/model validation remains the provider's boundary.
 */
export function summarizePolicy(
  policy: PolicyEvaluation,
  states: Readonly<Partial<Record<string, AssessmentState>>>,
): PolicySummary {
  const snapshot = structuredClone(policy);
  const assessments: PolicySummary['assessments'][number][] = [];
  const unresolvedUnits: UnresolvedUnit[] = [];
  const verdicts: Verdict[] = [];
  for (const unit of snapshot.units) {
    const state = Object.hasOwn(states, unit.id) ? states[unit.id] : undefined;
    const assessment: AssessmentState | MissingAssessment = state
      ? structuredClone(state)
      : {
          state: 'missing',
          reason: 'No validated assessment was supplied.',
          nextAction: 'Run analysis for this decision unit.',
          coverageLimits: [],
        };
    assessments.push({ unitId: unit.id, ...assessment });
    if (assessment.state === 'assessed') {
      verdicts.push(
        strictest([unit.effectiveCeiling, assessment.verdict ?? unit.effectiveCeiling]),
      );
    } else {
      unresolvedUnits.push({
        unitId: unit.id,
        ...assessment,
        coverageLimits: [
          ...new Set([
            ...unit.coverageLimits,
            ...unit.gaps.flatMap((gap) => gap.coverageLimits),
            ...assessment.coverageLimits,
          ]),
        ],
      });
    }
  }
  const verifiedHold = snapshot.units.some((unit) =>
    unit.rules.some(
      (trace) => trace.findingId !== undefined && trace.effectiveVerdict === 'do_not_merge',
    ),
  );
  let decision: PolicySummary['decision'];
  if (verifiedHold) decision = 'do_not_merge';
  else if (unresolvedUnits.length) decision = 'decision_incomplete';
  else decision = strictest(verdicts);
  return { ...snapshot, decision, assessments, unresolvedUnits };
}
