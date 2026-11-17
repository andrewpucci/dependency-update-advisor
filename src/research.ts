import {
  EVIDENCE_READ_ALLOCATION,
  EVIDENCE_READ_ENVELOPE,
  RESEARCH_CACHE_LIMITS,
} from './budget.js';
import type { GithubComparison } from './github-read.js';
import { enrichAdvisories } from './evidence/advisories.js';
import { createAdvisoryReader, createMalwareReader } from './evidence/advisory-read.js';
import { createNpmPublishTimeReader } from './evidence/npm-publish-times.js';
import { createNpmRegistryReader } from './evidence/npm-registry.js';
import { enrichPolicySignals } from './evidence/policy-signals.js';
import type { SignalAttempt } from './evidence/policy-signals.js';
import { createPolicySignalReader } from './evidence/policy-signals-read.js';
import type { PolicyMetadataReader } from './evidence/policy-signals-read.js';
import { enrichUpstream, type UpstreamAttempt } from './evidence/upstream.js';
import { createUpstreamReader } from './evidence/upstream-read.js';
import { createResearchCache, type ResearchCache } from './evidence/research-cache.js';
import type { NpmInventoryResult } from './evidence/npm.js';
import type { PacketChange, PacketExpected, PacketResult } from './schema.js';
import type { ChangeEvidence, EvidenceReason, NpmSide } from './schema.js';
import { isResearchPlaceholder, reconcilePacket } from './revalidation.js';

type Packet = Extract<PacketResult, { ok: true }>['packet'];
/** A packet change as the packet exposes it, which is readonly all the way down. */
type PacketChangeView = Packet['changes'][number];
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
/** A stage boundary reported to an optional observer; carries no request data. */
export type ResearchObservation =
  | Readonly<{ kind: 'stage-start'; stage: ResearchStage }>
  | Readonly<{
      kind: 'stage-end';
      stage: ResearchStage;
      outcome: 'enriched' | 'unavailable';
      reason: EvidenceReason | null;
    }>;
