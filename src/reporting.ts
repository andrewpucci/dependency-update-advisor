import { isDeepStrictEqual } from 'node:util';
import { parseReviewBinding, type ReviewBinding } from './event.js';
import { formDecisionUnits, type DecisionCoverage, type DecisionUnit } from './units.js';
import type { UnitRecord } from './analysis/batches.js';
import type { SignalAttempt } from './evidence/policy-signals.js';
import type { ResolvedReference } from './analysis/validation.js';
import { evidenceGaps } from './policy.js';

export type DecisionBriefInput = Readonly<{
  binding: ReviewBinding;
  generatedAt: string;
  reviewDigest?: string;
  coverage: DecisionCoverage;
  records: readonly UnitRecord[];
  analysisUnavailable: boolean;
  signalAttempts: readonly SignalAttempt[];
  signalBinding: ReviewBinding;
}>;
export type DecisionBriefResult =
  | Readonly<{ ok: true; body: string }>
  | Readonly<{ ok: false; category: 'input' | 'reference' | 'content' | 'size' }>;

/** Renderer-owned constant; describes shared defaults, not a consumer's settings. */
const POLICY_GUIDE_URL =
  'https://github.com/andrewpucci/dependency-update-advisor/blob/main/docs/policy-guide.md';

class RenderFailure extends Error {
  constructor(readonly category: 'input' | 'reference' | 'content' | 'size') {
    super(category);
  }
}

