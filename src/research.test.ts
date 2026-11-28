import { afterEach, expect, test, vi } from 'vite-plus/test';
import { upstreamScenario } from '../tests/parity/upstream.js';
import * as advisoryModule from './evidence/advisories.js';
import * as npmRegistryModule from './evidence/npm-registry.js';
import * as publishTimesModule from './evidence/npm-publish-times.js';
import * as signalReadModule from './evidence/policy-signals-read.js';
import * as advisoryReadModule from './evidence/advisory-read.js';
import * as upstreamModule from './evidence/upstream.js';
import * as upstreamReadModule from './evidence/upstream-read.js';
import * as policySignalsModule from './evidence/policy-signals.js';
import {
  EVIDENCE_READ_ALLOCATION,
  EVIDENCE_READ_ENVELOPE,
  RESEARCH_SHARE_PARAMETERS,
  researchShareUnits,
  researchShares,
} from './budget.js';
import { registered, registerShareParameters } from '../tests/parity/shares.js';
import { researchOrder, runResearch, type ResearchObservation } from './research.js';
import { limit } from './limits.js';
import type { PacketChange } from './schema.js';
import * as schemaModule from './schema.js';
import { validateReviewPacket } from './schema.js';

vi.mock('./evidence/advisories.js', async (original) => {
  const actual = await original<typeof import('./evidence/advisories.js')>();
  return { ...actual, enrichAdvisories: vi.fn(actual.enrichAdvisories) };
});
vi.mock('./evidence/upstream.js', async (original) => {
  const actual = await original<typeof import('./evidence/upstream.js')>();
  return { ...actual, enrichUpstream: vi.fn(actual.enrichUpstream) };
});
vi.mock('./evidence/policy-signals.js', async (original) => {
  const actual = await original<typeof import('./evidence/policy-signals.js')>();
  return { ...actual, enrichPolicySignals: vi.fn(actual.enrichPolicySignals) };
});
vi.mock('./evidence/npm-registry.js', async (original) => {
  const actual = await original<typeof import('./evidence/npm-registry.js')>();
  return { ...actual, createNpmRegistryReader: vi.fn(actual.createNpmRegistryReader) };
});
vi.mock('./evidence/npm-publish-times.js', async (original) => {
  const actual = await original<typeof import('./evidence/npm-publish-times.js')>();
  return { ...actual, createNpmPublishTimeReader: vi.fn(actual.createNpmPublishTimeReader) };
});
vi.mock('./evidence/policy-signals-read.js', async (original) => {
  const actual = await original<typeof import('./evidence/policy-signals-read.js')>();
  return { ...actual, createPolicySignalReader: vi.fn(actual.createPolicySignalReader) };
});
const closed: string[] = [];
const actualSchema = await vi.importActual<typeof import('./schema.js')>('./schema.js');
vi.mock('./evidence/advisory-read.js', async (original) => {
  const actual = await original<typeof import('./evidence/advisory-read.js')>();
  const track = (name: string, create: typeof actual.createAdvisoryReader) =>
    vi.fn((...args: Parameters<typeof actual.createAdvisoryReader>) => {
      const reader = create(...args);
      if (reader.kind !== 'ready') return reader;
      return { ...reader, close: () => (reader.close(), closed.push(name)) };
    });
  return {
    ...actual,
    createAdvisoryReader: track('advisory', actual.createAdvisoryReader),
    createMalwareReader: track('malware', actual.createMalwareReader),
  };
});
vi.mock('./evidence/upstream-read.js', async (original) => {
  const actual = await original<typeof import('./evidence/upstream-read.js')>();
  return {
    ...actual,
    createUpstreamReader: vi.fn((...args: Parameters<typeof actual.createUpstreamReader>) => {
      const opened = actual.createUpstreamReader(...args);
      if (opened.kind !== 'ready') return opened;
      return {
        ...opened,
        reader: {
          ...opened.reader,
          close: () => (opened.reader.close(), closed.push('upstream')),
        },
      };
    }),
  };
});
vi.mock('./schema.js', async (original) => {
  const actual = await original<typeof import('./schema.js')>();
  return { ...actual, validateReviewPacket: vi.fn(actual.validateReviewPacket) };
});

const evaluationTime = Date.parse('2026-11-07T00:00:00Z');
type Packet = Awaited<ReturnType<typeof scenario>>['packet'];
const RESEARCH_CATEGORIES = ['upstream', 'installScript', 'vulnerability', 'malware'] as const;
const MALFORMED = { status: 'unavailable', reasons: ['malformed'], sourceIds: [] };

/**
 * Counts members that carry enrichment: a non-basis change that differs from its collected version and
 * has a research category beyond unavailable. Reverted members are unavailable, so they do not count.
 */
function enrichedMembers(candidate: unknown, collected: Packet): number {
  const { changes } = candidate as {
    changes: { id: string; basis?: unknown; evidence: Record<string, { status: string }> }[];
  };
  const before = new Map(collected.changes.map((change) => [change.id, change]));
  // A member is enriched when research gave one of its categories evidence it did not have.
  return changes.filter((change) => {
    const collectedEvidence = before.get(change.id)?.evidence as
      | Record<string, unknown>
      | undefined;
    return (
      !('basis' in change) &&
      RESEARCH_CATEGORIES.some(
        (key) =>
          ['available', 'partial'].includes(change.evidence[key]?.status ?? '') &&
          JSON.stringify(change.evidence[key]) !== JSON.stringify(collectedEvidence?.[key]),
      )
    );
  }).length;
}

afterEach(() => {
  vi.mocked(schemaModule.validateReviewPacket).mockImplementation(
    actualSchema.validateReviewPacket,
  );
});

async function scenario(options: Parameters<typeof upstreamScenario>[0] = {}) {
  const fixture = await upstreamScenario(options);
  const candidate = {
    version: 1,
    ...fixture.expected,
    changes: fixture.input.changes,
    sources: fixture.input.sources,
    findings: fixture.input.findings,
    coverage: fixture.coverage,
    relationships: fixture.relationships,
    reachability: [],
    retryAfter: null,
  };
  const validated = validateReviewPacket(candidate, fixture.expected);
  if (!validated.ok) throw new Error(`fixture packet: ${JSON.stringify(validated)}`);
  return { fixture, packet: validated.packet };
}

function base(
  fixture: Awaited<ReturnType<typeof upstreamScenario>>,
  packet: Awaited<ReturnType<typeof scenario>>['packet'],
) {
  return {
    packet,
    trusted: fixture.expected,
    npmInventory: fixture.npm,
    comparison: null,
    fetch: fixture.fetch as (url: string, init: RequestInit) => Promise<Response>,
    now: () => 0,
    deadline: 240_000,
    evaluationTime,
  };
}

test('feeds upstream proofs to advisory lookup and signals, and returns a revalidated packet', async () => {
  const { fixture, packet } = await scenario({ vulnerableNpm: true });
  const result = await runResearch(base(fixture, packet));
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.unavailable).toEqual([]);
  const reviewed = fixture.requests
    .filter((url) => url.includes('/advisories') && url.includes('type=reviewed'))
    .map((url) => decodeURIComponent(new URL(url).search));
  // The npm target needs a public-identity proof and the Actions target an Actions mapping.
  expect(reviewed.some((query) => query.includes('ecosystem=npm&affects=orbit@2.0.0'))).toBe(true);
  expect(
    reviewed.some((query) => query.includes('ecosystem=actions&affects=fixture/action@2.0.0')),
  ).toBe(true);
  const malware = fixture.requests
    .filter((url) => url.includes('/advisories') && url.includes('type=malware'))
    .map((url) => decodeURIComponent(new URL(url).search));
  expect(malware.some((query) => query.includes('ecosystem=npm&affects=orbit@2.0.0'))).toBe(true);
  expect(result.packet.findings.some((finding) => finding.kind === 'vulnerability')).toBe(true);
  const kinds = new Set(result.packet.sources.map((source) => source.kind));
  for (const kind of ['release', 'advisory', 'malware', 'publishTime'])
    expect(kinds.has(kind as never)).toBe(true);
  expect(result.upstreamAttempts.length).toBeGreaterThan(0);
  expect(result.signalAttempts.length).toBeGreaterThan(0);
});

test('shares exact PyPI release reads between upstream evidence and policy signals', async () => {
  const { fixture, packet } = await scenario();
  const result = await runResearch(base(fixture, packet));
  expect(result.kind).toBe('ready');
  const releases = fixture.requests.filter((url) => {
    const target = new URL(url);
    return (
      target.origin === 'https://pypi.org' && /^\/pypi\/[^/]+\/[^/]+\/json$/u.test(target.pathname)
    );
  });
  expect(releases.length).toBeGreaterThan(0);
  for (const url of new Set(releases))
    expect(releases.filter((value) => value === url)).toHaveLength(1);
});

test('closes every reader it opened', async () => {
  const { fixture, packet } = await scenario();
  closed.length = 0;
  await runResearch(base(fixture, packet));
  expect(closed.sort()).toEqual(['advisory', 'malware', 'upstream', 'upstream']);
});

test('never reports research evidence as available when every public source fails', async () => {
  const { fixture, packet } = await scenario();
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async () => new Response(null, { status: 500 }),
  });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.packet.coverage).toEqual(packet.coverage);
  expect(result.packet.findings).toEqual(packet.findings);
  expect(JSON.stringify(result.packet.changes)).not.toContain(
    '"vulnerability":{"status":"available"',
  );
});

test('records an unavailable stage with its reason and continues with the evidence it has', async () => {
  const { fixture, packet } = await scenario();
  vi.mocked(advisoryModule.enrichAdvisories).mockResolvedValueOnce({
    kind: 'unavailable',
    reason: 'budget',
  });
  const result = await runResearch(base(fixture, packet));
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.unavailable).toEqual([{ stage: 'advisories', reason: 'budget' }]);
  expect(result.upstreamAttempts.length).toBeGreaterThan(0);
});

test('records a stage whose reader stopped early as unavailable with the stop reason', async () => {
  const { fixture, packet } = await scenario();
  const actualUpstream = await vi.importActual<typeof import('./evidence/upstream-read.js')>(
    './evidence/upstream-read.js',
  );
  vi.mocked(upstreamReadModule.createUpstreamReader).mockImplementationOnce((...args) => {
    const opened = actualUpstream.createUpstreamReader(...args);
    if (opened.kind !== 'ready') return opened;
    return { ...opened, reader: { ...opened.reader, stopped: () => 'timeout' as const } };
  });
  const actualAdvisories = await vi.importActual<typeof import('./evidence/advisories.js')>(
    './evidence/advisories.js',
  );
  vi.mocked(advisoryModule.enrichAdvisories).mockImplementationOnce(async (...args) => {
    const result = await actualAdvisories.enrichAdvisories(...args);
    return result.kind === 'enriched' ? { ...result, stopped: 'rate_limit' } : result;
  });
  const result = await runResearch(base(fixture, packet));
  if (result.kind !== 'ready') throw new Error('research');
  expect(result.unavailable).toEqual([
    { stage: 'upstream', reason: 'timeout' },
    { stage: 'advisories', reason: 'rate_limit' },
  ]);
});

