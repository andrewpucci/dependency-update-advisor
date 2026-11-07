import { parseReviewConfig } from '../../src/config.js';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSourceContext } from '../../src/context.js';
import { validateReviewPacket } from '../../src/schema.js';
import { formDecisionUnits } from '../../src/units.js';
import { policySignalScenario, type SignalScenarioOptions } from './policy-signals.js';
import {
  ANALYSIS_LIMITS,
  prepareAnalysisBatch,
  preparedSnapshot,
  type PreparedAnalysisBatch,
} from '../../src/analysis/contract.js';

/** Invented immutable inputs through actual collectors and T4/T5; no live services. */
export async function analysisScenario(options: SignalScenarioOptions = {}) {
  const scenario = await policySignalScenario(options);
  const config = parseReviewConfig(
    JSON.stringify({
      version: 1,
      analysis: { provider: 'mistral', model: 'synthetic-model' },
    }),
  );
  return {
    scenario,
    input: {
      inventory: scenario.units,
      config,
      evaluatedAt: Date.parse('2026-11-07T00:00:00Z'),
      unitIds: scenario.units.units.map((unit) => unit.id),
    },
  };
}

export async function preparedAnalysis(options: SignalScenarioOptions = {}) {
  const scenario = await analysisScenario(options);
  const result = prepareAnalysisBatch({ ...scenario.input, limits: ANALYSIS_LIMITS });
  if (result.kind !== 'prepared') throw new Error('synthetic analysis preparation failed');
  return { ...scenario, batch: result.batch };
}

export function analysisDocument(batch: PreparedAnalysisBatch) {
  const snapshot = preparedSnapshot(batch)!;
  return {
    assessments: snapshot.units.map((unit) => {
      const policy = snapshot.policy.units.find((entry) => entry.id === unit.id)!;
      const holds = snapshot.holds.filter((hold) => hold.value.unitId === unit.id);
      return {
        unitId: unit.alias,
        verdict: policy.effectiveCeiling,
        reason: {
          text: 'Retain the supplied evidence limits and policy result.',
          references: [] as unknown[],
        },
        findingIds: [] as string[],
        blockers: holds.slice(0, 1).map((hold) => ({
          holdId: hold.alias,
          reason: 'The supplied policy requires a hold.',
          impact: 'The proposed change needs remediation.',
          evidence: findingEvidence(snapshot, hold.value.trace.findingId),
          remediation: ['Resolve the named policy finding or evidence gap.'],
          validation: ['Re-run the dependency review.'],
        })),
        followups:
          policy.effectiveCeiling === 'merge_with_followups'
            ? [
                {
                  description: 'Resolve the recorded evidence limits and re-run the review.',
                  blocking: false,
                  references: [] as unknown[],
                },
              ]
            : [],
        newFunctionality: [] as unknown[],
      };
    }),
  };
}

function findingEvidence(
  snapshot: NonNullable<ReturnType<typeof preparedSnapshot>>,
  findingId?: string,
): unknown[] {
  if (!findingId) return [];
  const finding = snapshot.findings.find((entry) => entry.id === findingId)!.value;
  const source = snapshot.sources.find(
    (entry) => finding.references.includes(entry.id) && entry.value.provenance.kind === 'upstream',
  );
  const member = snapshot.members.find((entry) => entry.id === finding.memberId)!;
  if (!source || source.value.provenance.kind !== 'upstream')
    throw new Error('fixture finding source');
  const subject = source.value.provenance.subjects.find((entry) => entry.memberId === member.id)!;
  return [
    {
      text: 'The supplied finding cites this exact member and version.',
      references: [
        {
          kind: 'source',
          sourceId: source.alias,
          memberId: member.alias,
          side: subject.side,
          category: source.value.kind,
        },
      ],
    },
  ];
}

export async function analysisWithContext(
  mode: 'available' | 'disabled' | 'unmatched' | 'partial' = 'available',
) {
  const { input, scenario } = await analysisScenario();
  const root = await fs.mkdtemp(join(tmpdir(), 'analysis-context-'));
  try {
    await fs.mkdir(join(root, 'src'));
    const suffix = mode === 'partial' ? ' // ' + 'x'.repeat(800) : '';
    await fs.writeFile(
      join(root, 'src/usage.ts'),
      mode === 'unmatched'
        ? 'export const sentinel = 1;'
        : `import orbit from 'orbit';${suffix}\nimport child from 'child-0';\n`,
    );
    const config = parseReviewConfig(
      JSON.stringify({
        version: 1,
        analysis: { provider: 'mistral', model: 'synthetic-model' },
        context: { sendSourceExcerptsToModel: mode !== 'disabled', excerptFiles: ['src/usage.ts'] },
      }),
    );
    const context = await collectSourceContext({
      config,
      checkoutRoot: root,
      visibility: 'private',
      dependencies: input.inventory.packet.changes.map((change) => {
        const side = change.to ?? change.from!;
        return { id: change.id, name: 'name' in side ? side.name : side.action };
      }),
      trackedFiles: (async function* () {
        yield 'src/usage.ts';
      })(),
    });
    if (!context.ok) throw new Error('synthetic C2 failure');
    const expected = { ...scenario.fixture.expected, context };
    const packet = validateReviewPacket({ ...input.inventory.packet, context }, expected);
    if (!packet.ok) throw new Error('context packet validation');
    const prepared = prepareAnalysisBatch({
      ...input,
      config,
      inventory: formDecisionUnits(packet.packet),
      limits: ANALYSIS_LIMITS,
    });
    if (prepared.kind !== 'prepared') throw new Error('context preparation');
    return { batch: prepared.batch, context };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function capabilityDocument(batch: PreparedAnalysisBatch) {
  const snapshot = preparedSnapshot(batch)!;
  const unit = snapshot.units.find((entry) => entry.value.kind === 'direct_group')!;
  const member = snapshot.members.find((entry) => entry.id === unit.value.anchorId)!;
  const source = snapshot.sources.find(
    (entry) =>
      member.value.evidence.upstream.sourceIds.includes(entry.id) &&
      entry.value.provenance.kind === 'upstream' &&
      entry.value.provenance.subjects.some(
        (subject) => subject.memberId === member.id && subject.side === 'head',
      ),
  )!;
  const context = snapshot.contexts.find((entry) => entry.value.memberId === member.id);
  const feature = {
    kind: 'new_capability',
    memberId: member.alias,
    feature: 'A new opt-in workflow helper.',
    sourceId: source.alias,
    usefulness: 'use_now',
    action: 'Adopt the helper at the recorded existing import.',
    contextId: context?.alias ?? null,
    rationale: 'The existing package import supplies an immediate use case.',
  };
  const document = analysisDocument(batch);
  document.assessments.find((entry) => entry.unitId === unit.alias)!.newFunctionality = [feature];
  return { document, feature, unit, member, source, context };
}
