import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import {
  citationProblems,
  migrationProblems,
  specProblems,
  testProblems,
  workflowProblems,
} from '../../scripts/limits/check.js';
import { REGISTER, limit, type Limit } from '../../src/limits.js';

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

test('the real tree passes check:limits', () => {
  const output = execFileSync(process.execPath, ['scripts/limits/check.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(output).toMatch(/^check:limits passed/);
});
