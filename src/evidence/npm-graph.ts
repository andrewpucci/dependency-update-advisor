import { isDeepStrictEqual, types } from 'node:util';
import { createHash } from 'node:crypto';
import { parseReviewBinding } from '../event.js';
import {
  PACKET_LIMITS,
  type PacketChange,
  type RelationshipProof,
  type NpmSide,
  type EvidenceReason,
} from '../schema.js';
import type { Finding } from '../policy.js';
import type { NpmInventoryResult, NpmRootSide, NpmNode } from './npm.js';
import {
  createNpmRegistryReader,
  interpretNpmLifecycle,
  type NpmRegistryDependencies,
  type NpmMetadataResult,
  type NpmLifecycleSide,
} from './npm-registry.js';

type Inventory = Extract<NpmInventoryResult, { kind: 'inventory' }>;
type NpmProof = Extract<RelationshipProof, { ecosystem: 'npm' }>;
type Resolved = Exclude<Extract<PacketChange, { ecosystem: 'npm' }>, { basis: 'declaration' }>;
export type NpmGraphLimits = Readonly<{ maxGraphWork: number; maxRetainedBytes: number }>;
export type NpmGraphResult =
  | Exclude<NpmInventoryResult, Inventory>
  | (Inventory & {
      readonly relationships: readonly NpmProof[];
      readonly findings: readonly Finding[];
    });
class GraphFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
function need(value: unknown): asserts value {
  if (!value) throw new Error('invalid graph');
}
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function budget(maximum: number) {
  let remaining = maximum;
  return () => {
    if (--remaining < 0) throw new GraphFailure('budget');
  };
}
/** Rejects accessors and proxies before cloning or serialization can execute caller code. */
function plain(value: unknown, spend: () => void) {
  const queue = [value];
  const seen = new Set<object>();
  while (queue.length) {
    spend();
    const item = queue.pop();
    if (!item || typeof item !== 'object') {
      need(item === null || ['string', 'number', 'boolean'].includes(typeof item));
      continue;
    }
    need(!types.isProxy(item));
    if (seen.has(item)) continue;
    seen.add(item);
    const array = Array.isArray(item);
    need(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype));
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(item, key)!;
      need(typeof key === 'string' && 'value' in d && d.enumerable);
      queue.push(d.value);
    }
  }
}
function validLimits(limits: NpmGraphLimits) {
  need(
    limits &&
      [limits.maxGraphWork, limits.maxRetainedBytes].every((n) => Number.isSafeInteger(n) && n > 0),
  );
}
function checkSide(
  root: string,
  side: NpmRootSide,
  revision: 'base' | 'head',
  inventory: Inventory,
) {
  if (side.state !== 'present') return;
  const source = inventory.sources.find((s) => s.id === side.lockId);
  need(
    source?.kind === 'file' && source.status === 'available' && source.provenance.kind === 'file',
  );
  const p = source.provenance;
  need(
    p.revision === revision &&
      p.sha === (revision === 'base' ? inventory.binding.baseSha : inventory.binding.headSha),
  );
  need(isDeepStrictEqual(p.repository, inventory.binding.repository));
  need(p.path === (root === '.' ? '' : root + '/') + 'package-lock.json');
  for (const [path, node] of Object.entries(side.packages)) {
    if (node.instance)
      need(
        node.instance.root === root &&
          node.instance.lockPath === path &&
          node.instance.sourceId === side.lockId,
      );
  }
}
function checkChanges(inventory: Inventory) {
  const ids = new Map(inventory.sources.map((source) => [source.id, source]));
  need(ids.size === inventory.sources.length);
  for (const change of inventory.changes) {
    need(change.ecosystem === 'npm');
    if (!resolved(change)) continue;
    for (const [revision, side] of [
      ['base', change.from],
      ['head', change.to],
    ] as const) {
      if (!side) continue;
      const source = ids.get(side.sourceId);
      need(
        source?.kind === 'file' &&
          source.status === 'available' &&
          source.provenance.kind === 'file' &&
          source.memberIds.includes(change.id),
      );
      need(source.provenance.revision === revision);
      const snapshot = inventory.roots.find((root) => root.root === side.root)?.[revision];
      if (!snapshot || snapshot.state !== 'present') continue;
      const node = own(snapshot.packages, side.lockPath)?.instance;
      need(node && isDeepStrictEqual({ ...node, sourceId: '' }, { ...side, sourceId: '' }));
      const lock = ids.get(snapshot.lockId!);
      need(lock && isDeepStrictEqual(lock.provenance, source.provenance));
    }
  }
}
function parse(value: unknown) {
  need(value && typeof value === 'object' && !types.isProxy(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ['inventory', 'binding', 'limits'])
    need(descriptors[key] && 'value' in descriptors[key]);
  const limits = descriptors.limits.value as NpmGraphLimits;
  // Inspect the limits envelope before reading numeric members.
  need(limits && !types.isProxy(limits));
  for (const key of ['maxGraphWork', 'maxRetainedBytes'])
    need('value' in (Object.getOwnPropertyDescriptor(limits, key) ?? {}));
  validLimits(limits);
  const spend = budget(limits.maxGraphWork);
  plain(value, spend);
  if (Buffer.byteLength(JSON.stringify(value)) > limits.maxRetainedBytes)
    throw new GraphFailure('budget');
  const binding = parseReviewBinding(descriptors.binding.value);
  need(binding);
  const inventory = descriptors.inventory.value as NpmInventoryResult;
  need(['inventory', 'invalid', 'obsolete', 'unavailable'].includes(inventory.kind));
  if (inventory.kind === 'inventory') {
    need(isDeepStrictEqual(binding, inventory.binding));
    need(new Set(inventory.changes.map((c) => c.id)).size === inventory.changes.length);
    checkChanges(inventory);
    for (const root of inventory.roots) {
      checkSide(root.root, root.base, 'base', inventory);
      checkSide(root.root, root.head, 'head', inventory);
    }
  }
  return { inventory, binding, limits, spend };
}
function resolved(change: PacketChange): change is Resolved {
  return change.ecosystem === 'npm' && !('basis' in change);
}
function roots(change: Resolved) {
  return [...new Set([change.from?.root, change.to?.root].filter((r) => r !== undefined))];
}
const explanations = {
  inventory_incomplete: 'Relationship unproven because npm inventory is incomplete.',
  multiple_roots: 'Relationship unproven across multiple roots.',
  unknown_role: 'Relationship unproven because a package role is unknown.',
  multiple_direct_changes: 'Relationship unproven with multiple changed direct dependencies.',
  no_direct_change: 'Relationship unproven without a changed direct anchor.',
  missing_relationship:
    'No supported immutable path proved this relationship; it remains unproven.',
  wrong_side: 'Relationship unproven because the anchor does not exist on the required side.',
  source_split: 'Relationship unproven within the original lock-source membership limits.',
  snapshot_missing: 'Relationship unproven because an immutable graph snapshot is unavailable.',
  path_limit: 'Relationship unproven because the full path exceeds the packet limit.',
  shared:
    'This member is also reachable from an unchanged direct dependency; grouping does not establish exclusive ownership or causation.',
  budget: 'Relationship search is incomplete because its graph-work budget was exhausted.',
} as const;
type Observation = keyof typeof explanations;
function note(member: Resolved, reason: Observation): Finding {
  const side = member.kind === 'removal' ? member.from : member.to;
  need(side);
  const id = createHash('sha256')
    .update(JSON.stringify([member.id, reason]))
    .digest('hex');
  return {
    id: 'npm:relationship:' + id,
    memberId: member.id,
    kind: 'informational',
    detail: explanations[reason],
    rationale: 'Grouping preserves each installed instance and its own research requirements.',
    references: [side.sourceId],
    remediation: ['Assess this member and any concrete unanswered evidence questions.'],
    validation: ['Inspect the cited immutable lockfile and the exact member instance.'],
  };
}
function eligible(inventory: Inventory, member: Resolved): Resolved | Observation {
  const root = roots(member);
  if (member.role === 'unknown') return 'unknown_role';
  if (root.length !== 1) return 'multiple_roots';
  if (inventory.coverage.status !== 'complete') return 'inventory_incomplete';
  const candidates = inventory.changes.filter(resolved).filter((c) => roots(c).includes(root[0]));
  if (candidates.some((c) => c.role === 'unknown')) return 'unknown_role';
  const anchors = candidates.filter((c) => c.role === 'direct');
  if (anchors.length !== 1) return anchors.length ? 'multiple_direct_changes' : 'no_direct_change';
  return roots(anchors[0]).length === 1 ? anchors[0] : 'multiple_roots';
}
function slotTarget(snapshot: NpmRootSide, path: string, key: string, spend: () => void) {
  let parent = path;
  for (;;) {
    spend();
    const candidate = (parent ? parent + '/' : '') + 'node_modules/' + key;
    if (snapshot.unresolvedPaths.includes(candidate)) return undefined;
    const node = own(snapshot.packages, candidate);
    if (node) return node.instance ?? undefined;
    if (!parent) return undefined;
    const index = parent.lastIndexOf('/node_modules/');
    parent = index < 0 ? '' : parent.slice(0, index);
  }
}
function supportedEdge(key: string, specifier: string, target: NpmSide) {
  const alias = /^npm:((?:@[^/]+\/)?[^@/]+)@(.+)$/u.exec(specifier);
  const name = alias?.[1] ?? key;
  const range = alias?.[2] ?? specifier;
  return (
    target.source.kind === 'registry' &&
    target.name === name &&
    /^[a-z\d\s._^~<>=*|+-]+$/iu.test(range) &&
    /[a-z\d*]/iu.test(range)
  );
}
function nodeKey(node: NpmSide) {
  return JSON.stringify([node.root, node.lockPath, node.name, node.version, node.source]);
}
function edges(snapshot: NpmRootSide, node: NpmNode, spend: () => void) {
  const maps = { ...node.dependencies, ...node.optionalDependencies };
  const targets: NpmSide[] = [];
  for (const key of Object.keys(maps).sort()) {
    spend();
    if (!/^(?:@[a-z\d._-]+\/)?[a-z\d][a-z\d._-]*$/iu.test(key)) continue;
    const target = slotTarget(snapshot, node.instance!.lockPath, key, spend);
    if (target && supportedEdge(key, maps[key], target)) targets.push(target);
  }
  return targets.sort((a, b) => (nodeKey(a) < nodeKey(b) ? -1 : nodeKey(a) > nodeKey(b) ? 1 : 0));
}
function pathTo(snapshot: NpmRootSide, start: NpmSide, end: NpmSide, spend: () => void) {
  const queue: NpmSide[][] = [[start]],
    seen = new Set([start.lockPath]);
  for (let i = 0; i < queue.length; i++) {
    spend();
    const path = queue[i],
      node = own(snapshot.packages, path.at(-1)!.lockPath);
    if (path.at(-1)!.lockPath === end.lockPath) return path;
    if (!node) continue;
    for (const target of edges(snapshot, node, spend)) {
      if (!seen.has(target.lockPath)) {
        seen.add(target.lockPath);
        queue.push([...path, target]);
      }
    }
  }
  return undefined;
}
function proofFor(
  inventory: Inventory,
  member: Resolved,
  spend: () => void,
): NpmProof | Observation {
  const anchor = eligible(inventory, member);
  if (typeof anchor === 'string') return anchor;
  const side = member.kind === 'removal' ? 'base' : 'head';
  const start = side === 'head' ? anchor.to : anchor.from;
  const end = side === 'head' ? member.to : member.from;
  if (!start || !end) return 'wrong_side';
  if (start.sourceId !== end.sourceId) return 'source_split';
  const snapshot = inventory.roots.find((r) => r.root === end.root)?.[side];
  if (!snapshot || snapshot.state !== 'present') return 'snapshot_missing';
  const path = pathTo(snapshot, start, end, spend);
  if (!path) return 'missing_relationship';
  if (path.length > PACKET_LIMITS.pathInstances) return 'path_limit';
  return {
    fromId: anchor.id,
    toId: member.id,
    ecosystem: 'npm',
    side,
    sourceId: start.sourceId,
    // N1 snapshots cite the original file record; endpoints may cite an equivalent member-scoped copy.
    path: path.map((step) => ({ ...step, sourceId: start.sourceId })),
  };
}
/** Instances reachable from unchanged direct slots of one root/side, computed once per attempt. */
function unchangedReach(
  inventory: Inventory,
  root: string,
  side: 'base' | 'head',
  spend: () => void,
) {
  const snapshot = inventory.roots.find((r) => r.root === root)![side];
  const changedSlots = new Set(
    inventory.changes
      .filter(resolved)
      .map((c) => (side === 'head' ? c.to : c.from))
      .filter((s) => s?.root === root)
      .map((s) => s!.lockPath),
  );
  const queue: NpmSide[] = [];
  for (const key of Object.keys(snapshot.declarations ?? {}).sort()) {
    spend();
    const slot = 'node_modules/' + key;
    const start = changedSlots.has(slot) ? undefined : own(snapshot.packages, slot)?.instance;
    if (start) queue.push(start);
  }
  const seen = new Set(queue.map((s) => s.lockPath));
  for (let i = 0; i < queue.length; i++) {
    spend();
    const node = own(snapshot.packages, queue[i].lockPath);
    if (!node) continue;
    for (const target of edges(snapshot, node, spend)) {
      if (!seen.has(target.lockPath)) {
        seen.add(target.lockPath);
        queue.push(target);
      }
    }
  }
  return seen;
}
function collectProofs(inventory: Inventory, spend: () => void) {
  const relationships: NpmProof[] = [],
    findings: Finding[] = [],
    reach = new Map<string, Set<string>>();
  const shared = (proof: NpmProof) => {
    const end = proof.path.at(-1)!,
      key = JSON.stringify([end.root, proof.side]);
    if (!reach.has(key)) reach.set(key, unchangedReach(inventory, end.root, proof.side, spend));
    return reach.get(key)!.has(end.lockPath);
  };
  for (const member of [...inventory.changes].sort(byId)) {
    if (!resolved(member) || member.role === 'direct') continue;
    try {
      const result = proofFor(inventory, member, spend);
      if (typeof result === 'string') findings.push(note(member, result));
      else {
        relationships.push(result);
        if (shared(result)) findings.push(note(member, 'shared'));
      }
    } catch (error) {
      if (!(error instanceof GraphFailure)) throw error;
      findings.push(note(member, 'budget'));
    }
  }
  return { relationships, findings };
}
function graphResult({ inventory, limits, spend }: ReturnType<typeof parse>): NpmGraphResult {
  if (inventory.kind !== 'inventory') return freeze(structuredClone(inventory));
  const { relationships, findings } = collectProofs(inventory, spend);
  const result = {
    ...inventory,
    changes: [...inventory.changes].sort(byId),
    roots: [...inventory.roots].sort((a, b) => (a.root < b.root ? -1 : 1)),
    sources: [...inventory.sources].sort(byId),
    relationships,
    findings: findings.sort(byId),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > limits.maxRetainedBytes)
    throw new GraphFailure('budget');
  return freeze(structuredClone(result));
}
function byId(a: { id: string }, b: { id: string }) {
  return a.id < b.id ? -1 : 1;
}
function failure(error: unknown): NpmGraphResult {
  return error instanceof GraphFailure
    ? { kind: 'unavailable', reason: error.reason }
    : { kind: 'invalid' };
}
/** Uses authentic N1 snapshots and an independently verified binding; no I/O occurs.
 * Limits count cumulative graph/validation work and UTF-8 retained bytes. Output is detached and frozen.
 */
export function proveNpmRelationships(value: unknown): NpmGraphResult {
  try {
    return graphResult(parse(value));
  } catch (error) {
    return failure(error);
  }
}
async function lifecycleInput(
  graph: Inventory,
  change: Resolved,
  reader: { read: (value: unknown) => Promise<NpmMetadataResult> },
) {
  const result: { base?: NpmLifecycleSide; head?: NpmLifecycleSide } = {};
  for (const [side, instance] of [
    ['base', change.from],
    ['head', change.to],
  ] as const) {
    if (!instance) continue;
    const snapshot = graph.roots.find((root) => root.root === instance.root)?.[side];
    const node =
      snapshot?.state === 'present' ? own(snapshot.packages, instance.lockPath) : undefined;
    if (!node?.instance) continue;
    const metadata = await reader.read({
      name: instance.name,
      version: instance.version,
      source: instance.source,
      integrity: node.integrity,
    });
    result[side] = { node, metadata };
  }
  return result;
}
function packetBounds(graph: Extract<NpmGraphResult, { kind: 'inventory' }>) {
  const contribution = {
    changes: graph.changes,
    sources: graph.sources,
    relationships: graph.relationships,
    findings: graph.findings,
  };
  return (
    graph.changes.length <= PACKET_LIMITS.changes &&
    graph.sources.length <= PACKET_LIMITS.sources &&
    graph.relationships.length <= PACKET_LIMITS.relationships &&
    graph.findings.length <= PACKET_LIMITS.findings &&
    Buffer.byteLength(JSON.stringify(contribution)) <= PACKET_LIMITS.bytes
  );
}
/** Enriches authentic N1 evidence through one bounded attempt, retaining exact inventory/source identities.
 * Dependencies are trusted transport/clock injection. Invalid or overflowing results expose no partial packet.
 * Total registry duration starts after bounded input validation and includes graph traversal and metadata reads.
 */
export async function enrichNpmEvidence(
  value: unknown,
  deps: NpmRegistryDependencies,
): Promise<NpmGraphResult> {
  try {
    const parsed = parse(value);
    if (parsed.inventory.kind !== 'inventory') return graphResult(parsed);
    const reader = createNpmRegistryReader((value as { limits: unknown }).limits, deps);
    if (reader.kind !== 'ready') return { kind: 'invalid' };
    const graph = graphResult(parsed);
    if (graph.kind !== 'inventory') return graph;
    if (!packetBounds(graph)) return { kind: 'unavailable', reason: 'budget' };
    const changes: PacketChange[] = [],
      sources = [...graph.sources],
      findings = [...graph.findings];
    for (const change of graph.changes) {
      if (!resolved(change)) {
        changes.push(change);
        continue;
      }
      const input = await lifecycleInput(graph, change, reader);
      const interpreted = interpretNpmLifecycle(change, input);
      changes.push(interpreted.change);
      sources.push(...interpreted.sources);
      findings.push(...interpreted.findings);
    }
    const result = {
      ...graph,
      changes,
      sources: sources.sort(byId),
      findings: findings.sort(byId),
    };
    need(
      new Set(sources.map((s) => s.id)).size === sources.length &&
        new Set(findings.map((f) => f.id)).size === findings.length,
    );
    if (
      !packetBounds(result) ||
      Buffer.byteLength(JSON.stringify(result)) > parsed.limits.maxRetainedBytes
    )
      return { kind: 'unavailable', reason: 'budget' };
    return freeze(structuredClone(result));
  } catch (error) {
    return failure(error);
  }
}