test('names the reader limit that stopped a stage to the observer', async () => {
  const { fixture, packet } = await scenario();
  const actualUpstream = await vi.importActual<typeof import('./evidence/upstream-read.js')>(
    './evidence/upstream-read.js',
  );
  vi.mocked(upstreamReadModule.createUpstreamReader).mockImplementationOnce((...args) => {
    const opened = actualUpstream.createUpstreamReader(...args);
    if (opened.kind !== 'ready') return opened;
    const reader = {
      ...opened.reader,
      stopped: () => 'budget' as const,
      stopLimit: () => 'maxRetainedBytes',
    };
    return { ...opened, reader };
  });
  const events: ResearchObservation[] = [];
  await runResearch({ ...base(fixture, packet), observe: (o) => events.push(o) });
  expect(events).toContainEqual({
    kind: 'stage-end',
    stage: 'upstream',
    outcome: 'unavailable',
    reason: 'budget',
    limit: 'maxRetainedBytes',
  });
});

test('reports each stage start and end to an observer, with the stop reason', async () => {
  const { fixture, packet } = await scenario();
  vi.mocked(advisoryModule.enrichAdvisories).mockResolvedValueOnce({
    kind: 'unavailable',
    reason: 'budget',
  });
  const events: ResearchObservation[] = [];
  await runResearch({
    ...base(fixture, packet),
    observe: (observation) => events.push(observation),
  });
  expect(events).toEqual([
    { kind: 'stage-start', stage: 'upstream' },
    { kind: 'stage-end', stage: 'upstream', outcome: 'enriched', reason: null },
    { kind: 'stage-start', stage: 'advisories' },
    { kind: 'stage-end', stage: 'advisories', outcome: 'unavailable', reason: 'budget' },
    { kind: 'stage-start', stage: 'signals' },
    { kind: 'stage-end', stage: 'signals', outcome: 'enriched', reason: null },
    { kind: 'stage-start', stage: 'revalidation' },
    { kind: 'stage-end', stage: 'revalidation', outcome: 'enriched', reason: null },
  ]);
});

test('ignores observer errors', async () => {
  const { fixture, packet } = await scenario();
  const result = await runResearch({
    ...base(fixture, packet),
    observe: () => {
      throw new Error('observer');
    },
  });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.unavailable).toEqual([]);
});

/** Makes candidates that carry enrichment for two or more members fail validation, as an unattributable failure would. */
function failWhenTwoMembersEnriched(collected: Packet) {
  vi.mocked(schemaModule.validateReviewPacket).mockImplementation((candidate, trusted) =>
    enrichedMembers(candidate, collected) >= 2
      ? { ok: false, error: { category: 'reference', field: 'sources' } }
      : actualSchema.validateReviewPacket(candidate, trusted),
  );
}

/** Asserts the collected packet is the fallback: every non-basis change marked malformed. */
function expectMalformedFallback(packet: Packet, changes: Packet['changes']) {
  for (const change of changes) {
    if ('basis' in change) continue;
    const before = packet.changes.find((item) => item.id === change.id);
    for (const category of RESEARCH_CATEGORIES.filter((key) => key in change.evidence)) {
      const collected = before?.evidence[category];
      // Collected facts survive the fallback; only research placeholders become malformed.
      const placeholder =
        JSON.stringify(collected) ===
        JSON.stringify({ status: 'unavailable', reasons: ['missing'], sourceIds: [] });
      expect(change.evidence[category], `${change.id} ${category}`).toEqual(
        placeholder ? MALFORMED : collected,
      );
    }
  }
  expect(changes.map((change) => change.id)).toEqual(packet.changes.map((change) => change.id));
}

test('reports a failed revalidation to the observer', async () => {
  const { fixture, packet } = await scenario();
  failWhenTwoMembersEnriched(packet);
  const events: ResearchObservation[] = [];
  const result = await runResearch({
    ...base(fixture, packet),
    observe: (observation) => events.push(observation),
  });
  expect(events.at(-1)).toEqual({
    kind: 'stage-end',
    stage: 'revalidation',
    outcome: 'unavailable',
    reason: 'malformed',
  });
  if (result.kind !== 'ready') throw new Error('research');
  expectMalformedFallback(packet, result.packet.changes);
});

test('falls back to the collected packet when the enriched one fails validation', async () => {
  const { fixture, packet } = await scenario();
  failWhenTwoMembersEnriched(packet);
  const result = await runResearch(base(fixture, packet));
  if (result.kind !== 'ready') throw new Error('research');
  expect(result).toMatchObject({
    kind: 'ready',
    unavailable: expect.arrayContaining([{ stage: 'revalidation', reason: 'malformed' }]),
    upstreamAttempts: [],
    signalAttempts: [],
  });
  expect(result.packet.coverage).toEqual(packet.coverage);
  expect(result.packet.findings).toEqual(packet.findings);
  expect(result.packet.sources).toEqual(packet.sources);
  expectMalformedFallback(packet, result.packet.changes);
});

test('sends no credentials to any public source', async () => {
  const { fixture, packet } = await scenario();
  const headers: Record<string, string>[] = [];
  await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => {
      headers.push(Object.fromEntries(new Headers(init.headers)));
      return fixture.fetch(url, init);
    },
  });
  expect(headers.length).toBeGreaterThan(0);
  for (const sent of headers) expect(sent).not.toHaveProperty('authorization');
});

test('caps every reader at its share, so the readers together stay inside the envelope', async () => {
  const { fixture, packet } = await scenario();
  for (const mock of [
    upstreamReadModule.createUpstreamReader,
    advisoryReadModule.createAdvisoryReader,
    advisoryReadModule.createMalwareReader,
    npmRegistryModule.createNpmRegistryReader,
    publishTimesModule.createNpmPublishTimeReader,
    signalReadModule.createPolicySignalReader,
  ])
    vi.mocked(mock).mockClear();
  await runResearch(base(fixture, packet));
  const MiB = 1024 * 1024;
  type Limits = { maxRequests: number; maxTotalBytes: number; maxResponseBytes: number };
  const calls = (mock: unknown) =>
    vi.mocked(mock as (value: unknown) => unknown).mock.calls.map(([value]) => value as Limits);
  const upstream = calls(upstreamReadModule.createUpstreamReader);
  const advisory = calls(advisoryReadModule.createAdvisoryReader);
  // Each S2 reader builds an inner registry reader through its own bounded fetch, so the registry
  // calls are [S2 inner, S3 registry, S3 upstream inner]; only the middle one is ours.
  const registry = calls(npmRegistryModule.createNpmRegistryReader);
  expect(upstream).toHaveLength(2);
  expect(advisory).toHaveLength(1);
  const { readers } = EVIDENCE_READ_ALLOCATION.signals;
  // Each reader opens with the register's share for this packet, under its allocation ceiling.
  const shares = researchShares(researchShareUnits(packet.changes));
  const computed = shares.signals.readers;
  const expected = [
    ['S2 upstream', upstream[0], shares.upstream, EVIDENCE_READ_ALLOCATION.upstream],
    ['advisory', advisory[0], shares.advisory, EVIDENCE_READ_ALLOCATION.advisory],
    [
      'malware',
      calls(advisoryReadModule.createMalwareReader)[0],
      computed.malware,
      readers.malware,
    ],
    ['npm registry', registry[1], computed.registry, readers.registry],
    [
      'publish times',
      calls(publishTimesModule.createNpmPublishTimeReader)[0],
      computed.publishTimes,
      readers.publishTimes,
    ],
    [
      'metadata',
      calls(signalReadModule.createPolicySignalReader)[0],
      computed.metadata,
      readers.metadata,
    ],
    ['S3 upstream', upstream[1], computed.upstream, readers.upstream],
  ] as const;
  for (const [name, actual, share, ceiling] of expected) {
    expect(actual, name).toMatchObject({
      maxRequests: share.maxRequests,
      maxTotalBytes: share.maxTotalBytes,
      maxResponseBytes: Math.min(MiB, share.maxTotalBytes),
    });
    expect(share.maxRequests, name).toBeLessThanOrEqual(ceiling.maxRequests);
    expect(share.maxTotalBytes, name).toBeLessThanOrEqual(ceiling.maxTotalBytes);
  }
  // The upstream byte share and the PyPI metadata share scale with members (#467): upstream
  // bytes are the 29-response base plus 750,000 × 4 members, and the metadata share for its one uv member is 2 + 2.5
  // requests, rounded up, and 2 × 1 MiB + 70,000 bytes: its base is that member's two PyPI reads
  // (L11, #383). Every other byte share stays at its ceiling.
  expect(shares.upstream.maxTotalBytes).toBe(33_408_704);
  expect(computed.metadata).toEqual({ maxRequests: 5, maxTotalBytes: 2 * MiB + 70_000 });
  for (const [name, , share, ceiling] of expected)
    if (!['S2 upstream', 'metadata'].includes(name))
      expect(share.maxTotalBytes, name).toBe(ceiling.maxTotalBytes);
  // Three direct members (npm, Action, uv) and one transitive npm member: upstream
  // 9 + 5.9 × 4 = 32.6, advisory 3 + 3 × 3 + 2 = 14, malware 2 + 2 × 3 + 1 × 4 = 12, and
  // publish times 2 + 1.2 × 2 = 4.4, each rounded up and under its ceiling.
  expect(researchShareUnits(packet.changes)).toMatchObject({ direct: 3, transitive: 1 });
  expect([
    shares.upstream.maxRequests,
    shares.advisory.maxRequests,
    computed.malware.maxRequests,
    computed.publishTimes.maxRequests,
  ]).toEqual([33, 14, 12, 5]);
  expect(shares.upstream.maxRequests).toBeLessThan(EVIDENCE_READ_ALLOCATION.upstream.maxRequests);
  const used = expected.reduce((sum, [, actual]) => sum + actual.maxRequests, 0);
  const ceilings = expected.reduce((sum, [, , , ceiling]) => sum + ceiling.maxRequests, 0);
  const bytes = expected.reduce((sum, [, actual]) => sum + actual.maxTotalBytes, 0);
  // The transport, evidence session, and registry shares hold the rest of the envelope.
  const others = [
    EVIDENCE_READ_ALLOCATION.transport,
    EVIDENCE_READ_ALLOCATION.session,
    EVIDENCE_READ_ALLOCATION.registry,
  ];
  const otherRequests = others.reduce((sum, share) => sum + share.maxRequests, 0);
  expect(ceilings + otherRequests).toBe(EVIDENCE_READ_ENVELOPE.maxRequests);
  expect(used + otherRequests).toBeLessThan(EVIDENCE_READ_ENVELOPE.maxRequests);
  const ceilingBytes = expected.reduce((sum, [, , , ceiling]) => sum + ceiling.maxTotalBytes, 0);
  const otherBytes = others.reduce((sum, share) => sum + share.maxTotalBytes, 0);
  expect(ceilingBytes + otherBytes).toBe(EVIDENCE_READ_ENVELOPE.maxTotalBytes);
  expect(bytes + otherBytes).toBeLessThan(EVIDENCE_READ_ENVELOPE.maxTotalBytes);
});

