import { expect, test, vi } from 'vite-plus/test';
import { enrichPolicySignals, runMemberMalware, type SignalEnrichment } from './policy-signals.js';
import { reserveSignals } from './policy-signals-evidence.js';
import { createMalwareReader } from './advisory-read.js';
import { createUpstreamReader } from './upstream-read.js';
import { enrichUpstream } from './upstream.js';
import { researchOrder } from '../research.js';
import { upstreamScenario, upstreamTestLimits } from '../../tests/parity/upstream.js';
import type { PacketChange } from '../schema.js';

// The packet byte limit is lowered per test so a small fixture's signals overflow it.
const cap = vi.hoisted(() => ({ bytes: Infinity }));
vi.mock('../schema.js', async (original) => {
  const actual = await original<typeof import('../schema.js')>();
  const limits = { ...actual.PACKET_LIMITS };
  Object.defineProperty(limits, 'bytes', {
    get: () => Math.min(cap.bytes, actual.PACKET_LIMITS.bytes),
  });
  return { ...actual, PACKET_LIMITS: limits };
});

const packetBytes = ({ changes, sources, findings }: SignalEnrichment) =>
  Buffer.byteLength(JSON.stringify({ changes, sources, findings }));

async function signalInput() {
  const f = await upstreamScenario({ extras: true, declaration: true });
  const r = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  if (r.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(f.input, r);
  r.reader.close();
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  return {
    ...upstream,
    // Research hands signals its members in priority order (coverage §3.5).
    changes: researchOrder(
      upstream.changes as PacketChange[],
      (f.input.npmInventory ?? null) as Parameters<typeof researchOrder>[1],
    ),
    npmInventory: f.input.npmInventory,
    limits: { ...f.advisoryLimits, maxAttempts: 2000 },
    evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
  };
}
const emptyMalware = (limits: Parameters<typeof createMalwareReader>[0]) => {
  const reader = createMalwareReader(limits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  return reader;
};

test('signals over the packet byte limit keep priority members’ malware and budget the rest', async () => {
  const input = await signalInput();
  const members = input.changes.filter((c) => !('basis' in c));
  expect(members.length).toBeGreaterThan(2);
  // Sizes with every member reserved, then with every member's malware checked.
  const output = structuredClone({
    kind: 'enriched' as const,
    binding: input.binding,
    changes: input.changes,
    sources: input.sources,
    findings: input.findings,
    attempts: [],
  }) as SignalEnrichment;
  reserveSignals(input, output);
  const reserved = packetBytes(output);
  const reader = emptyMalware(input.limits);
  for (const change of output.changes)
    if (!('basis' in change)) await runMemberMalware(input, output, change, reader, new Map());
  const checked = packetBytes(output);
  expect(checked).toBeGreaterThan(reserved);

  // Room for about half the members' malware results.
  cap.bytes = Math.floor((reserved + checked) / 2);
  try {
    const result = await enrichPolicySignals(input, { malwareReader: reader });
    // Mutation "fail the stage when the output overflows": the stage would be unavailable.
    if (result.kind !== 'enriched') throw new Error(JSON.stringify(result));
    expect(packetBytes(result)).toBeLessThanOrEqual(cap.bytes);
    const states = result.changes
      .filter((c) => !('basis' in c))
      .map((c) => ({ id: c.id, malware: c.evidence.malware }));
    const kept = states.filter((s) => s.malware.status === 'available');
    const budgeted = states.filter((s) => s.malware.reasons.includes('budget'));
    expect(kept.length).toBeGreaterThan(0);
    expect(budgeted.length).toBeGreaterThan(0);
    expect(kept.length + budgeted.length).toBe(states.length);
    // The highest-priority member is kept and the lowest-priority one is not.
    expect(states[0].malware.status).toBe('available');
    expect(states.at(-1)!.malware).toEqual({
      status: 'unavailable',
      reasons: ['budget'],
      sourceIds: [],
    });
    // Each member left at budget carries its reservation, not a stage failure.
    for (const { id } of budgeted)
      expect(result.attempts.filter((a) => a.memberId === id && a.category === 'malware')).toEqual([
        expect.objectContaining({ outcome: 'skipped', reasons: ['budget'], url: null }),
      ]);
  } finally {
    cap.bytes = Infinity;
    reader.close();
  }
});

test('attempts count toward retained bytes, not the packet byte limit', async () => {
  const input = await signalInput();
  const reader = emptyMalware(input.limits);
  try {
    const full = await enrichPolicySignals(input, { malwareReader: reader });
    if (full.kind !== 'enriched') throw new Error(JSON.stringify(full));
    // A packet limit the packet's own content fits, but not with the diagnostics attempts added.
    cap.bytes = packetBytes(full);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(cap.bytes);
    const result = await enrichPolicySignals(input, { malwareReader: reader });
    if (result.kind !== 'enriched') throw new Error(JSON.stringify(result));
    expect(result.changes).toEqual(full.changes);
  } finally {
    cap.bytes = Infinity;
    reader.close();
  }
});

/** Malware records for every query that lists package `name`, and none for any other query. */
const malwareFor = (
  limits: Parameters<typeof createMalwareReader>[0],
  name: string,
  { records = 3, summaryBytes = 200 } = {},
) => {
  const reader = createMalwareReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      const affects = new URL(url).searchParams.get('affects') ?? '';
      const ecosystem = new URL(url).searchParams.get('ecosystem');
      // A batch returns the records of any target it lists, as GitHub does.
      if (!affects.split(',').some((a) => a.startsWith(name + '@'))) return Response.json([]);
      return Response.json(
        ['aaaa-bbbb-cccc', 'dddd-eeee-ffff', 'gggg-hhhh-jjjj', ...'kmnpqrstuvwx']
          .slice(0, records)
          .map((id) => 'GHSA-' + (id.length > 1 ? id : id.repeat(4) + '-bbbb-cccc'))
          .map((id) => ({
            ghsa_id: id,
            html_url: 'https://github.com/advisories/' + id,
            summary: 'Synthetic malware ' + 'x'.repeat(summaryBytes),
            type: 'malware',
            severity: 'unknown',
            withdrawn_at: null,
            vulnerabilities: [{ package: { ecosystem, name }, vulnerable_version_range: '*' }],
          })),
      );
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  return reader;
};

test('the cut is strict: no member after the first that overflows keeps malware, even a smaller one', async () => {
  const input = await signalInput();
  const members = input.changes.filter((c) => !('basis' in c));
  const nameOf = (c: PacketChange) => ((c.to ?? c.from) as { name: string }).name;
  // The large member is an npm package no other member shares, after the top-priority member and
  // before smaller ones.
  const index = members.findIndex(
    (c, i) =>
      i > 0 &&
      i < members.length - 1 &&
      c.ecosystem === 'npm' &&
      members.filter((m) => nameOf(m) === nameOf(c)).length === 1,
  );
  expect(index).toBeGreaterThan(0);
  const name = nameOf(members[index]);
  const reader = malwareFor(input.limits, name);
  // Packet bytes after each member's check, with no limit in the way.
  const output = structuredClone({
    kind: 'enriched' as const,
    binding: input.binding,
    changes: input.changes,
    sources: input.sources,
    findings: input.findings,
    attempts: [],
  }) as SignalEnrichment;
  reserveSignals(input, output);
  const after: number[] = [];
  for (const change of output.changes)
    if (!('basis' in change)) {
      await runMemberMalware(input, output, change, reader, new Map());
      after.push(packetBytes(output));
    }
  const growth = after.map((bytes, i) => bytes - (i ? after[i - 1] : after[0]));
  const room = Math.floor(growth[index] / 2);
  // A later member would fit in the room the large one leaves, so keep-what-fits would keep it.
  expect(growth.slice(index + 1).some((g) => g <= room)).toBe(true);

  cap.bytes = after[index - 1] + room;
  try {
    const result = await enrichPolicySignals(input, { malwareReader: reader });
    if (result.kind !== 'enriched') throw new Error(JSON.stringify(result));
    const states = result.changes
      .filter((c) => !('basis' in c))
      .map((c) => c.evidence.malware.status);
    expect(states.slice(0, index).every((s) => s === 'available')).toBe(true);
    expect(states.slice(index).every((s) => s === 'unavailable')).toBe(true);
    for (const change of result.changes.filter((c) => !('basis' in c)).slice(index))
      expect(change.evidence.malware).toEqual({
        status: 'unavailable',
        reasons: ['budget'],
        sourceIds: [],
      });
    // A malware finding for the large member never survives the cut.
    expect(result.findings.some((f) => f.kind === 'malware')).toBe(false);
  } finally {
    cap.bytes = Infinity;
    reader.close();
  }
});

test('the malware cut leaves optional signals to their own pass, below the cut too', async () => {
  const input = await signalInput();
  const members = input.changes.filter((c) => !('basis' in c));
  const nameOf = (c: PacketChange) => ((c.to ?? c.from) as { name: string }).name;
  // A large npm member no other member shares, with members of lower priority after it.
  const index = members.findIndex(
    (c, i) =>
      i > 0 &&
      i < members.length - 1 &&
      c.ecosystem === 'npm' &&
      members.filter((m) => nameOf(m) === nameOf(c)).length === 1,
  );
  expect(index).toBeGreaterThan(0);
  const empty = emptyMalware(input.limits);
  const reader = malwareFor(input.limits, nameOf(members[index]), {
    records: 12,
    summaryBytes: 1000,
  });
  try {
    // Every member's malware and optional signals, with no malware records anywhere.
    const baseline = await enrichPolicySignals(input, { malwareReader: empty });
    if (baseline.kind !== 'enriched') throw new Error(JSON.stringify(baseline));
    // Room for that, so only the large member's malware records cross the limit. Members below it
    // keep a reservation no larger than their checked malware, so their optional signals fit.
    cap.bytes = packetBytes(baseline);
    const result = await enrichPolicySignals(input, { malwareReader: reader });
    if (result.kind !== 'enriched') throw new Error(JSON.stringify(result));
    const checked = result.changes.filter((c) => !('basis' in c));
    expect(checked.slice(index).map((c) => c.evidence.malware)).toEqual(
      checked
        .slice(index)
        .map(() => ({ status: 'unavailable', reasons: ['budget'], sourceIds: [] })),
    );
    const optional = (c: PacketChange) => {
      const { publishTime, deprecation, trust, publisher, license } = c.evidence;
      return { publishTime, deprecation, trust, publisher, license };
    };
    const expected = baseline.changes.filter((c) => !('basis' in c)).map(optional);
    // Mutation "the malware cut ends the optional pass too": members from the cut stay at budget.
    expect(checked.map(optional)).toEqual(expected);
    expect(expected.slice(index).some((e) => !e.trust?.reasons.includes('budget'))).toBe(true);
  } finally {
    cap.bytes = Infinity;
    empty.close();
    reader.close();
  }
});

test('a record a batch attributes to a member below the cut leaves it at budget, with no finding', async () => {
  const input = await signalInput();
  const members = input.changes.filter((c) => !('basis' in c));
  const nameOf = (c: PacketChange) => ((c.to ?? c.from) as { name: string }).name;
  // A proposed npm member with a name no other member shares, and a large npm member above it
  // that is not the top-priority member, so the cut falls between them.
  const below = members.findLast(
    (c) =>
      c.ecosystem === 'npm' && c.to && members.filter((m) => nameOf(m) === nameOf(c)).length === 1,
  );
  if (!below) throw new Error('fixture');
  const index = members.findIndex(
    (c, i) => i > 0 && i < members.indexOf(below) && c.ecosystem === 'npm',
  );
  expect(index).toBeGreaterThan(0);
  const large = nameOf(members[index]);
  const requests: URL[] = [];
  const reader = createMalwareReader(input.limits, {
    now: () => 0,
    fetch: async (url) => {
      const u = new URL(url);
      requests.push(u);
      const ecosystem = u.searchParams.get('ecosystem');
      const listed = (u.searchParams.get('affects') ?? '').split(',');
      // npm only: the large member's name may also be another ecosystem's package.
      const has = (name: string) =>
        ecosystem === 'npm' && listed.some((a) => a.startsWith(name + '@'));
      const advisory = (id: string, name: string, summaryBytes: number) => ({
        ghsa_id: id,
        html_url: 'https://github.com/advisories/' + id,
        summary: 'Synthetic malware ' + 'x'.repeat(summaryBytes),
        type: 'malware',
        severity: 'unknown',
        withdrawn_at: null,
        vulnerabilities: [{ package: { ecosystem, name }, vulnerable_version_range: '*' }],
      });
      return Response.json([
        ...(has(large)
          ? [...'kmnpqrstuvwx'].map((c) => advisory(`GHSA-${c.repeat(4)}-bbbb-cccc`, large, 1000))
          : []),
        ...(has(nameOf(below)) ? [advisory('GHSA-aaaa-bbbb-cccc', nameOf(below), 10)] : []),
      ]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const empty = emptyMalware(input.limits);
  try {
    const baseline = await enrichPolicySignals(input, { malwareReader: empty });
    if (baseline.kind !== 'enriched') throw new Error(JSON.stringify(baseline));
    // Room for every member's empty result, so the large member's records cross the limit.
    cap.bytes = packetBytes(baseline);
    const result = await enrichPolicySignals(input, { malwareReader: reader });
    if (result.kind !== 'enriched') throw new Error(JSON.stringify(result));
    // The batch settled every npm member: no npm singleton query was sent, only batches.
    expect(
      requests.some(
        (u) =>
          u.searchParams.get('ecosystem') === 'npm' &&
          u.searchParams.get('affects')!.split(',').length === 1,
      ),
    ).toBe(false);
    expect(result.changes.find((c) => c.id === below.id)!.evidence.malware).toEqual({
      status: 'unavailable',
      reasons: ['budget'],
      sourceIds: [],
    });
    expect(result.findings.some((f) => f.kind === 'malware')).toBe(false);
  } finally {
    cap.bytes = Infinity;
    empty.close();
    reader.close();
  }
});
