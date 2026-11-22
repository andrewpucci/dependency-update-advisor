/**
 * The comment-limit probe's runner (docs/specs/SPEC-limit-register.md, External Citations
 * Amendment A2). Usage, in a test repository the user chooses:
 *
 *   GITHUB_TOKEN=... npm run probe:comment-limit -- --repo <owner/name> --issue <number>
 *
 * It posts and edits comments on that one issue, deletes every comment it made, and prints one
 * JSON result with no repository name, link, or token. All logic is in core.ts; this file only
 * does I/O, pacing, the write cap, and cleanup.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';
import type * as Format from '../../src/format.js';
import type * as Limits from '../../src/limits.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(ROOT, file)).href)) as T;
const { classifyWrite, runProbe } = await load<typeof Core>('scripts/probe-comment-limit/core.ts');
const { HTTP_STATUS } = await load<typeof Format>('src/format.ts');
const { limit } = await load<typeof Limits>('src/limits.ts');

/** This repository: the probe never writes here. */
const THIS_REPOSITORY = 'andrewpucci/dependency-update-advisor';
const API = 'https://api.github.com';
const SEED_BODY = 'comment-limit probe: seed for the update test';

export type Http = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: { body: string },
) => Promise<{ status: number; data: unknown }>;

export type ProbeDeps = {
  http: Http;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  limits: { maxWrites: number; intervalMs: number; firstLength: number };
  signal?: AbortSignal;
};

type Args = { repo: string; issue: number };

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const repo = value('--repo');
  const issue = Number(value('--issue'));
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    return { error: 'needs --repo <owner/name>' };
  if (!Number.isSafeInteger(issue) || issue < 1) return { error: 'needs --issue <number>' };
  return { repo, issue };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Visibility and owner type only; never the name. */
function repositoryType(data: Record<string, unknown>): string {
  const owner =
    isRecord(data.owner) && data.owner.type === 'Organization' ? 'organization' : 'user';
  return `${data.private === true ? 'private' : 'public'}, ${owner}-owned, github.com`;
}

/** Replaces each name, longest first and in any case, so GitHub's text cannot leak one. */
function redact(text: string, names: readonly string[]): string {
  const sorted = [...new Set(names.filter((name) => name !== ''))].sort(
    (a, b) => b.length - a.length,
  );
  return sorted.reduce(
    (out, name) =>
      out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<redacted>'),
    text,
  );
}

/**
 * Redacts only the text that can come from GitHub or the network: the stop reason and each 422
 * detail message. Keys and the probe's own values are left alone, so a name that is also an
 * output word cannot corrupt the result.
 */
function redactOutcome(outcome: Core.ProbeOutcome, names: readonly string[]): Core.ProbeOutcome {
  return {
    ...outcome,
    ...(outcome.reason === undefined ? {} : { reason: redact(outcome.reason, names) }),
    writes: outcome.writes.map((record) =>
      record.detail === undefined
        ? record
        : { ...record, detail: record.detail.map((text) => redact(text, names)) },
    ),
  };
}

