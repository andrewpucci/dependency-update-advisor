import { expect, test } from 'vite-plus/test';
import { EVIDENCE_READ_ALLOCATION, EVIDENCE_READ_ENVELOPE } from './budget.js';

const MiB = 1024 * 1024;

test('records the evidence-read envelope', () => {
  expect(EVIDENCE_READ_ENVELOPE).toEqual({
    maxRequests: 944,
    maxResponseBytes: MiB,
    maxTotalBytes: 54 * MiB,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 240_000,
  });
});

test('splits the envelope with nothing unallocated or over-allocated', () => {
  expect(EVIDENCE_READ_ALLOCATION).toEqual({
    transport: {
      maxRequests: 224,
      maxTotalBytes: 12 * MiB,
      snapshot: { maxRequests: 200, maxTotalBytes: 9 * MiB },
      freshness: { maxRequests: 24, maxTotalBytes: 3 * MiB },
    },
    session: { maxRequests: 160, maxTotalBytes: 12 * MiB },
    registry: { maxRequests: 64, maxTotalBytes: 4 * MiB },
    upstream: { maxRequests: 240, maxTotalBytes: 15 * MiB },
    advisory: { maxRequests: 80, maxTotalBytes: 5 * MiB },
    signals: {
      maxRequests: 176,
      maxTotalBytes: 6 * MiB,
      readers: {
        malware: { maxRequests: 40, maxTotalBytes: 1.5 * MiB },
        publishTimes: { maxRequests: 40, maxTotalBytes: 1.5 * MiB },
        registry: { maxRequests: 64, maxTotalBytes: 2 * MiB },
        metadata: { maxRequests: 16, maxTotalBytes: 0.5 * MiB },
        upstream: { maxRequests: 16, maxTotalBytes: 0.5 * MiB },
      },
    },
  });
  const shares = Object.values(EVIDENCE_READ_ALLOCATION);
  expect(shares.reduce((sum, share) => sum + share.maxRequests, 0)).toBe(
    EVIDENCE_READ_ENVELOPE.maxRequests,
  );
  expect(shares.reduce((sum, share) => sum + share.maxTotalBytes, 0)).toBe(
    EVIDENCE_READ_ENVELOPE.maxTotalBytes,
  );
});

test('divides the transport share exactly between snapshot reads and freshness reads', () => {
  const { transport } = EVIDENCE_READ_ALLOCATION;
  expect(transport.snapshot.maxRequests + transport.freshness.maxRequests).toBe(
    transport.maxRequests,
  );
  expect(transport.snapshot.maxTotalBytes + transport.freshness.maxTotalBytes).toBe(
    transport.maxTotalBytes,
  );
});

test('divides the signals share exactly between its five readers', () => {
  const { signals } = EVIDENCE_READ_ALLOCATION;
  const readers = Object.values(signals.readers);
  expect(readers).toHaveLength(5);
  expect(readers.reduce((sum, reader) => sum + reader.maxRequests, 0)).toBe(signals.maxRequests);
  expect(readers.reduce((sum, reader) => sum + reader.maxTotalBytes, 0)).toBe(
    signals.maxTotalBytes,
  );
});
