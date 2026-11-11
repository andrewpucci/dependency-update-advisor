import { expect, test } from 'vite-plus/test';
import { enrichAdvisories } from './advisories.js';
import { createAdvisoryReader } from './advisory-read.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits, evaluateUnitPolicy } from '../units.js';
import { parseReviewConfig } from '../config.js';
import {
  collectAdvisoryNpm,
  advisoryTestLimits,
  syntheticAdvisory,
  collectAdvisoryUv,
  collectAdvisoryActions,
  collectMixedAdvisoryInventories,
} from '../../tests/parity/advisories.js';

test.each(['permission', 'empty', 'omission'])(
  'actual D1/N1 retains inventory through %s comparison and independent advisories',
  async (mode) => {
    const { fixture, inventory, input } = await collectAdvisoryNpm(mode);
    const r = createAdvisoryReader(advisoryTestLimits, {
      now: () => 0,
      fetch: async (url) =>
        Response.json(
          new URL(url).searchParams.get('affects') === 'fixture-anchor@1.1.0'
            ? [syntheticAdvisory]
            : [],
        ),
    });
    if (r.kind !== 'ready') throw new Error('reader');
    const result = await enrichAdvisories(input, { reader: r });
    r.close();
    if (result.kind !== 'enriched') throw new Error('enrichment');
    const packet = validateReviewPacket(
      {
        version: 1,
        ...fixture.expected,
        changes: result.changes,
        sources: [...result.sources, fixture.absent],
        findings: result.findings,
        relationships: [],
        reachability: [],
        coverage: {
          npm: inventory.coverage,
          actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        },
      },
      fixture.expected,
    );
    expect(packet.ok, JSON.stringify(packet)).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(inventory.comparison.status).toBe(mode === 'permission' ? 'unavailable' : 'available');
    expect(result.changes.map((c) => c.id)).toEqual(inventory.changes.map((c) => c.id));
  },
);

