import { expect, test, vi } from 'vite-plus/test';
import {
  analysisDocument,
  analysisScenario,
  preparedAnalysis,
} from '../../tests/parity/analysis.js';
import { summarizeDecisionCoverage } from '../units.js';
import type { AssessmentState } from '../policy.js';
import {
  ANALYSIS_LIMITS,
  prepareAnalysisBatch,
  preparedSnapshot,
  type PreparedAnalysisBatch,
} from './contract.js';
import { analyzeMistralBatch, type MistralResult } from './mistral.js';

const options = { apiKey: 'SYNTHETIC_MODEL_KEY', deadlineMs: 1000 };
function response(batch: PreparedAnalysisBatch) {
  const snapshot = preparedSnapshot(batch)!;
  const document = analysisDocument(batch);
  for (const row of document.assessments) {
    const unit = snapshot.units.find((entry) => entry.alias === row.unitId)!;
    row.findingIds = snapshot.findings
      .filter((entry) => unit.value.findings.some((finding) => finding.id === entry.id))
      .map((entry) => entry.alias);
    const source = snapshot.sources.find(
      (entry) =>
        entry.value.provenance.kind === 'upstream' &&
        entry.value.status !== 'unavailable' &&
        entry.value.memberIds.some((id) => unit.value.memberIds.includes(id)),
    );
    if (!source || source.value.provenance.kind !== 'upstream') continue;
    const subject = source.value.provenance.subjects.find((entry) =>
      unit.value.memberIds.includes(entry.memberId),
    )!;
    const member = snapshot.members.find((entry) => entry.id === subject.memberId)!;
    const category = Object.entries(member.value.evidence).find(([, evidence]) =>
      evidence?.sourceIds.includes(source.id),
    )?.[0];
    if (category)
      row.reason.references = [
        {
          kind: 'source',
          sourceId: source.alias,
          memberId: member.alias,
          side: subject.side,
          category,
        },
      ];
  }
  return Response.json({
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(document) },
      },
    ],
  });
}
function states(results: readonly MistralResult[]): Record<string, AssessmentState> {
  return Object.fromEntries(
    results.flatMap<[string, AssessmentState]>((result) =>
      result.kind === 'validated'
        ? result.assessments.map((row) => [row.unitId, { state: 'assessed', verdict: row.verdict }])
        : ('unitIds' in result ? (result.unitIds ?? []) : []).map((id) => [
            id,
            {
              state: 'unavailable',
              reason: 'Analysis unavailable.',
              nextAction: 'Re-run analysis.',
              coverageLimits: [],
            },
          ]),
    ),
  );
}

test('actual mixed collectors and research retain groups, member evidence and independent coverage through the POST', async () => {
  const { batch, input } = await preparedAnalysis();
  const fetch = vi.fn(async () => response(batch));
  const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
  expect(result.kind).toBe('validated');
  if (result.kind !== 'validated') throw new Error('fixture analysis');
  const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  const wire = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
  expect(Object.keys(wire.coverage)).toEqual(['npm', 'actions', 'uv']);
  expect(new Set(wire.units.map((unit: { ecosystem: string }) => unit.ecosystem))).toEqual(
    new Set(['npm', 'actions', 'uv']),
  );
  expect(wire.units.some((unit: { kind: string }) => unit.kind === 'direct_group')).toBe(true);
  expect(wire.units.some((unit: { kind: string }) => unit.kind === 'standalone')).toBe(true);
  const refs = result.assessments.flatMap((row) => row.reason.references);
  expect(refs.length).toBeGreaterThan(0);
  for (const row of result.assessments) {
    const unit = input.inventory.units.find((entry) => entry.id === row.unitId)!;
    for (const ref of row.reason.references) {
      expect(unit.memberIds).toContain(ref.memberId);
      if (ref.kind === 'source')
        expect(
          input.inventory.packet.sources.find((source) => source.id === ref.sourceId)?.memberIds,
        ).toContain(ref.memberId);
    }
  }
  for (const id of [...batch.unitIds, ...input.inventory.packet.changes.map((change) => change.id)])
    expect(String(init.body)).not.toContain(id);
  expect(result).not.toHaveProperty('executionSuccess');
});

