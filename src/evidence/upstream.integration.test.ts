import { expect, test } from 'vite-plus/test';
import {
  upstreamScenario,
  upstreamTestLimits,
  addSyntheticMalwareCoverage,
} from '../../tests/parity/upstream.js';
import { enrichUpstream } from './upstream.js';
import { createUpstreamReader } from './upstream-read.js';
import { createAdvisoryReader } from './advisory-read.js';
import { enrichAdvisories } from './advisories.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits, evaluateUnitPolicy } from '../units.js';
import { parseReviewConfig } from '../config.js';

async function review(options: Parameters<typeof upstreamScenario>[0] = {}) {
  const fixture = await upstreamScenario(options);
  const opened = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: fixture.fetch });
  if (opened.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(fixture.input, opened);
  opened.reader.close();
  expect(upstream.kind, JSON.stringify(upstream)).toBe('enriched');
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  const advisory = createAdvisoryReader(fixture.advisoryLimits, {
    now: () => 0,
    fetch: fixture.fetch,
  });
  if (advisory.kind !== 'ready') throw new Error('reader');
  const result = await enrichAdvisories(
    {
      binding: upstream.binding,
      changes: upstream.changes,
      sources: upstream.sources,
      findings: upstream.findings,
      publicIdentities: upstream.publicIdentities,
      actionVersions: upstream.actionVersions,
      limits: fixture.advisoryLimits,
    },
    { reader: advisory },
  );
  advisory.close();
  if (result.kind !== 'enriched') throw new Error(JSON.stringify(result));
  const packet = validateReviewPacket(
    {
      version: 1,
      ...fixture.expected,
      ...addSyntheticMalwareCoverage(result),
      coverage: fixture.coverage,
      relationships: fixture.relationships,
    },
    fixture.expected,
  );
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (!packet.ok) throw new Error('packet');
  const units = formDecisionUnits(packet.packet);
  const policy = evaluateUnitPolicy(units, parseReviewConfig('{"version":1}'), 0);
  if (!policy.ok) throw new Error('policy');
  return { fixture, upstream, result, packet: packet.packet, units, policy };
}
test('actual mixed collectors -> S2 -> S1 -> T4 -> T5 -> C3 retain exact attribution', async () => {
  const r = await review();
  expect(r.upstream.publicIdentities).toHaveLength(6);
  expect(r.upstream.actionVersions).toHaveLength(2);
  expect(r.upstream.changes.every((c) => c.evidence.upstream.status === 'available')).toBe(true);
  expect(r.units.units.find((u) => u.kind === 'direct_group')?.memberCount).toBe(2);
  expect(r.fixture.npm.comparison.status).toBe('unavailable');
  expect(r.result.changes.map((c) => c.id)).toEqual(r.fixture.input.changes.map((c) => c.id));
});
test('a known proposed vulnerability survives unavailable uv metadata and research', async () => {
  const r = await review({ missingPyPI: true, vulnerableNpm: true });
  expect(r.policy.defaultCeiling).toBe('do_not_merge');
  expect(r.result.findings.some((f) => f.kind === 'vulnerability')).toBe(true);
  const uv = r.result.changes.find((c) => c.ecosystem === 'uv');
  expect(uv?.evidence.upstream.status).toBe('unavailable');
  expect(uv?.evidence.vulnerability.status).toBe('unavailable');
  expect(
    r.units.units.some((u) =>
      u.evidenceLinks.some((link) => link.memberId === uv?.id && link.status === 'unavailable'),
    ),
  ).toBe(true);
});
test('mixed additions/removals/declarations keep nullable sides and declaration research empty', async () => {
  const r = await review({ extras: true, declaration: true });
  expect(r.result.changes.some((c) => c.kind === 'addition')).toBe(true);
  expect(r.result.changes.some((c) => c.kind === 'removal')).toBe(true);
  const declaration = r.result.changes.find((c) => 'basis' in c);
  expect(declaration?.evidence).toEqual({});
  expect(r.upstream.attempts.some((a) => a.memberId === declaration?.id)).toBe(false);
  expect(r.fixture.requests.some((url) => url.includes('/steady/'))).toBe(false);
});
test('uv variants retain their own proofs and cannot borrow another variant release', async () => {
  const r = await review({ uvVariants: true });
  const uv = r.upstream.changes.filter((c) => c.ecosystem === 'uv');
  expect(uv).toHaveLength(2);
  expect(r.upstream.publicIdentities.filter((p) => p.ecosystem === 'uv')).toHaveLength(4);
  expect(
    uv.some((c) => c.to?.version.endsWith('+other') && c.evidence.upstream.status === 'partial'),
  ).toBe(true);
  expect(
    uv.some((c) => c.to?.version === '2.0.0' && c.evidence.upstream.status === 'available'),
  ).toBe(true);
});
test('a failed grouped child advisory remains visible beside complete anchor research', async () => {
  const r = await review({ failedAdvisoryChild: true });
  const child = r.result.changes.find((c) => c.ecosystem === 'npm' && c.to?.name === 'child-0');
  expect(child?.evidence.upstream.status).toBe('available');
  expect(child?.evidence.vulnerability.status).toBe('unavailable');
  expect(
    r.units.units
      .find((u) => u.kind === 'direct_group')
      ?.evidenceLinks.some(
        (link) =>
          link.memberId === child?.id &&
          link.category === 'vulnerability' &&
          link.status === 'unavailable',
      ),
  ).toBe(true);
  expect(r.policy.defaultCeiling).toBe('merge_with_followups');
});
test('unsupported Actions components remain unknown alongside complete npm evidence', async () => {
  const r = await review({ actionsSubpath: true });
  expect(r.upstream.actionVersions).toHaveLength(0);
  expect(
    r.result.changes.find((c) => c.ecosystem === 'actions')?.evidence.vulnerability.status,
  ).toBe('unavailable');
  expect(r.result.changes.find((c) => c.ecosystem === 'npm')?.evidence.upstream.status).toBe(
    'available',
  );
});
test.each([125, 126])(
  'actual mixed inventory retains the 128-change boundary (%s children)',
  async (children) => {
    const f = await upstreamScenario({ children, lifecycle: false });
    let requests = 0;
    const opened = createUpstreamReader(upstreamTestLimits, {
      now: () => 0,
      fetch: async (url, init) => {
        requests++;
        return f.fetch(url, init);
      },
    });
    if (opened.kind !== 'ready') throw new Error('reader');
    const r = await enrichUpstream(f.input, opened);
    expect(
      r.kind,
      JSON.stringify({
        result: r,
        requests,
        inputBytes: Buffer.byteLength(JSON.stringify(f.input)),
        contributionBytes: Buffer.byteLength(
          JSON.stringify({
            changes: f.input.changes,
            sources: f.input.sources,
            findings: f.input.findings,
          }),
        ),
        changes: f.input.changes.length,
        sources: f.input.sources.length,
        findings: f.input.findings.length,
        npm: f.npm.changes.length,
        uv: f.uv.changes.length,
        actions: f.actions.changes.length,
      }),
    ).toBe(children === 125 ? 'enriched' : 'invalid');
    if (children === 126) expect(requests).toBe(0);
    opened.reader.close();
  },
);
test('clipped target notes beside an unavailable comparison keep the whole enrichment usable', async () => {
  const f = await upstreamScenario();
  const opened = createUpstreamReader(upstreamTestLimits, {
    now: () => 0,
    fetch: async (url, init) => {
      const response = await f.fetch(url, init);
      if (!/^\/repos\/[^/]+\/[^/]+\/releases(?:\/tags\/|$)/u.test(new URL(url).pathname))
        return response;
      const data = await response.json();
      const long = (r: Record<string, unknown>) => ({ ...r, body: 'Long notes. '.repeat(300) });
      return Response.json(Array.isArray(data) ? data.map(long) : long(data));
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const r = await enrichUpstream(f.input, opened);
  opened.reader.close();
  expect(r.kind, JSON.stringify(r)).toBe('enriched');
  if (r.kind !== 'enriched') throw new Error('upstream');
  const npm = r.changes.find((c) => c.ecosystem === 'npm' && c.kind === 'update');
  expect(npm?.evidence.upstream.status).toBe('partial');
  expect(npm?.evidence.upstream.reasons).toContain('truncated');
});
test('the retained-output budget admits the exact enriched size and rejects one byte less', async () => {
  const run = async (maxRetainedBytes: number) => {
    const f = await upstreamScenario();
    const scoped = { ...upstreamTestLimits, maxRetainedBytes };
    const opened = createUpstreamReader(scoped, { now: () => 0, fetch: f.fetch });
    if (opened.kind !== 'ready') throw new Error('reader');
    const r = await enrichUpstream({ ...f.input, limits: scoped }, opened);
    opened.reader.close();
    return r;
  };
  const full = await run(upstreamTestLimits.maxRetainedBytes);
  if (full.kind !== 'enriched') throw new Error('upstream');
  const exact = Buffer.byteLength(JSON.stringify(full));
  expect(await run(exact)).toEqual(full);
  expect(await run(exact - 1)).toEqual({ kind: 'unavailable', reason: 'budget' });
});
