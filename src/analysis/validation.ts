import type { Verdict } from '../config.js';
import { freeze, isPlainObject } from '../evidence/common.js';
import type { DecisionUnit } from '../units.js';
import type { BatchSnapshot } from './projection.js';
import type { AnalysisCategory, AnalysisFailure } from './contract.js';

export type ResolvedReference =
  | Readonly<{
      kind: 'source';
      sourceId: string;
      memberId: string;
      side: 'base' | 'head';
      category: string;
      url: string | null;
    }>
  | Readonly<{ kind: 'context'; contextId: string; memberId: string; path: string }>;
export type Claim = Readonly<{ text: string; references: readonly ResolvedReference[] }>;
export type ValidatedBlocker = Readonly<{
  holdId: string;
  reason: string;
  impact: string;
  evidence: readonly Claim[];
  remediation: readonly string[];
  validation: readonly string[];
}>;
export type ValidatedFollowup = Readonly<{
  description: string;
  blocking: false;
  references: readonly ResolvedReference[];
}>;
export type ValidatedCapability = Readonly<{
  kind: 'new_capability';
  memberId: string;
  feature: string;
  sourceId: string;
  sourceUrl: string;
  usefulness: 'use_now' | 'consider_later' | 'not_relevant';
  action: string | null;
  contextId: string | null;
  contextPath: string | null;
  contextStatus: BatchSnapshot['inventory']['packet']['context']['status'];
  contextReasons: readonly string[];
  contextExcerptTruncated: boolean | null;
  rationale: string;
}>;
export type ValidatedAssessment = Readonly<{
  unitId: string;
  verdict: Verdict;
  reason: Claim;
  findingIds: readonly string[];
  blockers: readonly ValidatedBlocker[];
  followups: readonly ValidatedFollowup[];
  newFunctionality: readonly ValidatedCapability[];
}>;
export type AnalysisResult =
  | Readonly<{
      kind: 'validated';
      batchId: string;
      unitIds: readonly string[];
      assessments: readonly ValidatedAssessment[];
    }>
  | Readonly<{
      kind: 'failed';
      category: AnalysisCategory;
      attempted: true;
      batchId: string;
      unitIds: readonly string[];
    }>
  | AnalysisFailure;

export function rejectedAnalysis(
  snapshot: BatchSnapshot,
  category: AnalysisCategory,
): AnalysisResult {
  return freeze({
    kind: 'failed',
    category,
    attempted: true,
    batchId: snapshot.batchId,
    unitIds: snapshot.selected.map((unit) => unit.id),
  });
}

class ValidationError extends Error {
  constructor(readonly category: AnalysisCategory) {
    super(category);
  }
}
function check(value: unknown, category: AnalysisCategory = 'schema'): asserts value {
  if (!value) throw new ValidationError(category);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(isPlainObject(value));
  check(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
  );
  return value;
}
function list(value: unknown, limit: number): unknown[] {
  check(Array.isArray(value) && value.length <= limit);
  return value;
}
function text(value: unknown, bytes: number): string {
  check(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= bytes);
  return value;
}
function unique<T>(values: T[]): T[] {
  check(new Set(values.map((value) => JSON.stringify(value))).size === values.length, 'reference');
  return values;
}
type Scope = Readonly<{ snapshot: BatchSnapshot; unit: DecisionUnit }>;

