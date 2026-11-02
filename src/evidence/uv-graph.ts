import type { ReviewBinding } from '../event.js';
import type { Finding } from '../policy.js';
import type {
  PacketChange,
  PacketSource,
  RelationshipProof,
  InventoryCoverage,
  PacketRevision,
} from '../schema.js';
import { freeze } from './common.js';
import type { UvMetadata, UvGap, UvRootSnapshot } from './uv.js';
import { uvRootInventory } from './uv-inventory.js';
import { finishUvOutput } from './uv-output.js';
import { parseGraphInput, UvGraphFailure, type GraphWork } from './uv-input.js';

export type UvChange = Extract<PacketChange, { ecosystem: 'uv' }>;
export type UvObservation = {
  kind: 'package' | 'declaration' | 'metadata' | 'relationship' | 'corroboration';
  root: string | null;
  side: 'base' | 'head' | null;
  path: string | null;
  entry: string | null;
  reason: string;
  sourceIds: string[];
  memberIds: string[];
  value: unknown;
  nextAction: string;
};
export type UvGraphGap = UvGap & { nextAction: string };
export type UvInventory = {
  kind: 'inventory';
  binding: ReviewBinding;
  configRevision: PacketRevision;
  changes: UvChange[];
  sources: PacketSource[];
  fileIdentities: UvMetadata['sources'];
  relationships: RelationshipProof[];
  findings: Finding[];
  gaps: UvGraphGap[];
  observations: UvObservation[];
  coverage: InventoryCoverage;
  comparison: UvMetadata['comparison'];
  corroboration: {
    status: 'unattempted' | 'available' | 'unavailable' | 'partial';
    reasons: string[];
  };
};
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type UvGraphResult =
  | DeepReadonly<UvInventory>
  | { readonly kind: 'invalid' | 'obsolete' }
  | { readonly kind: 'unavailable'; readonly reason: UvGap['reason'] };
export function addGap(result: UvInventory, gap: UvGap) {
  if (
    !result.gaps.some(
      (g) =>
        JSON.stringify([g.root, g.side, g.path, g.entry, g.reason]) ===
        JSON.stringify([gap.root, gap.side, gap.path, gap.entry, gap.reason]),
    )
  )
    result.gaps.push({
      ...gap,
      nextAction: 'Inspect the cited immutable uv metadata and resolve the incomplete scope.',
    });
}
function fileSources(metadata: UvMetadata): PacketSource[] {
  return metadata.sources
    .filter((s) => s.kind !== 'absence')
    .map((s) => ({
      id: s.id,
      kind: 'file',
      ecosystems: ['uv'],
      memberIds: [],
      status: s.kind === 'absence' ? 'unavailable' : s.status,
      reasons: s.kind === 'absence' ? ['missing'] : s.reasons,
      provenance:
        s.kind === 'absence'
          ? { kind: 'unavailable' }
          : {
              kind: 'file',
              revision: s.side,
              repository: s.repository,
              sha: s.commitSha,
              path: s.path,
            },
    }));
}
function initial(metadata: UvMetadata, work: GraphWork): UvInventory {
  const b = metadata.binding;
  const discovery: PacketSource = {
    id: work.id('inventory', [b.identity, b.baseSha, metadata.discovery]),
    kind: 'file-list',
    ecosystems: ['uv'],
    memberIds: [],
    status: metadata.discovery.complete
      ? 'available'
      : metadata.discovery.status === 'available'
        ? 'partial'
        : metadata.discovery.status,
    reasons: metadata.discovery.complete
      ? []
      : metadata.discovery.reasons.length
        ? metadata.discovery.reasons
        : ['unknown'],
    provenance: {
      kind: 'inventory',
      repository: b.repository,
      baseSha: b.baseSha,
      headSha: b.headSha,
      absentEcosystems: metadata.discovery.complete && !metadata.discovery.applicable ? ['uv'] : [],
    },
  };
  const result: UvInventory = {
    kind: 'inventory',
    binding: b,
    configRevision: metadata.configRevision,
    changes: [],
    sources: [discovery, ...fileSources(metadata)],
    fileIdentities: metadata.sources,
    relationships: [],
    findings: [],
    gaps: [],
    observations: [],
    coverage: { status: 'partial', reasons: ['unknown'], sourceIds: [discovery.id] },
    comparison: metadata.comparison,
    corroboration: { status: 'unattempted', reasons: [] },
  };
  for (const gap of metadata.gaps) addGap(result, gap);
  if (!metadata.discovery.complete && !metadata.gaps.length)
    addGap(result, { root: null, side: null, path: null, entry: null, reason: 'unknown' });
  return result;
}
function rootChanges(
  result: UvInventory,
  metadata: UvMetadata,
  root: UvRootSnapshot,
  work: GraphWork,
) {
  const inventory = uvRootInventory(metadata, root, work);
  result.changes.push(...inventory.changes);
  for (const gap of inventory.gaps) addGap(result, gap);
  result.observations.push(...inventory.observations);
  for (const change of inventory.changes)
    for (const side of [change.from, change.to])
      if (side) {
        const source = result.sources.find((s) => s.id === side.sourceId)!;
        if (source.status === 'available') source.memberIds.push(change.id);
        else {
          if (source.status !== 'partial' || source.provenance.kind !== 'file')
            throw new UvGraphFailure('conflict');
          const id = work.id('validated-file', [source.id, change.id]);
          result.sources.push({
            ...source,
            id,
            status: 'available',
            reasons: [],
            memberIds: [change.id],
          });
          side.sourceId = id;
        }
      }
}
/** Pure reconciliation of authentic U1 snapshots; coverage, not kind, reports completeness. */
export function reconcileUvGraph(input: unknown): UvGraphResult {
  try {
    const { metadata, work, limits } = parseGraphInput(input);
    if (metadata.kind !== 'metadata') return freeze(metadata);
    const m = metadata as UvMetadata,
      result = initial(m, work);
    for (const root of m.roots) rootChanges(result, m, root, work);
    return finishUvOutput(result, m, work, limits.maxRetainedBytes);
  } catch (error) {
    return error instanceof UvGraphFailure
      ? { kind: 'unavailable', reason: error.reason }
      : { kind: 'invalid' };
  }
}
