import { positiveId, record, type RepositoryIdentity, type WorkflowIdentity } from './event.js';

export const W2_GITHUB_LIMITS = Object.freeze({
  maxRequests: 512,
  maxResponseBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 240_000,
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
  | Readonly<{ kind: 'unavailable'; reason: 'budget' | 'rate_limit' | 'timeout' | 'unknown' }>;
export type GithubTransport = Readonly<{
  readWorkflow: (repository: RepositoryIdentity, file: string) => Promise<GithubRead>;
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

function unavailable(response: Response): GithubRead {
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    return { kind: 'unavailable', reason: 'rate_limit' };
  return { kind: 'unavailable', reason: 'unknown' };
}

export function createGithubTransport(dependencies: TransportDependencies): GithubTransport {
  let requests = 0;
  let bytes = 0;
  const started = dependencies.now();

  return Object.freeze({
    readWorkflow: async (repository, file) => {
      if (
        ++requests > W2_GITHUB_LIMITS.maxRequests ||
        dependencies.now() - started >= W2_GITHUB_LIMITS.totalTimeoutMs
      )
        return { kind: 'unavailable', reason: 'budget' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), W2_GITHUB_LIMITS.requestTimeoutMs);
      try {
        const response = await dependencies.fetch(
          route('repos', repository.owner, repository.name, 'actions', 'workflows', file),
          {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            headers: {
              accept: 'application/vnd.github+json',
              authorization: 'Bearer ' + dependencies.token,
            },
            signal: controller.signal,
          },
        );
        if (response.status !== 200) return unavailable(response);
        const text = await response.text();
        const responseBytes = new TextEncoder().encode(text).byteLength;
        bytes += responseBytes;
        if (
          responseBytes > W2_GITHUB_LIMITS.maxResponseBytes ||
          bytes > W2_GITHUB_LIMITS.maxTotalBytes
        )
          return { kind: 'unavailable', reason: 'budget' };
        try {
          return { kind: 'available', value: JSON.parse(text) };
        } catch {
          return { kind: 'unavailable', reason: 'unknown' };
        }
      } catch {
        return { kind: 'unavailable', reason: controller.signal.aborted ? 'timeout' : 'unknown' };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export async function resolveWorkflow(
  runtime: Runtime,
  transport: GithubTransport,
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