function member(scope: Scope, alias: unknown) {
  const entry = scope.snapshot.members.find((item) => item.alias === alias);
  check(entry && scope.unit.memberIds.includes(entry.id), 'reference');
  return entry;
}
function sourceReference(
  value: unknown,
  scope: Scope,
): Extract<ResolvedReference, { kind: 'source' }> {
  const ref = object(value, ['kind', 'sourceId', 'memberId', 'side', 'category']);
  const change = member(scope, ref.memberId);
  const source = scope.snapshot.sources.find((entry) => entry.alias === ref.sourceId);
  check(
    source && source.value.memberIds.includes(change.id) && source.value.status !== 'unavailable',
    'reference',
  );
  check(ref.side === 'base' || ref.side === 'head', 'reference');
  const side = ref.side === 'base' ? change.value.from : change.value.to;
  check(side, 'reference');
  const category = text(ref.category, 128);
  const categorySources = change.value.evidence[category]?.sourceIds ?? [];
  const findingSource = scope.unit.findings.some(
    (finding) => finding.memberId === change.id && finding.references.includes(source.id),
  );
  const inventorySource = source.value.provenance.kind === 'file' && side.sourceId === source.id;
  check(
    categorySources.includes(source.id) ||
      (category === source.value.kind && (findingSource || inventorySource)),
    'reference',
  );
  const provenance = source.value.provenance;
  let url: string | null = null;
  if (provenance.kind === 'upstream') {
    const version = 'ref' in side ? side.ref : 'version' in side ? side.version : null;
    check(
      provenance.subjects.some(
        (subject) =>
          subject.memberId === change.id && subject.side === ref.side && subject.value === version,
      ),
      'reference',
    );
    url = provenance.url;
  } else {
    check(provenance.kind === 'file' && provenance.revision === ref.side, 'reference');
  }
  return {
    kind: 'source',
    sourceId: source.id,
    memberId: change.id,
    side: ref.side,
    category,
    url,
  };
}
function contextFact(value: unknown, scope: Scope) {
  const ref = object(value, ['kind', 'contextId', 'memberId']);
  const change = member(scope, ref.memberId);
  const fact = scope.snapshot.contexts.find((entry) => entry.alias === ref.contextId);
  check(
    fact &&
      fact.value.memberId === change.id &&
      ['available', 'partial'].includes(fact.value.status),
    'reference',
  );
  return fact;
}
function contextReference(
  value: unknown,
  scope: Scope,
): Extract<ResolvedReference, { kind: 'context' }> {
  const fact = contextFact(value, scope);
  return {
    kind: 'context',
    contextId: fact.id,
    memberId: fact.value.memberId,
    path: fact.value.path,
  };
}
function references(value: unknown, scope: Scope): ResolvedReference[] {
  return unique(
    list(value, scope.snapshot.limits.references).map((entry) => {
      check(isPlainObject(entry));
      if (entry.kind === 'source') return sourceReference(entry, scope);
      check(entry.kind === 'context', 'reference');
      return contextReference(entry, scope);
    }),
  );
}
function claim(value: unknown, scope: Scope): Claim {
  const entry = object(value, ['text', 'references']);
  return {
    text: text(entry.text, scope.snapshot.limits.textBytes),
    references: references(entry.references, scope),
  };
}
function steps(value: unknown, scope: Scope): string[] {
  const entries = list(value, scope.snapshot.limits.steps);
  check(entries.length > 0);
  return entries.map((entry) => text(entry, scope.snapshot.limits.textBytes));
}
function blocker(value: unknown, scope: Scope): ValidatedBlocker {
  const entry = object(value, [
    'holdId',
    'reason',
    'impact',
    'evidence',
    'remediation',
    'validation',
  ]);
  const hold = scope.snapshot.holds.find((item) => item.alias === entry.holdId);
  check(hold && hold.value.unitId === scope.unit.id, 'policy');
  const evidence = list(entry.evidence, scope.snapshot.limits.references).map((item) =>
    claim(item, scope),
  );
  const findingId = hold.value.trace.findingId;
  if (findingId) {
    const finding = scope.unit.findings.find((item) => item.id === findingId)!;
    check(
      evidence.some((item) =>
        item.references.some(
          (ref) =>
            ref.kind === 'source' &&
            ref.memberId === finding.memberId &&
            finding.references.includes(ref.sourceId),
        ),
      ),
      'reference',
    );
  } else {
    check(hold.value.trace.rule === 'incompleteEvidence' && hold.value.trace.sourceId, 'policy');
  }
  return {
    holdId: hold.id,
    reason: text(entry.reason, scope.snapshot.limits.textBytes),
    impact: text(entry.impact, scope.snapshot.limits.textBytes),
    evidence,
    remediation: steps(entry.remediation, scope),
    validation: steps(entry.validation, scope),
  };
}
function followup(value: unknown, scope: Scope): ValidatedFollowup {
  const entry = object(value, ['description', 'blocking', 'references']);
  check(entry.blocking === false);
  return {
    description: text(entry.description, scope.snapshot.limits.followupBytes),
    blocking: false,
    references: references(entry.references, scope),
  };
}

