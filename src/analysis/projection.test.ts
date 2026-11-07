import { expect, test, vi } from 'vite-plus/test';
import { analysisScenario } from '../../tests/parity/analysis.js';
import { parseReviewConfig } from '../config.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits } from '../units.js';
import { ANALYSIS_LIMITS, prepareAnalysisBatch, preparedSnapshot } from './contract.js';

test('projects actual mixed collector units with short aliases and independent coverage', async () => {
  const { input } = await analysisScenario();
  const result = prepareAnalysisBatch({ ...input, limits: ANALYSIS_LIMITS });
  expect(result.kind).toBe('prepared');
  if (result.kind !== 'prepared') throw new Error('preparation');
  const { batch } = result;
  const projection = JSON.parse(batch.request.messages[1].content);
  expect(batch.unitIds).toEqual(input.unitIds);
  expect(Math.max(...input.unitIds.map((id) => id.length))).toBeGreaterThan(128);
  expect(projection.units.map((unit: { id: string }) => unit.id)).toEqual(
    input.unitIds.map((_, i) => 'u' + i.toString(36)),
  );
  expect(Object.keys(projection.coverage)).toEqual(['npm', 'actions', 'uv']);
  expect(batch.requestBytes).toBe(Buffer.byteLength(JSON.stringify(batch.request)));
  for (const id of input.unitIds) expect(JSON.stringify(batch.request)).not.toContain(id);
  expect(Object.isFrozen(batch)).toBe(true);
  expect(Object.isFrozen(batch.request.messages)).toBe(true);
});

test('shortens multibyte upstream text without changing source identity or other evidence', async () => {
  const { input, scenario } = await analysisScenario();
  const candidate = {
    ...input.inventory.packet,
    sources: input.inventory.packet.sources.map((source) =>
      source.provenance.kind === 'upstream'
        ? {
            ...source,
            provenance: { ...source.provenance, excerpt: '🙂"🙂"🙂"', excerptTruncated: false },
          }
        : source,
    ),
  };
  const accepted = validateReviewPacket(candidate, scenario.fixture.expected);
  if (!accepted.ok) throw new Error('fixture packet rejected');
  const inventory = formDecisionUnits(accepted.packet);
  const result = prepareAnalysisBatch({
    ...input,
    inventory,
    limits: { ...ANALYSIS_LIMITS, sourceBytes: 5 },
  });
  expect(result.kind).toBe('prepared');
  if (result.kind !== 'prepared') throw new Error('preparation');
  const data = JSON.parse(result.batch.request.messages[1].content);
  for (const source of data.sources.filter(
    (s: { provenance: { kind: string } }) => s.provenance.kind === 'upstream',
  )) {
    expect(source.provenance.excerpt).toBe('🙂"');
    expect(source.provenance.excerptTruncated).toBe(true);
    const original = preparedSnapshot(result.batch)!.sources.find(
      (entry) => entry.alias === source.id,
    )!.value;
    expect(source.status).toBe(original.status);
    if (original.provenance.kind === 'upstream')
      expect(source.provenance.url).toBe(original.provenance.url);
  }
  expect(result.batch.requestBytes).toBe(Buffer.byteLength(JSON.stringify(result.batch.request)));
});

test('configuration failure, missing selection, and invalid time cannot yield a prepared batch', async () => {
  const { input } = await analysisScenario();
  for (const config of [
    parseReviewConfig('{'),
    parseReviewConfig('{"version":1}'),
    parseReviewConfig('{"version":1,"analysis":{"provider":"other","model":"x"}}'),
  ]) {
    expect(prepareAnalysisBatch({ ...input, config, limits: ANALYSIS_LIMITS })).toMatchObject({
      kind: 'unavailable',
      category: 'configuration',
      attempted: false,
    });
  }
  for (const evaluatedAt of [NaN, Infinity, 1.5])
    expect(prepareAnalysisBatch({ ...input, evaluatedAt, limits: ANALYSIS_LIMITS }).kind).toBe(
      'invalid',
    );
});

test('rejects an out-of-order or caller-forged inventory instead of trusting supplied policy', async () => {
  const { input } = await analysisScenario();
  expect(
    prepareAnalysisBatch({
      ...input,
      limits: ANALYSIS_LIMITS,
      unitIds: [...input.unitIds].reverse(),
    }),
  ).toMatchObject({ kind: 'invalid', attempted: false });
  expect(
    prepareAnalysisBatch({
      ...input,
      limits: ANALYSIS_LIMITS,
      policy: { effectiveCeiling: 'merge' },
    }),
  ).toMatchObject({ kind: 'invalid', attempted: false });
  const inventory = {
    ...structuredClone(input.inventory),
    units: [...input.inventory.units].reverse(),
  };
  expect(prepareAnalysisBatch({ ...input, inventory, limits: ANALYSIS_LIMITS })).toMatchObject({
    kind: 'invalid',
  });
});

test('binds config and evaluation time locally without placing the binding in the request', async () => {
  const { input } = await analysisScenario();
  const first = prepareAnalysisBatch({ ...input, limits: ANALYSIS_LIMITS });
  const second = prepareAnalysisBatch({
    ...input,
    evaluatedAt: input.evaluatedAt + 1,
    limits: ANALYSIS_LIMITS,
  });
  expect(first.kind).toBe('prepared');
  expect(second.kind).toBe('prepared');
  if (first.kind !== 'prepared' || second.kind !== 'prepared') throw new Error('preparation');
  expect(second.batch.batchId).not.toBe(first.batch.batchId);
  expect(JSON.stringify(first.batch.request)).not.toContain(first.batch.batchId);
});

