import { afterEach, expect, test, vi } from 'vite-plus/test';
import { upstreamScenario } from '../tests/parity/upstream.js';
import { runResearch } from './research.js';
import { reconcilePacket, researchPacketBytes } from './revalidation.js';
import { limit } from './limits.js';
import type { PacketResult } from './schema.js';

type Fixture = Awaited<ReturnType<typeof upstreamScenario>>;
type Packet = Extract<PacketResult, { ok: true }>['packet'];
type AnyChange = {
  id: string;
  basis?: unknown;
  evidence: Record<string, { status: string; reasons: string[]; sourceIds: string[] }>;
};

const RESEARCH = ['upstream', 'installScript', 'vulnerability', 'malware'] as const;
const MALFORMED = { status: 'unavailable', reasons: ['malformed'], sourceIds: [] };
const BUDGET = { status: 'unavailable', reasons: ['budget'], sourceIds: [] };
const evaluationTime = Date.parse('2026-11-07T00:00:00Z');
const PLACEHOLDER = JSON.stringify({ status: 'unavailable', reasons: ['missing'], sourceIds: [] });

/** A reverted change keeps its collected facts; only research placeholders take the marker. */
function reverted(collected: Packet, id: string, key: string, marker: object) {
  const before = (collected.changes.find((change) => change.id === id) as AnyChange | undefined)
    ?.evidence[key];
  return JSON.stringify(before) === PLACEHOLDER ? marker : before;
}

/** When set, a candidate it rejects fails validation with the returned result instead. */
let rejects: ((candidate: unknown) => PacketResult | null) | null = null;

vi.mock('./schema.js', async (original) => {
  const actual = await original<typeof import('./schema.js')>();
  return {
    ...actual,
    validateReviewPacket: vi.fn((candidate: unknown, trusted: unknown) => {
      const rejected = rejects?.(candidate);
      return rejected ?? actual.validateReviewPacket(candidate, trusted);
    }),
  };
});

afterEach(() => {
  rejects = null;
});

async function scenario(options: Parameters<typeof upstreamScenario>[0] = {}) {
  const fixture = await upstreamScenario(options);
  const candidate = {
    version: 1,
    ...fixture.expected,
    changes: fixture.input.changes,
    sources: fixture.input.sources,
    findings: fixture.input.findings,
    coverage: fixture.coverage,
    relationships: fixture.relationships,
    reachability: [],
    retryAfter: null,
  };
  const { validateReviewPacket } =
    await vi.importActual<typeof import('./schema.js')>('./schema.js');
  const validated = validateReviewPacket(candidate, fixture.expected);
  if (!validated.ok) throw new Error(`fixture packet: ${JSON.stringify(validated)}`);
  return { fixture, packet: validated.packet };
}

function base(fixture: Fixture, packet: Packet) {
  return {
    packet,
    trusted: fixture.expected,
    npmInventory: fixture.npm,
    comparison: null,
    fetch: fixture.fetch as (url: string, init: RequestInit) => Promise<Response>,
    now: () => 0,
    deadline: 240_000,
    evaluationTime,
  };
}

/**
 * Counts members that carry enrichment: a non-basis change that differs from its collected version and
 * has a research category beyond unavailable. Reverted members are unavailable, so they do not count.
 */
function enrichedMembers(candidate: unknown, collected: Packet): number {
  const { changes } = candidate as {
    changes: { id: string; basis?: unknown; evidence: Record<string, { status: string }> }[];
  };
  const before = new Map(collected.changes.map((change) => [change.id, change]));
  // A member is enriched when research gave one of its categories evidence it did not have.
  return changes.filter((change) => {
    const collectedEvidence = before.get(change.id)?.evidence as
      | Record<string, unknown>
      | undefined;
    return (
      !('basis' in change) &&
      RESEARCH.some(
        (key) =>
          ['available', 'partial'].includes(change.evidence[key]?.status ?? '') &&
          JSON.stringify(change.evidence[key]) !== JSON.stringify(collectedEvidence?.[key]),
      )
    );
  }).length;
}