test('additions, removals, declarations and uv variants keep their exact original identities across independent batches', async () => {
  const { input } = await analysisScenario({
    inventory: { extras: true, declaration: true, uvVariants: true, missingPyPI: true },
  });
  const seen: string[] = [];
  expect(new Set(input.inventory.packet.changes.map((change) => change.kind))).toEqual(
    new Set(['update', 'addition', 'removal']),
  );
  for (const unit of input.inventory.units) {
    const prepared = prepareAnalysisBatch({
      ...input,
      unitIds: [unit.id],
      limits: ANALYSIS_LIMITS,
    });
    if (prepared.kind !== 'prepared') throw new Error('fixture preparation');
    const fetch = vi.fn(async () => response(prepared.batch));
    const result = await analyzeMistralBatch(prepared.batch, options, { fetch, now: () => 0 });
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') throw new Error('fixture validation');
    seen.push(...result.unitIds);
    expect(fetch).toHaveBeenCalledTimes(1);
    const wire = JSON.parse(prepared.batch.request.messages[1].content);
    expect(wire.units[0].members).toHaveLength(unit.memberCount);
    expect(wire.coverage).toHaveProperty('npm');
    expect(wire.coverage).toHaveProperty('actions');
    expect(wire.coverage).toHaveProperty('uv');
  }
  expect(seen).toEqual(input.unitIds);
  expect(
    input.inventory.packet.changes.some(
      (change) => 'basis' in change && change.basis === 'declaration',
    ),
  ).toBe(true);
});

test.each([false, true])(
  'a verified malware hold survives independent failed calls (all failed: %s)',
  async (allFailed) => {
    const { input } = await analysisScenario({ mode: 'malware' });
    const results: MistralResult[] = [];
    for (const [i, unit] of input.inventory.units.entries()) {
      const prepared = prepareAnalysisBatch({
        ...input,
        unitIds: [unit.id],
        limits: ANALYSIS_LIMITS,
      });
      if (prepared.kind !== 'prepared') throw new Error('fixture');
      results.push(
        await analyzeMistralBatch(prepared.batch, options, {
          fetch: async () =>
            allFailed || i > 0
              ? new Response('PRIVATE_ERROR_BODY', { status: 503 })
              : response(prepared.batch),
          now: () => 0,
        }),
      );
    }
    const coverage = summarizeDecisionCoverage(
      input.inventory,
      input.config,
      input.evaluatedAt,
      states(results),
    );
    if (!coverage.ok) throw new Error('coverage');
    expect(coverage.outcome).toEqual({ kind: 'advice', verdict: 'do_not_merge' });
    expect(coverage.counts.unresolvedUnits).toBe(
      allFailed ? input.unitIds.length : input.unitIds.length - 1,
    );
    expect(
      coverage.policyProvenance.assessments.units
        .flatMap((unit) => unit.findings)
        .some((finding) => finding.kind === 'malware'),
    ).toBe(true);
    expect(coverage).not.toHaveProperty('executionSuccess');
  },
);

test('ordinary evidence gaps and unavailable batches preserve an unresolved queue', async () => {
  const { input, batch } = await preparedAnalysis({ inventory: { missingPyPI: true } });
  const result = await analyzeMistralBatch(batch, options, {
    fetch: async () => new Response(null, { status: 429 }),
    now: () => 0,
  });
  const coverage = summarizeDecisionCoverage(
    input.inventory,
    input.config,
    input.evaluatedAt,
    states([result]),
  );
  if (!coverage.ok) throw new Error('coverage');
  expect(coverage.outcome).toEqual({ kind: 'decision_incomplete' });
  expect(coverage.counts.unresolvedUnits).toBe(input.unitIds.length);
});

test('a real Actions collector budget gap remains independent of successful npm and uv analysis', async () => {
  const { input, batch } = await preparedAnalysis({
    inventory: { partialActionsInventory: true, missingPyPI: true },
  });
  expect(input.inventory.packet.coverage.actions.status).not.toBe('complete');
  expect(input.inventory.packet.coverage.npm.status).toBe('complete');
  const result = await analyzeMistralBatch(batch, options, {
    fetch: async () => response(batch),
    now: () => 0,
  });
  expect(result.kind).toBe('validated');
  const wire = JSON.parse(batch.request.messages[1].content);
  expect(wire.coverage.actions).toMatchObject({
    status: input.inventory.packet.coverage.actions.status,
    reasons: input.inventory.packet.coverage.actions.reasons,
  });
  const coverage = summarizeDecisionCoverage(
    input.inventory,
    input.config,
    input.evaluatedAt,
    states([result]),
  );
  if (!coverage.ok) throw new Error('coverage');
  expect(coverage.inventoryGaps.map((gap) => gap.ecosystem)).toContain('actions');
  expect(coverage.outcome).toEqual({ kind: 'decision_incomplete' });
});

test('two in-flight responses keep their own snapshot even with identical wire aliases', async () => {
  const { batch: first } = await preparedAnalysis();
  const { batch: second } = await preparedAnalysis({ mode: 'malware' });
  let releaseFirst: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    releaseFirst = resolve;
  });
  const firstTask = analyzeMistralBatch(first, options, { fetch: () => pending, now: () => 0 });
  const secondResult = await analyzeMistralBatch(second, options, {
    fetch: async () => response(second),
    now: () => 0,
  });
  releaseFirst(response(first));
  const firstResult = await firstTask;
  expect(firstResult).toMatchObject({ kind: 'validated', batchId: first.batchId });
  expect(secondResult).toMatchObject({ kind: 'validated', batchId: second.batchId });
  expect(first.batchId).not.toBe(second.batchId);
});
