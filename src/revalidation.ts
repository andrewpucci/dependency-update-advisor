import type { Finding } from './policy.js';
import {
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
type Validated = Extract<PacketResult, { ok: true }>;
type Failed = Extract<PacketResult, { ok: false }>;

const RESEARCH_CATEGORIES = ['upstream', 'installScript', 'vulnerability', 'malware'] as const;

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

/**
 * Keeps every member's research that validates, in priority order within packet limits (coverage
 * §1.4, §1.5). Members are attributed one at a time; an unattributable failure falls back to the
 * collected packet with every member marked malformed.
 */
export function reconcilePacket(input: {
  collected: Packet; // the validated collected packet
  /** In packet order; `retryAfter` is the latest GitHub rate-limit retry time research recorded. */
  enriched: { changes: unknown; sources: unknown; findings: unknown; retryAfter?: string | null };
  trusted: PacketExpected;
  priority: readonly string[]; // member ids, highest priority first
}): { packet: Packet; reasons: Reason[]; whole: boolean } {
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

  /** A candidate with `kept` members enriched; other members are reverted with `reasonOf`. */
  const attempt = (kept: ReadonlySet<string>, reasonOf: ReadonlyMap<string, Reason>) => {
    const keptEveryone = members.every((id) => kept.has(id));
    const changes = collectedChanges.map((change) => {
      if (!memberSet.has(change.id)) return change;
      if (kept.has(change.id)) return enrichedById.get(change.id);
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
          ...researchSources.filter((source) => source.memberIds.some((id) => kept.has(id))),
        ],
        findings: [
          ...collectedFindings,
          ...researchFindings.filter((finding) =>
            finding.memberId === null ? keptEveryone : kept.has(finding.memberId),
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
        retryAfter: collected.retryAfter,
      },
      input.trusted,
    );
    const packet = result.ok ? result.packet : collected;
    return { packet, reasons, whole: true };
  };

  const everyone = attempt(new Set(members), new Map());
  if (everyone.ok) return { packet: everyone.packet, reasons: [], whole: false };

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
  if (withoutBad.ok) return { packet: withoutBad.packet, reasons: malformed, whole: false };
  if (withoutBad.error.category !== 'budget') return whole(['malformed']);

  // Within limits: keep members in priority order, as many as validate.
  const rank = new Map(input.priority.map((id, index) => [id, index]));
  const ordered = [...kept].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  const fits = (count: number): Validated | Failed => {
    const reasonOf = new Map<string, Reason>(badReasons);
    for (const id of ordered.slice(count)) reasonOf.set(id, 'budget');
    return attempt(new Set(ordered.slice(0, count)), reasonOf);
  };
  let best = fits(0);
  if (!best.ok) return whole(['malformed']);
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const result = fits(middle);
    if (result.ok) {
      low = middle;
      best = result;
    } else high = middle - 1;
  }
  return {
    packet: best.ok ? best.packet : collected,
    reasons: [...malformed, 'budget'],
    whole: false,
  };
}
