import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  PACKET_LIMITS,
  type PacketChange,
  type PacketSource,
  type EvidenceReason,
} from '../schema.js';
import type { Finding } from '../policy.js';
import { advisoryCheck, AdvisoryFailure } from './advisory-read.js';
import { limit, SIGNAL_EXCERPT } from '../limits.js';
import { UpstreamFailure } from './upstream-read.js';
import type { Observation, PolicySignalInput, SignalEnrichment } from './policy-signals.js';

export function observe<T>(read: () => T): Observation<T> {
  try {
    return { kind: 'known', value: read() };
  } catch (error) {
    return {
      kind: 'unchecked',
      reason: error instanceof AdvisoryFailure ? error.reason : 'malformed',
    };
  }
}
export type OptionalCategory = 'publishTime' | 'deprecation' | 'trust' | 'publisher' | 'license';
const REASON_CODE_UNITS = limit('signals.reasonCodeUnits');
/** Bounds a registry reason by UTF-16 units without splitting a surrogate pair. */
export function boundedReason(value: string): string {
  const clean = value.replace(/[\p{Cc}\p{Cs}]/gu, ' ');
  if (clean.length <= REASON_CODE_UNITS) return clean;
  let kept = '';
  for (const point of clean) {
    if (kept.length + point.length > REASON_CODE_UNITS) break;
    kept += point;
  }
  return kept + SIGNAL_EXCERPT.reasonMarker;
}
type KnownSignal = { url: string; value: unknown; reasons?: EvidenceReason[]; bothSides?: boolean };
function signalSubject(change: PacketChange, side: 'base' | 'head') {
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return null;
  const value = 'version' in instance ? instance.version : 'ref' in instance ? instance.ref : '';
  return { memberId: change.id, side, value };
}
function signalRange(
  change: PacketChange,
  side: 'base' | 'head',
  value: string,
  bothSides?: boolean,
) {
  if (!bothSides)
    return { from: side === 'base' ? value : null, to: side === 'head' ? value : null };
  return {
    from: change.from && 'version' in change.from ? change.from.version : null,
    to: change.to && 'version' in change.to ? change.to.version : null,
  };
}
function signalProvenance(
  change: PacketChange,
  side: 'base' | 'head',
  category: OptionalCategory,
  known: KnownSignal | null,
  excerpt: string,
): PacketSource['provenance'] {
  if (!known) return { kind: 'unavailable' };
  const reviewed = signalSubject(change, side);
  advisoryCheck(reviewed);
  const sides: ('base' | 'head')[] = known.bothSides ? ['base', 'head'] : [side];
  const subjects = sides.flatMap((s) => {
    const subject = signalSubject(change, s);
    return subject ? [subject] : [];
  });
  return {
    kind: 'upstream',
    url: known.url,
    title: 'Exact ' + category + ' observation',
    excerpt,
    excerptTruncated: false,
    subjects,
    range: signalRange(change, side, reviewed.value, known.bothSides),
  };
}
function signalState(
  known: KnownSignal | null,
  reason: EvidenceReason,
): Pick<PacketSource, 'status' | 'reasons'> {
  if (!known) return { status: 'unavailable', reasons: [reason] };
  const reasons = known.reasons ?? [];
  return { status: reasons.length ? 'partial' : 'available', reasons };
}
function optionalAttempt(
  source: PacketSource,
  side: 'base' | 'head',
  category: OptionalCategory,
  known: KnownSignal | null,
  reason: EvidenceReason,
) {
  const outcome = known
    ? ('available' as const)
    : reason === 'unsupported'
      ? ('skipped' as const)
      : ('unavailable' as const);
  return {
    memberId: source.memberIds[0],
    side,
    category,
    url: known?.url ?? null,
    outcome,
    reasons: source.reasons,
    sourceIds: [source.id],
    truncated: reason === 'truncated' && !known,
  };
}
export function recordSignal(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  side: 'base' | 'head',
  category: OptionalCategory,
  known: KnownSignal | null,
  reason: EvidenceReason = 'unsupported',
): PacketSource {
  advisoryCheck(signalSubject(change, side));
  const excerpt = known ? JSON.stringify(known.value) : '';
  if (known && excerpt.length > PACKET_LIMITS.excerptCodeUnits) {
    known = null;
    reason = 'truncated';
  }
  const source: PacketSource = {
    id: signalId(input.binding.identity, change.id, side, category, known ?? reason),
    kind: category === 'license' ? 'metadata' : category,
    ecosystems: [change.ecosystem],
    memberIds: [change.id],
    ...signalState(known, reason),
    provenance: signalProvenance(change, side, category, known, excerpt),
  };
  retainSignalSource(output, source);
  output.attempts.push(optionalAttempt(source, side, category, known, reason));
  return source;
}
export function attachSignalCoverage(
  change: PacketChange,
  category: Exclude<OptionalCategory, 'license'>,
  sources: PacketSource[],
) {
  const reasons = [...new Set(sources.flatMap((s) => s.reasons))];
  change.evidence[category] = {
    status: reasons.length
      ? sources.some((s) => s.status !== 'unavailable')
        ? 'partial'
        : 'unavailable'
      : 'available',
    sourceIds: [...new Set(sources.map((s) => s.id))],
    reasons,
  };
}
export const signalId = (...values: unknown[]) =>
  'signal:' + createHash('sha256').update(JSON.stringify(values)).digest('hex');
