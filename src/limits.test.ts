import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import { PACKET_LIMITS } from './schema.js';
import { COMPARE_PAGE_SIZES, RELEASE_PAGE_SIZES } from './evidence/upstream-read.js';
import { DISCOVERY_PAGE_SIZES } from './evidence/advisory-read.js';
import {
  PENDING_AUDIT,
  REGISTER,
  buildRegister,
  checkRegister,
  dependents,
  limit,
  limitEntry,
  settingProblems,
  replyBytesFor,
  hardMaximum,
  heapBytesFor,
  maxRelationshipLimits,
  unitDerivedBytes,
  UNIT_TEXT,
  Q10_RETAINED_INPUTS,
  type LimitDefinition,
  type LimitId,
} from './limits.js';
import { COUNTERS } from '../scripts/probe-parse-cost/core.js';

/** V8's maximum string length on 64-bit platforms, (1 << 29) - 24 code units. */
const V8_MAX_STRING_LENGTH = 536_870_888;

const unjustified = (id: string, value: number): LimitDefinition => ({
  id,
  value,
  unit: 'count',
  protects: PENDING_AUDIT,
  effect: PENDING_AUDIT,
  basis: { kind: 'unjustified', note: PENDING_AUDIT },
  test: PENDING_AUDIT,
});

const derived = (
  id: string,
  inputs: string[],
  formula: (...values: number[]) => number,
): LimitDefinition => ({
  id,
  unit: 'count',
  protects: PENDING_AUDIT,
  effect: PENDING_AUDIT,
  basis: { kind: 'derived', inputs, formula, description: 'test formula' },
  test: PENDING_AUDIT,
});

test('PACKET_LIMITS is a frozen view of the register with the same values and keys', () => {
  const keys = Object.keys(PACKET_LIMITS) as (keyof typeof PACKET_LIMITS)[];
  for (const key of keys) {
    expect(PACKET_LIMITS[key]).toBe(limit(`packet.${key}`));
  }
  expect(Object.isFrozen(PACKET_LIMITS)).toBe(true);
  const packetIds = [...REGISTER.keys()].filter((id) => id.startsWith('packet.')).sort();
  expect(packetIds).toEqual(keys.map((key) => `packet.${key}`).sort());
  expect(packetIds).toHaveLength(15);
});

test('checkRegister names an entry whose basis kind is not one of the six', () => {
  const guessed = { ...unjustified('guessed', 1), basis: { kind: 'guess', note: 'x' } };
  expect(checkRegister([guessed])).toEqual([expect.stringMatching(/guessed/)]);
  expect(checkRegister([{ ...guessed, basis: { kind: 'safety', reason: 'x' } }])).toEqual([]);
});

const setting = (
  id: string,
  value: number,
  maximum: string,
  extra: Partial<NonNullable<LimitDefinition['configurable']>> = {},
): LimitDefinition => ({
  ...unjustified(id, value),
  basis: { kind: 'config', bears: 'the adopter', approved: 'test' },
  configurable: { setting: `limits.${id}`, default: value, maximum, ...extra },
});

test('a config entry needs its setting, a default equal to its value and defined bounds', () => {
  const max = unjustified('max', 10);
  expect(checkRegister([setting('a', 4, 'max'), max])).toEqual([]);
  expect(checkRegister([{ ...setting('a', 4, 'max'), configurable: undefined }, max])).toEqual([
    expect.stringMatching(/a: a config entry needs configurable/),
  ]);
  expect(checkRegister([{ ...setting('a', 4, 'max'), value: 5 }, max])).toEqual([
    expect.stringMatching(/a: the setting default must equal value/),
  ]);
  expect(checkRegister([setting('a', 4, 'missing')])).toEqual([
    expect.stringMatching(/a: setting bound "missing" is not defined/),
  ]);
  expect(
    checkRegister([
      { ...unjustified('b', 1), configurable: setting('a', 1, 'max').configurable },
      max,
    ]),
  ).toEqual([expect.stringMatching(/b: only a config entry may set configurable/)]);
});

test('a register built at a setting moves the entries derived from it, and only settings move', () => {
  const definitions = [
    setting('a', 4, 'max'),
    unjustified('max', 10),
    derived('b', ['a'], (a) => a * 3),
  ];
  expect(buildRegister(definitions).get('b')?.value).toBe(12);
  expect(buildRegister(definitions, new Map([['a', 7]])).get('b')?.value).toBe(21);
  expect(() => buildRegister(definitions, new Map([['max', 7]]))).toThrow(
    /max: not an adopter setting/,
  );
});

test('settingProblems checks every setting at the defaults and at its hard maximum', () => {
  const within = buildRegister([setting('a', 4, 'max'), unjustified('max', 10)]);
  expect(settingProblems(within)).toEqual([]);
  const above = buildRegister([setting('a', 12, 'max'), unjustified('max', 10)]);
  expect(settingProblems(above)).toContain('a: above its hard maximum at the defaults');
  const below = buildRegister([
    setting('a', 4, 'max', { minimum: 'min' }),
    unjustified('max', 10),
    unjustified('min', 5),
  ]);
  expect(settingProblems(below)).toContain('a: below its hard minimum at the defaults');
  const joint = buildRegister([
    setting('a', 6, 'max', { joint: true }),
    setting('b', 6, 'max', { joint: true }),
    unjustified('max', 10),
  ]);
  expect(settingProblems(joint)).toContain(
    'max: the settings it bounds sum past it at the defaults',
  );
  // The maximum of one setting may derive from another; raising that one can push it out.
  const coupled = buildRegister([
    setting('a', 4, 'room'),
    setting('b', 4, 'limit'),
    unjustified('limit', 10),
    derived('room', ['b'], (b) => 12 - b),
  ]);
  expect(settingProblems(coupled)).toEqual([
    'a: above its hard maximum with b at its hard maximum',
  ]);
});

test('a derived input that names no entry is reported with both ids and blocks the build', () => {
  const orphan = derived('orphan', ['missing'], (m) => m);
  const problems = checkRegister([orphan]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/orphan/);
  expect(problems[0]).toMatch(/missing/);
  expect(() => buildRegister([orphan])).toThrow(/orphan[\s\S]*missing/);
});