function text(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\`*_[\]{}()!|~])/gu, '\\$1')
    .replace(/([@#:])/gu, '$1\u200b')
    .replace(/\bwww\./giu, 'www.\u200b')
    .replace(/\b(gh)-(?=\d)/giu, '$1-\u200b')
    .replace(/\b[\da-f]{7,40}\b/giu, (value) => value.slice(0, 6) + '\u200b' + value.slice(6))
    .replace(/[\r\n]+/gu, ' ');
}

/** For untrusted text that starts a list item, where a leading marker would nest a block. */
function lineStart(value: string): string {
  return value
    .trimStart()
    .replace(/^[-+]/u, '\\$&')
    .replace(/^(\d+)\./u, '$1\\.');
}

function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function readableLabel(value: string): string {
  return text(
    value
      .replace(
        /([a-z])([A-Z])/gu,
        (_, lower: string, upper: string) => `${lower} ${upper.toLowerCase()}`,
      )
      .replaceAll('_', ' '),
  );
}

function sourceTitle(value: string): string {
  return text(value.replaceAll('publishTime', 'publication time'));
}

function recovery(category: string | null): string {
  if (category === 'configuration')
    return 'Correct the provider configuration or credential, then rerun CI.';
  if (category === 'budget' || category === 'length')
    return 'Inspect the oversized input or response, resolve it, then rerun CI.';
  if (
    [
      'transport',
      'http',
      'media-type',
      'response-size',
      'encoding',
      'envelope',
      'json',
      'deadline',
      'cancelled',
      'call_budget',
    ].includes(category ?? '')
  )
    return 'Rerun CI to retry dependency analysis.';
  return 'Investigate the failed review data or validation, correct the cause, then rerun CI.';
}

function evidenceGap(unit: DecisionUnit, sourceId: string): string {
  const link = unit.evidenceLinks.find((entry) => entry.id === sourceId);
  const member = unit.members.find((entry) => entry.id === link?.memberId);
  if (!link || !member) throw new RenderFailure('reference');
  return `${text(member.name)}: ${readableLabel(link.category)} evidence is ${readableLabel(link.status)} (${link.reasons.map(readableLabel).join(', ')}). Review the ${readableLabel(link.category)} evidence for ${text(member.name)} and rerun CI.`;
}

function unsafeUrl(value: string): boolean {
  return (
    /\s/u.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}

function vettedLink(title: string, value: string): string {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || unsafeUrl(value))
    throw new RenderFailure('reference');
  return `[${sourceTitle(title)}](<${url.href.replace(/[<>]/gu, '')}>)`;
}

function utcTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?(?:Z|\+00:00)$/u.exec(value);
  if (!match) return false;
  const canonical = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  return new Date(value).toISOString() === canonical;
}

function contextReference(
  ref: Extract<ResolvedReference, { kind: 'context' }>,
  input: DecisionBriefInput,
): string {
  const dependency = input.coverage.inventory.packet.context.dependencies.find(
    (item) => item.id === ref.memberId,
  );
  const index = dependency?.facts.findIndex(
    (fact, i) =>
      JSON.stringify([ref.memberId, fact.path, i]) === ref.contextId && fact.path === ref.path,
  );
  if (index === undefined || index < 0) throw new RenderFailure('reference');
  return `Repository context: ${text(ref.path)}`;
}

function fileReference(
  ref: Extract<ResolvedReference, { kind: 'source' }>,
  revision: 'base' | 'head' | 'context',
): string {
  if (revision !== ref.side || ref.url !== null) throw new RenderFailure('reference');
  return ref.side === 'base'
    ? 'Base repository file evidence'
    : 'Proposed repository file evidence';
}

function reference(ref: ResolvedReference, unit: DecisionUnit, input: DecisionBriefInput): string {
  if (!unit.memberIds.includes(ref.memberId)) throw new RenderFailure('reference');
  const packet = input.coverage.inventory.packet;
  if (ref.kind === 'context') return contextReference(ref, input);
  const source = packet.sources.find((item) => item.id === ref.sourceId);
  const change = packet.changes.find((item) => item.id === ref.memberId);
  const side = ref.side === 'base' ? change?.from : change?.to;
  if (
    !source ||
    source.status === 'unavailable' ||
    !source.memberIds.includes(ref.memberId) ||
    !side
  )
    throw new RenderFailure('reference');
  const linked =
    change?.evidence[ref.category]?.sourceIds.includes(source.id) ||
    unit.findings.some(
      (finding) =>
        finding.memberId === ref.memberId &&
        finding.references.includes(source.id) &&
        ref.category === source.kind,
    ) ||
    (source.provenance.kind === 'file' &&
      source.id === side.sourceId &&
      ref.category === source.kind);
  if (!linked) throw new RenderFailure('reference');
  if (source.provenance.kind === 'file') return fileReference(ref, source.provenance.revision);
  if (source.provenance.kind !== 'upstream' || source.provenance.url !== ref.url)
    throw new RenderFailure('reference');
  const version = 'ref' in side ? side.ref : 'version' in side ? side.version : null;
  if (
    !source.provenance.subjects.some(
      (subject) =>
        subject.memberId === ref.memberId && subject.side === ref.side && subject.value === version,
    )
  )
    throw new RenderFailure('reference');
  return vettedLink(source.provenance.title, ref.url);
}

function assessmentSourceForSide(
  unit: DecisionUnit,
  link: DecisionUnit['evidenceLinks'][number],
  side: 'head' | 'base',
  input: DecisionBriefInput,
): string | null {
  const packet = input.coverage.inventory.packet;
  const change = packet.changes.find((item) => item.id === link.memberId);
  const version = side === 'head' ? change?.to : change?.from;
  if (!version) return null;
  const value = 'ref' in version ? version.ref : 'version' in version ? version.version : null;
  for (const id of link.sourceIds) {
    const source = packet.sources.find((item) => item.id === id);
    if (!source || source.status === 'unavailable' || source.provenance.kind !== 'upstream')
      continue;
    if (
      !source.provenance.subjects.some(
        (subject) =>
          subject.memberId === link.memberId && subject.side === side && subject.value === value,
      )
    )
      continue;
    return reference(
      {
        kind: 'source',
        sourceId: id,
        memberId: link.memberId,
        side,
        category: link.category,
        url: source.provenance.url,
      },
      unit,
      input,
    );
  }
  return null;
}

function assessmentSource(unit: DecisionUnit, input: DecisionBriefInput): string | null {
  for (const link of unit.evidenceLinks) {
    if (link.category !== 'upstream' || link.status === 'unavailable') continue;
    for (const side of ['head', 'base'] as const) {
      const source = assessmentSourceForSide(unit, link, side, input);
      if (source) return source;
    }
  }
  return null;
}

function consistentOutcome(input: DecisionBriefInput): boolean {
  const { inventory, inventoryGaps, outcome, policyProvenance } = input.coverage;
  const decision = inventoryGaps.length
    ? policyProvenance.withoutAssessments?.decision
    : policyProvenance.assessments.decision;
  if (!inventory.units.length && !inventoryGaps.length) return false;
  if (inventoryGaps.length && decision !== 'do_not_merge')
    return outcome.kind === 'decision_incomplete' && decision !== undefined;
  if (decision === 'decision_incomplete') return outcome.kind === 'decision_incomplete';
  return outcome.kind === 'advice' && outcome.verdict === decision;
}

function consistentCounts(input: DecisionBriefInput): boolean {
  const { inventory, counts } = input.coverage;
  const units = inventory.units;
  const assessed = input.records.filter((record) => record.state.state === 'assessed').length;
  const grouped = units.filter((unit) => unit.kind === 'direct_group').length;
  return (
    input.records.length === units.length &&
    counts.units === units.length &&
    counts.changedMembers === inventory.packet.changes.length &&
    counts.assessedUnits === assessed &&
    counts.unresolvedUnits === input.records.length - assessed &&
    input.analysisUnavailable === (units.length > 0 && assessed === 0) &&
    counts.groupedUnits === grouped &&
    counts.standaloneUnits === units.length - grouped
  );
}

function consistentRecord(record: UnitRecord, unit: DecisionUnit): boolean {
  if (record.unitId !== unit.id) return false;
  if (record.state.state !== 'assessed') return record.assessment === null;
  return (
    !!record.assessment &&
    record.assessment.unitId === record.unitId &&
    record.assessment.verdict === record.state.verdict
  );
}

function consistentEvidence(
  unit: DecisionUnit,
  evaluation: DecisionCoverage['policyProvenance']['assessments']['units'][number],
): boolean {
  const { gaps, uncheckedSignals } = evidenceGaps(unit);
  return (
    isDeepStrictEqual(evaluation.gaps, gaps) &&
    isDeepStrictEqual(evaluation.uncheckedSignals, uncheckedSignals)
  );
}

function consistentUnits(input: DecisionBriefInput): boolean {
  const { inventory, counts, policyProvenance } = input.coverage;
  const units = inventory.units,
    summary = policyProvenance.assessments;
  if (
    summary.unresolvedUnits.length !== counts.unresolvedUnits ||
    summary.assessments.length !== units.length ||
    summary.units.length !== units.length
  )
    return false;
  return units.every((unit, index) => {
    const evaluation = summary.units[index],
      assessment = summary.assessments[index];
    const { unitId, ...state } = assessment;
    return (
      consistentRecord(input.records[index], unit) &&
      evaluation.id === unit.id &&
      isDeepStrictEqual(evaluation.members, unit.members) &&
      isDeepStrictEqual(evaluation.findings, unit.findings) &&
      isDeepStrictEqual(evaluation.sources, unit.sources) &&
      isDeepStrictEqual(evaluation.coverageLimits, unit.coverageLimits) &&
      consistentEvidence(unit, evaluation) &&
      unitId === unit.id &&
      isDeepStrictEqual(state, input.records[index].state)
    );
  });
}

function consistentInventoryGaps(input: DecisionBriefInput): boolean {
  const { inventory, inventoryGaps } = input.coverage;
  const expected = Object.values(inventory.packet.coverage).filter(
    (coverage) => coverage.status === 'partial' || coverage.status === 'unavailable',
  ).length;
  if (inventoryGaps.length !== expected) return false;
  return (['npm', 'actions', 'uv'] as const).every((ecosystem) => {
    const coverage = inventory.packet.coverage[ecosystem];
    const gaps = inventoryGaps.filter((gap) => gap.ecosystem === ecosystem);
    if (coverage.status !== 'partial' && coverage.status !== 'unavailable')
      return gaps.length === 0;
    if (gaps.length !== 1 || gaps[0].status !== coverage.status) return false;
    return (
      isDeepStrictEqual([...gaps[0].reasons].sort(), [...coverage.reasons].sort()) &&
      isDeepStrictEqual([...gaps[0].sourceIds].sort(), [...coverage.sourceIds].sort()) &&
      gaps[0].nextActions.length === coverage.reasons.length &&
      gaps[0].nextActions.every(Boolean)
    );
  });
}

function consistentReview(input: DecisionBriefInput): boolean {
  return (
    consistentOutcome(input) &&
    consistentCounts(input) &&
    consistentUnits(input) &&
    consistentInventoryGaps(input)
  );
}

function fitComment(
  head: string[],
  assessments: string[],
  requiredFollowups: string[],
  optional: string[][],
): DecisionBriefResult {
  const sections = [assessments, ...optional];
  let omitted = false;
  for (;;) {
    const body = [
      ...head,
      ...sections[0],
      ...requiredFollowups,
      ...sections.slice(1).flat(),
      ...(omitted ? ['', 'Some lower-priority detail was omitted to fit the comment.'] : []),
    ].join('\n');
    if (body.length <= 50_000) return { ok: true, body };
    const last = sections.findLastIndex((section) => section.length > 0);
    if (last < 0) return { ok: false, category: 'size' };
    sections[last] = [];
    omitted = true;
  }
}

type Summary = DecisionCoverage['policyProvenance']['assessments'];
type Review = Readonly<{
  input: DecisionBriefInput;
  binding: ReviewBinding;
  units: readonly DecisionUnit[];
  summary: Summary;
  holds: ReturnType<typeof collectHolds>['holds'];
  modelHolds: ReturnType<typeof collectHolds>['modelHolds'];
}>;
type Hold = Review['holds'][number];
type ModelHold = Review['modelHolds'][number];

function collectHolds(input: DecisionBriefInput, units: readonly DecisionUnit[], summary: Summary) {
  const modelHolds = input.records.flatMap(
    (record, index) =>
      record.assessment?.blockers.map((blocker) => ({
        unit: units[index],
        blocker,
        rule: summary.units[index].rules.find(
          (rule) =>
            rule.effectiveVerdict === 'do_not_merge' &&
            blocker.holdId ===
              JSON.stringify([
                units[index].id,
                rule.rule,
                rule.findingId ?? null,
                rule.sourceId ?? null,
              ]),
        ),
      })) ?? [],
  );
  // One hold per finding: several rules can hold it, and model blockers explain it.
  const holds = summary.units.flatMap((unit) =>
    [
      ...new Set(
        unit.rules
          .filter((rule) => rule.findingId && rule.effectiveVerdict === 'do_not_merge')
          .map((rule) => rule.findingId),
      ),
    ].map((findingId) => ({
      unit,
      finding: unit.findings.find((f) => f.id === findingId),
      // Packet finding IDs are unique, so the ID alone pins the blocker to this unit.
      blockers: modelHolds.filter((hold) => hold.rule?.findingId === findingId),
    })),
  );
  return { holds, modelHolds };
}

function validateSignals(input: DecisionBriefInput): void {
  const { changes, sources } = input.coverage.inventory.packet;
  if (
    input.signalAttempts.some(
      (attempt) =>
        !changes.some((change) => change.id === attempt.memberId) ||
        attempt.sourceIds.some(
          (id) =>
            !sources.some(
              (source) => source.id === id && source.memberIds.includes(attempt.memberId),
            ),
        ),
    )
  )
    throw new RenderFailure('reference');
}

function validateHolds({ input, holds, modelHolds }: Review): void {
  const { outcome } = input.coverage;
  if (modelHolds.some(({ rule }) => !rule)) throw new RenderFailure('reference');
  if (
    outcome.kind === 'advice' &&
    outcome.verdict === 'do_not_merge' &&
    (!(holds.length || modelHolds.length) || holds.some((hold) => !hold.finding))
  )
    throw new RenderFailure('content');
  if (holds.length && (outcome.kind !== 'advice' || outcome.verdict !== 'do_not_merge'))
    throw new RenderFailure('content');
}

function recommendationText(outcome: DecisionCoverage['outcome']): string {
  if (outcome.kind !== 'advice') return 'No merge recommendation.';
  if (outcome.verdict === 'do_not_merge') return 'Hold; verified blockers require action.';
  if (outcome.verdict === 'merge_with_followups') return 'Merge with follow-ups.';
  return 'Merge.';
}

function nextAction(
  { input, summary, units, holds, modelHolds }: Review,
  firstUnresolved?: UnitRecord,
): string {
  const { inventoryGaps, outcome } = input.coverage;
  if (outcome.kind === 'advice' && outcome.verdict === 'do_not_merge')
    return text(holds[0]?.finding?.remediation[0] ?? modelHolds[0]?.blocker.remediation[0] ?? '');
  if (firstUnresolved) {
    const action = recovery(firstUnresolved.category);
    return input.analysisUnavailable && inventoryGaps.length
      ? `${text(inventoryGaps[0].nextActions[0] ?? '')} ${action}`
      : action;
  }
  if (inventoryGaps.length) return text(inventoryGaps[0].nextActions[0] ?? '');
  const firstGapIndex = summary.units.findIndex((unit) => unit.gaps.length > 0);
  if (firstGapIndex >= 0)
    return evidenceGap(units[firstGapIndex], summary.units[firstGapIndex].gaps[0].sourceId);
  const firstFollowup = input.records.flatMap((record) => record.assessment?.followups ?? [])[0];
  if (firstFollowup) return text(firstFollowup.description);
  return 'Review the evidence, then merge.';
}

function metadataLines(input: DecisionBriefInput, binding: ReviewBinding): string[] {
  const { owner, name } = binding.repository;
  return [
    '<!-- dependabot-intelligent-review -->',
    `<!-- reviewed-head: ${binding.headSha} -->`,
    ...(input.reviewDigest ? [`<!-- review-digest: ${input.reviewDigest} -->`] : []),
    '',
    `# Dependabot review: ${owner}/${name} PR ${binding.pullNumber}`,
    '',
  ];
}

