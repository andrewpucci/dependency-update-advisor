import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import {
  PENDING_AMENDMENT,
  citationProblems,
  migrationProblems,
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
    'The cap is at most 50,000 code units.',
    'The cap is at most 50000 code units.',
    'The cap is at most 50_000 code units.',
  ]) {
    expect(specProblems(REGISTER, FLOOR, SPECS(line), [])).toHaveLength(1);
  }
});

test('an allowlisted spec line with a register value passes', () => {
  const line = 'The cap is at most 50,000 code units.';
  const allowlist = [{ file: SPEC, line, values: [50_000], reason: 'test' }];
  expect(specProblems(REGISTER, FLOOR, SPECS(line), allowlist)).toEqual([]);
});

test('a register value at the spec floor, or a non-whole number, is not a problem', () => {
  expect(specProblems(REGISTER, FLOOR, SPECS('The cap is at most 64 items.'), [])).toEqual([]);
  expect(specProblems(REGISTER, FLOOR, SPECS('Read 150,0001 bytes.'), [])).toEqual([]);
  expect(specProblems(REGISTER, FLOOR, SPECS('Use v50000x here.'), [])).toEqual([]);
});

test('an allowlist entry that matches no spec line is a problem', () => {
  const allowlist = [
    { file: SPEC, line: 'The cap is at most 50,000 code units.', values: [50_000], reason: 'test' },
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
  const text = 'Bodies hold at most 50,000 code units.\nPackets hold at most 128 changes.\n';
  const allowlist = [
    { file: SPEC, line: 'Bodies hold at most 50,000 code units.', values: [50_000], reason: 'x' },
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
  const text = 'Tracked in #50000 and https://example.com/pull/50000 and [x](https://e.com/128).\n';
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

test('a test title that appears only in a comment is a problem', () => {
  const only = new Map([
    ['packet.bytes', { ...entryOf('packet.bytes'), test: 'src/a.test.ts > gone' }],
  ]);
  const files = { 'src/a.test.ts': "// test('gone', () => {});\nconst s = \"test('gone'\";\n" };
  expect(testProblems(only, reading(files))).toHaveLength(1);
});

test('closing migration reports pending fields and pending allowlist lines', () => {
  const derived = [...REGISTER.values()].find(
    (entry) => entry.basis.kind === 'derived' && entry.test === PENDING_AUDIT,
  );
  if (!derived) throw new Error('expected a derived entry with a pending test');
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

test('the real tree passes check:limits', () => {
  const output = execFileSync(process.execPath, ['scripts/limits/check.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(output).toMatch(/^check:limits passed/);
});
