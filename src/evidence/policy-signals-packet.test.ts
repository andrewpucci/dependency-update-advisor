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
