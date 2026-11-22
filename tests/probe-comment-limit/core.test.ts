import { expect, test } from 'vite-plus/test';
import {
  UNITS,
  asciiBody,
  classifyUnit,
  classifyWrite,
  counts,
  findLimit,
  lineBreakBody,
  raiseAllowed,
  runProbe,
  statedMaximum,
  unitBodies,
  type ProbeOutcome,
  type Unit,
  type WriteKind,
  type WriteResult,
} from '../../scripts/probe-comment-limit/core.js';

const ASTRAL = '\u{1F600}';
const TWO_BYTE = 'é';
const THREE_BYTE = 'あ';

type FakeRules = {
  unit: Unit;
  limit: number;
  /** A second cap in UTF-8 bytes, applied on top of `unit`. */
  byteCap?: number;
  /** How many units GitHub counts for each line break (LF normalized to CRLF counts 2). */
  lineBreakWeight?: number;
  /** A different limit for update than for create. */
  updateLimit?: number;
};

/** A fake GitHub that counts the body in one unit and answers as the probe expects. */
function fakeGitHub(rules: FakeRules) {
  const sent: { kind: WriteKind; text: string }[] = [];
  const write = async (kind: WriteKind, text: string): Promise<WriteResult> => {
    sent.push({ kind, text });
    const breaks = text.split('\n').length - 1;
    const size = counts(text)[rules.unit] + breaks * ((rules.lineBreakWeight ?? 1) - 1);
    const cap = kind === 'update' ? (rules.updateLimit ?? rules.limit) : rules.limit;
    const tooLong =
      size > cap || (rules.byteCap !== undefined && counts(text).bytes > rules.byteCap);
    return tooLong
      ? {
          outcome: 'rejected',
          status: 422,
          message: `Body is too long (maximum is ${rules.limit} characters)`,
        }
      : { outcome: 'accepted', status: kind === 'create' ? 201 : 200 };
  };
  return { write, sent };
}

test('each unit body has exactly the code points, code units, and bytes in the A2 table', () => {
  for (const L of [10, 11]) {
    const k = Math.floor(L / 2);
    const bodies = Object.fromEntries(unitBodies(L).map((body) => [body.name, body.text]));
    expect(counts(asciiBody(L)), `${L} ascii`).toEqual({
      'code points': L,
      'code units': L,
      bytes: L,
    });
    expect(counts(bodies.astral ?? ''), `${L} astral`).toEqual({
      'code points': k,
      'code units': 2 * k,
      bytes: 4 * k,
    });
    expect(counts(bodies.astralPlusOne ?? ''), `${L} astral+1`).toEqual({
      'code points': k + 1,
      'code units': 2 * k + 2,
      bytes: 4 * k + 4,
    });
    expect(counts(bodies.twoByte ?? ''), `${L} two-byte`).toEqual({
      'code points': L,
      'code units': L,
      bytes: 2 * L,
    });
    expect(counts(bodies.threeByte ?? ''), `${L} three-byte`).toEqual({
      'code points': L,
      'code units': L,
      bytes: 3 * L,
    });
    expect(bodies.astral).toBe(ASTRAL.repeat(k));
    expect(bodies.twoByte).toBe(TWO_BYTE.repeat(L));
    expect(bodies.threeByte).toBe(THREE_BYTE.repeat(L));
  }
});

test('the k-copy bodies keep 2k <= L and 2k + 2 > L for an even and an odd L', () => {
  for (const L of [2, 3, 64, 65, 65_536, 65_537]) {
    const bodies = Object.fromEntries(unitBodies(L).map((body) => [body.name, body.text]));
    expect(counts(bodies.astral ?? '')['code units'], String(L)).toBeLessThanOrEqual(L);
    expect(counts(bodies.astralPlusOne ?? '')['code units'], String(L)).toBeGreaterThan(L);
  }
});

test('the line-break body is L ASCII code units with every other one a line feed', () => {
  for (const L of [10, 11]) {
    const body = lineBreakBody(L);
    expect(counts(body)).toEqual({ 'code points': L, 'code units': L, bytes: L });
    expect(body.split('\n')).toHaveLength(Math.floor(L / 2) + 1);
    expect(body).not.toContain('\r');
  }
});

test('a write is accepted only on the expected success status with the same body returned', () => {
  expect(classifyWrite('create', 'abc', { status: 201, data: { body: 'abc' } })).toEqual({
    outcome: 'accepted',
    status: 201,
  });
  expect(classifyWrite('update', 'abc', { status: 200, data: { body: 'abc' } }).outcome).toBe(
    'accepted',
  );
  // The wrong success status for the kind of write is not acceptance.
  expect(classifyWrite('create', 'abc', { status: 200, data: { body: 'abc' } }).outcome).toBe(
    'inconclusive',
  );
});

