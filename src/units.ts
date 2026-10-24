import type { Ecosystem, EvidenceReason, PacketResult } from './schema.js';
import {
  evaluatePolicy,
  summarizePolicy,
  type EvidenceSource,
  type PolicyUnit,
  type PolicySummary,
  type AssessmentState,
} from './policy.js';
import type { Verdict } from './config.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
type Change = Packet['changes'][number];
export type GroupingReason =
  | 'independent_change'
  | 'actions_occurrence'
  | 'unknown_role'
  | 'inventory_incomplete'
  | 'multiple_direct_changes'
  | 'no_direct_change'
  | 'missing_relationship'
  | 'multiple_roots'
  | 'proven_relationship';
const reasonRanks = {
  permission: 0,
  rate_limit: 1,
  timeout: 2,
  missing: 3,
  malformed: 4,
  unsupported: 5,
  truncated: 6,
  budget: 7,
  conflict: 8,
  unknown: 9,
} satisfies Record<EvidenceReason, number>;
type OptionalSignal = NonNullable<EvidenceSource['signal']>;
const optionalSignals: readonly string[] = ['publishTime', 'deprecation', 'trust', 'publisher'];
export type EvidenceLink = Readonly<{
  id: string;
  memberId: string;
  category: string;
  status: string;
  sourceIds: readonly string[];
  reasons: readonly EvidenceReason[];
}>;
export type DecisionUnit = PolicyUnit &
  Readonly<{
    id: string;
    ecosystem: Ecosystem;
    kind: 'standalone' | 'direct_group';
    anchorId: string | null;
    memberIds: readonly string[];
    memberCount: number;
    proofKeys: readonly string[];
    relationship: Readonly<{ reason: GroupingReason; nextAction: string }>;
    evidenceLinks: readonly EvidenceLink[];
  }>;
export type UnitInventory = Readonly<{
  packet: Packet;
  units: readonly DecisionUnit[];
}>;
export type DecisionOutcome =
  | Readonly<{ kind: 'advice'; verdict: Verdict }>
  | Readonly<{ kind: 'decision_incomplete' | 'empty_inventory' }>;
export type InventoryGap = Readonly<{
  ecosystem: Ecosystem;
  status: 'partial' | 'unavailable';
  reasons: readonly EvidenceReason[];
  sourceIds: readonly string[];
  nextActions: readonly string[];
}>;
export type DecisionCoverage = Readonly<{
  ok: true;
  outcome: DecisionOutcome;
  inventory: UnitInventory;
  inventoryGaps: readonly InventoryGap[];
  counts: Readonly<{
    changedMembers: number;
    units: number;
    assessedUnits: number;
    unresolvedUnits: number;
    groupedUnits: number;
    standaloneUnits: number;
  }>;
  policyProvenance: Readonly<{ assessments: PolicySummary; withoutAssessments?: PolicySummary }>;
}>;

