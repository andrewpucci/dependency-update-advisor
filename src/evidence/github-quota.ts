import { DURATION_MS } from '../format.js';

const GITHUB_API = 'https://api.github.com';
/**
 * Set only on the guard's own synthetic refusal: the Unix-millisecond time it can be retried. It is
 * not a rate-limit header, so the guard never reads its own refusal as quota.
 */
export const QUOTA_REFUSAL_RETRY_AT = 'x-dependabot-review-retry-at';
const DIGITS = /^\d+$/;

export type QuotaAdmission =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; retryAt: number | null }>;

/**
 * The run's guard on research's GitHub requests. It follows the quota GitHub reports, so research
 * never takes the requests the post-research rechecks need, as far as the estimate can tell.
 */
export type GithubQuotaGuard = Readonly<{
  /** Called after a cache miss and before the share is charged; a refusal is never sent. */
  admit(url: string): QuotaAdmission;
  /** Called only with a response returned by the network, never a cached or synthetic one. */
  observe(url: string, response: Response): void;
  /** How many requests the guard has refused this run. */
  refusals(): number;
  /**
   * When a rate-limited GitHub response can be retried: the guard's own refusal time, else its
   * `retry-after`, else its reset when the quota is spent. Null when the time is unknown or outside
   * the window.
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

function isGithub(url: string): boolean {
  try {
    return new URL(url).origin === GITHUB_API;
  } catch {
    return false;
  }
}

function count(value: string | null): number | null {
  if (value === null || !DIGITS.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createGithubQuotaGuard(options: GithubQuotaOptions): GithubQuotaGuard {
  let window: { reset: number; remaining: number; started: number } | null = null;
  let refused = 0;
  let latest: number | null = null;
  const inWindow = (time: number) => {
    const now = options.wallNow();
    return time >= now && time <= now + options.windowMs;
  };
  const current = () => {
    if (window && options.wallNow() >= window.reset) window = null;
    return window;
  };
  return {
    admit(url) {
      if (!isGithub(url)) return { allowed: true };
      const estimate = current();
      if (!estimate) return { allowed: true };
      if (estimate.remaining - estimate.started - 1 < options.reserve) {
        refused += 1;
        return { allowed: false, retryAt: estimate.reset };
      }
      estimate.started += 1;
      return { allowed: true };
    },
    observe(url, response) {
      if (!isGithub(url)) return;
      const resource = response.headers.get('x-ratelimit-resource');
      if (resource !== null && resource !== 'core') return;
      const remaining = count(response.headers.get('x-ratelimit-remaining'));
      const resetSeconds = count(response.headers.get('x-ratelimit-reset'));
      if (remaining === null || resetSeconds === null) return;
      const reset = resetSeconds * DURATION_MS.second;
      const now = options.wallNow();
      if (reset <= now || reset > now + options.windowMs) return;
      const estimate = current();
      if (estimate && reset < estimate.reset) return;
      if (estimate && reset === estimate.reset) {
        if (remaining > estimate.remaining - estimate.started) return;
      }
      window = { reset, remaining, started: 0 };
    },
    refusals: () => refused,
    retryAt(response) {
      const refused = count(response.headers.get(QUOTA_REFUSAL_RETRY_AT));
      if (refused !== null) return inWindow(refused) ? refused : null;
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
 * Waits for `retryAt` when that time plus one request timeout fits in the time the reader has left,
 * and reports whether it waited. The wait ends early, with an error, when `signal` aborts.
 */
export async function waitForRetry(
  guard: GithubQuotaGuard,
  retryAt: number | null,
  time: Readonly<{ remainingMs: number; requestTimeoutMs: number; signal?: AbortSignal }>,
): Promise<boolean> {
  if (retryAt === null) return false;
  const wait = Math.max(0, guard.msUntil(retryAt));
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