test.each(['malware', 'security-fix', 'optional-failed', 'recent'] as const)(
  'preserves actual C3 evaluation and lookup distinctions for %s',
  async (mode) => {
    const { input } = await analysisScenario({ mode });
    const result = prepareAnalysisBatch({ ...input, limits: ANALYSIS_LIMITS });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('preparation');
    const snapshot = preparedSnapshot(result.batch)!;
    const data = JSON.parse(result.batch.request.messages[1].content);
    expect(
      data.units.map(
        (unit: { policy: { effectiveCeiling: string } }) => unit.policy.effectiveCeiling,
      ),
    ).toEqual(
      input.inventory.units.map(
        (unit) => snapshot.policy.units.find((p) => p.id === unit.id)!.effectiveCeiling,
      ),
    );
    expect(data.context.dependencies).toHaveLength(snapshot.members.length);
    expect(
      data.context.dependencies.every(
        (context: { status: string }) => context.status === 'disabled',
      ),
    ).toBe(true);
    if (mode === 'malware') expect(snapshot.holds.length).toBeGreaterThan(0);
    if (mode === 'optional-failed')
      expect(snapshot.policy.units.flatMap((unit) => unit.uncheckedSignals).length).toBeGreaterThan(
        0,
      );
  },
);

test('exposes no unrelated members through shared source subjects in a subset', async () => {
  const { input } = await analysisScenario();
  const result = prepareAnalysisBatch({
    ...input,
    unitIds: [input.unitIds[0]],
    limits: ANALYSIS_LIMITS,
  });
  expect(result.kind).toBe('prepared');
  if (result.kind !== 'prepared') throw new Error('preparation');
  const snapshot = preparedSnapshot(result.batch)!;
  const data = JSON.parse(result.batch.request.messages[1].content);
  expect(data.units).toHaveLength(1);
  const memberAliases = snapshot.members.map((member) => member.alias);
  for (const source of data.sources) {
    expect(source.memberIds.every((id: string) => memberAliases.includes(id))).toBe(true);
    if (source.provenance.kind === 'upstream')
      expect(
        source.provenance.subjects.every((subject: { memberId: string }) =>
          memberAliases.includes(subject.memberId),
        ),
      ).toBe(true);
  }
  expect(preparedSnapshot({ ...result.batch })).toBeUndefined();
});

test('enforces the final escaped UTF-8 request boundary, and truncates only source text', async () => {
  const { input } = await analysisScenario();
  const result = prepareAnalysisBatch({
    ...input,
    limits: { ...ANALYSIS_LIMITS, sourceBytes: 20 },
  });
  expect(result.kind).toBe('prepared');
  if (result.kind !== 'prepared') throw new Error('preparation');
  const n = result.batch.requestBytes;
  const exact = { ...ANALYSIS_LIMITS, sourceBytes: 20, requestBytes: n };
  expect(prepareAnalysisBatch({ ...input, limits: exact }).kind).toBe('prepared');
  expect(prepareAnalysisBatch({ ...input, limits: { ...exact, requestBytes: n - 1 } })).toEqual({
    kind: 'invalid',
    attempted: false,
    category: 'budget',
  });
  const data = JSON.parse(result.batch.request.messages[1].content);
  const upstream = data.sources.filter(
    (source: { provenance: { kind: string } }) => source.provenance.kind === 'upstream',
  );
  expect(
    upstream.some(
      (source: { provenance: { excerptTruncated: boolean } }) => source.provenance.excerptTruncated,
    ),
  ).toBe(true);
  for (const source of upstream)
    expect(Buffer.byteLength(source.provenance.excerpt)).toBeLessThanOrEqual(20);
  expect(
    prepareAnalysisBatch({ ...input, limits: { ...ANALYSIS_LIMITS, unitBytes: 1 } }).kind,
  ).toBe('invalid');
});

test('does not execute supplied accessors or accept invalid limits, duplicate or empty units', async () => {
  const { input } = await analysisScenario();
  const getter = vi.fn(() => input.inventory);
  const candidate = { ...input, limits: ANALYSIS_LIMITS };
  Object.defineProperty(candidate, 'inventory', { get: getter, enumerable: true });
  expect(prepareAnalysisBatch(candidate).kind).toBe('invalid');
  expect(getter).not.toHaveBeenCalled();
  for (const unitIds of [[], [input.unitIds[0], input.unitIds[0]], ['unknown']])
    expect(prepareAnalysisBatch({ ...input, unitIds, limits: ANALYSIS_LIMITS }).kind).toBe(
      'invalid',
    );
  for (const maxUnits of [0, -1, 9, NaN, Infinity, 1.5])
    expect(prepareAnalysisBatch({ ...input, limits: { ...ANALYSIS_LIMITS, maxUnits } }).kind).toBe(
      'invalid',
    );
  const result = prepareAnalysisBatch({ ...input, limits: ANALYSIS_LIMITS });
  if (result.kind !== 'prepared') throw new Error('preparation');
  if (input.config.ok && input.config.config.analysis)
    input.config.config.analysis.model = 'changed';
  expect(result.batch.request.model).toBe('synthetic-model');
  expect(() =>
    Object.defineProperty(result.batch.request.messages[1], 'content', { value: 'changed' }),
  ).toThrow();
});