function attributionLines(input: DecisionBriefInput, binding: ReviewBinding): string[] {
  const { owner, name } = binding.repository;
  return [
    `Reviewed head: [${binding.headSha}](https://github.com/${owner}/${name}/commit/${binding.headSha})`,
    `Generated: ${input.generatedAt}`,
  ];
}

function headerLines(r: Review): string[] {
  const { input, binding, summary } = r;
  const { counts, inventoryGaps, outcome } = input.coverage;
  const incomplete =
    input.analysisUnavailable ||
    counts.unresolvedUnits > 0 ||
    inventoryGaps.length > 0 ||
    summary.units.some((unit) => unit.gaps.length > 0);
  const firstUnresolved = input.records.find((record) => record.state.state !== 'assessed');
  const next = nextAction(r, firstUnresolved);
  if (!next) throw new RenderFailure('content');
  return [
    ...metadataLines(input, binding),
    `**Recommendation:** ${recommendationText(outcome)}${input.analysisUnavailable ? ' Analysis is unavailable.' : ''}`,
    `**Next action:** ${next}${input.analysisUnavailable && outcome.kind === 'advice' && firstUnresolved ? ` ${recovery(firstUnresolved.category)}` : ''}`,
    `Required evidence: ${incomplete ? 'Incomplete.' : 'Complete.'}`,
    '',
    ...attributionLines(input, binding),
  ];
}

