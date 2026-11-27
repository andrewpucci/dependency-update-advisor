import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import { PACKET_LIMITS } from './schema.js';
import { COMPARE_PAGE_SIZES, RELEASE_PAGE_SIZES } from './evidence/upstream-read.js';
import {
  PENDING_AUDIT,
  REGISTER,
  buildRegister,
  checkRegister,
  dependents,
  limit,
  limitEntry,
  replyBytesFor,
  type LimitDefinition,
  type LimitId,
} from './limits.js';

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
  expect(packetIds).toHaveLength(14);
});

test('checkRegister names an entry whose basis kind is not one of the five', () => {
  const guessed = { ...unjustified('guessed', 1), basis: { kind: 'guess', note: 'x' } };
  expect(checkRegister([guessed])).toEqual([expect.stringMatching(/guessed/)]);
  expect(checkRegister([{ ...guessed, basis: { kind: 'safety', reason: 'x' } }])).toEqual([]);
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
  expect(dependents(REGISTER, 'job.budget')).toEqual(['job.window']);
});

test('the job budget is derived from the dependabot review workflow timeout', () => {
  expect(dependents(REGISTER, 'workflow.dependabotReview.review.timeoutMinutes')).toEqual(
    expect.arrayContaining(['job.budget', 'job.window']),
  );
  expect(limit('job.budget')).toBe(900_000);
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

test('copies wired: the source-root and candidate bounds are one entry each, read by config and context', () => {
  expect(limit('context.maxSourceRoots')).toBe(16);
  expect(limit('context.maxSourceCandidates')).toBe(128);
  expect(dependents(REGISTER, 'context.maxSourceRoots')).toEqual([]);
  expect(dependents(REGISTER, 'context.maxSourceCandidates')).toEqual([]);
  for (const file of ['src/config.ts', 'src/context.ts']) {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    expect(source, file).toContain("limit('context.maxSourceRoots')");
    expect(source, file).toContain("limit('context.maxSourceCandidates')");
  }
});

test('moved limits that mirror a packet bound are derived from it', () => {
  expect(dependents(REGISTER, 'packet.changes')).toContain('advisories.maxLookups');
  expect(dependents(REGISTER, 'packet.findings')).toContain('research.maxFindings');
  expect(limit('advisories.maxLookups')).toBe(2 * PACKET_LIMITS.changes);
  expect(limit('research.maxFindings')).toBe(PACKET_LIMITS.findings);
});

test('derived packet bounds keep their formulas and the values they had as fixed numbers', () => {
  const cases: [LimitId, LimitId[], number, number][] = [
    ['packet.relationships', ['packet.changes'], 2 * limit('packet.changes'), 256],
    [
      'packet.textBytes',
      ['analysis.unitBytes', 'packet.listEntries'],
      Math.floor(limit('analysis.unitBytes') / limit('packet.listEntries')),
      2_048,
    ],
    ['packet.contextBytes', ['analysis.unitBytes'], limit('analysis.unitBytes'), 65_536],
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
  expect(limitEntry('runner.oldGenerationBytes').basis).toMatchObject({
    kind: 'external',
    platformValue: 2_147_483_648,
  });
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

test('packet.bytes is the packet that fits the runner heap beside the model replies', () => {
  const inputs: LimitId[] = [
    'runner.oldGenerationBytes',
    'analysis.replyHeapBytes',
    'runner.heapBytesPerPacketByte',
  ];
  const { basis } = limitEntry('packet.bytes');
  expect(basis).toMatchObject({ kind: 'derived', inputs });
  if (basis.kind !== 'derived') throw new Error('derived');
  const [heap, replies, perByte] = inputs.map((id) => limit(id));
  expect(limit('packet.bytes')).toBe(Math.floor((heap - replies) / perByte));
  // The packet's own heap and the replies' heap together stay inside the runner heap.
  expect(limit('packet.bytes') * perByte + replies).toBeLessThanOrEqual(heap);
  expect((limit('packet.bytes') + 1) * perByte + replies).toBeGreaterThan(heap);
  expect(basis.formula(1_000, 100, 3)).toBe(300);
  for (const input of ['analysis.responseBytes', 'analysis.maxConcurrentCalls'] as const)
    expect(dependents(REGISTER, input)).toContain('packet.bytes');
  // The snapshot budgets no longer follow the packet cap.
  expect(dependents(REGISTER, 'packet.bytes')).not.toContain('analysis.projectionBytes');
  expect(limit('analysis.projectionBytes')).toBe(8_388_608);
  expect(limit('analysis.projectionEntries')).toBe(1_048_576);
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

test('RELEASE_PAGE_SIZES halves from the register value down to 1 and is frozen', () => {
  expect(RELEASE_PAGE_SIZES).toEqual([64, 32, 16, 8, 4, 2, 1]);
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
