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
  researchShareUnits,
  researchShares,
} from './budget.js';
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
  const expected = [
    ['S2 upstream', upstream[0], EVIDENCE_READ_ALLOCATION.upstream],
    ['advisory', advisory[0], EVIDENCE_READ_ALLOCATION.advisory],
    ['malware', calls(advisoryReadModule.createMalwareReader)[0], readers.malware],
    ['npm registry', registry[1], readers.registry],
    [
      'publish times',
      calls(publishTimesModule.createNpmPublishTimeReader)[0],
      readers.publishTimes,
    ],
    ['metadata', calls(signalReadModule.createPolicySignalReader)[0], readers.metadata],
    ['S3 upstream', upstream[1], readers.upstream],
  ] as const;
  for (const [name, actual, share] of expected)
    expect(actual, name).toMatchObject({
      maxRequests: share.maxRequests,
      maxTotalBytes: share.maxTotalBytes,
      maxResponseBytes: Math.min(MiB, share.maxTotalBytes),
    });
  const used = expected.reduce((sum, [, actual]) => sum + actual.maxRequests, 0);
  const bytes = expected.reduce((sum, [, actual]) => sum + actual.maxTotalBytes, 0);
  // The transport, evidence session, and registry shares hold the rest of the envelope.
  const others = [
    EVIDENCE_READ_ALLOCATION.transport,
    EVIDENCE_READ_ALLOCATION.session,
    EVIDENCE_READ_ALLOCATION.registry,
  ];
  expect(used + others.reduce((sum, share) => sum + share.maxRequests, 0)).toBe(
    EVIDENCE_READ_ENVELOPE.maxRequests,
  );
  expect(bytes + others.reduce((sum, share) => sum + share.maxTotalBytes, 0)).toBe(
    EVIDENCE_READ_ENVELOPE.maxTotalBytes,
  );
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

test('researches a group of 32 changed packages without exhausting any reader', async () => {
  // One npm anchor, one Action, one uv package, and 29 npm children.
  const { fixture, packet } = await scenario({ children: 29 } as never);
  expect(packet.changes.length).toBe(32);
  const counts: Record<string, number> = {};
  const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
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
  // Every package was looked up, and none was cut short by a share running out.
  const { readers } = EVIDENCE_READ_ALLOCATION.signals;
  expect(counts.malware).toBeGreaterThan(25);
  expect(counts.malware).toBeLessThanOrEqual(readers.malware.maxRequests);
  expect(counts.advisory).toBeGreaterThan(50);
  expect(counts.advisory).toBeLessThanOrEqual(EVIDENCE_READ_ALLOCATION.advisory.maxRequests);
  // No stage of research ran out of any share, in the packet or in its own attempt records.
  expect(JSON.stringify(result.packet)).not.toContain('budget');
  expect(JSON.stringify(result.upstreamAttempts)).not.toContain('budget');
  expect(JSON.stringify(result.signalAttempts)).not.toContain('budget');
  expect(result.signalAttempts.length).toBeGreaterThan(0);
  expect(result.upstreamAttempts.length).toBeGreaterThan(0);
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
  limits: { maxJsonEntries: number; maxRetainedBytes: number },
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
  const atLimit = registryReader(
    { maxJsonEntries, maxRetainedBytes: limit('research.maxRetainedBytes') },
    entriesFor(maxJsonEntries - fixedEntries),
  );
  expect(await atLimit.read(registryRequest)).toMatchObject({ kind: 'metadata' });

  const pastLimit = registryReader(
    { maxJsonEntries, maxRetainedBytes: limit('research.maxRetainedBytes') },
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
  const atLimit = registryReader(
    { maxJsonEntries: limit('research.maxJsonEntries'), maxRetainedBytes },
    registryDocument({ pad: 'x'.repeat(padding) }),
  );
  expect(await atLimit.read(registryRequest)).toMatchObject({ kind: 'metadata' });

  const pastLimit = registryReader(
    { maxJsonEntries: limit('research.maxJsonEntries'), maxRetainedBytes },
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
