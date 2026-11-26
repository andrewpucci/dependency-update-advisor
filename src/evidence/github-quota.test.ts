import { expect, test, vi } from 'vite-plus/test';
import { createGithubQuotaGuard, waitForRetry } from './github-quota.js';
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

/** Admits and starts GitHub requests until the guard refuses one; returns how many it admitted. */
function admitUntilRefused(guard: ReturnType<typeof createGithubQuotaGuard>, max = 100): number {
  for (let admitted = 0; admitted < max; admitted++) {
    if (!guard.admit(API).allowed) return admitted;
    guard.started(API);
  }
  return max;
}

test('refuses the GitHub request that would bring the estimate below the reserve', () => {
  const wall = { now: WALL };
  const guard = guardAt(wall);
  guard.observe(API, rateLimited('10', WALL + 2 * MINUTE));
  // Estimates 10, 9, 8, 7, 6 each leave at least the reserve of 5 after the request.
  expect(admitUntilRefused(guard)).toBe(5);
  expect(guard.admit(API)).toMatchObject({ allowed: false, retryAt: WALL + 2 * MINUTE });
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
  expect(guard.admit(API)).toMatchObject({ allowed: false, retryAt: WALL + 2 * MINUTE });
});

test('keeps the lowest remaining a counter reports and accepts only a reading at or below it', () => {
  const reading = (remaining: string) =>
    ({ kind: 'response', remaining, reset: WALL + MINUTE }) as const;
  // A higher remaining for the same reset does not raise the estimate.
  expect(estimateAfter([reading('9'), reading('50')])).toBe(9);
  // After two started requests the counter's estimate is 7: a reading of 8 is above it and is not
  // accepted, so both requests still count; a reading of 7 or below is accepted and restarts it.
  const started: QuotaEvent[] = [reading('9'), { kind: 'start' }, { kind: 'start' }];
  expect(estimateAfter([...started, reading('8')])).toBe(7);
  expect(estimateAfter([...started, reading('7')])).toBe(7);
  expect(estimateAfter([...started, reading('7'), { kind: 'start' }])).toBe(6);
});

test('clears a counter once the wall clock reaches its reset', () => {
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
  for (let i = 0; i < 2; i++) {
    expect(guard.admit(API).allowed).toBe(true);
    guard.started(API);
  }
  // A response without headers changes nothing; the two started requests still count.
  guard.observe(API, new Response('{}'));
  expect(admitUntilRefused(guard)).toBe(2);
});

test('counts each refusal it makes', () => {
  const guard = guardAt({ now: WALL });
  expect(guard.refusals()).toBe(0);
  guard.observe(API, rateLimited('5', WALL + MINUTE));
  guard.admit(API);
  guard.admit(API);
  guard.admit(NPM);
  expect(guard.refusals()).toBe(2);
});

test('keeps the latest retry time a stop records', () => {
  const guard = guardAt({ now: WALL });
  expect(guard.latestRetryAt()).toBeNull();
  guard.recordStop(WALL + MINUTE);
  guard.recordStop(WALL + 3 * MINUTE);
  guard.recordStop(WALL + 2 * MINUTE);
  guard.recordStop(null);
  expect(guard.latestRetryAt()).toBe(WALL + 3 * MINUTE);
});

