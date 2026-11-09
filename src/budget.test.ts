import { expect, test } from 'vite-plus/test';
import { W2_ALLOCATION, W2_ENVELOPE } from './budget.js';

test('records the approved W2 envelope', () => {
  expect(W2_ENVELOPE).toEqual({
    maxRequests: 512,
    maxResponseBytes: 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 240_000,
  });
});

test('splits the envelope as approved, with nothing unallocated or over-allocated', () => {
  const MiB = 1024 * 1024;
  expect(W2_ALLOCATION).toEqual({
    transport: { maxRequests: 64, maxTotalBytes: 4 * MiB },
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
