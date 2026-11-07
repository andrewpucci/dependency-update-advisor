import { parseReviewConfig } from '../../src/config.js';
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