function verifiedLinks({ input }: Review, finding: NonNullable<Hold['finding']>): string[] {
  const sources = finding.references.map((id) =>
    input.coverage.inventory.packet.sources.find(
      (source) => source.id === id && source.memberIds.includes(finding.memberId),
    ),
  );
  if (sources.some((source) => !source || source.status === 'unavailable'))
    throw new RenderFailure('reference');
  return sources.flatMap((source) =>
    source?.provenance.kind === 'upstream'
      ? [vettedLink(source.provenance.title, source.provenance.url)]
      : [],
  );
}

function blockerEvidence(r: Review, { unit, blocker }: ModelHold): string {
  if (!blocker.remediation.length || !blocker.validation.length) throw new RenderFailure('content');
  return blocker.evidence
    .map(
      (claim) =>
        `${text(claim.text)} ${claim.references.map((ref) => reference(ref, unit, r.input)).join(' ')}`,
    )
    .join(' ');
}

function distinctText(values: readonly string[]): string {
  return [...new Set(values)].map(text).join(' ');
}

function blockerLines(r: Review): string[] {
  const { holds, modelHolds } = r;
  if (!holds.length && !modelHolds.length) return [];
  const lines = ['', '## Reasons not to merge', ''];
  for (const { unit, finding, blockers } of holds) {
    if (!finding || !finding.remediation.length || !finding.validation.length)
      throw new RenderFailure('content');
    const links = verifiedLinks(r, finding);
    const evidence = blockers.map((hold) => blockerEvidence(r, hold)).filter(Boolean);
    const impact = blockers.length
      ? distinctText(blockers.map(({ blocker }) => blocker.impact))
      : 'this finding requires a hold.';
    lines.push(
      `- ${text(unit.members.find((member) => member.id === finding.memberId)?.name ?? '')}: ${text(finding.rationale)} Impact: ${impact}${evidence.length ? ` Evidence: ${evidence.join(' ')}` : ''} Remediation: ${distinctText([...finding.remediation, ...blockers.flatMap(({ blocker }) => blocker.remediation)])} Validation: ${distinctText([...finding.validation, ...blockers.flatMap(({ blocker }) => blocker.validation)])} ${links.join(' ')}`,
    );
  }
  for (const hold of modelHolds) {
    if (hold.rule?.findingId) continue;
    const { unit, blocker, rule } = hold;
    const evidence = blockerEvidence(r, hold);
    const memberId = unit.evidenceLinks.find((link) => link.id === rule?.sourceId)?.memberId;
    const member = unit.members.find((entry) => entry.id === memberId);
    if (!member) throw new RenderFailure('reference');
    lines.push(
      `- ${text(member.name)}: ${text(blocker.reason)} Impact: ${text(blocker.impact)} Evidence: ${evidence || 'The policy requires action on the identified evidence gap.'} Remediation: ${blocker.remediation.map(text).join(' ')} Validation: ${blocker.validation.map(text).join(' ')}`,
    );
  }
  return lines;
}

