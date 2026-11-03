import { expect, test } from 'vite-plus/test';
import { enrichAdvisories } from './advisories.js';
import { createAdvisoryReader } from './advisory-read.js';
import { validateReviewPacket } from '../schema.js';
import {
  collectAdvisoryNpm,
  advisoryTestLimits,
  syntheticAdvisory,
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