export function retainSignalSource(output: SignalEnrichment, source: PacketSource) {
  const previous = output.sources.find((s) => s.id === source.id);
  advisoryCheck(!previous || isDeepStrictEqual(previous, source), 'conflict');
  if (!previous) output.sources.push(source);
}
export function retainSignalFinding(output: SignalEnrichment, finding: Finding) {
  const previous = output.findings.find((f) => f.id === finding.id);
  advisoryCheck(!previous || isDeepStrictEqual(previous, finding), 'conflict');
  if (!previous) output.findings.push(finding);
}
const OPTIONAL_CATEGORIES = [
  'publishTime',
  'deprecation',
  'trust',
  'publisher',
  'license',
] as const;
/**
 * Attempts need no runtime cap: each member's come from fixed call sites over its sides and the
 * categories (at most 15 by reading the collectors; tests pin it), with no loop over untrusted
 * data, and members are bounded by `PACKET_LIMITS.changes`.
 */
export const SIGNAL_ATTEMPTS_PER_MEMBER = limit('signals.attemptsPerMember');
const PACKET_FIELDS = new Set(['changes', 'sources', 'findings']);
/**
 * Serialized sizes of the enrichment, each part serialized once: `packet` is what it adds to the
 * review packet (changes, sources, findings), and `retained` is the whole output. Attempts are
 * diagnostics outside the packet, so they count only toward retained bytes. Both equal
 * `Buffer.byteLength(JSON.stringify(...))` of the corresponding object.
 */
export function enrichmentBytes(output: SignalEnrichment): { packet: number; retained: number } {
  const object = (sizes: number[]) =>
    2 + sizes.reduce((total, size) => total + size, 0) + Math.max(sizes.length - 1, 0);
  const members = Object.entries(output).flatMap(([key, value]) => {
    const json = JSON.stringify(value);
    return json === undefined
      ? []
      : [{ key, size: Buffer.byteLength(JSON.stringify(key)) + 1 + Buffer.byteLength(json) }];
  });
  return {
    packet: object(members.filter((m) => PACKET_FIELDS.has(m.key)).map((m) => m.size)),
    retained: object(members.map((m) => m.size)),
  };
}
function fitsBytes(input: PolicySignalInput, bytes: { packet: number; retained: number }) {
  return bytes.packet <= PACKET_LIMITS.bytes && bytes.retained <= input.limits.maxRetainedBytes;
}
export function signalBounds(input: PolicySignalInput, output: SignalEnrichment) {
  advisoryCheck(
    output.changes.every((c) =>
      Object.values(c.evidence).every((e) => e.sourceIds.length <= PACKET_LIMITS.listEntries),
    ),
    'budget',
  );
  advisoryCheck(
    output.sources.length <= PACKET_LIMITS.sources &&
      output.findings.length <=
        Math.min(PACKET_LIMITS.findings, input.findings.length + input.limits.maxFindings) &&
      fitsBytes(input, enrichmentBytes(output)),
    'budget',
  );
}
const SIGNAL_CATEGORIES = ['malware', ...OPTIONAL_CATEGORIES] as const;
/**
 * Reserves every member's explained terminal outcome, malware included, before any read can spend
 * retention space. A member whose results then cross a limit returns to its reservation, which
 * was already counted, so one member's overflow never fails the stage (coverage §1.5). Members
 * run in research order (§3.5), and the first member that does not fit ends that pass, so the
 * members left at `budget` are exactly the lowest-priority ones.
 */