function queueLines({ input, units, summary }: Review): string[] {
  const lines: string[] = [];
  if (input.coverage.counts.unresolvedUnits) lines.push('', '## Decision queue', '');
  for (const [index, unit] of units.entries()) {
    const record = input.records[index];
    if (record.state.state === 'assessed') continue;
    const unresolved = summary.unresolvedUnits.find((entry) => entry.unitId === unit.id);
    if (!unresolved) throw new RenderFailure('content');
    lines.push(
      `- ${text(unit.members.map((member) => member.name).join(', '))} (${plural(unit.memberCount, 'changed update')}): ${text(record.state.reason)} ${recovery(record.category)} ${summary.units[index].gaps.map((gap) => evidenceGap(unit, gap.sourceId)).join(' ')}`,
    );
  }
  return lines;
}

function coverageLines({ input }: Review): string[] {
  const { counts, inventoryGaps } = input.coverage;
  return [
    '',
    '## Decision coverage',
    '',
    `${plural(counts.changedMembers, 'changed update')}; ${plural(counts.assessedUnits, 'assessed decision unit')}; ${plural(counts.unresolvedUnits, 'unresolved decision unit')}.`,
    ...(counts.groupedUnits
      ? ['A direct-update group is assessed as one unit, not as separately researched members.']
      : []),
    ...inventoryGaps.map(
      (gap) =>
        `- ${text(gap.ecosystem)}: ${gap.reasons.map(text).join(', ')}. ${gap.nextActions.map(text).join(' ')}`,
    ),
  ];
}

