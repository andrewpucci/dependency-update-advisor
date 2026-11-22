import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import {
  PENDING_AMENDMENT,
  citationProblems,
  migrationProblems,
  schemaProblems,
  specProblems,
  testProblems,
  workflowProblems,
} from '../../scripts/limits/check.js';
import { PENDING_AUDIT, REGISTER, limit, type Limit } from '../../src/limits.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FLOOR = limit('checkLimits.specValueFloor');
const SPEC = 'docs/specs/SPEC-example.md';

function entryOf(id: string): Limit {
  const found = REGISTER.get(id);
  if (found === undefined) throw new Error(`no register entry ${id}`);
  return found;
}

function reading(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null;
}

const CLEAN_WORKFLOWS = [
  {
    file: '.github/workflows/dependabot-review.yml',
    text: 'jobs:\n  review:\n    timeout-minutes: 15\n',
  },
  { file: '.github/workflows/ci.yml', text: 'jobs:\n  quality:\n    timeout-minutes: 10\n' },
  {
    file: '.github/workflows/complexity.yml',
    text: 'jobs:\n  report:\n    timeout-minutes: 10\n  comment:\n    timeout-minutes: 5\n',
  },
];

test('the workflow timeouts match their register entries', () => {
  expect(workflowProblems(REGISTER, CLEAN_WORKFLOWS)).toEqual([]);
});

test('a workflow job timeout that differs from its register entry is a problem', () => {
  const workflows = [
    {
      file: '.github/workflows/dependabot-review.yml',
      text: 'jobs:\n  review:\n    timeout-minutes: 16\n',
    },
    CLEAN_WORKFLOWS[1],
    CLEAN_WORKFLOWS[2],
  ];
  const problems = workflowProblems(REGISTER, workflows);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('.github/workflows/dependabot-review.yml:3');
  expect(problems[0]).toContain('review');
});

test('a workflow job with a timeout and no register entry is a problem', () => {
  const workflows = [
    CLEAN_WORKFLOWS[0],
    {
      file: '.github/workflows/ci.yml',
      text: 'jobs:\n  quality:\n    timeout-minutes: 10\n  lint:\n    timeout-minutes: 5\n',
    },
    CLEAN_WORKFLOWS[2],
  ];
  const problems = workflowProblems(REGISTER, workflows);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('workflow.ci.lint.timeoutMinutes');
});

test('a workflow entry with no job in the workflow files is a problem', () => {
  const problems = workflowProblems(REGISTER, CLEAN_WORKFLOWS.slice(0, 2));
  expect(problems).toEqual([
    expect.stringContaining('workflow.complexity.report.timeoutMinutes'),
    expect.stringContaining('workflow.complexity.comment.timeoutMinutes'),
  ]);
});

const SPECS = (text: string) => [{ file: SPEC, text }];

test('a spec line stating a register value above the floor must be allowlisted', () => {
  for (const line of [
    'The cap is at most 3,000 code units.',
    'The cap is at most 3000 code units.',
    'The cap is at most 3_000 code units.',
  ]) {
    expect(specProblems(REGISTER, FLOOR, SPECS(line), [])).toHaveLength(1);
  }
});

test('an allowlisted spec line with a register value passes', () => {
  const line = 'The cap is at most 3,000 code units.';
  const allowlist = [{ file: SPEC, line, values: [3_000], reason: 'test' }];
  expect(specProblems(REGISTER, FLOOR, SPECS(line), allowlist)).toEqual([]);
});

test('a register value at the spec floor, or a non-whole number, is not a problem', () => {
  expect(specProblems(REGISTER, FLOOR, SPECS('The cap is at most 64 items.'), [])).toEqual([]);
  expect(specProblems(REGISTER, FLOOR, SPECS('Read 13,0001 bytes.'), [])).toEqual([]);
  expect(specProblems(REGISTER, FLOOR, SPECS('Use v3000x here.'), [])).toEqual([]);
});

test('an allowlist entry that matches no spec line is a problem', () => {
  const allowlist = [
    { file: SPEC, line: 'The cap is at most 3,000 code units.', values: [3_000], reason: 'test' },
  ];
  const problems = specProblems(REGISTER, FLOOR, SPECS('No numbers on this line.'), allowlist);
  expect(problems).toEqual([expect.stringContaining('matches no spec line')]);
});