test('derived values resolve in any definition order and dependents follow transitive reads', () => {
  const register = buildRegister([derived('b', ['a'], (a) => a * 3), unjustified('a', 4)]);
  expect(register.get('b')?.value).toBe(12);
  expect(dependents(register, 'a')).toEqual(['b']);

  const chain = buildRegister([
    derived('c', ['b'], (b) => b + 1),
    derived('b', ['a'], (a) => a * 3),
    unjustified('a', 4),
  ]);
  expect(chain.get('c')?.value).toBe(13);
  expect(dependents(chain, 'a')).toEqual(['b', 'c']);
});

test('checkRegister reports duplicate ids, missing values, stray values, and cycles', () => {
  expect(checkRegister([unjustified('a', 1), unjustified('a', 2)])).toEqual([
    expect.stringMatching(/a: duplicate id/),
  ]);
  expect(checkRegister([{ ...unjustified('a', 1), value: undefined }])).toEqual([
    expect.stringMatching(/a: value/),
  ]);
  expect(
    checkRegister([{ ...derived('b', ['a'], (a) => a), value: 3 }, unjustified('a', 1)]),
  ).toEqual([expect.stringMatching(/b: .*value/)]);
  expect(checkRegister([derived('x', ['y'], (y) => y), derived('y', ['x'], (x) => x)])).toEqual([
    expect.stringMatching(/cycle/),
  ]);
});

test('derived limits are wired to the entries they sum or copy', () => {
  expect(dependents(REGISTER, 'evidence.allocation.signals.readers.malware.maxRequests')).toEqual(
    expect.arrayContaining([
      'evidence.allocation.signals.maxRequests',
      'evidence.envelope.maxRequests',
    ]),
  );
  expect(dependents(REGISTER, 'evidence.allocation.registry.maxTotalBytes')).toEqual(
    expect.arrayContaining(['evidence.envelope.maxTotalBytes', 'research.cache.maxTotalBytes']),
  );
  expect(dependents(REGISTER, 'job.budget')).toEqual([
    'job.maxAnalysisTimeMs',
    'job.maxEvidenceDeadlineMs',
    'job.window',
    'measureDemand.testTimeoutMs',
    'startup.maxReportedDurationMs',
  ]);
});

test('the job budget is derived from the dependabot review workflow timeout', () => {
  // Since L11 item 10(b) the budget is the review step's timeout; the job's follows from it.
  expect(dependents(REGISTER, 'workflow.dependabotReview.review.steps.1.timeoutMinutes')).toEqual(
    expect.arrayContaining([
      'job.budget',
      'job.window',
      'workflow.dependabotReview.review.timeoutMinutes',
    ]),
  );
  expect(limit('job.budget')).toBe(900_000);
  expect(limit('workflow.dependabotReview.review.timeoutMinutes')).toBe(16);
});

/** Each copy of a packet limit, paired with the packet entry whose value it mirrors. */
const PACKET_COPIES: readonly [LimitId, LimitId][] = [
  ['context.maxDependencies', 'packet.changes'],
  ['context.maxIdCodeUnits', 'packet.idCodeUnits'],
  ['context.maxPathBytes', 'packet.identityBytes'],
  ['context.maxSourceContextBytes', 'packet.contextBytes'],
  ['context.maxSourceExcerptCodeUnits', 'packet.excerptCodeUnits'],
  ['context.maxSourceFactsPerDependency', 'packet.facts'],
  ['dependabot.maxPathBytes', 'packet.identityBytes'],
];

test('copies wired: a packet copy is a derived mirror of its packet entry', () => {
  for (const [copy, source] of PACKET_COPIES) {
    expect(limitEntry(copy).basis, copy).toMatchObject({ kind: 'derived', inputs: [source] });
    expect(dependents(REGISTER, source), copy).toContain(copy);
    expect(limit(copy), copy).toBe(limit(source));
  }
});

test('copies wired: the candidate bound is one entry read by config and context, and roots have none', () => {
  // The source-root count is deleted (L11, item 9): a root only filters paths already listed.
  expect(REGISTER.has('context.maxSourceRoots' as LimitId)).toBe(false);
  expect(limit('context.maxSourceCandidates')).toBe(193);
  expect(dependents(REGISTER, 'context.maxSourceCandidates')).toEqual([]);
  for (const file of ['src/config.ts', 'src/context.ts']) {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    expect(source, file).not.toContain('context.maxSourceRoots');
    expect(source, file).toContain("limit('context.maxSourceCandidates')");
  }
});

test('moved limits that mirror a packet bound are derived from it', () => {
  expect(dependents(REGISTER, 'packet.changes')).toContain('advisories.maxLookups');
  expect(dependents(REGISTER, 'packet.findings')).toContain('research.maxFindings');
  expect(limit('advisories.maxLookups')).toBe(2 * PACKET_LIMITS.changes);
  expect(limit('research.maxFindings')).toBe(PACKET_LIMITS.findings);
});

test('derived packet bounds keep their formulas and the values the analysis caps give', () => {
  const cases: [LimitId, LimitId[], number, number][] = [
    ['packet.relationships', ['packet.changes'], 2 * limit('packet.changes'), 256],
    [
      'packet.textBytes',
      ['analysis.unitBytes', 'packet.listEntries'],
      Math.floor(limit('analysis.unitBytes') / limit('packet.listEntries')),
      3_782,
    ],
    ['packet.contextBytes', ['analysis.unitBytes'], limit('analysis.unitBytes'), 121_026],
  ];
  for (const [id, inputs, expected, previous] of cases) {
    const { basis } = limitEntry(id);
    expect(basis, id).toMatchObject({ kind: 'derived', inputs });
    if (basis.kind !== 'derived') continue;
    expect(basis.formula(...inputs.map((input) => limit(input))), id).toBe(expected);
    expect(limit(id), id).toBe(expected);
    expect(limit(id), id).toBe(previous);
    for (const input of inputs) expect(dependents(REGISTER, input), id).toContain(id);
  }
  // The formulas, not the current inputs, are pinned: a moved input moves the bound.
  const relationships = limitEntry('packet.relationships').basis;
  const textBytes = limitEntry('packet.textBytes').basis;
  if (relationships.kind !== 'derived' || textBytes.kind !== 'derived') throw new Error('derived');
  expect(relationships.formula(100)).toBe(200);
  expect(textBytes.formula(65_536, 30)).toBe(2_184);
});

