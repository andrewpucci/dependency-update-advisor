import { EVIDENCE_READ_ALLOCATION, EVIDENCE_READ_ENVELOPE } from './budget.js';
import type { GithubComparison } from './github-read.js';
import { enrichAdvisories } from './evidence/advisories.js';
import { createAdvisoryReader, createMalwareReader } from './evidence/advisory-read.js';
import { createNpmPublishTimeReader } from './evidence/npm-publish-times.js';
import { createNpmRegistryReader } from './evidence/npm-registry.js';
import { enrichPolicySignals } from './evidence/policy-signals.js';
import type { SignalAttempt } from './evidence/policy-signals.js';
import { createPolicySignalReader } from './evidence/policy-signals-read.js';
import { enrichUpstream, type UpstreamAttempt } from './evidence/upstream.js';
import { createUpstreamReader } from './evidence/upstream-read.js';
import type { NpmInventoryResult } from './evidence/npm.js';
import type { PacketExpected, PacketResult } from './schema.js';
import { validateReviewPacket, type EvidenceReason } from './schema.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
type NpmInventory = Extract<NpmInventoryResult, { kind: 'inventory' }>;
export type ResearchStage = 'upstream' | 'advisories' | 'signals' | 'revalidation';
export type ResearchInput = Readonly<{
  packet: Packet;
  trusted: PacketExpected;
  /** The authentic npm inventory, needed for npm identity proofs; absent when no npm evidence ran. */
  npmInventory: NpmInventory | null;
  /** A complete D1 comparison, used only as additional advisory evidence. */
  comparison: GithubComparison | null;
  /** Credential-free fetch for public registries and advisory sources. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  /** Absolute time, in `now` units, by which research must be finished. */
  deadline: number;
  evaluationTime: number;
  signal?: AbortSignal;
}>;
export type ResearchResult =
  | Readonly<{
      kind: 'ready';
      packet: Packet;
      /** Stages whose research could not be established; their evidence stays as collected. */
      unavailable: readonly Readonly<{ stage: ResearchStage; reason: EvidenceReason }>[];
      upstreamAttempts: readonly UpstreamAttempt[];
      signalAttempts: readonly SignalAttempt[];
    }>
  | Readonly<{ kind: 'internal-failure' }>;

const MAX_JSON_ENTRIES = 200_000;
const MAX_JSON_DEPTH = 32;
const MAX_RETAINED_BYTES = 2_000_000;

function remaining(input: Pick<ResearchInput, 'now' | 'deadline'>): number {
  return Math.max(
    1,
    Math.min(EVIDENCE_READ_ENVELOPE.totalTimeoutMs, Math.floor(input.deadline - input.now())),
  );
}

function limits(
  share: { maxRequests: number; maxTotalBytes: number },
  input: Pick<ResearchInput, 'now' | 'deadline'>,
) {
  const { maxRequests, maxTotalBytes } = share;
  return {
    maxRequests,
    maxPages: maxRequests,
    maxTagCandidates: 100,
    maxTagDepth: 10,
    maxResponseBytes: Math.min(EVIDENCE_READ_ENVELOPE.maxResponseBytes, maxTotalBytes),
    maxTotalBytes,
    maxJsonEntries: MAX_JSON_ENTRIES,
    maxJsonDepth: MAX_JSON_DEPTH,
    maxWork: 5_000_000,
    maxRetainedBytes: MAX_RETAINED_BYTES,
    maxAttempts: 512,
    maxFindings: 512,
    // A request may not be allowed longer than the whole read, so near the deadline both shrink.
    requestTimeoutMs: Math.min(EVIDENCE_READ_ENVELOPE.requestTimeoutMs, remaining(input)),
    totalTimeoutMs: remaining(input),
  };
}

/**
 * Runs upstream research, advisory lookup, and policy signals over a validated packet, feeding each
 * stage's proofs and sources to the next. A stage that cannot be established leaves the evidence as
 * collected, so research is never reported as complete without its own result; the enriched packet
 * is revalidated and replaced by the collected one if it fails.
 */
