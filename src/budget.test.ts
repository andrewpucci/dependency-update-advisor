import { expect, test } from 'vite-plus/test';
import {
  EVIDENCE_READ_ALLOCATION,
  EVIDENCE_READ_ENVELOPE,
  JOB_BUDGET_MS,
  JOB_WINDOW_MS,
  PRE_STARTUP_ALLOWANCE_MS,
  researchShareUnits,
  researchShares,
} from './budget.js';

const MiB = 1024 * 1024;

test('records the job window as the budget less the pre-startup allowance', () => {
  expect(JOB_BUDGET_MS).toBe(900_000);
  expect(PRE_STARTUP_ALLOWANCE_MS).toBe(60_000);
  expect(JOB_WINDOW_MS).toBe(840_000);
});

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

type Units = Parameters<typeof researchShares>[0];
type Parameters_ = NonNullable<Parameters<typeof researchShares>[1]>;

const NO_UNITS: Units = {
  direct: 0,
  transitive: 0,
  added: 0,
  removed: 0,
  eligible: { malware: 0, publishTimes: 0, registry: 0, metadata: 0, upstream: 0 },
};
const R1_UNITS: Units = {
  direct: 1,
  transitive: 91,
  added: 20,
  removed: 3,
  eligible: { malware: 92, publishTimes: 92, registry: 92, metadata: 0, upstream: 0 },
};

/** Test-only parameters: every share starts at `base`, with the given rates, under `ceiling`. */
function testParameters(
  base: number,
  ceiling: number,
  rates: Readonly<{ role: number; eligible: number }>,
): Parameters_ {
  const dimension = (eligible: boolean) => ({
    base,
    ceiling,
    rates: {
      direct: rates.role,
      transitive: rates.role,
      added: rates.role,
      removed: rates.role,
      ...(eligible ? { eligible: rates.eligible } : {}),
    },
  });
  const share = (eligible: boolean) => ({
    requests: dimension(eligible),
    bytes: dimension(eligible),
  });
  return {
    upstream: share(false),
    advisory: share(false),
    signals: {
      malware: share(true),
      publishTimes: share(true),
      registry: share(true),
      metadata: share(true),
      upstream: share(true),
    },
  };
}

test('starting parameters reproduce the current research shares for any change', () => {
  for (const units of [NO_UNITS, R1_UNITS]) {
    const shares = researchShares(units);
    const { upstream, advisory, signals } = EVIDENCE_READ_ALLOCATION;
    expect(shares.upstream).toEqual({
      maxRequests: upstream.maxRequests,
      maxTotalBytes: upstream.maxTotalBytes,
    });
    expect(shares.advisory).toEqual({
      maxRequests: advisory.maxRequests,
      maxTotalBytes: advisory.maxTotalBytes,
    });
    expect(shares.signals).toEqual({
      maxRequests: signals.maxRequests,
      maxTotalBytes: signals.maxTotalBytes,
      readers: signals.readers,
    });
  }
});

test('a share is its base plus each rate times its count, rounded up, under its ceiling', () => {
  const parameters = testParameters(10, 10_000, { role: 1.5, eligible: 0.25 });
  const units: Units = {
    direct: 1,
    transitive: 4,
    added: 2,
    removed: 1,
    eligible: { malware: 3, publishTimes: 0, registry: 0, metadata: 0, upstream: 0 },
  };
  const shares = researchShares(units, parameters);
  // 10 + 1.5 × (1 + 4 + 2 + 1) = 22.
  expect(shares.upstream.maxRequests).toBe(22);
  // 10 + 1.5 × 8 + 0.25 × 3 = 22.75, rounded up.
  expect(shares.signals.readers.malware.maxRequests).toBe(23);
  // A reader's eligible count is its own: publish times has none here.
  expect(shares.signals.readers.publishTimes.maxRequests).toBe(22);
});

test('a share never exceeds its ceiling', () => {
  const shares = researchShares(R1_UNITS, testParameters(10, 50, { role: 5, eligible: 5 }));
  expect(shares.upstream.maxRequests).toBe(50);
  expect(shares.signals.readers.malware.maxTotalBytes).toBe(50);
});

