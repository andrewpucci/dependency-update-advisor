import { isDeepStrictEqual } from 'node:util';
import { parseReviewBinding, type ReviewBinding } from './event.js';
import { formDecisionUnits, type DecisionCoverage, type DecisionUnit } from './units.js';
import type { UnitRecord } from './analysis/batches.js';
import type { SignalAttempt } from './evidence/policy-signals.js';
import type { ResolvedReference } from './analysis/validation.js';

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

class InvalidReference extends Error {}

function text(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\`*_[\]{}()!|~])/gu, '\\$1')
    .replace(/([@#:])/gu, '$1\u200b')
    .replace(/\bwww\./giu, 'www.\u200b')
    .replace(/\b[\da-f]{7,40}\b/giu, (value) => value.slice(0, 6) + '\u200b' + value.slice(6))
    .replace(/[\r\n]+/gu, ' ');
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
  if (!link || !member) throw new InvalidReference();
  return `${text(member.name)}: ${text(link.category)} evidence is ${text(link.status)} (${link.reasons.map(text).join(', ')}). Review the ${text(link.category)} evidence for ${text(member.name)} and rerun CI.`;
}

function unsafeUrl(value: string): boolean {
  return (
    /\s/u.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
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
  if (index === undefined || index < 0) throw new InvalidReference();
  return `Repository context: ${text(ref.path)}`;
}

function reference(ref: ResolvedReference, unit: DecisionUnit, input: DecisionBriefInput): string {
  if (!unit.memberIds.includes(ref.memberId)) throw new InvalidReference();
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
    throw new InvalidReference();
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
  if (!linked) throw new InvalidReference();
  if (source.provenance.kind === 'file') {
    if (source.provenance.revision !== ref.side || ref.url !== null) throw new InvalidReference();
    return 'Repository file evidence';
  }
  if (source.provenance.kind !== 'upstream' || source.provenance.url !== ref.url)
    throw new InvalidReference();
  const version = 'ref' in side ? side.ref : 'version' in side ? side.version : null;
  if (
    !source.provenance.subjects.some(
      (subject) =>
        subject.memberId === ref.memberId && subject.side === ref.side && subject.value === version,
    )
  )
    throw new InvalidReference();
  const url = new URL(ref.url);
  if (url.protocol !== 'https:' || url.username || url.password || unsafeUrl(ref.url))
    throw new InvalidReference();
  return `[${text(source.provenance.title)}](<${url.href.replace(/[<>]/gu, '')}>)`;
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
      unitId === unit.id &&
      isDeepStrictEqual(state, input.records[index].state)
    );
  });
}

function consistentInventoryGaps(input: DecisionBriefInput): boolean {
  const { inventory, inventoryGaps } = input.coverage;
  return (['npm', 'actions', 'uv'] as const).every((ecosystem) => {
    const status = inventory.packet.coverage[ecosystem].status;
    return (
      (status === 'partial' || status === 'unavailable') ===
      inventoryGaps.some((gap) => gap.ecosystem === ecosystem && gap.status === status)
    );
  });
}

function renderNonempty(input: DecisionBriefInput, binding: ReviewBinding): DecisionBriefResult {
  const { counts, inventoryGaps, outcome } = input.coverage;
  const units = input.coverage.inventory.units;
  const summary = input.coverage.policyProvenance.assessments;
  if (
    !consistentOutcome(input) ||
    !consistentCounts(input) ||
    !consistentUnits(input) ||
    !consistentInventoryGaps(input)
  )
    return { ok: false, category: 'content' };
  const { owner, name } = binding.repository;
  if (
    input.signalAttempts.some(
      (attempt) =>
        !input.coverage.inventory.packet.changes.some((change) => change.id === attempt.memberId) ||
        attempt.sourceIds.some(
          (id) =>
            !input.coverage.inventory.packet.sources.some(
              (source) => source.id === id && source.memberIds.includes(attempt.memberId),
            ),
        ),
    )
  )
    return { ok: false, category: 'reference' };
  const holds = summary.units.flatMap((unit) =>
    unit.rules
      .filter((rule) => rule.findingId && rule.effectiveVerdict === 'do_not_merge')
      .map((rule) => ({ unit, finding: unit.findings.find((f) => f.id === rule.findingId) })),
  );
  const modelHolds = input.records.flatMap(
    (record, index) =>
      record.assessment?.blockers.map((blocker) => ({
        unit: units[index],
        policy: summary.units[index],
        blocker,
      })) ?? [],
  );
  if (
    modelHolds.some(
      ({ unit, policy, blocker }) =>
        !policy.rules.some(
          (rule) =>
            rule.effectiveVerdict === 'do_not_merge' &&
            blocker.holdId ===
              JSON.stringify([unit.id, rule.rule, rule.findingId ?? null, rule.sourceId ?? null]),
        ),
    )
  )
    return { ok: false, category: 'reference' };
  if (
    outcome.kind === 'advice' &&
    outcome.verdict === 'do_not_merge' &&
    (!(holds.length || modelHolds.length) || holds.some((hold) => !hold.finding))
  )
    return { ok: false, category: 'content' };
  if (holds.length && (outcome.kind !== 'advice' || outcome.verdict !== 'do_not_merge'))
    return { ok: false, category: 'content' };
  const gaps = summary.units.flatMap((unit) => unit.gaps);
  const incomplete =
    input.analysisUnavailable ||
    counts.unresolvedUnits > 0 ||
    inventoryGaps.length > 0 ||
    gaps.length > 0;
  const recommendation =
    outcome.kind !== 'advice'
      ? 'No merge recommendation.'
      : outcome.verdict === 'do_not_merge'
        ? 'Hold; verified blockers require action.'
        : outcome.verdict === 'merge_with_followups'
          ? 'Merge with follow-ups.'
          : 'Advisory recommendation: merge.';
  const firstUnresolved = input.records.find((record) => record.state.state !== 'assessed');
  const firstGapIndex = summary.units.findIndex((unit) => unit.gaps.length > 0);
  const firstFollowup = input.records.flatMap((record) => record.assessment?.followups ?? [])[0];
  const next =
    outcome.kind === 'advice' && outcome.verdict === 'do_not_merge'
      ? text(holds[0]?.finding?.remediation[0] ?? modelHolds[0]?.blocker.remediation[0] ?? '')
      : firstUnresolved
        ? recovery(firstUnresolved.category)
        : inventoryGaps.length
          ? text(inventoryGaps[0].nextActions[0] ?? '')
          : firstGapIndex >= 0
            ? evidenceGap(units[firstGapIndex], summary.units[firstGapIndex].gaps[0].sourceId)
            : firstFollowup
              ? text(firstFollowup.description)
              : 'Review the assessments below.';
  if (!next) return { ok: false, category: 'content' };
  const lines = [
    '<!-- dependabot-intelligent-review -->',
    `<!-- reviewed-head: ${binding.headSha} -->`,
    ...(input.reviewDigest ? [`<!-- review-digest: ${input.reviewDigest} -->`] : []),
    '',
    `# Dependabot review: ${owner}/${name} PR ${binding.pullNumber}`,
    '',
    `**Recommendation:** ${recommendation}${input.analysisUnavailable ? ' Analysis is unavailable.' : ''}`,
    `**Next action:** ${next}${input.analysisUnavailable && outcome.kind === 'advice' && firstUnresolved ? ` ${recovery(firstUnresolved.category)}` : ''}`,
    `**Evidence coverage:** ${incomplete ? 'Incomplete.' : 'Complete.'}`,
    '',
    `Reviewed head: [${binding.headSha}](https://github.com/${owner}/${name}/commit/${binding.headSha})`,
    `Generated: ${input.generatedAt}`,
  ];
  function appendBlockers(): DecisionBriefResult | undefined {
    if (holds.length || modelHolds.length) {
      lines.push('', '## Reasons not to merge', '');
      for (const { unit, finding } of holds) {
        if (!finding || !finding.remediation.length || !finding.validation.length)
          return { ok: false, category: 'content' };
        const sources = finding.references.map((id) =>
          input.coverage.inventory.packet.sources.find(
            (source) => source.id === id && source.memberIds.includes(finding.memberId),
          ),
        );
        if (sources.some((source) => !source || source.status === 'unavailable'))
          return { ok: false, category: 'reference' };
        const links: string[] = [];
        for (const source of sources) {
          if (source?.provenance.kind !== 'upstream') continue;
          const url = new URL(source.provenance.url);
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            unsafeUrl(source.provenance.url)
          )
            return { ok: false, category: 'reference' };
          links.push(`[${text(source.provenance.title)}](<${url.href.replace(/[<>]/gu, '')}>)`);
        }
        lines.push(
          `- ${text(unit.members.find((member) => member.id === finding.memberId)?.name ?? '')}: ${text(finding.rationale)} Impact: this finding requires a hold. Remediation: ${finding.remediation.map(text).join(' ')} Validation: ${finding.validation.map(text).join(' ')} ${links.join(' ')}`,
        );
      }
      for (const { unit, blocker } of modelHolds) {
        const evidence = blocker.evidence
          .map(
            (claim) =>
              `${text(claim.text)} ${claim.references.map((ref) => reference(ref, unit, input)).join(' ')}`,
          )
          .join(' ');
        if (!blocker.remediation.length || !blocker.validation.length)
          return { ok: false, category: 'content' };
        lines.push(
          `- ${text(unit.members.map((member) => member.name).join(', '))}: ${text(blocker.reason)} Impact: ${text(blocker.impact)} Evidence: ${evidence || 'The policy requires action on the identified evidence gap.'} Remediation: ${blocker.remediation.map(text).join(' ')} Validation: ${blocker.validation.map(text).join(' ')}`,
        );
      }
    }
    return undefined;
  }
  const appendBlockersError = appendBlockers();
  if (appendBlockersError) return appendBlockersError;
  function appendQueue(): DecisionBriefResult | undefined {
    if (counts.unresolvedUnits) lines.push('', '## Decision queue', '');
    for (const [index, unit] of units.entries()) {
      const record = input.records[index];
      if (record.state.state === 'assessed') continue;
      const unresolved = summary.unresolvedUnits.find((entry) => entry.unitId === unit.id);
      if (!unresolved || unresolved.unitId !== unit.id) return { ok: false, category: 'content' };
      lines.push(
        `- ${text(unit.members.map((member) => member.name).join(', '))} (${unit.memberCount} changed updates): ${text(record.state.reason)} ${recovery(record.category)} ${summary.units[index].gaps.map((gap) => evidenceGap(unit, gap.sourceId)).join(' ')}`,
      );
    }
    return undefined;
  }
  const appendQueueError = appendQueue();
  if (appendQueueError) return appendQueueError;
  lines.push(
    '',
    '## Decision coverage',
    '',
    `${counts.changedMembers} changed updates; ${counts.assessedUnits} assessed decision units; ${counts.unresolvedUnits} unresolved decision units.`,
  );
  if (counts.groupedUnits)
    lines.push(
      'A direct-update group is assessed as one unit, not as separately researched members.',
    );
  for (const gap of inventoryGaps)
    lines.push(
      `- ${text(gap.ecosystem)}: ${gap.reasons.map(text).join(', ')}. ${gap.nextActions.map(text).join(' ')}`,
    );
  function appendFindings(): DecisionBriefResult | undefined {
    for (const unit of units) {
      for (const finding of unit.findings) {
        const member = unit.members.find((item) => item.id === finding.memberId);
        if (!member || !finding.references.length) return { ok: false, category: 'reference' };
        const citations = finding.references.map((id) => {
          const source = input.coverage.inventory.packet.sources.find((item) => item.id === id);
          if (!source || !source.memberIds.includes(finding.memberId)) throw new InvalidReference();
          const side =
            source.provenance.kind === 'file'
              ? source.provenance.revision
              : source.provenance.kind === 'upstream'
                ? source.provenance.subjects.find(
                    (subject) => subject.memberId === finding.memberId,
                  )?.side
                : undefined;
          if (side !== 'base' && side !== 'head') throw new InvalidReference();
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
          `- ${text(member.name)} — ${text(finding.kind)}: ${text(finding.rationale)} ${'applicability' in finding ? text(finding.applicability) : ''} ${'severity' in finding && finding.severity ? text(finding.severity) : ''} ${citations.join(' ')}`,
        );
      }
    }
    return undefined;
  }
  const appendFindingsError = appendFindings();
  if (appendFindingsError) return appendFindingsError;
  const head = [...lines];
  lines.length = 0;
  function appendAssessments(): void {
    if (counts.assessedUnits) {
      lines.push('', '## Package assessments', '');
      for (const [index, unit] of units.entries()) {
        const assessment = input.records[index].assessment;
        if (!assessment) continue;
        const evaluation = summary.units[index];
        const names = unit.members
          .map(
            (member) =>
              `${text(member.name)} ${text(member.currentVersion ?? 'unknown')} → ${text(member.proposedVersion ?? 'unknown')}`,
          )
          .join(', ');
        const citations = assessment.reason.references.map((ref) => reference(ref, unit, input));
        lines.push(
          `- ${names} (${unit.kind === 'direct_group' ? 'direct group' : text(input.coverage.inventory.packet.changes.find((change) => unit.memberIds.includes(change.id))?.role ?? 'unknown')}): ${text(assessment.reason.text)} Policy: ${text(evaluation.effectiveCeiling)}. Evidence: ${evaluation.gaps.length ? 'partial' : 'complete'}. ${citations.join(' ')}`,
        );
      }
    }
  }
  appendAssessments();
  const assessments = lines.splice(0);
  function appendFollowups(): void {
    const assessedGaps = summary.units.flatMap((unit, index) =>
      input.records[index].assessment ? unit.gaps.map((gap) => ({ unit: units[index], gap })) : [],
    );
    const followups = input.records.flatMap(
      (record, index) =>
        record.assessment?.followups.map((followup) => ({ followup, unit: units[index] })) ?? [],
    );
    if (assessedGaps.length || followups.length) {
      lines.push('', '## Non-blocking follow-ups', '');
      for (const { unit, gap } of assessedGaps) lines.push(`- ${evidenceGap(unit, gap.sourceId)}`);
      for (const { unit, followup } of followups)
        lines.push(
          `- ${text(unit.members.map((member) => member.name).join(', '))}: ${text(followup.description)} ${followup.references.map((ref) => reference(ref, unit, input)).join(' ')}`,
        );
    }
  }
  appendFollowups();
  const requiredFollowups = lines.splice(0);
  const optional: string[][] = [];
  function appendCapabilities(): DecisionBriefResult | undefined {
    const capabilities = input.records.flatMap(
      (record, index) =>
        record.assessment?.newFunctionality.map((capability) => ({
          capability,
          unit: units[index],
        })) ?? [],
    );
    for (const [kind, heading] of [
      ['use_now', 'New capabilities to adopt now'],
      ['consider_later', 'Consider later'],
      ['not_relevant', 'Not relevant'],
    ] as const) {
      const entries = capabilities.filter(({ capability }) => capability.usefulness === kind);
      if (!entries.length) continue;
      if (kind === 'not_relevant')
        lines.push('', '<details>', '<summary>Not relevant</summary>', '');
      else lines.push('', `## ${heading}`, '');
      for (const { capability, unit } of entries) {
        if (unit.kind === 'direct_group' && capability.memberId !== unit.anchorId)
          return { ok: false, category: 'reference' };
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
        let context = '';
        if (capability.contextId && capability.contextPath)
          context = reference(
            {
              kind: 'context',
              contextId: capability.contextId,
              memberId: capability.memberId,
              path: capability.contextPath,
            },
            unit,
            input,
          );
        if (kind !== 'not_relevant' && (!capability.action || !context))
          return { ok: false, category: 'content' };
        lines.push(
          `- ${text(capability.feature)} ${capability.action ? text(capability.action) : ''} ${text(capability.rationale)} ${context} ${source}`,
        );
      }
      if (kind === 'not_relevant') lines.push('', '</details>');
      optional.push(lines.splice(0));
    }
    return undefined;
  }
  const appendCapabilitiesError = appendCapabilities();
  if (appendCapabilitiesError) return appendCapabilitiesError;
  function appendUnchecked(): DecisionBriefResult | undefined {
    const licenseFailures = input.signalAttempts.filter(
      (attempt) => attempt.category === 'license' && attempt.outcome !== 'available',
    );
    const unchecked = summary.units.flatMap((unit, index) =>
      unit.uncheckedSignals.map((signal) => ({ unit: units[index], signal })),
    );
    if (licenseFailures.length || unchecked.length) {
      lines.push('', '## Unchecked signals', '');
      for (const { unit, signal } of unchecked) {
        const link = unit.evidenceLinks.find((entry) => entry.id === signal.sourceId);
        const member = unit.members.find((entry) => entry.id === link?.memberId);
        if (!link || !member) return { ok: false, category: 'reference' };
        lines.push(
          `- ${text(member.name)} ${text(signal.signal)}: ${text(signal.reason)}; ${text(link.status)}.`,
        );
      }
      for (const attempt of licenseFailures) {
        const unit = units.find((candidate) => candidate.memberIds.includes(attempt.memberId));
        const member = unit?.members.find((candidate) => candidate.id === attempt.memberId);
        if (!member) return { ok: false, category: 'reference' };
        lines.push(
          `- License lookup for ${text(member.name)} (${text(attempt.side)}): ${attempt.reasons.map(text).join(', ') || 'not checked'}.`,
        );
      }
      optional.push(lines.splice(0));
    }
    return undefined;
  }
  const appendUncheckedError = appendUnchecked();
  if (appendUncheckedError) return appendUncheckedError;
  const sections = [assessments, ...optional];
  let omitted = false;
  for (let remaining = sections.length; remaining >= 0; remaining--) {
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
  return { ok: false, category: 'size' };
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
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(input.generatedAt) ||
      new Date(input.generatedAt).toISOString() !== input.generatedAt ||
      (input.reviewDigest !== undefined && !/^[a-f\d]{64}$/u.test(input.reviewDigest))
    )
      return { ok: false, category: 'input' };
    const { counts, inventoryGaps, outcome } = input.coverage;
    if (outcome.kind !== 'empty_inventory') return renderNonempty(input, binding);
    if (
      outcome.kind !== 'empty_inventory' ||
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
    const { owner, name } = binding.repository;
    const body = [
      '<!-- dependabot-intelligent-review -->',
      `<!-- reviewed-head: ${binding.headSha} -->`,
      ...(input.reviewDigest ? [`<!-- review-digest: ${input.reviewDigest} -->`] : []),
      '',
      `# Dependabot review: ${owner}/${name} PR ${binding.pullNumber}`,
      '',
      'No dependency changes to review.',
      '',
      '**Next action:** No dependency action is needed.',
      '',
      'Evidence coverage: complete; 0 changed updates, 0 assessed decision units, 0 unresolved decision units.',
      '',
      `Reviewed head: [${binding.headSha}](https://github.com/${owner}/${name}/commit/${binding.headSha})`,
      `Generated: ${input.generatedAt}`,
    ].join('\n');
    return body.length <= 50_000 ? { ok: true, body } : { ok: false, category: 'size' };
  } catch (error) {
    return { ok: false, category: error instanceof InvalidReference ? 'reference' : 'input' };
  }
}