/** Runs real research once and returns its enriched packet, which is fully valid. */
async function enrichedResult() {
  const { fixture, packet } = await scenario({ vulnerableNpm: true });
  const result = await runResearch(base(fixture, packet));
  if (result.kind !== 'ready') throw new Error('research');
  const members = packet.changes
    .filter((change) => !('basis' in change))
    .map((change) => change.id);
  return { fixture, packet, enriched: result.packet, members };
}

function enrichedInput(enriched: Packet) {
  return { changes: enriched.changes, sources: enriched.sources, findings: enriched.findings };
}

test('keeps every member when the enriched packet validates', async () => {
  const { fixture, packet, enriched, members } = await enrichedResult();
  const result = reconcilePacket({
    collected: packet,
    enriched: enrichedInput(enriched),
    trusted: fixture.expected,
    priority: members,
  });
  expect(result.reasons).toEqual([]);
  expect(result.whole).toBe(false);
  expect(result.packet).toEqual(enriched);
});

test('reverts only the member whose enrichment is invalid', async () => {
  const { fixture, packet, enriched, members } = await enrichedResult();
  const badId = members[0];
  const changes = enriched.changes.map((change) =>
    change.id === badId
      ? {
          ...change,
          evidence: {
            ...change.evidence,
            vulnerability: { status: 'available', reasons: [], sourceIds: ['no-such-source'] },
          },
        }
      : change,
  );
  const result = reconcilePacket({
    collected: packet,
    enriched: { ...enrichedInput(enriched), changes },
    trusted: fixture.expected,
    priority: members,
  });
  expect(result.reasons).toEqual(['malformed']);
  expect(result.whole).toBe(false);
  const byId = (id: string) => result.packet.changes.find((change) => change.id === id);
  for (const key of RESEARCH.filter((category) => category in (byId(badId)?.evidence ?? {})))
    expect(byId(badId)?.evidence[key], key).toEqual(reverted(packet, badId, key, MALFORMED));
  // The fixture's npm members carry a lockfile install-script fact, which a revert must keep.
  const kept = RESEARCH.filter(
    (key) =>
      key in (byId(badId)?.evidence ?? {}) && reverted(packet, badId, key, MALFORMED) !== MALFORMED,
  );
  expect(kept.length).toBeGreaterThan(0);
  for (const id of members.slice(1))
    expect(byId(id), id).toEqual(enriched.changes.find((change) => change.id === id));
});

test('keeps the retry time research set, including when one member reverts', async () => {
  const { fixture, packet, enriched, members } = await enrichedResult();
  const retryAfter = '2026-11-21T00:30:00Z';
  const kept = reconcilePacket({
    collected: packet,
    enriched: { ...enrichedInput(enriched), retryAfter },
    trusted: fixture.expected,
    priority: members,
  });
  expect(kept.packet.retryAfter).toBe(retryAfter);
  const changes = enriched.changes.map((change) =>
    change.id === members[0]
      ? {
          ...change,
          evidence: {
            ...change.evidence,
            vulnerability: { status: 'available', reasons: [], sourceIds: ['no-such-source'] },
          },
        }
      : change,
  );
  const reverted = reconcilePacket({
    collected: packet,
    enriched: { ...enrichedInput(enriched), changes, retryAfter },
    trusted: fixture.expected,
    priority: members,
  });
  expect(reverted.whole).toBe(false);
  expect(reverted.packet.retryAfter).toBe(retryAfter);
});

const OPTIONAL = ['publishTime', 'deprecation', 'trust', 'publisher'] as const;
/** An optional signal source or finding: made by the signals stage for anything but malware. */
const optionalRecord = (record: { id: string; kind: string }) =>
  record.id.startsWith('signal:') && record.kind !== 'malware';