test('opens each reader with the share scaled from the packet members', async () => {
  const { fixture, packet } = await scenario();
  for (const mock of [
    upstreamReadModule.createUpstreamReader,
    advisoryReadModule.createAdvisoryReader,
    advisoryReadModule.createMalwareReader,
    publishTimesModule.createNpmPublishTimeReader,
    signalReadModule.createPolicySignalReader,
    npmRegistryModule.createNpmRegistryReader,
    policySignalsModule.enrichPolicySignals,
  ])
    vi.mocked(mock).mockClear();
  // Distinct bases and a direct-member rate, so each reader's share differs from its ceiling.
  const dimension = (base: number, ceiling: number) => ({
    base,
    ceiling,
    rates: { direct: 3, transitive: 0, added: 0, removed: 0, eligible: 1 },
  });
  const shareFor = (base: number) => ({
    requests: dimension(base, 1_000),
    bytes: dimension(base * 1024 * 1024, 64 * 1024 * 1024),
  });
  const shareParameters = {
    upstream: shareFor(11),
    advisory: shareFor(12),
    signals: {
      malware: shareFor(13),
      publishTimes: shareFor(14),
      registry: shareFor(15),
      metadata: shareFor(16),
      upstream: shareFor(17),
    },
  };
  await runResearch({ ...base(fixture, packet), shareParameters });
  const expected = researchShares(researchShareUnits(packet.changes), shareParameters);
  expect(expected.upstream.maxRequests).not.toBe(EVIDENCE_READ_ALLOCATION.upstream.maxRequests);
  type Limits = { maxRequests: number; maxTotalBytes: number };
  const first = (mock: unknown, index = 0) =>
    vi.mocked(mock as (value: unknown) => unknown).mock.calls[index]?.[0] as Limits;
  const pick = ({ maxRequests, maxTotalBytes }: Limits) => ({ maxRequests, maxTotalBytes });
  expect(pick(first(upstreamReadModule.createUpstreamReader))).toEqual(expected.upstream);
  expect(pick(first(advisoryReadModule.createAdvisoryReader))).toEqual(expected.advisory);
  expect(pick(first(advisoryReadModule.createMalwareReader))).toEqual(
    expected.signals.readers.malware,
  );
  expect(pick(first(publishTimesModule.createNpmPublishTimeReader))).toEqual(
    expected.signals.readers.publishTimes,
  );
  expect(pick(first(signalReadModule.createPolicySignalReader))).toEqual(
    expected.signals.readers.metadata,
  );
  expect(pick(first(upstreamReadModule.createUpstreamReader, 1))).toEqual(
    expected.signals.readers.upstream,
  );
  // Registry calls are [S2 inner, S3 registry, S3 upstream inner]; only the middle one is research's.
  expect(pick(first(npmRegistryModule.createNpmRegistryReader, 1))).toEqual(
    expected.signals.readers.registry,
  );
  // The signals stage limit is the sum of its readers' scaled shares.
  const stage = vi.mocked(policySignalsModule.enrichPolicySignals).mock.calls[0]?.[0] as {
    limits: Limits;
  };
  expect(pick(stage.limits)).toEqual({
    maxRequests: expected.signals.maxRequests,
    maxTotalBytes: expected.signals.maxTotalBytes,
  });
});

test('opens every research reader with its register limits and the share the register computes', async () => {
  const { fixture, packet } = await scenario();
  const readerMocks = [
    upstreamReadModule.createUpstreamReader,
    advisoryReadModule.createAdvisoryReader,
    advisoryReadModule.createMalwareReader,
    npmRegistryModule.createNpmRegistryReader,
    publishTimesModule.createNpmPublishTimeReader,
    signalReadModule.createPolicySignalReader,
    policySignalsModule.enrichPolicySignals,
  ];
  for (const mock of readerMocks) vi.mocked(mock).mockClear();
  // A deadline past the envelope's total time, so both timeouts are the envelope's own.
  await runResearch({ ...base(fixture, packet), deadline: Number.MAX_SAFE_INTEGER });
  const calls = (mock: unknown) =>
    vi.mocked(mock as (value: unknown) => unknown).mock.calls.map(([value]) => value);
  // Every value is read from the register here, and each share from the register's parameters.
  const shares = researchShares(researchShareUnits(packet.changes), registerShareParameters());
  const { readers } = shares.signals;
  const upstream = calls(upstreamReadModule.createUpstreamReader);
  // Registry calls are [S2 inner, S3 registry, S3 upstream inner]; only the middle one is research's.
  const opened = [
    ['S2 upstream', upstream[0], shares.upstream],
    ['advisory', calls(advisoryReadModule.createAdvisoryReader)[0], shares.advisory],
    ['malware', calls(advisoryReadModule.createMalwareReader)[0], readers.malware],
    ['npm registry', calls(npmRegistryModule.createNpmRegistryReader)[1], readers.registry],
    [
      'publish times',
      calls(publishTimesModule.createNpmPublishTimeReader)[0],
      readers.publishTimes,
    ],
    ['metadata', calls(signalReadModule.createPolicySignalReader)[0], readers.metadata],
    ['S3 upstream', upstream[1], readers.upstream],
  ] as const;
  for (const [name, actual, share] of opened)
    expect(actual, name).toEqual({
      maxRequests: share.maxRequests,
      maxPages: share.maxRequests,
      maxTagCandidates: registered('research.maxTagCandidates'),
      maxTagDepth: registered('research.maxTagDepth'),
      maxResponseBytes: Math.min(
        registered('evidence.envelope.maxResponseBytes'),
        share.maxTotalBytes,
      ),
      maxTotalBytes: share.maxTotalBytes,
      maxJsonEntries: registered('research.maxJsonEntries'),
      maxJsonDepth: registered('research.maxJsonDepth'),
      maxWork: registered('research.maxWork'),
      maxRetainedBytes: registered('research.maxRetainedBytes'),
      maxAttempts: registered('research.maxAttempts'),
      maxFindings: registered('research.maxFindings'),
      requestTimeoutMs: registered('evidence.envelope.requestTimeoutMs'),
      totalTimeoutMs: registered('evidence.envelope.totalTimeoutMs'),
    });
  const stage = calls(policySignalsModule.enrichPolicySignals)[0] as {
    limits: { maxRequests: number; maxTotalBytes: number };
  };
  expect(stage.limits).toMatchObject({
    maxRequests: shares.signals.maxRequests,
    maxTotalBytes: shares.signals.maxTotalBytes,
  });
});