export type ResearchInput = Readonly<{
  packet: Packet;
  trusted: PacketExpected;
  /** The authentic npm inventory, needed for npm identity proofs; absent when no npm evidence ran. */
  npmInventory: NpmInventory | null;
  /** A complete D1 comparison, used only as additional advisory evidence. */
  comparison: GithubComparison | null;
  /** Credential-free fetch for public registries and advisory sources. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The run's research cache, shared with collection's registry reads; created here when absent. */
  cache?: ResearchCache;
  now: () => number;
  /** Absolute time, in `now` units, by which research must be finished. */
  deadline: number;
  evaluationTime: number;
  signal?: AbortSignal;
  /** Receives stage boundaries in order; its errors are ignored. */
  observe?: (observation: ResearchObservation) => void;
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

/** The categories each stage owns; a stage's failure marks only these placeholders. */
const STAGE_CATEGORIES: Record<ResearchStage, readonly string[]> = {
  upstream: ['upstream', 'installScript'],
  advisories: ['vulnerability'],
  signals: ['malware'],
  revalidation: [],
};

/** Replaces a failed stage's placeholders with the stage's reason; copies, never mutates. */
function markStage(progress: ResearchProgress, stage: ResearchStage, reason: EvidenceReason): void {
  progress.changes = (progress.changes as readonly PacketChange[]).map((change) => {
    if ('basis' in change) return change;
    const evidence: Record<string, ChangeEvidence> = { ...change.evidence };
    for (const category of STAGE_CATEGORIES[stage]) {
      if (isResearchPlaceholder(evidence[category]))
        evidence[category] = { status: 'unavailable', reasons: [reason], sourceIds: [] };
    }
    return { ...change, evidence };
  });
}

function installsScript(
  inventory: NpmInventory,
  side: NpmSide | null,
  revision: 'base' | 'head',
): boolean {
  if (!side) return false;
  const root = inventory.roots.find((candidate) => candidate.root === side.root);
  return root?.[revision].packages[side.lockPath]?.hasInstallScript === true;
}

/** Research order (§3.5): direct and added, then install scripts, then the rest; stable within each. */
export function researchOrder<T extends PacketChangeView>(
  changes: readonly T[],
  npmInventory: NpmInventory | null,
): T[] {
  const rank = (change: T): number => {
    if (change.role === 'direct' || change.kind === 'addition') return 0;
    if (
      npmInventory &&
      change.ecosystem === 'npm' &&
      !('basis' in change) &&
      (installsScript(npmInventory, change.from, 'base') ||
        installsScript(npmInventory, change.to, 'head'))
    )
      return 1;
    return 2;
  };
  return [...changes].sort((a, b) => rank(a) - rank(b));
}

/** Puts the changes back in the packet's own order, so the returned packet keeps its shape. */
function restorePacketOrder(progress: ResearchProgress, packet: Packet): void {
  const position = new Map(packet.changes.map((change, index) => [change.id, index]));
  progress.changes = [...(progress.changes as readonly PacketChange[])].sort(
    (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
  );
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
  pypiReader?: PolicyMetadataReader,
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
    { reader: opened.reader, ...(pypiReader ? { pypiReader } : {}) },
  );
  if (upstream.kind !== 'enriched') return fail('upstream', failure(upstream));
  replaceEvidence(progress, upstream);
  progress.publicIdentities = upstream.publicIdentities;
  progress.actionVersions = upstream.actionVersions;
  progress.upstreamAttempts = upstream.attempts;
  if (upstream.stopped) fail('upstream', upstream.stopped);
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
  if (advisories.stopped) fail('advisories', advisories.stopped);
}

async function enrichSignalsStage(
  input: ResearchInput,
  dependencies: Pick<ResearchInput, 'now' | 'fetch' | 'signal'>,
  readers: Reader[],
  progress: ResearchProgress,
  fail: Fail,
  metadata: PolicyMetadataReader | null,
): Promise<void> {
  const limitsForStage = limits(EVIDENCE_READ_ALLOCATION.signals, input);
  const { readers: shares } = EVIDENCE_READ_ALLOCATION.signals;
  const malware = createMalwareReader(limits(shares.malware, input), dependencies);
  const registry = createNpmRegistryReader(limits(shares.registry, input), dependencies);
  const times = createNpmPublishTimeReader(limits(shares.publishTimes, input), dependencies);
  const upstream = createUpstreamReader(limits(shares.upstream, input), dependencies);
  // The npm registry reader holds no timers or listeners, so it has nothing to close.
  for (const opened of [malware, times]) if (opened.kind === 'ready') readers.push(opened);
  if (upstream.kind === 'ready') readers.push(upstream.reader);
  if (
    malware.kind !== 'ready' ||
    registry.kind !== 'ready' ||
    times.kind !== 'ready' ||
    !metadata ||
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

/**
 * Runs upstream research, advisory lookup, and policy signals over a validated packet, feeding each
 * stage's proofs and sources to the next. A stage that cannot be established leaves the evidence as
 * collected, so research is never reported as complete without its own result; the enriched packet
 * is reconciled per member, and only the members whose research fails validation revert.
 */
export async function runResearch(input: ResearchInput): Promise<ResearchResult> {
  const dependencies = {
    now: input.now,
    fetch: input.fetch,
    signal: input.signal,
    cache: input.cache ?? createResearchCache(RESEARCH_CACHE_LIMITS),
  };
  const unavailable: { stage: ResearchStage; reason: EvidenceReason }[] = [];
  const readers: Reader[] = [];
  const observe = (observation: ResearchObservation) => {
    try {
      input.observe?.(observation);
    } catch {
      // An observer cannot change the research result.
    }
  };
  const runStage = async (stage: ResearchStage, run: () => Promise<void>) => {
    observe({ kind: 'stage-start', stage });
    const before = unavailable.length;
    await run();
    const failed = unavailable.slice(before).find((entry) => entry.stage === stage);
    observe(
      failed
        ? { kind: 'stage-end', stage, outcome: 'unavailable', reason: failed.reason }
        : { kind: 'stage-end', stage, outcome: 'enriched', reason: null },
    );
  };
  try {
    const { packet } = input;
    const progress: ResearchProgress = {
      changes: researchOrder(packet.changes, input.npmInventory),
      sources: packet.sources,
      findings: packet.findings,
      publicIdentities: [],
      actionVersions: [],
      upstreamAttempts: [],
      signalAttempts: [],
    };
    const fail = (stage: ResearchStage, reason: EvidenceReason) => {
      unavailable.push({ stage, reason });
      markStage(progress, stage, reason);
    };
    const metadata = createPolicySignalReader(
      limits(EVIDENCE_READ_ALLOCATION.signals.readers.metadata, input),
      dependencies,
    );
    const sharedMetadata = metadata.kind === 'ready' ? metadata : null;
    if (sharedMetadata) readers.push(sharedMetadata);
    await runStage('upstream', () =>
      enrichUpstreamStage(
        input,
        dependencies,
        readers,
        progress,
        fail,
        sharedMetadata ?? undefined,
      ),
    );
    await runStage('advisories', () =>
      enrichAdvisoryStage(input, dependencies, readers, progress, fail),
    );
    await runStage('signals', () =>
      enrichSignalsStage(input, dependencies, readers, progress, fail, sharedMetadata),
    );

    restorePacketOrder(progress, packet);
    observe({ kind: 'stage-start', stage: 'revalidation' });
    const reconciled = reconcilePacket({
      collected: packet,
      enriched: progress,
      trusted: input.trusted,
      priority: researchOrder(packet.changes, input.npmInventory).map((change) => change.id),
    });
    for (const reason of reconciled.reasons) unavailable.push({ stage: 'revalidation', reason });
    observe(
      reconciled.reasons.length === 0
        ? { kind: 'stage-end', stage: 'revalidation', outcome: 'enriched', reason: null }
        : {
            kind: 'stage-end',
            stage: 'revalidation',
            outcome: 'unavailable',
            reason: reconciled.reasons[0] ?? null,
          },
    );
    return {
      kind: 'ready',
      packet: reconciled.packet,
      unavailable,
      upstreamAttempts: reconciled.whole ? [] : progress.upstreamAttempts,
      signalAttempts: reconciled.whole ? [] : progress.signalAttempts,
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