export async function runResearch(input: ResearchInput): Promise<ResearchResult> {
  const dependencies = { now: input.now, fetch: input.fetch, signal: input.signal };
  const unavailable: { stage: ResearchStage; reason: EvidenceReason }[] = [];
  const readers: { close: () => void }[] = [];
  try {
    const { packet } = input;
    let current: {
      changes: unknown;
      sources: unknown;
      findings: unknown;
    } = { changes: packet.changes, sources: packet.sources, findings: packet.findings };
    let publicIdentities: unknown = [];
    let actionVersions: unknown = [];
    let upstreamAttempts: readonly UpstreamAttempt[] = [];
    let signalAttempts: readonly SignalAttempt[] = [];

    const fail = (stage: ResearchStage, reason: EvidenceReason) =>
      unavailable.push({ stage, reason });
    const failure = (result: { kind: string; reason?: EvidenceReason }): EvidenceReason =>
      result.kind === 'unavailable' && result.reason ? result.reason : 'malformed';

    const upstreamLimits = limits(EVIDENCE_READ_ALLOCATION.upstream, input);
    const opened = createUpstreamReader(upstreamLimits, dependencies);
    if (opened.kind === 'ready') {
      readers.push(opened.reader);
      const upstream = await enrichUpstream(
        {
          binding: packet.binding,
          changes: current.changes,
          sources: current.sources,
          findings: current.findings,
          limits: upstreamLimits,
          ...(input.npmInventory ? { npmInventory: input.npmInventory } : {}),
        },
        { reader: opened.reader },
      );
      if (upstream.kind === 'enriched') {
        current = {
          changes: upstream.changes,
          sources: upstream.sources,
          findings: upstream.findings,
        };
        publicIdentities = upstream.publicIdentities;
        actionVersions = upstream.actionVersions;
        upstreamAttempts = upstream.attempts;
      } else fail('upstream', failure(upstream));
    } else fail('upstream', 'malformed');

    const advisoryLimits = limits(EVIDENCE_READ_ALLOCATION.advisory, input);
    const reviewed = createAdvisoryReader(advisoryLimits, dependencies);
    if (reviewed.kind === 'ready') {
      readers.push(reviewed);
      const advisories = await enrichAdvisories(
        {
          binding: packet.binding,
          changes: current.changes,
          sources: current.sources,
          findings: current.findings,
          publicIdentities,
          actionVersions,
          limits: advisoryLimits,
          ...(input.comparison?.kind === 'available' ? { comparisons: [input.comparison] } : {}),
        } as never,
        { reader: reviewed },
      );
      if (advisories.kind === 'enriched')
        current = {
          changes: advisories.changes,
          sources: advisories.sources,
          findings: advisories.findings,
        };
      else fail('advisories', failure(advisories));
    } else fail('advisories', 'malformed');

    // S3 drives five independent readers, each with its own share of the signals allocation.
    const signalLimits = limits(EVIDENCE_READ_ALLOCATION.signals, input);
    const { readers: shares } = EVIDENCE_READ_ALLOCATION.signals;
    const malware = createMalwareReader(limits(shares.malware, input), dependencies);
    const registry = createNpmRegistryReader(limits(shares.registry, input), dependencies);
    const times = createNpmPublishTimeReader(limits(shares.publishTimes, input), dependencies);
    const metadata = createPolicySignalReader(limits(shares.metadata, input), dependencies);
    const research = createUpstreamReader(limits(shares.upstream, input), dependencies);
    // The npm registry reader holds no timers or listeners, so it has nothing to close.
    for (const opened of [malware, times, metadata])
      if (opened.kind === 'ready') readers.push(opened);
    if (research.kind === 'ready') readers.push(research.reader);
    if (
      malware.kind === 'ready' &&
      registry.kind === 'ready' &&
      times.kind === 'ready' &&
      metadata.kind === 'ready' &&
      research.kind === 'ready'
    ) {
      const signals = await enrichPolicySignals(
        {
          binding: packet.binding,
          changes: current.changes,
          sources: current.sources,
          findings: current.findings,
          publicIdentities,
          actionVersions,
          evaluationTime: input.evaluationTime,
          limits: signalLimits,
        },
        {
          malwareReader: malware,
          npmReader: registry,
          publishTimeReader: times,
          metadataReader: metadata,
          upstreamReader: research.reader,
        },
      );
      if (signals.kind === 'enriched') {
        current = {
          changes: signals.changes,
          sources: signals.sources,
          findings: signals.findings,
        };
        signalAttempts = signals.attempts;
      } else fail('signals', failure(signals));
    } else fail('signals', 'malformed');

    const candidate = validateReviewPacket(
      {
        version: 1,
        binding: packet.binding,
        baseSha: packet.baseSha,
        contextRevision: packet.contextRevision,
        context: packet.context,
        coverage: packet.coverage,
        changes: current.changes,
        sources: current.sources,
        findings: current.findings,
        relationships: packet.relationships,
      },
      input.trusted,
    );
    if (!candidate.ok) {
      fail('revalidation', 'malformed');
      return {
        kind: 'ready',
        packet,
        unavailable,
        upstreamAttempts: [],
        signalAttempts: [],
      };
    }
    return {
      kind: 'ready',
      packet: candidate.packet,
      unavailable,
      upstreamAttempts,
      signalAttempts,
    };
  } catch {
    return { kind: 'internal-failure' };
  } finally {
    for (const reader of readers) {
      try {
        reader.close();
      } catch {
        // A close failure cannot change a result already computed.
      }
    }
  }
}