test('a share never decreases when any one count grows', () => {
  const parameters = testParameters(3, 100_000, { role: 0.7, eligible: 1.3 });
  const counts = ['direct', 'transitive', 'added', 'removed'] as const;
  const readers = ['malware', 'publishTimes', 'registry', 'metadata', 'upstream'] as const;
  const grown: Units[] = [
    ...counts.map((count) => ({ ...R1_UNITS, [count]: R1_UNITS[count] + 1 })),
    ...readers.map((reader) => ({
      ...R1_UNITS,
      eligible: { ...R1_UNITS.eligible, [reader]: R1_UNITS.eligible[reader] + 1 },
    })),
  ];
  const before = researchShares(R1_UNITS, parameters);
  for (const units of grown) {
    const after = researchShares(units, parameters);
    expect(after.upstream.maxRequests).toBeGreaterThanOrEqual(before.upstream.maxRequests);
    expect(after.advisory.maxTotalBytes).toBeGreaterThanOrEqual(before.advisory.maxTotalBytes);
    for (const reader of readers) {
      expect(after.signals.readers[reader].maxRequests).toBeGreaterThanOrEqual(
        before.signals.readers[reader].maxRequests,
      );
    }
  }
});

test('a one-member change gets a smaller share than the 92 members of R1', () => {
  const parameters = testParameters(4, 100_000, { role: 2, eligible: 1 });
  const one: Units = {
    ...NO_UNITS,
    direct: 1,
    eligible: { ...NO_UNITS.eligible, malware: 1 },
  };
  const small = researchShares(one, parameters);
  const large = researchShares(R1_UNITS, parameters);
  expect(small.upstream.maxRequests).toBeLessThan(large.upstream.maxRequests);
  expect(small.signals.maxRequests).toBeLessThan(large.signals.maxRequests);
});

test('a request share is at least 1 and a byte share at least one full response', () => {
  const shares = researchShares(NO_UNITS, testParameters(0, 10 * MiB, { role: 0, eligible: 0 }));
  expect(shares.upstream.maxRequests).toBe(1);
  expect(shares.upstream.maxTotalBytes).toBe(EVIDENCE_READ_ENVELOPE.maxResponseBytes);
  // A ceiling below one response caps the byte floor.
  const small = researchShares(NO_UNITS, testParameters(0, 100, { role: 0, eligible: 0 }));
  expect(small.upstream.maxTotalBytes).toBe(100);
});

test('the signals stage share is the sum of the reader shares', () => {
  const shares = researchShares(R1_UNITS, testParameters(2, 100_000, { role: 1, eligible: 3 }));
  const readers = Object.values(shares.signals.readers);
  expect(shares.signals.maxRequests).toBe(
    readers.reduce((total, reader) => total + reader.maxRequests, 0),
  );
  expect(shares.signals.maxTotalBytes).toBe(
    readers.reduce((total, reader) => total + reader.maxTotalBytes, 0),
  );
});

test('rejects a negative or non-finite rate', () => {
  expect(() => researchShares(R1_UNITS, testParameters(1, 100, { role: -1, eligible: 0 }))).toThrow(
    /share parameter/,
  );
  expect(() =>
    researchShares(R1_UNITS, testParameters(1, 100, { role: Number.NaN, eligible: 0 })),
  ).toThrow(/share parameter/);
});

test('counts members from resolved changes only, by role, kind, and ecosystem', () => {
  const change = (
    id: string,
    ecosystem: 'npm' | 'uv' | 'actions',
    role: 'direct' | 'transitive' | 'unknown',
    kind: 'update' | 'addition' | 'removal',
  ) => ({ id, ecosystem, role, kind, from: null, to: null, evidence: {} });
  const units = researchShareUnits([
    change('a', 'npm', 'direct', 'update'),
    change('b', 'npm', 'transitive', 'addition'),
    change('c', 'uv', 'unknown', 'removal'),
    change('d', 'actions', 'direct', 'addition'),
    // A declaration record is not a member.
    {
      id: 'decl',
      ecosystem: 'npm',
      basis: 'declaration',
      role: 'direct',
      kind: 'update',
      from: null,
      to: null,
      evidence: {},
    },
  ] as never);
  expect(units).toEqual({
    direct: 2,
    transitive: 2,
    added: 2,
    removed: 1,
    eligible: { malware: 4, publishTimes: 2, registry: 2, metadata: 1, upstream: 1 },
  });
});