test('the heap inputs of packet.bytes keep their sources and formula', () => {
  expect(limitEntry('runner.heapBytes').basis).toMatchObject({ kind: 'derived' });
  for (const id of ['runner.heapBytesPerPacketByte', 'runner.heapBytesPerReplyByte'] as const)
    expect(limitEntry(id).basis, id).toMatchObject({
      kind: 'measured',
      command: 'npm run measure:heap',
    });
  const inputs: LimitId[] = [
    'analysis.maxConcurrentCalls',
    'analysis.responseBytes',
    'runner.heapBytesPerReplyByte',
  ];
  const { basis } = limitEntry('analysis.replyHeapBytes');
  expect(basis).toMatchObject({ kind: 'derived', inputs });
  if (basis.kind !== 'derived') throw new Error('derived');
  const [calls, bytes, perByte] = inputs.map((id) => limit(id));
  expect(limit('analysis.replyHeapBytes')).toBe(Math.ceil(calls * bytes * perByte));
  // The formula, not the current inputs, is pinned: a reply cap or concurrency change moves it.
  expect(basis.formula(2, 10, 1.25)).toBe(25);
  expect(basis.formula(2, 10, 1.26)).toBe(26);
  for (const input of inputs)
    expect(dependents(REGISTER, input)).toContain('analysis.replyHeapBytes');
});

test('the evidence-phase heap inputs keep their sources and formula', () => {
  for (const id of [
    'runner.heapBytesPerEvidenceByte',
    'runner.evidenceHeapBytesPerPacketByte',
  ] as const)
    expect(limitEntry(id).basis, id).toMatchObject({
      kind: 'measured',
      command: 'npm run measure:heap',
    });
  const heap = limitEntry('runner.evidenceHeapBytes').basis;
  expect(heap).toMatchObject({
    kind: 'derived',
    inputs: [
      'runner.heapBytes',
      'packet.bytes',
      'runner.evidenceHeapBytesPerPacketByte',
      'runner.evidenceRetainedHeapBytes',
    ],
  });
  if (heap.kind !== 'derived') throw new Error('derived');
  // H − packet × rate − the retained evidence: the heap left for responses in flight.
  expect(heap.formula(1000, 10, 2, 30)).toBe(1000 - 20 - 30);
  const cap = limitEntry('runner.maxEvidenceResponseBytes').basis;
  expect(cap).toMatchObject({
    kind: 'derived',
    inputs: [
      'runner.evidenceHeapBytes',
      'evidence.readsInFlight',
      'runner.heapBytesPerEvidenceByte',
    ],
  });
  if (cap.kind !== 'derived') throw new Error('derived');
  expect(cap.formula(1000, 2, 3)).toBe(166);
  expect(limitEntry('evidence.envelope.maxResponseBytes').configurable).toMatchObject({
    maximum: 'runner.maxEvidenceResponseBytes',
  });
  expect(limit('evidence.envelope.maxResponseBytes')).toBeLessThanOrEqual(
    limit('runner.maxEvidenceResponseBytes'),
  );
  // The packet cap takes the evidence-phase heap the defaults leave, so the response cap's hard
  // maximum is its default: a larger cap would lower limit:packet.bytes, not fit beside it.
  expect(limit('runner.maxEvidenceResponseBytes')).toBe(
    limit('evidence.envelope.maxResponseBytes'),
  );
  expect(hardMaximum(REGISTER, 'evidence.envelope.maxResponseBytes')).toBe(
    limit('evidence.envelope.maxResponseBytes'),
  );
});

test('the Q10 byte shares and retained caps are settings under one joint heap maximum', () => {
  const members = Q10_RETAINED_INPUTS.filter(
    (id) => id !== 'research.maxRetainedBytes' && id !== 'config.maxBytes',
  );
  expect(members).toHaveLength(13);
  for (const id of members)
    expect(limitEntry(id).configurable, id).toMatchObject({
      maximum: 'runner.maxEvidenceRetainedBytes',
      joint: true,
    });
  for (const id of [
    'evidence.allocation.registry.maxTotalBytes',
    'evidence.allocation.signals.readers.upstream.maxTotalBytes',
  ] as const)
    expect(limitEntry(id).configurable, id).toMatchObject({
      minimum: 'evidence.envelope.maxResponseBytes',
    });
  // Q11(a): the upstream share's default rises to one response at the cap.
  expect(limit('evidence.allocation.signals.readers.upstream.maxTotalBytes')).toBe(
    limit('evidence.envelope.maxResponseBytes'),
  );
  const { basis } = limitEntry('runner.maxEvidenceRetainedBytes');
  if (basis.kind !== 'derived') throw new Error('derived');
  // (H − packet × rate − reads × response × parse rate) ÷ retained rate − research − config.
  expect(basis.formula(1000, 10, 2, 1, 4, 5, 2, 100, 50)).toBe(
    Math.floor((1000 - 20 - 20) / 2) - 150,
  );
  // The defaults fit under it, with the packet at its value.
  const total = members.reduce((sum, id) => sum + limit(id), 0);
  expect(total).toBeLessThanOrEqual(limit('runner.maxEvidenceRetainedBytes'));
  expect(settingProblems(REGISTER)).toEqual([]);
});

test('the evidence retained state is sized at the retained rate', () => {
  expect(limitEntry('runner.heapBytesPerRetainedByte').basis).toMatchObject({
    kind: 'measured',
    command: 'npm run measure:heap',
  });
  // What a reader keeps costs less per byte than the parse that produced it.
  expect(limit('runner.heapBytesPerRetainedByte')).toBeLessThan(
    limit('runner.heapBytesPerEvidenceByte'),
  );
  const { basis } = limitEntry('runner.evidenceRetainedHeapBytes');
  expect(basis).toMatchObject({
    kind: 'derived',
    inputs: [...Q10_RETAINED_INPUTS, 'runner.heapBytesPerRetainedByte'],
  });
  if (basis.kind !== 'derived') throw new Error('derived');
  expect(basis.formula(1, 2, 3, 2.5)).toBe(15);
  expect(Q10_RETAINED_INPUTS).toHaveLength(15);
  const retained = Q10_RETAINED_INPUTS.reduce((sum, id) => sum + limit(id), 0);
  expect(limit('runner.evidenceRetainedHeapBytes')).toBe(
    Math.ceil(retained * limit('runner.heapBytesPerRetainedByte')),
  );
});

