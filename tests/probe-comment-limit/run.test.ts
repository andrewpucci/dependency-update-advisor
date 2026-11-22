import { expect, test } from 'vite-plus/test';
import { counts } from '../../scripts/probe-comment-limit/core.js';
import { limit } from '../../src/limits.js';
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
  /** The status GET /user answers; an Actions installation token gets 403. */
  userStatus?: number;
  /** The status the sweep's comment listing answers. */
  listStatus?: number;
  isPrivate?: boolean;
  ownerType?: string;
  /** The message of the error thrown on the failCreate POST. */
  failMessage?: string;
  /** The maximum the too-long message states, when it differs from the real limit. */
  statedLimit?: number;
  /** The token's user; it differs from the owner so redaction of each is tested apart. */
  login?: string;
  /** Answer too-long as GitHub did live: a bare string error with no body field. */
  bareErrors?: boolean;
};

/** A fake GitHub that counts comment bodies in UTF-16 code units. */
function fakeGitHub(options: FakeOptions = {}) {
  const limit = options.limit ?? 64;
  const comments = new Map<number, Comment>((options.existing ?? []).map((c) => [c.id, c]));
  const calls: { method: string; path: string }[] = [];
  let nextId = 1_000;
  let posts = 0;
  const tooLongText = `Body is too long (maximum is ${options.statedLimit ?? limit} characters)`;
  const tooLong = {
    message: 'Validation Failed',
    errors: options.bareErrors ? [tooLongText] : [{ field: 'body', message: tooLongText }],
  };
  const http: Http = async (method, path, body) => {
    calls.push({ method, path });
    if (method === 'GET' && path === '/repos/tester/scratch')
      return {
        status: 200,
        data: {
          full_name: options.fullName ?? 'tester/scratch',
          private: options.isPrivate ?? true,
          owner: { type: options.ownerType ?? 'User' },
        },
      };
    if (method === 'GET' && path === '/user')
      return options.userStatus === undefined
        ? { status: 200, data: { login: options.login ?? 'tester' } }
        : { status: options.userStatus, data: { message: 'Resource not accessible' } };
    if (method === 'GET' && path.startsWith('/repos/tester/scratch/issues/7/comments'))
      return options.listStatus === undefined
        ? { status: 200, data: [...comments.values()] }
        : { status: options.listStatus, data: { message: 'Server Error' } };
    if (method === 'POST' && path === '/repos/tester/scratch/issues/7/comments') {
      posts++;
      if (posts === options.failCreate) throw new Error(options.failMessage ?? 'socket hang up');
      const text = String(body?.body);
      if (counts(text)['code units'] > limit) return { status: 422, data: tooLong };
      const comment = { id: nextId++, body: text, user: { login: options.login ?? 'tester' } };
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

test('mutative requests are paced by the interval', async () => {
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

test('mutative requests wait for the full pause and never overlap', async () => {
  const github = fakeGitHub();
  let inFlight = 0;
  let mostInFlight = 0;
  let pausing = false;
  let sentDuringPause = 0;
  const http: Http = async (method, path, body) => {
    if (pausing) sentDuringPause++;
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight--;
    return github.http(method, path, body);
  };
  const sleep = async () => {
    pausing = true;
    await new Promise((resolve) => setTimeout(resolve, 1));
    pausing = false;
  };
  const result = await probe(ARGV, ENV, deps(http, { sleep }));
  expect(JSON.parse(result.output)).toMatchObject({ unit: 'code units', undeleted: 0 });
  expect(mostInFlight).toBe(1);
  expect(sentDuringPause).toBe(0);
});

test('the probe refuses to start when it cannot read the token user, because the sweep needs it', async () => {
  const github = fakeGitHub({ userStatus: 403 });
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toMatch(/token's user/);
  expect(mutative(github.calls)).toBe(0);
});

test('a sweep that cannot list the comments is reported and fails the run', async () => {
  const github = fakeGitHub({ listStatus: 500 });
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(JSON.parse(result.output)).toMatchObject({ sweep: 'failed', undeleted: 0 });
  expect(result.exitCode).not.toBe(0);
  const clean = await probe(ARGV, ENV, deps(fakeGitHub().http));
  expect(JSON.parse(clean.output)).toMatchObject({ sweep: 'done' });
  expect(clean.exitCode).toBe(0);
});

test('the seed comment counts two writes against the cap', async () => {
  // With a stated maximum, seven creates come before the first update: first body, M, M + 1,
  // and four unit bodies. The first update then needs the seed comment and its edit.
  for (const [maxWrites, expected] of [
    [8, 7],
    [9, 9],
  ] as const) {
    const github = fakeGitHub();
    const result = await probe(
      ARGV,
      ENV,
      deps(github.http, { limits: { maxWrites, intervalMs: 1_000, firstLength: 1_000 } }),
    );
    expect(JSON.parse(result.output), String(maxWrites)).toMatchObject({ unit: 'inconclusive' });
    const writes = github.calls.filter(({ method }) => method === 'POST' || method === 'PATCH');
    expect(writes, String(maxWrites)).toHaveLength(expected);
  }
});

test('repositoryType names a public, organization-owned repository', async () => {
  const github = fakeGitHub({ isPrivate: false, ownerType: 'Organization' });
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(JSON.parse(result.output)).toMatchObject({
    repositoryType: 'public, organization-owned, github.com',
  });
});

test('a network error that names the repository does not leak it into the result', async () => {
  const github = fakeGitHub({
    failCreate: 2,
    failMessage: 'connect ECONNRESET api.github.com/repos/tester/scratch',
  });
  const result = await probe(ARGV, ENV, deps(github.http));
  expect(JSON.parse(result.output)).toMatchObject({ unit: 'inconclusive' });
  for (const secret of ['tester', 'scratch', 'api.github.com', TOKEN])
    expect(result.output, secret).not.toContain(secret);
});

test('an empty GITHUB_TOKEN is refused like a missing one', async () => {
  const github = fakeGitHub();
  const result = await probe(ARGV, { GITHUB_TOKEN: '' }, deps(github.http));
  expect(result.exitCode).not.toBe(0);
  expect(github.calls).toEqual([]);
});

test('the register write cap covers the longest run from the register first body', async () => {
  // The longest run: GitHub states a maximum far below the real one, so M and M + 1 are both
  // accepted and the search halves all the way from M + 1 to the first body.
  const realLimit = 1_000_003;
  const github = fakeGitHub({ limit: realLimit, statedLimit: 1_000 });
  const result = await probe(
    ARGV,
    ENV,
    deps(github.http, {
      limits: {
        maxWrites: limit('probe.commentLimit.maxWrites'),
        intervalMs: limit('probe.commentLimit.writeIntervalMs'),
        firstLength: limit('probe.commentLimit.firstBodyCodeUnits'),
      },
    }),
  );
  const writes = github.calls.filter(({ method }) => method === 'POST' || method === 'PATCH');
  expect(writes).toHaveLength(31);
  expect(JSON.parse(result.output)).toMatchObject({
    unit: 'code units',
    limit: realLimit,
    update: 'agrees',
    lineBreaks: 'accepted',
    undeleted: 0,
  });
});

test('a 422 detail that names the repository or the user is redacted in the result', async () => {
  // The login differs from the owner, and each name appears on its own, so each is redacted apart.
  const github = fakeGitHub({ login: 'prober' });
  const http: Http = async (method, path, body) =>
    method === 'POST'
      ? {
          status: 422,
          data: {
            message: 'Validation Failed',
            errors: ['tester/scratch rejected it', 'owner Tester, repo Scratch, user Prober'],
          },
        }
      : github.http(method, path, body);
  const result = await probe(ARGV, ENV, deps(http));
  const printed = JSON.parse(result.output) as { writes: { detail?: string[] }[] };
  expect(printed.writes[0]?.detail).toEqual([
    'Validation Failed',
    '<redacted> rejected it',
    'owner <redacted>, repo <redacted>, user <redacted>',
  ]);
  for (const secret of ['tester', 'scratch', 'prober', TOKEN])
    expect(result.output.toLowerCase(), secret).not.toContain(secret.toLowerCase());
});

test('the live shape: a bare too-long error stating a wrong maximum still yields the real limit', async () => {
  // As on 2026-11-22: GitHub said "maximum is 65536 characters" but accepted longer bodies.
  const github = fakeGitHub({ limit: 200_003, statedLimit: 65_536, bareErrors: true });
  const result = await probe(
    ARGV,
    ENV,
    deps(github.http, {
      limits: {
        maxWrites: limit('probe.commentLimit.maxWrites'),
        intervalMs: limit('probe.commentLimit.writeIntervalMs'),
        firstLength: limit('probe.commentLimit.firstBodyCodeUnits'),
      },
    }),
  );
  expect(JSON.parse(result.output)).toMatchObject({
    unit: 'code units',
    limit: 200_003,
    update: 'agrees',
    lineBreaks: 'accepted',
    undeleted: 0,
    sweep: 'done',
  });
});
