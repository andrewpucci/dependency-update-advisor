import type { Finding } from './policy.js';
import { longestFittingPrefix } from './evidence/common.js';
import { isOptionalSignalRecord } from './evidence/policy-signals-evidence.js';
import {
  PACKET_LIMITS,
  validateReviewPacket,
  type ChangeEvidence,
  type EvidenceReason,
  type PacketChange,
  type PacketExpected,
  type PacketResult,
  type PacketSource,
} from './schema.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
type Reason = Extract<EvidenceReason, 'malformed' | 'budget'>;

const RESEARCH_CATEGORIES = ['upstream', 'installScript', 'vulnerability', 'malware'] as const;
/** The optional signal categories, which give way before any member's required research (§1.5). */
const OPTIONAL_CATEGORIES = ['publishTime', 'deprecation', 'trust', 'publisher'] as const;
const NONE: ReadonlySet<string> = new Set();

/** The collector's "not researched yet" value, which research replaces with its own result. */
export function isResearchPlaceholder(evidence: ChangeEvidence | undefined): boolean {
  return (
    evidence?.status === 'unavailable' &&
    evidence.reasons.length === 1 &&
    evidence.reasons[0] === 'missing' &&
    evidence.sourceIds.length === 0
  );
}

/**
 * Replaces a collected change's research placeholders with one evidence value; copies, never
 * mutates. Collected facts, such as an install-script flag read from the lockfile, are kept.
 */
function withResearch(change: PacketChange, evidence: ChangeEvidence): PacketChange {
  const categories = RESEARCH_CATEGORIES.filter((key) =>
    isResearchPlaceholder(change.evidence[key]),
  ).map((key) => [key, evidence] as const);
  return { ...change, evidence: { ...change.evidence, ...Object.fromEntries(categories) } };
}

/** A kept member's enriched change with its optional signal categories left at `budget`; copies. */
function withoutOptional(change: PacketChange): PacketChange {
  const evidence: Record<string, ChangeEvidence> = { ...change.evidence };
  for (const key of OPTIONAL_CATEGORIES)
    if (evidence[key])
      evidence[key] = { status: 'unavailable', reasons: ['budget'], sourceIds: [] };
  return { ...change, evidence } as PacketChange;
}

/** Whether an optional signal record belongs only to members whose optional signals are stripped. */
function strippedRecord(
  record: { id: string; kind: string },
  memberIds: readonly (string | null)[],
  stripped: ReadonlySet<string>,
): boolean {
  return isOptionalSignalRecord(record) && memberIds.every((id) => id !== null && stripped.has(id));
}

/** A whole-second UTC retry time; every such value serializes to the same number of bytes. */
const RETRY_AFTER_SHAPE = '1970-01-01T00:00:00Z';

/**
 * The research byte bound: the bytes the enriched changes, sources, and findings may take so the
 * packet `reconcilePacket` builds stays within `packet.bytes`. It is the packet limit less the
 * collected packet's serialized members other than those three (binding, coverage, context,
 * relationships, reachability, retryAfter, and the rest), which reconciliation copies unchanged.
 * A JSON object's size is the sum of its members' sizes plus separators, so that difference does
 * not depend on the three lists' contents. `retryAfter` is counted as a retry time, since
 * research may set one where the collected packet had null.
 */
export function researchPacketBytes(collected: Packet): number {
  const { changes, sources, findings } = collected;
  const whole = Buffer.byteLength(JSON.stringify({ ...collected, retryAfter: RETRY_AFTER_SHAPE }));
  const part = Buffer.byteLength(JSON.stringify({ changes, sources, findings }));
  return PACKET_LIMITS.bytes - (whole - part);
}

/**
 * A reconciled packet. `stripped` names the kept members whose optional signals left the packet,
 * and `reverted` the members whose research reverted, with the reason they now carry; research
 * rewrites those members' attempt records so none cites a source the packet no longer holds.
 * After a whole-packet fallback (`whole`) no research record is kept, so both are empty.
 */
export type Reconciled = {
  packet: Packet;
  reasons: Reason[];
  whole: boolean;
  stripped: ReadonlySet<string>;
  reverted: ReadonlyMap<string, Reason>;
};

/**
 * Keeps every member's research that validates, within packet limits (coverage §1.4, §1.5).
 * Members are attributed one at a time; an unattributable failure falls back to the collected
 * packet with every member marked malformed. Over a packet limit, the lowest-priority members'
 * optional signals give way first; only if every member's optional signals are stripped and the
 * packet still does not fit are members' required research reverted, lowest priority first.
 */