test('a limit citation naming an id outside the register is a problem', () => {
  const docs = (text: string) => [{ file: 'docs/adr/example.md', text }];
  expect(citationProblems(REGISTER, docs('See `limit:packet.nope`.'))).toHaveLength(1);
  expect(citationProblems(REGISTER, docs('See `limit:packet.bytes`.'))).toEqual([]);
});

test('a test reference naming a missing title is a problem', () => {
  const only = (patch: Partial<Limit>) =>
    new Map([['packet.bytes', { ...entryOf('packet.bytes'), ...patch }]]);
  const files = {
    'src/schema.test.ts': "test('enforces the exact serialized packet budget', () => {});\n",
  };
  expect(
    testProblems(
      only({ test: 'src/schema.test.ts > enforces the exact serialized packet budget' }),
      reading(files),
    ),
  ).toEqual([]);
  expect(
    testProblems(only({ test: 'src/schema.test.ts > no such title' }), reading(files)),
  ).toHaveLength(1);
  expect(
    testProblems(
      only({ test: 'src/missing.test.ts > enforces the exact serialized packet budget' }),
      reading(files),
    ),
  ).toHaveLength(1);
});

test('an unjustified entry is a problem only while migration is closed', () => {
  expect(migrationProblems(REGISTER, false)).toContainEqual(
    expect.stringContaining('packet.bytes'),
  );
  expect(migrationProblems(REGISTER, true)).toEqual([]);
});

test('a step-level timeout is checked like a job timeout', () => {
  const step = {
    file: '.github/workflows/ci.yml',
    text: 'jobs:\n  quality:\n    timeout-minutes: 10\n    steps:\n      - run: npm test\n        timeout-minutes: 600\n',
  };
  const problems = workflowProblems(REGISTER, [
    ...CLEAN_WORKFLOWS.slice(0, 1),
    step,
    CLEAN_WORKFLOWS[2],
  ]);
  expect(problems).toEqual([
    expect.stringContaining('job quality step 0 has timeout-minutes but no register entry'),
  ]);
});

test('a timeout written through an alias or expression is a problem', () => {
  for (const value of ['*t', '${{ inputs.minutes }}']) {
    const aliased = {
      file: '.github/workflows/ci.yml',
      text: `x: &t 10\njobs:\n  quality:\n    timeout-minutes: ${value}\n`,
    };
    expect(
      workflowProblems(REGISTER, [CLEAN_WORKFLOWS[0], aliased, CLEAN_WORKFLOWS[2]]),
      value,
    ).toContainEqual(expect.stringContaining('must be a literal number'));
  }
});

test('only the unlisted line in a file with an allowlisted one is a problem', () => {
  const text = 'Bodies hold at most 3,000 code units.\nPackets hold at most 128 changes.\n';
  const allowlist = [
    { file: SPEC, line: 'Bodies hold at most 3,000 code units.', values: [3_000], reason: 'x' },
  ];
  const problems = specProblems(REGISTER, FLOOR, [{ file: SPEC, text }], allowlist);
  expect(problems).toEqual([expect.stringContaining(`${SPEC}:2:`)]);
});

test.each([
  ['Parse at most 16 KiB of JSON.', 'config.maxBytes'],
  ['The packet holds at most 1 MiB.', 'packet.bytes'],
  [
    'Each signals reader gets 1.5 MiB.',
    'evidence.allocation.signals.readers.malware.maxTotalBytes',
  ],
  ['Evidence reads end after 240 seconds.', 'evidence.envelope.totalTimeoutMs'],
  ['Evidence reads end after 4 minutes.', 'evidence.envelope.totalTimeoutMs'],
  ['The job has 15 minutes.', 'job.budget'],
])('a value written with a unit is a stated value: %s', (line, id) => {
  const problems = specProblems(REGISTER, FLOOR, [{ file: SPEC, text: `${line}\n` }], []);
  expect(problems).toEqual([expect.stringContaining(String(entryOf(id).value))]);
});

