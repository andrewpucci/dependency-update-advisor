import { expect, test } from 'vite-plus/test';
import { analysisWithContext, capabilityDocument } from '../../tests/parity/analysis.js';
import { preparedSnapshot, receiveAnalysisReply, validateAnalysisReply } from './contract.js';

test('use_now and consider_later require a real C2 fact for the directly researched member', async () => {
  const { batch } = await analysisWithContext();
  const { document, feature, context } = capabilityDocument(batch);
  expect(context).toBeDefined();
  for (const usefulness of ['use_now', 'consider_later']) {
    feature.usefulness = usefulness;
    const result = validateAnalysisReply(
      batch,
      await receiveAnalysisReply(batch, async () => document),
    );
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') throw new Error('validation');
    const capability = result.assessments.flatMap((unit) => unit.newFunctionality)[0];
    expect(capability).toMatchObject({ contextPath: 'src/usage.ts', contextStatus: 'available' });
  }
});

test('a same-file fact for another dependency cannot support an adoption action', async () => {
  const { batch } = await analysisWithContext();
  const { document, feature, context, member } = capabilityDocument(batch);
  const other = preparedSnapshot(batch)!.contexts.find(
    (entry) => entry.value.memberId !== member.id && entry.value.path === context?.value.path,
  )!;
  expect(other).toBeDefined();
  feature.contextId = other.alias;
  expect(
    validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)).kind,
  ).toBe('failed');
});

test.each(['disabled', 'unmatched', 'partial'] as const)(
  'not_relevant retains %s usage uncertainty',
  async (mode) => {
    const { batch } = await analysisWithContext(mode);
    const { document, feature } = capabilityDocument(batch);
    feature.usefulness = 'not_relevant';
    const projected = JSON.parse(batch.request.messages[1].content).context.dependencies.find(
      (entry: { memberId: string }) => entry.memberId === feature.memberId,
    );
    expect(projected.matched).toBe(mode === 'partial');
    const value = { ...feature, action: null, contextId: null };
    document.assessments.find((entry) => entry.newFunctionality.length)!.newFunctionality = [value];
    const result = validateAnalysisReply(
      batch,
      await receiveAnalysisReply(batch, async () => document),
    );
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') throw new Error('validation');
    expect(result.assessments.flatMap((unit) => unit.newFunctionality)[0]).toMatchObject({
      contextStatus: mode === 'unmatched' ? 'unavailable' : mode,
      contextPath: null,
    });
  },
);

test('adoption advice cannot omit action/context or invent feature fields and destinations', async () => {
  const { batch } = await analysisWithContext();
  const { document, feature } = capabilityDocument(batch);
  const index = document.assessments.findIndex((entry) => entry.newFunctionality.length);
  for (const candidate of [
    { ...feature, action: null },
    { ...feature, contextId: null },
    { ...feature, contextId: 'cunknown' },
    { ...feature, sourceId: 'sunknown' },
    { ...feature, kind: 'bug_fix' },
    { ...feature, feature: 'x'.repeat(513) },
    { ...feature, contextPath: 'src/invented.ts' },
  ]) {
    document.assessments[index].newFunctionality = [candidate];
    expect(
      validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)).kind,
    ).toBe('failed');
  }
  document.assessments[index].newFunctionality = [feature, feature];
  expect(
    validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)).kind,
  ).toBe('failed');
});

test('a transitive grouped member cannot receive advice even with its own real source and usage fact', async () => {
  const { batch } = await analysisWithContext();
  const snapshot = preparedSnapshot(batch)!;
  const { document, feature, unit } = capabilityDocument(batch);
  const child = snapshot.members.find(
    (member) => unit.value.memberIds.includes(member.id) && member.id !== unit.value.anchorId,
  )!;
  const source = snapshot.sources.find(
    (entry) =>
      child.value.evidence.upstream.sourceIds.includes(entry.id) &&
      entry.value.provenance.kind === 'upstream' &&
      entry.value.provenance.subjects.some(
        (subject) => subject.memberId === child.id && subject.side === 'head',
      ),
  )!;
  const context = snapshot.contexts.find((entry) => entry.value.memberId === child.id)!;
  expect(source).toBeDefined();
  expect(context).toBeDefined();
  feature.memberId = child.alias;
  feature.sourceId = source.alias;
  feature.contextId = context.alias;
  expect(
    validateAnalysisReply(batch, await receiveAnalysisReply(batch, async () => document)).kind,
  ).toBe('failed');
});

test('real C2 opt-out removes lines from the prepared request, while partial advice preserves truncation', async () => {
  const disabled = await analysisWithContext('disabled');
  expect(JSON.stringify(disabled.batch.request)).not.toContain('import orbit from');
  expect(preparedSnapshot(disabled.batch)!.contexts).toHaveLength(0);
  const partial = await analysisWithContext('partial');
  const { document } = capabilityDocument(partial.batch);
  const result = validateAnalysisReply(
    partial.batch,
    await receiveAnalysisReply(partial.batch, async () => document),
  );
  expect(result.kind).toBe('validated');
  if (result.kind !== 'validated') throw new Error('validation');
  expect(result.assessments.flatMap((unit) => unit.newFunctionality)[0]).toMatchObject({
    contextStatus: 'partial',
    contextExcerptTruncated: true,
  });
});
