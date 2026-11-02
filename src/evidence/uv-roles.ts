import { isDeepStrictEqual } from 'node:util';
import { byCodeUnit } from './common.js';
import type { UvRootSnapshot, UvRootSide, UvGap } from './uv.js';
import type { UvPackage, UvSelector, UvLockRequirement } from './uv-lock.js';
import type { UvDeclaration } from './uv-manifest.js';
import type { GraphWork } from './uv-input.js';
import type { UvChange, UvObservation } from './uv-graph.js';

export type UvAssociation = { declaration: UvDeclaration; scope: string | null; targets: string[] };
export type UvRoleNode = {
  pkg: UvPackage;
  role: 'direct' | 'transitive' | 'unknown';
  extras: string[];
  membershipComplete: boolean;
};
export type UvRoles = {
  nodes: Map<string, UvRoleNode>;
  associations: UvAssociation[];
  complete: boolean;
  gaps: UvGap[];
  observations: UvObservation[];
};
export function uvGuard(
  current: string | null,
  edge: string | null,
  pkg: UvPackage,
): string | null | undefined {
  const markers = pkg.resolutionMarkers ?? [];
  if (markers.length > 1) return undefined;
  const conditions = [current, edge, markers[0] ?? null].filter((s): s is string => s !== null);
  return new Set(conditions).size > 1 ? undefined : (conditions[0] ?? null);
}
type Activation = { key: string; extras: string[]; scope: string | null; guard: string | null };
function activatedSelectors(pkg: UvPackage, extras: string[]) {
  return [
    ...(pkg.dependencies ?? []),
    ...extras.flatMap(
      (extra) => pkg.optionalDependencies?.find((e) => e.extra === extra)?.declarations ?? [],
    ),
  ];
}
function reachability(
  root: UvRootSnapshot,
  side: 'base' | 'head',
  self: UvPackage,
  result: UvRoles,
  work: GraphWork,
) {
  const snapshot = root[side],
    queue: Activation[] = [],
    seen = new Set<string>();
  const reached = new Map<string, Set<string | null>>();
  let closed = true;
  const visit = (s: UvSelector, scope: string | null, guard: string | null, from: string) => {
    work.spend();
    const target = resolveUvSelector(snapshot, s, work);
    const nextGuard = target ? uvGuard(guard, s.marker, target) : undefined;
    result.observations.push({
      kind: 'metadata',
      root: root.root,
      side,
      path: snapshot.lock.path,
      entry: from,
      reason: nextGuard === undefined ? 'unresolved_selector' : 'recorded_selector',
      sourceIds: [snapshot.lock.sourceId!],
      memberIds: [],
      value: { from, selector: s, target: target?.key ?? null, projectExtra: scope },
      nextAction: 'Preserve this exact selector and its activation context.',
    });
    if (!target || nextGuard === undefined) {
      closed = false;
      return;
    }
    if (!target.external) {
      closed = false;
      return;
    }
    const state = {
      key: target.key,
      extras: [...(s.extra ?? [])].sort(byCodeUnit),
      scope,
      guard: nextGuard,
    };
    const id = JSON.stringify(state);
    if (seen.has(id)) return;
    seen.add(id);
    queue.push(state);
  };
  for (const scope of [null, ...(self.optionalDependencies ?? []).map((e) => e.extra)])
    for (const s of selectors(self, scope)) visit(s, scope, null, self.key);
  for (let i = 0; i < queue.length; i++) {
    work.spend();
    const state = queue[i],
      node = result.nodes.get(state.key);
    if (!node) continue;
    const scopes = reached.get(state.key) ?? new Set<string | null>();
    scopes.add(state.scope);
    reached.set(state.key, scopes);
    for (const s of activatedSelectors(node.pkg, state.extras))
      visit(s, state.scope, state.guard, node.pkg.key);
  }
  for (const [key, node] of result.nodes) {
    work.spend();
    const scopes = reached.get(key);
    node.extras = scopes?.has(null)
      ? []
      : [...(scopes ?? [])].filter((s): s is string => s !== null).sort(byCodeUnit);
    node.membershipComplete = !!scopes && (scopes.has(null) || closed) && result.complete;
    if (node.role !== 'direct' && scopes && result.complete) node.role = 'transitive';
    if (!node.membershipComplete)
      result.gaps.push({
        root: root.root,
        side,
        path: snapshot.lock.path,
        entry: key,
        reason: 'unsupported',
      });
  }
}
export function resolveUvSelector(
  snapshot: UvRootSide,
  s: UvSelector,
  work: GraphWork,
): UvPackage | null {
  const candidates: UvPackage[] = [];
  for (const p of snapshot.lock.data?.packages ?? []) {
    work.spend();
    if (
      p.name !== s.name ||
      (s.version !== null && s.version !== p.version) ||
      (s.source !== null && !isDeepStrictEqual(s.source, p.source))
    )
      continue;
    candidates.push(p);
  }
  if (candidates.length !== 1) return null;
  if (snapshot.lock.state !== 'present' && (s.version === null || s.source === null)) return null;
  return candidates[0];
}
function mirrorMarker(d: UvDeclaration, scope: string | null, m: UvLockRequirement) {
  if (scope === null) return m.marker === d.marker;
  const guards = [`extra == '${scope}'`, `extra == "${scope}"`];
  if (d.marker === null) return guards.includes(m.marker ?? '');
  return guards.some((g) =>
    [
      `${d.marker} and ${g}`,
      `(${d.marker}) and ${g}`,
      `${g} and ${d.marker}`,
      `${g} and (${d.marker})`,
    ].includes(m.marker ?? ''),
  );
}
function mirrored(d: UvDeclaration, scope: string | null, m: UvLockRequirement) {
  return (
    m.name === d.name &&
    m.specifier === d.specifier &&
    isDeepStrictEqual(m.extras ?? [], d.extras) &&
    mirrorMarker(d, scope, m)
  );
}
function declarations(snapshot: UvRootSide): UvAssociation[] {
  const manifest = snapshot.manifest.data;
  return manifest
    ? [
        ...manifest.dependencies.map((declaration) => ({ declaration, scope: null, targets: [] })),
        ...manifest.optionalDependencies.flatMap((e) =>
          e.declarations.map((declaration) => ({ declaration, scope: e.extra, targets: [] })),
        ),
      ]
    : [];
}
function selectors(self: UvPackage, scope: string | null) {
  return scope === null
    ? (self.dependencies ?? [])
    : (self.optionalDependencies?.find((e) => e.extra === scope)?.declarations ?? []);
}
function selectorMatches(d: UvDeclaration, s: UvSelector) {
  return (
    d.name === s.name &&
    isDeepStrictEqual(d.extras, s.extra ?? []) &&
    (d.marker === null || s.marker === d.marker)
  );
}
function directMappings(snapshot: UvRootSide, self: UvPackage, roles: UvRoles, work: GraphWork) {
  const unused = [...(self.metadata?.requiresDist ?? [])];
  for (const a of roles.associations) {
    work.spend();
    const mirror = unused.findIndex((m) => {
      work.spend();
      return mirrored(a.declaration, a.scope, m);
    });
    if (mirror < 0) {
      roles.complete = false;
      continue;
    }
    unused.splice(mirror, 1);
    const candidates = selectors(self, a.scope).filter((s) => {
      work.spend();
      return selectorMatches(a.declaration, s);
    });
    if (!candidates.length) {
      roles.complete = false;
      continue;
    }
    for (const s of candidates) {
      const target = resolveUvSelector(snapshot, s, work);
      if (target) a.targets.push(target.key);
      else roles.complete = false;
    }
  }
  if (unused.length) roles.complete = false;
  // A lock selector without a matching manifest declaration cannot prove direct exclusion.
  for (const scope of [null, ...(self.optionalDependencies ?? []).map((e) => e.extra)])
    for (const s of selectors(self, scope)) {
      work.spend();
      if (!roles.associations.some((a) => a.scope === scope && selectorMatches(a.declaration, s)))
        roles.complete = false;
    }
}
export function uvRoles(root: UvRootSnapshot, side: 'base' | 'head', work: GraphWork): UvRoles {
  const snapshot = root[side],
    manifest = snapshot.manifest.data,
    lock = snapshot.lock.data;
  const result: UvRoles = {
    nodes: new Map(),
    associations: declarations(snapshot),
    complete: snapshot.state === 'present',
    gaps: [],
    observations: [],
  };
  for (const pkg of lock?.packages ?? [])
    if (pkg.external)
      result.nodes.set(pkg.key, { pkg, role: 'unknown', extras: [], membershipComplete: false });
  const selfs = lock?.packages.filter((p) => !p.external) ?? [],
    self = selfs.length === 1 ? selfs[0] : null;
  if (!manifest || !lock || !self || self.name !== manifest.name) {
    result.complete = false;
    return result;
  }
  if (manifest.requiresPython !== lock.requiresPython) result.complete = false;
  if (
    !['present', 'absent'].includes(manifest.fields.dependencies) ||
    !['present', 'absent'].includes(manifest.fields.optionalDependencies)
  )
    result.complete = false;
  const extras = manifest.optionalDependencies.map((e) => e.extra).sort(byCodeUnit);
  if (!isDeepStrictEqual(extras, [...(self.metadata?.providesExtras ?? [])].sort(byCodeUnit)))
    result.complete = false;
  if (self.metadata?.requiresDist === null) result.complete = false;
  directMappings(snapshot, self, result, work);
  for (const a of result.associations)
    for (const key of a.targets) {
      const node = result.nodes.get(key);
      if (node && result.complete) {
        node.role = 'direct';
        node.membershipComplete = a.scope === null;
      }
    }
  if (!result.complete)
    result.gaps.push({
      root: root.root,
      side,
      path: snapshot.manifest.path,
      entry: 'declaration-map',
      reason: 'conflict',
    });
  reachability(root, side, self, result, work);
  return result;
}
function declarationKey(a: UvAssociation, withRange: boolean) {
  const d = a.declaration;
  return JSON.stringify([
    a.scope,
    d.list,
    d.name,
    d.extras,
    d.marker,
    ...(withRange ? [d.specifier] : []),
  ]);
}
function corresponding(
  a: UvAssociation,
  b: UvAssociation,
  changes: UvChange[],
  root: UvRootSnapshot,
) {
  return changes.filter(
    (c) =>
      c.role === 'direct' &&
      c.from &&
      c.to &&
      c.from.root === root.root &&
      a.targets.some(
        (k) =>
          k ===
          JSON.stringify([
            c.from!.name,
            c.from!.version,
            { kind: 'registry', url: c.from!.source.identity },
          ]),
      ) &&
      b.targets.some(
        (k) =>
          k ===
          JSON.stringify([
            c.to!.name,
            c.to!.version,
            { kind: 'registry', url: c.to!.source.identity },
          ]),
      ),
  );
}
export function uvDeclarationChanges(
  root: UvRootSnapshot,
  base: UvRoles,
  head: UvRoles,
  changes: UvChange[],
) {
  const gaps: UvGap[] = [],
    observations: UvObservation[] = [];
  const before = base.associations,
    after = head.associations;
  const unchanged = new Set(
    before
      .map((a) => declarationKey(a, true))
      .filter((k) => after.some((a) => declarationKey(a, true) === k)),
  );
  const removed = before.filter((a) => !unchanged.has(declarationKey(a, true))),
    added = after.filter((a) => !unchanged.has(declarationKey(a, true)));
  const keys = new Set([...removed, ...added].map((a) => declarationKey(a, false)));
  for (const key of [...keys].sort(byCodeUnit)) {
    const a = removed.filter((x) => declarationKey(x, false) === key),
      b = added.filter((x) => declarationKey(x, false) === key);
    const members =
      a.length === 1 && b.length === 1 && base.complete && head.complete
        ? corresponding(a[0], b[0], changes, root)
        : [];
    const explained = members.length === 1;
    observations.push({
      kind: 'declaration',
      root: root.root,
      side: null,
      path: root.head.manifest.path,
      entry: key,
      reason: explained ? 'range_rewrite' : 'unrepresented_declaration',
      sourceIds: [root.base.manifest.sourceId, root.head.manifest.sourceId].filter(
        (id): id is string => !!id,
      ),
      memberIds: members.map((c) => c.id),
      value: { base: a, head: b },
      nextAction: explained
        ? 'Review the accompanying exact resolved change.'
        : 'Inspect the declaration change separately; its full effect is not represented.',
    });
    if (!explained)
      gaps.push({
        root: root.root,
        side: null,
        path: root.head.manifest.path,
        entry: key,
        reason: 'unsupported',
      });
  }
  return { gaps, observations };
}
