import { expect, test, vi } from 'vite-plus/test';
import { upstreamScenario } from '../tests/parity/upstream.js';
import { researchOrder, runResearch } from './research.js';
import { researchPacketBytes } from './revalidation.js';
import { limit } from './limits.js';
import { PACKET_LIMITS, validateReviewPacket, type PacketSource } from './schema.js';
import type { SignalEnrichment } from './evidence/policy-signals.js';

// The read budget at ten times the register, as a demand measurement runs it (see
// `scaledDefinitions`), so no request share or attempt cap stops research and the packet byte
// limit is what binds. The retained-byte cap keeps its register value: diagnostics count only
// toward it, and this run stays within it.
vi.mock('./limits.js', async (original) => {
  const actual = await original<typeof import('./limits.js')>();
  const { scaledDefinitions } = await import('./measurement/scale.js');
  const definitions = scaledDefinitions(actual.REGISTER, 10).map((entry) =>
    entry.id === 'research.maxRetainedBytes'
      ? { ...entry, value: actual.limit('research.maxRetainedBytes') }
      : entry,
  );
  const register = actual.buildRegister(definitions);
  const limitEntry = (id: string) => {
    const entry = register.get(id);
    if (entry === undefined) throw new Error(`unknown limit id: ${id}`);
    return entry;
  };
  return { ...actual, REGISTER: register, limitEntry, limit: (id: string) => limitEntry(id).value };
});

const signals = vi.hoisted(() => ({ output: null as unknown }));
vi.mock('./evidence/policy-signals.js', async (original) => {
  const actual = await original<typeof import('./evidence/policy-signals.js')>();
  return {
    ...actual,
    enrichPolicySignals: async (...args: Parameters<typeof actual.enrichPolicySignals>) =>
      (signals.output = await actual.enrichPolicySignals(...args)),
  };
});

// When `loose`, stages get the whole packet limit as their bound, as before fix 1, so signals
// fills the limit with its own lists and the assembled packet overflows at revalidation.
const bound = vi.hoisted(() => ({ loose: false }));
vi.mock('./revalidation.js', async (original) => {
  const actual = await original<typeof import('./revalidation.js')>();
  const { PACKET_LIMITS } = await import('./schema.js');
  return {
    ...actual,
    researchPacketBytes: (packet: Parameters<typeof actual.researchPacketBytes>[0]) =>
      bound.loose ? PACKET_LIMITS.bytes : actual.researchPacketBytes(packet),
  };
});

/** Every source a signal attempt cites is in the packet and belongs to the attempt's member. */
function expectAttemptsCited(result: {
  packet: { sources: readonly { id: string; memberIds: readonly string[] }[] };
  signalAttempts: readonly { memberId: string; category: string; sourceIds: readonly string[] }[];
}) {
  for (const attempt of result.signalAttempts)
    for (const id of attempt.sourceIds)
      expect(
        result.packet.sources.some((s) => s.id === id && s.memberIds.includes(attempt.memberId)),
        `${attempt.memberId} ${attempt.category} ${id}`,
      ).toBe(true);
}

vi.setConfig({ testTimeout: limit('tests.largeInventoryRenderTimeoutMs') });

const OPTIONAL = ['publishTime', 'deprecation', 'trust', 'publisher'] as const;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const packetPart = ({ changes, sources, findings }: Omit<SignalEnrichment, 'attempts'>) =>
  bytes({ changes, sources, findings });

async function research110() {
  const fixture = await upstreamScenario({ children: 110 });
  const collected = validateReviewPacket(
    {
      version: 1,
      ...fixture.expected,
      changes: fixture.input.changes,
      sources: fixture.input.sources,
      findings: fixture.input.findings,
      coverage: fixture.coverage,
      relationships: fixture.relationships,
      reachability: [],
      retryAfter: null,
    },
    fixture.expected,
  );
  if (!collected.ok) throw new Error(JSON.stringify(collected));
  const packet = collected.packet;
  const result = await runResearch({
    packet,
    trusted: fixture.expected,
    npmInventory: fixture.npm,
    comparison: null,
    fetch: fixture.fetch as (url: string, init: RequestInit) => Promise<Response>,
    now: () => 0,
    deadline: 240_000,
    evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
  });
  if (result.kind !== 'ready') throw new Error('research');
  return { fixture, packet, result };
}

