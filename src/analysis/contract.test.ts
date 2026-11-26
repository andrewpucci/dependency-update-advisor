import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vite-plus/test';
import {
  analysisDocument,
  analysisScenario,
  preparedAnalysis,
} from '../../tests/parity/analysis.js';
import { parseReviewConfig } from '../config.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits } from '../units.js';
import {
  receiveAnalysisReply,
  validateAnalysisReply,
  preparedSnapshot,
  prepareAnalysisBatch,
  prepareAnalysisRun,
  prepareRunBatch,
  ANALYSIS_LIMITS,
  type PreparedAnalysisBatch,
} from './contract.js';

function attributedSource(batch: PreparedAnalysisBatch) {
  const snapshot = preparedSnapshot(batch)!;
  for (const unit of snapshot.units.filter((entry) => entry.value.memberCount > 1)) {
    for (const member of snapshot.members.filter((entry) =>
      unit.value.memberIds.includes(entry.id),
    )) {
      const source = snapshot.sources.find(
        (entry) =>
          member.value.evidence.upstream?.sourceIds.includes(entry.id) &&
          entry.value.status === 'available' &&
          entry.value.provenance.kind === 'upstream' &&
          entry.value.provenance.subjects.some(
            (subject) => subject.memberId === member.id && subject.side === 'head',
          ),
      );
      if (source)
        return {
          unit,
          source,
          member,
          ref: {
            kind: 'source',
            sourceId: source.alias,
            memberId: member.alias,
            side: 'head',
            category: 'upstream',
          },
        };
    }
  }
  throw new Error('fixture needs attributable grouped upstream evidence');
}

test('accepts complete aliased assessments and restores exact T5 ordering and identities', async () => {
  const { batch } = await preparedAnalysis();
  const document = analysisDocument(batch);
  document.assessments.reverse();
  const reply = await receiveAnalysisReply(batch, async () => document);
  const result = validateAnalysisReply(batch, reply);
  expect(result.kind).toBe('validated');
  if (result.kind !== 'validated') throw new Error('validation');
  expect(result.batchId).toBe(batch.batchId);
  expect(result.assessments.map((assessment) => assessment.unitId)).toEqual(batch.unitIds);
  expect(Object.isFrozen(result.assessments)).toBe(true);
});

test('rejects a reply bound to another genuine snapshot even when aliases have equal counts', async () => {
  const first = await preparedAnalysis(),
    second = await preparedAnalysis({ mode: 'recent' });
  expect(first.batch.unitIds.length).toBe(second.batch.unitIds.length);
  const reply = await receiveAnalysisReply(first.batch, async () => analysisDocument(first.batch));
  expect(validateAnalysisReply(second.batch, reply)).toMatchObject({
    kind: 'failed',
    category: 'reference',
    batchId: second.batch.batchId,
    unitIds: second.batch.unitIds,
  });
  expect(validateAnalysisReply(first.batch, { ...reply })).toMatchObject({
    kind: 'failed',
    category: 'reference',
  });
});

test('an unowned batch cannot invoke a receive callback or claim a request attempt', async () => {
  const { batch } = await preparedAnalysis();
  const fake = { ...batch };
  const receive = vi.fn(async () => analysisDocument(batch));
  const reply = await receiveAnalysisReply(fake, receive);
  expect(receive).not.toHaveBeenCalled();
  expect(validateAnalysisReply(fake, reply)).toMatchObject({ kind: 'invalid', attempted: false });
});

test('rejects missing, duplicate, unknown and extra fields without retaining partial results', async () => {
  const { batch } = await preparedAnalysis();
  const source = analysisDocument(batch);
  const candidates = [
    { assessments: source.assessments.slice(1) },
    { assessments: [source.assessments[0], ...source.assessments] },
    {
      assessments: source.assessments.map((entry, i) =>
        i ? entry : { ...entry, unitId: 'unknown' },
      ),
    },
    { ...source, verdict: 'merge' },
    {
      assessments: source.assessments.map((entry, i) =>
        i ? entry : { ...entry, surprise: 'SENTINEL' },
      ),
    },
  ];
  for (const value of candidates) {
    const result = validateAnalysisReply(
      batch,
      await receiveAnalysisReply(batch, async () => value),
    );
    expect(result.kind).toBe('failed');
    expect(result).not.toHaveProperty('assessments');
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  }
});