export function reserveSignals(input: PolicySignalInput, output: SignalEnrichment) {
  for (const change of output.changes) {
    if ('basis' in change) continue;
    for (const category of SIGNAL_CATEGORIES) {
      if (category !== 'license')
        change.evidence[category] = { status: 'unavailable', reasons: ['budget'], sourceIds: [] };
      output.attempts.push({
        memberId: change.id,
        side: change.to ? 'head' : 'base',
        category,
        url: null,
        outcome: 'skipped',
        reasons: ['budget'],
        sourceIds: [],
        truncated: false,
      });
    }
  }
  signalBounds(input, output);
}
/** A collector with no side to observe, e.g. proposed-only deprecation for a removal. */
function explainUnattempted(output: SignalEnrichment, change: PacketChange) {
  for (const category of OPTIONAL_CATEGORIES) {
    if (output.attempts.some((a) => a.memberId === change.id && a.category === category)) continue;
    if (category !== 'license')
      change.evidence[category] = {
        status: 'unavailable',
        reasons: ['unsupported'],
        sourceIds: [],
      };
    output.attempts.push({
      memberId: change.id,
      side: change.to ? 'head' : 'base',
      category,
      url: null,
      outcome: 'skipped',
      reasons: ['unsupported'],
      sourceIds: [],
      truncated: false,
    });
  }
}
/**
 * Checks packet limits after a member's rollback. If the discoveries kept from that member no
 * longer fit, they are dropped too, so only this member loses its optional signals. Returns
 * whether it had to drop them.
 */
function boundOrRelease(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  snapshot: { sources: PacketSource[]; findings: Finding[] },
): boolean {
  try {
    signalBounds(input, output);
    return false;
  } catch {
    output.sources = [...snapshot.sources];
    output.findings = [...snapshot.findings];
    for (const category of OPTIONAL_CATEGORIES) {
      if (category !== 'license')
        change.evidence[category] = { status: 'unavailable', reasons: ['budget'], sourceIds: [] };
      const terminal = output.attempts.find(
        (a) => a.memberId === change.id && a.category === category,
      )!;
      // Exactly the reservation's placeholder, so the state is no larger than before this member.
      Object.assign(terminal, {
        url: null,
        outcome: 'skipped',
        reasons: ['budget'],
        sourceIds: [],
        truncated: false,
      });
    }
    signalBounds(input, output);
    return true;
  }
}
/**
 * One member's optional signals. Returns false when the member's results crossed a packet limit,
 * so the caller leaves every lower-priority member at its reservation (coverage §1.5).
 */
export async function runOptionalSignals(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  collect: () => Promise<void>,
): Promise<boolean> {
  let overflowed = false;
  const snapshot = {
    sources: [...output.sources],
    findings: [...output.findings],
    attempts: [...output.attempts],
    evidence: structuredClone(change.evidence),
  };
  output.attempts = output.attempts.filter(
    (a) => a.memberId !== change.id || a.category === 'malware',
  );
  try {
    await collect();
    explainUnattempted(output, change);
    try {
      signalBounds(input, output);
      return true;
    } catch (error) {
      overflowed = true;
      throw error;
    }
  } catch (error) {
    const reason =
      error instanceof AdvisoryFailure || error instanceof UpstreamFailure
        ? error.reason
        : 'unknown';
    const priorIds = new Set(snapshot.findings.map((f) => f.id));
    const discoveries = output.findings.filter((f) => !priorIds.has(f.id));
    const refs = new Set(discoveries.flatMap((f) => f.references));
    const priorSources = new Set(snapshot.sources.map((s) => s.id));
    const retained = output.sources.filter((s) => refs.has(s.id) && !priorSources.has(s.id));
    const attempts = output.attempts.filter(
      (a) => a.memberId === change.id && a.category !== 'malware',
    );
    output.sources = [...snapshot.sources, ...retained];
    output.findings = [...snapshot.findings, ...discoveries];
    output.attempts = snapshot.attempts;
    change.evidence = snapshot.evidence;
    for (const category of OPTIONAL_CATEGORIES) {
      if (category !== 'license')
        change.evidence[category] = { status: 'unavailable', reasons: [reason], sourceIds: [] };
      const terminal = output.attempts.find(
        (a) => a.memberId === change.id && a.category === category,
      )!;
      const actual = attempts.filter((a) => a.category === category);
      terminal.reasons = [reason];
      terminal.outcome = actual.length ? 'unavailable' : 'skipped';
      terminal.url = actual.find((a) => a.side === terminal.side)?.url ?? null;
      terminal.sourceIds = [
        ...new Set(actual.flatMap((a) => a.sourceIds).filter((id) => refs.has(id))),
      ];
      terminal.truncated = actual.length > 0;
    }
    return !boundOrRelease(input, output, change, snapshot) && !overflowed;
  }
}