function findingLines({ input, units }: Review): string[] {
  const lines: string[] = [];
  for (const unit of units) {
    for (const finding of unit.findings) {
      const member = unit.members.find((item) => item.id === finding.memberId);
      if (!member || !finding.references.length) throw new RenderFailure('reference');
      const citations = finding.references.map((id) => {
        const source = input.coverage.inventory.packet.sources.find((item) => item.id === id);
        if (!source || !source.memberIds.includes(finding.memberId))
          throw new RenderFailure('reference');
        const side =
          source.provenance.kind === 'file'
            ? source.provenance.revision
            : source.provenance.kind === 'upstream'
              ? source.provenance.subjects.find((subject) => subject.memberId === finding.memberId)
                  ?.side
              : undefined;
        if (side !== 'base' && side !== 'head') throw new RenderFailure('reference');
        return reference(
          {
            kind: 'source',
            sourceId: id,
            memberId: member.id,
            side,
            category: source.kind,
            url: source.provenance.kind === 'upstream' ? source.provenance.url : null,
          },
          unit,
          input,
        );
      });
      lines.push(
        `- ${text(member.name)} — ${readableLabel(finding.kind)}: ${text(finding.rationale)} ${'applicability' in finding ? readableLabel(finding.applicability) : ''} ${'severity' in finding && finding.severity ? text(finding.severity) : ''} ${citations.join(' ')}`,
      );
    }
  }
  return lines;
}

function assessmentLines({ input, units, summary }: Review): string[] {
  if (!input.coverage.counts.assessedUnits) return [];
  const lines = ['', '## Package assessments', ''];
  for (const [index, unit] of units.entries()) {
    const assessment = input.records[index].assessment;
    if (!assessment) continue;
    const evaluation = summary.units[index];
    if (unit.kind === 'direct_group') {
      lines.push(
        `- **Direct-update group** (${unit.ecosystem}; ${plural(unit.memberCount, 'changed update')})`,
      );
      for (const member of unit.members)
        lines.push(
          `  - ${text(member.name)}: ${text(member.currentVersion ?? 'unknown')} → ${text(member.proposedVersion ?? 'unknown')}`,
        );
    } else {
      const member = unit.members[0];
      const role =
        input.coverage.inventory.packet.changes.find((change) => unit.memberIds.includes(change.id))
          ?.role ?? 'unknown';
      lines.push(
        `- **${text(member.name)}** (${unit.ecosystem}, ${text(role)}): ${text(member.currentVersion ?? 'unknown')} → ${text(member.proposedVersion ?? 'unknown')}`,
      );
    }
    const citations = assessment.reason.references.map((ref) => reference(ref, unit, input));
    const upstream = assessmentSource(unit, input);
    if (upstream && !citations.includes(upstream)) citations.push(upstream);
    lines.push(`  - Assessment: ${text(assessment.reason.text)}`);
    lines.push(
      `  - [Policy](<${POLICY_GUIDE_URL}>): ${readableLabel(evaluation.effectiveCeiling)}; evidence: ${evaluation.gaps.length ? 'partial' : 'complete'}. ${citations.join(' ')}`,
    );
  }
  return lines;
}