test('the runner heap derives from runner memory less what is not old generation', () => {
  const inputs: LimitId[] = [
    'runner.memoryBytes',
    'runner.youngGenerationBytes',
    'runner.offHeapBytes',
    'runner.baselineBytes',
    'runner.systemReservedBytes',
  ];
  const { basis } = limitEntry('runner.heapBytes');
  expect(basis).toMatchObject({ kind: 'derived', inputs });
  if (basis.kind !== 'derived') throw new Error('derived');
  // In whole MiB, since --max-old-space-size takes whole MiB.
  const MiB = 1024 * 1024;
  expect(basis.formula(100 * MiB, 10 * MiB, 20 * MiB, 5 * MiB, 15 * MiB)).toBe(50 * MiB);
  expect(basis.formula(100 * MiB + 7, 10, 20, 5, 15)).toBe(99 * MiB);
  expect(limit('runner.heapBytes')).toBe(
    heapBytesFor(...(inputs.map((id) => limit(id)) as [number, number, number, number, number])),
  );
  expect(limitEntry('runner.memoryBytes').basis).toMatchObject({ kind: 'external' });
  expect(limitEntry('runner.youngGenerationBytes').basis).toMatchObject({
    kind: 'external',
    platformValue: 3 * 64 * 1024 * 1024,
  });
  expect(limitEntry('runner.baselineBytes').basis).toMatchObject({
    kind: 'measured',
    command: 'npm run probe:runtime-baseline',
  });
  // The off-heap buffers: the research cache, two copies of each read in flight and its largest
  // decoded file, two copies of each model reply in flight, and the event read buffer (L11, 11).
  expect(limit('runner.offHeapBytes')).toBe(
    limit('research.cache.maxTotalBytes') +
      limit('evidence.readsInFlight') *
        2 *
        (limit('evidence.envelope.maxResponseBytes') +
          Math.max(
            limit('snapshot.maxBlobBytes'),
            limit('w2.session.maxFileBytes'),
            limit('context.maxSourceFileBytes'),
          )) +
      limit('analysis.maxConcurrentCalls') * 2 * limit('analysis.responseBytes') +
      limit('startup.maxEventBytes') +
      1,
  );
  // The OS and agent reserve is MemTotal − MemAvailable recorded on a GitHub-hosted runner.
  expect(limitEntry('runner.systemReservedBytes').basis).toMatchObject({
    kind: 'measured',
    command: 'npm run probe:runner-memory',
  });
  // The reviewer plans for more old generation than the 2 GiB V8 would give the smallest runner.
  expect(limit('runner.heapBytes')).toBeGreaterThan(2 * 1024 ** 3);
});

test('packet.bytes is the packet that fits the runner heap beside the model replies', () => {
  const inputs: LimitId[] = [
    'runner.heapBytes',
    'analysis.replyHeapBytes',
    'runner.unitExpansionHeapBytes',
    'runner.heapBytesPerPacketByte',
    'runner.evidenceRetainedHeapBytes',
    'evidence.readsInFlight',
    'evidence.envelope.maxResponseBytes',
    'runner.heapBytesPerEvidenceByte',
    'runner.evidenceHeapBytesPerPacketByte',
  ];
  const { basis } = limitEntry('packet.bytes');
  expect(basis).toMatchObject({ kind: 'derived', inputs });
  if (basis.kind !== 'derived') throw new Error('derived');
  const [heap, replies, expansion, perByte, retained, reads, response, perResponse, evidenceRate] =
    inputs.map((id) => limit(id)) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
  const responses = reads * response * perResponse;
  expect(limit('packet.bytes')).toBe(
    Math.min(
      Math.floor((heap - replies - expansion) / perByte),
      Math.floor((heap - retained - responses) / evidenceRate),
    ),
  );
  // In each phase the packet's own heap and what is held beside it stay inside the heap.
  expect(limit('packet.bytes') * perByte + replies + expansion).toBeLessThanOrEqual(heap);
  expect(limit('packet.bytes') * evidenceRate + retained + responses).toBeLessThanOrEqual(heap);
  // One byte more passes the binding phase.
  expect(
    (limit('packet.bytes') + 1) * perByte + replies + expansion > heap ||
      (limit('packet.bytes') + 1) * evidenceRate + retained + responses > heap,
  ).toBe(true);
  // Each phase can bind.
  expect(basis.formula(1_000, 100, 300, 3, 0, 0, 0, 0, 1)).toBe(200);
  expect(basis.formula(1_000, 0, 0, 1, 400, 1, 10, 10, 2)).toBe(250);
  expect(limitEntry('runner.unitExpansionHeapBytes').basis).toMatchObject({
    kind: 'measured',
    command: 'npm run measure:heap',
  });
  for (const input of ['analysis.responseBytes', 'analysis.maxConcurrentCalls'] as const)
    expect(dependents(REGISTER, input)).toContain('packet.bytes');
  // The snapshot budgets follow the packet cap and the unit expansion's structural bound.
  expect(limit('analysis.projectionBytes')).toBe(
    3 * limit('packet.bytes') +
      limit('analysis.unitDerivedBytes') +
      limit('config.maxBytes') +
      UNIT_TEXT.configDefaultBytes,
  );
  expect(limit('analysis.projectionEntries')).toBe(
    limit('packet.bytes') +
      limit('analysis.unitDerivedEntries') +
      Math.ceil(limit('config.maxBytes') / 2) +
      UNIT_TEXT.configDefaultEntries,
  );
  expect(limit('analysis.unitDerivedBytes')).toBe(
    unitDerivedBytes(
      limit('packet.changes'),
      limit('packet.relationships'),
      limit('packet.idCodeUnits'),
      limit('packet.identityBytes'),
    ),
  );
  expect(maxRelationshipLimits(128)).toBe(8_064);
  expect(limit('analysis.projectionBytes')).toBeLessThanOrEqual(V8_MAX_STRING_LENGTH);
});

test('the reply cap is the token budget in escaped bytes plus the envelope, with no escape multiplier', () => {
  const inputs: LimitId[] = [
    'analysis.completionTokens',
    'analysis.maxTokenEscapedBytes',
    'analysis.responseEnvelopeBytes',
  ];
  expect(limitEntry('analysis.responseBytes').basis).toMatchObject({ kind: 'derived', inputs });
  expect(limit('analysis.responseBytes')).toBe(
    replyBytesFor(...(inputs.map((id) => limit(id)) as [number, number, number])),
  );
  expect(limit('analysis.responseBytes')).toBe(16_384 * 1_024 + 65_536);
  expect(limitEntry('analysis.maxTokenEscapedBytes').basis).toMatchObject({
    kind: 'external',
    platformValue: 1_024,
    probe: { command: 'npm run probe:token-length' },
  });
});