test('a unit only matches entries measured in that unit', () => {
  // 3 seconds is 3,000 ms, and github.treeMaxFiles is 3,000 files: not the same limit.
  expect(entryOf('github.treeMaxFiles').value).toBe(3000);
  const text = 'Retry after 3 seconds.\nTake 10 steps.\nUse 128 KiB of scratch.\n';
  expect(specProblems(REGISTER, FLOOR, [{ file: SPEC, text }], [])).toEqual([]);
});

test('issue references and URLs are not stated values', () => {
  const text = 'Tracked in #3000 and https://example.com/pull/3000 and [x](https://e.com/128).\n';
  expect(specProblems(REGISTER, FLOOR, [{ file: SPEC, text }], [])).toEqual([]);
});

test('a structural test reference is checked like the entry test', () => {
  const entry = entryOf('signals.attemptsPerMember');
  if (entry.basis.kind !== 'derived') throw new Error('expected a derived entry');
  const broken = new Map([
    [
      entry.id,
      {
        ...entry,
        test: 'none: x',
        basis: { ...entry.basis, structuralTest: 'src/a.test.ts > gone' },
      },
    ],
  ]);
  expect(testProblems(broken, reading({ 'src/a.test.ts': "test('here', () => {});\n" }))).toEqual([
    expect.stringContaining("no test('gone'"),
  ]);
});

test('a test.each template or a double-quoted title names a test', () => {
  const only = (title: string) =>
    new Map([['packet.bytes', { ...entryOf('packet.bytes'), test: `src/a.test.ts > ${title}` }]]);
  const files = {
    'src/a.test.ts': [
      "test.each([1, 2])('accepts %s entries', () => {});",
      'test.each([',
      '  [',
      "    'a table label',",
      '    1,',
      '  ],',
      "])('uses %s', () => {});",
      'test.each(cases)(',
      "  'rejects window $value in the parser',",
      '  () => {},',
      ');',
      'test("handles the share\'s byte limit", () => {});',
      '',
    ].join('\n'),
  };
  for (const title of [
    'accepts %s entries',
    'rejects window $value in the parser',
    "handles the share's byte limit",
  ])
    expect(testProblems(only(title), reading(files)), title).toEqual([]);
  // An expanded title is not the template, and a placeholder-free title must be a test() call.
  expect(testProblems(only('accepts 1 entries'), reading(files))).toHaveLength(1);
  expect(testProblems(only('handles the share'), reading(files))).toHaveLength(1);
  // A table row's label is not a test title.
  expect(testProblems(only('a table label'), reading(files))).toHaveLength(1);
});

test('a test title that appears only in a comment is a problem', () => {
  const only = new Map([
    ['packet.bytes', { ...entryOf('packet.bytes'), test: 'src/a.test.ts > gone' }],
  ]);
  const files = { 'src/a.test.ts': "// test('gone', () => {});\nconst s = \"test('gone'\";\n" };
  expect(testProblems(only, reading(files))).toHaveLength(1);
});

test('closing migration reports pending fields and pending allowlist lines', () => {
  // A derived entry whose test the audit has not filled, built here so the real register's
  // progress cannot make this test vacuous.
  const found = [...REGISTER.values()].find((entry) => entry.basis.kind === 'derived');
  if (!found) throw new Error('expected a derived entry');
  const derived: Limit = { ...found, test: PENDING_AUDIT };
  const only = new Map([[derived.id, derived]]);
  const pending = [{ file: SPEC, line: 'x', values: [128], reason: `${PENDING_AMENDMENT} (L10)` }];
  const settled = [{ file: SPEC, line: 'y', values: [128], reason: 'an example, not a limit' }];
  expect(migrationProblems(only, false, pending)).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`${derived.id}: test is still`),
      expect.stringContaining('pending amendment still allowlisted'),
    ]),
  );
  expect(migrationProblems(only, false, settled).some((p) => p.includes('allowlisted'))).toBe(
    false,
  );
  expect(migrationProblems(only, true, pending)).toEqual([]);
});

const SCHEMA = 'schemas/example.json';
const schemaWith = (maxLength: number, minLength = 1) => ({
  file: SCHEMA,
  text: JSON.stringify({ properties: { model: { minLength, maxLength } } }),
});
const MODEL_BOUND = { [`${SCHEMA}#/properties/model/maxLength`]: 'config.maxModelCodeUnits' };