function followupLines({ input, units, summary }: Review): string[] {
  const assessedGaps = summary.units.flatMap((unit, index) =>
    input.records[index].assessment ? unit.gaps.map((gap) => ({ unit: units[index], gap })) : [],
  );
  const followups = input.records.flatMap(
    (record, index) =>
      record.assessment?.followups.map((followup) => ({ followup, unit: units[index] })) ?? [],
  );
  if (!assessedGaps.length && !followups.length) return [];
  return [
    '',
    '## Non-blocking follow-ups',
    '',
    ...assessedGaps.map(({ unit, gap }) => `- ${evidenceGap(unit, gap.sourceId)}`),
    ...followups.map(
      ({ unit, followup }) =>
        `- ${text(unit.members.map((member) => member.name).join(', '))}: ${text(followup.description)} ${followup.references.map((ref) => reference(ref, unit, input)).join(' ')}`,
    ),
  ];
}

function capabilityLine(
  { input }: Review,
  capability: NonNullable<UnitRecord['assessment']>['newFunctionality'][number],
  unit: DecisionUnit,
): string {
  if (unit.kind === 'direct_group' && capability.memberId !== unit.anchorId)
    throw new RenderFailure('reference');
  const source = reference(
    {
      kind: 'source',
      sourceId: capability.sourceId,
      memberId: capability.memberId,
      side: 'head',
      category: 'upstream',
      url: capability.sourceUrl,
    },
    unit,
    input,
  );
  const context =
    capability.contextId && capability.contextPath
      ? reference(
          {
            kind: 'context',
            contextId: capability.contextId,
            memberId: capability.memberId,
            path: capability.contextPath,
          },
          unit,
          input,
        )
      : '';
  if (capability.usefulness !== 'not_relevant' && (!capability.action || !context))
    throw new RenderFailure('content');
  return `- ${lineStart(text(capability.feature))} ${capability.action ? text(capability.action) : ''} ${text(capability.rationale)} ${context} ${source}`;
}

function capabilitySections(r: Review): string[][] {
  const { input, units } = r;
  const capabilities = input.records.flatMap(
    (record, index) =>
      record.assessment?.newFunctionality.map((capability) => ({
        capability,
        unit: units[index],
      })) ?? [],
  );
  const sections: string[][] = [];
  for (const [kind, heading] of [
    ['use_now', 'New capabilities to adopt now'],
    ['consider_later', 'Consider later'],
    ['not_relevant', 'Not relevant'],
  ] as const) {
    const entries = capabilities.filter(({ capability }) => capability.usefulness === kind);
    if (!entries.length) continue;
    sections.push([
      ...(kind === 'not_relevant'
        ? ['', '<details>', '<summary>Not relevant</summary>', '']
        : ['', `## ${heading}`, '']),
      ...entries.map(({ capability, unit }) => capabilityLine(r, capability, unit)),
      ...(kind === 'not_relevant' ? ['', '</details>'] : []),
    ]);
  }
  return sections;
}

function uncheckedQualifier(
  { input, units }: Review,
  member: DecisionUnit['members'][number],
): string {
  const duplicates = units
    .flatMap((unit) => unit.members)
    .filter((item) => item.name === member.name && item.ecosystem === member.ecosystem);
  if (duplicates.length < 2) return member.ecosystem;
  const change = input.coverage.inventory.packet.changes.find((item) => item.id === member.id);
  const side = change?.to ?? change?.from;
  if (!side) throw new RenderFailure('reference');
  const location =
    'root' in side
      ? `root ${side.root}`
      : `${side.workflow}, ${side.jobId}, step ${side.stepIndex ?? 'unknown'}`;
  return `${member.ecosystem}, ${text(location)}, ${text(member.proposedVersion ?? member.currentVersion ?? 'unknown')}`;
}