test('safety packet bounds keep their values and state a reason', () => {
  const values: [LimitId, number][] = [
    ['packet.findings', 512],
    ['packet.pathInstances', 32],
    ['packet.idCodeUnits', 256],
    ['packet.identityBytes', 1_024],
    ['packet.listEntries', 32],
  ];
  for (const [id, value] of values) {
    const { basis } = limitEntry(id);
    expect(basis, id).toMatchObject({ kind: 'safety', reason: expect.any(String) });
    expect(limit(id), id).toBe(value);
  }
});

test('RELEASE_PAGE_SIZES is a divisor chain from the register value down to 1 and is frozen', () => {
  expect(RELEASE_PAGE_SIZES).toEqual([100, 50, 25, 5, 1]);
  for (const [i, size] of RELEASE_PAGE_SIZES.slice(1).entries())
    expect(RELEASE_PAGE_SIZES[i] % size).toBe(0);
  expect(RELEASE_PAGE_SIZES[0]).toBe(limit('upstream.releasePageSize'));
  expect(Object.isFrozen(RELEASE_PAGE_SIZES)).toBe(true);
});

test('COMPARE_PAGE_SIZES is a divisor chain from the register value down to 1 and is frozen', () => {
  expect(COMPARE_PAGE_SIZES).toEqual([100, 50, 25, 5, 1]);
  for (const [i, size] of COMPARE_PAGE_SIZES.slice(1).entries())
    expect(COMPARE_PAGE_SIZES[i] % size).toBe(0);
  expect(COMPARE_PAGE_SIZES[0]).toBe(limit('upstream.comparePageSize'));
  expect(Object.isFrozen(COMPARE_PAGE_SIZES)).toBe(true);
});

test('checkRegister rejects a value that is not a finite number', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    expect(checkRegister([unjustified('a', value)]), String(value)).toEqual([
      expect.stringMatching(/a: value/),
    ]);
});

const PACKAGE_SCRIPTS = Object.keys(
  (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    }
  ).scripts,
);

/** Today's date in UTC, so the check does not depend on the runner's time zone. */
const utcToday = (): string => new Date().toISOString().slice(0, 10);

function isRealDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === text;
}

/**
 * Spec A1: an external entry's citation is checkable. This runs only here, never when the
 * register loads, because the date check reads the clock.
 */
function externalProblems(
  entries: readonly LimitDefinition[],
  today: string,
  scripts: readonly string[],
): string[] {
  return entries.flatMap(({ id, basis }) => {
    if (basis.kind !== 'external') return [];
    const problems: string[] = [];
    if (!basis.url.startsWith('https://')) problems.push(`${id}: url is not https`);
    if (!isRealDate(basis.checked)) problems.push(`${id}: checked is not a YYYY-MM-DD date`);
    else if (basis.checked > today) problems.push(`${id}: checked is after today (UTC)`);
    if (basis.probe) {
      const script = /^npm run ([\w:-]+)$/.exec(basis.probe.command)?.[1];
      if (script === undefined || !scripts.includes(script))
        problems.push(
          `${id}: probe command is not npm run <package.json script> without arguments`,
        );
      if (basis.probe.repositoryType.trim() === '')
        problems.push(`${id}: probe repositoryType is empty`);
    }
    return problems;
  });
}

const external = (
  basis: Partial<Extract<LimitDefinition['basis'], { kind: 'external' }>>,
): LimitDefinition => ({
  ...unjustified('cited', 1),
  basis: {
    kind: 'external',
    url: 'https://docs.github.com/en/rest',
    checked: '2026-11-22',
    platformValue: 1,
    margin: 'none: test',
    ...basis,
  },
});

test('every external entry in the register cites an https page and a real past UTC date', () => {
  expect(externalProblems([...REGISTER.values()], utcToday(), PACKAGE_SCRIPTS)).toEqual([]);
});

test('an external entry needs an https url and a real checked date', () => {
  const today = '2026-11-22';
  expect(externalProblems([external({})], today, PACKAGE_SCRIPTS)).toEqual([]);
  expect(externalProblems([external({ url: 'http://docs.github.com' })], today, [])).toEqual([
    expect.stringMatching(/cited: url/),
  ]);
  for (const checked of ['2026-02-30', '2026-11-2', '22/11/2026', ''])
    expect(externalProblems([external({ checked })], today, []), checked).toEqual([
      expect.stringMatching(/cited: checked is not/),
    ]);
});

test('an external checked date one day past UTC today is rejected', () => {
  expect(externalProblems([external({ checked: '2026-11-23' })], '2026-11-22', [])).toEqual([
    expect.stringMatching(/cited: checked is after today/),
  ]);
  expect(externalProblems([external({ checked: '2026-11-22' })], '2026-11-22', [])).toEqual([]);
});

test('a probe command must be npm run of a package.json script with no arguments', () => {
  const probe = (command: string) =>
    external({ probe: { command, repositoryType: 'private, user-owned, github.com' } });
  expect(externalProblems([probe('npm run check:limits')], '2026-11-22', PACKAGE_SCRIPTS)).toEqual(
    [],
  );
  for (const command of [
    'npm run check:limits -- --repo x',
    'npm run no-such-script',
    'node scripts/limits/check.ts',
  ])
    expect(externalProblems([probe(command)], '2026-11-22', PACKAGE_SCRIPTS), command).toEqual([
      expect.stringMatching(/cited: probe command/),
    ]);
  expect(
    externalProblems(
      [external({ probe: { command: 'npm run check:limits', repositoryType: ' ' } })],
      '2026-11-22',
      PACKAGE_SCRIPTS,
    ),
  ).toEqual([expect.stringMatching(/repositoryType/)]);
});

test('checkRegister reports a self-loop and a cycle through three entries', () => {
  expect(checkRegister([derived('x', ['x'], (x) => x)])).toEqual([expect.stringMatching(/cycle/)]);
  expect(
    checkRegister([
      derived('x', ['y'], (y) => y),
      derived('y', ['z'], (z) => z),
      derived('z', ['x'], (x) => x),
    ]),
  ).toEqual([expect.stringMatching(/cycle/)]);
});

