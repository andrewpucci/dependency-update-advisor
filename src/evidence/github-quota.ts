import { DURATION_MS, HTTP_STATUS } from '../format.js';
import { limit } from '../limits.js';

/** The GitHub REST API origin: the only host whose rate-limit headers the guard reads. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
const DIGITS = /^\d+$/;

export type QuotaAdmission =
  | Readonly<{ allowed: true }>
  /** `response` is the guard's own header-less 429; only the guard knows its retry time. */
  | Readonly<{ allowed: false; retryAt: number | null; response: Response }>;

/**
 * The run's guard on research's GitHub requests. It follows the quota GitHub reports, so research
 * never takes the requests the post-research rechecks need, as far as the estimate can tell.
 */
export type GithubQuotaGuard = Readonly<{
  /**
   * Called after a cache miss and before the share is charged; a refusal is never sent. Deciding
   * does not count the request: `started` does, once the share has been charged.
   */
  admit(url: string): QuotaAdmission;
  /** Counts a GitHub request that has passed its share's charge and is about to be sent. */
  started(url: string): void;
  /** Called only with a response returned by the network, never a cached or synthetic one. */
  observe(url: string, response: Response): void;
  /**
   * How many requests the guard has refused this run. It does not report which counter refused
   * each one; per-counter refusal reporting is an observability follow-up.
   */
  refusals(): number;
  /**
   * When a rate-limited GitHub response can be retried: for the guard's own refusal, the latest
   * reset among the counters that refused it; else the response's `retry-after`, else its reset
   * when the quota is spent. Null when the time is unknown or outside the window.
   */
  retryAt(response: Response): number | null;
  /** Wall milliseconds from now until `retryAt`. */
  msUntil(retryAt: number): number;
  /** Records the retry time of a stop that ended members `rate_limit`. */
  recordStop(retryAt: number | null): void;
  /** The latest retry time recorded by a stop, or null. */
  latestRetryAt(): number | null;
}>;

export type GithubQuotaOptions = Readonly<{
  /** Requests the estimate must keep for the GitHub reads after research. */
  reserve: number;
  /** Wall time in Unix milliseconds; reset headers are Unix seconds. */
  wallNow: () => number;
  /** How far ahead a reported reset may be; GitHub's quota resets hourly. */
  windowMs: number;
}>;

/** Whether `url` is on the GitHub REST API, the one host whose quota research guards and waits on. */
export function isGithubApi(url: string): boolean {
  try {
    return new URL(url).origin === GITHUB_API_ORIGIN;
  } catch {
    return false;
  }
}

