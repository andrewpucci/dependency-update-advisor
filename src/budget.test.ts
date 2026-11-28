import { expect, test } from 'vite-plus/test';
import {
  collectionRegistryRequests,
  COLLECTION_REGISTRY_SHARE_PARAMETERS,
  EVIDENCE_READ_ALLOCATION,
  EVIDENCE_READ_ENVELOPE,
  FRESHNESS_ALLOWANCE_MS,
  JOB_BUDGET_MS,
  JOB_WINDOW_MS,
  PRE_STARTUP_ALLOWANCE_MS,
  RESEARCH_CACHE_LIMITS,
  RESEARCH_SHARE_PARAMETERS,
  researchShareUnits,
  researchShares,
} from './budget.js';
import { REGISTER } from './limits.js';
import { leaves, registered, registerShareParameters } from '../tests/parity/shares.js';

const MiB = 1024 * 1024;

test('records the job window as the budget less the pre-startup allowance', () => {
  expect(JOB_BUDGET_MS).toBe(900_000);
  expect(PRE_STARTUP_ALLOWANCE_MS).toBe(60_000);
  expect(JOB_WINDOW_MS).toBe(840_000);
});

test('records the evidence-read envelope', () => {
  expect(EVIDENCE_READ_ENVELOPE).toEqual({
    // The advisory, upstream byte, and PyPI metadata ceilings (#467) raise the envelope sums:
    // 1,520 + (221 − 80) + (256 − 16) + (256 − 40) requests, the last the malware ceiling, and
    // 54 MiB − 15 MiB − 0.5 MiB + 76,800,000 + 9,484,288 bytes. The structural freshness share
    // (L11, #383) moves them by (17 − 24) requests and (17 − 3) MiB, and the signals upstream
    // share's floor of one response (L11, Q11(a)) by 0.5 MiB.
    maxRequests: 2110,
    maxResponseBytes: MiB,
    maxTotalBytes: 141_858_816,
    requestTimeoutMs: 11_639,
    totalTimeoutMs: 240_000,
  });
});