/** Members that still carry optional signal sources in a candidate packet. */
function optionalMembers(candidate: unknown): number {
  const { sources } = candidate as { sources: { id: string; kind: string; memberIds: string[] }[] };
  return new Set(sources.filter(optionalRecord).flatMap((source) => source.memberIds)).size;
}
/** A change with every optional signal category it has left at budget. */
function withoutOptional<T extends { evidence: object }>(change: T): T {
  const evidence = { ...change.evidence } as Record<string, unknown>;
  for (const key of OPTIONAL) if (key in evidence) evidence[key] = BUDGET;
  return { ...change, evidence };
}

test('keeps members in priority order within packet limits', async () => {
  const { fixture, packet, enriched, members } = await enrichedResult();
  const keep = 1;
  rejects = (candidate) =>
    enrichedMembers(candidate, packet) > keep
      ? { ok: false, error: { category: 'budget', field: 'sources' } }
      : null;
  const priority = [...members].reverse();
  const result = reconcilePacket({
    collected: packet,
    enriched: enrichedInput(enriched),
    trusted: fixture.expected,
    priority,
  });
  const kept = priority.slice(0, keep);
  expect(result.reasons).toEqual(['budget']);
  expect(result.whole).toBe(false);
  const byId = (id: string) => result.packet.changes.find((change) => change.id === id);
  // Required research is reverted only once no member keeps optional signals (coverage §1.5).
  for (const id of kept)
    expect(byId(id), id).toEqual(withoutOptional(enriched.changes.find((c) => c.id === id)!));
  expect(optionalMembers(result.packet)).toBe(0);
  // A reverted member's own research sources leave with its research.
  const collectedIds = new Set(packet.sources.map((source) => source.id));
  const revertedOnly = result.packet.sources.filter(
    (source) => !collectedIds.has(source.id) && source.memberIds.every((id) => !kept.includes(id)),
  );
  expect(revertedOnly).toEqual([]);
  expect(
    enriched.sources.some(
      (source) =>
        !collectedIds.has(source.id) && source.memberIds.every((id) => !kept.includes(id)),
    ),
  ).toBe(true);
  for (const id of priority.slice(keep))
    for (const key of RESEARCH.filter((category) => category in (byId(id)?.evidence ?? {})))
      expect(byId(id)?.evidence[key], `${id} ${key}`).toEqual(reverted(packet, id, key, BUDGET));
});

test('over a packet limit, strips the lowest-priority members’ optional signals before any required research', async () => {
  const { fixture, packet, enriched, members } = await enrichedResult();
  const keep = 1;
  // Room for one member's optional signals, and for every member's required research.
  rejects = (candidate) =>
    optionalMembers(candidate) > keep
      ? { ok: false, error: { category: 'budget', field: 'packet' } }
      : null;
  expect(optionalMembers(enriched)).toBe(members.length);
  const priority = [...members].reverse();
  const result = reconcilePacket({
    collected: packet,
    enriched: enrichedInput(enriched),
    trusted: fixture.expected,
    priority,
  });
  expect(result.reasons).toEqual(['budget']);
  expect(result.whole).toBe(false);
  const byId = (changes: Packet['changes'], id: string) => changes.find((c) => c.id === id)!;
  // Mutation "revert before stripping": the lower-priority members lose required research.
  for (const id of members)
    for (const key of RESEARCH.filter(
      (category) => category in byId(enriched.changes, id).evidence,
    ))
      expect(byId(result.packet.changes, id).evidence[key], `${id} ${key}`).toEqual(
        byId(enriched.changes, id).evidence[key],
      );
  // The highest-priority member keeps everything; the rest lose only their optional signals.
  expect(byId(result.packet.changes, priority[0])).toEqual(byId(enriched.changes, priority[0]));
  for (const id of priority.slice(keep))
    expect(byId(result.packet.changes, id), id).toEqual(
      withoutOptional(byId(enriched.changes, id)),
    );
  expect(optionalMembers(result.packet)).toBe(keep);
  const strippedRecords = (records: readonly { id: string; kind: string }[], ids: string[]) =>
    records.filter((r) => optionalRecord(r) && ids.some((id) => JSON.stringify(r).includes(id)));
  const strippedIds = priority.slice(keep);
  expect(strippedRecords(enriched.findings, strippedIds).length).toBeGreaterThan(0);
  expect(strippedRecords(result.packet.findings, strippedIds)).toEqual([]);
  // Every other research record stays: only optional signal records of stripped members left.
  const left = (all: readonly { id: string }[], now: readonly { id: string }[]) =>
    all.filter((r) => !now.some((n) => n.id === r.id));
  for (const record of [
    ...left(enriched.sources, result.packet.sources),
    ...left(enriched.findings, result.packet.findings),
  ])
    expect(optionalRecord(record as { id: string; kind: string }), record.id).toBe(true);
});