test('stops research GitHub requests at the quota reserve, keeping other hosts and completed members', async () => {
  const { fixture, packet } = await scenario();
  const wall = Date.parse('2026-11-21T00:00:00Z');
  // The reset is 30 minutes away: inside the quota window, beyond research's 240-second deadline,
  // so no reader waits for it.
  const reset = String(Math.floor(wall / 1000) + 30 * 60);
  let stage = 'none';
  let reported = 0;
  const calls: { stage: string; host: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const host = new URL(url).host;
    calls.push({ stage, host });
    const response = await (fixture.fetch as (u: string, i: RequestInit) => Promise<Response>)(
      url,
      init,
    );
    if (host !== 'api.github.com') return response;
    // GitHub reports a falling quota, as it would for a busy repository.
    const headers = new Headers(response.headers);
    headers.set('x-ratelimit-remaining', String(20 - reported++));
    headers.set('x-ratelimit-reset', reset);
    return new Response(response.body, { status: response.status, headers });
  };
  const result = await runResearch({
    ...base(fixture, packet),
    fetch,
    wallNow: () => wall,
    observe: (observation) => {
      if (observation.kind === 'stage-start') stage = observation.stage;
    },
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  const count = (where: string, host: string) =>
    calls.filter((call) => call.stage === where && call.host === host).length;
  // Upstream needs 18 GitHub requests unguarded; the reserve stops it partway.
  expect(count('upstream', 'api.github.com')).toBeGreaterThan(0);
  expect(count('upstream', 'api.github.com')).toBeLessThan(18);
  // GitHub reports 20, 19, ...; research stops once the next request would leave less than the
  // reserve, so it sends exactly 20 - reserve + 1 and the last reported quota is the reserve.
  const reserve = limit('research.githubQuota.reserve');
  expect(count('upstream', 'api.github.com')).toBe(20 - reserve + 1);
  expect(20 - (reported - 1)).toBe(reserve);
  // Later stages send no GitHub request while the estimate is at the reserve...
  expect(count('advisories', 'api.github.com')).toBe(0);
  expect(count('signals', 'api.github.com')).toBe(0);
  // ...but still reach other hosts.
  expect(count('advisories', 'api.osv.dev')).toBe(2);
  expect(count('signals', 'registry.npmjs.org')).toBe(2);
  // The upstream reader blocks only GitHub, so the stage itself keeps running; a refusal is never
  // reported as our own budget or a fault.
  for (const { reason } of result.unavailable)
    expect(['budget', 'unknown', 'malformed']).not.toContain(reason);
  // Members researched before the stop keep their evidence; GitHub-backed checks after it carry
  // the stop's reason, and the uv member's OSV lookup still completes.
  type Evidence = Record<string, { status: string; reasons?: readonly string[] }>;
  const members = result.packet.changes.filter((change) => !('basis' in change));
  const evidence = (category: string) =>
    members.map((change) => ({
      ecosystem: change.ecosystem,
      ...(change.evidence as Evidence)[category],
    }));
  expect(evidence('upstream').some((item) => item.status === 'available')).toBe(true);
  expect(evidence('upstream').some((item) => item.reasons?.includes('rate_limit'))).toBe(true);
  // The guard's stops could not wait for the reset, so it becomes the packet's retry time.
  expect(result.packet.retryAfter).toBe('2026-11-21T00:30:00Z');
  for (const item of evidence('vulnerability'))
    expect(item).toMatchObject(
      item.ecosystem === 'uv'
        ? { status: 'available' }
        : { status: 'unavailable', reasons: ['rate_limit'] },
    );
});

test('a refusal by two quota counters records the later reset as the packet retry time (#447)', async () => {
  const { fixture, packet } = await scenario();
  const wall = Date.parse('2026-11-21T00:00:00Z');
  const reserve = limit('research.githubQuota.reserve');
  // One token, two core counters, both past research's deadline. The first response names the
  // later reset with one request to spare; the second names the earlier reset, already below the
  // reserve. Both counters then refuse, and the lower one does not set the retry time.
  const early = Math.floor(wall / 1000) + 20 * 60;
  const late = early + 20 * 60;
  const readings = [
    { remaining: reserve + 1, reset: late },
    { remaining: reserve - 1, reset: early },
  ];
  let github = 0;
  const fetch = async (url: string, init: RequestInit) => {
    const response = await (fixture.fetch as (u: string, i: RequestInit) => Promise<Response>)(
      url,
      init,
    );
    if (new URL(url).host !== 'api.github.com') return response;
    const reading = readings[github++];
    if (!reading) throw new Error('the guard sent a request both counters refuse');
    const headers = new Headers(response.headers);
    headers.set('x-ratelimit-remaining', String(reading.remaining));
    headers.set('x-ratelimit-reset', String(reading.reset));
    return new Response(response.body, { status: response.status, headers });
  };
  const result = await runResearch({ ...base(fixture, packet), fetch, wallNow: () => wall });
  if (result.kind !== 'ready') throw new Error(result.kind);
  expect(github).toBe(2);
  expect(result.packet.retryAfter).toBe('2026-11-21T00:40:00Z');
});

test('uses an injected quota guard for every research GitHub request', async () => {
  const { fixture, packet } = await scenario();
  const hosts: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    hosts.push(new URL(url).host);
    return (fixture.fetch as (u: string, i: RequestInit) => Promise<Response>)(url, init);
  };
  const admitted: string[] = [];
  const quota = {
    admit: (url: string) =>
      new URL(url).host === 'api.github.com'
        ? (admitted.push(url),
          { allowed: false as const, retryAt: null, response: new Response(null, { status: 429 }) })
        : { allowed: true as const },
    observe: () => {},
    refusals: () => admitted.length,
    started: () => {},
    retryAt: () => null,
    msUntil: () => 0,
    recordStop: () => {},
    latestRetryAt: () => null,
  };
  const result = await runResearch({ ...base(fixture, packet), fetch, quota });
  expect(result.kind).toBe('ready');
  expect(admitted.length).toBeGreaterThan(0);
  expect(hosts).not.toContain('api.github.com');
  expect(hosts).toContain('registry.npmjs.org');
});

test('a run with no GitHub rate-limit stop has no retry time, even when OSV is rate-limited', async () => {
  const { fixture, packet } = await scenario();
  const plain = await runResearch(base(fixture, packet));
  if (plain.kind !== 'ready') throw new Error(plain.kind);
  // The direct-member rates cover the fixture's Actions and pip lookups under the fitted shares.
  expect(JSON.stringify(plain.packet)).not.toContain('budget');
  expect(plain.packet.retryAfter).toBeNull();
  const osvLimited = await runResearch({
    ...base(fixture, packet),
    fetch: async (url: string, init: RequestInit) =>
      new URL(url).host === 'api.osv.dev'
        ? new Response(null, { status: 429, headers: { 'retry-after': '1' } })
        : (fixture.fetch as (u: string, i: RequestInit) => Promise<Response>)(url, init),
  });
  if (osvLimited.kind !== 'ready') throw new Error(osvLimited.kind);
  expect(JSON.stringify(osvLimited.packet)).toContain('rate_limit');
  expect(osvLimited.packet.retryAfter).toBeNull();
});

test('rounds the retry time up to the whole second', async () => {
  const { fixture, packet } = await scenario();
  const wall = Date.parse('2026-11-21T00:00:00Z') + 500;
  const result = await runResearch({
    ...base(fixture, packet),
    wallNow: () => wall,
    // GitHub asks for 10 minutes, which research's deadline cannot wait out.
    fetch: async (url: string, init: RequestInit) =>
      new URL(url).host === 'api.github.com'
        ? new Response(null, { status: 429, headers: { 'retry-after': '600' } })
        : (fixture.fetch as (u: string, i: RequestInit) => Promise<Response>)(url, init),
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  expect(result.packet.retryAfter).toBe('2026-11-21T00:10:01Z');
});

test('reports an internal failure rather than a research result when a reader throws', async () => {
  const { fixture, packet } = await scenario();
  const result = await runResearch({
    ...base(fixture, packet),
    packet: undefined as never,
  });
  expect(result).toEqual({ kind: 'internal-failure' });
});

test('does not raise unhandled errors when closing readers fails', async () => {
  const { fixture, packet } = await scenario();
  const spy = vi.spyOn(globalThis, 'clearTimeout');
  const result = await runResearch(base(fixture, packet));
  spy.mockRestore();
  expect(result.kind).toBe('ready');
});

test('still runs, with request timeouts no longer than the time left, near the deadline', async () => {
  const { fixture, packet } = await scenario();
  vi.mocked(upstreamReadModule.createUpstreamReader).mockClear();
  vi.mocked(advisoryReadModule.createAdvisoryReader).mockClear();
  const result = await runResearch({ ...base(fixture, packet), now: () => 0, deadline: 5_000 });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.unavailable).toEqual([]);
  const all = [
    ...vi.mocked(upstreamReadModule.createUpstreamReader).mock.calls,
    ...vi.mocked(advisoryReadModule.createAdvisoryReader).mock.calls,
  ].map(([limits]) => limits as { requestTimeoutMs: number; totalTimeoutMs: number });
  expect(all.length).toBeGreaterThan(0);
  for (const limits of all) {
    expect(limits.totalTimeoutMs).toBe(5_000);
    expect(limits.requestTimeoutMs).toBeLessThanOrEqual(limits.totalTimeoutMs);
  }
});

test.each([true, false])(
  'researches a group of 32 changed packages without exhausting any reader; batched=%s',
  async (batched) => {
    // One npm anchor, one Action, one uv package, and 29 npm children.
    const { fixture, packet } = await scenario({ children: 29 } as never);
    expect(packet.changes.length).toBe(32);
    if (!batched) await dropAdvisoryPrePass();
    const counts: Record<string, number> = {};
    const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
    // The register's shares cover the group batched and unbatched: 3 direct and 29 transitive
    // members give advisory 3 + 3 × 3 + 2 × 29 = 70 and malware 2 + 2 × 3 + 1 × 32 = 40.
    expect(researchShares(researchShareUnits(packet.changes))).toMatchObject({
      advisory: { maxRequests: 70 },
      signals: { readers: { malware: { maxRequests: 40 } } },
    });
    const result = await runResearch({
      ...base(fixture, packet),
      fetch: async (url, init) => {
        const target = new URL(url);
        if (target.pathname.startsWith('/advisories'))
          bump(target.searchParams.get('type') === 'malware' ? 'malware' : 'advisory');
        return fixture.fetch(url, init);
      },
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.unavailable).toEqual([]);
    // Every package was looked up, and none was cut short by a share running out. Malware is
    // settled in batches: one npm batch for all 30 npm packages, one pip discovery batch and the
    // hit's versioned query, and the Action's own discovery and versioned query.
    const { readers } = EVIDENCE_READ_ALLOCATION.signals;
    expect(counts.malware).toBe(5);
    expect(
      result.packet.changes.every((c) => 'basis' in c || c.evidence.malware.status === 'available'),
    ).toBe(true);
    expect(counts.malware).toBeLessThanOrEqual(readers.malware.maxRequests);
    // Reviewed advisories take one npm batch per side, and the Action's discovery batch, whose
    // hit sends both versioned queries. Read alone, they still fit the cost-sized share.
    if (batched) expect(counts.advisory).toBe(5);
    else expect(counts.advisory).toBeGreaterThan(50);
    expect(counts.advisory).toBeLessThanOrEqual(EVIDENCE_READ_ALLOCATION.advisory.maxRequests);
    for (const change of result.packet.changes)
      if (!('basis' in change)) expect(change.evidence.vulnerability.status).toBe('available');
    // No stage of research ran out of any share, in the packet or in its own attempt records.
    expect(JSON.stringify(result.packet)).not.toContain('budget');
    expect(JSON.stringify(result.upstreamAttempts)).not.toContain('budget');
    expect(JSON.stringify(result.signalAttempts)).not.toContain('budget');
    expect(result.signalAttempts.length).toBeGreaterThan(0);
    expect(result.upstreamAttempts.length).toBeGreaterThan(0);
  },
);

test('a uv change of one direct and seven transitive pip packages keeps every vulnerability check', async () => {
  const CHILDREN = 7;
  const { fixture, packet } = await scenario({ uvChildren: CHILDREN });
  const uv = packet.changes.filter((c) => c.ecosystem === 'uv' && !('basis' in c));
  expect(uv.map((c) => c.role).sort()).toEqual([
    'direct',
    ...Array.from({ length: CHILDREN }, () => 'transitive'),
  ]);
  // pip reviewed lookups go to OSV one target at a time, two per member (base and head); the
  // transitive rate is sized for that: the advisory share is 3 + 3 × 3 + 2 × 8 = 28 for these
  // 16 OSV lookups and the npm batches and Action. At a transitive rate of 0.2 it would be
  // 3 + 3 × 3 + 0.2 × 8, rounded up to 14, and pip members would end with `budget`.
  let osv = 0;
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => {
      if (new URL(url).host === 'api.osv.dev') osv++;
      return fixture.fetch(url, init);
    },
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  expect(osv).toBe(2 * (CHILDREN + 1));
  for (const change of result.packet.changes)
    if (change.ecosystem === 'uv' && !('basis' in change))
      expect(change.evidence.vulnerability, change.id).toMatchObject({ status: 'available' });
  expect(JSON.stringify(result.packet)).not.toContain('budget');
});

test('a uv change of 30 pip members keeps upstream, vulnerability and malware for every member (#467)', async () => {
  // About half direct and half transitive, as on the #462 PRs: orbit and 14 more direct pip
  // packages, and 15 transitive ones under orbit. Each PyPI version response carries a README-sized
  // description, near the 25–28 KB per read those PRs averaged. Each member's GitHub release
  // carries wheel assets shaped as the REST API returns them, about the 0.6 MB of upstream reads
  // per member #462 measured. Asset records are denser in JSON entries than those PRs' reads
  // (about 7,400 per member), so this change uses more entries than they did. Together they pass
  // each former cap: the 200,000-entry cap, the flat 15 MiB upstream byte share, and the
  // 2,000,000-byte retained cap; the reader keeps each release it parses.
  const DIRECT = 14;
  const CHILDREN = 15;
  const { fixture, packet } = await scenario({
    uvDirect: DIRECT,
    uvChildren: CHILDREN,
    pypiDescriptionBytes: 24_000,
    pipReleaseAssets: 360,
  });
  const uv = packet.changes.filter((c) => c.ecosystem === 'uv' && !('basis' in c));
  expect(uv).toHaveLength(30);
  expect(uv.filter((c) => c.role === 'direct')).toHaveLength(DIRECT + 1);
  // Two PyPI reads per member, which the former flat metadata share of 16 cut after 8 members.
  const units = researchShareUnits(packet.changes);
  expect(units.eligible.metadata).toBe(30);
  expect(researchShares(units).signals.readers.metadata.maxRequests).toBe(
    Math.ceil(
      limit('research.share.signals.metadata.requests.base') +
        30 * limit('research.share.signals.metadata.requests.rate.eligible'),
    ),
  );
  const countEntries = (value: unknown): number =>
    typeof value === 'object' && value !== null
      ? Object.values(value).reduce<number>((total, child) => total + 1 + countEntries(child), 0)
      : 0;
  let pypi = 0;
  const releases = { reads: 0, bytes: 0, entries: 0 };
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => {
      const target = new URL(url);
      if (target.host === 'pypi.org') pypi++;
      const response = await fixture.fetch(url, init);
      if (/^\/repos\/fixture\/py-[^/]+\/releases\/tags\//u.test(target.pathname)) {
        const text = await response.clone().text();
        releases.reads++;
        releases.bytes += Buffer.byteLength(text);
        releases.entries += countEntries(JSON.parse(text));
      }
      return response;
    },
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  expect(pypi).toBe(2 * 30);
  // One release read per member, each about 0.6 MB, all kept by the reader.
  expect(releases.reads).toBe(30);
  expect(releases.bytes / 30).toBeGreaterThan(550_000);
  expect(releases.bytes / 30).toBeLessThan(650_000);
  expect(releases.entries).toBeGreaterThan(200_000);
  expect(releases.bytes).toBeGreaterThan(15 * 1024 * 1024);
  expect(releases.bytes).toBeLessThan(limit('research.maxRetainedBytes'));
  expect(releases.entries).toBeLessThan(limit('research.maxJsonEntries'));
  expect(releases.bytes).toBeLessThan(researchShares(units).upstream.maxTotalBytes);
  expect(result.unavailable).toEqual([]);
  for (const change of result.packet.changes) {
    if (change.ecosystem !== 'uv' || 'basis' in change) continue;
    for (const category of ['upstream', 'vulnerability', 'malware'] as const)
      expect(change.evidence[category], `${change.id} ${category}`).toMatchObject({
        status: 'available',
      });
  }
  expect(JSON.stringify(result.packet)).not.toContain('budget');
  expect(JSON.stringify(result.upstreamAttempts)).not.toContain('budget');
  expect(JSON.stringify(result.signalAttempts)).not.toContain('budget');
});

test('a uv change whose advisory and malware lookups pass the former ceilings completes them (#467)', async () => {
  // 40 uv members, 20 direct and 20 transitive: pip reviewed lookups go to OSV one target at a
  // time, two per member, so advisory needs 80 OSV queries plus the npm batches and the Action's
  // lookups. That is above the former ceiling of 80 and under the ceiling of 221 the evidence
  // deadline derives. Malware takes a pip discovery batch and a versioned query per member, past
  // the former malware ceiling of 40 and under the ceiling of 256 (#467).
  const { fixture, packet } = await scenario({ uvDirect: 19, uvChildren: 20 });
  const uv = packet.changes.filter((c) => c.ecosystem === 'uv' && !('basis' in c));
  expect(uv).toHaveLength(40);
  const share = researchShares(researchShareUnits(packet.changes)).advisory.maxRequests;
  const ceiling = EVIDENCE_READ_ALLOCATION.advisory.maxRequests;
  expect(ceiling).toBe(221);
  expect(EVIDENCE_READ_ALLOCATION.signals.readers.malware.maxRequests).toBe(256);
  let stage = 'none';
  let advisory = 0;
  let malware = 0;
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => {
      const target = new URL(url);
      const reviewed =
        target.host === 'api.osv.dev' ||
        (target.pathname === '/advisories' && target.searchParams.get('type') === 'reviewed');
      if (stage === 'advisories' && reviewed) advisory++;
      if (target.searchParams.get('type') === 'malware') malware++;
      return fixture.fetch(url, init);
    },
    observe: (observation) => {
      if (observation.kind === 'stage-start') stage = observation.stage;
    },
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  expect(advisory).toBeGreaterThan(80);
  expect(advisory).toBeLessThanOrEqual(share);
  expect(share).toBeLessThanOrEqual(ceiling);
  expect(malware).toBeGreaterThan(40);
  expect(result.unavailable).toEqual([]);
  // Every member keeps its vulnerability and malware checks; none ends `budget`.
  for (const change of result.packet.changes)
    if (!('basis' in change))
      for (const category of ['vulnerability', 'malware'] as const)
        expect(change.evidence[category], `${change.id} ${category}`).toMatchObject({
          status: 'available',
          reasons: [],
        });
  expect(JSON.stringify(result.packet)).not.toContain('budget');
  expect(JSON.stringify(result.signalAttempts)).not.toContain('budget');
});

test.each([
  ['one uv member', {}],
  ['a direct member and seven transitive ones', { uvChildren: 7 }],
  ['30 members, half direct', { uvDirect: 14, uvChildren: 15 }],
  ['a member with two resolution variants', { uvVariants: true }],
  ['a member with sdist and wheel artifacts', { uvArtifacts: true }],
] as const)(
  'the PyPI metadata reads stay within two per uv change, the reads its ceiling allows: %s',
  async (_name, options) => {
    // The ceiling is two reads per change, base and head, over the packet's change limit.
    expect(EVIDENCE_READ_ALLOCATION.signals.readers.metadata.maxRequests).toBe(
      2 * limit('packet.changes'),
    );
    const { fixture, packet } = await scenario(options);
    const uvChanges = packet.changes.filter((c) => c.ecosystem === 'uv' && !('basis' in c));
    expect(uvChanges.length).toBeGreaterThan(0);
    const reads: string[] = [];
    const result = await runResearch({
      ...base(fixture, packet),
      fetch: async (url, init) => {
        if (new URL(url).host === 'pypi.org') reads.push(url);
        return fixture.fetch(url, init);
      },
    });
    if (result.kind !== 'ready') throw new Error(result.kind);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(2 * uvChanges.length);
    // Each exact release is read once, shared by upstream and signals.
    expect(new Set(reads).size).toBe(reads.length);
  },
);

test('a one-member uv change whose upstream reads pass one response completes upstream (#467)', async () => {
  // Only the uv member changes. Its repository and release responses together pass the
  // one-response floor and the single member rate, so it needs the upstream byte base: the most
  // reads one member's release stage can make, each a full response.
  const { fixture, packet } = await scenario({
    uvOnly: true,
    pipReleaseAssets: 540,
    pipRepositoryBytes: 300_000,
  });
  const members = packet.changes.filter((c) => !('basis' in c));
  expect(members.map((c) => c.ecosystem)).toEqual(['uv']);
  const share = researchShares(researchShareUnits(packet.changes)).upstream.maxTotalBytes;
  expect(share).toBe(
    limit('research.share.upstream.bytes.base') +
      limit('research.share.upstream.bytes.rate.direct'),
  );
  let github = 0;
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => {
      const response = await fixture.fetch(url, init);
      if (new URL(url).host === 'api.github.com' && !url.includes('/advisories'))
        github += Buffer.byteLength(await response.clone().text());
      return response;
    },
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  const response = limit('evidence.envelope.maxResponseBytes');
  expect(github).toBeGreaterThan(response);
  expect(github).toBeGreaterThan(limit('research.share.upstream.bytes.rate.direct'));
  expect(github).toBeLessThan(limit('research.share.upstream.bytes.base'));
  expect(result.unavailable).toEqual([]);
  expect(members).toHaveLength(1);
  const [member] = result.packet.changes.filter((c) => !('basis' in c));
  expect(member?.evidence.upstream).toMatchObject({ status: 'available', reasons: [] });
  expect(JSON.stringify(result.upstreamAttempts)).not.toContain('budget');
});

test('a one-member uv change makes exactly the metadata request base of PyPI reads', async () => {
  // Its base and head metadata reads (src/evidence/upstream.ts), shared by upstream and signals
  // through the run cache: the structural count the metadata request base is (L11, #383).
  const { fixture, packet } = await scenario({ uvOnly: true });
  const members = packet.changes.filter((c) => !('basis' in c));
  expect(members.map((c) => c.ecosystem)).toEqual(['uv']);
  let pypi = 0;
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => {
      if (new URL(url).host === 'pypi.org') pypi++;
      return fixture.fetch(url, init);
    },
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  expect(pypi).toBe(limit('research.share.signals.metadata.requests.base'));
  expect(pypi).toBe(2);
  expect(result.unavailable).toEqual([]);
  // Both reads fit the byte base, each at most one response at the cap.
  expect(limit('research.share.signals.metadata.bytes.base')).toBe(
    pypi * limit('evidence.envelope.maxResponseBytes'),
  );
});

const PLACEHOLDER = { status: 'unavailable', reasons: ['missing'], sourceIds: [] };
const BUDGET = { status: 'unavailable', reasons: ['budget'], sourceIds: [] };

function evidenceOf(
  packet: { readonly changes: readonly { readonly id: string; readonly evidence: object }[] },
  category: string,
): [string, unknown][] {
  return packet.changes.map((change) => [
    change.id,
    (change.evidence as Readonly<Record<string, unknown>>)[category],
  ]);
}

/** Makes the next upstream run stop after completing every member, as a reader stop would. */
async function stopUpstreamOnce(reason: 'timeout') {
  const actual =
    await vi.importActual<typeof import('./evidence/upstream.js')>('./evidence/upstream.js');
  vi.mocked(upstreamModule.enrichUpstream).mockImplementationOnce(async (...args) => {
    const result = await actual.enrichUpstream(...args);
    return result.kind === 'enriched' ? { ...result, stopped: reason } : result;
  });
}

test("applies a stopped stage's retained members and records the stop", async () => {
  const { fixture, packet } = await scenario();
  const complete = await runResearch(base(fixture, packet));
  await stopUpstreamOnce('timeout');
  const result = await runResearch(base(fixture, packet));
  if (result.kind !== 'ready' || complete.kind !== 'ready') throw new Error('research');
  expect(result.unavailable).toEqual([{ stage: 'upstream', reason: 'timeout' }]);
  expect(evidenceOf(result.packet, 'upstream')).toEqual(evidenceOf(complete.packet, 'upstream'));
});

test('runs advisory lookups for members with retained identities after an upstream stop', async () => {
  const { fixture, packet } = await scenario({ vulnerableNpm: true });
  await stopUpstreamOnce('timeout');
  const result = await runResearch(base(fixture, packet));
  expect(result.kind).toBe('ready');
  const reviewed = fixture.requests
    .filter((url) => url.includes('/advisories') && url.includes('type=reviewed'))
    .map((url) => decodeURIComponent(new URL(url).search));
  expect(reviewed.some((query) => query.includes('ecosystem=npm&affects=orbit@2.0.0'))).toBe(true);
});

type ReadyResearch = Extract<Awaited<ReturnType<typeof runResearch>>, { kind: 'ready' }>;
type ResearchedChange = ReadyResearch['packet']['changes'][number];

/** The members upstream left with nothing retained, with the reasons it recorded for them. */
function cutMembers(packet: ReadyResearch['packet'], reason: string) {
  return packet.changes.filter(
    (change) =>
      !('basis' in change) &&
      change.evidence.upstream.status === 'unavailable' &&
      change.evidence.upstream.sourceIds.length === 0 &&
      change.evidence.upstream.reasons.includes(reason as never),
  );
}

/** Each cut member reports the upstream stop's reason, never `unsupported`, in every lookup category. */
function expectStopReason(
  result: ReadyResearch,
  cut: readonly ResearchedChange[],
  reason: string,
  registryCategories: Readonly<Partial<Record<'npm' | 'uv', readonly string[]>>> = {},
) {
  for (const change of cut) {
    const categories = ['vulnerability', 'malware'];
    if (change.ecosystem === 'npm') categories.push('publishTime');
    if (change.ecosystem !== 'actions')
      categories.push(...(registryCategories[change.ecosystem] ?? []));
    for (const category of categories) {
      const evidence = (
        change.evidence as Readonly<Record<string, ResearchedChange['evidence']['upstream']>>
      )[category];
      expect(evidence, `${change.id} ${category}`).toMatchObject({
        status: 'unavailable',
        reasons: [reason],
      });
      expect(evidence?.sourceIds.length, `${change.id} ${category} sources`).toBeGreaterThan(0);
      for (const id of evidence?.sourceIds ?? []) {
        const reasons = result.packet.sources.find((s) => s.id === id)?.reasons;
        expect(reasons, `${change.id} ${category} source ${id}`).toEqual([reason]);
      }
    }
  }
}

// The #439 reproduction cuts the upstream share, the stage that establishes identity proofs.
test('a member whose identity proof an exhausted upstream share cut reports budget, not unsupported (#439)', async () => {
  const { fixture, packet } = await scenario({ children: 4 });
  // A three-request upstream share runs out after the first member's identity proof.
  const shareParameters = {
    ...RESEARCH_SHARE_PARAMETERS,
    upstream: {
      ...RESEARCH_SHARE_PARAMETERS.upstream,
      requests: { base: 3, ceiling: 3, rates: {} },
    },
  };
  const result = await runResearch({ ...base(fixture, packet), shareParameters });
  if (result.kind !== 'ready') throw new Error('research');
  expect(result.unavailable).toContainEqual({ stage: 'upstream', reason: 'budget' });
  const cut = cutMembers(result.packet, 'budget');
  // The Action lost its ref mapping to the same stop.
  expect(cut.map((change) => change.ecosystem).sort()).toEqual([
    'actions',
    'npm',
    'npm',
    'npm',
    'npm',
    'uv',
  ]);
  // The npm and PyPI metadata categories share the vulnerability rule.
  expectStopReason(result, cut, 'budget', {
    npm: ['trust', 'publisher', 'deprecation'],
    uv: ['publishTime', 'deprecation'],
  });
  // The member that kept its proof was looked up.
  const kept = result.packet.changes.filter(
    (change) => change.ecosystem === 'npm' && change.evidence.vulnerability.status === 'available',
  );
  expect(kept).toHaveLength(1);
});

test('a member whose identity proof a rate-limited upstream read cut reports rate_limit (#439)', async () => {
  const { fixture, packet } = await scenario({ children: 4 });
  // The registry and GitHub repository reads are throttled, so upstream blocks both origins: the
  // npm members and the Action lose their identity reads, while uv metadata still arrives.
  const throttled = (url: URL) =>
    url.origin === 'https://registry.npmjs.org' ||
    (url.origin === 'https://api.github.com' && url.pathname.startsWith('/repos/'));
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) =>
      throttled(new URL(url))
        ? new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } })
        : fixture.fetch(url, init),
  });
  if (result.kind !== 'ready') throw new Error('research');
  const cut = cutMembers(result.packet, 'rate_limit');
  expect(cut.filter((change) => change.ecosystem === 'npm')).toHaveLength(5);
  expect(cut.filter((change) => change.ecosystem === 'actions')).toHaveLength(1);
  expectStopReason(result, cut, 'rate_limit');
});

