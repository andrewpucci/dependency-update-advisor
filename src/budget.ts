const MiB = 1024 * 1024;

/** Bounds for all pre-analysis evidence reads. Time is shared; every reader gets what remains. */
export const W2_ENVELOPE = Object.freeze({
  maxRequests: 672,
  maxResponseBytes: MiB,
  maxTotalBytes: 40 * MiB,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 240_000,
});

/**
 * How the envelope is divided between readers. A larger pull request exhausts a share and ends
 * incomplete with a `budget` reason; no reader borrows from another.
 */
export const W2_ALLOCATION = Object.freeze({
  // The snapshot covers C1's 128 excerpt files with their directories; freshness reads are
  // reserved separately so a heavy snapshot can never starve the checks that keep a result valid.
  transport: Object.freeze({
    maxRequests: 224,
    maxTotalBytes: 12 * MiB,
    snapshot: Object.freeze({ maxRequests: 200, maxTotalBytes: 9 * MiB }),
    freshness: Object.freeze({ maxRequests: 24, maxTotalBytes: 3 * MiB }),
  }),
  session: Object.freeze({ maxRequests: 160, maxTotalBytes: 12 * MiB }),
  registry: Object.freeze({ maxRequests: 64, maxTotalBytes: 4 * MiB }),
  upstream: Object.freeze({ maxRequests: 96, maxTotalBytes: 6 * MiB }),
  advisory: Object.freeze({ maxRequests: 64, maxTotalBytes: 4 * MiB }),
  signals: Object.freeze({ maxRequests: 64, maxTotalBytes: 2 * MiB }),
});