test("the comment cap is derived from GitHub's byte limit so any body within it fits", () => {
  const bytes = limit('github.comment.maxBodyBytes');
  const cap = limit('comment.maxBodyCodeUnits');
  expect(limitEntry('comment.maxBodyCodeUnits').basis).toMatchObject({
    kind: 'derived',
    inputs: ['github.comment.maxBodyBytes'],
  });
  expect(dependents(REGISTER, 'github.comment.maxBodyBytes')).toContain('comment.maxBodyCodeUnits');
  expect(cap).toBe(Math.floor(bytes / 3));
  // One UTF-16 code unit is at most three UTF-8 bytes; a cap one unit larger could overflow.
  for (const unit of ['a', 'é', 'あ', '\u{1F600}']) {
    const body = unit.repeat(Math.floor(cap / unit.length));
    expect(Buffer.byteLength(body, 'utf8'), unit).toBeLessThanOrEqual(bytes);
  }
  expect(Buffer.byteLength('あ'.repeat(cap + 1), 'utf8')).toBeGreaterThan(bytes);
  expect(limitEntry('github.comment.maxBodyBytes').basis).toMatchObject({
    kind: 'external',
    platformValue: bytes,
    url: expect.stringMatching(
      /^https:\/\/github\.com\/andrewpucci\/dependency-update-advisor\/issues\/381#issuecomment-\d+$/,
    ),
    probe: {
      command: 'npm run probe:comment-limit',
      repositoryType: 'private, user-owned, github.com',
    },
  });
});

test('the evidence timeouts derive from the GitHub processing timeout, the cap and the probes', () => {
  expect(limitEntry('github.processingTimeoutMs').basis).toMatchObject({
    kind: 'external',
    platformValue: 10_000,
  });
  for (const [id, command] of [
    ['upstream.throughputBytesPerSecond', 'npm run probe:upstream-throughput'],
    ['osv.slowestResponseMs', 'npm run probe:osv-latency'],
  ] as const)
    expect(limitEntry(id).basis).toMatchObject({ kind: 'external', probe: { command } });
  expect(limit('evidence.envelope.requestTimeoutMs')).toBe(
    limit('github.processingTimeoutMs') +
      Math.ceil(
        (limit('evidence.envelope.maxResponseBytes') * 1000) /
          limit('upstream.throughputBytesPerSecond'),
      ),
  );
  expect(limit('evidence.envelope.requestTimeoutMs')).toBe(11_639);
  expect(limit('github.requestTimeoutMs')).toBe(limit('evidence.envelope.requestTimeoutMs'));
  expect(limit('evidence.allocation.advisory.maxRequests')).toBe(221);
  expect(limit('evidence.allocation.upstream.maxTotalBytes')).toBe(76_800_000);
});

test('the evidence deadline is an adopter setting whose hard maximum leaves one model call', () => {
  const deadline = limitEntry('evidence.envelope.totalTimeoutMs');
  expect(deadline.basis.kind).toBe('config');
  expect(deadline.configurable).toMatchObject({
    default: 240_000,
    maximum: 'job.maxEvidenceDeadlineMs',
  });
  expect(limit('job.maxEvidenceDeadlineMs')).toBe(
    limit('job.window') -
      limit('freshness.readsPerCheck') * limit('github.requestTimeoutMs') -
      limit('analysis.requestTimeoutMs') -
      limit('analysis.publicationReserveMs') -
      limit('job.freshnessAllowance'),
  );
  expect(limit('evidence.envelope.totalTimeoutMs')).toBeLessThanOrEqual(
    limit('job.maxEvidenceDeadlineMs'),
  );
  // The freshness allowance and the publication reserve are sequential GitHub requests at the
  // request timeout, so the hard maximum follows that timeout (L11, #383).
  expect(limit('job.freshnessAllowance')).toBe(
    limit('freshness.readsPerCheck') * limit('github.requestTimeoutMs'),
  );
  expect(limit('analysis.publicationReserveMs')).toBe(5 * limit('github.requestTimeoutMs'));
  expect(limit('job.maxEvidenceDeadlineMs')).toBe(471_971);
  // The window-derived research ceilings follow the setting (L11, Q1(a)).
  const definitions = [...REGISTER.values()].map(({ value, ...entry }): LimitDefinition =>
    entry.basis.kind === 'derived' ? entry : { ...entry, value },
  );
  const longer = buildRegister(
    definitions,
    new Map([['evidence.envelope.totalTimeoutMs', 2 * limit('evidence.envelope.totalTimeoutMs')]]),
  );
  expect(longer.get('evidence.allocation.advisory.maxRequests')?.value).toBe(443);
  expect(longer.get('evidence.allocation.upstream.maxTotalBytes')?.value).toBe(153_600_000);
  expect(settingProblems(REGISTER)).toEqual([]);
});

test('the GitHub read shares keep their sources and formulas', () => {
  expect(limit('evidence.allocation.transport.freshness.maxRequests')).toBe(
    limit('freshness.startupReads') +
      limit('freshness.entryReads') +
      limit('freshness.checksPerRun') * limit('freshness.readsPerCheck'),
  );
  expect(limit('evidence.allocation.transport.freshness.maxRequests')).toBe(17);
  expect(limit('evidence.allocation.transport.freshness.maxTotalBytes')).toBe(
    17 * limit('github.maxResponseBytes'),
  );
  expect(limit('github.token.requestCapMax')).toBe(
    limit('github.token.restRequestsPerHour') -
      limit('evidence.allocation.transport.freshness.maxRequests'),
  );
  for (const id of [
    'evidence.allocation.transport.snapshot.maxRequests',
    'evidence.allocation.upstream.maxRequests',
    'evidence.allocation.signals.readers.upstream.maxRequests',
  ] as const)
    expect(limitEntry(id).configurable, id).toMatchObject({
      maximum: 'github.token.requestCapMax',
      joint: true,
    });
  expect(limitEntry('github.compareMaxFiles').basis).toMatchObject({
    kind: 'external',
    platformValue: 300,
  });
  expect(limit('upstream.releasePageSize')).toBe(limit('github.pageSize'));
  expect(limit('snapshot.maxTreeEntries')).toBe(
    Math.floor(
      limit('evidence.allocation.transport.snapshot.maxTotalBytes') /
        limit('snapshot.minTreeEntryBytes'),
    ),
  );
  expect(limit('snapshot.minTreeEntryBytes')).toBe(92);
  expect(limit('snapshot.maxTreeEntries')).toBe(102_578);
});

