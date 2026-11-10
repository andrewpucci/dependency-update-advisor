import { EVIDENCE_READ_ALLOCATION, EVIDENCE_READ_ENVELOPE } from './budget.js';
import { collectorRoots, type DependabotRootsOutcome } from './dependabot-roots.js';
import type { ReviewBinding } from './event.js';
import { collectActionsInventory } from './evidence/actions.js';
import { collectNpmInventory } from './evidence/npm.js';
import { enrichNpmEvidence } from './evidence/npm-graph.js';
import { collectUvMetadata } from './evidence/uv.js';
import { reconcileUvGraph } from './evidence/uv-graph.js';
import { createGithubReadSession, type GithubReadSession } from './github-read.js';
import type { Ecosystem, EvidenceReason } from './schema.js';

/**
 * Reader limits inside the envelope split (see `EVIDENCE_READ_ALLOCATION`); every reader's time is
 * what remains of the 240,000 ms total. Parse and retention limits reuse the values the reader
 * integration tests use.
 */
export const W2_EVIDENCE_LIMITS = Object.freeze({
  session: Object.freeze({
    maxRequests: EVIDENCE_READ_ALLOCATION.session.maxRequests,
    maxPages: 10,
    maxFiles: 1_000,
    maxJsonEntries: 200_000,
    maxResponseBytes: EVIDENCE_READ_ENVELOPE.maxResponseBytes,
    maxFileBytes: 500_000,
    maxTotalBytes: EVIDENCE_READ_ALLOCATION.session.maxTotalBytes,
    maxRetainedBytes: 2_000_000,
    requestTimeoutMs: EVIDENCE_READ_ENVELOPE.requestTimeoutMs,
  }),
  npm: Object.freeze({
    maxFileBytes: 500_000,
    maxJsonDepth: 32,
    maxJsonEntries: 100_000,
    maxRoots: 10,
    maxRetainedBytes: 2_000_000,
  }),
  actions: Object.freeze({
    maxFileBytes: 100_000,
    maxWorkflows: 20,
    maxYamlNodes: 100_000,
    maxYamlDepth: 32,
    maxAliasExpansions: 100,
    maxOccurrences: 1_000,
    maxRetainedBytes: 2_000_000,
  }),
  uv: Object.freeze({
    maxFileBytes: 100_000,
    maxTomlDepth: 32,
    maxTomlEntries: 100_000,
    maxPackages: 1_000,
    maxDeclarations: 1_000,
    maxEdges: 1_000,
    maxStringBytes: 4_096,
    maxRequirementTokens: 200,
    maxMarkerDepth: 16,
    maxRoots: 20,
    maxRetainedBytes: 1_000_000,
  }),
  graph: Object.freeze({ maxGraphWork: 500_000, maxRetainedBytes: 2_000_000 }),
  registry: Object.freeze({
    maxRequests: EVIDENCE_READ_ALLOCATION.registry.maxRequests,
    maxResponseBytes: EVIDENCE_READ_ENVELOPE.maxResponseBytes,
    maxTotalBytes: EVIDENCE_READ_ALLOCATION.registry.maxTotalBytes,
    maxJsonEntries: 100_000,
    maxJsonDepth: 32,
    requestTimeoutMs: EVIDENCE_READ_ENVELOPE.requestTimeoutMs,
  }),
  totalTimeoutMs: EVIDENCE_READ_ENVELOPE.totalTimeoutMs,
});

type Clock = () => number;
export type EvidenceSessionResult =
  | Readonly<{ kind: 'ready'; session: GithubReadSession }>
  | Readonly<{ kind: 'obsolete' }>
  | Readonly<{ kind: 'unavailable' }>;
export type CollectionInput = Readonly<{
  binding: ReviewBinding;
  /** Carries the trusted snapshot's revision, which becomes the collectors' `configRevision`. */
  dependabot: DependabotRootsOutcome;
  /** Credential-free registry fetch; never receives the GitHub token. */
  registryFetch: (url: string, init: RequestInit) => Promise<Response>;
  now: Clock;
  /** Receives the authentic npm inventory, which upstream research needs for npm identity proofs. */
  onNpmInventory?: (inventory: unknown) => void;
  /** Absolute time, in `now` units, by which pre-analysis evidence must be finished. */
  deadline: number;
  signal?: AbortSignal;
}>;
type Fragment = Readonly<{
  kind: 'complete';
  ecosystem: Ecosystem;
  coverage: unknown;
  changes: readonly unknown[];
  sources: readonly unknown[];
  findings: readonly unknown[];
  relationships: readonly unknown[];
}>;
type Unavailable = Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;
type Collector = (session: GithubReadSession) => Promise<Fragment | Unavailable>;

/** A request may not be allowed longer than the whole read, so near the deadline both shrink. */
function timeouts(requestTimeoutMs: number, left: number) {
  const totalTimeoutMs = Math.min(W2_EVIDENCE_LIMITS.totalTimeoutMs, left);
  return { totalTimeoutMs, requestTimeoutMs: Math.min(requestTimeoutMs, totalTimeoutMs) };
}