test('the whole-packet fallback keeps the retry time research set', async () => {
  const { fixture, packet, enriched, members } = await enrichedResult();
  rejects = (candidate) =>
    enrichedMembers(candidate, packet) >= 2
      ? { ok: false, error: { category: 'reference', field: 'sources' } }
      : null;
  const result = reconcilePacket({
    collected: packet,
    enriched: { ...enrichedInput(enriched), retryAfter: '2026-11-21T00:30:00Z' },
    trusted: fixture.expected,
    priority: members,
  });
  expect(result.whole).toBe(true);
  expect(result.packet.retryAfter).toBe('2026-11-21T00:30:00Z');
});

test('an unattributable failure reports every member malformed', async () => {
  const { fixture, packet, enriched, members } = await enrichedResult();
  rejects = (candidate) =>
    enrichedMembers(candidate, packet) >= 2
      ? { ok: false, error: { category: 'reference', field: 'sources' } }
      : null;
  const result = reconcilePacket({
    collected: packet,
    enriched: enrichedInput(enriched),
    trusted: fixture.expected,
    priority: members,
  });
  expect(result.reasons).toEqual(['malformed']);
  expect(result.whole).toBe(true);
  for (const change of result.packet.changes) {
    if ('basis' in change) continue;
    for (const key of RESEARCH.filter((category) => category in change.evidence))
      expect(change.evidence[key], `${change.id} ${key}`).toEqual(
        reverted(packet, change.id, key, MALFORMED),
      );
  }
  expect(result.packet.sources).toEqual(packet.sources);
  expect(result.packet.findings).toEqual(packet.findings);
});

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const packetPart = ({ changes, sources, findings }: Packet) =>
  bytes({ changes, sources, findings });

test('the research byte bound leaves exactly the room the packet takes outside changes, sources, and findings', async () => {
  const { fixture, packet, enriched } = await enrichedResult();
  const bound = researchPacketBytes(packet);
  // Mutation "drop the non-change part from the bound": the bound would be the whole limit.
  expect(bound).toBeLessThan(limit('packet.bytes') - 1000);
  // Whatever research's lists hold, a part of exactly `bound` bytes makes a packet of exactly
  // the limit once research records a retry time, and one 18 bytes smaller while it stays null.
  for (const retryAfter of ['2026-11-21T00:01:00Z', null]) {
    const reconciled = reconcilePacket({
      collected: packet,
      enriched: { ...enrichedInput(enriched), retryAfter },
      trusted: fixture.expected,
      priority: [],
    });
    expect(reconciled.reasons).toEqual([]);
    const slack = retryAfter === null ? bytes(retryAfter) - bytes('2026-11-21T00:01:00Z') : 0;
    expect(packetPart(reconciled.packet)).not.toBe(packetPart(packet));
    expect(bytes(reconciled.packet) - packetPart(reconciled.packet) + bound).toBe(
      limit('packet.bytes') + slack,
    );
  }
});
