import { isDeepStrictEqual, types } from 'node:util';
import { parseReviewBinding } from '../event.js';
import {
  PACKET_LIMITS,
  type PacketChange,
  type RelationshipProof,
  type NpmSide,
  type EvidenceReason,
} from '../schema.js';
import type { Finding } from '../policy.js';
import type { NpmInventoryResult, NpmRootSide } from './npm.js';

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
function eligible(inventory: Inventory, member: Resolved) {
  const root = roots(member);
  if (member.role !== 'transitive' || root.length !== 1 || inventory.coverage.status !== 'complete')
    return undefined;
  const candidates = inventory.changes.filter(resolved).filter((c) => roots(c).includes(root[0]));
  const anchors = candidates.filter((c) => c.role === 'direct');
  if (
    candidates.some((c) => c.role === 'unknown') ||
    anchors.length !== 1 ||
    roots(anchors[0]).length !== 1
  )
    return undefined;
  return anchors[0];
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
function pathTo(snapshot: NpmRootSide, start: NpmSide, end: NpmSide, spend: () => void) {
  const queue: NpmSide[][] = [[start]],
    seen = new Set([start.lockPath]);
  for (let i = 0; i < queue.length; i++) {
    spend();
    const path = queue[i],
      node = own(snapshot.packages, path.at(-1)!.lockPath);
    if (path.at(-1)!.lockPath === end.lockPath) return path;
    if (!node) continue;
    for (const key of Object.keys(node.dependencies).sort()) {
      spend();
      const target = slotTarget(snapshot, path.at(-1)!.lockPath, key, spend);
      if (target && !seen.has(target.lockPath)) {
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
): NpmProof | undefined {
  const anchor = eligible(inventory, member);
  if (!anchor) return undefined;
  const side = member.kind === 'removal' ? 'base' : 'head';
  const start = side === 'head' ? anchor.to : anchor.from;
  const end = side === 'head' ? member.to : member.from;
  if (!start || !end || start.sourceId !== end.sourceId) return undefined;
  const snapshot = inventory.roots.find((r) => r.root === end.root)?.[side];
  if (!snapshot || snapshot.state !== 'present') return undefined;
  const path = pathTo(snapshot, start, end, spend);
  if (!path || path.length > PACKET_LIMITS.pathInstances) return undefined;
  return {
    fromId: anchor.id,
    toId: member.id,
    ecosystem: 'npm',
    side,
    sourceId: start.sourceId,
    path,
  };
}
/** Uses authentic N1 snapshots and an independently verified binding; no I/O occurs.
 * Limits count cumulative graph/validation work and UTF-8 retained bytes. Output is detached and frozen.
 */
export function proveNpmRelationships(value: unknown): NpmGraphResult {
  try {
    const { inventory, limits, spend } = parse(value);
    if (inventory.kind !== 'inventory') return freeze(structuredClone(inventory));
    const relationships: NpmProof[] = [];
    for (const member of [...inventory.changes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!resolved(member)) continue;
      const proof = proofFor(inventory, member, spend);
      if (proof) relationships.push(proof);
    }
    const result = { ...inventory, relationships, findings: [] };
    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxRetainedBytes)
      throw new GraphFailure('budget');
    return freeze(structuredClone(result));
  } catch (error) {
    return error instanceof GraphFailure
      ? { kind: 'unavailable', reason: error.reason }
      : { kind: 'invalid' };
  }
}
