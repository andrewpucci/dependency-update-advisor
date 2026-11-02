import { isDeepStrictEqual } from 'node:util';
import type { UvSide } from '../schema.js';
import { PACKET_LIMITS } from '../schema.js';
import { byCodeUnit } from './common.js';
import type { UvMetadata, UvRootSnapshot, UvGap } from './uv.js';
import type { GraphWork } from './uv-input.js';
import { boundedIdentity } from './uv-input.js';
import type { UvChange, UvObservation } from './uv-graph.js';
import {
  uvRoles,
  uvDeclarationChanges,
  resolveUvSelector,
  type UvRoles,
  type UvRoleNode,
} from './uv-roles.js';
import type { UvSelector } from './uv-lock.js';

export type UvInstance = { key: string; side: UvSide; node: UvRoleNode; available: boolean };
function packageTableComplete(metadata: UvMetadata, root: UvRootSnapshot, side: 'base' | 'head') {
  const file = root[side].lock;
  if (file.state === 'present') return true;
  if (file.state !== 'partial' || !file.data) return false;
  const gaps = metadata.gaps.filter(
    (g) => g.root === root.root && g.side === side && g.path === file.path,
  );
  // Artifacts do not participate in identity, declaration mapping, or graph selectors.
  return (
    gaps.length > 0 &&
    gaps.every((g) => file.data!.packages.some((p) => g.entry === `${p.key}:artifacts`))
  );
}
export function uvInstance(
  node: UvRoleNode,
  root: UvRootSnapshot,
  side: 'base' | 'head',
): UvSide | null {
  const p = node.pkg;
  if (!p.external || p.version === null || p.source.kind !== 'registry') return null;
  const marker = p.resolutionMarkers?.length
    ? JSON.stringify([...new Set(p.resolutionMarkers)].sort(byCodeUnit))
    : null;
  if (
    ![p.name, p.version, p.source.url, ...node.extras].every(boundedIdentity) ||
    (marker !== null && !boundedIdentity(marker)) ||
    node.extras.length > PACKET_LIMITS.listEntries
  )
    return null;
  return {
    root: root.root,
    name: p.name,
    version: p.version,
    source: { kind: 'registry', identity: p.source.url },
    marker,
    extras: node.extras,
    groups: [],
    sourceId: root[side].lock.sourceId!,
  };
}
export function uvSemantic(side: UvSide) {
  const { sourceId: _, ...identity } = side;
  return JSON.stringify(identity);
}
function family(row: UvInstance) {
  const s = row.side;
  return JSON.stringify([s.root, s.name, s.source, s.marker]);
}
function note(
  root: UvRootSnapshot,
  side: 'base' | 'head' | null,
  reason: string,
  value: unknown,
  entry: string | null = null,
): UvObservation {
  return {
    kind: 'package',
    root: root.root,
    side,
    path: (side ? root[side] : root.head).lock.path,
    entry,
    reason,
    sourceIds: side && root[side].lock.sourceId ? [root[side].lock.sourceId!] : [],
    memberIds: [],
    value,
    nextAction: 'Review the exact recorded variants; do not infer a migration pair.',
  };
}
function records(
  root: UvRootSnapshot,
  side: 'base' | 'head',
  roles: UvRoles,
  work: GraphWork,
  gaps: UvGap[],
  observations: UvObservation[],
) {
  const rows: UvInstance[] = [];
  for (const [key, node] of roles.nodes) {
    work.spend();
    const value = uvInstance(node, root, side);
    observations.push(
      note(
        root,
        side,
        'recorded_package',
        {
          package: node.pkg,
          extras: node.extras,
          membershipComplete: node.membershipComplete,
          role: node.role,
        },
        key,
      ),
    );
    if (value) rows.push({ key, side: value, node, available: roles.tableComplete });
    else
      gaps.push({
        root: root.root,
        side,
        path: root[side].lock.path,
        entry: key,
        reason: 'unsupported',
      });
  }
  return rows.sort((a, b) => byCodeUnit(uvSemantic(a.side), uvSemantic(b.side)));
}
function change(
  metadata: UvMetadata,
  root: UvRootSnapshot,
  from: UvInstance | null,
  to: UvInstance | null,
  work: GraphWork,
): UvChange {
  const kind = from && to ? 'update' : to ? 'addition' : 'removal';
  const role =
    from && to
      ? from.node.role === to.node.role
        ? from.node.role
        : 'unknown'
      : (from ?? to)!.node.role;
  const a = from?.side ?? null,
    b = to?.side ?? null;
  const id = work.id('change', [
    metadata.binding.identity,
    metadata.binding.baseSha,
    root.root,
    kind,
    a,
    b,
  ]);
  const evidence = Object.fromEntries(
    ['upstream', 'vulnerability', 'malware'].map((c) => [
      c,
      { status: 'unavailable' as const, reasons: ['missing' as const], sourceIds: [] },
    ]),
  );
  return { id, ecosystem: 'uv', kind, role, from: a, to: b, evidence };
}
function tablesComplete(root: UvRootSnapshot, side: 'base' | 'head') {
  return root[side].state === 'absent' || root[side].lock.state === 'present';
}
function unmatched(
  metadata: UvMetadata,
  root: UvRootSnapshot,
  base: UvInstance[],
  head: UvInstance[],
  work: GraphWork,
  changes: UvChange[],
  observations: UvObservation[],
  complete: { base: boolean; head: boolean },
) {
  const families = [...new Set([...base, ...head].map(family))].sort(byCodeUnit);
  for (const key of families) {
    work.spend(base.length + head.length);
    const a = base.filter((r) => family(r) === key),
      b = head.filter((r) => family(r) === key);
    if (
      a.length === 1 &&
      b.length === 1 &&
      a[0].available &&
      b[0].available &&
      complete.base &&
      complete.head
    ) {
      changes.push(change(metadata, root, a[0], b[0], work));
      continue;
    }
    if ((a.length > 1 && b.length) || (b.length > 1 && a.length))
      observations.push(
        note(
          root,
          null,
          'ambiguous_pairing',
          { base: a.map((r) => r.key), head: b.map((r) => r.key) },
          key,
        ),
      );
    for (const row of a)
      if (row.available && complete.head) changes.push(change(metadata, root, row, null, work));
    for (const row of b)
      if (row.available && complete.base) changes.push(change(metadata, root, null, row, work));
  }
}
function edges(node: UvRoleNode) {
  const selector = (s: NonNullable<UvRoleNode['pkg']['dependencies']>[number]) =>
    JSON.stringify([s.name, s.version, s.source, s.marker, s.extra ?? []]);
  return {
    ordinary: (node.pkg.dependencies ?? []).map(selector).sort(byCodeUnit),
    optional: (node.pkg.optionalDependencies ?? [])
      .filter((e) => e.declarations.length)
      .map((e) => [e.extra, e.declarations.map(selector).sort(byCodeUnit)])
      .sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b))),
  };
}
function metadataChanges(
  root: UvRootSnapshot,
  base: UvInstance[],
  head: UvInstance[],
  gaps: UvGap[],
  observations: UvObservation[],
  work: GraphWork,
) {
  const record = (entry: string, value: unknown) => {
    gaps.push({
      root: root.root,
      side: null,
      path: root.head.lock.path,
      entry,
      reason: 'unsupported',
    });
    observations.push({
      ...note(root, null, 'unrepresented_metadata', value, entry),
      kind: 'metadata',
    });
  };
  for (const old of base) {
    work.spend(head.length);
    const next = head.find((r) => r.key === old.key);
    if (!next) continue;
    if (!isDeepStrictEqual(edges(old.node), edges(next.node)))
      record(old.key, { base: edges(old.node), head: edges(next.node) });
    if (old.node.role !== next.node.role)
      record(`${old.key}:role`, { base: old.node.role, head: next.node.role });
  }
  const context = (side: 'base' | 'head') => ({
    python: root[side].lock.data?.requiresPython ?? null,
    markers: [...(root[side].lock.data?.resolutionMarkers ?? [])].sort(byCodeUnit),
  });
  if (
    root.base.lock.data &&
    root.head.lock.data &&
    !isDeepStrictEqual(context('base'), context('head'))
  )
    record('root-resolution', { base: context('base'), head: context('head') });
  const empty = (side: 'base' | 'head') =>
    root[side].manifest.data?.optionalDependencies
      .filter((e) => !e.declarations.length)
      .map((e) => e.extra)
      .sort(byCodeUnit) ?? [];
  if (!isDeepStrictEqual(empty('base'), empty('head')))
    record('empty-extras', { base: empty('base'), head: empty('head') });
}
function selfEdges(root: UvRootSnapshot, side: 'base' | 'head', work: GraphWork) {
  const self = root[side].lock.data?.packages.find((p) => !p.external);
  const edges: { scope: string | null; selector: UvSelector; target: string | null }[] = [];
  const record = (scope: string | null, selector: UvSelector) => {
    const target = resolveUvSelector(root[side], selector, work);
    edges.push({ scope, selector, target: target?.key ?? null });
  };
  for (const s of self?.dependencies ?? []) record(null, s);
  for (const e of self?.optionalDependencies ?? [])
    for (const s of e.declarations) record(e.extra, s);
  return edges;
}
function selfEdgeChanges(root: UvRootSnapshot, changes: UvChange[], work: GraphWork) {
  const before = selfEdges(root, 'base', work),
    after = selfEdges(root, 'head', work);
  const identity = (e: (typeof before)[number]) =>
    JSON.stringify([
      e.scope,
      e.selector.name,
      e.selector.version,
      e.selector.source,
      e.selector.marker,
      e.selector.extra ?? [],
    ]);
  const header = (e: (typeof before)[number]) =>
    JSON.stringify([e.scope, e.selector.name, e.selector.marker, e.selector.extra ?? []]);
  const accounted = (edge: (typeof before)[number], side: 'from' | 'to', other: typeof before) => {
    if (other.some((e) => identity(e) === identity(edge))) return true;
    return changes.some((c) => {
      work.spend();
      const s = c[side];
      if (!s || c.role !== 'direct' || !edge.target) return false;
      if (
        edge.target !==
        JSON.stringify([s.name, s.version, { kind: 'registry', url: s.source.identity }])
      )
        return false;
      const sameHeader = other.some((e) => header(e) === header(edge));
      const addedOrRemoved =
        c.kind === (side === 'from' ? 'removal' : 'addition') &&
        !other.some((e) => e.scope === edge.scope && e.selector.name === edge.selector.name);
      return (
        sameHeader ||
        addedOrRemoved ||
        (c.from && c.to && !isDeepStrictEqual(c.from.extras, c.to.extras)) ||
        (side === 'from' ? root.head.state === 'absent' : root.base.state === 'absent')
      );
    });
  };
  const changed =
    before.some((e) => !accounted(e, 'from', after)) ||
    after.some((e) => !accounted(e, 'to', before));
  if (!changed) return { gaps: [] as UvGap[], observations: [] as UvObservation[] };
  return {
    gaps: [
      {
        root: root.root,
        side: null,
        path: root.head.lock.path,
        entry: 'project-selectors',
        reason: 'unsupported',
      } as UvGap,
    ],
    observations: [
      {
        ...note(
          root,
          null,
          'unrepresented_metadata',
          { base: before, head: after },
          'project-selectors',
        ),
        kind: 'metadata',
      } as UvObservation,
    ],
  };
}
export function uvRootInventory(metadata: UvMetadata, root: UvRootSnapshot, work: GraphWork) {
  const baseRoles = uvRoles(root, 'base', work, packageTableComplete(metadata, root, 'base')),
    headRoles = uvRoles(root, 'head', work, packageTableComplete(metadata, root, 'head'));
  const gaps = [...baseRoles.gaps, ...headRoles.gaps],
    observations = [...baseRoles.observations, ...headRoles.observations],
    changes: UvChange[] = [];
  const base = records(root, 'base', baseRoles, work, gaps, observations),
    head = records(root, 'head', headRoles, work, gaps, observations);
  const unchanged = new Set(
    base
      .filter((a) => {
        work.spend(head.length);
        return head.some((b) => uvSemantic(a.side) === uvSemantic(b.side));
      })
      .map((a) => uvSemantic(a.side)),
  );
  unmatched(
    metadata,
    root,
    base.filter((r) => !unchanged.has(uvSemantic(r.side))),
    head.filter((r) => !unchanged.has(uvSemantic(r.side))),
    work,
    changes,
    observations,
    {
      base: root.base.state === 'absent' || baseRoles.tableComplete,
      head: root.head.state === 'absent' || headRoles.tableComplete,
    },
  );
  metadataChanges(root, base, head, gaps, observations, work);
  const selfChanges = selfEdgeChanges(root, changes, work);
  gaps.push(...selfChanges.gaps);
  observations.push(...selfChanges.observations);
  const declarations = uvDeclarationChanges(root, baseRoles, headRoles, changes);
  gaps.push(...declarations.gaps);
  observations.push(...declarations.observations);
  for (const c of changes)
    if (c.role === 'unknown')
      gaps.push({
        root: root.root,
        side: null,
        path: root.head.lock.path,
        entry: c.id,
        reason: 'unsupported',
      });
  for (const side of ['base', 'head'] as const) {
    if (
      !tablesComplete(root, side) &&
      !metadata.gaps.some((g) => g.root === root.root && g.side === side)
    )
      gaps.push({
        root: root.root,
        side,
        path: root[side].lock.path,
        entry: null,
        reason: 'unknown',
      });
    for (const file of [root[side].manifest, root[side].lock])
      if (file.state === 'absent')
        observations.push({
          ...note(root, side, 'proven_absence', { path: file.path, treeSha: file.treeSha }),
          kind: 'metadata',
        });
  }
  return { changes, gaps, observations, baseRoles, headRoles };
}