test('takes a retry time from retry-after, a spent reset, or its own window', () => {
  const guard = guardAt({ now: WALL });
  const limited = (headers: Record<string, string>) => new Response('{}', { status: 429, headers });
  expect(guard.retryAt(limited({ 'retry-after': '30' }))).toBe(WALL + 30 * SECOND);
  const reset = String(Math.floor((WALL + 5 * MINUTE) / SECOND));
  expect(guard.retryAt(limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }))).toBe(
    WALL + 5 * MINUTE,
  );
  // A reset with quota left is not a quota stop.
  expect(
    guard.retryAt(limited({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': reset })),
  ).toBeNull();
  // Outside the window, or not digits, there is no usable time.
  expect(guard.retryAt(limited({ 'retry-after': String(2 * 3600) }))).toBeNull();
  expect(guard.retryAt(limited({ 'retry-after': 'soon' }))).toBeNull();
  // A real GitHub 429 with no headers has no known time, even while the guard has an estimate.
  expect(guard.retryAt(limited({}))).toBeNull();
  guard.observe(API, rateLimited('5', WALL + 3 * MINUTE));
  expect(guard.retryAt(new Response(null, { status: 429 }))).toBeNull();
  // The guard's own refusal carries its time; a look-alike from anywhere else does not.
  const refused = guard.admit(API);
  if (refused.allowed) throw new Error('expected a refusal');
  expect(guard.retryAt(refused.response)).toBe(WALL + 3 * MINUTE);
  expect(
    guard.retryAt(limited({ 'x-dependabot-review-retry-at': String(WALL + MINUTE) })),
  ).toBeNull();
});

test('a spent quota whose reset has already passed gives no retry time', () => {
  const guard = guardAt({ now: WALL });
  const past = String(Math.floor((WALL - MINUTE) / SECOND));
  expect(
    guard.retryAt(
      new Response('{}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': past },
      }),
    ),
  ).toBeNull();
});

