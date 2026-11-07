import { expect, test } from 'vite-plus/test';
import { enrichPolicySignals } from './policy-signals.js';
import { createMalwareReader } from './advisory-read.js';
import { createUpstreamReader } from './upstream-read.js';
import { enrichUpstream } from './upstream.js';
import { upstreamScenario, upstreamTestLimits } from '../../tests/parity/upstream.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits, evaluateUnitPolicy } from '../units.js';
import { parseReviewConfig } from '../config.js';

async function fixture(extras = false) {
  const f = await upstreamScenario({ extras, declaration: extras });
  const r = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  if (r.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(f.input, r);
  r.reader.close();
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  return {
    f,
    input: {
      ...upstream,
      limits: { ...f.advisoryLimits, maxAttempts: 2000 },
      evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
    },
  };
}

test.each(['positive', 'failed', 'empty'])(
  'exact-member malware %s survives T4/T5/C3 without changing other categories',
  async (mode) => {
    const { f, input } = await fixture(true);
    const requests: URL[] = [];
    const r = createMalwareReader(input.limits, {
      now: () => 0,
      fetch: async (url) => {
        const query = new URL(url);
        requests.push(query);
        const name = query.searchParams.get('affects')!.split('@')[0];
        return mode === 'failed'
          ? Response.json({}, { status: 503 })
          : Response.json(
              mode === 'positive'
                ? [
                    {
                      ghsa_id: 'GHSA-aaaa-bbbb-cccc',
                      html_url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
                      summary: 'Synthetic malware',
                      type: 'malware',
                      severity: 'unknown',
                      withdrawn_at: null,
                      vulnerabilities: [
                        {
                          package: { ecosystem: query.searchParams.get('ecosystem'), name },
                          vulnerable_version_range: '*',
                        },
                      ],
                    },
                  ]
                : [],
            );
      },
    });
    if (r.kind !== 'ready') throw new Error('reader');
    const out = await enrichPolicySignals(input, { malwareReader: r });
    r.close();
    if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
    expect(out.changes.map((c) => c.id)).toEqual(input.changes.map((c) => c.id));
    expect(out.changes.map((c) => c.evidence.upstream)).toEqual(
      input.changes.map((c) => c.evidence.upstream),
    );
    expect(requests.every((q) => q.searchParams.get('type') === 'malware')).toBe(true);
    expect(
      out.attempts.some((a) => input.changes.find((c) => c.id === a.memberId && 'basis' in c)),
    ).toBe(false);
    const sources = [...out.sources];
    const changes = structuredClone(out.changes);
    // Unrelated S1 coverage is synthetic here; S3's own coverage uses real transport.
    for (const c of changes)
      if (!('basis' in c)) {
        c.evidence.vulnerability = structuredClone(c.evidence.malware);
        for (const id of c.evidence.vulnerability.sourceIds) {
          const s = sources.find((s) => s.id === id)!;
          const copy = { ...s, id: 's1:' + id, kind: 'advisory' as const };
          sources.push(copy);
        }
        c.evidence.vulnerability.sourceIds = c.evidence.vulnerability.sourceIds.map(
          (id) => 's1:' + id,
        );
      }
    const packet = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes,
        sources,
        findings: out.findings,
        coverage: f.coverage,
        relationships: f.relationships,
      },
      f.expected,
    );
    expect(packet.ok, JSON.stringify(packet)).toBe(true);
    if (!packet.ok) throw new Error('packet');
    const units = formDecisionUnits(packet.packet);
    const policy = evaluateUnitPolicy(
      units,
      parseReviewConfig('{"version":1,"policy":{"verdicts":{"incompleteEvidence":"merge"}}}'),
      input.evaluationTime,
    );
    expect(policy.ok).toBe(true);
    if (policy.ok && mode === 'positive') expect(policy.defaultCeiling).toBe('do_not_merge');
    expect(
      out.findings
        .filter((f) => f.kind === 'malware')
        .every((f) => changes.find((c) => c.id === f.memberId)?.to),
    ).toBe(true);
    expect(
      await enrichPolicySignals(out.kind === 'enriched' ? { ...input, ...out } : input, {
        malwareReader: r,
      }),
    ).toMatchObject({ kind: 'enriched' });
  },
);
test('invalid input cannot trigger network and does not mutate caller data', async () => {
  let reads = 0;
  const reader = {
    read: async () => {
      reads++;
      throw new Error('unexpected');
    },
    close: () => {},
  };
  expect(await enrichPolicySignals({}, { malwareReader: reader })).toEqual({ kind: 'invalid' });
  const { input } = await fixture();
  expect(
    await enrichPolicySignals({ ...input, evaluationTime: NaN }, { malwareReader: reader }),
  ).toEqual({ kind: 'invalid' });
  expect(reads).toBe(0);
});
