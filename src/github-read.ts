import {
  classifyPullRequest,
  parseReviewBinding,
  record,
  type ReviewBinding,
  type RepositoryIdentity,
} from './event.js';
import { PACKET_LIMITS, type EvidenceReason } from './schema.js';

export type GithubReadLimits = Readonly<{
  maxRequests: number;
  maxPages: number;
  maxFiles: number;
  maxJsonEntries: number;
  maxResponseBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxRetainedBytes: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}>;
export type GithubReadDependencies = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}>;
type Failure = Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;
export type GithubReadSession = Readonly<{ close: () => void }>;
export type GithubReadCreation =
  | { kind: 'invalid' }
  | { kind: 'obsolete' }
  | Failure
  | { kind: 'ready'; binding: ReviewBinding; session: GithubReadSession };

const ORIGIN = 'https://api.github.com';
const LIMIT_KEYS = [
  'maxRequests',
  'maxPages',
  'maxFiles',
  'maxJsonEntries',
  'maxResponseBytes',
  'maxFileBytes',
  'maxTotalBytes',
  'maxRetainedBytes',
  'requestTimeoutMs',
  'totalTimeoutMs',
] as const;
class ReadFailure extends Error {
  constructor(
    readonly reason: EvidenceReason,
    readonly obsolete = false,
  ) {
    super(reason);
  }
}
function requireRead(condition: unknown, reason: EvidenceReason = 'malformed'): asserts condition {
  if (!condition) throw new ReadFailure(reason);
}
function fixedFailure(error: unknown): Failure {
  return { kind: 'unavailable', reason: error instanceof ReadFailure ? error.reason : 'unknown' };
}
function parseLimits(value: unknown): GithubReadLimits | null {
  if (!record(value)) return null;
  const copy: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return null;
    copy[key] = n;
  }
  const limits = copy as GithubReadLimits;
  if (
    limits.maxResponseBytes > limits.maxTotalBytes ||
    limits.maxFileBytes > limits.maxTotalBytes ||
    limits.requestTimeoutMs > limits.totalTimeoutMs
  )
    return null;
  return Object.freeze(limits);
}
function repoPath(repo: RepositoryIdentity): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
function httpReason(response: Response): EvidenceReason {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const retry = response.headers.get('retry-after');
  if (
    response.status === 429 ||
    (response.status === 403 && (remaining === '0' || (retry !== null && /^\d+$/u.test(retry))))
  )
    return 'rate_limit';
  if (response.status === 404) return 'missing';
  if (response.status === 401) return 'permission';
  return 'unknown';
}