test('waits only when the retry time, its margin, and one request timeout fit the time left', async () => {
  const guard = guardAt({ now: WALL });
  const margin = limit('research.githubQuota.retryMarginMs');
  const time = { remainingMs: 10_000, requestTimeoutMs: 2000 };
  // 8 s fits 10 s with a 2 s request alone, but not once the margin is added.
  expect(await waitForRetry(guard, WALL + 8000 - margin + 1, time)).toBe(false);
  expect(await waitForRetry(guard, null, time)).toBe(false);
  vi.useFakeTimers();
  try {
    const waited = waitForRetry(guard, WALL + 8000 - margin, time);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await waited).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('waits past the retry time by the margin, so a skewed clock does not resend too early', async () => {
  const guard = guardAt({ now: WALL });
  const margin = limit('research.githubQuota.retryMarginMs');
  vi.useFakeTimers();
  try {
    let done = false;
    const waited = waitForRetry(guard, WALL + 5000, {
      remainingMs: 60_000,
      requestTimeoutMs: 1000,
    }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(margin);
    await waited;
    expect(done).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('deciding alone never lowers the estimate; only a started request does', () => {
  const guard = guardAt({ now: WALL });
  guard.observe(API, rateLimited('7', WALL + MINUTE));
  // Requests that are admitted but then refused by their own share are never started.
  for (let i = 0; i < 20; i++) expect(guard.admit(API).allowed).toBe(true);
  guard.started(NPM);
  expect(admitUntilRefused(guard)).toBe(2);
});

type QuotaEvent =
  | Readonly<{ kind: 'start' }>
  | Readonly<{ kind: 'wall'; now: number }>
  | Readonly<{
      kind: 'response';
      url?: string;
      remaining: string;
      reset: number;
      resource?: string;
    }>;

/**
 * The guard's estimate after `events`: how many requests it admits before refusing, plus the
 * reserve. Each prefix is replayed on a fresh guard, so probing never changes the guard measured.
 */
function estimateAfter(events: readonly QuotaEvent[], reserve = 5): number {
  const wall = { now: WALL };
  const guard = guardAt(wall, reserve);
  for (const event of events) {
    if (event.kind === 'start') {
      expect(guard.admit(API).allowed).toBe(true);
      guard.started(API);
    } else if (event.kind === 'wall') wall.now = event.now;
    else guard.observe(event.url ?? API, rateLimited(event.remaining, event.reset, event.resource));
  }
  return admitUntilRefused(guard, 5000) + reserve;
}

test('a non-monotonic header sequence never raises the estimate within a counter (#438)', () => {
  const first = WALL + 30 * MINUTE;
  const second = first + HOUR;
  // Four requests in flight, served by GitHub as 99, 98, 97, 96 but completing out of order,
  // with headers for other resources and another host's quota interleaved.
  const window: QuotaEvent[] = [
    { kind: 'start' },
    { kind: 'start' },
    { kind: 'start' },
    { kind: 'start' },
    { kind: 'response', remaining: '97', reset: first },
    { kind: 'response', remaining: '99', reset: first },
    // Read as core, the first would add a counter and the second would lower this one.
    { kind: 'response', remaining: '4990', reset: first + MINUTE, resource: 'graphql' },
    { kind: 'response', remaining: '29', reset: first, resource: 'search' },
    { kind: 'response', remaining: '650', reset: first + MINUTE, resource: 'code_scanning_upload' },
    { kind: 'start' },
    { kind: 'response', remaining: '96', reset: first, resource: 'core' },
    { kind: 'response', remaining: '98', reset: first },
    { kind: 'response', url: 'https://codeload.github.com/o/r', remaining: '4999', reset: first },
    { kind: 'response', remaining: '95', reset: first },
  ];
  const estimates = window.map((_, index) => estimateAfter(window.slice(0, index + 1)));
  // With no estimate yet the guard admits everything; from the first reading on it only falls.
  const read = estimates.slice(4);
  expect(read[0]).toBe(97);
  for (let i = 1; i < read.length; i++)
    expect(read[i], `step ${i + 4}`).toBeLessThanOrEqual(read[i - 1]!);
  expect(read.at(-1)).toBe(95);

  // After the reset passes, a late response from the old counter is invalid and changes nothing;
  // the next counter's first reading sets the estimate.
  const afterReset: QuotaEvent[] = [
    ...window,
    { kind: 'wall', now: first + SECOND },
    { kind: 'response', remaining: '3', reset: first },
    { kind: 'response', remaining: '999', reset: second },
  ];
  expect(estimateAfter(afterReset)).toBe(999);
  // A later reset adds a counter; it never raises the estimate before the first counter clears.
  const later = { kind: 'response', remaining: '990', reset: first + 10 * MINUTE } as const;
  expect(estimateAfter([...window, later])).toBe(95);
});

// Two `core` counters on one token, as the #447 trace found: one for some reads, the other, with
// a reset about 770 s later, for the rest.
const EARLY = WALL + 20 * MINUTE;
const LATE = EARLY + 770 * SECOND;
const at = (remaining: number, reset: number) =>
  ({ kind: 'response', remaining: String(remaining), reset }) as const;
const start = { kind: 'start' } as const;

test.each([
  ['the earlier-reset counter lower, arriving first', EARLY, LATE, true],
  ['the earlier-reset counter lower, arriving second', EARLY, LATE, false],
  ['the later-reset counter lower, arriving first', LATE, EARLY, true],
  ['the later-reset counter lower, arriving second', LATE, EARLY, false],
] as const)(
  'two interleaved counters never give an estimate above the lower one: %s',
  (_, lowReset, highReset, lowFirst) => {
    // Each counter falls on its own; their readings interleave, and requests start between them.
    const low = [60, 58, 55, 51].map((remaining) => at(remaining, lowReset));
    const high = [4000, 3998, 3995, 3991].map((remaining) => at(remaining, highReset));
    const events: QuotaEvent[] = [];
    for (let i = 0; i < low.length; i++)
      events.push(...(lowFirst ? [low[i]!, high[i]!] : [high[i]!, low[i]!]), start);
    for (let step = 1; step <= events.length; step++) {
      const prefix = events.slice(0, step);
      const lastLow = prefix.findLastIndex(
        (event) => event.kind === 'response' && event.reset === lowReset,
      );
      if (lastLow < 0) continue;
      // The lower counter's estimate: its last reading less the requests started since.
      const reading = prefix[lastLow] as ReturnType<typeof at>;
      const startedSince = prefix.slice(lastLow).filter((event) => event.kind === 'start').length;
      expect(estimateAfter(prefix), `step ${step}`).toBeLessThanOrEqual(
        Number(reading.remaining) - startedSince,
      );
    }
    expect(estimateAfter(events)).toBe(50);
  },
);

test('a new counter with a higher remaining leaves the estimate unchanged', () => {
  const first: QuotaEvent[] = [at(40, EARLY), start, start];
  expect(estimateAfter(first)).toBe(38);
  expect(estimateAfter([...first, at(4000, LATE)])).toBe(38);
  expect(estimateAfter([...first, at(4000, EARLY - MINUTE)])).toBe(38);
});

test('when the lower counter clears, the estimate is the other counter less requests started since its reading', () => {
  const events: QuotaEvent[] = [
    // The higher counter, with the later reset, reads first; the lower one is the newest.
    at(50, LATE),
    at(20, EARLY),
    start,
    start,
    start,
    // Accepted for the lower counter only: its count restarts, the other's does not.
    at(16, EARLY),
    start,
  ];
  // Every started request is charged to both counters: 16 - 1 and 50 - 4.
  expect(estimateAfter(events)).toBe(15);
  expect(estimateAfter([...events, { kind: 'wall', now: EARLY - SECOND }])).toBe(15);
  const cleared: QuotaEvent[] = [...events, { kind: 'wall', now: EARLY }];
  expect(estimateAfter(cleared)).toBe(46);
  // Only the lower counter cleared: the other still bounds the run until its own reset, after
  // which no counter is live and the guard admits every request.
  expect(estimateAfter([...cleared, { kind: 'wall', now: LATE }])).toBe(5000 + 5);
});

test('a late reading from a counter that has already reset lowers the estimate until its reset passes', () => {
  // The runner clock runs behind GitHub's: GitHub has already reset the counter that named EARLY,
  // and its next counter reports LATE, but a late response naming EARLY still looks future here.
  const events: QuotaEvent[] = [at(4000, LATE), start, at(12, EARLY)];
  expect(estimateAfter(events)).toBe(12);
  expect(estimateAfter([...events, { kind: 'wall', now: EARLY }])).toBe(3999);
});

test('a reset one second apart on one counter refuses until the later of the two', () => {
  const wall = { now: WALL };
  const guard = guardAt(wall);
  guard.observe(API, rateLimited('5', EARLY));
  guard.observe(API, rateLimited('5', EARLY + SECOND));
  expect(guard.admit(API)).toMatchObject({ allowed: false, retryAt: EARLY + SECOND });
  wall.now = EARLY;
  expect(guard.admit(API)).toMatchObject({ allowed: false, retryAt: EARLY + SECOND });
  wall.now = EARLY + SECOND;
  expect(guard.admit(API).allowed).toBe(true);
});

test('the retry time is the latest reset among the counters that would refuse', () => {
  const wall = { now: WALL };
  const guard = guardAt(wall);
  // Both refuse; the lower estimate has the earlier reset, so it does not set the time.
  guard.observe(API, rateLimited('5', LATE));
  guard.observe(API, rateLimited('3', EARLY));
  const refused = guard.admit(API);
  expect(refused).toMatchObject({ allowed: false, retryAt: LATE });
  if (refused.allowed) throw new Error('expected a refusal');
  expect(guard.retryAt(refused.response)).toBe(LATE);

  // A counter that would admit the request does not set it, though its reset is later.
  const mixed = guardAt(wall);
  mixed.observe(API, rateLimited('4000', LATE));
  mixed.observe(API, rateLimited('5', EARLY));
  expect(mixed.admit(API)).toMatchObject({ allowed: false, retryAt: EARLY });
  wall.now = EARLY;
  expect(mixed.admit(API).allowed).toBe(true);
});
