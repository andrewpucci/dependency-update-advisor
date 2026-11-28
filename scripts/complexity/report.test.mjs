import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, regressions, render } from './report.mjs';
import { COMPLEXITY_REPORT_TEXT, limit } from '../../src/limits.ts';

test('measures TypeScript including zero-score functions and nested decisions', () => {
  const functions = measure(
    'function flat(x: number): number { return x; }\n' +
      'function nested(x: boolean) { if (x) { while (x) { if (x) { break; } } } }',
    'src/example.ts',
  );
  assert.deepEqual(
    functions.map(({ name, score }) => ({ name, score })),
    [
      { name: 'flat', score: 0 },
      { name: 'nested', score: 6 },
    ],
  );
});

test('reports only new or worse functions above 15, matching duplicates by rank', () => {
  const entries = (scores) =>
    scores.map((score) => ({ path: 'src/a.ts', name: 'same', score, line: 1 }));
  assert.deepEqual(
    regressions(entries([15, 20, 30]), entries([30, 19, 10])).map(({ score, before }) => [
      score,
      before,
    ]),
    [[20, 19]],
  );
  assert.deepEqual(
    regressions(entries([16, 17]), entries([16])).map(({ score, before }) => [score, before]),
    [
      [17, 16],
      [16, null],
    ],
  );
  assert.deepEqual(regressions(entries([15]), []), []);
  assert.deepEqual(regressions(entries([16]), entries([20])), []);
});

test('keeps private and computed method names distinct from public methods', () => {
  const functions = measure(
    'class Thing { p() {} #p() {} [p]() {} }\nconst p = Symbol();',
    'src/example.ts',
  );
  assert.deepEqual(
    functions.map(({ name }) => name),
    ['p', '#p', '(anonymous)'],
  );
});

test('rejects malformed source rather than reporting no regressions', () => {
  assert.throws(() => measure('function broken( {', 'src/broken.ts'), /Expected.*EOF/);
});

test('measures methods, arrows, and ignores inline rule suppressions', () => {
  const functions = measure(
    '/* oxlint-disable */\n// eslint-disable-next-line sonarjs/cognitive-complexity\n' +
      'const arrow = (x: boolean) => { if (x) return 1; };\n' +
      'class Thing { method(x: boolean) { if (x) return 1; } }',
    'src/example.ts',
  );
  assert.deepEqual(
    functions.map(({ name, score }) => [name, score]),
    [
      ['arrow', 1],
      ['method', 1],
    ],
  );
});

test('renders scores, revisions, and bounded escaped regression details', () => {
  const head = [{ path: 'src/a&b|c.ts', name: 'odd`name', score: 16, line: 3 }];
  const report = render(head, [], 'a'.repeat(40), 'b'.repeat(40));
  assert.match(report, /<!-- complexity-report -->/);
  assert.match(report, /^### 🐙 Cognitive complexity$/m);
  assert.match(report, /^⚠️ \*\*1 new or worsened/m);
  assert.match(report, /1 functions/);
  assert.match(report, /advisory threshold of 15/);
  assert.match(report, /<code>odd&#96;name<\/code>/);
  assert.match(report, /<code>src\/a&#38;b&#124;c\.ts:3<\/code>/);
  assert.match(report, /new/);
  assert.match(report, /aaaaaaa/);
  assert.match(render([], [], 'a'.repeat(40), 'b'.repeat(40)), /^✅ No functions regressed/m);
  assert.ok(
    render(
      Array.from({ length: 1000 }, (_, i) => ({
        ...head[0],
        name: `fn${i}` + '`'.repeat(160),
        path: '|'.repeat(160),
      })),
      [],
      'a'.repeat(40),
      'b'.repeat(40),
    ).length <= limit('complexity.maxCommentCodeUnits'),
  );
});

test('a report at complexity.maxListedFindings rows of the widest kind fits complexity.maxCommentCodeUnits', () => {
  const listed = limit('complexity.maxListedFindings');
  const cell = limit('complexity.cellOutputCodeUnits');
  const widest = Number.MAX_SAFE_INTEGER;
  const digits = String(widest).length;
  // An 8-unit prefix and six-unit `&#124;` entities fill a cell to exactly its output cap, which a
  // plain cell cannot reach past the input cap.
  const wide = (prefix) => `${prefix}`.padEnd(8, 'x') + '|'.repeat(cell);
  const fn = (index, score) => ({
    name: wide(`f${index}`),
    path: wide(`p${index}`),
    line: widest,
    score,
  });
  const count = listed + 1;
  const head = Array.from({ length: count }, (_, index) => fn(index, widest));
  const base = Array.from({ length: count }, (_, index) => fn(index, widest - 1));
  const report = render(head, base, 'a'.repeat(64), 'b'.repeat(64));
  const rows = report.split('\n').filter((line) => line.startsWith('| <code>'));
  assert.equal(rows.length, listed);
  for (const row of rows)
    assert.equal(row.length + 1, 2 * cell + COMPLEXITY_REPORT_TEXT.rowFixedCodeUnits);
  // The counts here have fewer digits than the 16 the constant allows: the function and over-threshold
  // counts and the finding count twice, the listed count, and the threshold.
  const short = (value) => digits - String(value).length;
  const widened =
    report.length -
    rows.length * (2 * cell + COMPLEXITY_REPORT_TEXT.rowFixedCodeUnits) +
    4 * short(count) +
    short(listed) +
    short(limit('complexity.threshold'));
  assert.equal(widened, COMPLEXITY_REPORT_TEXT.reportFixedCodeUnits);
  assert.ok(
    COMPLEXITY_REPORT_TEXT.reportFixedCodeUnits +
      listed * (2 * cell + COMPLEXITY_REPORT_TEXT.rowFixedCodeUnits) <=
      limit('complexity.maxCommentCodeUnits'),
  );
  assert.ok(report.length <= limit('complexity.maxCommentCodeUnits'));
});

test('CLI compares immutable git revisions without executing source, and rejects missing bases', () => {
  const root = mkdtempSync(join(tmpdir(), 'complexity-test-'));
  // Ignore developer git config such as commit signing so the fixture is hermetic.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const runGit = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv }).trim();
  try {
    runGit('init', '--quiet');
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src/a.ts'),
      'throw new Error("must not execute");\nfunction example(x: boolean) { return x; }',
    );
    runGit('add', 'src');
    runGit(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'base',
    );
    const base = runGit('rev-parse', 'HEAD');
    writeFileSync(
      join(root, 'src/a.ts'),
      'function example(x: boolean) { ' +
        'if (x) { '.repeat(6) +
        'return x; ' +
        '}'.repeat(6) +
        '}',
    );
    runGit('add', 'src');
    runGit(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'head',
    );
    const cli = fileURLToPath(new URL('./report.mjs', import.meta.url));
    const output = join(root, 'output');
    const result = spawnSync(process.execPath, [cli, '--base', base, '--github-output'], {
      cwd: root,
      env: { ...gitEnv, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /new or worsened/);
    assert.match(result.stdout, /\| 21 \| 0 \|/);
    const missing = spawnSync(process.execPath, [cli, '--base', 'missing-ref'], {
      cwd: root,
      env: gitEnv,
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
