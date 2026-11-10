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
type EnrichedEvidence = { changes: unknown; sources: unknown; findings: unknown };
type ResearchProgress = EnrichedEvidence & {
  publicIdentities: unknown;
  actionVersions: unknown;
  upstreamAttempts: readonly UpstreamAttempt[];
  signalAttempts: readonly SignalAttempt[];
};
type Reader = { close: () => void };
type Fail = (stage: ResearchStage, reason: EvidenceReason) => void;
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

function failure(result: { kind: string; reason?: EvidenceReason }): EvidenceReason {
  return result.kind === 'unavailable' && result.reason ? result.reason : 'malformed';
}

function replaceEvidence(progress: ResearchProgress, evidence: EnrichedEvidence): void {
  progress.changes = evidence.changes;
  progress.sources = evidence.sources;
  progress.findings = evidence.findings;
}

async function enrichUpstreamStage(
  input: ResearchInput,
  dependencies: Pick<ResearchInput, 'now' | 'fetch' | 'signal'>,
  readers: Reader[],
  progress: ResearchProgress,
  fail: Fail,
): Promise<void> {
  const limitsForStage = limits(EVIDENCE_READ_ALLOCATION.upstream, input);
  const opened = createUpstreamReader(limitsForStage, dependencies);
  if (opened.kind !== 'ready') return fail('upstream', 'malformed');
  readers.push(opened.reader);
  const upstream = await enrichUpstream(
    {
      binding: input.packet.binding,
      changes: progress.changes,
      sources: progress.sources,
      findings: progress.findings,
      limits: limitsForStage,
      ...(input.npmInventory ? { npmInventory: input.npmInventory } : {}),
    },
    { reader: opened.reader },
  );
  if (upstream.kind !== 'enriched') return fail('upstream', failure(upstream));
  replaceEvidence(progress, upstream);
  progress.publicIdentities = upstream.publicIdentities;
  progress.actionVersions = upstream.actionVersions;
  progress.upstreamAttempts = upstream.attempts;
}

async function enrichAdvisoryStage(
  input: ResearchInput,
  dependencies: Pick<ResearchInput, 'now' | 'fetch' | 'signal'>,
  readers: Reader[],
  progress: ResearchProgress,
  fail: Fail,
): Promise<void> {
  const limitsForStage = limits(EVIDENCE_READ_ALLOCATION.advisory, input);
  const opened = createAdvisoryReader(limitsForStage, dependencies);
  if (opened.kind !== 'ready') return fail('advisories', 'malformed');
  readers.push(opened);
  const advisories = await enrichAdvisories(
    {
      binding: input.packet.binding,
      changes: progress.changes,
      sources: progress.sources,
      findings: progress.findings,
      publicIdentities: progress.publicIdentities,
      actionVersions: progress.actionVersions,
      limits: limitsForStage,
      ...(input.comparison?.kind === 'available' ? { comparisons: [input.comparison] } : {}),
    } as never,
    { reader: opened },
  );
  if (advisories.kind !== 'enriched') return fail('advisories', failure(advisories));
  replaceEvidence(progress, advisories);
}

async function enrichSignalsStage(
  input: ResearchInput,
  dependencies: Pick<ResearchInput, 'now' | 'fetch' | 'signal'>,
  readers: Reader[],
  progress: ResearchProgress,
  fail: Fail,
): Promise<void> {
  const limitsForStage = limits(EVIDENCE_READ_ALLOCATION.signals, input);
  const { readers: shares } = EVIDENCE_READ_ALLOCATION.signals;
  const malware = createMalwareReader(limits(shares.malware, input), dependencies);
  const registry = createNpmRegistryReader(limits(shares.registry, input), dependencies);
  const times = createNpmPublishTimeReader(limits(shares.publishTimes, input), dependencies);
  const metadata = createPolicySignalReader(limits(shares.metadata, input), dependencies);
  const upstream = createUpstreamReader(limits(shares.upstream, input), dependencies);
  // The npm registry reader holds no timers or listeners, so it has nothing to close.
  for (const opened of [malware, times, metadata])
    if (opened.kind === 'ready') readers.push(opened);
  if (upstream.kind === 'ready') readers.push(upstream.reader);
  if (
    malware.kind !== 'ready' ||
    registry.kind !== 'ready' ||
    times.kind !== 'ready' ||
    metadata.kind !== 'ready' ||
    upstream.kind !== 'ready'
  )
    return fail('signals', 'malformed');
  const signals = await enrichPolicySignals(
    {
      binding: input.packet.binding,
      changes: progress.changes,
      sources: progress.sources,
      findings: progress.findings,
      publicIdentities: progress.publicIdentities,
      actionVersions: progress.actionVersions,
      evaluationTime: input.evaluationTime,
      limits: limitsForStage,
    },
    {
      malwareReader: malware,
      npmReader: registry,
      publishTimeReader: times,
      metadataReader: metadata,
      upstreamReader: upstream.reader,
    },
  );
  if (signals.kind !== 'enriched') return fail('signals', failure(signals));
  replaceEvidence(progress, signals);
  progress.signalAttempts = signals.attempts;
}

function revalidate(input: ResearchInput, progress: ResearchProgress) {
  const { packet } = input;
  return validateReviewPacket(
    {
      version: 1,
      binding: packet.binding,
      baseSha: packet.baseSha,
      contextRevision: packet.contextRevision,
      context: packet.context,
      coverage: packet.coverage,
      changes: progress.changes,
      sources: progress.sources,
      findings: progress.findings,
      relationships: packet.relationships,
    },
    input.trusted,
  );
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
  const readers: Reader[] = [];
  try {
    const { packet } = input;
    const progress: ResearchProgress = {
      changes: packet.changes,
      sources: packet.sources,
      findings: packet.findings,
      publicIdentities: [],
      actionVersions: [],
      upstreamAttempts: [],
      signalAttempts: [],
    };
    const fail = (stage: ResearchStage, reason: EvidenceReason) =>
      unavailable.push({ stage, reason });
    await enrichUpstreamStage(input, dependencies, readers, progress, fail);
    await enrichAdvisoryStage(input, dependencies, readers, progress, fail);
    await enrichSignalsStage(input, dependencies, readers, progress, fail);

    const candidate = revalidate(input, progress);
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
      upstreamAttempts: progress.upstreamAttempts,
      signalAttempts: progress.signalAttempts,
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
