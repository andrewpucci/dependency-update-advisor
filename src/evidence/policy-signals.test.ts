import { expect, test } from 'vite-plus/test';
import {
  enrichPolicySignals,
  runMemberMalware,
  type PolicySignalInput,
  type SignalEnrichment,
} from './policy-signals.js';
import { runOptionalSignals, SIGNAL_ATTEMPTS_PER_MEMBER } from './policy-signals-evidence.js';
import { resolveAdvisoryTarget } from './advisories.js';
import { createMalwareReader, type AdvisoryReader } from './advisory-read.js';
import { createUpstreamReader } from './upstream-read.js';
import { enrichUpstream } from './upstream.js';
import { upstreamScenario, upstreamTestLimits } from '../../tests/parity/upstream.js';
import { validateReviewPacket } from '../schema.js';
import { formDecisionUnits, evaluateUnitPolicy } from '../units.js';
import { parseReviewConfig } from '../config.js';
import { AdvisoryFailure } from './advisory-read.js';
import { createNpmRegistryReader } from './npm-registry.js';
import { viaAdvisoryHttp } from '../../tests/parity/advisory-http.js';
test.each(['severity', 'range'])(
  '%s disagreement cannot erase a verified active malware hold',
  async (conflict) => {
    const { f, input } = await fixture();
    const r = createMalwareReader(input.limits, {
      now: () => 0,
      fetch: viaAdvisoryHttp(async (url) => {
        const q = new URL(url),
          target = q.searchParams.get('affects')!,
          i = target.lastIndexOf('@');
        const record = {
          ghsa_id: 'GHSA-aaaa-bbbb-cccc',
          html_url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          summary: 'Active malware',
          type: 'malware',
          withdrawn_at: null,
          vulnerabilities: [
            {
              package: { ecosystem: q.searchParams.get('ecosystem'), name: target.slice(0, i) },
              vulnerable_version_range: '*',
            },
          ],
        };
        return Response.json([
          { ...record, severity: 'high' },
          {
            ...record,
            severity: conflict === 'severity' ? 'low' : 'high',
            vulnerabilities: record.vulnerabilities.map((v) => ({
              ...v,
              vulnerable_version_range: conflict === 'range' ? '>= 1.0.0' : '*',
            })),
          },
        ]);
      }),
    });
    if (r.kind !== 'ready') throw new Error('reader');
    const out = await enrichPolicySignals(input, { malwareReader: r });
    r.close();
    if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
    expect(out.findings.some((f) => f.kind === 'malware')).toBe(true);
    if (conflict === 'range')
      expect(
        out.findings
          .filter((f) => f.kind === 'malware')
          .every((f) => f.affectedRange === undefined),
      ).toBe(true);
    expect(out.changes.every((c) => c.evidence.malware.reasons.includes('conflict'))).toBe(true);
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
    if (!packet.ok) throw new Error('packet');
    const policy = evaluateUnitPolicy(
      formDecisionUnits(packet.packet),
      parseReviewConfig('{"version":1,"policy":{"verdicts":{"incompleteEvidence":"merge"}}}'),
      input.evaluationTime,
    );
    expect(policy.ok && policy.defaultCeiling).toBe('do_not_merge');
  },
);

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
      fetch: viaAdvisoryHttp(async (url) => {
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
      }),
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
        reachability: [],
        retryAfter: null,
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
test('optional attempt exhaustion keeps a bounded explained result and known deprecation findings', async () => {
  const { f, input } = await fixture();
  const malware = createMalwareReader(input.limits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  const npm = createNpmRegistryReader(upstreamTestLimits, {
    now: () => 0,
    fetch: async (url, init) => {
      const data = await (await f.fetch(url, init)).json();
      return Response.json({ ...data, deprecated: 'Maintained replacement required' });
    },
  });
  if (malware.kind !== 'ready' || npm.kind !== 'ready') throw new Error('reader');
  const out = await enrichPolicySignals(
    { ...input, npmInventory: f.input.npmInventory },
    { malwareReader: malware, npmReader: npm },
  );
  malware.close();
  expect(out.kind, JSON.stringify(out)).toBe('enriched');
  if (out.kind !== 'enriched') throw new Error('output');
  for (const c of input.changes.filter((c) => !('basis' in c)))
    expect(out.attempts.filter((a) => a.memberId === c.id).length).toBeLessThanOrEqual(
      SIGNAL_ATTEMPTS_PER_MEMBER,
    );
  expect(
    out.changes
      .filter((c) => !('basis' in c))
      .every((c) => c.evidence.malware.status === 'available'),
  ).toBe(true);
  expect(
    out.findings.some((f) => f.kind === 'releaseMetadata' && f.deprecated?.marker === 'deprecated'),
  ).toBe(true);
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
});
test('an optional adapter throwing a bounded failure cannot fail completed required checks', async () => {
  const { f, input } = await fixture();
  const malware = createMalwareReader(input.limits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (malware.kind !== 'ready') throw new Error('reader');
  const out = await enrichPolicySignals(
    { ...input, npmInventory: f.input.npmInventory },
    {
      malwareReader: malware,
      npmReader: {
        read: async () => {
          throw new AdvisoryFailure('budget');
        },
      },
    },
  );
  malware.close();
  expect(out.kind, JSON.stringify(out)).toBe('enriched');
  if (out.kind !== 'enriched') throw new Error('output');
  expect(
    out.changes
      .filter((c) => c.ecosystem === 'npm')
      .every(
        (c) =>
          c.evidence.malware.status === 'available' &&
          c.evidence.publisher.reasons.includes('budget'),
      ),
  ).toBe(true);
});
test('a removal explains proposed-only signals as unsupported, not budget exhaustion', async () => {
  const { input } = await fixture(true);
  const malware = createMalwareReader(input.limits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (malware.kind !== 'ready') throw new Error('reader');
  const out = await enrichPolicySignals(input, { malwareReader: malware });
  malware.close();
  if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
  const removals = out.changes.filter((c) => !('basis' in c) && c.from && !c.to);
  expect(removals.length).toBeGreaterThan(0);
  for (const c of removals) {
    expect(c.evidence.deprecation).toEqual({
      status: 'unavailable',
      reasons: ['unsupported'],
      sourceIds: [],
    });
    for (const category of ['publishTime', 'deprecation', 'trust', 'publisher', 'license'])
      expect(
        out.attempts.some((a) => a.memberId === c.id && a.category === category),
        category,
      ).toBe(true);
  }
  expect(out.attempts.some((a) => a.reasons.includes('budget'))).toBe(false);
});

function npmVictim(input: { changes: readonly ({ id: string; ecosystem: string } & object)[] }) {
  return input.changes.find((c) => c.ecosystem === 'npm' && !('basis' in c))!;
}
function nameOf(change: object): string {
  const instance = ('to' in change && change.to) || ('from' in change && change.from);
  return (instance as { name: string }).name;
}
test('a tight attempt setting never stops signals: attempts are bounded by structure', async () => {
  const { f, input } = await fixture(true);
  const run = async (maxAttempts: number) => {
    const malware = createMalwareReader(input.limits, {
      now: () => 0,
      fetch: async () => Response.json([]),
    });
    if (malware.kind !== 'ready') throw new Error('reader');
    const out = await enrichPolicySignals(
      { ...input, npmInventory: f.input.npmInventory, limits: { ...input.limits, maxAttempts } },
      { malwareReader: malware },
    );
    malware.close();
    if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
    return out;
  };
  const allowed = await run(2000);
  const tight = await run(1);
  expect(tight.changes.map((c) => c.evidence.malware)).toEqual(
    allowed.changes.map((c) => c.evidence.malware),
  );
  expect(
    tight.changes
      .filter((c) => !('basis' in c))
      .every((c) => c.evidence.malware.status === 'available'),
  ).toBe(true);
});
test('a member over its attempt allowance loses only its optional signals', async () => {
  const { f, input } = await fixture(true);
  const victim = npmVictim(input);
  const victimName = nameOf(victim);
  const base = createNpmRegistryReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  if (base.kind !== 'ready') throw new Error('reader');
  const run = async (throwForVictim: boolean) => {
    const malware = createMalwareReader(input.limits, {
      now: () => 0,
      fetch: async () => Response.json([]),
    });
    if (malware.kind !== 'ready') throw new Error('reader');
    const npmReader = {
      read: async (target: unknown) => {
        if (throwForVictim && JSON.stringify(target).includes(victimName))
          throw new AdvisoryFailure('budget');
        return base.read(target);
      },
    };
    const out = await enrichPolicySignals(
      { ...input, npmInventory: f.input.npmInventory },
      { malwareReader: malware, npmReader },
    );
    malware.close();
    if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
    return out;
  };
  const allSuccess = await run(false);
  const overAllowance = await run(true);
  const others = (changes: typeof allSuccess.changes) => changes.filter((c) => c.id !== victim.id);
  expect(others(overAllowance.changes)).toEqual(others(allSuccess.changes));
  const lost = overAllowance.changes.find((c) => c.id === victim.id)!;
  const before = allSuccess.changes.find((c) => c.id === victim.id)!;
  expect(lost.evidence.malware).toEqual(before.evidence.malware);
  for (const category of ['publishTime', 'deprecation', 'trust', 'publisher'] as const)
    expect(lost.evidence[category], category).toEqual({
      status: 'unavailable',
      reasons: ['budget'],
      sourceIds: [],
    });
  expect(overAllowance.attempts.filter((a) => a.memberId !== victim.id)).toEqual(
    allSuccess.attempts.filter((a) => a.memberId !== victim.id),
  );
});
test('a member whose malware read throws keeps the stage enriched', async () => {
  const { input } = await fixture(true);
  const members = input.changes.filter((c) => !('basis' in c));
  const victim = members[0];
  const victimTarget = JSON.stringify(
    resolveAdvisoryTarget(input, victim, victim.to ? 'head' : 'base'),
  );
  const real = createMalwareReader(input.limits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (real.kind !== 'ready') throw new Error('reader');
  const flaky: AdvisoryReader = {
    read: async (target) => {
      if (JSON.stringify(target) === victimTarget) throw new AdvisoryFailure('malformed');
      return real.read(target);
    },
    close: () => real.close(),
  };
  const out = await enrichPolicySignals(input, { malwareReader: flaky });
  flaky.close();
  if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
  expect(out.changes.find((c) => c.id === victim.id)!.evidence.malware).toMatchObject({
    status: 'unavailable',
    reasons: ['malformed'],
  });
  expect(
    out.attempts.some(
      (a) => a.memberId === victim.id && a.category === 'malware' && a.outcome === 'unavailable',
    ),
  ).toBe(true);
  for (const c of members.filter((c) => c.id !== victim.id))
    expect(out.changes.find((o) => o.id === c.id)!.evidence.malware.status).toBe('available');
});
test('optional discoveries that cross the packet byte limit are dropped for that member only', async () => {
  const { f, input } = await fixture(true);
  const victim = npmVictim(input);
  const victimName = nameOf(victim);
  const run = async (mode: 'deprecated' | 'failing') => {
    const registry = createNpmRegistryReader(upstreamTestLimits, {
      now: () => 0,
      fetch: async (url, init) => {
        const data = await (await f.fetch(url, init)).json();
        const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
        return Response.json(
          name === victimName ? { ...data, deprecated: 'Maintained replacement required' } : data,
        );
      },
    });
    const malware = createMalwareReader(input.limits, {
      now: () => 0,
      fetch: async () => Response.json([]),
    });
    if (registry.kind !== 'ready' || malware.kind !== 'ready') throw new Error('reader');
    const npmReader = {
      read: async (target: unknown) => {
        if (mode === 'failing' && JSON.stringify(target).includes(victimName))
          throw new AdvisoryFailure('budget');
        return registry.read(target);
      },
    };
    const out = await enrichPolicySignals(
      { ...input, npmInventory: f.input.npmInventory },
      { malwareReader: malware, npmReader },
    );
    malware.close();
    if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
    return out;
  };
  const finding = (await run('deprecated')).findings.find(
    (x) => x.kind === 'releaseMetadata' && x.memberId === victim.id,
  )!;
  expect(finding).toBeDefined();
  // Start from the state where the victim's optional reads failed, then let its collector
  // discover the finding under a limit that admits that state but not the finding.
  const baseline = await run('failing');
  const output = structuredClone(baseline) as SignalEnrichment;
  const maxRetainedBytes =
    Buffer.byteLength(JSON.stringify(output)) +
    Math.floor(Buffer.byteLength(JSON.stringify(finding)) / 2);
  const change = output.changes.find((c) => c.id === victim.id)!;
  await runOptionalSignals(
    { ...input, limits: { ...input.limits, maxRetainedBytes } } as PolicySignalInput,
    output,
    change,
    async () => {
      output.findings.push(structuredClone(finding));
    },
  );
  expect(
    output.findings.some((x) => x.kind === 'releaseMetadata' && x.memberId === victim.id),
  ).toBe(false);
  for (const category of ['publishTime', 'deprecation', 'trust', 'publisher'] as const)
    expect(change.evidence[category], category).toEqual({
      status: 'unavailable',
      reasons: ['budget'],
      sourceIds: [],
    });
  expect(output.changes.filter((c) => c.id !== victim.id)).toEqual(
    baseline.changes.filter((c) => c.id !== victim.id),
  );
});

test("a member's malware additions that cross the packet byte limit are rolled back alone", async () => {
  const { input } = await fixture(true);
  const empty = createMalwareReader(input.limits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (empty.kind !== 'ready') throw new Error('reader');
  const baseline = await enrichPolicySignals(input, { malwareReader: empty });
  empty.close();
  if (baseline.kind !== 'enriched') throw new Error(JSON.stringify(baseline));
  const victim = npmVictim(input);
  const positive: AdvisoryReader = {
    read: async (target) => {
      const t = target as { ecosystem: string; name: string; version: string };
      const reader = createMalwareReader(input.limits, {
        now: () => 0,
        fetch: async () =>
          Response.json([
            {
              ghsa_id: 'GHSA-aaaa-bbbb-cccc',
              html_url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
              summary: 'Synthetic malware',
              type: 'malware',
              severity: 'unknown',
              withdrawn_at: null,
              vulnerabilities: [
                {
                  package: { ecosystem: t.ecosystem, name: t.name },
                  vulnerable_version_range: '*',
                },
              ],
            },
          ]),
      });
      if (reader.kind !== 'ready') throw new Error('reader');
      return reader.read(target);
    },
    close: () => {},
  };
  const failing: AdvisoryReader = {
    read: async () => {
      throw new AdvisoryFailure('budget');
    },
    close: () => {},
  };
  const start = () => {
    const output = structuredClone(baseline) as SignalEnrichment;
    return { output, change: output.changes.find((c) => c.id === victim.id)! };
  };
  // The size a failed check leaves, plus less than one malware record and its finding.
  const failed = start();
  await runMemberMalware(input, failed.output, failed.change, failing, new Map());
  const limits = {
    ...input.limits,
    maxRetainedBytes: Buffer.byteLength(JSON.stringify(failed.output)) + 50,
  };
  const { output, change } = start();
  await runMemberMalware({ ...input, limits }, output, change, positive, new Map());
  expect(change.evidence.malware).toMatchObject({ status: 'unavailable', reasons: ['budget'] });
  expect(output.findings.some((f) => f.memberId === victim.id && f.kind === 'malware')).toBe(false);
  expect(output.sources.length).toBe(failed.output.sources.length);
  expect(output.changes.filter((c) => c.id !== victim.id)).toEqual(
    baseline.changes.filter((c) => c.id !== victim.id),
  );
});

test('a released member returns to exactly its pre-member size', async () => {
  const { f, input } = await fixture(true);
  const victim = npmVictim(input);
  const victimName = nameOf(victim);
  const registry = createNpmRegistryReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  const malware = createMalwareReader(input.limits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (registry.kind !== 'ready' || malware.kind !== 'ready') throw new Error('reader');
  const baseline = await enrichPolicySignals(
    { ...input, npmInventory: f.input.npmInventory },
    {
      malwareReader: malware,
      npmReader: {
        read: async (target: unknown) => {
          if (JSON.stringify(target).includes(victimName)) throw new AdvisoryFailure('budget');
          return registry.read(target);
        },
      },
    },
  );
  malware.close();
  if (baseline.kind !== 'enriched') throw new Error(JSON.stringify(baseline));
  // The state just before the victim runs: its optional categories hold the budget placeholders.
  const output = structuredClone(baseline) as SignalEnrichment;
  const change = output.changes.find((c) => c.id === victim.id)!;
  for (const a of output.attempts)
    if (a.memberId === victim.id && a.category !== 'malware')
      Object.assign(a, {
        url: null,
        outcome: 'skipped',
        reasons: ['budget'],
        sourceIds: [],
        truncated: false,
      });
  const limit = Buffer.byteLength(JSON.stringify(output));
  const finding = structuredClone(baseline.findings[0]);
  await runOptionalSignals(
    { ...input, limits: { ...input.limits, maxRetainedBytes: limit } } as PolicySignalInput,
    output,
    change,
    async () => {
      // A real read leaves a URL on the attempt; a discovery then crosses the limit.
      output.attempts.push({
        memberId: victim.id,
        side: change.to ? 'head' : 'base',
        category: 'deprecation',
        url: 'https://registry.npmjs.org/' + victimName,
        outcome: 'unavailable',
        reasons: ['unknown'],
        sourceIds: [],
        truncated: false,
      });
      output.findings.push({ ...finding, id: finding.id + ':discovery' });
    },
  );
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(limit);
  expect(
    output.attempts.filter((a) => a.memberId === victim.id && a.category !== 'malware'),
  ).toEqual(
    ['publishTime', 'deprecation', 'trust', 'publisher', 'license'].map((category) =>
      expect.objectContaining({ category, url: null, outcome: 'skipped', reasons: ['budget'] }),
    ),
  );
});