test('rejects a verdict above the internally evaluated ceiling without clamping it', async () => {
  const { batch } = await preparedAnalysis({ mode: 'recent' });
  const document = analysisDocument(batch);
  const snapshot = preparedSnapshot(batch)!;
  const index = snapshot.units.findIndex(
    (unit) =>
      snapshot.policy.units.find((entry) => entry.id === unit.id)!.effectiveCeiling !== 'merge',
  );
  expect(index).toBeGreaterThanOrEqual(0);
  document.assessments[index].verdict = 'merge';
  document.assessments[index].followups = [];
  document.assessments[index].blockers = [];
  expect(
    validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)),
  ).toMatchObject({ kind: 'failed', category: 'policy' });
});

test('accepts only member-side-category source attribution, even within one group', async () => {
  const { batch } = await preparedAnalysis();
  const example = attributedSource(batch);
  const document = analysisDocument(batch);
  const assessment = document.assessments.find((row) => row.unitId === example.unit.alias)!;
  assessment.reason.references = [example.ref];
  const valid = validateAnalysisReply(
    batch,
    await receiveAnalysisReply(batch, async () => document),
  );
  expect(valid.kind).toBe('validated');
  if (valid.kind !== 'validated') throw new Error('validation');
  expect(
    valid.assessments.find((row) => row.unitId === example.unit.id)!.reason.references[0],
  ).toMatchObject({ sourceId: example.source.id, memberId: example.member.id });
  const otherMember = preparedSnapshot(batch)!.members.find(
    (member) =>
      example.unit.value.memberIds.includes(member.id) &&
      !example.source.value.memberIds.includes(member.id),
  )!;
  expect(otherMember).toBeDefined();
  for (const ref of [
    { ...example.ref, memberId: otherMember.alias },
    { ...example.ref, side: 'base' },
    { ...example.ref, category: 'invented' },
    { ...example.ref, sourceId: 'sunknown' },
    { ...example.ref, url: 'https://example.invalid/invented' },
  ]) {
    assessment.reason.references = [ref];
    expect(
      validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)),
    ).toMatchObject({ kind: 'failed' });
  }
});

test('requires distinct effective holds and their actual finding evidence for do_not_merge', async () => {
  const { batch } = await preparedAnalysis({ mode: 'malware' });
  const document = analysisDocument(batch);
  const index = document.assessments.findIndex((entry) => entry.verdict === 'do_not_merge');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(
    validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)).kind,
  ).toBe('validated');
  for (const blockers of [
    [],
    [...document.assessments[index].blockers, ...document.assessments[index].blockers],
    [{ ...document.assessments[index].blockers[0], holdId: 'hunknown' }],
    [{ ...document.assessments[index].blockers[0], evidence: [] }],
  ]) {
    const candidate = structuredClone(document);
    candidate.assessments[index].blockers = blockers;
    expect(
      validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => candidate)).kind,
    ).toBe('failed');
  }
});

test('a coverage-rule hold can name its actual gap without inventing an available source', async () => {
  const { input } = await analysisScenario({ mode: 'malware-failed' });
  const config = parseReviewConfig(
    JSON.stringify({
      version: 1,
      analysis: { provider: 'mistral', model: 'synthetic-model' },
      policy: { verdicts: { incompleteEvidence: 'do_not_merge' } },
    }),
  );
  const ready = prepareAnalysisBatch({ ...input, config, limits: ANALYSIS_LIMITS });
  if (ready.kind !== 'prepared') throw new Error('preparation');
  const document = analysisDocument(ready.batch);
  expect(document.assessments.some((entry) => entry.verdict === 'do_not_merge')).toBe(true);
  expect(
    validateAnalysisReply(
      ready.batch,
      await receiveAnalysisReply(ready.batch, async () => document),
    ).kind,
  ).toBe('validated');
});