test('a public registry member whose identity is missing upstream stays unsupported', async () => {
  const { fixture, packet } = await scenario({ missingPyPI: true });
  const result = await runResearch(base(fixture, packet));
  if (result.kind !== 'ready') throw new Error('research');
  const uv = result.packet.changes.find((change) => change.ecosystem === 'uv');
  expect(uv?.evidence.upstream.reasons).not.toContain('budget');
  expect(uv?.evidence.vulnerability.reasons).toEqual(['unsupported']);
  expect(uv?.evidence.malware.reasons).toEqual(['unsupported']);
});

test('a side whose own identity read failed carries its reason while the other side keeps its proof (#439)', async () => {
  const { fixture, packet } = await scenario();
  // Only orbit's base registry read is refused, so its head proof stands.
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) =>
      url === 'https://registry.npmjs.org/orbit/1.0.0'
        ? new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
        : fixture.fetch(url, init),
  });
  if (result.kind !== 'ready') throw new Error('research');
  const orbit = result.packet.changes.find(
    (change) =>
      change.ecosystem === 'npm' && change.to && 'name' in change.to && change.to.name === 'orbit',
  );
  if (!orbit) throw new Error('orbit');
  expect(orbit.evidence.vulnerability.status).toBe('available');
  // Malware reads only the reviewed side; the base advisory lookup is the one the base read cut.
  const failed = result.packet.sources.filter(
    (s) => s.kind === 'advisory' && s.memberIds.includes(orbit.id) && s.status === 'unavailable',
  );
  expect(failed.map((s) => s.reasons)).toEqual([['permission']]);
});