test('a success whose returned body differs from the one sent is inconclusive', () => {
  for (const returned of ['ab', 'abc\r\n', 'ABC', undefined]) {
    expect(
      classifyWrite('create', 'abc', { status: 201, data: { body: returned } }),
      String(returned),
    ).toMatchObject({ outcome: 'inconclusive' });
  }
});

test('only a 422 with a too-long body error is a rejection, and its message is kept', () => {
  const tooLong = {
    message: 'Validation Failed',
    errors: [
      {
        resource: 'IssueComment',
        code: 'custom',
        field: 'body',
        message: 'body is too long (maximum is 65536 characters)',
      },
    ],
  };
  expect(classifyWrite('create', 'x', { status: 422, data: tooLong })).toEqual({
    outcome: 'rejected',
    status: 422,
    message: 'body is too long (maximum is 65536 characters)',
  });
});

test('any other 422, such as submitted too quickly, is inconclusive, never a rejection', () => {
  const answers = [
    {
      message: 'Validation Failed',
      errors: [{ field: 'body', message: 'was submitted too quickly' }],
    },
    { message: 'Validation Failed', errors: [{ field: 'title', message: 'is too long' }] },
    { message: 'Validation Failed', errors: [] },
    { message: 'Validation Failed' },
  ];
  for (const data of answers)
    expect(classifyWrite('create', 'x', { status: 422, data }), JSON.stringify(data)).toMatchObject(
      { outcome: 'inconclusive', status: 422 },
    );
});

test('a 403, 429, 5xx, or network error is inconclusive, never a rejection', () => {
  for (const status of [403, 429, 500, 502])
    expect(classifyWrite('create', 'x', { status, data: {} }), String(status)).toMatchObject({
      outcome: 'inconclusive',
      status,
    });
  expect(classifyWrite('create', 'x', { error: 'socket hang up' })).toMatchObject({
    outcome: 'inconclusive',
  });
});

test('statedMaximum reads the maximum from a too-long message and nothing else', () => {
  expect(statedMaximum('body is too long (maximum is 65536 characters)')).toBe(65_536);
  expect(statedMaximum('Body is too long (maximum is 12 characters)')).toBe(12);
  expect(statedMaximum('body is too long')).toBeUndefined();
  expect(statedMaximum(undefined)).toBeUndefined();
});

test('the unit classifier names each unit from its own expected outcomes', () => {
  for (const unit of UNITS)
    for (const L of [64, 65]) {
      const outcomes = [asciiBody(L), asciiBody(L + 1), ...unitBodies(L).map((b) => b.text)].map(
        (text) => ({
          text,
          outcome: counts(text)[unit] > L ? ('rejected' as const) : ('accepted' as const),
        }),
      );
      expect(classifyUnit(L, outcomes), `${unit} ${L}`).toBe(unit);
    }
});

test('code points with a second byte cap are inconclusive, not UTF-16', () => {
  const L = 64;
  const outcomes = [asciiBody(L), asciiBody(L + 1), ...unitBodies(L).map((b) => b.text)].map(
    (text) => ({
      text,
      outcome:
        counts(text)['code points'] > L || counts(text).bytes > 2 * L + 2
          ? ('rejected' as const)
          : ('accepted' as const),
    }),
  );
  // Without the three-byte row these outcomes would read exactly as UTF-16.
  const withoutThreeByte = outcomes.filter(({ text }) => !text.includes(THREE_BYTE));
  expect(classifyUnit(L, withoutThreeByte)).toBe('code units');
  expect(classifyUnit(L, outcomes)).toBe('inconclusive');
});

test('a mixed outcome set that fits no single unit is inconclusive', () => {
  const L = 64;
  const outcomes = [asciiBody(L), asciiBody(L + 1), ...unitBodies(L).map((b) => b.text)].map(
    (text) => ({
      text,
      outcome: text.includes(TWO_BYTE) ? ('rejected' as const) : ('accepted' as const),
    }),
  );
  expect(classifyUnit(L, outcomes)).toBe('inconclusive');
});

test('a rejection that states M leads to exactly the M and M + 1 tests', async () => {
  const github = fakeGitHub({ unit: 'code units', limit: 1_000 });
  await expect(findLimit(4_000, github.write)).resolves.toEqual({ limit: 1_000 });
  expect(github.sent.map(({ text }) => text.length)).toEqual([4_000, 1_000, 1_001]);
});