// 110 children is the smallest count of this fixture at which, before the research byte bound,
// signals filled the packet limit with its own lists and revalidation reverted members to budget.
test('research on 110 children passes revalidation with every required check and cuts only optional signals', async () => {
  const { fixture, packet, result } = await research110();
  // Mutation "drop the non-change part from the bound": revalidation reverts members to budget.
  expect(result.unavailable).toEqual([]);
  expectAttemptsCited(result);
  const members = researchOrder(result.packet.changes, fixture.npm).filter((c) => !('basis' in c));
  expect(members).toHaveLength(113);
  for (const member of members)
    for (const category of ['upstream', 'vulnerability', 'malware'] as const)
      expect(member.evidence[category].status, `${member.id} ${category}`).toBe('available');

  // The packet holds exactly what signals kept, within the bound that leaves room for the rest of
  // the packet, which here includes 18 bytes reserved for a retry time research did not record.
  const output = signals.output as SignalEnrichment;
  const bound = researchPacketBytes(packet);
  expect(packetPart(output)).toBeLessThanOrEqual(bound);
  expect(result.packet.retryAfter).toBeNull();
  expect(bytes(result.packet)).toBe(
    packetPart(output) +
      PACKET_LIMITS.bytes -
      bound -
      (bytes('1970-01-01T00:00:00Z') - bytes(null)),
  );
  expect(bytes(result.packet)).toBeLessThanOrEqual(PACKET_LIMITS.bytes);

  // Optional signals are cut in research order, and only for want of room: the space left is
  // smaller than what any member that kept its optional signals took for them.
  const cut = members.filter((m) =>
    OPTIONAL.some((c) => m.evidence[c]?.reasons.includes('budget')),
  );
  expect(cut.length).toBeGreaterThan(0);
  expect(cut.length).toBeLessThan(members.length);
  expect(members.slice(members.length - cut.length)).toEqual(cut);
  for (const member of cut)
    for (const category of OPTIONAL) expect(member.evidence[category]?.reasons).toEqual(['budget']);
  expect(output.sources.length).toBeLessThan(PACKET_LIMITS.sources);
  const optionalBytes = (id: string) => {
    const own = (output.sources as PacketSource[]).filter(
      (s) => s.id.startsWith('signal:') && s.kind !== 'malware' && s.memberIds.includes(id),
    );
    return own.reduce((total, source) => total + bytes(source) + 1, 0);
  };
  const kept = members.slice(0, members.length - cut.length).map((m) => optionalBytes(m.id));
  expect(Math.min(...kept)).toBeGreaterThan(bound - packetPart(output));
});

test('when the assembled packet still overflows, revalidation strips optional signals, not required research', async () => {
  bound.loose = true;
  try {
    const { fixture, result } = await research110();
    // Fix 1 alone would revert members' required research here; the strip keeps all of it.
    expect(result.unavailable).toEqual([{ stage: 'revalidation', reason: 'budget' }]);
    // Mutation "keep the attempts research recorded": stripped members' attempts cite sources
    // that left the packet.
    expectAttemptsCited(result);
    const members = researchOrder(result.packet.changes, fixture.npm).filter(
      (c) => !('basis' in c),
    );
    expect(members).toHaveLength(113);
    for (const member of members)
      for (const category of ['upstream', 'vulnerability', 'malware'] as const)
        expect(member.evidence[category].status, `${member.id} ${category}`).toBe('available');
    expect(bytes(result.packet)).toBeLessThanOrEqual(PACKET_LIMITS.bytes);
    // Revalidation stripped members whose optional signals the stage had kept, and the members
    // without optional signals are the lowest-priority suffix.
    const output = signals.output as SignalEnrichment;
    const budgeted = (
      evidence: Readonly<Record<string, { reasons: readonly string[] } | undefined>>,
    ) => OPTIONAL.every((c) => !evidence[c] || evidence[c]!.reasons.includes('budget'));
    const stageCut = new Set(
      output.changes.filter((c) => !('basis' in c) && budgeted(c.evidence)).map((c) => c.id),
    );
    const cut = members.filter((m) => budgeted(m.evidence));
    expect(cut.some((m) => !stageCut.has(m.id))).toBe(true);
    expect(cut.length).toBeLessThan(members.length);
    expect(members.slice(members.length - cut.length)).toEqual(cut);
  } finally {
    bound.loose = false;
  }
});