const verdictRanks = { merge: 0, merge_with_followups: 1, do_not_merge: 2 } as const;
function capability(value: unknown, scope: Scope): ValidatedCapability {
  const entry = object(value, [
    'kind',
    'memberId',
    'feature',
    'sourceId',
    'usefulness',
    'action',
    'contextId',
    'rationale',
  ]);
  check(entry.kind === 'new_capability');
  check(
    entry.usefulness === 'use_now' ||
      entry.usefulness === 'consider_later' ||
      entry.usefulness === 'not_relevant',
  );
  const change = member(scope, entry.memberId);
  check(scope.unit.kind !== 'direct_group' || scope.unit.anchorId === change.id, 'reference');
  const source = sourceReference(
    {
      kind: 'source',
      sourceId: entry.sourceId,
      memberId: entry.memberId,
      side: 'head',
      category: 'upstream',
    },
    scope,
  );
  check(source.url !== null, 'reference');
  const action = entry.action === null ? null : text(entry.action, scope.snapshot.limits.textBytes);
  const fact =
    entry.contextId === null
      ? null
      : contextFact(
          { kind: 'context', contextId: entry.contextId, memberId: entry.memberId },
          scope,
        );
  if (entry.usefulness !== 'not_relevant') check(action && fact, 'reference');
  const contextState = scope.snapshot.inventory.packet.context;
  const dependency = contextState.dependencies.find((item) => item.id === change.id);
  return {
    kind: 'new_capability',
    memberId: change.id,
    feature: text(entry.feature, scope.snapshot.limits.featureBytes),
    sourceId: source.sourceId,
    sourceUrl: source.url,
    usefulness: entry.usefulness,
    action,
    contextId: fact?.id ?? null,
    contextPath: fact?.value.path ?? null,
    contextStatus:
      dependency?.status ?? (contextState.status === 'disabled' ? 'disabled' : 'unavailable'),
    contextReasons: dependency?.reasons ?? contextState.reasons,
    contextExcerptTruncated: fact?.value.excerptTruncated ?? null,
    rationale: text(entry.rationale, scope.snapshot.limits.textBytes),
  };
}

function assessment(value: unknown, snapshot: BatchSnapshot): ValidatedAssessment {
  const entry = object(value, [
    'unitId',
    'verdict',
    'reason',
    'findingIds',
    'blockers',
    'followups',
    'newFunctionality',
  ]);
  const unit = snapshot.units.find((item) => item.alias === entry.unitId)?.value;
  check(unit, 'reference');
  const scope = { snapshot, unit };
  check(typeof entry.verdict === 'string' && Object.hasOwn(verdictRanks, entry.verdict));
  const verdict = entry.verdict as Verdict;
  const policy = snapshot.policy.units.find((item) => item.id === unit.id)!;
  check(verdictRanks[verdict] >= verdictRanks[policy.effectiveCeiling], 'policy');
  const findingIds = unique(
    list(entry.findingIds, snapshot.limits.references).map((alias) => {
      const finding = snapshot.findings.find((item) => item.alias === alias);
      check(finding && unit.findings.some((item) => item.id === finding.id), 'reference');
      return finding.id;
    }),
  );
  const blockers = list(entry.blockers, snapshot.limits.references).map((item) =>
    blocker(item, scope),
  );
  unique(blockers.map((item) => item.holdId));
  check(verdict === 'do_not_merge' ? blockers.length > 0 : blockers.length === 0, 'policy');
  const followups = list(entry.followups, snapshot.limits.steps).map((item) =>
    followup(item, scope),
  );
  check(
    verdict === 'merge_with_followups' ? followups.length > 0 : followups.length === 0,
    'policy',
  );
  const newFunctionality = list(entry.newFunctionality, 1).map((item) => capability(item, scope));
  return {
    unitId: unit.id,
    verdict,
    reason: claim(entry.reason, scope),
    findingIds,
    blockers,
    followups,
    newFunctionality,
  };
}

export function parseAssessments(value: unknown, snapshot: BatchSnapshot): AnalysisResult {
  try {
    const document = object(value, ['assessments']);
    const rows = list(document.assessments, snapshot.limits.maxUnits);
    check(rows.length === snapshot.selected.length, 'reference');
    const assessments = rows.map((row) => assessment(row, snapshot));
    unique(assessments.map((row) => row.unitId));
    return freeze({
      kind: 'validated',
      batchId: snapshot.batchId,
      unitIds: snapshot.selected.map((unit) => unit.id),
      assessments: snapshot.selected.map((unit) =>
        assessments.find((row) => row.unitId === unit.id)!,
      ),
    });
  } catch (error) {
    return rejectedAnalysis(snapshot, error instanceof ValidationError ? error.category : 'schema');
  }
}
