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
  const f = npmPublishingFacts({ deprecated: 'x'.repeat(349) + '\u{1F600} tail' });
  if (f.deprecated.kind !== 'known' || !f.deprecated.value) throw new Error('deprecated');
  expect(f.deprecated.value.reason).toBe('x'.repeat(349) + ' [reason truncated]');
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
