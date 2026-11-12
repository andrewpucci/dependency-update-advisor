import { fork, spawnSync } from 'node:child_process';
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
import { eventFile, mockGithub } from './parity/startup-github.js';
import { upstreamScenario } from './parity/upstream.js';

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

function noWriteEnvironment(eventPath: string, llmApiKey = sentinel) {
  return {
    INPUT_GITHUB_TOKEN: 'read-token',
    INPUT_APP_TOKEN: 'app-token',
    INPUT_LLM_API_KEY: llmApiKey,
    INPUT_CI_WORKFLOW: '.github/workflows/ci.yml',
    GITHUB_REPOSITORY: 'example/consumer',
    GITHUB_REPOSITORY_ID: '101',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_EVENT_PATH: eventPath,
  };
}

function startNoWriteFailure(mode: 'snapshot' | 'freshness', llmApiKey = sentinel) {
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
    `let pulls = 0;
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      const authorization = new Headers(init?.headers ?? {}).get('authorization');
      // No-write rehearsal: any write, status or comment path, or non-read credential is a defect.
      if ((init?.method ?? 'GET') !== 'GET' || /\\/(statuses|comments)(\\/|$)/.test(path) ||
          (authorization && authorization !== 'Bearer read-token'))
        process.stderr.write('LIVE-WRITE ' + (init?.method ?? 'GET') + ' ' + path + '\\n');
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
      if (path.endsWith('/pulls/42') && ${JSON.stringify(mode)} === 'freshness' && ++pulls > 1)
        return new Response('sentinel-body', { status: 404 });
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
      env: { ...env, REVIEW_SENTINEL: sentinel, ...noWriteEnvironment(eventPath, llmApiKey) },
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
  const result = startNoWriteFailure('snapshot');
  expect(result.stderr).toBe(
    'dependabot-review: no-write rehearsal recorded internal-failure at snapshot; nothing was published.\n',
  );
  expect(result.stdout).toBe('');
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
});

test('shipped action reports a fixed freshness field and reason without secrets', () => {
  const result = startNoWriteFailure('freshness');
  expect(result.stderr).toBe(
    'dependabot-review: no-write rehearsal recorded internal-failure at freshness (pullRequest missing); nothing was published.\n',
  );
  expect(result.stdout).toBe('');
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
  expect(result.stdout + result.stderr).not.toContain('sentinel-body');
});

test('shipped action reports the no-key reason without any evidence request', () => {
  // The snapshot mode would fail at the repository read; no key must stop before it.
  const result = startNoWriteFailure('snapshot', '');
  expect(result.stderr).toBe(
    'dependabot-review: no-write rehearsal recorded model-unavailable (no-key); nothing was published.\n',
  );
  expect(result.stdout).toBe('');
  expect(result.status).toBe(78);
  expect(result.stdout + result.stderr).not.toContain(sentinel);
});

const MODEL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
type Request = { method: string; url: string; authorization: string | null };

/**
 * True for any request a no-write rehearsal must never make. Only the one model call, a POST to
 * the Mistral endpoint carrying the model key, is exempt; every other write, status or comment
 * path, or credential other than the read token is a defect.
 */
function isLiveWrite({ method, url, authorization }: Request, modelKey: string): boolean {
  if (method === 'POST' && url === MODEL_ENDPOINT && authorization === `Bearer ${modelKey}`)
    return false;
  return (
    method !== 'GET' ||
    /\/(statuses|comments)(\/|$)/.test(new URL(url).pathname) ||
    (authorization !== null && authorization !== 'Bearer read-token')
  );
}

test('the no-write guard exempts exactly the one model call', () => {
  const key = 'model-key';
  const call = { method: 'POST', url: MODEL_ENDPOINT, authorization: `Bearer ${key}` };
  expect(isLiveWrite(call, key)).toBe(false);
  expect(isLiveWrite({ ...call, authorization: 'Bearer other' }, key)).toBe(true);
  expect(isLiveWrite({ ...call, method: 'PUT' }, key)).toBe(true);
  expect(isLiveWrite({ ...call, url: `${MODEL_ENDPOINT}/other` }, key)).toBe(true);
  expect(isLiveWrite({ ...call, url: 'https://api.github.com/repos/o/r/statuses/x' }, key)).toBe(
    true,
  );
  expect(
    isLiveWrite(
      {
        method: 'POST',
        url: 'https://api.github.com/repos/o/r/issues/1/comments',
        authorization: `Bearer ${key}`,
      },
      key,
    ),
  ).toBe(true);
  expect(
    isLiveWrite(
      {
        method: 'GET',
        url: 'https://api.github.com/repos/o/r',
        authorization: 'Bearer read-token',
      },
      key,
    ),
  ).toBe(false);
  // Each of these is a GET, so only the path and credential clauses can flag them.
  const github = 'https://api.github.com/repos/o/r';
  expect(isLiveWrite({ method: 'GET', url: github, authorization: 'Bearer app-token' }, key)).toBe(
    true,
  );
  expect(
    isLiveWrite(
      { method: 'GET', url: `${github}/statuses/x`, authorization: 'Bearer read-token' },
      key,
    ),
  ).toBe(true);
  expect(
    isLiveWrite({ method: 'GET', url: MODEL_ENDPOINT, authorization: `Bearer ${key}` }, key),
  ).toBe(true);
});

/**
 * Plain ESM for the child: forwards every fetch to the test over IPC and awaits the reply. It
 * accepts a Request or a URL, rejects when the caller's signal aborts, and rejects like a network
 * failure when the test answers with an error.
 */
const bridge = `
const pending = new Map();
let next = 0;
process.channel.unref();
function settle(id, finish) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (pending.size === 0) process.channel.unref();
  finish(entry);
}
process.on('message', (reply) => {
  settle(reply.id, (entry) => {
    if (reply.error) entry.reject(new TypeError('fetch failed'));
    else entry.resolve(new Response(reply.body, { status: reply.status, headers: reply.headers }));
  });
});
globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
  const request = typeof input === 'object' && 'url' in input ? input : null;
  const signal = init?.signal ?? request?.signal;
  if (signal?.aborted) return reject(signal.reason);
  const id = ++next;
  pending.set(id, { resolve, reject });
  process.channel.ref();
  signal?.addEventListener('abort', () => settle(id, (entry) => entry.reject(signal.reason)), {
    once: true,
  });
  process.send({
    id,
    url: request ? request.url : String(input),
    method: init?.method ?? request?.method ?? 'GET',
    redirect: init?.redirect ?? request?.redirect,
    credentials: init?.credentials ?? request?.credentials,
    authorization: new Headers(init?.headers ?? request?.headers ?? {}).get('authorization'),
    body: typeof init?.body === 'string' ? init.body : null,
  });
});
`;

/** What the test answers the one model call with: an HTTP status, or a network failure. */
type ModelReply = number | 'network-error';

/** Runs the shipped bundle against the shared mock GitHub, answering the model call itself. */
async function startWithModelReply(modelReply: ModelReply) {
  const eventPath = join(shipped, 'event.json');
  const bridgePath = join(shipped, 'bridge.mjs');
  writeFileSync(eventPath, eventFile);
  writeFileSync(bridgePath, bridge);
  const github = mockGithub({ changes: await upstreamScenario() });
  const violations: string[] = [];
  const modelCalls: string[] = [];
  const { NODE_OPTIONS: _ignored, ...env } = process.env;
  const child = fork(join(shipped, entry), [], {
    cwd: shipped,
    execArgv: ['--no-experimental-strip-types', '--import', bridgePath],
    silent: true,
    env: { ...env, ...noWriteEnvironment(eventPath) },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const reply = (message: object) => {
    // A child that already exited cannot be answered, and must not fail the test with an error.
    if (child.connected) child.send(message);
  };
  child.on(
    'message',
    async (
      message: Request & {
        id: number;
        redirect?: RequestRedirect;
        credentials?: RequestCredentials;
      },
    ) => {
      try {
        const request = {
          method: message.method,
          url: message.url,
          authorization: message.authorization,
        };
        if (isLiveWrite(request, sentinel)) violations.push(`${message.method} ${message.url}`);
        if (message.url === MODEL_ENDPOINT) {
          modelCalls.push(message.method);
          reply(
            modelReply === 'network-error'
              ? { id: message.id, error: true }
              : { id: message.id, status: modelReply, body: 'RAW_PROVIDER_BODY', headers: {} },
          );
          return;
        }
        const headers: Record<string, string> = {};
        if (message.authorization) headers.authorization = message.authorization;
        const response = await github.fetch(message.url, {
          method: message.method,
          redirect: message.redirect,
          credentials: message.credentials,
          headers,
        });
        reply({
          id: message.id,
          status: response.status,
          body: await response.text(),
          headers: Object.fromEntries(response.headers),
        });
      } catch {
        // A request the guard or mock cannot handle must not leave the child waiting.
        violations.push(`unhandled ${String(message?.url)}`);
        reply({ id: message.id, status: 500, body: '', headers: {} });
      }
    },
  );
  // A hung child is killed so it never outlives the test.
  const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', resolve);
  });
  clearTimeout(killer);
  return { stderr, code, violations, modelCalls };
}

test.each([
  [401, 'http-auth'],
  [503, 'http-server'],
  ['network-error', 'transport'],
] as const)(
  'shipped action reports a %s model reply as %s and makes no other write',
  async (modelReply, reason) => {
    const result = await startWithModelReply(modelReply);
    expect(result.stderr).toBe(
      `dependabot-review: no-write rehearsal recorded model-unavailable (${reason}); nothing was published.\n`,
    );
    expect(result.modelCalls).toEqual(['POST']);
    expect(result.violations).toEqual([]);
    expect(result.code).toBe(78);
    expect(result.stderr).not.toContain(sentinel);
    expect(result.stderr).not.toContain('RAW_PROVIDER_BODY');
  },
  30_000,
);
