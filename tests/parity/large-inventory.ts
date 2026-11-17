import { analyzeDecisionUnits } from '../../src/analysis/batches.js';
import { preparedSnapshot, type PreparedAnalysisBatch } from '../../src/analysis/contract.js';
import { analyzeMistralBatch } from '../../src/analysis/mistral.js';
import { validateReviewPacket, type ChangeEvidence } from '../../src/schema.js';
import { formDecisionUnits, type UnitInventory } from '../../src/units.js';
import { analysisDocument, analysisScenario } from './analysis.js';

const CHILD_CATEGORIES = ['upstream', 'vulnerability', 'malware', 'installScript'];

export type LargeInventoryOptions = {
  members?: number;
  duplicateNames?: number;
  evidence?: (memberIndex: number, category: string) => ChangeEvidence | null;
  unresolved?: number;
  followups?: number;
  followupText?: (index: number, name: string) => string;
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
      const next = evidence(memberIndex, category) ?? incomplete;
      if (next && category in change.evidence) replaced[category] = next;
    }
    memberIndex++;
    return { ...change, evidence: { ...change.evidence, ...replaced } };
  });
  return { ...packet, changes };
}

function followupText(index: number, name: string) {
  return `Confirm the recorded evidence gap for ${name} (unit ${index}) with a fresh lookup, then rerun the dependency review before merging the pull request.`;
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
    const description = state.followupText(state.order.get(unit.id)!, state.names.get(unit.id)!);
    return { ...entry, followups: [{ description, blocking: false, references: [] }] };
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