test('the session reads follow GitHub file-list limits, and workflow files stay within them', () => {
  expect(limit('w2.session.maxPages')).toBe(
    Math.ceil(limit('github.treeMaxFiles') / limit('github.pageSize')),
  );
  expect(limit('w2.session.maxPages')).toBe(30);
  expect(limit('w2.session.maxFiles')).toBe(limit('github.treeMaxFiles'));
  expect(limitEntry('w2.actions.maxFileBytes').basis).toMatchObject({
    kind: 'external',
    platformValue: 500_000,
  });
  // A workflow file is read by the session reader, so its cap may not exceed the session's.
  expect(limit('w2.actions.maxFileBytes')).toBeLessThanOrEqual(limit('w2.session.maxFileBytes'));
  expect(limitEntry('evidence.allocation.session.maxRequests').configurable).toMatchObject({
    maximum: 'github.token.requestCapMax',
    joint: true,
  });
  // The session share must still hold every file-list page.
  expect(limit('evidence.allocation.session.maxRequests')).toBeGreaterThan(
    limit('w2.session.maxPages'),
  );
  expect(limitEntry('w2.actions.maxYamlDepth').basis.kind).toBe('safety');
});

test('the uv and npm collection bounds keep their sources and formulas', () => {
  const lockBytes = 2 * limit('w2.uv.maxRoots') * limit('w2.uv.maxFileBytes');
  expect(limit('w2.uv.maxPackages')).toBe(Math.floor(lockBytes / limit('uv.minRecordBytes')));
  expect(limit('w2.uv.maxEdges')).toBe(Math.floor(lockBytes / limit('uv.minRecordBytes')));
  expect(limit('w2.uv.maxDeclarations')).toBe(
    Math.floor((2 * lockBytes) / limit('uv.minRecordBytes')),
  );
  expect(limit('w2.uv.maxPackages')).toBe(10_000_000);
  expect(limit('w2.npm.maxFileBytes')).toBe(limit('w2.session.maxFileBytes'));
  for (const id of ['w2.npm.maxRoots', 'w2.uv.maxRoots'] as const) {
    expect(limitEntry(id).configurable, id).toMatchObject({ maximum: 'dependabot.maxRoots' });
    expect(limit(id), id).toBeLessThanOrEqual(limit('dependabot.maxRoots'));
  }
  for (const id of [
    'w2.npm.maxJsonDepth',
    'w2.registry.maxJsonDepth',
    'w2.uv.maxTomlDepth',
    'w2.uv.maxMarkerDepth',
    'w2.uv.maxStringBytes',
    'w2.uv.maxRequirementTokens',
    'npm.maxIntegrityCodeUnits',
  ] as const)
    expect(limitEntry(id).basis.kind, id).toBe('safety');
});

test('the Q8(a) parse-count bounds whose check passed are safety and cite the parse-cost probe', () => {
  // L11 Q8(a), #383: each cites its largest legitimate use and its harm from npm run probe:parse-cost.
  for (const [id, counter] of [
    ['dependabot.maxYamlNodes', 'dependabot-nodes'],
    ['dependabot.maxUpdates', 'dependabot-updates'],
    ['dependabot.maxRoots', 'dependabot-roots'],
    ['uv.maxCorroborationCodeUnits', 'claims'],
  ] as const) {
    const { basis } = limitEntry(id);
    expect(basis.kind, id).toBe('safety');
    expect(basis.kind === 'safety' && basis.reason, id).toContain(
      `npm run probe:parse-cost -- harm ${counter}`,
    );
    expect(basis.kind === 'safety' && basis.reason, id).toContain(
      'npm run probe:parse-cost -- use',
    );
  }
});

test('every parse-cost counter the register cites is one the probe runs', () => {
  // Reasons and stop notes alike: a cited counter the probe does not have cannot be re-run.
  const counters: readonly string[] = COUNTERS;
  const cited = [...REGISTER.values()].flatMap((entry) =>
    [...JSON.stringify(entry).matchAll(/probe:parse-cost -- harm ([a-z-]+)/gu)].map(
      ([, counter]) => [entry.id, counter] as const,
    ),
  );
  expect(cited.length).toBeGreaterThan(0);
  for (const [id, counter] of cited) expect(counters, `${id} cites ${counter}`).toContain(counter);
});

test('the research and signal bounds keep their sources and formulas', () => {
  // The coverage setting's hard maximum is the upstream request ceiling (Q9(a)); a listed release
  // outside the range costs no request beyond its page, so it is not a per-candidate bound.
  expect(limitEntry('research.maxTagCandidates').configurable).toMatchObject({
    maximum: 'evidence.allocation.upstream.maxRequests',
  });
  expect(limit('research.maxTagCandidates')).toBeLessThanOrEqual(
    limit('evidence.allocation.upstream.maxRequests'),
  );
  // One npm read per side of a change; the stage and research sums follow.
  for (const id of [
    'evidence.allocation.signals.readers.publishTimes.maxRequests',
    'evidence.allocation.signals.readers.registry.maxRequests',
  ] as const)
    expect(limit(id), id).toBe(2 * limit('packet.changes'));
  const readers = ['malware', 'publishTimes', 'registry', 'metadata', 'upstream'] as const;
  const signals = readers.reduce(
    (total, reader) => total + limit(`evidence.allocation.signals.readers.${reader}.maxRequests`),
    0,
  );
  expect(limit('evidence.allocation.signals.maxRequests')).toBe(signals);
  expect(limit('research.githubQuota.researchCeiling')).toBe(
    limit('evidence.allocation.upstream.maxRequests') +
      limit('evidence.allocation.advisory.maxRequests') +
      signals,
  );
  for (const id of ['research.maxJsonDepth', 'research.maxTagDepth'] as const)
    expect(limitEntry(id).basis.kind, id).toBe('safety');
});

test('the analysis request and unit caps derive from the context window', () => {
  for (const id of ['analysis.model.contextTokens', 'analysis.model.templateTokens'] as const)
    expect(limitEntry(id).basis.kind, id).toBe('external');
  expect(limit('analysis.requestBytes')).toBe(
    limit('analysis.model.contextTokens') -
      limit('analysis.completionTokens') -
      limit('analysis.model.templateTokens'),
  );
  expect(limit('analysis.requestBytes')).toBe(245_755);
  // A lone unit at the cap, every byte JSON-escaped to two, fits beside the fixed request. The
  // run-wide projection fields are not counted; see the analysis.unitBytes description.
  expect(limit('analysis.fixedRequestBytes') + 2 * limit('analysis.unitBytes')).toBeLessThanOrEqual(
    limit('analysis.requestBytes'),
  );
  expect(limit('analysis.unitBytes')).toBe(
    Math.floor((limit('analysis.requestBytes') - limit('analysis.fixedRequestBytes')) / 2),
  );
  expect(limit('analysis.sourceBytes')).toBe(limit('packet.textBytes'));
  expect(limit('analysis.references')).toBe(limit('packet.listEntries'));
  // The request follows the completion setting it shares the window with (L11, Q1(a)).
  for (const id of ['analysis.requestBytes', 'analysis.unitBytes', 'packet.textBytes'] as const)
    expect(dependents(REGISTER, 'analysis.completionTokens'), id).toContain(id);
});

