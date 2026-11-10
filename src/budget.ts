const MiB = 1024 * 1024;

/** Bounds for all pre-analysis evidence reads. Time is shared; every reader gets what remains. */
export const EVIDENCE_READ_ENVELOPE = Object.freeze({
  maxRequests: 944,
  maxResponseBytes: MiB,
  maxTotalBytes: 54 * MiB,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 240_000,
});

/**
 * How the envelope is divided between readers. A larger pull request exhausts a share and ends
 * incomplete with a `budget` reason; no reader borrows from another.
 */
export const EVIDENCE_READ_ALLOCATION = Object.freeze({
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
  // Research reads scale with the group: measured at about 7 upstream (5 GitHub plus 2 registry),
  // 2 advisory, and 1 each malware and publish-time request per extra package, so these cover a
  // group of 32 packages.
  upstream: Object.freeze({ maxRequests: 240, maxTotalBytes: 15 * MiB }),
  advisory: Object.freeze({ maxRequests: 80, maxTotalBytes: 5 * MiB }),
  signals: Object.freeze({
    maxRequests: 176,
    maxTotalBytes: 6 * MiB,
    readers: Object.freeze({
      malware: Object.freeze({ maxRequests: 40, maxTotalBytes: 1.5 * MiB }),
      publishTimes: Object.freeze({ maxRequests: 40, maxTotalBytes: 1.5 * MiB }),
      registry: Object.freeze({ maxRequests: 64, maxTotalBytes: 2 * MiB }),
      metadata: Object.freeze({ maxRequests: 16, maxTotalBytes: 0.5 * MiB }),
      upstream: Object.freeze({ maxRequests: 16, maxTotalBytes: 0.5 * MiB }),
    }),
  }),
});