test('rejects invented findings, unsupported holds and invalid follow-up combinations', async () => {
  const { batch } = await preparedAnalysis();
  const document = analysisDocument(batch);
  const candidates = [
    { ...document.assessments[0], findingIds: ['funknown'] },
    { ...document.assessments[0], verdict: 'do_not_merge', blockers: [] },
    { ...document.assessments[0], verdict: 'merge_with_followups', followups: [] },
    {
      ...document.assessments[0],
      verdict: 'merge_with_followups',
      followups: [{ description: 'Action', blocking: true, references: [] }],
    },
  ];
  for (const entry of candidates) {
    const value = { assessments: [entry, ...document.assessments.slice(1)] };
    expect(
      validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => value)).kind,
    ).toBe('failed');
  }
});

test('captures detached reply data and refuses nested accessors without executing them', async () => {
  const { batch } = await preparedAnalysis();
  const document = analysisDocument(batch);
  const reply = await receiveAnalysisReply(batch, async () => document);
  document.assessments[0].unitId = 'changed';
  expect(validateAnalysisReply(batch, reply).kind).toBe('validated');
  const getter = vi.fn(() => 'RAW_MODEL_SENTINEL');
  Object.defineProperty(document.assessments[0].reason, 'text', { get: getter, enumerable: true });
  const rejected = validateAnalysisReply(
    batch,
    await receiveAnalysisReply(batch, async () => document),
  );
  expect(rejected.kind).toBe('failed');
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.stringify(rejected)).not.toContain('RAW_MODEL_SENTINEL');
});

test('permits exact immutable inventory-file references without requiring an upstream finding', async () => {
  const { input, scenario } = await analysisScenario();
  const packet = validateReviewPacket(
    { ...input.inventory.packet, findings: [] },
    scenario.fixture.expected,
  );
  if (!packet.ok) throw new Error('fixture packet');
  const ready = prepareAnalysisBatch({
    ...input,
    inventory: formDecisionUnits(packet.packet),
    limits: ANALYSIS_LIMITS,
  });
  if (ready.kind !== 'prepared') throw new Error('preparation');
  const batch = ready.batch;
  const snapshot = preparedSnapshot(batch)!;
  const member = snapshot.members.find((entry) => entry.value.ecosystem === 'npm')!;
  const unit = snapshot.units.find((entry) => entry.value.memberIds.includes(member.id))!;
  const source = snapshot.sources.find((entry) => entry.id === member.value.to?.sourceId)!;
  const document = analysisDocument(batch);
  document.assessments.find((entry) => entry.unitId === unit.alias)!.reason.references = [
    {
      kind: 'source',
      sourceId: source.alias,
      memberId: member.alias,
      side: 'head',
      category: source.value.kind,
    },
  ];
  expect(
    validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)).kind,
  ).toBe('validated');
});

test('the retry time never reaches the model request', async () => {
  const { input } = await analysisScenario();
  const retried = {
    ...input,
    inventory: {
      ...input.inventory,
      packet: { ...input.inventory.packet, retryAfter: '2026-11-21T00:01:00Z' },
    },
  };
  const plain = prepareAnalysisBatch({ ...input, limits: ANALYSIS_LIMITS });
  const timed = prepareAnalysisBatch({ ...retried, limits: ANALYSIS_LIMITS });
  if (plain.kind !== 'prepared' || timed.kind !== 'prepared') throw new Error('fixture failed');
  expect(JSON.stringify(timed.batch.request)).not.toContain('retryAfter');
  expect(JSON.stringify(timed.batch.request)).not.toContain('2026-11-21T00:01:00Z');
  expect(timed.batch.request).toEqual(plain.batch.request);
});