test('a rejection that states no maximum leads to the halving search', async () => {
  const github = fakeGitHub({ unit: 'code units', limit: 1_000 });
  const silent = async (kind: WriteKind, text: string): Promise<WriteResult> => {
    const result = await github.write(kind, text);
    return result.outcome === 'rejected' ? { ...result, message: 'body is too long' } : result;
  };
  await expect(findLimit(4_000, silent)).resolves.toEqual({ limit: 1_000 });
  const lengths = github.sent.map(({ text }) => text.length);
  expect(lengths[0]).toBe(4_000);
  expect(lengths).toContain(1_000);
  expect(lengths).toContain(1_001);
  expect(lengths.length).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(4_000)));
});

test('a wrong stated maximum falls back to halving and still finds the limit', async () => {
  for (const stated of [1_000, 800]) {
    const github = fakeGitHub({ unit: 'code units', limit: 900 });
    const misstated = async (kind: WriteKind, text: string): Promise<WriteResult> => {
      const result = await github.write(kind, text);
      return result.outcome === 'rejected'
        ? { ...result, message: `body is too long (maximum is ${stated} characters)` }
        : result;
    };
    await expect(findLimit(4_000, misstated), String(stated)).resolves.toEqual({ limit: 900 });
  }
});

test('the search is inconclusive when the first body is accepted or a write is inconclusive', async () => {
  const github = fakeGitHub({ unit: 'code units', limit: 10_000 });
  await expect(findLimit(4_000, github.write)).resolves.not.toHaveProperty('limit');
  let calls = 0;
  const limited = async (): Promise<WriteResult> =>
    ++calls === 1
      ? { outcome: 'rejected', status: 422, message: 'body is too long' }
      : { outcome: 'inconclusive', status: 429, reason: 'rate limited' };
  await expect(findLimit(4_000, limited)).resolves.not.toHaveProperty('limit');
  expect(calls).toBe(2);
});

test('the probe names each unit against a fake GitHub that counts in it', async () => {
  for (const unit of UNITS)
    for (const limit of [64, 65]) {
      const github = fakeGitHub({ unit, limit });
      const outcome = await runProbe({ firstLength: 1_000, write: github.write });
      expect(outcome, `${unit} ${limit}`).toMatchObject({
        unit,
        limit,
        update: 'agrees',
        lineBreaks: 'accepted',
      });
    }
});

test('the probe reports a differing update limit and a rejected line-break body', async () => {
  const differs = await runProbe({
    firstLength: 1_000,
    write: fakeGitHub({ unit: 'code units', limit: 64, updateLimit: 63 }).write,
  });
  expect(differs).toMatchObject({ unit: 'code units', update: 'differs' });
  const crlf = await runProbe({
    firstLength: 1_000,
    write: fakeGitHub({ unit: 'code units', limit: 64, lineBreakWeight: 2 }).write,
  });
  expect(crlf).toMatchObject({ unit: 'code units', lineBreaks: 'rejected' });
});

test('the probe records each write by body name, length, and status, never its text', async () => {
  const outcome = await runProbe({
    firstLength: 1_000,
    write: fakeGitHub({ unit: 'code units', limit: 64 }).write,
  });
  expect(outcome.writes.length).toBeGreaterThan(0);
  for (const record of outcome.writes) {
    expect(Object.keys(record).sort()).toEqual(['body', 'codeUnits', 'kind', 'outcome', 'status']);
  }
  expect(JSON.stringify(outcome)).not.toContain('a'.repeat(32));
});

test('the probe stops at the first inconclusive write', async () => {
  let calls = 0;
  const github = fakeGitHub({ unit: 'code units', limit: 64 });
  const write = async (kind: WriteKind, text: string): Promise<WriteResult> =>
    ++calls === 5
      ? { outcome: 'inconclusive', status: 403, reason: 'forbidden' }
      : github.write(kind, text);
  const outcome = await runProbe({ firstLength: 1_000, write });
  expect(outcome.unit).toBe('inconclusive');
  expect(calls).toBe(5);
});

const outcome = (overrides: Partial<ProbeOutcome>): ProbeOutcome => ({
  unit: 'code units',
  limit: 64,
  update: 'agrees',
  lineBreaks: 'accepted',
  writes: [],
  ...overrides,
});

test('a raise is allowed only for code units or code points that agree and accept line breaks', () => {
  expect(raiseAllowed(outcome({}))).toBe(true);
  expect(raiseAllowed(outcome({ unit: 'code points' }))).toBe(true);
  expect(raiseAllowed(outcome({ unit: 'bytes' }))).toBe(false);
  expect(raiseAllowed(outcome({ unit: 'inconclusive' }))).toBe(false);
  expect(raiseAllowed(outcome({ update: 'differs' }))).toBe(false);
  expect(raiseAllowed(outcome({ lineBreaks: 'rejected' }))).toBe(false);
});

