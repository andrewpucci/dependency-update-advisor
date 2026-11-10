import { record } from './event.js';
import {
  EVIDENCE_REASONS,
  validateReviewPacket,
  type EvidenceReason,
  type PacketResult,
} from './schema.js';

type Ecosystem = 'npm' | 'actions' | 'uv';
type Session = Readonly<{ close: () => void }>;
/** Which source gave no usable evidence, and a fixed reason; never error text. */
export type PacketGap = Readonly<{
  source: Ecosystem | 'packet' | 'brief';
  reason: EvidenceReason;
}>;

function gapReason(value: unknown): EvidenceReason {
  if (!record(value, ['kind'])) return 'malformed';
  if (value.kind !== 'unavailable') return 'malformed';
  return EVIDENCE_REASONS.find((reason) => reason === value.reason) ?? 'unknown';
}
export type PacketAssemblyResult =
  | Readonly<{ kind: 'ready'; packet: Extract<PacketResult, { ok: true }>['packet'] }>
  | Readonly<{ kind: 'incomplete'; gaps: readonly PacketGap[] }>
  | Readonly<{ kind: 'stale' | 'internal-failure' }>
  /** C2 could not produce a usable context; `category` is C2's own failure category. */
  | Readonly<{ kind: 'context-failure'; category: string }>;
export type PacketAssemblyInput<S extends Session = Session> = Readonly<{
  /** Binding, base SHA, and context revision; `context` too unless `collectContext` supplies it. */
  trusted: unknown;
  /** Collects C2 context for the changes the collectors found, before the packet is validated. */
  collectContext?: (changes: readonly unknown[]) => Promise<unknown>;
  isCurrent: () => boolean;
  openSession: () => Promise<S>;
  collectors: Readonly<Record<Ecosystem, (session: S) => Promise<unknown>>>;
  /** Optional shared source; collectors normally carry their own, including not-applicable proofs. */
  inventorySource: unknown;
}>;

type Fragment = Readonly<{
  ecosystem: Ecosystem;
  coverage: unknown;
  changes: unknown;
  sources: unknown;
  findings: unknown;
  relationships: unknown;
}>;

function fragment(value: unknown, ecosystem: Ecosystem): Fragment | null {
  if (
    !record(value, [
      'kind',
      'ecosystem',
      'coverage',
      'changes',
      'sources',
      'findings',
      'relationships',
    ]) ||
    value.kind !== 'complete' ||
    value.ecosystem !== ecosystem ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.relationships)
  )
    return null;
  return value as Fragment;
}

/** Owns one read session and delegates all structural acceptance to T4 validation. */
export async function assembleReviewPacket<S extends Session>(
  input: PacketAssemblyInput<S>,
): Promise<PacketAssemblyResult> {
  let session: S | undefined;
  try {
    if (!input.isCurrent()) return { kind: 'stale' };
    session = await input.openSession();
    const fragments: Fragment[] = [];
    for (const ecosystem of ['npm', 'actions', 'uv'] as const) {
      if (!input.isCurrent()) return { kind: 'stale' };
      const result = await input.collectors[ecosystem](session);
      const value = fragment(result, ecosystem);
      if (!value || !input.isCurrent())
        return input.isCurrent()
          ? { kind: 'incomplete', gaps: [{ source: ecosystem, reason: gapReason(result) }] }
          : { kind: 'stale' };
      fragments.push(value);
    }
    if (!record(input.trusted, ['binding', 'baseSha', 'contextRevision']))
      return { kind: 'internal-failure' };
    let trusted: Record<string, unknown> = input.trusted;
    if (input.collectContext) {
      const context = await input.collectContext(fragments.flatMap((item) => item.changes));
      if (!input.isCurrent()) return { kind: 'stale' };
      if (!record(context, ['ok'])) return { kind: 'internal-failure' };
      if (context.ok !== true)
        return {
          kind: 'context-failure',
          category: record(context.error, ['category'])
            ? String(context.error.category)
            : 'unknown',
        };
      trusted = { ...trusted, context };
    } else if (!Object.hasOwn(trusted, 'context')) return { kind: 'internal-failure' };
    const packet = validateReviewPacket(
      {
        version: 1,
        binding: input.trusted.binding,
        baseSha: input.trusted.baseSha,
        contextRevision: trusted.contextRevision,
        context: trusted.context,
        coverage: Object.fromEntries(fragments.map((item) => [item.ecosystem, item.coverage])),
        changes: fragments.flatMap((item) => item.changes),
        sources: [
          ...(input.inventorySource === null || input.inventorySource === undefined
            ? []
            : [input.inventorySource]),
          ...fragments.flatMap((item) => item.sources),
        ],
        findings: fragments.flatMap((item) => item.findings),
        relationships: fragments.flatMap((item) => item.relationships),
      },
      trusted,
    );
    if (packet.ok) return { kind: 'ready', packet: packet.packet };
    return {
      kind: 'incomplete',
      gaps: [
        { source: 'packet', reason: packet.error.category === 'budget' ? 'budget' : 'malformed' },
      ],
    };
  } catch {
    return { kind: 'internal-failure' };
  } finally {
    try {
      session?.close();
    } catch {
      // A close failure cannot revive or replace the result already computed.
    }
  }
}