test('splits the envelope with nothing unallocated or over-allocated', () => {
  expect(EVIDENCE_READ_ALLOCATION).toEqual({
    transport: {
      maxRequests: 217,
      maxTotalBytes: 26 * MiB,
      snapshot: { maxRequests: 200, maxTotalBytes: 9 * MiB },
      freshness: { maxRequests: 17, maxTotalBytes: 17 * MiB },
    },
    session: { maxRequests: 160, maxTotalBytes: 12 * MiB },
    registry: { maxRequests: 640, maxTotalBytes: 4 * MiB },
    upstream: { maxRequests: 240, maxTotalBytes: 76_800_000 },
    advisory: { maxRequests: 221, maxTotalBytes: 5 * MiB },
    signals: {
      maxRequests: 632,
      maxTotalBytes: 15_775_744,
      readers: {
        malware: { maxRequests: 256, maxTotalBytes: 1.5 * MiB },
        publishTimes: { maxRequests: 40, maxTotalBytes: 1.5 * MiB },
        registry: { maxRequests: 64, maxTotalBytes: 2 * MiB },
        metadata: { maxRequests: 256, maxTotalBytes: 9_484_288 },
        upstream: { maxRequests: 16, maxTotalBytes: MiB },
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

/** R1, PR #276: 105 npm members, 2 direct and 103 transitive. */
const R276_UNITS: Units = {
  direct: 2,
  transitive: 103,
  added: 0,
  removed: 0,
  eligible: { malware: 105, publishTimes: 105, registry: 105, metadata: 0, upstream: 0 },
};
/** One direct npm member. */
const ONE_UNITS: Units = {
  ...NO_UNITS,
  direct: 1,
  eligible: { ...NO_UNITS.eligible, malware: 1, publishTimes: 1, registry: 1 },
};
const READERS = ['malware', 'publishTimes', 'registry', 'metadata', 'upstream'] as const;
/** A uv change of 30 pip members, 15 direct and 15 transitive, as on the #462 PRs. */
const UV30_UNITS: Units = {
  ...NO_UNITS,
  direct: 15,
  transitive: 15,
  eligible: { ...NO_UNITS.eligible, malware: 30, metadata: 30 },
};

test('shares the fit keeps at their ceilings stay there for any change', () => {
  for (const units of [NO_UNITS, ONE_UNITS, R1_UNITS, R276_UNITS, UV30_UNITS]) {
    const shares = researchShares(units);
    const { advisory, signals } = EVIDENCE_READ_ALLOCATION;
    // Every byte share but upstream's and the PyPI metadata reader's (#467) stays at its ceiling.
    expect(shares.advisory.maxTotalBytes).toBe(advisory.maxTotalBytes);
    for (const reader of READERS.filter((name) => name !== 'metadata'))
      expect(shares.signals.readers[reader].maxTotalBytes, reader).toBe(
        signals.readers[reader].maxTotalBytes,
      );
    // The registry and upstream signals readers keep their request ceilings too.
    for (const reader of ['registry', 'upstream'] as const)
      expect(shares.signals.readers[reader], reader).toEqual(signals.readers[reader]);
  }
});

test('the upstream byte and PyPI metadata shares grow with uv members up to their ceilings', () => {
  const { upstream, signals } = EVIDENCE_READ_ALLOCATION;
  const metadata = signals.readers.metadata;
  const upstreamRate = registered('research.share.upstream.bytes.rate.direct');
  const requestBase = registered('research.share.signals.metadata.requests.base');
  const requestRate = registered('research.share.signals.metadata.requests.rate.eligible');
  const byteBase = registered('research.share.signals.metadata.bytes.base');
  const byteRate = registered('research.share.signals.metadata.bytes.rate.eligible');
  const changes = registered('packet.changes');
  // Upstream bytes: a base of one member's whole release stage, 1 repository read plus, for each
  // of 2 candidate tags, a ref, up to the tag depth of annotated tags, contents, release, and a
  // recheck ref, each a full response; then the same rate for direct and transitive members, and
  // none for the others.
  const response = registered('evidence.envelope.maxResponseBytes');
  const upstreamBase = registered('research.share.upstream.bytes.base');
  expect(upstreamBase).toBe((1 + 2 * (registered('research.maxTagDepth') + 4)) * response);
  expect(upstreamBase).toBe(29 * response);
  expect(registered('research.share.upstream.bytes.rate.transitive')).toBe(upstreamRate);
  for (const unit of ['added', 'removed'])
    expect(registered(`research.share.upstream.bytes.rate.${unit}`), unit).toBe(0);
  // The ceilings: half the evidence window at 640,000 bytes/s for upstream, two reads per change
  // for metadata requests, and the metadata byte formula at the packet's change limit.
  expect(upstream.maxTotalBytes).toBe(
    ((registered('evidence.envelope.totalTimeoutMs') / 1000) * 640_000) / 2,
  );
  expect(upstream.maxTotalBytes).toBe(76_800_000);
  expect(metadata.maxRequests).toBe(2 * changes);
  expect(metadata.maxTotalBytes).toBe(byteBase + byteRate * changes);

  // No counted members: upstream bytes get their base; metadata bytes get the one-response floor,
  // since their base is under it; metadata requests get their base.
  const none = researchShares(NO_UNITS);
  expect(none.upstream.maxTotalBytes).toBe(upstreamBase);
  // One member gets the base and one rate.
  expect(researchShares(ONE_UNITS).upstream.maxTotalBytes).toBe(upstreamBase + upstreamRate);
  expect(byteBase).toBeLessThan(response);
  expect(none.signals.readers.metadata).toEqual({ maxRequests: 16, maxTotalBytes: response });
  // Additions and removals alone add no upstream bytes.
  expect(researchShares({ ...NO_UNITS, added: 5, removed: 5 }).upstream.maxTotalBytes).toBe(
    none.upstream.maxTotalBytes,
  );
  // 30 uv members, 15 direct and 15 transitive: the base plus 750,000 × 30 upstream bytes; metadata
  // 16 + 2.5 × 30 = 91 requests and 524,288 + 70,000 × 30 bytes.
  const uv30 = researchShares(UV30_UNITS);
  expect(uv30.upstream.maxTotalBytes).toBe(52_908_704);
  expect(uv30.upstream.maxTotalBytes).toBe(upstreamBase + upstreamRate * 30);
  expect(uv30.signals.readers.metadata).toEqual({
    maxRequests: 91,
    maxTotalBytes: 2_624_288,
  });
  expect(uv30.signals.readers.metadata.maxRequests).toBe(requestBase + requestRate * 30);
  // Metadata reads scale with uv members only: npm members leave the share at its base.
  expect(researchShares(R276_UNITS).signals.readers.metadata).toEqual(
    none.signals.readers.metadata,
  );

  const uv = (members: number): Units => ({
    ...NO_UNITS,
    direct: Math.ceil(members / 2),
    transitive: Math.floor(members / 2),
    eligible: { ...NO_UNITS.eligible, malware: members, metadata: members },
  });
  // Upstream: the base plus 750,000 × 61 is under the 76.8 MB ceiling; 62 members pass it and are
  // capped there.
  const underUpstream = Math.floor((upstream.maxTotalBytes - upstreamBase) / upstreamRate);
  expect(underUpstream).toBe(61);
  expect(researchShares(uv(underUpstream)).upstream.maxTotalBytes).toBe(
    upstreamBase + upstreamRate * underUpstream,
  );
  expect(researchShares(uv(underUpstream)).upstream.maxTotalBytes).toBeLessThan(
    upstream.maxTotalBytes,
  );
  expect(researchShares(uv(underUpstream + 1)).upstream.maxTotalBytes).toBe(upstream.maxTotalBytes);
  expect(researchShares(uv(changes)).upstream.maxTotalBytes).toBe(upstream.maxTotalBytes);
  // Metadata requests: 16 + 2.5 × 96 reaches the ceiling of 256 exactly; 95 members stay under.
  const toCeiling = (metadata.maxRequests - requestBase) / requestRate;
  expect(toCeiling).toBe(96);
  expect(researchShares(uv(toCeiling - 1)).signals.readers.metadata.maxRequests).toBe(254);
  expect(researchShares(uv(toCeiling)).signals.readers.metadata.maxRequests).toBe(256);
  expect(researchShares(uv(changes)).signals.readers.metadata.maxRequests).toBe(256);
  // Metadata bytes reach their ceiling exactly at the packet's change limit.
  expect(researchShares(uv(changes - 1)).signals.readers.metadata.maxTotalBytes).toBe(
    metadata.maxTotalBytes - byteRate,
  );
  expect(researchShares(uv(changes)).signals.readers.metadata.maxTotalBytes).toBe(
    metadata.maxTotalBytes,
  );
  expect(researchShares(uv(changes + 1)).signals.readers.metadata.maxTotalBytes).toBe(
    metadata.maxTotalBytes,
  );
});

type FittedRequests = Readonly<
  Record<'upstream' | 'advisory' | 'malware' | 'publishTimes', number>
>;
const fittedRequests = (shares: ReturnType<typeof researchShares>): FittedRequests => ({
  upstream: shares.upstream.maxRequests,
  advisory: shares.advisory.maxRequests,
  malware: shares.signals.readers.malware.maxRequests,
  publishTimes: shares.signals.readers.publishTimes.maxRequests,
});

test('the fitted values give a one-member change a smaller share than R1 #276', () => {
  const { upstream, advisory, signals } = EVIDENCE_READ_ALLOCATION;
  const small = researchShares(ONE_UNITS);
  const large = researchShares(R276_UNITS);
  // One direct member: 9 + 5.9 = 14.9, 3 + 3 = 6, 2 + 2 + 1 = 5, and 2 + 1.2 = 3.2, rounded up.
  expect(fittedRequests(small)).toEqual({ upstream: 15, advisory: 6, malware: 5, publishTimes: 4 });
  // One transitive npm member: advisory 3 + 2 = 5 and malware 2 + 1 = 3.
  const transitive = researchShares({ ...ONE_UNITS, direct: 0, transitive: 1 });
  expect(fittedRequests(transitive)).toMatchObject({ advisory: 5, malware: 3 });
  // 105 members, 2 direct: upstream and publish times pass their ceilings. Advisory is
  // 3 + 3 × 2 + 2 × 103 = 215, under its ceiling of 221, and malware 2 + 2 × 2 + 1 × 105 = 111,
  // under its ceiling of 256 (#467).
  expect(advisory.maxRequests).toBe(221);
  expect(signals.readers.malware.maxRequests).toBe(256);
  expect(fittedRequests(large)).toEqual({
    upstream: upstream.maxRequests,
    advisory: 215,
    malware: 111,
    publishTimes: signals.readers.publishTimes.maxRequests,
  });
  const largeRequests = fittedRequests(large);
  for (const [share, count] of Object.entries(fittedRequests(small)))
    expect(count, share).toBeLessThan(largeRequests[share as keyof FittedRequests]);
  expect(small.signals.maxRequests).toBeLessThan(large.signals.maxRequests);
  // The collection registry share: 5 + 2.5 = 7.5 and 5 + 2.5 × 105 = 267.5, rounded up.
  expect(collectionRegistryRequests(ONE_UNITS.eligible.registry)).toBe(8);
  expect(collectionRegistryRequests(R276_UNITS.eligible.registry)).toBe(268);
});

test('the collection registry share scales with npm members and stops at its ceiling', () => {
  const ceiling = EVIDENCE_READ_ALLOCATION.registry.maxRequests;
  expect(COLLECTION_REGISTRY_SHARE_PARAMETERS).toEqual({
    base: REGISTER.get('collection.share.registry.requests.base')?.value,
    ceiling,
    rates: { npm: REGISTER.get('collection.share.registry.requests.rate.npm')?.value },
  });
  // 5 + 2.5 × count, rounded up: no members, one, two, and R1 #276's 105.
  expect([0, 1, 2, 105].map((count) => collectionRegistryRequests(count))).toEqual([5, 8, 10, 268]);
  // 5 + 2.5 × 254 reaches the ceiling exactly; more members are capped there.
  expect(collectionRegistryRequests(253)).toBeLessThan(ceiling);
  expect(collectionRegistryRequests(254)).toBe(ceiling);
  expect(collectionRegistryRequests(255)).toBe(ceiling);
  expect(collectionRegistryRequests(100_000)).toBe(ceiling);
  for (let count = 0; count < 300; count++)
    expect(collectionRegistryRequests(count + 1)).toBeGreaterThanOrEqual(
      collectionRegistryRequests(count),
    );
  // A request share is at least 1, and a count that is not a whole number is refused.
  expect(collectionRegistryRequests(0, { base: 0, ceiling, rates: { npm: 0 } })).toBe(1);
  for (const count of [-1, 1.5, Number.NaN])
    expect(() => collectionRegistryRequests(count), String(count)).toThrow(/npm member count/);
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

/** Test-only parameters with a distinct rate per unit, so a swapped count changes the result. */
function distinctParameters(base: number): Parameters_ {
  const dimension = (eligible: boolean) => ({
    base,
    ceiling: 1_000_000,
    rates: {
      direct: 1,
      transitive: 10,
      added: 100,
      removed: 1000,
      ...(eligible ? { eligible: 10_000 } : {}),
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

test('each unit scales only its own share terms', () => {
  const units: Units = {
    direct: 1,
    transitive: 2,
    added: 3,
    removed: 4,
    eligible: { malware: 1, publishTimes: 2, registry: 3, metadata: 4, upstream: 5 },
  };
  const shares = researchShares(units, distinctParameters(7));
  // 7 + 1×1 + 10×2 + 100×3 + 1000×4 = 4328.
  expect(shares.upstream.maxRequests).toBe(4328);
  expect(shares.advisory.maxRequests).toBe(4328);
  const readers = ['malware', 'publishTimes', 'registry', 'metadata', 'upstream'] as const;
  readers.forEach((reader, index) => {
    expect(shares.signals.readers[reader].maxRequests, reader).toBe(4328 + 10_000 * (index + 1));
  });
});

test('decimal rates are computed exactly before rounding up', () => {
  const rated = (rate: number) => ({
    upstream: {
      requests: { base: 0, ceiling: 10_000, rates: { direct: rate } },
      bytes: { base: 0, ceiling: 10 * MiB, rates: {} },
    },
    advisory: testParameters(1, 10, { role: 0, eligible: 0 }).advisory,
    signals: testParameters(1, 10, { role: 0, eligible: 0 }).signals,
  });
  expect(researchShares({ ...NO_UNITS, direct: 100 }, rated(1.1)).upstream.maxRequests).toBe(110);
  expect(researchShares({ ...NO_UNITS, direct: 3 }, rated(0.1)).upstream.maxRequests).toBe(1);
  expect(researchShares({ ...NO_UNITS, direct: 7 }, rated(0.15)).upstream.maxRequests).toBe(2);
});

test('reads every scaled-share base and rate from its own register entry', () => {
  const shares = [
    ['upstream', RESEARCH_SHARE_PARAMETERS.upstream],
    ['advisory', RESEARCH_SHARE_PARAMETERS.advisory],
    ...(['malware', 'publishTimes', 'registry', 'metadata', 'upstream'] as const).map(
      (reader) => [`signals.${reader}`, RESEARCH_SHARE_PARAMETERS.signals[reader]] as const,
    ),
  ] as const;
  for (const [share, parameters] of shares)
    for (const dimension of ['requests', 'bytes'] as const) {
      const entry = (name: string) => REGISTER.get(`research.share.${share}.${dimension}.${name}`);
      const dim = parameters[dimension];
      expect(dim.base, `${share} ${dimension} base`).toBe(entry('base')?.value);
      for (const [unit, rate] of Object.entries(dim.rates))
        expect(rate, `${share} ${dimension} ${unit}`).toBe(entry(`rate.${unit}`)?.value);
      // A dimension kept at its ceiling has no rate entries (L11, #383); any other has all of them.
      const units = share.startsWith('signals.')
        ? ['added', 'direct', 'eligible', 'removed', 'transitive']
        : ['added', 'direct', 'removed', 'transitive'];
      const kept = entry('rate.direct') === undefined;
      expect(Object.keys(dim.rates).sort(), `${share} ${dimension}`).toEqual(kept ? [] : units);
      if (kept) expect(dim.base, `${share} ${dimension}`).toBe(dim.ceiling);
    }
});

test('a share dimension kept at its ceiling has no rate entries', () => {
  // The B12 fit keeps these dimensions at their ceilings; their 34 zero rates were deleted (L11).
  const kept = [...REGISTER.keys()].filter(
    (id) => id.startsWith('research.share.') && id.endsWith('.base'),
  );
  const withoutRates = kept.filter(
    (id) => ![...REGISTER.keys()].some((other) => other.startsWith(id.replace(/base$/u, 'rate.'))),
  );
  expect(withoutRates.sort()).toEqual(
    [
      'advisory.bytes',
      'signals.malware.bytes',
      'signals.publishTimes.bytes',
      'signals.registry.requests',
      'signals.registry.bytes',
      'signals.upstream.requests',
      'signals.upstream.bytes',
    ]
      .map((dimension) => `research.share.${dimension}.base`)
      .sort(),
  );
  for (const id of withoutRates) expect(REGISTER.get(id)?.basis.kind, id).toBe('derived');
});

test('wires every budget constant, share ceiling, and computed share to its register entry', () => {
  // Each value's path names its register id, and every register id under these prefixes is wired.
  const wired = [
    ...leaves(EVIDENCE_READ_ENVELOPE, 'evidence.envelope'),
    ...leaves(EVIDENCE_READ_ALLOCATION, 'evidence.allocation'),
    ...leaves(RESEARCH_CACHE_LIMITS, 'research.cache'),
  ];
  for (const [id, value] of wired) expect(value, id).toBe(registered(id));
  const prefixes = ['evidence.envelope.', 'evidence.allocation.', 'research.cache.'];
  expect(wired.map(([id]) => id).sort()).toEqual(
    [...REGISTER.keys()].filter((id) => prefixes.some((prefix) => id.startsWith(prefix))).sort(),
  );
  expect([JOB_BUDGET_MS, PRE_STARTUP_ALLOWANCE_MS, JOB_WINDOW_MS, FRESHNESS_ALLOWANCE_MS]).toEqual(
    ['job.budget', 'job.preStartupAllowance', 'job.window', 'job.freshnessAllowance'].map(
      registered,
    ),
  );

  // The scaled shares: their ceilings are the allocation entries, and what the share function
  // computes from the production parameters is what it computes from the register's.
  const fromRegister = registerShareParameters();
  expect(RESEARCH_SHARE_PARAMETERS).toEqual(fromRegister);
  for (const units of [NO_UNITS, ONE_UNITS, R1_UNITS, R276_UNITS])
    expect(researchShares(units)).toEqual(researchShares(units, fromRegister));
  // The byte floor is one full response at the register's envelope response cap.
  const floor = researchShares(NO_UNITS, testParameters(0, 100 * MiB, { role: 0, eligible: 0 }));
  expect(floor.upstream.maxTotalBytes).toBe(registered('evidence.envelope.maxResponseBytes'));

  const registryShare = {
    base: registered('collection.share.registry.requests.base'),
    ceiling: registered('evidence.allocation.registry.maxRequests'),
    rates: { npm: registered('collection.share.registry.requests.rate.npm') },
  };
  expect(COLLECTION_REGISTRY_SHARE_PARAMETERS).toEqual(registryShare);
  for (const count of [0, 1, 105, 100_000])
    expect(collectionRegistryRequests(count), String(count)).toBe(
      collectionRegistryRequests(count, registryShare),
    );
});