/** Sends mutative requests one at a time, paced, under the write cap; tracks what it made. */
function writeSession(args: Args, deps: ProbeDeps) {
  const comments = `/repos/${args.repo}/issues/${args.issue}/comments`;
  const created = new Set<number>();
  const sent = new Set<string>();
  let mutations = 0;
  let writes = 0;
  let seed: number | undefined;

  const send = async (method: 'POST' | 'PATCH' | 'DELETE', path: string, text?: string) => {
    if (mutations++ > 0) await deps.sleep(deps.limits.intervalMs);
    return deps.http(method, path, text === undefined ? undefined : { body: text });
  };
  const remember = (data: unknown) => {
    if (isRecord(data) && typeof data.id === 'number') created.add(data.id);
  };
  const post = async (text: string) => {
    sent.add(text);
    const answer = await send('POST', comments, text);
    if (answer.status === HTTP_STATUS.created) remember(answer.data);
    return answer;
  };
  const answerOf = async (kind: Core.WriteKind, text: string): Promise<Core.WriteAnswer> => {
    try {
      if (kind === 'create') return await post(text);
      if (seed === undefined) {
        writes++;
        const answer = await post(SEED_BODY);
        if (!isRecord(answer.data) || typeof answer.data.id !== 'number')
          return { error: 'the seed comment for the update test was not created' };
        seed = answer.data.id;
      }
      sent.add(text);
      return await send('PATCH', `/repos/${args.repo}/issues/comments/${seed}`, text);
    } catch (error) {
      return { error: error instanceof Error ? error.name : 'network error' };
    }
  };
  const write: Core.Writer = async (kind, text) => {
    if (deps.signal?.aborted) return { outcome: 'inconclusive', reason: 'interrupted' };
    // The first update also creates the seed comment it edits, so it needs two writes.
    const needed = kind === 'update' && seed === undefined ? 2 : 1;
    if (writes + needed > deps.limits.maxWrites)
      return { outcome: 'inconclusive', reason: 'write cap reached' };
    writes++;
    return classifyWrite(kind, text, await answerOf(kind, text), {
      detailCodeUnits: limit('probe.commentLimit.detailCodeUnits'),
    });
  };

  /**
   * Deletes every comment made, then sweeps for any whose create answer was lost. A sweep that
   * cannot list the comments is `failed`: a lost create may then be left behind unseen.
   */
  const cleanup = async (
    login: string,
    since: string,
  ): Promise<{ undeleted: number; sweep: 'done' | 'failed' }> => {
    let undeleted = 0;
    const remove = async (id: number) => {
      const answer = await send('DELETE', `/repos/${args.repo}/issues/comments/${id}`).catch(
        () => undefined,
      );
      if (answer === undefined || answer.status >= HTTP_STATUS.redirectMin) undeleted++;
    };
    for (const id of created) await remove(id);
    const found = await sweep(login, since);
    for (const comment of found ?? []) await remove(comment);
    return { undeleted, sweep: found === undefined ? 'failed' : 'done' };
  };
  const sweep = async (login: string, since: string): Promise<number[] | undefined> => {
    const listing = await deps
      .http('GET', `${comments}?since=${since}&per_page=${limit('github.pageSize')}`)
      .catch(() => undefined);
    if (listing?.status !== HTTP_STATUS.ok || !Array.isArray(listing.data)) return undefined;
    return listing.data.flatMap((comment: unknown) =>
      isRecord(comment) &&
      typeof comment.id === 'number' &&
      !created.has(comment.id) &&
      isRecord(comment.user) &&
      comment.user.login === login &&
      typeof comment.body === 'string' &&
      sent.has(comment.body)
        ? [comment.id]
        : [],
    );
  };
  return { write, cleanup };
}

export async function probe(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: ProbeDeps,
): Promise<{ exitCode: number; output: string }> {
  const args = parseArgs(argv);
  if ('error' in args) return { exitCode: 1, output: `probe:comment-limit ${args.error}` };
  if (!env.GITHUB_TOKEN) return { exitCode: 1, output: 'probe:comment-limit needs GITHUB_TOKEN' };

  const repository = await deps.http('GET', `/repos/${args.repo}`);
  const data = isRecord(repository.data) ? repository.data : {};
  if (repository.status !== HTTP_STATUS.ok || typeof data.full_name !== 'string')
    return {
      exitCode: 1,
      output: `probe:comment-limit could not read the repository (${repository.status})`,
    };
  if (data.full_name.toLowerCase() === THIS_REPOSITORY)
    return { exitCode: 1, output: 'probe:comment-limit refuses to write to this repository' };
  // The sweep finds lost creates by their author, so without the token's user it cannot run.
  const user = await deps.http('GET', '/user');
  const login =
    user.status === HTTP_STATUS.ok && isRecord(user.data) && typeof user.data.login === 'string'
      ? user.data.login
      : '';
  if (login === '')
    return {
      exitCode: 1,
      output: `probe:comment-limit could not read the token's user (${user.status}); use a personal token`,
    };

  const started = deps.now();
  const session = writeSession(args, deps);
  let outcome: Core.ProbeOutcome | undefined;
  let cleaned = { undeleted: 0, sweep: 'failed' as 'done' | 'failed' };
  try {
    outcome = await runProbe({ firstLength: deps.limits.firstLength, write: session.write });
  } finally {
    cleaned = await session.cleanup(login, started.toISOString());
  }
  const names = [args.repo, ...args.repo.split('/'), login];
  const result = {
    date: started.toISOString().slice(0, 'YYYY-MM-DD'.length),
    repositoryType: repositoryType(data),
    ...(outcome === undefined ? {} : redactOutcome(outcome, names)),
    ...cleaned,
  };
  const exitCode = cleaned.undeleted === 0 && cleaned.sweep === 'done' ? 0 : 1;
  return { exitCode, output: JSON.stringify(result, null, 2) };
}

/** The real GitHub REST client: one request at a time, with the token in a header only. */
function githubHttp(token: string): Http {
  return async (method, path, body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'comment-limit-probe',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, data: text === '' ? null : (JSON.parse(text) as unknown) };
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const { exitCode, output } = await probe(process.argv.slice(2), process.env, {
    http: githubHttp(process.env.GITHUB_TOKEN ?? ''),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    limits: {
      maxWrites: limit('probe.commentLimit.maxWrites'),
      intervalMs: limit('probe.commentLimit.writeIntervalMs'),
      firstLength: limit('probe.commentLimit.firstBodyCodeUnits'),
    },
    signal: controller.signal,
  });
  process.stdout.write(`${output}\n`);
  process.exitCode = exitCode;
}
