import { expect, test, vi } from 'vite-plus/test';
import { upstreamScenario } from '../tests/parity/upstream.js';
import * as advisoryModule from './evidence/advisories.js';
import * as npmRegistryModule from './evidence/npm-registry.js';
import * as publishTimesModule from './evidence/npm-publish-times.js';
import * as signalReadModule from './evidence/policy-signals-read.js';
import * as advisoryReadModule from './evidence/advisory-read.js';
import * as upstreamReadModule from './evidence/upstream-read.js';
import { W2_ALLOCATION, W2_ENVELOPE } from './budget.js';
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
  const calls = (mock: unknown) =>
    vi.mocked(mock as (value: unknown) => unknown).mock.calls.map(([value]) => value as Limits);
  const upstream = calls(upstreamReadModule.createUpstreamReader);
  const advisory = calls(advisoryReadModule.createAdvisoryReader);
  // Each S2 reader builds an inner registry reader through its own bounded fetch, so the registry
  // calls are [S2 inner, S3 registry, S3 upstream inner]; only the middle one is ours.
  const registry = calls(npmRegistryModule.createNpmRegistryReader);
  expect(upstream).toHaveLength(2);
  expect(advisory).toHaveLength(1);
  const { readers } = W2_ALLOCATION.signals;
  const expected = [
    ['S2 upstream', upstream[0], W2_ALLOCATION.upstream],
    ['advisory', advisory[0], W2_ALLOCATION.advisory],
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
  const others = [W2_ALLOCATION.transport, W2_ALLOCATION.session, W2_ALLOCATION.registry];
  expect(used + others.reduce((sum, share) => sum + share.maxRequests, 0)).toBe(
    W2_ENVELOPE.maxRequests,
  );
  expect(bytes + others.reduce((sum, share) => sum + share.maxTotalBytes, 0)).toBe(
    W2_ENVELOPE.maxTotalBytes,
  );
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
  const { readers } = W2_ALLOCATION.signals;
  expect(counts.malware).toBeGreaterThan(25);
  expect(counts.malware).toBeLessThanOrEqual(readers.malware.maxRequests);
  expect(counts.advisory).toBeGreaterThan(50);
  expect(counts.advisory).toBeLessThanOrEqual(W2_ALLOCATION.advisory.maxRequests);
  expect(JSON.stringify(result.packet.changes)).not.toContain('"reasons":["budget"]');
  expect(JSON.stringify(result.packet.sources)).not.toContain('"reasons":["budget"]');
});
