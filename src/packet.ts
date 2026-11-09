import { record } from './event.js';
import { validateReviewPacket, type PacketResult } from './schema.js';

type Ecosystem = 'npm' | 'actions' | 'uv';
type Session = Readonly<{ close: () => void }>;
export type PacketAssemblyResult =
  | Readonly<{ kind: 'ready'; packet: Extract<PacketResult, { ok: true }>['packet'] }>
  | Readonly<{ kind: 'incomplete' | 'stale' | 'internal-failure' }>;
export type PacketAssemblyInput = Readonly<{
  trusted: unknown;
  isCurrent: () => boolean;
  openSession: () => Promise<Session>;
  collectors: Readonly<Record<Ecosystem, (session: Session) => Promise<unknown>>>;
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
export async function assembleReviewPacket(
  input: PacketAssemblyInput,
): Promise<PacketAssemblyResult> {
  let session: Session | undefined;
  try {
    if (!input.isCurrent()) return { kind: 'stale' };
    session = await input.openSession();
    const fragments: Fragment[] = [];
    for (const ecosystem of ['npm', 'actions', 'uv'] as const) {
      if (!input.isCurrent()) return { kind: 'stale' };
      const value = fragment(await input.collectors[ecosystem](session), ecosystem);
      if (!value || !input.isCurrent())
        return input.isCurrent() ? { kind: 'incomplete' } : { kind: 'stale' };
      fragments.push(value);
    }
    if (!record(input.trusted, ['binding', 'baseSha', 'contextRevision', 'context']))
      return { kind: 'internal-failure' };
    const packet = validateReviewPacket(
      {
        version: 1,
        binding: input.trusted.binding,
        baseSha: input.trusted.baseSha,
        contextRevision: input.trusted.contextRevision,
        context: input.trusted.context,
        coverage: Object.fromEntries(fragments.map((item) => [item.ecosystem, item.coverage])),
        changes: fragments.flatMap((item) => item.changes),
        sources: [input.inventorySource, ...fragments.flatMap((item) => item.sources)],
        findings: fragments.flatMap((item) => item.findings),
        relationships: fragments.flatMap((item) => item.relationships),
      },
      input.trusted,
    );
    return packet.ok ? { kind: 'ready', packet: packet.packet } : { kind: 'incomplete' };
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