test('real bounded D1 comparison supplies a positive when global lookup fails', async () => {
  const { input, fixture, inventory } = await collectAdvisoryNpm('empty', 1, [
    {
      manifest: 'package-lock.json',
      change_type: 'added',
      ecosystem: 'npm',
      name: 'fixture-anchor',
      version: '1.1.0',
      vulnerabilities: [
        {
          severity: 'high',
          advisory_ghsa_id: syntheticAdvisory.ghsa_id,
          advisory_url: syntheticAdvisory.html_url,
          advisory_summary: syntheticAdvisory.summary,
        },
      ],
    },
  ]);
  const reader = createAdvisoryReader(advisoryTestLimits, {
    now: () => 0,
    fetch: async () => Response.json({}, { status: 500 }),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const out = await enrichAdvisories(input, { reader });
  reader.close();
  if (out.kind !== 'enriched') throw new Error('enrichment');
  const accepted = validateReviewPacket(
    {
      version: 1,
      ...fixture.expected,
      changes: out.changes,
      sources: [...out.sources, fixture.absent],
      findings: out.findings,
      relationships: [],
      reachability: [],
      coverage: {
        npm: inventory.coverage,
        actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
      },
    },
    fixture.expected,
  );
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  expect(out.findings).toHaveLength(1);
  expect(out.changes[0].evidence.vulnerability.status).toBe('partial');
});

test.each(['https://pypi.org/simple', 'https://private.example/simple'])(
  'actual U1/U2 maps exact %s uv targets without guessing versions',
  async (registry) => {
    const f = await collectAdvisoryUv(registry);
    const requests: URL[] = [];
    const reader = createAdvisoryReader(advisoryTestLimits, {
      now: () => 0,
      fetch: async (url) => {
        const query = new URL(url);
        requests.push(query);
        expect(query.searchParams.get('ecosystem')).toBe('pip');
        expect(['orbit@1.0', 'orbit@2.0rc1']).toContain(query.searchParams.get('affects'));
        return Response.json(
          query.searchParams.get('affects') === 'orbit@2.0rc1'
            ? [
                {
                  ...syntheticAdvisory,
                  vulnerabilities: [
                    {
                      package: { ecosystem: 'pip', name: 'orbit' },
                      vulnerable_version_range: '>=2.0rc1',
                    },
                  ],
                },
              ]
            : [],
        );
      },
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const out = await enrichAdvisories(f.input, { reader });
    reader.close();
    if (out.kind !== 'enriched') throw new Error('enrichment');
    expect(requests).toHaveLength(registry.includes('private') ? 0 : 2);
    expect(out.changes[0].evidence.vulnerability.status).toBe(
      registry.includes('private') ? 'unavailable' : 'available',
    );
    const packet = validateReviewPacket(
      {
        ...f.packet,
        changes: out.changes,
        sources: [
          ...out.sources,
          ...f.packet.sources.filter((s) => !f.input.sources.some((x) => x.id === s.id)),
        ],
        findings: out.findings,
      },
      f.expected,
    );
    expect(packet.ok, JSON.stringify(packet)).toBe(true);
    expect(out.changes).toMatchObject(
      f.inventory.changes.map((c) => ({ id: c.id, from: c.from, to: c.to })),
    );
  },
);

test.each([false, true])(
  'actual X1 refs require a proven mapping=%s, including action subpaths',
  async (mapped) => {
    const f = await collectAdvisoryActions(mapped);
    let calls = 0;
    const reader = createAdvisoryReader(advisoryTestLimits, {
      now: () => 0,
      fetch: async (url) => {
        calls++;
        const query = new URL(url),
          name = query.searchParams.get('affects')!.split('@')[0];
        expect(query.searchParams.get('ecosystem')).toBe('actions');
        expect(query.searchParams.get('affects')).toMatch(/@[12]\.0\.0$/);
        return Response.json(
          query.searchParams.get('affects')!.endsWith('@2.0.0')
            ? [
                {
                  ...syntheticAdvisory,
                  vulnerabilities: [
                    {
                      package: { ecosystem: 'actions', name },
                      vulnerable_version_range: '>=2.0.0',
                    },
                  ],
                },
              ]
            : [],
        );
      },
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const out = await enrichAdvisories(f.input, { reader });
    reader.close();
    if (out.kind !== 'enriched') throw new Error('enrichment');
    expect(calls > 0).toBe(mapped);
    expect(out.findings).toHaveLength(mapped ? f.inventory.changes.length : 0);
    expect(
      out.changes.every(
        (c) => c.evidence.vulnerability.status === (mapped ? 'available' : 'unavailable'),
      ),
    ).toBe(true);
    const packet = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes: out.changes,
        sources: [...out.sources, f.absent],
        findings: out.findings,
        relationships: [],
        reachability: [],
        coverage: {
          actions: f.inventory.coverage,
          npm: { status: 'not_applicable', reasons: [], sourceIds: [f.absent.id] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: [f.absent.id] },
        },
      },
      f.expected,
    );
    expect(packet.ok, JSON.stringify(packet)).toBe(true);
  },
);

test.each(['high', 'critical'])(
  'mixed authentic collectors preserve %s blockers and unknown SHA applicability through T4/T5/C3',
  async (severity) => {
    const f = await collectMixedAdvisoryInventories();
    const reader = createAdvisoryReader(advisoryTestLimits, {
      now: () => 0,
      fetch: async (url) => {
        const query = new URL(url),
          affects = query.searchParams.get('affects')!;
        return Response.json(
          affects === 'fixture-child-0@2.0.0'
            ? [
                {
                  ...syntheticAdvisory,
                  severity,
                  vulnerabilities: [
                    {
                      package: { ecosystem: 'npm', name: 'fixture-child-0' },
                      vulnerable_version_range: '>=2.0.0',
                    },
                  ],
                },
              ]
            : [],
        );
      },
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const out = await enrichAdvisories(f.input, { reader });
    reader.close();
    if (out.kind !== 'enriched') throw new Error('enrichment');
    const accepted = validateReviewPacket(
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
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (!accepted.ok) throw new Error('packet');
    const units = formDecisionUnits(accepted.packet),
      policy = evaluateUnitPolicy(units, parseReviewConfig('{"version":1}'), 0);
    expect(policy.ok).toBe(true);
    if (!policy.ok) throw new Error('policy');
    expect(policy.defaultCeiling).toBe('do_not_merge');
    const group = units.units.find((u) => u.kind === 'direct_group');
    expect(group?.memberCount).toBe(2);
    expect(group?.findings.some((f) => f.kind === 'vulnerability')).toBe(true);
    expect(
      out.changes.find((c) => c.ecosystem === 'actions')?.evidence.vulnerability,
    ).toMatchObject({ status: 'unavailable', reasons: ['unsupported'] });
    expect(out.changes.find((c) => c.ecosystem === 'uv')?.evidence.vulnerability.status).toBe(
      'available',
    );
    const source = out.sources.find(
      (s) =>
        s.kind === 'advisory' &&
        s.memberIds.includes(out.findings.find((f) => f.kind === 'vulnerability')!.memberId) &&
        s.provenance.kind === 'upstream' &&
        !s.provenance.advisoryId,
    );
    expect(source?.provenance.kind === 'upstream' && source.provenance.excerpt).not.toContain(
      'No active',
    );
  },
);

test.each([125, 126])(
  'combined %s npm children respect the unchanged 128-change T4 ceiling',
  async (count) => {
    const f = await collectMixedAdvisoryInventories(count);
    expect(f.input.changes).toHaveLength(count + 3);
    const reader = createAdvisoryReader(advisoryTestLimits, {
      now: () => 0,
      fetch: async () => Response.json([]),
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const result = await enrichAdvisories(f.input, { reader });
    reader.close();
    expect(result.kind).toBe(count === 125 ? 'enriched' : 'invalid');
    const changes = result.kind === 'enriched' ? result.changes : f.input.changes;
    const packet = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes,
        sources: result.kind === 'enriched' ? result.sources : f.input.sources,
        findings: result.kind === 'enriched' ? result.findings : f.input.findings,
        coverage: f.coverage,
        relationships: f.relationships,
        reachability: [],
      },
      f.expected,
    );
    expect(packet.ok).toBe(count === 125);
  },
);

test.each([false, true])(
  'comparison/global disagreement or wrong purl cannot yield complete coverage: wrong purl=%s',
  async (wrongPurl) => {
    const f = await collectAdvisoryNpm('empty', 1, [
      {
        manifest: 'package-lock.json',
        change_type: 'added',
        ecosystem: 'npm',
        name: 'fixture-anchor',
        version: '1.1.0',
        package_url: wrongPurl ? 'pkg:npm/unrelated@1.1.0' : 'pkg:npm/fixture-anchor@1.1.0',
        vulnerabilities: [
          {
            severity: 'high',
            advisory_ghsa_id: syntheticAdvisory.ghsa_id,
            advisory_url: syntheticAdvisory.html_url,
            advisory_summary: syntheticAdvisory.summary,
          },
        ],
      },
    ]);
    const reader = createAdvisoryReader(advisoryTestLimits, {
      now: () => 0,
      fetch: async () => Response.json([]),
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const out = await enrichAdvisories(f.input, { reader });
    reader.close();
    if (out.kind !== 'enriched') throw new Error('enrichment');
    expect(out.changes[0].evidence.vulnerability.reasons).toContain('conflict');
    expect(out.findings).toHaveLength(wrongPurl ? 0 : 1);
  },
);

test('actual N1 removals, declarations, and unchanged versions never create a missing-side claim', async () => {
  for (const options of [{ reverse: true }, { declaration: true }, {}]) {
    const f = await collectAdvisoryNpm('empty', 'reverse' in options ? 1 : 0, undefined, options);
    const requests: string[] = [];
    const reader = createAdvisoryReader(advisoryTestLimits, {
      now: () => 0,
      fetch: async (url) => {
        requests.push(url);
        return Response.json([]);
      },
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const out = await enrichAdvisories(f.input, { reader });
    reader.close();
    if (out.kind !== 'enriched') throw new Error('enrichment');
    expect(out.findings).toEqual([]);
    if ('reverse' in options) {
      const removed = out.changes.find((c) => c.kind === 'removal');
      expect(removed).toBeDefined();
      expect(out.lookups.filter((l) => l.memberId === removed!.id).map((l) => l.side)).toEqual([
        'base',
      ]);
    } else {
      expect(requests).toEqual([]);
      expect(out.changes).toHaveLength('declaration' in options ? 1 : 0);
      if ('declaration' in options) expect(out.changes[0].evidence).toEqual({});
    }
  }
});

test.each([
  ['v2.0.0', 'tag'],
  ['v2', 'tag'],
  ['main', 'branch'],
  ['expression', 'unknown'],
] as const)('unmapped Actions ref %s remains unknown without guessing', async (ref, refKind) => {
  const f = await collectAdvisoryActions();
  const changes = f.input.changes.map((c) =>
    c.ecosystem === 'actions' && c.to ? { ...c, to: { ...c.to, ref, refKind } } : c,
  );
  let calls = 0;
  const reader = createAdvisoryReader(advisoryTestLimits, {
    now: () => 0,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const result = await enrichAdvisories({ ...f.input, changes }, { reader });
  reader.close();
  expect(result.kind).toBe('enriched');
  expect(calls).toBe(0);
  if (result.kind === 'enriched')
    expect(result.changes.every((c) => c.evidence.vulnerability.status === 'unavailable')).toBe(
      true,
    );
});

test('real uv marker variants keep exact separate subjects through shared advisory requests', async () => {
  const f = await collectAdvisoryUv('https://pypi.org/simple', true);
  expect(f.inventory.changes.length).toBeGreaterThan(1);
  const queries: string[] = [];
  const reader = createAdvisoryReader(advisoryTestLimits, {
    now: () => 0,
    fetch: async (url) => {
      queries.push(new URL(url).searchParams.get('affects')!);
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const result = await enrichAdvisories(f.input, { reader });
  reader.close();
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result.changes.every((c) => c.evidence.vulnerability.status === 'available')).toBe(true);
  expect(result.changes.map((c) => [c.id, c.from, c.to])).toEqual(
    f.inventory.changes.map((c) => [c.id, c.from, c.to]),
  );
  expect(new Set(queries).size).toBe(queries.length);
  const packet = validateReviewPacket(
    {
      ...f.packet,
      changes: result.changes,
      sources: [
        ...result.sources,
        ...f.packet.sources.filter((s) => !f.input.sources.some((x) => x.id === s.id)),
      ],
      findings: result.findings,
    },
    f.expected,
  );
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
});