export function reconcilePacket(input: {
  collected: Packet; // the validated collected packet
  /** In packet order; `retryAfter` is the latest GitHub rate-limit retry time research recorded. */
  enriched: { changes: unknown; sources: unknown; findings: unknown; retryAfter?: string | null };
  trusted: PacketExpected;
  priority: readonly string[]; // member ids, highest priority first
}): Reconciled {
  const { collected } = input;
  const collectedChanges = collected.changes as readonly PacketChange[];
  const collectedSources = collected.sources as readonly PacketSource[];
  const collectedFindings = collected.findings as readonly Finding[];
  const enrichedById = new Map(
    (input.enriched.changes as readonly PacketChange[]).map((change) => [change.id, change]),
  );
  const collectedSourceIds = new Set(collectedSources.map((source) => source.id));
  const collectedFindingIds = new Set(collectedFindings.map((finding) => finding.id));
  const researchSources = (input.enriched.sources as readonly PacketSource[]).filter(
    (source) => !collectedSourceIds.has(source.id),
  );
  const researchFindings = (input.enriched.findings as readonly Finding[]).filter(
    (finding) => !collectedFindingIds.has(finding.id),
  );
  const members = collectedChanges
    .filter(
      (change) =>
        !('basis' in change) &&
        JSON.stringify(enrichedById.get(change.id)) !== JSON.stringify(change),
    )
    .map((change) => change.id);
  const memberSet = new Set(members);

  /**
   * A candidate with `kept` members enriched, of which the `stripped` ones lose their optional
   * signals; other members are reverted with `reasonOf`.
   */
  const attempt = (
    kept: ReadonlySet<string>,
    reasonOf: ReadonlyMap<string, Reason>,
    stripped: ReadonlySet<string> = NONE,
  ) => {
    const keptEveryone = members.every((id) => kept.has(id));
    const changes = collectedChanges.map((change) => {
      if (!memberSet.has(change.id)) return change;
      if (kept.has(change.id)) {
        const enriched = enrichedById.get(change.id)!;
        return stripped.has(change.id) ? withoutOptional(enriched) : enriched;
      }
      const reason = reasonOf.get(change.id) ?? 'malformed';
      return withResearch(change, { status: 'unavailable', reasons: [reason], sourceIds: [] });
    });
    return validateReviewPacket(
      {
        version: 1,
        binding: collected.binding,
        baseSha: collected.baseSha,
        contextRevision: collected.contextRevision,
        context: collected.context,
        coverage: collected.coverage,
        changes,
        sources: [
          ...collectedSources,
          ...researchSources.filter(
            (source) =>
              source.memberIds.some((id) => kept.has(id)) &&
              !strippedRecord(source, source.memberIds, stripped),
          ),
        ],
        findings: [
          ...collectedFindings,
          ...researchFindings.filter(
            (finding) =>
              (finding.memberId === null ? keptEveryone : kept.has(finding.memberId)) &&
              !strippedRecord(finding, [finding.memberId], stripped),
          ),
        ],
        relationships: collected.relationships,
        reachability: collected.reachability,
        retryAfter: input.enriched.retryAfter ?? collected.retryAfter,
      },
      input.trusted,
    );
  };

  const whole = (reasons: Reason[]) => {
    const marked = collectedChanges.map((change) =>
      'basis' in change
        ? change
        : withResearch(change, { status: 'unavailable', reasons: ['malformed'], sourceIds: [] }),
    );
    const result = validateReviewPacket(
      {
        version: 1,
        binding: collected.binding,
        baseSha: collected.baseSha,
        contextRevision: collected.contextRevision,
        context: collected.context,
        coverage: collected.coverage,
        changes: marked,
        sources: collectedSources,
        findings: collectedFindings,
        relationships: collected.relationships,
        reachability: collected.reachability,
        // A GitHub rate limit research met still tells the reader when a rerun can work.
        retryAfter: input.enriched.retryAfter ?? collected.retryAfter,
      },
      input.trusted,
    );
    const packet = result.ok ? result.packet : collected;
    return { packet, reasons, whole: true, stripped: NONE, reverted: new Map() };
  };

  const everyone = attempt(new Set(members), new Map());
  const partial = (
    packet: Packet,
    reasons: Reason[],
    stripped: ReadonlySet<string>,
    reverted: ReadonlyMap<string, Reason>,
  ): Reconciled => ({ packet, reasons, whole: false, stripped, reverted });
  if (everyone.ok) return partial(everyone.packet, [], NONE, new Map());

  // Attribute: a member whose candidate fails for any reason but a packet limit is bad.
  const bad = members.filter((id) => {
    const alone = attempt(new Set([id]), new Map());
    return !alone.ok && alone.error.category !== 'budget';
  });
  const badSet = new Set(bad);
  const badReasons = new Map<string, Reason>(bad.map((id) => [id, 'malformed']));
  const malformed: Reason[] = bad.length > 0 ? ['malformed'] : [];
  const kept = members.filter((id) => !badSet.has(id));
  const withoutBad = attempt(new Set(kept), badReasons);
  if (withoutBad.ok) return partial(withoutBad.packet, malformed, NONE, badReasons);
  if (withoutBad.error.category !== 'budget') return whole(['malformed']);

  const rank = new Map(input.priority.map((id, index) => [id, index]));
  const ordered = [...kept].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  const keptSet = new Set(kept);
  const reasons: Reason[] = [...malformed, 'budget'];

  // Optional before required (§1.5): strip optional signals from the lowest-priority members
  // first, keeping as many of the highest-priority members' optional signals as fit.
  const strip = (count: number) => {
    const stripped = new Set(ordered.slice(count));
    return { stripped, result: attempt(keptSet, badReasons, stripped) };
  };
  const optionalFit = longestFittingPrefix(ordered.length, strip, ({ result }) => result.ok);
  if (optionalFit?.result.ok)
    return partial(optionalFit.result.packet, reasons, optionalFit.stripped, badReasons);

  // Even with no optional signals the packet does not fit: keep members' required research in
  // priority order, as many as validate, with every kept member's optional signals stripped,
  // since none may outrank another member's required research. A candidate that fails for any
  // other reason once stripped cannot be attributed, as when the bad members are reverted.
  const strippedAll = strip(0).result;
  if (!strippedAll.ok && strippedAll.error.category !== 'budget') return whole(['malformed']);
  const fits = (count: number) => {
    const reasonOf = new Map<string, Reason>(badReasons);
    for (const id of ordered.slice(count)) reasonOf.set(id, 'budget');
    const keptPrefix = new Set(ordered.slice(0, count));
    return { keptPrefix, reasonOf, result: attempt(keptPrefix, reasonOf, keptSet) };
  };
  const best = longestFittingPrefix(ordered.length, fits, ({ result }) => result.ok);
  if (!best?.result.ok) return whole(['malformed']);
  return partial(best.result.packet, reasons, best.keptPrefix, best.reasonOf);
}
