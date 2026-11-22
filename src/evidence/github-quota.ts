import { DURATION_MS } from '../format.js';

const GITHUB_API = 'https://api.github.com';
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
  const current = () => {
    if (window && options.wallNow() >= window.reset) window = null;
    return window;
  };
  return {
    admit(url) {
      if (!isGithub(url)) return { allowed: true };
      const estimate = current();
      if (!estimate) return { allowed: true };
      if (estimate.remaining - estimate.started - 1 < options.reserve)
        return { allowed: false, retryAt: estimate.reset };
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
  };
}
