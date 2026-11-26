import { analyzeDecisionUnits } from '../../src/analysis/batches.js';
import {
  ANALYSIS_LIMITS,
  preparedSnapshot,
  type PreparedAnalysisBatch,
} from '../../src/analysis/contract.js';
import { analyzeMistralBatch } from '../../src/analysis/mistral.js';
import { validateReviewPacket, type ChangeEvidence } from '../../src/schema.js';
import { formDecisionUnits, type UnitInventory } from '../../src/units.js';
import { analysisDocument, analysisScenario } from './analysis.js';
import type { SignalScenarioOptions } from './policy-signals.js';

const CHILD_CATEGORIES = ['upstream', 'vulnerability', 'malware', 'installScript'];

export type LargeInventoryOptions = {
  members?: number;
  duplicateNames?: number;
  mode?: SignalScenarioOptions['mode'];
  /** `current` is the change's evidence for that category, or undefined when it has none. */
  evidence?: (
    memberIndex: number,
    category: string,
    current: ChangeEvidence | undefined,
  ) => ChangeEvidence | null;
  unresolved?: number;
  followups?: number;
  /** Follow-ups per merge_with_followups unit; the first uses followupText, the rest add ` (n)`. */
  followupsPerUnit?: number;
  followupText?: (index: number, name: string) => string;
  /** Each follow-up cites its unit's first member's lockfile source, alternating proposed and base. */
  followupCitations?: boolean;
};

type Packet = UnitInventory['packet'];
type Change = Packet['changes'][number];

function nameOf(change: Change) {
  const side = change.to ?? change.from;
  if (!side) throw new Error('large inventory change side');
  return 'name' in side ? side.name : side.action;
}

function isChild(change: Change) {
  return change.ecosystem === 'npm' && nameOf(change).startsWith('child-');
}

/**
 * Replaces child research categories before units form; null keeps the collected evidence.
 * Children from `incompleteFrom` onward also get an unavailable vulnerability unless the
 * caller supplied one, so their units are merge_with_followups and each needs one follow-up.
 */
function withEvidence(
  packet: Packet,
  evidence: NonNullable<LargeInventoryOptions['evidence']>,
  incompleteFrom: number,
) {
  let memberIndex = 0;
  const changes = packet.changes.map((change) => {
    if (!isChild(change)) return change;
    const replaced: Record<string, ChangeEvidence> = {};
    for (const category of CHILD_CATEGORIES) {
      const incomplete: ChangeEvidence | null =
        category === 'vulnerability' && memberIndex >= incompleteFrom
          ? { status: 'unavailable', reasons: ['budget'], sourceIds: [] }
          : null;
      const current = (change.evidence as Record<string, ChangeEvidence | undefined>)[category];
      const next = evidence(memberIndex, category, current) ?? incomplete;
      if (next && category in change.evidence) replaced[category] = next;
    }
    memberIndex++;
    return { ...change, evidence: { ...change.evidence, ...replaced } };
  });
  return { ...packet, changes };
}

/** A reference to one side's lockfile source of the unit's first member, in model aliases. */
function lockfileReference(
  snapshot: NonNullable<ReturnType<typeof preparedSnapshot>>,
  unit: { members: readonly { id: string }[] },
  side: 'base' | 'head',
) {
  const member = snapshot.members.find((entry) => entry.id === unit.members[0].id)!;
  const value = side === 'head' ? member.value.to : member.value.from;
  if (!value || !('sourceId' in value))
    throw new Error(`large inventory: member has no ${side} side`);
  const source = snapshot.sources.find((entry) => entry.id === value.sourceId)!;
  return {
    kind: 'source',
    sourceId: source.alias,
    memberId: member.alias,
    side,
    category: source.value.kind,
  };
}

function followupText(index: number, name: string) {
  return `Confirm the recorded evidence gap for ${name} (unit ${index}) with a fresh lookup, then rerun the dependency review before merging the pull request.`;
}