test('an update limit above the create limit is reported as differs, so no raise follows', async () => {
  const outcome = await runProbe({
    firstLength: 1_000,
    write: fakeGitHub({ unit: 'code units', limit: 64, updateLimit: 65 }).write,
  });
  expect(outcome).toMatchObject({ unit: 'code units', update: 'differs' });
  expect(raiseAllowed(outcome)).toBe(false);
});

test('the halving search finds every limit exactly when no maximum is stated', async () => {
  for (let L = 1; L < 300; L++) {
    const github = fakeGitHub({ unit: 'code units', limit: L });
    const silent = async (kind: WriteKind, text: string): Promise<WriteResult> => {
      const result = await github.write(kind, text);
      return result.outcome === 'rejected' ? { ...result, message: 'body is too long' } : result;
    };
    expect(await findLimit(1_000, silent), String(L)).toEqual({ limit: L });
  }
});

/** A fake GitHub whose nth write of one kind is inconclusive. */
function failingNth(kind: WriteKind, nth: number) {
  const github = fakeGitHub({ unit: 'code units', limit: 64 });
  let seen = 0;
  return async (writeKind: WriteKind, text: string): Promise<WriteResult> =>
    writeKind === kind && ++seen === nth
      ? { outcome: 'inconclusive', status: 429, reason: 'rate limited' }
      : github.write(writeKind, text);
}

test('an inconclusive update makes the whole result inconclusive', async () => {
  for (const nth of [1, 2]) {
    const outcome = await runProbe({ firstLength: 1_000, write: failingNth('update', nth) });
    expect(outcome, String(nth)).toMatchObject({
      unit: 'inconclusive',
      update: 'inconclusive',
      lineBreaks: 'not run',
    });
    expect(raiseAllowed(outcome)).toBe(false);
  }
});

test('an inconclusive line-break write makes the whole result inconclusive', async () => {
  // Creates: the first body, M, M + 1, four unit bodies, then the line-break body.
  const outcome = await runProbe({ firstLength: 1_000, write: failingNth('create', 8) });
  expect(outcome).toMatchObject({
    unit: 'inconclusive',
    update: 'agrees',
    lineBreaks: 'inconclusive',
  });
  expect(raiseAllowed(outcome)).toBe(false);
});

test('a raise is not allowed when the update or line-break step is inconclusive or not run', () => {
  for (const update of ['inconclusive', 'not run'] as const)
    expect(raiseAllowed(outcome({ update })), update).toBe(false);
  for (const lineBreaks of ['inconclusive', 'not run'] as const)
    expect(raiseAllowed(outcome({ lineBreaks })), lineBreaks).toBe(false);
});

test('an unclassified 422 keeps GitHub validation messages, capped, without links', () => {
  const data = {
    message: 'Validation Failed',
    errors: [
      'Body is too long (maximum is 262144 characters)',
      { resource: 'IssueComment', code: 'custom', field: 'body', message: 'x'.repeat(40) },
      { resource: 'IssueComment', code: 'invalid' },
      7,
    ],
    documentation_url: 'https://docs.github.com/rest/issues/comments#create-an-issue-comment',
  };
  const result = classifyWrite('create', 'x', { status: 422, data }, { detailCodeUnits: 16 });
  expect(result).toMatchObject({ outcome: 'inconclusive', status: 422 });
  expect('detail' in result && result.detail).toEqual([
    'Validation Faile',
    'Body is too long',
    'x'.repeat(16),
    'invalid',
  ]);
  expect(JSON.stringify(result)).not.toContain('docs.github.com');
});

test('only an unclassified 422 carries detail', () => {
  const options = { detailCodeUnits: 64 };
  expect(
    classifyWrite('create', 'x', { status: 429, data: { message: 'slow down' } }, options),
  ).not.toHaveProperty('detail');
  const tooLong = { errors: [{ field: 'body', message: 'body is too long' }] };
  expect(classifyWrite('create', 'x', { status: 422, data: tooLong }, options)).not.toHaveProperty(
    'detail',
  );
});

test('the probe record keeps the detail of an unclassified 422', async () => {
  const write = async (): Promise<WriteResult> => ({
    outcome: 'inconclusive',
    status: 422,
    reason: 'a 422 that is not a too-long body error',
    detail: ['Validation Failed'],
  });
  const outcome = await runProbe({ firstLength: 1_000, write });
  expect(outcome.writes).toEqual([
    {
      kind: 'create',
      body: 'ascii',
      codeUnits: 1_000,
      status: 422,
      outcome: 'inconclusive',
      detail: ['Validation Failed'],
    },
  ]);
});
