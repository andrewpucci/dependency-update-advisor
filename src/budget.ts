import { limit } from './limits.js';

/** The runner's wall-clock limit for the job, mirroring the workflow's `timeout-minutes`. */
export const JOB_BUDGET_MS = limit('job.budget');
/**
 * Time the runner spends before `runStartup` takes its job start: the app-token step, action
 * download, Node load, and self-check. It is an allowance, not a measurement.
 */
export const PRE_STARTUP_ALLOWANCE_MS = limit('job.preStartupAllowance');
/**
 * The job window measured from the startup job start. The freshness reads and the analysis
 * deadline read this, never `JOB_BUDGET_MS` directly; analysis and publication reserve their own
 * time inside it.
 */
export const JOB_WINDOW_MS = limit('job.window');
/**
 * Reserved at the end of the job window for the final freshness re-verification: three sequential
 * reads (run, pull request, comparison) at the request timeout. Analysis must end before it.
 */
export const FRESHNESS_ALLOWANCE_MS = limit('job.freshnessAllowance');

/** Bounds for all pre-analysis evidence reads. Time is shared; every reader gets what remains. */
export const EVIDENCE_READ_ENVELOPE = Object.freeze({
  maxRequests: limit('evidence.envelope.maxRequests'),
  maxResponseBytes: limit('evidence.envelope.maxResponseBytes'),
  maxTotalBytes: limit('evidence.envelope.maxTotalBytes'),
  requestTimeoutMs: limit('evidence.envelope.requestTimeoutMs'),
  totalTimeoutMs: limit('evidence.envelope.totalTimeoutMs'),
});

/**
 * How the envelope is divided between readers. A larger pull request exhausts a share and ends
 * incomplete with a `budget` reason; no reader borrows from another.
 */
export const EVIDENCE_READ_ALLOCATION = Object.freeze({
  // The snapshot covers C1's 128 excerpt files with their directories; freshness reads are
  // reserved separately so a heavy snapshot can never starve the checks that keep a result valid.
  transport: Object.freeze({
    maxRequests: limit('evidence.allocation.transport.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.transport.maxTotalBytes'),
    snapshot: Object.freeze({
      maxRequests: limit('evidence.allocation.transport.snapshot.maxRequests'),
      maxTotalBytes: limit('evidence.allocation.transport.snapshot.maxTotalBytes'),
    }),
    freshness: Object.freeze({
      maxRequests: limit('evidence.allocation.transport.freshness.maxRequests'),
      maxTotalBytes: limit('evidence.allocation.transport.freshness.maxTotalBytes'),
    }),
  }),
  session: Object.freeze({
    maxRequests: limit('evidence.allocation.session.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.session.maxTotalBytes'),
  }),
  registry: Object.freeze({
    maxRequests: limit('evidence.allocation.registry.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.registry.maxTotalBytes'),
  }),
  // Research reads scale with the group: measured at about 7 upstream (5 GitHub plus 2 registry),
  // 2 advisory, and 1 each malware and publish-time request per extra npm package, so these cover
  // a group of 32 npm packages. pip and Actions malware lookups take at least 2 requests (stored-name
  // discovery, then the versioned query) and Actions reviewed lookups 3 per update, so the malware
  // share covers about 20 such packages and the advisory share about 26 Actions updates; S1's
  // Package Name Form Amendment states this limit.
  upstream: Object.freeze({
    maxRequests: limit('evidence.allocation.upstream.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.upstream.maxTotalBytes'),
  }),
  advisory: Object.freeze({
    maxRequests: limit('evidence.allocation.advisory.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.advisory.maxTotalBytes'),
  }),
  signals: Object.freeze({
    maxRequests: limit('evidence.allocation.signals.maxRequests'),
    maxTotalBytes: limit('evidence.allocation.signals.maxTotalBytes'),
    readers: Object.freeze({
      malware: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.malware.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.malware.maxTotalBytes'),
      }),
      publishTimes: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.publishTimes.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.publishTimes.maxTotalBytes'),
      }),
      registry: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.registry.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.registry.maxTotalBytes'),
      }),
      metadata: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.metadata.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.metadata.maxTotalBytes'),
      }),
      upstream: Object.freeze({
        maxRequests: limit('evidence.allocation.signals.readers.upstream.maxRequests'),
        maxTotalBytes: limit('evidence.allocation.signals.readers.upstream.maxTotalBytes'),
      }),
    }),
  }),
});

/**
 * Bounds for the run-scoped research cache. An entry is at most one response, and the cache never
 * holds more than the registry and research shares that fill it can fetch.
 */
export const RESEARCH_CACHE_LIMITS = Object.freeze({
  maxEntryBytes: limit('research.cache.maxEntryBytes'),
  maxTotalBytes: limit('research.cache.maxTotalBytes'),
});
