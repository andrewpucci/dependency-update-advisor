const MiB = 1024 * 1024;

/** The job's wall-clock limit; analysis and publication reserve their own time inside it. */
export const JOB_BUDGET_MS = 15 * 60 * 1_000;
/**
 * Time the runner spends before `runStartup` takes its job start: the app-token step, action
 * download, Node load, and self-check. It is an allowance, not a measurement.
 */
export const PRE_STARTUP_ALLOWANCE_MS = 60_000;
/**
 * The job window measured from the startup job start. Every deadline that must end inside the
 * runner's timeout reads this, never `JOB_BUDGET_MS` directly.
 */
export const JOB_WINDOW_MS = JOB_BUDGET_MS - PRE_STARTUP_ALLOWANCE_MS;
/**
 * Reserved at the end of the job window for the final freshness re-verification: three sequential
 * reads (run, pull request, comparison) at the request timeout. Analysis must end before it.
 */
export const FRESHNESS_ALLOWANCE_MS = 45_000;

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