/** Cuts text to at most `bytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, bytes: number) {
  let out = '';
  let used = 0;
  for (const character of text) {
    used += Buffer.byteLength(character);
    if (used > bytes) break;
    out += character;
  }
  return out;
}

function completion(finishReason: 'stop' | 'length', content: string) {
  return Response.json({
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
  });
}

/**
 * Stub model: a batch whose units are all unresolved fails (HTTP 500); a batch with some
 * unresolved units asks for a split until each unresolved unit is alone. Every other batch
 * answers with the analysis document, giving each merge_with_followups unit one follow-up.
 */
function stubReply(
  batch: PreparedAnalysisBatch,
  state: {
    unresolved: Set<string>;
    order: Map<string, number>;
    names: Map<string, string>;
    followupText: (index: number, name: string) => string;
    followupsPerUnit: number;
    followupCitations: boolean;
  },
) {
  if (batch.unitIds.every((id) => state.unresolved.has(id)))
    return Response.json({}, { status: 500 });
  if (batch.unitIds.some((id) => state.unresolved.has(id))) return completion('length', '');
  const snapshot = preparedSnapshot(batch)!;
  const document = analysisDocument(batch);
  const assessments = document.assessments.map((entry) => {
    if (entry.verdict !== 'merge_with_followups') return entry;
    const unit = snapshot.units.find((item) => item.alias === entry.unitId)!;
    const base = state.followupText(state.order.get(unit.id)!, state.names.get(unit.id)!);
    const side = state.order.get(unit.id)! % 2 ? 'base' : 'head';
    const references = state.followupCitations
      ? [lockfileReference(snapshot, unit.value, side)]
      : [];
    const followups = Array.from({ length: state.followupsPerUnit }, (_, index) => ({
      description: truncateUtf8(
        index === 0 ? base : `${base} (${index + 1})`,
        ANALYSIS_LIMITS.followupBytes,
      ),
      blocking: false,
      references,
    }));
    return { ...entry, followups };
  });
  return completion('stop', JSON.stringify({ assessments }));
}

/**
 * Invented npm inventory through the real collectors and unit formation. Members are the
 * standalone children of an unchanged anchor, with nested same-named copies appended.
 * `unresolved` marks the first children unresolved; `followups` puts an incomplete-evidence
 * gap on the last children. Both are realized through the packet, not the renderer.
 */
export async function largeInventoryScenario(options: LargeInventoryOptions = {}) {
  const members = options.members ?? 93;
  const duplicateNames = options.duplicateNames ?? 2;
  const unresolved = options.unresolved ?? 0;
  const followups = options.followups ?? 0;
  const { scenario, input: base } = await analysisScenario({
    mode: options.mode,
    inventory: { children: members, anchorUnchanged: true, duplicateNames },
  });
  const childCount = base.inventory.packet.changes.filter(isChild).length;
  if (unresolved + followups > childCount)
    throw new Error('large inventory: unresolved and followups exceed the members');
  const edited = withEvidence(
    base.inventory.packet,
    options.evidence ?? (() => null),
    childCount - followups,
  );
  const validated = validateReviewPacket(edited, scenario.fixture.expected);
  if (!validated.ok) throw new Error('large inventory packet failed validation');
  const inventory = formDecisionUnits(validated.packet);
  const input = { ...base, inventory, unitIds: inventory.units.map((unit) => unit.id) };
  const childOrder = new Map(
    validated.packet.changes.filter(isChild).map((change, index) => [change.id, index]),
  );
  const state = {
    unresolved: new Set(
      inventory.units
        .filter((unit) => childOrder.get(unit.members[0].id)! < unresolved)
        .map((unit) => unit.id),
    ),
    order: new Map(inventory.units.map((unit, index) => [unit.id, index])),
    names: new Map(inventory.units.map((unit) => [unit.id, unit.members[0].name])),
    followupText: options.followupText ?? followupText,
    followupsPerUnit: options.followupsPerUnit ?? 1,
    followupCitations: options.followupCitations ?? false,
  };
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, call) =>
        analyzeMistralBatch(batch, call, {
          now: () => 0,
          fetch: async () => stubReply(batch, state),
        }),
    },
  );
  if (!analysis.ok) throw new Error('large inventory analysis failed');
  return {
    input,
    packet: validated.packet,
    analysis,
    render: {
      binding: inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: analysis.coverage,
      records: analysis.records,
      analysisUnavailable: analysis.analysisUnavailable,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    },
  };
}
