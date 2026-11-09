import { expect, test } from 'vite-plus/test';
import { NOT_WIRED_EXIT_CODE, SELF_CHECK_EXIT_CODE, runStartup, selfCheck } from './startup.js';

const environment = {
  INPUT_GITHUB_TOKEN: 'read-token',
  INPUT_APP_TOKEN: 'app-token',
  INPUT_LLM_API_KEY: '',
  INPUT_CI_WORKFLOW: '.github/workflows/ci.yml',
  GITHUB_REPOSITORY: 'example/consumer',
  GITHUB_REPOSITORY_ID: '101',
};

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

test('startup fails closed without a valid action runtime', async () => {
  const stderr: string[] = [];
  const code = await runStartup((line) => stderr.push(line));
  expect(code).toBe(NOT_WIRED_EXIT_CODE);
  expect(stderr).toEqual(['dependabot-review: runtime configuration invalid; no review ran.']);
});

test('validates the action runtime before the no-write rehearsal exit', async () => {
  const stderr: string[] = [];
  await expect(runStartup((line) => stderr.push(line), environment)).resolves.toBe(
    NOT_WIRED_EXIT_CODE,
  );
  expect(stderr).toEqual(['dependabot-review: no-write rehearsal completed; no review ran.']);
});

test('rejects malformed action configuration without echoing input values', async () => {
  const stderr: string[] = [];
  await expect(
    runStartup((line) => stderr.push(line), {
      ...environment,
      INPUT_GITHUB_TOKEN: 'sentinel-token\n',
    }),
  ).resolves.toBe(NOT_WIRED_EXIT_CODE);
  expect(stderr).toEqual(['dependabot-review: runtime configuration invalid; no review ran.']);
  expect(stderr.join('\n')).not.toContain('sentinel-token');
});

test('uses exit codes that differ from a Node load failure', () => {
  expect([NOT_WIRED_EXIT_CODE, SELF_CHECK_EXIT_CODE]).not.toContain(1);
  expect(NOT_WIRED_EXIT_CODE).not.toBe(SELF_CHECK_EXIT_CODE);
});
