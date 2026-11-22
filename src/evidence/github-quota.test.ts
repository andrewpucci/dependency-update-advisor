import { expect, test } from 'vite-plus/test';
import { createGithubQuotaGuard } from './github-quota.js';
import { limit } from '../limits.js';

const API = 'https://api.github.com/repos/o/r/releases';
const NPM = 'https://registry.npmjs.org/pkg';
/** A realistic wall time: 2026-11-21T00:00:00Z. */
const WALL = Date.UTC(2026, 10, 21);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function rateLimited(remaining: string, resetMs: number, resource?: string): Response {
  const headers: Record<string, string> = {
    'x-ratelimit-remaining': remaining,
    'x-ratelimit-reset': String(Math.floor(resetMs / SECOND)),
  };
  if (resource !== undefined) headers['x-ratelimit-resource'] = resource;
  return new Response('{}', { status: 200, headers });
}

function guardAt(wall: { now: number }, reserve = 5) {
  return createGithubQuotaGuard({
    reserve,
    wallNow: () => wall.now,
    windowMs: limit('research.githubQuota.windowMs'),
  });
}

/** Admits GitHub requests until the guard refuses one; returns how many it admitted. */
function admitUntilRefused(guard: ReturnType<typeof createGithubQuotaGuard>, max = 100): number {
  for (let admitted = 0; admitted < max; admitted++) {
    if (!guard.admit(API).allowed) return admitted;
  }
  return max;
}

test('refuses the GitHub request that would bring the estimate below the reserve', () => {
  const wall = { now: WALL };
  const guard = guardAt(wall);
  guard.observe(API, rateLimited('10', WALL + 2 * MINUTE));
  // Estimates 10, 9, 8, 7, 6 each leave at least the reserve of 5 after the request.
  expect(admitUntilRefused(guard)).toBe(5);
  expect(guard.admit(API)).toEqual({ allowed: false, retryAt: WALL + 2 * MINUTE });
});

test('with no estimate yet, admits every request', () => {
  const guard = guardAt({ now: WALL });
  expect(admitUntilRefused(guard, 50)).toBe(50);
});

test('never refuses or reads headers for a host other than the GitHub API', () => {
  const guard = guardAt({ now: WALL });
  guard.observe(NPM, rateLimited('0', WALL + MINUTE));
  expect(guard.admit(API).allowed).toBe(true);
  guard.observe(API, rateLimited('5', WALL + MINUTE));
  expect(guard.admit(API).allowed).toBe(false);
  expect(guard.admit(NPM)).toEqual({ allowed: true });
});

test('ignores a response whose rate-limit resource is not core', () => {
  const guard = guardAt({ now: WALL });
  guard.observe(API, rateLimited('0', WALL + MINUTE, 'search'));
  expect(guard.admit(API).allowed).toBe(true);
  guard.observe(API, rateLimited('5', WALL + MINUTE, 'core'));
  expect(guard.admit(API).allowed).toBe(false);
});

test('ignores header values that are not plain digits', () => {
  const guard = guardAt({ now: WALL });
  // Headers trims surrounding whitespace itself, so only the value's own characters are tested.
  for (const remaining of ['', '-1', '1e3', '0x5', '5.0', '5 5', '99999999999999999999']) {
    guard.observe(API, rateLimited(remaining, WALL + MINUTE));
    expect(guard.admit(API).allowed, remaining).toBe(true);
  }
  const badReset = new Response('{}', {
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'soon' },
  });
  guard.observe(API, badReset);
  expect(guard.admit(API).allowed).toBe(true);
});

test('judges a reset on the wall clock: past or beyond the window is ignored', () => {
  const wall = { now: WALL };
  const guard = guardAt(wall);
  guard.observe(API, rateLimited('0', WALL - MINUTE));
  guard.observe(API, rateLimited('0', WALL + 2 * HOUR));
  expect(guard.admit(API).allowed).toBe(true);
  guard.observe(API, rateLimited('0', WALL + 2 * MINUTE));
  expect(guard.admit(API)).toEqual({ allowed: false, retryAt: WALL + 2 * MINUTE });
});

test('keeps the lowest remaining in a window and starts a new window on a later reset', () => {
  const wall = { now: WALL };
  const guard = guardAt(wall);
  guard.observe(API, rateLimited('7', WALL + MINUTE));
  // A higher remaining for the same reset does not raise the estimate.
  guard.observe(API, rateLimited('50', WALL + MINUTE));
  expect(admitUntilRefused(guard)).toBe(2);
  // An earlier reset than the current window's is ignored.
  guard.observe(API, rateLimited('50', WALL + 30 * SECOND));
  expect(guard.admit(API).allowed).toBe(false);
  // A later reset starts a new window with its own remaining.
  guard.observe(API, rateLimited('50', WALL + 10 * MINUTE));
  expect(admitUntilRefused(guard)).toBe(45);
});

test('clears the estimate once the window reset passes', () => {
  const wall = { now: WALL };
  const guard = guardAt(wall);
  guard.observe(API, rateLimited('5', WALL + MINUTE));
  expect(guard.admit(API).allowed).toBe(false);
  wall.now = WALL + MINUTE;
  expect(admitUntilRefused(guard, 20)).toBe(20);
});

test('requests started since the last valid header lower the estimate', () => {
  const guard = guardAt({ now: WALL });
  guard.observe(API, rateLimited('9', WALL + MINUTE));
  expect(guard.admit(API).allowed).toBe(true);
  expect(guard.admit(API).allowed).toBe(true);
  // A response without headers changes nothing; the two admitted requests still count.
  guard.observe(API, new Response('{}'));
  expect(admitUntilRefused(guard)).toBe(2);
});