/** Collected changes as upstream would leave them after a budget stop, with no proof or attempt. */
async function budgetCut() {
  const { fixture, packet } = await scenario();
  const changes = structuredClone(packet.changes) as PacketChange[];
  for (const change of changes)
    change.evidence.upstream = { status: 'unavailable', reasons: ['budget'], sourceIds: [] };
  const orbit = changes.find(
    (c) => c.ecosystem === 'npm' && c.to && 'name' in c.to && c.to.name === 'orbit',
  )!;
  const input = {
    changes,
    sources: packet.sources as never,
    npmInventory: structuredClone(fixture.npm) as never,
    publicIdentities: [],
    actionVersions: [],
    attempts: [],
  };
  const gapsFor = (id: string) =>
    upstreamModule
      .identityGaps(input)
      .filter((g) => g.memberId === id)
      .map((g) => [g.side, g.reasons]);
  return { input, orbit, gapsFor };
}

test('a budget stop gives a public npm member with lock integrity a gap on both sides', async () => {
  const { orbit, gapsFor } = await budgetCut();
  expect(gapsFor(orbit.id)).toEqual([
    ['base', ['budget']],
    ['head', ['budget']],
  ]);
});

test('a private-registry npm member cut by a budget stop stays unsupported', async () => {
  const { input, orbit, gapsFor } = await budgetCut();
  // The lockfile node agrees with the change, so only the registry origin rules the member out.
  const identity = 'https://npm.example.com/';
  for (const side of ['from', 'to'] as const) {
    const instance = orbit[side] as {
      source: { identity: string };
      root: string;
      lockPath: string;
    };
    instance.source.identity = identity;
    const root = (
      input.npmInventory as { roots: { root: string; base: never; head: never }[] }
    ).roots.find((r) => r.root === instance.root)!;
    const node = (
      root[side === 'from' ? 'base' : 'head'] as {
        packages: Record<string, { instance: { source: { identity: string } } }>;
      }
    ).packages[instance.lockPath]!;
    node.instance.source.identity = identity;
  }
  expect(gapsFor(orbit.id)).toEqual([]);
});

test('an npm member without lock integrity cut by a budget stop stays unsupported', async () => {
  const { input, orbit, gapsFor } = await budgetCut();
  const instance = orbit.to as { root: string; lockPath: string };
  const root = (
    input.npmInventory as {
      roots: { root: string; head: { packages: Record<string, { integrity: string | null }> } }[];
    }
  ).roots.find((r) => r.root === instance.root)!;
  root.head.packages[instance.lockPath]!.integrity = null;
  // Upstream never tries the head identity without integrity; the base side still has a gap.
  expect(gapsFor(orbit.id)).toEqual([['base', ['budget']]]);
});

test.each([
  ['partial with retained sources', 'partial', true],
  ['unavailable with retained sources', 'unavailable', true],
  ['partial with nothing retained', 'partial', false],
] as const)(
  'a budget-cut member whose upstream is %s and has no proof stays unsupported',
  async (_name, status, retained) => {
    const { orbit, gapsFor } = await budgetCut();
    orbit.evidence.upstream = {
      status,
      reasons: ['budget'],
      sourceIds: retained ? [orbit.to!.sourceId] : [],
    };
    expect(gapsFor(orbit.id)).toEqual([]);
  },
);

