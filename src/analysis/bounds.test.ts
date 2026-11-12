import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits } from '../units.js';
import { expect, test } from 'vite-plus/test';
import {
  analysisDocument,
  analysisScenario,
  analysisWithContext,
  capabilityDocument,
  preparedAnalysis,
} from '../../tests/parity/analysis.js';
import {
  ANALYSIS_LIMITS,
  prepareAnalysisBatch,
  preparedSnapshot,
  receiveAnalysisReply,
  validateAnalysisReply,
  type PreparedAnalysisBatch,
} from './contract.js';

function sized(bytes: number, character: string) {
  const count = Math.floor((bytes - 1) / Buffer.byteLength(character));
  return (
    'A' + character.repeat(count) + 'a'.repeat(bytes - 1 - count * Buffer.byteLength(character))
  );
}
async function validate(batch: PreparedAnalysisBatch, document: unknown) {
  return validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document));
}

test.each(['x', 'é', '🙂', '"', '\n'])(
  'reason text counts UTF-8 bytes at the exact boundary for %j',
  async (character) => {
    const { batch } = await preparedAnalysis();
    const document = analysisDocument(batch);
    document.assessments[0].reason.text = sized(ANALYSIS_LIMITS.textBytes, character);
    expect((await validate(batch, document)).kind).toBe('validated');
    document.assessments[0].reason.text += 'a';
    expect((await validate(batch, document)).kind).toBe('failed');
  },
);

test('blocker text, evidence claims and remediation/validation lists preserve their exact limits', async () => {
  const { batch } = await preparedAnalysis({ mode: 'malware' });
  const document = analysisDocument(batch);
  const row = document.assessments.find((entry) => entry.blockers.length)!;
  const blocker = row.blockers[0];
  blocker.reason = sized(1024, '🙂');
  blocker.impact = sized(1024, 'é');
  blocker.remediation = Array.from({ length: 8 }, () => sized(1024, '"'));
  blocker.validation = Array.from({ length: 8 }, () => sized(1024, '\n'));
  blocker.evidence = Array.from({ length: 32 }, () => structuredClone(blocker.evidence[0]));
  expect((await validate(batch, document)).kind).toBe('validated');
  for (const field of ['reason', 'impact'] as const) {
    blocker[field] += 'a';
    expect((await validate(batch, document)).kind).toBe('failed');
    blocker[field] = blocker[field].slice(0, -1);
  }
  for (const field of ['remediation', 'validation'] as const) {
    blocker[field].push('extra');
    expect((await validate(batch, document)).kind).toBe('failed');
    blocker[field].pop();
    blocker[field][0] += 'a';
    expect((await validate(batch, document)).kind).toBe('failed');
    blocker[field][0] = blocker[field][0].slice(0, -1);
  }
  blocker.evidence.push(structuredClone(blocker.evidence[0]));
  expect((await validate(batch, document)).kind).toBe('failed');
});

test('follow-up descriptions and list lengths accept the byte ceiling and reject overflow', async () => {
  const { batch } = await preparedAnalysis();
  const document = analysisDocument(batch);
  const row = document.assessments[0];
  row.verdict = 'merge_with_followups';
  row.followups = Array.from({ length: 8 }, () => ({
    description: sized(280, '🙂'),
    blocking: false as const,
    references: [],
  }));
  expect((await validate(batch, document)).kind).toBe('validated');
  row.followups[0].description += 'a';
  expect((await validate(batch, document)).kind).toBe('failed');
  row.followups[0].description = sized(280, '🙂');
  row.followups.push({ description: 'extra', blocking: false, references: [] });
  expect((await validate(batch, document)).kind).toBe('failed');
});

test('references obey a lower caller ceiling without confusing distinct sources with duplicates', async () => {
  const { input } = await analysisScenario();
  const ready = prepareAnalysisBatch({ ...input, limits: { ...ANALYSIS_LIMITS, references: 1 } });
  if (ready.kind !== 'prepared') throw new Error('fixture');
  const snapshot = preparedSnapshot(ready.batch)!;
  const unit = snapshot.units.find(
    (entry) => entry.value.kind === 'direct_group' && entry.value.ecosystem === 'npm',
  )!;
  const refs = snapshot.members
    .filter((member) => unit.value.memberIds.includes(member.id))
    .flatMap((member) =>
      snapshot.sources.flatMap((source) => {
        if (
          source.value.provenance.kind !== 'upstream' ||
          !member.value.evidence.upstream.sourceIds.includes(source.id)
        )
          return [];
        return source.value.provenance.subjects
          .filter((subject) => subject.memberId === member.id)
          .map((subject) => ({
            kind: 'source',
            sourceId: source.alias,
            memberId: member.alias,
            side: subject.side,
            category: 'upstream',
          }));
      }),
    );
  expect(refs.length).toBeGreaterThan(1);
  const document = analysisDocument(ready.batch);
  const row = document.assessments.find((entry) => entry.unitId === unit.alias)!;
  row.reason.references = refs.slice(0, 1);
  expect((await validate(ready.batch, document)).kind).toBe('validated');
  row.reason.references = refs.slice(0, 2);
  expect((await validate(ready.batch, document)).kind).toBe('failed');
});

test('capability feature, action and rationale use their own byte ceilings', async () => {
  const { batch } = await analysisWithContext();
  const { document, feature } = capabilityDocument(batch);
  feature.feature = sized(512, '🙂');
  feature.action = sized(1024, 'é');
  feature.rationale = sized(1024, '"');
  expect((await validate(batch, document)).kind).toBe('validated');
  for (const field of ['feature', 'action', 'rationale'] as const) {
    feature[field] += 'a';
    expect((await validate(batch, document)).kind).toBe('failed');
    feature[field] = feature[field].slice(0, -1);
  }
});

