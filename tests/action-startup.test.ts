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
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

const repo = fileURLToPath(new URL('..', import.meta.url));
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

function noWriteEnvironment(eventPath: string) {
  return {
    INPUT_GITHUB_TOKEN: 'read-token',
    INPUT_APP_TOKEN: 'app-token',
    INPUT_LLM_API_KEY: sentinel,
    INPUT_CI_WORKFLOW: '.github/workflows/ci.yml',
    GITHUB_REPOSITORY: 'example/consumer',
    GITHUB_REPOSITORY_ID: '101',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_EVENT_PATH: eventPath,
  };
}

function startNoWriteSnapshotFailure() {
  const eventPath = join(shipped, 'event.json');
  const fetchPath = join(shipped, 'mock-fetch.mjs');
  const head = 'a'.repeat(40);
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: 'completed',
      repository: { id: 101, full_name: 'example/consumer' },
      workflow_run: {
        id: 401,
        workflow_id: 301,
        run_attempt: 1,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        head_sha: head,
        actor: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
        repository: { id: 101, full_name: 'example/consumer' },
        head_repository: { id: 101, full_name: 'example/consumer' },
        pull_requests: [
          {
            number: 42,
            base: { repo: { id: 101, name: 'consumer', full_name: 'example/consumer' } },
            head: { sha: head, repo: { id: 101, name: 'consumer', full_name: 'example/consumer' } },
          },
        ],
      },
    }),
  );
  writeFileSync(
    fetchPath,
    `globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/actions/workflows/ci.yml') || path.endsWith('/actions/workflows/301'))
        return Response.json({ id: 301, path: '.github/workflows/ci.yml' });
      if (path.endsWith('/actions/runs/401'))
        return Response.json({
          id: 401, workflow_id: 301, run_attempt: 1, event: 'pull_request', status: 'completed',
          conclusion: 'success', head_sha: '${head}', actor: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
          repository: { id: 101, full_name: 'example/consumer' },
          head_repository: { id: 101, full_name: 'example/consumer' },
          pull_requests: [{ number: 42, base: { repo: { id: 101, name: 'consumer', full_name: 'example/consumer' } }, head: { sha: '${head}', repo: { id: 101, name: 'consumer', full_name: 'example/consumer' } } }],
        });
      if (path.endsWith('/pulls/42'))
        return Response.json({
          number: 42, state: 'open', merged: false, changed_files: 0, user: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
          base: { ref: 'main', sha: '${'b'.repeat(40)}', repo: { id: 101, full_name: 'example/consumer' } },
          head: { sha: '${head}', repo: { id: 101, full_name: 'example/consumer' } },
        });
      if (path.endsWith('/compare/${'b'.repeat(40)}...${head}'))
        return Response.json({ base_commit: { sha: '${'b'.repeat(40)}' }, merge_base_commit: { sha: '${'b'.repeat(40)}' } });
      return new Response(null, { status: 500 });
    };`,
  );
  const { NODE_OPTIONS: _ignored, ...env } = process.env;
  return spawnSync(
    process.execPath,
    ['--no-experimental-strip-types', '--import', fetchPath, join(shipped, entry)],
    {
      cwd: shipped,
      encoding: 'utf8',
      env: { ...env, REVIEW_SENTINEL: sentinel, ...noWriteEnvironment(eventPath) },
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
  expect(result.stderr).toBe('dependabot-review: runtime configuration invalid; no review ran.\n');
  expect(result.stdout).toBe('');
  expect(result.status).toBe(78);
});

test('starts with filesystem reads limited to the checkout and never prints environment secrets', () => {
  const result = start(['--permission', `--allow-fs-read=${shipped}`]);
  expect(result.stderr).toBe('dependabot-review: runtime configuration invalid; no review ran.\n');
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
});

test('shipped action reports a fixed snapshot stage without environment secrets', () => {
  const result = startNoWriteSnapshotFailure();
  expect(result.stderr).toBe(
    'dependabot-review: no-write rehearsal recorded internal-failure at snapshot; nothing was published.\n',
  );
  expect(result.stdout).toBe('');
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
});
