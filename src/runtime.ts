import { W2_ALLOCATION, W2_ENVELOPE } from './budget.js';
import { positiveId, record, type RepositoryIdentity, type WorkflowIdentity } from './event.js';
import { httpReason } from './github-read.js';
import type { EvidenceReason } from './schema.js';

export const W2_GITHUB_LIMITS = Object.freeze({
  maxRequests: W2_ALLOCATION.transport.maxRequests,
  maxResponseBytes: W2_ENVELOPE.maxResponseBytes,
  maxTotalBytes: W2_ALLOCATION.transport.maxTotalBytes,
  requestTimeoutMs: W2_ENVELOPE.requestTimeoutMs,
  totalTimeoutMs: W2_ENVELOPE.totalTimeoutMs,
});

export type Runtime = Readonly<{
  githubToken: string;
  appToken: string;
  llmApiKey: string | null;
  repository: RepositoryIdentity;
  workflowPath: string;
  workflowFile: string;
}>;
export type GithubRead =
  | Readonly<{ kind: 'available'; value: unknown }>
  | Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;
export type GithubTransport = Readonly<{
  readWorkflow: (repository: RepositoryIdentity, file: string) => Promise<GithubRead>;
  readRepository: (repository: RepositoryIdentity, signal?: AbortSignal) => Promise<GithubRead>;
  readCommit: (
    repository: RepositoryIdentity,
    ref: string,
    signal?: AbortSignal,
  ) => Promise<GithubRead>;
  readTree: (
    repository: RepositoryIdentity,
    sha: string,
    signal?: AbortSignal,
  ) => Promise<GithubRead>;
  readBlob: (
    repository: RepositoryIdentity,
    sha: string,
    signal?: AbortSignal,
  ) => Promise<GithubRead>;
}>;
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type TransportDependencies = Readonly<{
  token: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}>;

function plainText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function repository(value: string | undefined, id: string | undefined): RepositoryIdentity | null {
  if (!plainText(value) || !plainText(id)) return null;
  const pieces = value.split('/');
  const numericId = Number(id);
  if (
    pieces.length !== 2 ||
    !pieces.every((piece) => plainText(piece) && !/[\s/]/u.test(piece)) ||
    !positiveId(numericId) ||
    !/^\d+$/u.test(id)
  )
    return null;
  return Object.freeze({ id: numericId, owner: pieces[0], name: pieces[1] });
}

function workflow(value: string | undefined): Readonly<{ path: string; file: string }> | null {
  if (!plainText(value)) return null;
  const match = /^\.github\/workflows\/([^/]+\.(?:ya?ml))$/u.exec(value);
  if (!match || !plainText(match[1])) return null;
  return Object.freeze({ path: value, file: match[1] });
}

export function parseRuntime(value: RuntimeEnvironment): Runtime | null {
  const githubToken = value.INPUT_GITHUB_TOKEN;
  const appToken = value.INPUT_APP_TOKEN;
  const repo = repository(value.GITHUB_REPOSITORY, value.GITHUB_REPOSITORY_ID);
  const selectedWorkflow = workflow(value.INPUT_CI_WORKFLOW);
  if (!plainText(githubToken) || !plainText(appToken) || !repo || !selectedWorkflow) return null;
  const llmApiKey = plainText(value.INPUT_LLM_API_KEY) ? value.INPUT_LLM_API_KEY : null;
  return Object.freeze({
    githubToken,
    appToken,
    llmApiKey,
    repository: repo,
    workflowPath: selectedWorkflow.path,
    workflowFile: selectedWorkflow.file,
  });
}

function route(...segments: string[]): string {
  return (
    'https://api.github.com/' + segments.map((segment) => encodeURIComponent(segment)).join('/')
  );
}

class BodyAborted extends Error {}

/** Reads at most `limit` bytes; `body` is null as soon as the response would exceed it. */
async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<{ body: Uint8Array | null; size: number }> {
  if (!response.body) return { body: new Uint8Array(), size: 0 };
  const reader = response.body.getReader();
  let stop = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new BodyAborted());
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return { body: Buffer.concat(chunks), size };
      size += value.byteLength;
      if (size > limit) return { body: null, size };
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', stop);
    void reader.cancel().catch(() => {});
  }
}

function json(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
}

export function createGithubTransport(dependencies: TransportDependencies): GithubTransport {
  let requests = 0;
  let bytes = 0;
  const started = dependencies.now();

  const read = async (url: string, signal?: AbortSignal): Promise<GithubRead> => {
    if (
      signal?.aborted ||
      ++requests > W2_GITHUB_LIMITS.maxRequests ||
      dependencies.now() - started >= W2_GITHUB_LIMITS.totalTimeoutMs
    )
      return { kind: 'unavailable', reason: 'budget' };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const remaining = W2_GITHUB_LIMITS.totalTimeoutMs - (dependencies.now() - started);
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(W2_GITHUB_LIMITS.requestTimeoutMs, remaining),
    );
    try {
      const response = await dependencies.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + dependencies.token,
        },
        signal: controller.signal,
      });
      const { body, size } = await boundedBody(
        response,
        Math.min(W2_GITHUB_LIMITS.maxResponseBytes, W2_GITHUB_LIMITS.maxTotalBytes - bytes),
        controller.signal,
      );
      bytes += size;
      if (!body) return { kind: 'unavailable', reason: 'budget' };
      const value = json(body);
      // Error bodies feed github-read's classifier so permission, missing, and rate limits stay distinct.
      if (response.status !== 200)
        return { kind: 'unavailable', reason: httpReason(response, value ?? null) };
      return value === undefined
        ? { kind: 'unavailable', reason: 'malformed' }
        : { kind: 'available', value };
    } catch {
      return { kind: 'unavailable', reason: controller.signal.aborted ? 'timeout' : 'unknown' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };

  return Object.freeze({
    readWorkflow: (repository, file) =>
      read(route('repos', repository.owner, repository.name, 'actions', 'workflows', file)),
    readRepository: (repository, signal) =>
      read(route('repos', repository.owner, repository.name), signal),
    readCommit: (repository, ref, signal) =>
      read(route('repos', repository.owner, repository.name, 'commits', ref), signal),
    readTree: (repository, sha, signal) =>
      read(route('repos', repository.owner, repository.name, 'git', 'trees', sha), signal),
    readBlob: (repository, sha, signal) =>
      read(route('repos', repository.owner, repository.name, 'git', 'blobs', sha), signal),
  });
}

export async function resolveWorkflow(
  runtime: Runtime,
  transport: Pick<GithubTransport, 'readWorkflow'>,
): Promise<WorkflowIdentity | null> {
  const result = await transport.readWorkflow(runtime.repository, runtime.workflowFile);
  if (
    result.kind !== 'available' ||
    !record(result.value, ['id', 'path']) ||
    !positiveId(result.value.id) ||
    result.value.path !== runtime.workflowPath
  )
    return null;
  return Object.freeze({ id: result.value.id, path: result.value.path });
}