test('batch identity and request bytes stay pinned for fixed selections', async () => {
  const { input } = await analysisScenario();
  const [a, b, c] = input.unitIds;
  const pinned = [
    [
      [a, b, c],
      'b785cff6e974d52516a49dd0d8e9683af12af7e989494f41907cb2ee589cdd3b',
      54_774,
      '6448cb424115759b71301f93b81bc1dca8d667b5f3524ede55c5c873ed9bed52',
    ],
    [
      [a],
      'e44a46639135a635919281bd8fe22c65b5c352b2fdc59258d6c716516174ed72',
      15_799,
      '570a5bca169fcfe3d732962a20b2c6ccdeb695007720c0ae037174e29cb5b00c',
    ],
    [
      [b],
      '0da0072193047499e03832915d4d307534ce2b53d61b717782a3f928306215a5',
      34_723,
      '8d9cceb63bf211fb57523f9b6967f8f1fcce03b2ed60ff5ac41af9df82522543',
    ],
    [
      [c],
      'a8f8b564ac6390ebb92d817f2f1030bb5f49ee86a45b39e48e801c7e2c902868',
      15_516,
      '703578ac60cb36b4722ff05927cd5df080cacfdf24fef44ae39328f75c63f9fb',
    ],
    [
      [a, c],
      '200576ceddc1ba84b25f1397c687141ecc1119e6eee5f07e635f9b192e8eaaf7',
      25_636,
      '0c271e16f7909e7e1ba430c2a20cd2a0b7f102519a997b2aea6f9fd3b333927d',
    ],
  ] as const;
  expect(input.unitIds).toHaveLength(3);
  const { inventory, config, evaluatedAt } = input;
  const run = prepareAnalysisRun({ inventory, config, evaluatedAt, limits: ANALYSIS_LIMITS });
  if (run.kind !== 'ready') throw new Error('fixture failed');
  for (const [unitIds, digest, requestBytes, requestHash] of pinned) {
    for (const result of [
      prepareAnalysisBatch({ ...input, unitIds, limits: ANALYSIS_LIMITS }),
      prepareRunBatch(run.run, [...unitIds]),
    ]) {
      if (result.kind !== 'prepared') throw new Error('fixture failed');
      expect(result.batch.batchId).toBe('v1:' + digest);
      expect(result.batch.requestBytes).toBe(requestBytes);
      expect(createHash('sha256').update(JSON.stringify(result.batch.request)).digest('hex')).toBe(
        requestHash,
      );
    }
  }
});

test('a run handle is owned, detached from its caller, and checks each selection', async () => {
  const { input } = await analysisScenario();
  const { config, evaluatedAt } = input;
  const inventory = structuredClone(input.inventory);
  const run = prepareAnalysisRun({ inventory, config, evaluatedAt, limits: ANALYSIS_LIMITS });
  if (run.kind !== 'ready') throw new Error('fixture failed');
  const [first] = input.unitIds;
  expect(prepareRunBatch({}, [first])).toEqual({
    kind: 'invalid',
    category: 'reference',
    attempted: false,
  });
  expect(prepareRunBatch(run.run, []).kind).toBe('invalid');
  expect(prepareRunBatch(run.run, [first, first]).kind).toBe('invalid');
  expect(prepareRunBatch(run.run, ['unknown-unit']).kind).toBe('invalid');
  const before = prepareRunBatch(run.run, [first]);
  (inventory.units as unknown[]).length = 0;
  const after = prepareRunBatch(run.run, [first]);
  if (before.kind !== 'prepared' || after.kind !== 'prepared') throw new Error('fixture failed');
  expect(after.batch.batchId).toBe(before.batch.batchId);
  expect(
    prepareAnalysisRun({
      inventory,
      config,
      evaluatedAt,
      unitIds: [first],
      limits: ANALYSIS_LIMITS,
    }).kind,
  ).toBe('invalid');
});
