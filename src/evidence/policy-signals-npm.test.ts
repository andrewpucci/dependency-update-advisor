import { expect, test } from 'vite-plus/test';
import { npmPublishingFacts } from './policy-signals-npm.js';
import { enrichPolicySignals } from './policy-signals.js';
import { createMalwareReader } from './advisory-read.js';
import { createNpmRegistryReader } from './npm-registry.js';
import { createNpmPublishTimeReader } from './npm-publish-times.js';
import { createUpstreamReader } from './upstream-read.js';
import { enrichUpstream } from './upstream.js';
import { upstreamScenario, upstreamTestLimits } from '../../tests/parity/upstream.js';
import { validateReviewPacket } from '../schema.js';
import { limit, SIGNAL_EXCERPT } from '../limits.js';

test('npm exact-version publishing facts exclude email and retain independent mechanisms', () => {
  const f = npmPublishingFacts({
    _npmUser: { name: 'alice', email: 'private@example.invalid' },
    maintainers: [{ name: 'bob', email: 'hidden@example.invalid' }, { name: 'alice' }],
    dist: {
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/pkg@2',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
    deprecated: 'Use the maintained version',
  });
  expect(f.account).toEqual({ kind: 'known', value: { kind: 'human', name: 'alice' } });
  expect(f.maintainers).toEqual({ kind: 'known', value: ['alice', 'bob'] });
  expect(f.provenance).toEqual({ kind: 'known', value: true });
  expect(f.trustedPublishing).toEqual({ kind: 'known', value: false });
  expect(JSON.stringify(f)).not.toContain('example.invalid');
});
test('a long deprecation reason never splits a surrogate pair', () => {
  const cap = limit('signals.reasonCodeUnits');
  const f = npmPublishingFacts({ deprecated: 'x'.repeat(cap - 1) + '\u{1F600} tail' });
  if (f.deprecated.kind !== 'known' || !f.deprecated.value) throw new Error('deprecated');
  expect(f.deprecated.value.reason).toBe('x'.repeat(cap - 1) + ' [reason truncated]');
  expect(/\p{Cs}/u.test(f.deprecated.value.reason)).toBe(false);
});
test('trusted publisher uses provider/configuration identity rather than its display name', () => {
  const f = npmPublishingFacts({
    _npmUser: {
      name: 'GitHub Actions',
      trustedPublisher: { id: 'github', oidcConfigId: 'configuration-1' },
    },
    maintainers: [],
    dist: {},
  });
  expect(f.account).toEqual({
    kind: 'known',
    value: { kind: 'trusted', provider: 'github', configuration: 'configuration-1' },
  });
  expect(f.trustedPublishing).toEqual({ kind: 'known', value: true });
  expect(f.provenance).toEqual({ kind: 'known', value: false });
});
test.each([
  { url: 'https://registry.npmjs.org/arbitrary' },
  {
    url: 'https://evil.example/x',
    provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
  },
])('unusable provenance %j is unchecked rather than absent', (attestations) => {
  const f = npmPublishingFacts({
    _npmUser: { name: 'alice' },
    maintainers: [],
    dist: { attestations },
  });
  expect(f.provenance).toMatchObject({ kind: 'unchecked' });
  expect(f.account.kind).toBe('known');
});
test('a maintainer list at the registered cap is kept and one more is unchecked for budget', () => {
  const cap = limit('signals.npmMaxMaintainers');
  const maintainers = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `maintainer-${i}` }));
  const atCap = npmPublishingFacts({ maintainers: maintainers(cap), dist: {} });
  if (atCap.maintainers.kind !== 'known') throw new Error('maintainers');
  expect(atCap.maintainers.value).toHaveLength(cap);
  expect(
    npmPublishingFacts({ maintainers: maintainers(cap + 1), dist: {} }).maintainers,
  ).toMatchObject({ kind: 'unchecked', reason: 'budget' });
});

