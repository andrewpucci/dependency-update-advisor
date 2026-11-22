import { expect, test } from 'vite-plus/test';
import { counts } from '../../scripts/probe-comment-limit/core.js';
import {
  parseArgs,
  probe,
  type Http,
  type ProbeDeps,
} from '../../scripts/probe-comment-limit/run.js';

const TOKEN = 'ghp_testtokenvalue';
const ARGV = ['--repo', 'tester/scratch', '--issue', '7'];
const ENV = { GITHUB_TOKEN: TOKEN };

type Comment = { id: number; body: string; user: { login: string } };

type FakeOptions = {
  fullName?: string;
  limit?: number;
  /** Throw on the nth POST before answering, after creating the comment (a lost answer). */
  loseCreate?: number;
  /** Throw on the nth POST without creating anything. */
  failCreate?: number;
  /** Comment ids whose DELETE fails. */
  undeletable?: (id: number) => boolean;
  existing?: Comment[];
};

/** A fake GitHub that counts comment bodies in UTF-16 code units. */
function fakeGitHub(options: FakeOptions = {}) {
  const limit = options.limit ?? 64;
  const comments = new Map<number, Comment>((options.existing ?? []).map((c) => [c.id, c]));
  const calls: { method: string; path: string }[] = [];
  let nextId = 1_000;
  let posts = 0;
  const tooLong = {
    message: 'Validation Failed',
    errors: [{ field: 'body', message: `body is too long (maximum is ${limit} characters)` }],
  };
  const http: Http = async (method, path, body) => {
    calls.push({ method, path });
    if (method === 'GET' && path === '/repos/tester/scratch')
      return {
        status: 200,
        data: {
          full_name: options.fullName ?? 'tester/scratch',
          private: true,
          owner: { type: 'User' },
        },
      };
    if (method === 'GET' && path === '/user') return { status: 200, data: { login: 'tester' } };
    if (method === 'GET' && path.startsWith('/repos/tester/scratch/issues/7/comments'))
      return { status: 200, data: [...comments.values()] };
    if (method === 'POST' && path === '/repos/tester/scratch/issues/7/comments') {
      posts++;
      if (posts === options.failCreate) throw new Error('socket hang up');
      const text = String(body?.body);
      if (counts(text)['code units'] > limit) return { status: 422, data: tooLong };
      const comment = { id: nextId++, body: text, user: { login: 'tester' } };
      comments.set(comment.id, comment);
      if (posts === options.loseCreate) throw new Error('timeout');
      return { status: 201, data: comment };
    }
    const match = /^\/repos\/tester\/scratch\/issues\/comments\/(\d+)$/.exec(path);
    const id = Number(match?.[1]);
    if (method === 'PATCH' && comments.has(id)) {
      const text = String(body?.body);
      if (counts(text)['code units'] > limit) return { status: 422, data: tooLong };
      const comment = { ...(comments.get(id) as Comment), body: text };
      comments.set(id, comment);
      return { status: 200, data: comment };
    }
    if (method === 'DELETE' && comments.has(id)) {
      if (options.undeletable?.(id)) return { status: 403, data: {} };
      comments.delete(id);
      return { status: 204, data: null };
    }
    return { status: 404, data: {} };
  };
  return { http, comments, calls };
}

const deps = (http: Http, overrides: Partial<ProbeDeps> = {}): ProbeDeps => ({
  http,
  sleep: async () => {},
  now: () => new Date('2026-11-22T12:00:00Z'),
  limits: { maxWrites: 64, intervalMs: 1_000, firstLength: 1_000 },
  ...overrides,
});

const mutative = (calls: { method: string }[]) =>
  calls.filter(({ method }) => method !== 'GET').length;

test('parseArgs needs both --repo owner/name and a positive --issue number', () => {
  expect(parseArgs(ARGV)).toEqual({ repo: 'tester/scratch', issue: 7 });
  for (const argv of [
    [],
    ['--repo', 'tester/scratch'],
    ['--issue', '7'],
    ['--repo', 'scratch', '--issue', '7'],
    ['--repo', 'tester/scratch', '--issue', '0'],
    ['--repo', 'tester/scratch', '--issue', 'x'],
  ])
    expect(parseArgs(argv), argv.join(' ')).toHaveProperty('error');
});

