import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const quality = workflow.match(/^ {2}quality:\n((?: {4}[^\n]*\n|\n)*)/m)?.[1] ?? '';
const steps = quality.split(/(?=^ {6}- )/m).slice(1);
const runSteps = steps.filter((step) => /^ {8}run:/m.test(step));

test('runs every non-mutating check in order in the quality job', () => {
  expect(runSteps.map((step) => step.match(/^ {8}run: (.+)$/m)?.[1])).toEqual([
    '|',
    'npm ci',
    'npm run lint',
    'npm run format:check',
    'npm run check',
    'npm test -- --run',
  ]);
  expect(quality).not.toMatch(/^ {4,}(?:if|continue-on-error|shell|permissions|defaults):/m);
  expect(workflow).not.toMatch(/^defaults:/m);
});

test('identifies the checkout and environment before validation', () => {
  const revisionCommands = runSteps[0]?.match(/^ {8}run: \|\n((?: {10}[^\n]*\n)*)/m)?.[1];
  expect(
    revisionCommands
      ?.trim()
      .split('\n')
      .map((line) => line.trim()),
  ).toEqual([
    'git rev-parse HEAD',
    'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    'node --version',
    'npm --version',
  ]);
});

test('preserves eligible events and the required check identity', () => {
  const events = workflow.match(/^on:\n((?: {2}[^\n]*\n|\n)*)/m)?.[1];
  expect(events?.trim()).toBe('pull_request:\n    branches: [main]\n  push:\n    branches: [main]');
  expect(workflow).toMatch(/^name: CI$/m);
  expect(quality).toMatch(/^ {4}name: Repository quality$/m);
  expect(quality).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
  expect(quality).toMatch(/^ {4}timeout-minutes: 10$/m);
  expect(workflow).toMatch(
    /^concurrency:\n {2}group: \$\{\{ github.workflow \}\}-\$\{\{ github.ref \}\}\n {2}cancel-in-progress: true$/m,
  );
});

test('uses pinned setup with read-only access and default event checkout', () => {
  expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m);
  expect(steps[0]?.trim()).toBe(
    '- uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6\n' +
      '        with:\n          persist-credentials: false',
  );
  expect(steps[1]?.trim()).toBe(
    '- uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6\n' +
      "        with:\n          node-version: '24'\n          package-manager-cache: false",
  );
  expect(steps).toHaveLength(8);
  expect(quality).not.toMatch(/\$\{\{\s*secrets(?:\.|\[)/);
});