function uncheckedSections(r: Review): string[][] {
  const { input, units, summary } = r;
  const licenseFailures = input.signalAttempts.filter(
    (attempt) => attempt.category === 'license' && attempt.outcome !== 'available',
  );
  const unchecked = summary.units.flatMap((unit, index) =>
    unit.uncheckedSignals.map((signal) => ({ unit: units[index], signal })),
  );
  if (!licenseFailures.length && !unchecked.length) return [];
  type Member = DecisionUnit['members'][number];
  const groups = new Map<string, { member: Member; details: Map<string, string[]> }>();
  function add(member: Member, label: string, detail: string) {
    let group = groups.get(member.id);
    if (!group) {
      group = { member, details: new Map() };
      groups.set(member.id, group);
    }
    const labels = group.details.get(detail) ?? [];
    labels.push(label);
    group.details.set(detail, labels);
  }
  for (const { unit, signal } of unchecked) {
    const link = unit.evidenceLinks.find((entry) => entry.id === signal.sourceId);
    const member = unit.members.find((entry) => entry.id === link?.memberId);
    if (!link || !member) throw new RenderFailure('reference');
    const reasons = link.reasons.map(readableLabel).join(', ') || readableLabel(signal.reason);
    add(member, readableLabel(signal.signal), `${reasons}; ${readableLabel(link.status)}`);
  }
  for (const attempt of licenseFailures) {
    const unit = units.find((candidate) => candidate.memberIds.includes(attempt.memberId));
    const member = unit?.members.find((candidate) => candidate.id === attempt.memberId);
    if (!member) throw new RenderFailure('reference');
    const side = attempt.side === 'head' ? 'proposed' : 'base';
    const reasons = attempt.reasons.map(readableLabel).join(', ') || 'not checked';
    add(member, `license (${side})`, `${reasons}; ${readableLabel(attempt.outcome)}`);
  }
  const lines = ['', '## Unchecked signals', ''];
  for (const { member, details } of groups.values()) {
    lines.push(`- **${text(member.name)}** (${uncheckedQualifier(r, member)})`);
    for (const [detail, labels] of details) lines.push(`  - ${labels.join(', ')}: ${detail}.`);
  }
  return [lines];
}

function renderNonempty(input: DecisionBriefInput, binding: ReviewBinding): DecisionBriefResult {
  if (!consistentReview(input)) throw new RenderFailure('content');
  const units = input.coverage.inventory.units;
  const summary = input.coverage.policyProvenance.assessments;
  validateSignals(input);
  const r: Review = { input, binding, units, summary, ...collectHolds(input, units, summary) };
  validateHolds(r);
  const head = [
    ...headerLines(r),
    ...blockerLines(r),
    ...queueLines(r),
    ...coverageLines(r),
    ...findingLines(r),
  ];
  return fitComment(head, assessmentLines(r), followupLines(r), [
    ...capabilitySections(r),
    ...uncheckedSections(r),
  ]);
}

/** Render an attributed review body; publication readiness is decided by the caller. */
export function renderDecisionBrief(input: DecisionBriefInput): DecisionBriefResult {
  try {
    const binding = parseReviewBinding(input.binding);
    if (
      !binding ||
      !isDeepStrictEqual(binding, parseReviewBinding(input.signalBinding)) ||
      !/^[a-z0-9-]+$/u.test(binding.repository.owner) ||
      !/^[a-z0-9._-]+$/u.test(binding.repository.name) ||
      !isDeepStrictEqual(binding, input.coverage.inventory.packet.binding) ||
      !isDeepStrictEqual(
        formDecisionUnits(input.coverage.inventory.packet),
        input.coverage.inventory,
      ) ||
      !utcTimestamp(input.generatedAt) ||
      (input.reviewDigest !== undefined && !/^[a-f\d]{64}$/u.test(input.reviewDigest))
    )
      return { ok: false, category: 'input' };
    const { counts, inventoryGaps, outcome } = input.coverage;
    if (outcome.kind !== 'empty_inventory') return renderNonempty(input, binding);
    if (
      input.analysisUnavailable ||
      input.records.length !== 0 ||
      input.signalAttempts.length !== 0 ||
      input.coverage.inventory.units.length !== 0 ||
      input.coverage.inventory.packet.changes.length !== 0 ||
      counts.changedMembers !== 0 ||
      counts.units !== 0 ||
      counts.assessedUnits !== 0 ||
      counts.unresolvedUnits !== 0 ||
      counts.groupedUnits !== 0 ||
      counts.standaloneUnits !== 0 ||
      inventoryGaps.length !== 0 ||
      Object.values(input.coverage.inventory.packet.coverage).some(
        (entry) => entry.status === 'partial' || entry.status === 'unavailable',
      )
    )
      return { ok: false, category: 'content' };
    const body = [
      ...metadataLines(input, binding),
      'No dependency changes to review.',
      '',
      '**Next action:** No dependency action is needed.',
      '',
      'Required evidence: Complete; 0 changed updates, 0 assessed decision units, 0 unresolved decision units.',
      '',
      ...attributionLines(input, binding),
    ].join('\n');
    return body.length <= 50_000 ? { ok: true, body } : { ok: false, category: 'size' };
  } catch (error) {
    return { ok: false, category: error instanceof RenderFailure ? error.category : 'input' };
  }
}