test('an unexposed publishing user leaves trusted publishing unknown, not absent', () => {
  const f = npmPublishingFacts({ dist: {} });
  expect(f.trustedPublishing).toEqual({ kind: 'unchecked', reason: 'missing' });
  expect(f.provenance).toEqual({ kind: 'known', value: false });
  expect(f.account).toMatchObject({ kind: 'unchecked' });
  expect(f.maintainers).toMatchObject({ kind: 'unchecked' });
});
test.each([
  'downgrade',
  'absent',
  'base-failed',
  'rollback',
  'kind-change',
  'maintainer-change',
  'long-maintainers',
  'head-unexposed',
])('real exact npm metadata preserves %s policy facts and chronology attribution', async (mode) => {
  const f = await upstreamScenario();
  const ur = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  if (ur.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(f.input, ur);
  ur.reader.close();
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  const npm = createNpmRegistryReader(upstreamTestLimits, {
    now: () => 0,
    fetch: async (url, init) => {
      const version = new URL(url).pathname.split('/').at(-1);
      if (mode === 'base-failed' && version === '1.0.0') return Response.json({}, { status: 503 });
      const data = await (await f.fetch(url, init)).json();
      const trusted =
        mode === 'kind-change'
          ? version === '2.0.0'
          : ['downgrade', 'base-failed', 'rollback', 'head-unexposed'].includes(mode) &&
            version === '1.0.0';
      const unexposed = mode === 'head-unexposed' && version === '2.0.0';
      return Response.json({
        ...data,
        _npmUser: unexposed
          ? undefined
          : trusted
            ? {
                name: 'GitHub Actions',
                trustedPublisher: { id: 'github', oidcConfigId: 'fixture-configuration' },
              }
            : {
                name: mode === 'long-maintainers' && version === '2.0.0' ? 'bob' : 'alice',
                email: 'never-output@example.invalid',
              },
        maintainers:
          mode === 'long-maintainers'
            ? Array.from({ length: 24 }, (_, i) => ({
                name: 'maintainer-' + i + '-abcdefghijklmnopqrstuvwxyz',
              }))
            : [{ name: mode === 'maintainer-change' && version === '2.0.0' ? 'bob' : 'alice' }],
        deprecated: version === '2.0.0' ? 'Use the maintained line' : undefined,
      });
    },
  });
  const times = createNpmPublishTimeReader(
    { ...upstreamTestLimits, maxWork: 100000 },
    {
      now: () => 0,
      fetch: async (url) =>
        Response.json({
          name: decodeURIComponent(new URL(url).pathname.slice(1)),
          time: {
            '1.0.0': mode === 'rollback' ? '2026-11-02T00:00:00Z' : '2026-10-01T00:00:00Z',
            '2.0.0': '2026-11-01T00:00:00Z',
          },
        }),
    },
  );
  const malware = createMalwareReader(f.advisoryLimits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (npm.kind !== 'ready' || times.kind !== 'ready' || malware.kind !== 'ready')
    throw new Error('reader');
  const out = await enrichPolicySignals(
    {
      ...f.input,
      ...upstream,
      limits: { ...f.advisoryLimits, maxAttempts: 1000 },
      evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
    },
    { malwareReader: malware, publishTimeReader: times, npmReader: npm },
  );
  malware.close();
  times.close();
  if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
  const changes = out.changes.filter((c) => c.ecosystem === 'npm');
  const downgrades = out.findings.filter(
    (f) => f.kind === 'supplyChainChange' && f.change === 'trust_downgrade',
  );
  expect(downgrades.length > 0).toBe(mode === 'downgrade');
  expect(out.findings.some((f) => f.kind === 'supplyChainChange' && f.change === 'publisher')).toBe(
    ['downgrade', 'rollback', 'kind-change', 'maintainer-change', 'long-maintainers'].includes(
      mode,
    ),
  );
  if (mode === 'base-failed')
    expect(
      changes.every(
        (c) => c.evidence.trust.status === 'partial' && c.evidence.publisher.status === 'partial',
      ),
    ).toBe(true);
  if (mode === 'head-unexposed')
    expect(changes.every((c) => c.evidence.trust.status === 'partial')).toBe(true);
  if (mode === 'absent')
    expect(changes.every((c) => c.evidence.trust.status === 'available')).toBe(true);
  expect(JSON.stringify(out)).not.toContain('never-output@example.invalid');
  const packet = validateReviewPacket(
    {
      version: 1,
      ...f.expected,
      changes: out.changes,
      sources: out.sources,
      findings: out.findings,
      coverage: f.coverage,
      relationships: f.relationships,
      reachability: [],
      retryAfter: null,
    },
    f.expected,
  );
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (downgrades.length)
    expect(
      downgrades.every((f) =>
        f.references.every((id) => out.sources.find((s) => s.id === id)?.kind === 'trust'),
      ),
    ).toBe(true);
});

/** Runs the real npm signal stage with the proposed version's registry document rewritten. */
async function proposedSignals(rewrite: (data: Record<string, unknown>) => Record<string, unknown>) {
  const f = await upstreamScenario();
  const ur = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  if (ur.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(f.input, ur);
  ur.reader.close();
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  const npm = createNpmRegistryReader(upstreamTestLimits, {
    now: () => 0,
    fetch: async (url, init) => {
      const version = new URL(url).pathname.split('/').at(-1);
      const data = await (await f.fetch(url, init)).json();
      const document = { ...data, _npmUser: { name: 'alice' }, maintainers: [{ name: 'alice' }] };
      return Response.json(version === '2.0.0' ? rewrite(document) : document);
    },
  });
  const times = createNpmPublishTimeReader(
    { ...upstreamTestLimits, maxWork: 100000 },
    {
      now: () => 0,
      fetch: async (url) =>
        Response.json({
          name: decodeURIComponent(new URL(url).pathname.slice(1)),
          time: { '1.0.0': '2026-10-01T00:00:00Z', '2.0.0': '2026-11-01T00:00:00Z' },
        }),
    },
  );
  const malware = createMalwareReader(f.advisoryLimits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (npm.kind !== 'ready' || times.kind !== 'ready' || malware.kind !== 'ready')
    throw new Error('reader');
  const out = await enrichPolicySignals(
    {
      ...f.input,
      ...upstream,
      limits: { ...f.advisoryLimits, maxAttempts: 1000 },
      evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
    },
    { malwareReader: malware, publishTimeReader: times, npmReader: npm },
  );
  malware.close();
  times.close();
  if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
  return out;
}
/** The distinct excerpts of the proposed sides' sources of one kind; every npm member shares them. */
const excerpts = (out: Awaited<ReturnType<typeof proposedSignals>>, kind: string, key: string) => [
  ...new Set(
    out.sources.flatMap((s) =>
    s.kind === kind &&
    s.provenance.kind === 'upstream' &&
    s.provenance.subjects.some((subject) => subject.side === 'head') &&
    s.provenance.excerpt.includes(key)
      ? [s.provenance.excerpt]
      : [],
    ),
  ),
];
test('a deprecation reason of quotes cut at the cap keeps its excerpt inside the excerpt cap', async () => {
  const cap = limit('signals.reasonCodeUnits'),
    excerptCap = limit('packet.excerptCodeUnits');
  const { reasonWrapperCodeUnits: wrapper, reasonMarker: marker } = SIGNAL_EXCERPT;
  // The wrapper: a one-unit reason makes a 51-unit excerpt.
  const plain = await proposedSignals((d) => ({ ...d, deprecated: 'x' }));
  expect(excerpts(plain, 'deprecation', '"deprecated"').map((e) => e.length)).toEqual([
    wrapper + 1,
  ]);
  // The worst escaping: every kept unit is a quote, which JSON doubles.
  const quoted = await proposedSignals((d) => ({ ...d, deprecated: '"'.repeat(3 * cap) }));
  const [excerpt] = excerpts(quoted, 'deprecation', '"deprecated"');
  expect(excerpt).toHaveLength(wrapper + 2 * cap + marker.length);
  expect(excerpt.length).toBeLessThanOrEqual(excerptCap);
  // One unit more would not fit, so the cap is the largest that always does.
  expect(wrapper + 2 * (cap + 1) + marker.length).toBeGreaterThan(excerptCap);
  expect(
    quoted.findings.some((f) => f.kind === 'releaseMetadata' && 'deprecated' in f && f.deprecated),
  ).toBe(true);
});
test('the publisher excerpt takes 71 code units around the maintainer names and 4 for each name', async () => {
  const lengths = [];
  for (const names of [['a'], ['a', 'b']]) {
    const out = await proposedSignals((d) => ({
      ...d,
      maintainers: names.map((name) => ({ name })),
    }));
    lengths.push(...excerpts(out, 'publisher', '"maintainers"').map((e) => e.length));
  }
  const { maintainersWrapperCodeUnits: wrapper, maintainerCodeUnits: perName } = SIGNAL_EXCERPT;
  expect(lengths).toEqual([wrapper + perName - 1, wrapper + 2 * perName - 1]);
  // The cap is the longest list of one-character names whose excerpt could fit.
  const cap = limit('signals.npmMaxMaintainers'),
    excerptCap = limit('packet.excerptCodeUnits');
  expect(wrapper + cap * perName - 1).toBeLessThanOrEqual(excerptCap);
  expect(wrapper + (cap + 1) * perName - 1).toBeGreaterThan(excerptCap);
});
