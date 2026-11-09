import { expect, test } from 'vite-plus/test';
import { NOT_WIRED_EXIT_CODE, SELF_CHECK_EXIT_CODE, runStartup, selfCheck } from './startup.js';

test('self-check exercises every bundled production dependency', async () => {
  expect(await selfCheck()).toEqual({
    semver: true,
    pep440: true,
    spdx: true,
    toml: true,
    yaml: true,
    streamJson: true,
  });
});

test('startup fails closed because orchestration is not wired', async () => {
  const stderr: string[] = [];
  const code = await runStartup((line) => stderr.push(line));
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
  expect(stderr).toEqual(['dependabot-review: review orchestration is not wired; no review ran.']);
});

test('uses exit codes that differ from a Node load failure', () => {
  expect([NOT_WIRED_EXIT_CODE, SELF_CHECK_EXIT_CODE]).not.toContain(1);
  expect(NOT_WIRED_EXIT_CODE).not.toBe(SELF_CHECK_EXIT_CODE);
});