/** UTF-16 code-unit order, independent of locale. */
function byCodeUnit(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function unitId(
  packet: Packet,
  ecosystem: Ecosystem,
  kind: DecisionUnit['kind'],
  anchorId: string | null,
  memberIds: readonly string[],
) {
  const { repository, pullNumber, headSha } = packet.binding;
  return JSON.stringify([
    repository.id,
    repository.owner.toLowerCase(),
    repository.name.toLowerCase(),
    pullNumber,
    packet.baseSha,
    headSha,
    ecosystem,
    kind,
    anchorId,
    memberIds,
  ]);
}

function roots(change: Change): readonly string[] {
  return [
    ...new Set(
      [change.from, change.to].flatMap((side) => (side && 'root' in side ? [side.root] : [])),
    ),
  ];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
const actions: Record<GroupingReason, string> = {
  independent_change: 'Assess this change using its own evidence.',
  actions_occurrence: 'Assess this exact workflow occurrence using its own evidence.',
  unknown_role: 'Establish the dependency role or assess this change independently.',
  inventory_incomplete: 'Complete the ecosystem inventory; assess known changes independently.',
  multiple_direct_changes:
    'Assess this change independently; current proofs cannot establish a unique changed anchor.',
  no_direct_change: 'Assess this change independently; no changed direct anchor is established.',
  missing_relationship:
    'Obtain an applicable immutable lockfile path or assess this change independently.',
  multiple_roots:
    'Assess this root-moving change and related members independently; groups must stay within one root.',
  proven_relationship:
    'Assess the group without substituting anchor evidence for any member lookup.',
};
function projectMembers(
  packet: Packet,
  memberIds: readonly string[],
): Omit<PolicyUnit, 'id'> & { evidenceLinks: EvidenceLink[] } {
  const changes = memberIds.map((id) => packet.changes.find((c) => c.id === id)!);
  const evidenceLinks = changes.flatMap((c) =>
    Object.keys(c.evidence)
      .sort()
      .map((category) => {
        const entry = c.evidence[category];
        return {
          id: JSON.stringify([c.id, category]),
          memberId: c.id,
          category,
          status: entry.status,
          sourceIds: [...entry.sourceIds].sort(),
          reasons: [...entry.reasons].sort((a, b) => reasonRanks[a] - reasonRanks[b]),
        };
      }),
  );
  const sources = evidenceLinks.map((link) => ({
    id: link.id,
    status: link.status,
    reason: link.reasons[0] ?? '',
    coverageLimits: link.reasons.map((reason) =>
      JSON.stringify([link.memberId, link.category, link.status, reason]),
    ),
    ...(optionalSignals.includes(link.category) ? { signal: link.category as OptionalSignal } : {}),
  }));
  return {
    evidenceLinks,
    sources,
    members: changes.map((c) => {
      const side = c.to ?? c.from!;
      return {
        id: c.id,
        ecosystem: c.ecosystem,
        name: 'action' in side ? side.action : side.name,
        ...(c.from ? { currentVersion: 'ref' in c.from ? c.from.ref : c.from.version } : {}),
        ...(c.to ? { proposedVersion: 'ref' in c.to ? c.to.ref : c.to.version } : {}),
      };
    }),
    findings: packet.findings
      .filter((f) => memberIds.includes(f.memberId))
      .sort((a, b) => byCodeUnit(a.id, b.id)),
    coverageLimits: sources.flatMap((source) => source.coverageLimits),
  };
}
function grouping(
  packet: Packet,
  change: Change,
): { anchorId: string | null; reason: GroupingReason; proofKeys: string[] } {
  // ponytail: scans stay bounded by 128 changes and 256 proofs; index only if those packet caps grow.
  const standalone = (reason: GroupingReason) => ({ anchorId: null, reason, proofKeys: [] });
  if (change.ecosystem === 'actions') return standalone('actions_occurrence');
  if (change.role === 'unknown') return standalone('unknown_role');
  if (change.role === 'direct') return standalone('independent_change');
  if (packet.coverage[change.ecosystem].status !== 'complete')
    return standalone('inventory_incomplete');
  const side = change.kind === 'removal' ? 'base' : 'head';
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return standalone('missing_relationship');
  if (roots(change).length !== 1) return standalone('multiple_roots');
  const candidates = packet.changes.filter(
    (c) => c.ecosystem === change.ecosystem && roots(c).includes(instance.root),
  );
  if (candidates.some((c) => c.role === 'unknown')) return standalone('unknown_role');
  const anchors = candidates.filter((c) => c.role === 'direct');
  if (anchors.length !== 1)
    return standalone(anchors.length ? 'multiple_direct_changes' : 'no_direct_change');
  if (roots(anchors[0]).length !== 1) return standalone('multiple_roots');
  const proofs = packet.relationships.filter(
    (p) => p.fromId === anchors[0].id && p.toId === change.id && p.side === side,
  );
  if (!proofs.length) return standalone('missing_relationship');
  return {
    anchorId: anchors[0].id,
    reason: 'proven_relationship',
    proofKeys: proofs.map((p) => JSON.stringify(canonical(p))).sort(),
  };
}

/** Accepts only T4-validated packets from trusted orchestration; no validation or I/O occurs here.
 * IDs and ordering use canonical tuples and UTF-16 code-unit order. Returns a detached frozen snapshot.
 */
export function formDecisionUnits(input: Packet): UnitInventory {
  const packet = structuredClone(input);
  const assignments = new Map(packet.changes.map((c) => [c.id, grouping(packet, c)]));
  const groups = new Map<string, { members: string[]; proofs: string[] }>();
  for (const c of packet.changes) {
    const assignment = assignments.get(c.id)!;
    if (assignment.anchorId === null) continue;
    const group = groups.get(assignment.anchorId) ?? { members: [assignment.anchorId], proofs: [] };
    group.members.push(c.id);
    group.proofs.push(...assignment.proofKeys);
    groups.set(assignment.anchorId, group);
  }
  const units: DecisionUnit[] = packet.changes.flatMap((c) => {
    const assignment = assignments.get(c.id)!;
    if (assignment.anchorId !== null) return [];
    const group = groups.get(c.id),
      kind = group ? 'direct_group' : 'standalone';
    const memberIds = group ? group.members.sort() : [c.id];
    const anchorId = group ? c.id : null,
      reason = group ? 'proven_relationship' : assignment.reason;
    return [
      {
        ...projectMembers(packet, memberIds),
        id: unitId(packet, c.ecosystem, kind, anchorId, memberIds),
        ecosystem: c.ecosystem,
        kind,
        anchorId,
        memberIds,
        memberCount: memberIds.length,
        proofKeys: group ? group.proofs.sort() : [],
        relationship: { reason, nextAction: actions[reason] },
      },
    ];
  });
  units.sort((a, b) => byCodeUnit(a.id, b.id));
  return freeze({ packet, units });
}

/** Applies existing C3 rules using trusted config and caller-supplied epoch milliseconds.
 * Failed configuration returns C3's failure without an evaluation or fallback policy.
 */
export function evaluateUnitPolicy(
  inventory: UnitInventory,
  config: Parameters<typeof evaluatePolicy>[0],
  evaluatedAt: number,
) {
  return freeze(evaluatePolicy(config, inventory.units, evaluatedAt));
}

const recovery: Record<EvidenceReason, string> = {
  permission: 'Restore inventory read permission and re-run CI.',
  rate_limit: 'Re-run CI after the inventory request limit resets.',
  timeout: 'Re-run CI to retry the timed-out inventory read.',
  missing: 'Supply the missing immutable inventory input and re-run CI.',
  malformed: 'Correct the malformed inventory input or collector and re-run CI.',
  unsupported: 'Add reviewed support for the inventory format before re-running CI.',
  truncated: 'Collect all inventory pages and bounded inputs before re-running CI.',
  budget: 'Split the dependency PR or review the inventory budget before re-running CI.',
  conflict: 'Reconcile conflicting inventory sources and re-run CI.',
  unknown: 'Investigate the inventory failure and re-run CI.',
};

/** Accepts only M2/caller-validated states for this inventory and the same config/time used for analysis.
 * Omitted states argument means pre-analysis; an explicit empty map means missing post-analysis results.
 * The sole authoritative outcome is separate from nested C3 provenance and grants no execution success.
 */
export function summarizeDecisionCoverage(
  inventory: UnitInventory,
  config: Parameters<typeof evaluatePolicy>[0],
  evaluatedAt: number,
  states?: Readonly<Partial<Record<string, AssessmentState>>>,
): DecisionCoverage | Extract<ReturnType<typeof evaluatePolicy>, { ok: false }> {
  const evaluation = evaluateUnitPolicy(inventory, config, evaluatedAt);
  if (!evaluation.ok) return evaluation;
  const assessments = summarizePolicy(
    evaluation,
    states ??
      Object.fromEntries(
        inventory.units.map((unit) => [
          unit.id,
          {
            state: 'unattempted',
            reason: 'Analysis has not been attempted.',
            nextAction: 'Run analysis for this decision unit.',
            coverageLimits: [],
          },
        ]),
      ),
  );
  const inventoryGaps: InventoryGap[] = (['npm', 'actions', 'uv'] as const).flatMap((ecosystem) => {
    const coverage = inventory.packet.coverage[ecosystem];
    if (coverage.status !== 'partial' && coverage.status !== 'unavailable') return [];
    const reasons = [...coverage.reasons].sort((a, b) => reasonRanks[a] - reasonRanks[b]);
    return [
      {
        ecosystem,
        status: coverage.status,
        reasons,
        sourceIds: [...coverage.sourceIds].sort(),
        nextActions: reasons.map((reason) => `${ecosystem}: ${recovery[reason]}`),
      },
    ];
  });
  const withoutAssessments = inventoryGaps.length ? summarizePolicy(evaluation, {}) : undefined;
  const decision = withoutAssessments?.decision ?? assessments.decision;
  let outcome: DecisionOutcome;
  if (inventoryGaps.length)
    outcome =
      decision === 'do_not_merge'
        ? { kind: 'advice', verdict: decision }
        : { kind: 'decision_incomplete' };
  else if (!inventory.units.length) outcome = { kind: 'empty_inventory' };
  else
    outcome =
      decision === 'decision_incomplete'
        ? { kind: 'decision_incomplete' }
        : { kind: 'advice', verdict: decision };
  return freeze({
    ok: true,
    outcome,
    inventory: structuredClone(inventory),
    inventoryGaps,
    counts: {
      changedMembers: inventory.packet.changes.length,
      units: inventory.units.length,
      assessedUnits: inventory.units.length - assessments.unresolvedUnits.length,
      unresolvedUnits: assessments.unresolvedUnits.length,
      groupedUnits: inventory.units.filter((unit) => unit.kind === 'direct_group').length,
      standaloneUnits: inventory.units.filter((unit) => unit.kind === 'standalone').length,
    },
    policyProvenance: { assessments, ...(withoutAssessments ? { withoutAssessments } : {}) },
  });
}