test('the analysis settings are bounded by the change limit, the calls it needs and the job', () => {
  expect(limitEntry('analysis.maxUnits').configurable).toMatchObject({
    maximum: 'packet.changes',
  });
  expect(limitEntry('analysis.maxCalls').configurable).toMatchObject({
    maximum: 'analysis.maxCallsMax',
  });
  expect(limit('analysis.maxCallsMax')).toBe(240);
  expect(limitEntry('analysis.requestTimeoutMs').configurable).toMatchObject({
    maximum: 'job.maxAnalysisTimeMs',
  });
  expect(limit('job.maxAnalysisTimeMs')).toBe(
    limit('job.window') -
      limit('evidence.envelope.totalTimeoutMs') -
      limit('freshness.readsPerCheck') * limit('github.requestTimeoutMs') -
      limit('analysis.publicationReserveMs') -
      limit('job.freshnessAllowance'),
  );
  expect(limit('job.maxAnalysisTimeMs')).toBe(471_971);
  for (const id of [
    'analysis.textBytes',
    'analysis.featureBytes',
    'analysis.maxContentChunks',
    'analysis.maxProjectionDepth',
  ] as const)
    expect(limitEntry(id).basis.kind, id).toBe('safety');
  expect(settingProblems(REGISTER)).toEqual([]);
});

test('the advisory discovery bounds keep their sources and formulas', () => {
  expect(limitEntry('advisory.discovery.urlBytes').basis).toMatchObject({
    kind: 'external',
    platformValue: 5_694,
    probe: { command: 'npm run probe:batching' },
  });
  expect(limit('advisory.discovery.pageSize')).toBe(limit('github.pageSize'));
  expect(limit('advisory.batch.pageSize')).toBe(limit('advisory.discovery.pageSize'));
  expect(limit('advisory.batch.urlBytes')).toBe(limit('advisory.discovery.urlBytes'));
  expect(DISCOVERY_PAGE_SIZES).toEqual([100, 50, 25, 5, 1]);
  expect(Object.isFrozen(DISCOVERY_PAGE_SIZES)).toBe(true);
});

test('no heap setting at its hard maximum takes packet.bytes below its floor', () => {
  const definitions = [...REGISTER.values()].map(({ value, ...entry }): LimitDefinition =>
    entry.basis.kind === 'derived' ? entry : { ...entry, value },
  );
  const at = (id: LimitId, value: number) => buildRegister(definitions, new Map([[id, value]]));
  const floor = limit('packet.floorBytes');
  expect(limitEntry('packet.floorBytes').basis).toMatchObject({
    kind: 'derived',
    inputs: ['packet.changes', 'packet.listEntries'],
  });
  expect(floor).toBeLessThanOrEqual(limit('packet.bytes'));
  // Each heap maximum is the largest value at which the packet cap holds the floor, and one more
  // takes it below the floor.
  const cases: [LimitId, LimitId, number][] = [
    ['analysis.maxConcurrentCalls', 'analysis.maxConcurrentCallsMax', 8],
    // 71,091 before the 25,000,001-byte event buffer was counted off heap (L11, item 11).
    ['analysis.completionTokens', 'analysis.completionTokensMax', 70_807],
  ];
  for (const [id, maximum, value] of cases) {
    expect(limitEntry(id).configurable, id).toMatchObject({ maximum });
    expect(limit(maximum), maximum).toBe(value);
    expect(hardMaximum(REGISTER, id), id).toBe(value);
    expect(at(id, value).get('packet.bytes')?.value, id).toBeGreaterThanOrEqual(floor);
    expect(at(id, value + 1).get('packet.bytes')?.value, id).toBeLessThan(floor);
  }
  // At 8 calls the packet cap is 23,820,778 bytes; at 9 it is negative.
  expect(at('analysis.maxConcurrentCalls', 8).get('packet.bytes')?.value).toBe(23_820_778);
  // The concurrency maximum never passes the calls a run may make.
  expect(limit('analysis.maxConcurrentCallsMax')).toBeLessThanOrEqual(limit('analysis.maxCalls'));
  // The token maximum never passes the Q14(a) bound, the context less the smallest request.
  expect(limit('analysis.completionTokensMax')).toBeLessThanOrEqual(
    limit('analysis.model.contextTokens') -
      limit('analysis.fixedRequestBytes') -
      limit('analysis.model.templateTokens'),
  );
  // The Q10 joint maximum is sized beside a packet at the floor, not at today's packet cap, so it
  // leaves headroom above the sum of the defaults; one share raised to it leaves the floor.
  const members = Q10_RETAINED_INPUTS.filter(
    (id) => id !== 'research.maxRetainedBytes' && id !== 'config.maxBytes',
  );
  const defaults = members.reduce((total, id) => total + limit(id), 0);
  // 126,100,507 at the 16 KiB config cap; the 1 MiB cap (L11, item 9) takes 1,032,192 more and
  // the event buffer counted off heap (L11, item 11) 916,121 more.
  expect(limit('runner.maxEvidenceRetainedBytes')).toBe(124_152_194);
  expect(limit('runner.maxEvidenceRetainedBytes')).toBeGreaterThan(defaults);
  const share = 'evidence.allocation.session.maxTotalBytes';
  const raised = hardMaximum(REGISTER, share);
  expect(raised).toBe(limit('runner.maxEvidenceRetainedBytes') - defaults + limit(share));
  expect(at(share, raised).get('packet.bytes')?.value).toBeGreaterThanOrEqual(floor);
  expect(at(share, raised + 1).get('packet.bytes')?.value).toBeLessThan(floor);
  // check:limits reports a register whose packet cap falls below the floor.
  const below = buildRegister(
    definitions.map((entry) =>
      entry.id === 'runner.unitExpansionHeapBytes' ? { ...entry, value: limit('runner.heapBytes') } : entry,
    ),
  );
  expect(settingProblems(below)).toContain('packet.bytes: below limit:packet.floorBytes at the defaults');
  expect(settingProblems(REGISTER)).toEqual([]);
});
