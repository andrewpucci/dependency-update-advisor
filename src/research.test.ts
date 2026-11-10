import { expect, test, vi } from 'vite-plus/test';
import { upstreamScenario } from '../tests/parity/upstream.js';
import * as advisoryModule from './evidence/advisories.js';
import * as npmRegistryModule from './evidence/npm-registry.js';
import * as publishTimesModule from './evidence/npm-publish-times.js';
import * as signalReadModule from './evidence/policy-signals-read.js';
import * as advisoryReadModule from './evidence/advisory-read.js';
import * as upstreamReadModule from './evidence/upstream-read.js';
import { runResearch } from './research.js';
import * as schemaModule from './schema.js';
import { validateReviewPacket } from './schema.js';

vi.mock('./evidence/advisories.js', async (original) => {
  const actual = await original<typeof import('./evidence/advisories.js')>();
  return { ...actual, enrichAdvisories: vi.fn(actual.enrichAdvisories) };
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

test('gives each reader its share of the envelope and closes every one', async () => {
  const { fixture, packet } = await scenario();
  closed.length = 0;
  vi.mocked(upstreamReadModule.createUpstreamReader).mockClear();
  vi.mocked(advisoryReadModule.createAdvisoryReader).mockClear();
  vi.mocked(advisoryReadModule.createMalwareReader).mockClear();
  await runResearch(base(fixture, packet));
  const MiB = 1024 * 1024;
  const [upstream, signalUpstream] = vi
    .mocked(upstreamReadModule.createUpstreamReader)
    .mock.calls.map(([limits]) => limits as { maxRequests: number; maxTotalBytes: number });
  expect(upstream).toMatchObject({ maxRequests: 96, maxTotalBytes: 6 * MiB });
  expect(signalUpstream).toMatchObject({
    maxRequests: 12,
    maxTotalBytes: Math.floor((2 * MiB) / 5),
  });
  expect(vi.mocked(advisoryReadModule.createAdvisoryReader).mock.calls[0][0]).toMatchObject({
    maxRequests: 64,
    maxTotalBytes: 4 * MiB,
  });
  expect(vi.mocked(advisoryReadModule.createMalwareReader).mock.calls[0][0]).toMatchObject({
    maxRequests: 12,
  });
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

test('falls back to the collected packet when the enriched one fails validation', async () => {
  const { fixture, packet } = await scenario();
  vi.mocked(schemaModule.validateReviewPacket).mockReturnValueOnce({
    ok: false,
    error: { category: 'budget', field: 'sources' },
  });
  const result = await runResearch(base(fixture, packet));
  expect(result).toMatchObject({
    kind: 'ready',
    packet,
    unavailable: expect.arrayContaining([{ stage: 'revalidation', reason: 'malformed' }]),
    upstreamAttempts: [],
    signalAttempts: [],
  });
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
  const limits = (mock: unknown) =>
    vi.mocked(mock as (value: unknown) => unknown).mock.calls.map(([value]) => value as Limits);
  const upstream = limits(upstreamReadModule.createUpstreamReader);
  const advisory = limits(advisoryReadModule.createAdvisoryReader);
  const signal = [
    ...limits(upstreamReadModule.createUpstreamReader).slice(1),
    ...limits(advisoryReadModule.createMalwareReader),
    // Each S2 reader builds an inner registry reader through its own bounded fetch, so the calls are
    // [S2 inner, S3 registry, S3 upstream inner]; only the middle one is ours.
    ...limits(npmRegistryModule.createNpmRegistryReader).slice(1, 2),
    ...limits(publishTimesModule.createNpmPublishTimeReader),
    ...limits(signalReadModule.createPolicySignalReader),
  ];
  expect(upstream).toHaveLength(2);
  expect(advisory).toHaveLength(1);
  expect(signal).toHaveLength(5);
  const shareBytes = Math.floor((2 * MiB) / 5);
  for (const each of signal)
    expect(each).toMatchObject({
      maxRequests: 12,
      maxTotalBytes: shareBytes,
      maxResponseBytes: Math.min(MiB, shareBytes),
    });
  expect(upstream[0]).toMatchObject({ maxRequests: 96, maxResponseBytes: MiB });
  expect(advisory[0]).toMatchObject({ maxRequests: 64, maxResponseBytes: MiB });
  const requests = [upstream[0], advisory[0], ...signal].reduce(
    (sum, each) => sum + each.maxRequests,
    0,
  );
  const bytes = [upstream[0], advisory[0], ...signal].reduce(
    (sum, each) => sum + each.maxTotalBytes,
    0,
  );
  // Transport (64), evidence session (160), and registry (64) hold the rest of 512 and 32 MiB.
  expect(requests).toBeLessThanOrEqual(512 - 64 - 160 - 64);
  expect(bytes).toBeLessThanOrEqual(32 * MiB - 4 * MiB - 12 * MiB - 4 * MiB);
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
