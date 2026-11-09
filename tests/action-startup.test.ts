import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

const repo = new URL('..', import.meta.url).pathname;
const entry = '.github/actions/dependabot-review/dist/index.js';
const sentinel = 'startup-test-sentinel-secret';
let shipped = '';

/** Copies the files a consumer runner would check out: tracked or new, never ignored. */
beforeAll(() => {
  // Node's permission model checks real paths, so resolve symlinked temp roots.
  shipped = realpathSync(mkdtempSync(join(tmpdir(), 'action-startup-')));
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );
  expect(listed.status).toBe(0);
  // A tracked file deleted in the working tree is simply absent from the shipped layout.
  for (const file of listed.stdout
    .split('\0')
    .filter((name) => name && existsSync(join(repo, name)))) {
    mkdirSync(join(shipped, dirname(file)), { recursive: true });
    cpSync(join(repo, file), join(shipped, file));
  }
});
afterAll(() => rmSync(shipped, { recursive: true, force: true }));

function start(args: string[] = []) {
  const { NODE_OPTIONS: _ignored, ...env } = process.env;
  return spawnSync(
    process.execPath,
    ['--no-experimental-strip-types', ...args, join(shipped, entry)],
    {
      cwd: shipped,
      encoding: 'utf8',
      env: { ...env, REVIEW_SENTINEL: sentinel },
    },
  );
}

test('shipped layout has no installed dependencies', () => {
  const bundle = join(shipped, entry);
  const original = readFileSync(bundle, 'utf8');
  writeFileSync(bundle, `import 'yaml';\n${original}`);
  try {
    const result = start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
  } finally {
    writeFileSync(bundle, original);
  }
});

test('starts on Node.js 24 without a TypeScript loader or installed dependencies', () => {
  const result = start();
  expect(result.stderr).toBe(
    'dependabot-review: review orchestration is not wired; no review ran.\n',
  );
  expect(result.stdout).toBe('');
  expect(result.status).toBe(78);
});

test('starts with filesystem reads limited to the checkout and never prints environment secrets', () => {
  const result = start(['--permission', `--allow-fs-read=${shipped}`]);
  expect(result.stderr).toBe(
    'dependabot-review: review orchestration is not wired; no review ran.\n',
  );
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
});