test('the probe refuses to start without --repo, --issue, or GITHUB_TOKEN and calls nothing', async () => {
  for (const [argv, env] of [
    [['--issue', '7'], ENV],
    [['--repo', 'tester/scratch'], ENV],
    [ARGV, {}],
  ] as const) {
    const github = fakeGitHub();
    const result = await probe([...argv], env, deps(github.http));
    expect(result.exitCode, argv.join(' ')).not.toBe(0);
    expect(github.calls).toEqual([]);
  }
});

test('the probe refuses this repository by the name GitHub returns, whatever --repo says', async () => {
  for (const fullName of [
    'andrewpucci/dependency-update-advisor',
    'AndrewPucci/Dependency-Update-Advisor',
  ]) {
    const github = fakeGitHub({ fullName });
    const result = await probe(ARGV, ENV, deps(github.http));
    expect(result.exitCode, fullName).not.toBe(0);
    expect(result.output).toMatch(/refuses/);
    expect(mutative(github.calls), fullName).toBe(0);
  }
});

test('a run names the unit, deletes every comment it made, and prints no name, URL, or token', async () => {
  const github = fakeGitHub();
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(result.exitCode).toBe(0);
  const printed = JSON.parse(result.output) as Record<string, unknown>;
  expect(printed).toMatchObject({
    date: '2026-11-22',
    repositoryType: 'private, user-owned, github.com',
    unit: 'code units',
    limit: 64,
    update: 'agrees',
    lineBreaks: 'accepted',
    undeleted: 0,
  });
  expect(github.comments.size).toBe(0);
  for (const secret of ['tester', 'scratch', TOKEN, 'http', 'github.com/'])
    expect(result.output.replace('github.com"', ''), secret).not.toContain(secret);
});

test('every created comment is deleted when a later write throws', async () => {
  const github = fakeGitHub({ failCreate: 4 });
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(JSON.parse(result.output)).toMatchObject({ unit: 'inconclusive', undeleted: 0 });
  expect(github.comments.size).toBe(0);
});

test('a create whose answer is lost is found and deleted by the end sweep', async () => {
  const github = fakeGitHub({ loseCreate: 2 });
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(JSON.parse(result.output)).toMatchObject({ unit: 'inconclusive', undeleted: 0 });
  expect(github.comments.size).toBe(0);
});

test('the sweep never deletes another user comment or one with a body the probe did not send', async () => {
  const other = { id: 1, body: 'a'.repeat(64), user: { login: 'someone-else' } };
  const mine = { id: 2, body: 'a note I wrote', user: { login: 'tester' } };
  const github = fakeGitHub({ loseCreate: 2, existing: [other, mine] });
  await probe(ARGV, ENV, deps(github.http));
  expect([...github.comments.values()]).toEqual([other, mine]);
});

test('a comment the probe cannot delete is counted in the result', async () => {
  const github = fakeGitHub({ undeletable: (id) => id === 1_001 });
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(JSON.parse(result.output)).toMatchObject({ undeleted: 1 });
  expect(result.exitCode).not.toBe(0);
});

test('reaching the write cap gives inconclusive and sends no further write', async () => {
  const github = fakeGitHub();
  const result = await probe(
    ARGV,
    ENV,
    deps(github.http, { limits: { maxWrites: 3, intervalMs: 1_000, firstLength: 1_000 } }),
  );
  expect(JSON.parse(result.output)).toMatchObject({ unit: 'inconclusive' });
  const writes = github.calls.filter(({ method }) => method === 'POST' || method === 'PATCH');
  expect(writes).toHaveLength(3);
});

test('mutative requests are paced by the interval and never sent concurrently', async () => {
  const github = fakeGitHub();
  const pauses: number[] = [];
  await probe(ARGV, ENV, deps(github.http, { sleep: async (ms) => void pauses.push(ms) }));
  expect(pauses.length).toBe(mutative(github.calls) - 1);
  expect(new Set(pauses)).toEqual(new Set([1_000]));
});

test('an interrupt stops further writes and still cleans up', async () => {
  const controller = new AbortController();
  const github = fakeGitHub();
  let posts = 0;
  const http: Http = async (method, path, body) => {
    if (method === 'POST' && ++posts === 2) controller.abort();
    return github.http(method, path, body);
  };
  const result = await probe(ARGV, ENV, deps(http, { signal: controller.signal }));
  expect(JSON.parse(result.output)).toMatchObject({ unit: 'inconclusive', undeleted: 0 });
  expect(posts).toBe(2);
  expect(github.comments.size).toBe(0);
});