test('exact attributable unit bytes retain every required record or reject the whole unit', async () => {
  const { input } = await analysisScenario();
  const ready = prepareAnalysisBatch({
    ...input,
    unitIds: [input.unitIds[0]],
    limits: ANALYSIS_LIMITS,
  });
  if (ready.kind !== 'prepared') throw new Error('fixture');
  const wire = JSON.parse(ready.batch.request.messages[1].content);
  const unit = wire.units[0];
  const own = {
    unit,
    sources: wire.sources.filter((source: { memberIds: string[] }) =>
      source.memberIds.some((id) => unit.memberIds.includes(id)),
    ),
    contexts: wire.context.facts,
    contextStates: wire.context.dependencies,
    findings: wire.findings,
  };
  const unitBytes = Buffer.byteLength(JSON.stringify(own));
  const exact = prepareAnalysisBatch({
    ...input,
    unitIds: [input.unitIds[0]],
    limits: { ...ANALYSIS_LIMITS, unitBytes },
  });
  expect(exact.kind).toBe('prepared');
  if (exact.kind !== 'prepared') throw new Error('fixture');
  expect(exact.batch.request).toEqual(ready.batch.request);
  expect(
    prepareAnalysisBatch({
      ...input,
      unitIds: [input.unitIds[0]],
      limits: { ...ANALYSIS_LIMITS, unitBytes: unitBytes - 1 },
    }),
  ).toEqual({ kind: 'invalid', attempted: false, category: 'budget' });
});

test('every declared resource limit rejects larger, unsafe, fractional and incompatible values before a usable handle', async () => {
  const { input } = await analysisScenario();
  for (const [key, ceiling] of Object.entries(ANALYSIS_LIMITS)) {
    for (const value of [ceiling + 1, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const result = prepareAnalysisBatch({
        ...input,
        limits: { ...ANALYSIS_LIMITS, [key]: value },
      });
      expect(result.kind).toBe('invalid');
      expect(result).not.toHaveProperty('batch');
    }
  }
  expect(
    prepareAnalysisBatch({
      ...input,
      limits: { ...ANALYSIS_LIMITS, responseBytes: ANALYSIS_LIMITS.responseBytes - 1 },
    }).kind,
  ).toBe('invalid');
  const lower = prepareAnalysisBatch({
    ...input,
    limits: { ...ANALYSIS_LIMITS, completionTokens: 1, responseBytes: 128 * 6 + 65536 },
  });
  expect(lower.kind).toBe('prepared');
  if (lower.kind !== 'prepared') throw new Error('fixture');
  expect(lower.batch.request.max_tokens).toBe(1);
});

test('a shared vetted URL cannot lend one member the other member’s source alias', async () => {
  const { input, scenario } = await analysisScenario();
  const candidate = {
    ...input.inventory.packet,
    sources: input.inventory.packet.sources.map((source) =>
      source.provenance.kind === 'upstream'
        ? {
            ...source,
            provenance: {
              ...source.provenance,
              url: 'https://github.com/fixture/shared/releases/tag/v2',
            },
          }
        : source,
    ),
  };
  const accepted = validateReviewPacket(candidate, scenario.fixture.expected);
  if (!accepted.ok) throw new Error('fixture packet');
  const prepared = prepareAnalysisBatch({
    ...input,
    inventory: formDecisionUnits(accepted.packet),
    limits: ANALYSIS_LIMITS,
  });
  if (prepared.kind !== 'prepared') throw new Error('fixture preparation');
  const batch = prepared.batch,
    snapshot = preparedSnapshot(batch)!;
  const unit = snapshot.units.find(
    (entry) => entry.value.ecosystem === 'npm' && entry.value.kind === 'direct_group',
  )!;
  const members = snapshot.members.filter((entry) => unit.value.memberIds.includes(entry.id));
  const sources = members.map((member) =>
    snapshot.sources.find(
      (entry) =>
        member.value.evidence.upstream.sourceIds.includes(entry.id) &&
        entry.value.provenance.kind === 'upstream' &&
        entry.value.provenance.subjects.some(
          (subject) => subject.memberId === member.id && subject.side === 'head',
        ),
    )!,
  );
  const document = analysisDocument(batch);
  const row = document.assessments.find((entry) => entry.unitId === unit.alias)!;
  const ref = {
    kind: 'source',
    sourceId: sources[0].alias,
    memberId: members[0].alias,
    side: 'head',
    category: 'upstream',
  };
  row.reason.references = [ref];
  expect((await validate(batch, document)).kind).toBe('validated');
  ref.sourceId = sources[1].alias;
  expect((await validate(batch, document)).kind).toBe('failed');
});

test('budgets fit a reasoning-model reply and keep the response ceiling tied to the formula', () => {
  // Observed 2026-11-12: reasoning replies used 4.1k-8.0k completion tokens and took 58-101 s.
  expect(ANALYSIS_LIMITS).toMatchObject({
    completionTokens: 16_384,
    requestTimeoutMs: 240_000,
    responseBytes: 12_648_448,
  });
  expect(ANALYSIS_LIMITS.responseBytes).toBe(ANALYSIS_LIMITS.completionTokens * 128 * 6 + 65_536);
  // Every input bound is unchanged.
  expect(ANALYSIS_LIMITS).toMatchObject({
    maxUnits: 8,
    sourceBytes: 2_048,
    unitBytes: 65_536,
    requestBytes: 262_144,
  });
});

test('the old response ceiling is too small for the new completion budget', async () => {
  const { input } = await analysisScenario();
  const result = prepareAnalysisBatch({
    ...input,
    limits: { ...ANALYSIS_LIMITS, responseBytes: 3_211_264 },
  });
  expect(result.kind).toBe('invalid');
});
