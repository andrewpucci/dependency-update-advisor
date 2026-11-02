import type { ReviewBinding } from '../event.js';
import type { Finding } from '../policy.js';
import type {
  PacketChange,
  PacketSource,
  RelationshipProof,
  InventoryCoverage,
  UvSide,
  PacketRevision,
} from '../schema.js';
import { freeze, byCodeUnit } from './common.js';
import type { UvMetadata, UvGap, UvRootSnapshot } from './uv.js';
import type { UvPackage } from './uv-lock.js';
import { parseGraphInput, UvGraphFailure, boundedIdentity, type GraphWork } from './uv-input.js';

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
  return metadata.sources.map((s) => ({
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
function instance(p: UvPackage, root: UvRootSnapshot, side: 'base' | 'head'): UvSide | null {
  if (!p.external || p.version === null) return null;
  const marker = p.resolutionMarkers?.length
    ? JSON.stringify([...new Set(p.resolutionMarkers)].sort(byCodeUnit))
    : null;
  if (marker !== null && !boundedIdentity(marker)) return null;
  return {
    root: root.root,
    name: p.name,
    version: p.version,
    source: { kind: 'registry', identity: p.source.kind === 'registry' ? p.source.url : '' },
    marker,
    extras: [],
    groups: [],
    sourceId: root[side].lock.sourceId!,
  };
}
function direct(root: UvRootSnapshot, side: 'base' | 'head', p: UvPackage) {
  const snapshot = root[side],
    m = snapshot.manifest.data,
    l = snapshot.lock.data;
  if (!m || !l) return false;
  const self = l.packages.find((x) => !x.external);
  return (
    m.dependencies.some((d) => d.name === p.name && d.marker === null && !d.extras.length) &&
    !!self?.dependencies?.some(
      (s) =>
        s.name === p.name && (s.version === null || s.version === p.version) && s.marker === null,
    )
  );
}
function rootChanges(
  result: UvInventory,
  metadata: UvMetadata,
  root: UvRootSnapshot,
  work: GraphWork,
) {
  work.spend();
  if (root.base.state !== 'present' || root.head.state !== 'present') {
    addGap(result, { root: root.root, side: null, path: null, entry: null, reason: 'missing' });
    return;
  }
  const base = root.base.lock.data!.packages.filter((p) => p.external),
    head = root.head.lock.data!.packages.filter((p) => p.external);
  for (const name of [...new Set([...base, ...head].map((p) => p.name))].sort(byCodeUnit)) {
    work.spend();
    const old = base.filter((p) => p.name === name),
      next = head.filter((p) => p.name === name);
    if (old.length > 1 || next.length > 1) {
      addGap(result, {
        root: root.root,
        side: null,
        path: root.head.lock.path,
        entry: name,
        reason: 'unsupported',
      });
      continue;
    }
    const from = old[0] ? instance(old[0], root, 'base') : null,
      to = next[0] ? instance(next[0], root, 'head') : null;
    if (!from && !to) continue;
    if (
      from &&
      to &&
      JSON.stringify({ ...from, sourceId: '' }) === JSON.stringify({ ...to, sourceId: '' })
    )
      continue;
    const role =
      (!old[0] || direct(root, 'base', old[0])) && (!next[0] || direct(root, 'head', next[0]))
        ? 'direct'
        : 'unknown';
    const kind = from && to ? 'update' : to ? 'addition' : 'removal';
    const id = work.id('change', [
      metadata.binding.identity,
      metadata.binding.baseSha,
      root.root,
      kind,
      from,
      to,
    ]);
    const evidence = Object.fromEntries(
      ['upstream', 'vulnerability', 'malware'].map((category) => [
        category,
        { status: 'unavailable' as const, reasons: ['missing' as const], sourceIds: [] },
      ]),
    );
    result.changes.push({ id, ecosystem: 'uv', kind, role, from, to, evidence });
    for (const s of [from, to])
      if (s) result.sources.find((x) => x.id === s.sourceId)!.memberIds.push(id);
    if (role === 'unknown')
      addGap(result, {
        root: root.root,
        side: null,
        path: root.head.lock.path,
        entry: name,
        reason: 'unsupported',
      });
  }
}
function finish(result: UvInventory, metadata: UvMetadata, work: GraphWork, maxBytes: number) {
  result.changes.sort((a, b) => byCodeUnit(a.id, b.id));
  const reasons = [...new Set(result.gaps.map((g) => g.reason))].sort(byCodeUnit);
  const applicable = metadata.discovery.applicable || metadata.roots.length > 0;
  result.coverage = {
    status: reasons.length ? 'partial' : applicable ? 'complete' : 'not_applicable',
    reasons,
    sourceIds: result.sources
      .filter((s) => s.kind === 'file-list' || s.status === 'available')
      .map((s) => s.id)
      .sort(byCodeUnit),
  };
  for (const s of result.sources) s.memberIds.sort(byCodeUnit);
  work.spend(result.changes.length + result.sources.length + result.gaps.length);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new UvGraphFailure('budget');
  return freeze(result) as DeepReadonly<UvInventory>;
}
/** Pure reconciliation of authentic U1 snapshots; coverage, not kind, reports completeness. */
export function reconcileUvGraph(input: unknown): UvGraphResult {
  try {
    const { metadata, work, limits } = parseGraphInput(input);
    if (metadata.kind !== 'metadata') return freeze(metadata);
    const m = metadata as UvMetadata,
      result = initial(m, work);
    for (const root of m.roots) rootChanges(result, m, root, work);
    return finish(result, m, work, limits.maxRetainedBytes);
  } catch (error) {
    return error instanceof UvGraphFailure
      ? { kind: 'unavailable', reason: error.reason }
      : { kind: 'invalid' };
  }
}
