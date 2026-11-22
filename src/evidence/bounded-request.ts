import type { EvidenceReason } from '../schema.js';
import { advisoryCheck, AdvisoryFailure } from './advisory-read.js';
import { isPlainObject } from './common.js';
import { QUOTA_REFUSAL_RETRY_AT, type GithubQuotaGuard } from './github-quota.js';
import type { ResearchCache } from './research-cache.js';
import { HTTP_STATUS, MAX_TIMER_MS } from '../format.js';

export type BoundedLimits = {
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxJsonEntries: number;
  maxJsonDepth: number;
  maxWork: number;
  maxRetainedBytes: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
};
export type BoundedDependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
  /** Run-scoped research cache. Event, snapshot, and freshness reads never receive one. */
  cache?: ResearchCache;
  /** The run's research GitHub quota guard. Event, snapshot, and freshness reads never receive one. */
  quota?: GithubQuotaGuard;
};
type BoundedRequest = (
  | { url: string; accept: string; headers?: never }
  | { url: string; headers: Record<string, string>; accept?: never }
) & {
  timeoutMs: number;
  signal?: AbortSignal;
  /** A fixed body sent as a JSON `POST`; absent for a `GET`. */
  json?: unknown;
  /** Charges the reader's share for a live request; never called for a cache hit. */
  charge?: () => void;
};
export function boundedLimits(value: unknown): BoundedLimits {
  advisoryCheck(isPlainObject(value));
  const keys = [
    'maxRequests',
    'maxResponseBytes',
    'maxTotalBytes',
    'maxJsonEntries',
    'maxJsonDepth',
    'maxWork',
    'maxRetainedBytes',
    'requestTimeoutMs',
    'totalTimeoutMs',
  ] as const;
  advisoryCheck(keys.every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) > 0));
  advisoryCheck(
    Number(value.maxResponseBytes) <= Number(value.maxTotalBytes) &&
      Number(value.requestTimeoutMs) <= Number(value.totalTimeoutMs) &&
      Number(value.requestTimeoutMs) <= MAX_TIMER_MS,
  );
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as BoundedLimits;
}
/** Wall-clock budget shared by every request of one reader; a non-monotonic clock is unknown. */
export class BoundedClock {
  private readonly started: number;
  private last: number;
  constructor(
    private readonly totalTimeoutMs: number,
    private readonly deps: BoundedDependencies,
  ) {
    this.started = this.last = deps.now();
    advisoryCheck(Number.isFinite(this.started));
  }
  remaining(stopped: EvidenceReason | null) {
    advisoryCheck(!stopped && !this.deps.signal?.aborted, stopped ?? 'unknown');
    const now = this.deps.now();
    advisoryCheck(Number.isFinite(now) && now >= this.last, 'unknown');
    this.last = now;
    const left = this.totalTimeoutMs - (now - this.started);
    advisoryCheck(left > 0, 'timeout');
    return left;
  }
}
/** Node clamps oversized delays, so long request deadlines must be scheduled in platform-sized parts. */
function deadlineTimer(duration: number, expire: () => void) {
  let remaining = duration,
    handle: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const interval = Math.min(remaining, MAX_TIMER_MS);
    handle = setTimeout(() => {
      remaining -= interval;
      if (remaining > 0) schedule();
      else expire();
    }, interval);
  };
  schedule();
  return () => clearTimeout(handle);
}
/**
 * Stores a response read from `url` itself and returns the copy to consume. A redirected or
 * relocated response is returned unstored, so the reader's own identity check still rejects it;
 * a cached copy carries no URL to check.
 */
async function remember(
  cache: ResearchCache | undefined,
  key: string | undefined,
  url: string,
  response: Response,
  aborted: Promise<never>,
): Promise<Response> {
  if (!cache || key === undefined) return response;
  if (response.redirected || (response.url && response.url !== url)) return response;
  return Promise.race([cache.store(key, response), aborted]);
}
/**
 * A response that needs no request: a cache hit, or the quota guard's refusal. A refusal is never
 * sent or charged, and carries no rate-limit headers for the guard to read.
 */
function answeredLocally(
  deps: BoundedDependencies,
  key: string | undefined,
  url: string,
): { response: Response; cached: boolean } | null {
  const hit = key === undefined ? undefined : deps.cache?.lookup(key);
  if (hit) return { response: hit, cached: true };
  const admission = deps.quota?.admit(url);
  if (admission && !admission.allowed) {
    const headers =
      admission.retryAt === null
        ? undefined
        : { [QUOTA_REFUSAL_RETRY_AT]: String(admission.retryAt) };
    return {
      response: new Response(null, { status: HTTP_STATUS.tooManyRequests, headers }),
      cached: false,
    };
  }
  return null;
}
/**
 * One credential-free GET, or a POST of a fixed `json` body, raced against its timeout, the
 * caller's signal, and `onCancel` (registered for the reader's close). Every exit aborts the
 * request and releases its body.
 */
export async function boundedGet<T>(
  deps: BoundedDependencies,
  request: BoundedRequest,
  onCancel: (cancel: (() => void) | null) => void,
  consume: (response: Response, aborted: Promise<never>, cached: boolean) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let reject: (error: AdvisoryFailure) => void = () => {};
  const aborted = new Promise<never>((_, r) => {
    reject = r;
  });
  const stop = (reason: EvidenceReason) => {
    reject(new AdvisoryFailure(reason));
    controller.abort();
  };
  const cancel = () => stop('unknown');
  onCancel(cancel);
  const signals = [deps.signal, request.signal].filter((signal): signal is AbortSignal => !!signal);
  for (const signal of signals) signal.addEventListener('abort', cancel, { once: true });
  const clear = deadlineTimer(request.timeoutMs, () => stop('timeout'));
  let response: Response | undefined;
  try {
    if (signals.some((signal) => signal.aborted)) return await aborted;
    const headers: Record<string, string> =
      'headers' in request && request.headers
        ? { ...request.headers }
        : { accept: request.accept! };
    const post = request.json !== undefined;
    if (post) headers['content-type'] = 'application/json';
    const body = post ? JSON.stringify(request.json) : undefined;
    const key = deps.cache?.key(post ? 'POST' : 'GET', request.url, headers, body);
    const local = answeredLocally(deps, key, request.url);
    if (local) return await consume(local.response, aborted, local.cached);
    request.charge?.();
    const pending = deps.fetch(request.url, {
      method: post ? 'POST' : 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    void pending.then(
      (late) => {
        if (controller.signal.aborted && late.body && !late.body.locked)
          void late.body.cancel().catch(() => {});
      },
      () => {},
    );
    response = await Promise.race([pending, aborted]);
    deps.quota?.observe(request.url, response);
    response = await remember(deps.cache, key, request.url, response, aborted);
    return await consume(response, aborted, false);
  } finally {
    clear();
    for (const signal of signals) signal.removeEventListener('abort', cancel);
    onCancel(null);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