/** Why a reader produced no inventory: its own reason, malformed input, or evidence that moved. */
function noInventory(result: { kind: string; reason?: EvidenceReason }): Unavailable {
  if (result.kind === 'unavailable' && result.reason)
    return { kind: 'unavailable', reason: result.reason };
  return { kind: 'unavailable', reason: result.kind === 'obsolete' ? 'conflict' : 'malformed' };
}

const remaining = (input: Pick<CollectionInput, 'now' | 'deadline'>) =>
  Math.max(1, Math.floor(input.deadline - input.now()));

/** Opens the owner-bound GitHub evidence session inside the envelope. */
export async function openEvidenceSession(
  input: Pick<CollectionInput, 'binding' | 'now' | 'deadline'> &
    Readonly<{ fetch: (url: string, init: RequestInit) => Promise<Response> }>,
): Promise<EvidenceSessionResult> {
  const opened = await createGithubReadSession(
    {
      binding: input.binding,
      limits: {
        ...W2_EVIDENCE_LIMITS.session,
        ...timeouts(W2_EVIDENCE_LIMITS.session.requestTimeoutMs, remaining(input)),
      },
    },
    { fetch: input.fetch, now: input.now },
  );
  if (opened.kind === 'ready') return { kind: 'ready', session: opened.session };
  return opened.kind === 'obsolete' ? { kind: 'obsolete' } : { kind: 'unavailable' };
}

/** A configured-roots failure is a visible coverage gap, never an empty or skipped ecosystem. */
function gapFragment(
  binding: ReviewBinding,
  ecosystem: Ecosystem,
  reason: EvidenceReason,
): Fragment {
  const id = `${ecosystem}-roots-gap`;
  return {
    kind: 'complete',
    ecosystem,
    coverage: { status: 'unavailable', reasons: [reason], sourceIds: [id] },
    changes: [],
    sources: [
      {
        id,
        kind: 'file-list',
        ecosystems: [ecosystem],
        memberIds: [],
        status: 'unavailable',
        reasons: [reason],
        provenance: {
          kind: 'inventory',
          repository: binding.repository,
          baseSha: binding.baseSha,
          headSha: binding.headSha,
          absentEcosystems: [],
        },
      },
    ],
    findings: [],
    relationships: [],
  };
}

/**
 * Adapts the N1/N2, X1, and U2 collectors to T4 fragments. A collector that produces no
 * usable inventory yields `unavailable`, which assembly reports as incomplete; it is never mapped
 * to an empty or complete fragment.
 */
export function createEvidenceCollectors(
  input: CollectionInput,
): Readonly<Record<Ecosystem, Collector>> {
  const { binding } = input;

  const npm: Collector = async (session) => {
    const roots = collectorRoots(input.dependabot, 'npm');
    if (roots.kind === 'unavailable') return gapFragment(binding, 'npm', roots.reason);
    const inventory = await collectNpmInventory(
      {
        binding,
        roots: [...roots.roots],
        configRevision: roots.configRevision,
        limits: { ...W2_EVIDENCE_LIMITS.npm },
      },
      { session },
    );
    if (inventory.kind !== 'inventory') return noInventory(inventory);
    input.onNpmInventory?.(inventory);
    const total = remaining(input);
    const enriched = await enrichNpmEvidence(
      {
        inventory,
        binding,
        limits: {
          ...W2_EVIDENCE_LIMITS.graph,
          ...W2_EVIDENCE_LIMITS.registry,
          ...timeouts(W2_EVIDENCE_LIMITS.registry.requestTimeoutMs, total),
        },
      },
      { fetch: input.registryFetch, now: input.now, signal: input.signal },
    );
    if (enriched.kind !== 'inventory') return noInventory(enriched);
    return {
      kind: 'complete',
      ecosystem: 'npm',
      coverage: enriched.coverage,
      changes: enriched.changes,
      sources: enriched.sources,
      findings: enriched.findings,
      relationships: enriched.relationships,
    };
  };

  const actions: Collector = async (session) => {
    const inventory = await collectActionsInventory(
      { binding, limits: { ...W2_EVIDENCE_LIMITS.actions } },
      { session },
    );
    if (inventory.kind !== 'inventory') return noInventory(inventory);
    return {
      kind: 'complete',
      ecosystem: 'actions',
      coverage: inventory.coverage,
      changes: inventory.changes,
      sources: inventory.sources,
      findings: [],
      relationships: [],
    };
  };

  const uv: Collector = async (session) => {
    const roots = collectorRoots(input.dependabot, 'uv');
    if (roots.kind === 'unavailable') return gapFragment(binding, 'uv', roots.reason);
    const metadata = await collectUvMetadata(
      {
        binding,
        roots: [...roots.roots],
        configRevision: roots.configRevision,
        limits: { ...W2_EVIDENCE_LIMITS.uv },
      },
      { session },
    );
    if (metadata.kind !== 'metadata') return noInventory(metadata);
    const graph = reconcileUvGraph({
      binding,
      metadata,
      limits: { ...W2_EVIDENCE_LIMITS.graph },
    });
    if (graph.kind !== 'inventory') return noInventory(graph);
    return {
      kind: 'complete',
      ecosystem: 'uv',
      coverage: graph.coverage,
      changes: graph.changes,
      sources: graph.sources,
      findings: graph.findings,
      relationships: graph.relationships,
    };
  };

  return Object.freeze({ npm, actions, uv });
}