function count(value: string | null): number | null {
  if (value === null || !DIGITS.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A valid core rate-limit reading from one live GitHub API response (A2.3). */
export type QuotaReading = Readonly<{ remaining: number; reset: number }>;

/**
 * The response's core `x-ratelimit-remaining` and its reset in Unix milliseconds, or null when the
 * response is from another host, names another resource, or either header is invalid or its reset
 * is past or beyond the quota window. The guard and the demand measurement read quota only
 * through this, so both apply the same validity rules; the measurement applies them to every live
 * GitHub API response the run makes, while the guard sees only research's.
 */
export function quotaReading(
  url: string,
  response: Response,
  options: Pick<GithubQuotaOptions, 'wallNow' | 'windowMs'>,
): QuotaReading | null {
  if (!isGithubApi(url)) return null;
  const resource = response.headers.get('x-ratelimit-resource');
  if (resource !== null && resource !== 'core') return null;
  const remaining = count(response.headers.get('x-ratelimit-remaining'));
  const resetSeconds = count(response.headers.get('x-ratelimit-reset'));
  if (remaining === null || resetSeconds === null) return null;
  const reset = resetSeconds * DURATION_MS.second;
  const now = options.wallNow();
  if (reset <= now || reset > now + options.windowMs) return null;
  return { remaining, reset };
}

/**
 * One GitHub quota counter's estimate (Q1.2): its last accepted remaining and the research requests
 * started since that reading.
 */
type Counter = { remaining: number; started: number };

export function createGithubQuotaGuard(options: GithubQuotaOptions): GithubQuotaGuard {
  /**
   * One token can draw on more than one `core` counter at once, each with its own reset (#447), so
   * the guard keeps one estimate per reset and never lets one counter's reading stand for another.
   */
  const counters = new Map<number, Counter>();
  let refused = 0;
  /** The guard's own refusals and their retry times; no other response can stand in for one. */
  const ownRefusals = new WeakMap<Response, number | null>();
  let latest: number | null = null;
  const inWindow = (time: number) => {
    const now = options.wallNow();
    return time >= now && time <= now + options.windowMs;
  };
  /** The live counters: each is cleared, on its own, once the wall clock reaches its reset. */
  const live = () => {
    const now = options.wallNow();
    for (const reset of counters.keys()) if (now >= reset) counters.delete(reset);
    return counters;
  };
  return {
    admit(url) {
      if (!isGithubApi(url)) return { allowed: true };
      // The request may draw on any live counter, so each one that would fall below the reserve
      // refuses it, and the retry time is the latest of their resets (Q2): only once they have
      // all cleared can the request be admitted.
      let retryAt: number | null = null;
      for (const [reset, counter] of live()) {
        if (counter.remaining - counter.started - 1 >= options.reserve) continue;
        if (retryAt === null || reset > retryAt) retryAt = reset;
      }
      if (retryAt === null) return { allowed: true };
      refused += 1;
      const response = new Response(null, { status: HTTP_STATUS.tooManyRequests });
      ownRefusals.set(response, retryAt);
      return { allowed: false, retryAt, response };
    },
    started(url) {
      if (!isGithubApi(url)) return;
      // No response says in advance which counter it draws on, so every live counter is charged,
      // and no later response refunds one (Q1.3).
      for (const counter of live().values()) counter.started += 1;
    },
    observe(url, response) {
      const reading = quotaReading(url, response, options);
      if (!reading) return;
      const { remaining, reset } = reading;
      const counter = live().get(reset);
      // A counter's estimate never rises: a higher remaining for its reset is a response served
      // earlier, or counted by another GitHub node, arriving late. A new counter starts at its
      // own reading, which cannot raise the guard's estimate, the lowest of them; only a counter
      // clearing can.
      if (counter && remaining > counter.remaining - counter.started) return;
      counters.set(reset, { remaining, started: 0 });
    },
    refusals: () => refused,
    retryAt(response) {
      if (ownRefusals.has(response)) {
        const own = ownRefusals.get(response) ?? null;
        return own !== null && inWindow(own) ? own : null;
      }
      const after = count(response.headers.get('retry-after'));
      if (after !== null) {
        const time = options.wallNow() + after * DURATION_MS.second;
        return inWindow(time) ? time : null;
      }
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = count(response.headers.get('x-ratelimit-reset'));
      if (remaining === '0' && reset !== null) {
        const time = reset * DURATION_MS.second;
        return inWindow(time) ? time : null;
      }
      return null;
    },
    msUntil: (retryAt) => retryAt - options.wallNow(),
    recordStop(retryAt) {
      if (retryAt !== null && (latest === null || retryAt > latest)) latest = retryAt;
    },
    latestRetryAt: () => latest,
  };
}

/**
 * Waits until `retryAt` plus a safety margin when that, plus one request timeout, fits in the time
 * the reader has left, and reports whether it waited. The wait ends early, with an error, when `signal` aborts.
 */
export async function waitForRetry(
  guard: GithubQuotaGuard,
  retryAt: number | null,
  time: Readonly<{ remainingMs: number; requestTimeoutMs: number; signal?: AbortSignal }>,
): Promise<boolean> {
  if (retryAt === null) return false;
  // Past the reported reset by a margin, so a runner clock slightly ahead of GitHub's does not
  // resend just before the quota actually resets.
  const wait = Math.max(0, guard.msUntil(retryAt)) + limit('research.githubQuota.retryMarginMs');
  if (wait + time.requestTimeoutMs > time.remainingMs) return false;
  await new Promise<void>((resolve, reject) => {
    if (time.signal?.aborted) return reject(new Error('wait aborted'));
    const timer = setTimeout(() => {
      time.signal?.removeEventListener('abort', abort);
      resolve();
    }, wait);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('wait aborted'));
    };
    time.signal?.addEventListener('abort', abort, { once: true });
  });
  return true;
}