test('only budget, timeout, rate_limit and permission pass from upstream to lookups', async () => {
  const { orbit, gapsFor } = await budgetCut();
  orbit.evidence.upstream = {
    status: 'unavailable',
    reasons: ['malformed', 'conflict', 'missing', 'unknown', 'timeout'],
    sourceIds: [],
  };
  expect(gapsFor(orbit.id)).toEqual([
    ['base', ['timeout']],
    ['head', ['timeout']],
  ]);
  orbit.evidence.upstream = {
    status: 'unavailable',
    reasons: ['malformed', 'conflict'],
    sourceIds: [],
  };
  expect(gapsFor(orbit.id)).toEqual([]);
});

/** The advisory and signals stage inputs research built, with members to aim identity gaps at. */
async function stageInputs() {
  const { fixture, packet } = await scenario({ declaration: true, extras: true });
  vi.mocked(advisoryModule.enrichAdvisories).mockClear();
  vi.mocked(policySignalsModule.enrichPolicySignals).mockClear();
  await runResearch(base(fixture, packet));
  const [advisory, advisoryDeps] = vi.mocked(advisoryModule.enrichAdvisories).mock.calls[0]!;
  const [signals, signalDeps] = vi.mocked(policySignalsModule.enrichPolicySignals).mock.calls[0]!;
  const find = (match: (change: ResearchedChange) => boolean) => {
    const change = packet.changes.find(match);
    if (!change) throw new Error('fixture member');
    return change.id;
  };
  return {
    advisory: (gaps: unknown) =>
      advisoryModule.enrichAdvisories(
        { ...(advisory as object), identityGaps: gaps } as never,
        advisoryDeps,
      ),
    signals: (gaps: unknown) =>
      policySignalsModule.enrichPolicySignals(
        { ...(signals as object), identityGaps: gaps } as never,
        signalDeps,
      ),
    updated: find((c) => !('basis' in c) && c.ecosystem === 'npm' && !!c.from && !!c.to),
    added: find((c) => !('basis' in c) && !c.from && !!c.to),
    declaration: find((c) => 'basis' in c),
  };
}
type Members = Awaited<ReturnType<typeof stageInputs>>;

test.each([
  [
    'an unknown member',
    (_m: Members) => [{ memberId: 'npm:none', side: 'head', reasons: ['budget'] }],
  ],
  ['side x', (m: Members) => [{ memberId: m.updated, side: 'x', reasons: ['budget'] }]],
  ['empty reasons', (m: Members) => [{ memberId: m.updated, side: 'head', reasons: [] }]],
  [
    'a reason outside the allowlist',
    (m: Members) => [{ memberId: m.updated, side: 'head', reasons: ['malformed'] }],
  ],
  [
    'a non-array input',
    (m: Members) => ({ memberId: m.updated, side: 'head', reasons: ['budget'] }),
  ],
  [
    'more entries than the length bound',
    (m: Members) =>
      Array.from({ length: 2 * schemaModule.PACKET_LIMITS.changes + 1 }, () => ({
        memberId: m.updated,
        side: 'head',
        reasons: ['budget'],
      })),
  ],
  [
    'a duplicate member and side',
    (m: Members) => [
      { memberId: m.updated, side: 'head', reasons: ['budget'] },
      { memberId: m.updated, side: 'head', reasons: ['timeout'] },
    ],
  ],
  [
    'a side with no instance',
    (m: Members) => [{ memberId: m.added, side: 'base', reasons: ['budget'] }],
  ],
  [
    'a declaration-basis change',
    (m: Members) => [{ memberId: m.declaration, side: 'head', reasons: ['budget'] }],
  ],
] as const)('advisory and signals inputs reject identity gaps with %s', async (_name, gaps) => {
  const inputs = await stageInputs();
  expect((await inputs.advisory(gaps(inputs))).kind).toBe('invalid');
  expect((await inputs.signals(gaps(inputs))).kind).toBe('invalid');
});

test('advisory and signals inputs accept a well-formed identity gap', async () => {
  const inputs = await stageInputs();
  const gaps = [
    { memberId: inputs.updated, side: 'base', reasons: ['budget'] },
    { memberId: inputs.updated, side: 'head', reasons: ['rate_limit', 'permission'] },
  ];
  expect((await inputs.advisory(gaps)).kind).toBe('enriched');
  expect((await inputs.signals(gaps)).kind).toBe('enriched');
});

test('a whole-stage upstream failure gives every identity lookup the stage reason (#439)', async () => {
  const { fixture, packet } = await scenario();
  vi.mocked(upstreamModule.enrichUpstream).mockResolvedValueOnce({
    kind: 'unavailable',
    reason: 'budget',
  });
  const result = await runResearch(base(fixture, packet));
  if (result.kind !== 'ready') throw new Error('research');
  expect(result.unavailable).toContainEqual({ stage: 'upstream', reason: 'budget' });
  const lookups = result.packet.changes.filter((change) => !('basis' in change));
  expect(lookups.map((change) => change.ecosystem).sort()).toEqual(['actions', 'npm', 'npm', 'uv']);
  for (const change of lookups)
    for (const category of ['vulnerability', 'malware'] as const)
      expect(change.evidence[category].reasons, `${change.id} ${category}`).toEqual(['budget']);
});

test('a lock node that disagrees with its change gives no identity gap', async () => {
  const { input, orbit, gapsFor } = await budgetCut();
  const instance = orbit.to as { root: string; lockPath: string };
  const root = (
    input.npmInventory as {
      roots: {
        root: string;
        head: { packages: Record<string, { instance: { version: string } }> };
      }[];
    }
  ).roots.find((r) => r.root === instance.root)!;
  // The node check throws on the disagreement; upstream never researches such a side.
  root.head.packages[instance.lockPath]!.instance.version = '9.9.9';
  expect(gapsFor(orbit.id)).toEqual([['base', ['budget']]]);
});

const BATCHED_EXCERPT = 'A complete batched query checked reviewed advisories for this target.';
const SINGLETON_EXCERPT =
  'The complete exact-version query checked reviewed advisories for this target.';

/** Makes the next advisory reader one without `settle`, so its stage reads every target alone. */
async function dropAdvisoryPrePass() {
  const actual = await vi.importActual<typeof import('./evidence/advisory-read.js')>(
    './evidence/advisory-read.js',
  );
  vi.mocked(advisoryReadModule.createAdvisoryReader).mockImplementationOnce((...args) => {
    const reader = actual.createAdvisoryReader(...args);
    return reader.kind === 'ready' ? { ...reader, settle: undefined } : reader;
  });
}

/** Runs research once, with or without the advisory pre-pass, counting reviewed GitHub queries. */
async function advisoryRun(batched: boolean) {
  const { fixture, packet } = await scenario({ vulnerableNpm: true, children: 3 } as never);
  if (!batched) await dropAdvisoryPrePass();
  const sent: string[] = [];
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => {
      const target = new URL(url);
      if (target.pathname === '/advisories' && target.searchParams.get('type') === 'reviewed')
        sent.push(url);
      return fixture.fetch(url, init);
    },
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  return { packet: result.packet, sent };
}

test('the advisory pre-pass changes only cleared source text and sends fewer requests', async () => {
  const unbatched = await advisoryRun(false);
  const batched = await advisoryRun(true);
  expect(batched.sent.length).toBeLessThan(unbatched.sent.length);
  const settled = batched.packet.sources.filter(
    (s) => s.provenance.kind === 'upstream' && s.provenance.excerpt === BATCHED_EXCERPT,
  );
  // Every npm lookup of both sides was settled, the vulnerable head among them. The fixture
  // stores the Action under its own name, so its discovery batch is a hit and it sends its
  // versioned query as before.
  const npm = batched.packet.sources.filter(
    (s) =>
      s.kind === 'advisory' &&
      s.ecosystems.includes('npm') &&
      s.provenance.kind === 'upstream' &&
      !s.provenance.advisoryId,
  );
  expect(settled).toEqual(npm);
  const sides = settled.flatMap((s) =>
    s.provenance.kind === 'upstream' ? s.provenance.subjects.map((subject) => subject.side) : [],
  );
  expect(new Set(sides)).toEqual(new Set(['base', 'head']));
  expect(new Set(settled.flatMap((s) => s.ecosystems))).toEqual(new Set(['npm']));
  for (const source of settled) {
    if (source.provenance.kind !== 'upstream') continue;
    // Each cites the exact-version query the unbatched run fetched, which the batched run did not.
    const cited = new URL(source.provenance.url);
    expect(cited.searchParams.get('affects')).toMatch(/^[^,]+@[^,]+$/u);
    expect(cited.searchParams.get('per_page')).toBe('100');
    expect(unbatched.sent).toContain(source.provenance.url);
    expect(batched.sent).not.toContain(source.provenance.url);
  }
  expect(batched.packet.findings.some((f) => f.kind === 'vulnerability')).toBe(true);
  const restored = structuredClone(batched.packet) as unknown as {
    sources: { provenance: { excerpt?: string } }[];
  };
  for (const source of restored.sources)
    if (source.provenance.excerpt === BATCHED_EXCERPT)
      source.provenance.excerpt = SINGLETON_EXCERPT;
  expect(restored).toEqual(unbatched.packet);
});

test('a discovery batch that names nothing clears the Action without its versioned query', async () => {
  const { fixture, packet } = await scenario({ stored: () => [] });
  const sent: string[] = [];
  const result = await runResearch({
    ...base(fixture, packet),
    fetch: async (url, init) => (sent.push(url), fixture.fetch(url, init)),
  });
  if (result.kind !== 'ready') throw new Error(result.kind);
  const actions = sent
    .map((url) => new URL(url))
    .filter(
      (u) =>
        u.pathname === '/advisories' &&
        u.searchParams.get('type') === 'reviewed' &&
        u.searchParams.get('ecosystem') === 'actions',
    );
  // Only the package-only discovery query was sent for the Action.
  expect(actions.length).toBeGreaterThan(0);
  expect(actions.every((u) => u.searchParams.get('affects') === 'fixture/action')).toBe(true);
  const cited = result.packet.sources.filter(
    (s) =>
      s.kind === 'advisory' &&
      s.ecosystems.includes('actions') &&
      s.provenance.kind === 'upstream' &&
      !s.provenance.advisoryId,
  );
  expect(cited.map((s) => (s.provenance.kind === 'upstream' ? s.provenance.excerpt : ''))).toEqual(
    cited.map(() => BATCHED_EXCERPT),
  );
  const urls = cited.map((s) =>
    s.provenance.kind === 'upstream' ? decodeURIComponent(s.provenance.url) : '',
  );
  for (const version of ['1.0.0', '2.0.0'])
    expect(
      urls.some((u) => u.includes(`ecosystem=actions&affects=fixture/action@${version}&`)),
    ).toBe(true);
  for (const url of urls) expect(sent.map(decodeURIComponent)).not.toContain(url);
});