test('a schema bound matching its mapped register entry passes', () => {
  expect(schemaProblems(REGISTER, [schemaWith(128)], MODEL_BOUND)).toEqual([]);
});

test('a schema bound that differs from its register entry is a problem', () => {
  expect(schemaProblems(REGISTER, [schemaWith(129)], MODEL_BOUND)).toEqual([
    expect.stringContaining('schema bound 129 differs from config.maxModelCodeUnits (128)'),
  ]);
});

test('a schema bound with no mapping, or a mapping to an unknown id, is a problem', () => {
  expect(schemaProblems(REGISTER, [schemaWith(128)], {})).toEqual([
    expect.stringContaining('has no register entry'),
  ]);
  expect(
    schemaProblems(REGISTER, [schemaWith(128)], {
      [`${SCHEMA}#/properties/model/maxLength`]: 'config.nope',
    }),
  ).toEqual([expect.stringContaining('config.nope, which is not in the register')]);
});

test('a mapping to a bound the schema lacks is a problem', () => {
  const extra = {
    ...MODEL_BOUND,
    [`${SCHEMA}#/properties/gone/maxItems`]: 'context.maxSourceRoots',
  };
  expect(schemaProblems(REGISTER, [schemaWith(128)], extra)).toEqual([
    expect.stringContaining('names a bound the schema lacks'),
  ]);
});

test('schema bounds of 0 and 1 are positivity checks, not limits', () => {
  const text = JSON.stringify({ properties: { a: { minLength: 1, minimum: 0 } } });
  expect(schemaProblems(REGISTER, [{ file: SCHEMA, text }], {})).toEqual([]);
});

test('a bare limit citation is checked like a backticked one', () => {
  const docs = [{ file: SPEC, text: 'See limit:packet.nope and limit:packet.bytes.\n' }];
  expect(citationProblems(REGISTER, docs)).toEqual([expect.stringContaining('limit:packet.nope')]);
  const prose = [{ file: SPEC, text: 'The rate limit: 5 per minute, and no-limit:x.y.\n' }];
  expect(citationProblems(REGISTER, prose)).toEqual([]);
});

test('a none test reference must give a reason', () => {
  const only = (test: string) => new Map([['packet.bytes', { ...entryOf('packet.bytes'), test }]]);
  expect(testProblems(only('none:'), reading({}))).toEqual([
    expect.stringContaining('gives no reason'),
  ]);
  expect(testProblems(only('none:   '), reading({}))).toHaveLength(1);
  expect(testProblems(only('none: checked by the workflow comparison'), reading({}))).toEqual([]);
});

// Built from parts so this file does not itself read as skipping tests.
test.each(
  [
    ['describe', 'skip'],
    ['test', 'only'],
    ['it', 'todo'],
    ['test', 'skipIf'],
  ].map((parts) => `${parts.join('.')}(`),
)('a named test in a file using %s is a problem', (marker) => {
  const only = new Map([
    ['packet.bytes', { ...entryOf('packet.bytes'), test: 'src/a.test.ts > here' }],
  ]);
  const files = { 'src/a.test.ts': `${marker}'group', () => {});\ntest('here', () => {});\n` };
  expect(testProblems(only, reading(files))).toEqual([expect.stringContaining('might not run')]);
});

test('an allowlisted line that states a value its entry does not list is a problem', () => {
  const line = 'Snapshot reads get 200 requests and 9 MiB.';
  const listed = (values: number[]) => [{ file: SPEC, line, values, reason: 'x' }];
  const specs = [{ file: SPEC, text: `${line}\n` }];
  expect(specProblems(REGISTER, FLOOR, specs, listed([200]))).toEqual([
    expect.stringContaining('allowlist lists 200 but the line states'),
  ]);
  expect(specProblems(REGISTER, FLOOR, specs, listed([9 * 1024 * 1024, 200]))).toEqual([]);
});

test('the real tree passes check:limits', () => {
  const output = execFileSync(process.execPath, ['scripts/limits/check.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(output).toMatch(/^check:limits passed/);
});
