const MiB = 1024 * 1024;

/** The approved W2 pre-analysis evidence envelope. Time is shared; every reader gets what remains. */
export const W2_ENVELOPE = Object.freeze({
  maxRequests: 512,
  maxResponseBytes: MiB,
  maxTotalBytes: 32 * MiB,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 240_000,
});

/**
 * Approved split of the envelope, 2026-11-09. A larger pull request exhausts a share and ends
 * incomplete with a `budget` reason; no reader borrows from another.
 */
export const W2_ALLOCATION = Object.freeze({
  transport: Object.freeze({ maxRequests: 64, maxTotalBytes: 4 * MiB }),
  session: Object.freeze({ maxRequests: 160, maxTotalBytes: 12 * MiB }),
  registry: Object.freeze({ maxRequests: 64, maxTotalBytes: 4 * MiB }),
  upstream: Object.freeze({ maxRequests: 96, maxTotalBytes: 6 * MiB }),
  advisory: Object.freeze({ maxRequests: 64, maxTotalBytes: 4 * MiB }),
  signals: Object.freeze({ maxRequests: 64, maxTotalBytes: 2 * MiB }),
});