class ReadSession implements GithubReadSession {
  private requests = 0;
  private bytes = 0;
  private entries = 0;
  private retained = 0;
  private stopped: EvidenceReason | null = null;
  private active: AbortController | null = null;
  private readonly started: number;
  private lastTime: number;
  constructor(
    readonly binding: ReviewBinding,
    private readonly limits: GithubReadLimits,
    private readonly dependencies: GithubReadDependencies,
  ) {
    this.started = this.lastTime = dependencies.now();
    requireRead(Number.isFinite(this.started), 'unknown');
  }
  close(): void {
    this.stopped ??= 'budget';
    this.active?.abort();
  }
  private elapsed(): number {
    const time = this.dependencies.now();
    requireRead(Number.isFinite(time) && time >= this.lastTime, 'unknown');
    this.lastTime = time;
    return time - this.started;
  }
  private check(): void {
    if (this.stopped) throw new ReadFailure(this.stopped);
    if (this.elapsed() >= this.limits.totalTimeoutMs) {
      this.stopped = 'timeout';
      throw new ReadFailure('timeout');
    }
  }
  private consumeEntries(value: unknown): void {
    const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item !== 'object' || item === null) continue;
      const children = Object.values(item);
      this.entries += children.length;
      if (this.entries > this.limits.maxJsonEntries) {
        this.stopped = 'budget';
        throw new ReadFailure('budget');
      }
      pending.push(...children);
    }
  }
  private retain(value: unknown, bytes = 0): void {
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8') + bytes;
    if (size > this.limits.maxRetainedBytes - this.retained) {
      this.stopped = 'budget';
      throw new ReadFailure('budget');
    }
    this.retained += size;
  }
  private async get(path: string): Promise<{ value: unknown; headers: Headers }> {
    this.check();
    requireRead(this.requests < this.limits.maxRequests, 'budget');
    this.requests++;
    const controller = new AbortController();
    this.active = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let expired = false;
    const cancel = () => {
      if (reader) void reader.cancel().catch(() => {});
    };
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          cancel();
          reject(new ReadFailure(expired ? 'timeout' : 'budget'));
        },
        { once: true },
      );
    });
    const duration = Math.min(
      this.limits.requestTimeoutMs,
      this.limits.totalTimeoutMs - this.elapsed(),
    );
    const timer = setTimeout(() => {
      expired = true;
      this.stopped = 'timeout';
      controller.abort();
    }, duration);
    try {
      const response = await Promise.race([
        this.dependencies
          .fetch(`${ORIGIN}${path}`, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
            },
          })
          .then((result) => {
            if (controller.signal.aborted) {
              void result.body?.cancel().catch(() => {});
              throw new ReadFailure('timeout');
            }
            return result;
          }),
        aborted,
      ]);
      requireRead(!response.redirected, 'unknown');
      requireRead(response.body !== null);
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        this.bytes += chunk.value.byteLength;
        length += chunk.value.byteLength;
        if (length > this.limits.maxResponseBytes || this.bytes > this.limits.maxTotalBytes) {
          this.stopped = 'budget';
          controller.abort();
          throw new ReadFailure('budget');
        }
        this.check();
        chunks.push(chunk.value);
      }
      this.check();
      if (response.status !== 200) throw new ReadFailure(httpReason(response));
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)),
        );
      } catch {
        throw new ReadFailure('malformed');
      }
      return { value, headers: response.headers };
    } finally {
      clearTimeout(timer);
      cancel();
      if (this.active === controller) this.active = null;
    }
  }
  async metadata(): Promise<number> {
    const path = `${repoPath(this.binding.repository)}/pulls/${this.binding.pullNumber}`;
    const { value } = await this.get(path);
    this.consumeEntries(value);
    const state = classifyPullRequest(this.binding, value);
    if (state.kind === 'obsolete') throw new ReadFailure('conflict', true);
    if (state.kind === 'error')
      throw new ReadFailure(state.category === 'mismatch' ? 'conflict' : 'malformed');
    if (state.kind === 'compare') {
      const comparison = await this.get(
        `${repoPath(this.binding.repository)}/compare/${state.baseSha}...${this.binding.headSha}`,
      );
      this.consumeEntries(comparison.value);
      const checked = classifyPullRequest(this.binding, value, { value: comparison.value });
      if (checked.kind === 'obsolete') throw new ReadFailure('conflict', true);
      requireRead(checked.kind === 'current');
    }
    requireRead(
      record(value) &&
        typeof value.changed_files === 'number' &&
        Number.isSafeInteger(value.changed_files) &&
        value.changed_files >= 0,
    );
    return value.changed_files;
  }
  async initialize(): Promise<void> {
    await this.metadata();
    this.retain({ binding: this.binding });
  }
}

/** A session shares caller-supplied budgets across every read; creation grants no write authority. */
export async function createGithubReadSession(
  input: unknown,
  dependencies: GithubReadDependencies,
): Promise<GithubReadCreation> {
  let binding: ReviewBinding | null;
  let limits: GithubReadLimits | null;
  try {
    if (!record(input, ['binding', 'limits'])) return { kind: 'invalid' };
    binding = parseReviewBinding(input.binding);
    limits = parseLimits(input.limits);
    if (!binding || !limits) return { kind: 'invalid' };
    for (const value of [
      binding.repository.owner,
      binding.repository.name,
      binding.headRepository.owner,
      binding.headRepository.name,
      binding.baseRef,
    ]) {
      if (Buffer.byteLength(value, 'utf8') > PACKET_LIMITS.identityBytes)
        return { kind: 'invalid' };
    }
  } catch {
    return { kind: 'invalid' };
  }
  try {
    const session = new ReadSession(binding, limits, dependencies);
    await session.initialize();
    return { kind: 'ready', binding, session };
  } catch (error) {
    return error instanceof ReadFailure && error.obsolete
      ? { kind: 'obsolete' }
      : fixedFailure(error);
  }
}
