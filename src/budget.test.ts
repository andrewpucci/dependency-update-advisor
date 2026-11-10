import { expect, test } from 'vite-plus/test';
import { W2_ALLOCATION, W2_ENVELOPE } from './budget.js';

const MiB = 1024 * 1024;

test('records the W2 evidence envelope', () => {
  expect(W2_ENVELOPE).toEqual({
    maxRequests: 672,
    maxResponseBytes: MiB,
    maxTotalBytes: 40 * MiB,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 240_000,
  });
});

test('splits the envelope with nothing unallocated or over-allocated', () => {
  expect(W2_ALLOCATION).toEqual({
    transport: {
      maxRequests: 224,
      maxTotalBytes: 12 * MiB,
      snapshot: { maxRequests: 200, maxTotalBytes: 9 * MiB },
      freshness: { maxRequests: 24, maxTotalBytes: 3 * MiB },
    },
    session: { maxRequests: 160, maxTotalBytes: 12 * MiB },
    registry: { maxRequests: 64, maxTotalBytes: 4 * MiB },
    upstream: { maxRequests: 96, maxTotalBytes: 6 * MiB },
    advisory: { maxRequests: 64, maxTotalBytes: 4 * MiB },
    signals: { maxRequests: 64, maxTotalBytes: 2 * MiB },
  });
  const shares = Object.values(W2_ALLOCATION);
  expect(shares.reduce((sum, share) => sum + share.maxRequests, 0)).toBe(W2_ENVELOPE.maxRequests);
  expect(shares.reduce((sum, share) => sum + share.maxTotalBytes, 0)).toBe(
    W2_ENVELOPE.maxTotalBytes,
  );
});

test('divides the transport share exactly between snapshot reads and freshness reads', () => {
  const { transport } = W2_ALLOCATION;
  expect(transport.snapshot.maxRequests + transport.freshness.maxRequests).toBe(
    transport.maxRequests,
  );
  expect(transport.snapshot.maxTotalBytes + transport.freshness.maxTotalBytes).toBe(
    transport.maxTotalBytes,
  );
});