const ownedByStage = {
  upstream: ['upstream', 'installScript'],
  advisories: ['vulnerability'],
  signals: ['malware'],
} as const;

const failOnce: Record<keyof typeof ownedByStage, () => void> = {
  upstream: () =>
    vi.mocked(upstreamModule.enrichUpstream).mockResolvedValueOnce({
      kind: 'unavailable',
      reason: 'budget',
    }),
  advisories: () =>
    vi.mocked(advisoryModule.enrichAdvisories).mockResolvedValueOnce({
      kind: 'unavailable',
      reason: 'budget',
    }),
  signals: () =>
    vi.mocked(policySignalsModule.enrichPolicySignals).mockResolvedValueOnce({
      kind: 'unavailable',
      reason: 'budget',
    }),
};

test.each(['upstream', 'advisories', 'signals'] as const)(
  'a failed %s stage marks its placeholders with its reason, not missing',
  async (stage) => {
    const { fixture, packet } = await scenario({ vulnerableNpm: true });
    failOnce[stage]();
    const result = await runResearch(base(fixture, packet));
    if (result.kind !== 'ready') throw new Error('research');
    expect(result.unavailable).toEqual([{ stage, reason: 'budget' }]);
    const owned: readonly string[] = ownedByStage[stage];
    let marked = 0;
    for (const change of packet.changes) {
      if ('basis' in change) continue;
      const after = result.packet.changes.find((candidate) => candidate.id === change.id);
      if (!after) throw new Error(`missing change ${change.id}`);
      for (const category of owned) {
        if (JSON.stringify(change.evidence[category]) !== JSON.stringify(PLACEHOLDER)) continue;
        marked += 1;
        expect(after.evidence[category], `${change.id} ${category}`).toEqual(BUDGET);
      }
      // Categories the failed stage does not own are never marked with its reason.
      for (const [category, evidence] of Object.entries(after.evidence))
        if (!owned.includes(category))
          expect(evidence, `${change.id} ${category}`).not.toEqual(BUDGET);
    }
    expect(marked).toBeGreaterThan(0);
  },
);

test('orders research by priority, handing advisory lookup that order and returning the original order', async () => {
  const change = (id: string, overrides: Record<string, unknown>) =>
    ({
      id,
      ecosystem: 'npm',
      kind: 'update',
      role: 'transitive',
      evidence: {},
      from: null,
      to: null,
      ...overrides,
    }) as unknown as PacketChange;
  const side = (lockPath: string) => ({ root: '.', lockPath, name: lockPath, version: '1.0.0' });
  const inventory = {
    roots: [
      {
        root: '.',
        base: { packages: {} },
        head: { packages: { 'node_modules/scripts': { hasInstallScript: true } } },
      },
    ],
  } as never;
  const synthetic = [
    change('plain-a', { from: side('node_modules/plain-a'), to: side('node_modules/plain-a') }),
    change('direct', {
      role: 'direct',
      from: side('node_modules/direct'),
      to: side('node_modules/direct'),
    }),
    change('added', { kind: 'addition', to: side('node_modules/added') }),
    change('scripts', { from: side('node_modules/scripts'), to: side('node_modules/scripts') }),
    change('plain-b', { from: side('node_modules/plain-b'), to: side('node_modules/plain-b') }),
  ];
  expect(researchOrder(synthetic, inventory).map((entry) => entry.id)).toEqual([
    'direct',
    'added',
    'scripts',
    'plain-a',
    'plain-b',
  ]);

  const { fixture, packet } = await scenario({ children: 29 } as never);
  vi.mocked(advisoryModule.enrichAdvisories).mockClear();
  const result = await runResearch(base(fixture, packet));
  if (result.kind !== 'ready') throw new Error('research');
  const handed = vi.mocked(advisoryModule.enrichAdvisories).mock.calls[0]?.[0] as unknown as {
    changes: readonly PacketChange[];
  };
  const expected = researchOrder(packet.changes, fixture.npm).map((entry) => entry.id);
  expect(handed.changes.map((entry) => entry.id)).toEqual(expected);
  expect(result.packet.changes.map((entry) => entry.id)).toEqual(
    packet.changes.map((entry) => entry.id),
  );
});

const REGISTRY_NAME = 'example-package';
const REGISTRY_VERSION = '1.0.0';
const REGISTRY_INTEGRITY = 'sha512-' + Buffer.alloc(64).toString('base64');
const REGISTRY_URL = `https://registry.npmjs.org/${REGISTRY_NAME}/${REGISTRY_VERSION}`;

/** A registry reader whose only limits are the research register values under test. */
function registryReader(
  limits: {
    maxJsonEntries: number;
    maxRetainedBytes: number;
    maxResponseBytes?: number;
    maxTotalBytes?: number;
  },
  body: unknown,
) {
  const MiB8 = 8 * 1024 * 1024;
  const opened = npmRegistryModule.createNpmRegistryReader(
    {
      maxRequests: 4,
      maxResponseBytes: MiB8,
      maxTotalBytes: MiB8,
      maxJsonDepth: 32,
      requestTimeoutMs: 1000,
      totalTimeoutMs: 10000,
      ...limits,
    },
    {
      fetch: async () =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      now: () => 0,
    },
  );
  if (opened.kind !== 'ready') throw new Error('expected a ready registry reader');
  return opened;
}
const registryRequest = {
  name: REGISTRY_NAME,
  version: REGISTRY_VERSION,
  integrity: REGISTRY_INTEGRITY,
  source: { kind: 'registry', identity: 'https://registry.npmjs.org/' },
};
function registryDocument(extra: unknown) {
  return {
    name: REGISTRY_NAME,
    version: REGISTRY_VERSION,
    _id: `${REGISTRY_NAME}@${REGISTRY_VERSION}`,
    dist: { integrity: REGISTRY_INTEGRITY },
    ...(extra as Record<string, unknown>),
  };
}

test('the npm registry reader counts exactly research.maxJsonEntries entries and refuses one more', async () => {
  const maxJsonEntries = limit('research.maxJsonEntries');
  // Counted entries: the root's five values, dist's integrity, and each element of extra.
  const fixedEntries = 6;
  const entriesFor = (elements: number) =>
    registryDocument({ extra: Array.from({ length: elements }, () => 0) });
  // The document of a million entries is retained whole, so the retained-byte cap is lifted to
  // the response cap here: this test pins the entry cap alone.
  const maxRetainedBytes = 8 * 1024 * 1024;
  const atLimit = registryReader(
    { maxJsonEntries, maxRetainedBytes },
    entriesFor(maxJsonEntries - fixedEntries),
  );
  expect(await atLimit.read(registryRequest)).toMatchObject({ kind: 'metadata' });

  const pastLimit = registryReader(
    { maxJsonEntries, maxRetainedBytes },
    entriesFor(maxJsonEntries - fixedEntries + 1),
  );
  expect(await pastLimit.read(registryRequest)).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(pastLimit.stopped()).toBe('budget');
  expect(atLimit.stopLimit()).toBeNull();
  expect(pastLimit.stopLimit()).toBe('maxJsonEntries');
});

test('the npm registry reader retains exactly research.maxRetainedBytes and refuses one byte more', async () => {
  const maxRetainedBytes = limit('research.maxRetainedBytes');
  // The retained record is { name, version, url, data }, so its size is set by the padding in data.
  const retainedWith = (padding: number) =>
    Buffer.byteLength(
      JSON.stringify({
        name: REGISTRY_NAME,
        version: REGISTRY_VERSION,
        url: REGISTRY_URL,
        data: registryDocument({ pad: 'x'.repeat(padding) }),
      }),
    );
  const padding = maxRetainedBytes - retainedWith(0);
  expect(retainedWith(padding)).toBe(maxRetainedBytes);
  // The cap is the research cache total, above any one response, so the response caps are lifted
  // here: this test pins the retained-byte cap alone.
  const responseCaps = {
    maxResponseBytes: 2 * maxRetainedBytes,
    maxTotalBytes: 2 * maxRetainedBytes,
  };
  const atLimit = registryReader(
    { maxJsonEntries: limit('research.maxJsonEntries'), maxRetainedBytes, ...responseCaps },
    registryDocument({ pad: 'x'.repeat(padding) }),
  );
  expect(await atLimit.read(registryRequest)).toMatchObject({ kind: 'metadata' });

  const pastLimit = registryReader(
    { maxJsonEntries: limit('research.maxJsonEntries'), maxRetainedBytes, ...responseCaps },
    registryDocument({ pad: 'x'.repeat(padding + 1) }),
  );
  expect(await pastLimit.read(registryRequest)).toEqual({ kind: 'unavailable', reason: 'budget' });
  // The measurement report names the limit that stopped the reader (#431).
  expect(atLimit.stopLimit()).toBeNull();
  expect(pastLimit.stopLimit()).toBe('maxRetainedBytes');
});

test('the upstream reader spends exactly research.maxWork units and refuses the next one', () => {
  const maxWork = limit('research.maxWork');
  const share = EVIDENCE_READ_ALLOCATION.upstream;
  const opened = upstreamReadModule.createUpstreamReader(
    {
      maxRequests: share.maxRequests,
      maxPages: share.maxRequests,
      maxTagCandidates: limit('research.maxTagCandidates'),
      maxTagDepth: limit('research.maxTagDepth'),
      maxResponseBytes: Math.min(EVIDENCE_READ_ENVELOPE.maxResponseBytes, share.maxTotalBytes),
      maxTotalBytes: share.maxTotalBytes,
      maxJsonEntries: limit('research.maxJsonEntries'),
      maxJsonDepth: limit('research.maxJsonDepth'),
      maxWork,
      maxRetainedBytes: limit('research.maxRetainedBytes'),
      maxAttempts: limit('research.maxAttempts'),
      requestTimeoutMs: EVIDENCE_READ_ENVELOPE.requestTimeoutMs,
      totalTimeoutMs: EVIDENCE_READ_ENVELOPE.totalTimeoutMs,
    },
    { fetch: async () => new Response('{}'), now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('expected a ready upstream reader');
  const { reader } = opened;
  reader.spend(maxWork);
  expect(reader.stopped?.()).toBeNull();
  expect(reader.stopLimit?.()).toBeNull();
  expect(() => reader.spend(1)).toThrow();
  expect(reader.stopped?.()).toBe('budget');
  expect(reader.stopLimit?.()).toBe('maxWork');
});
