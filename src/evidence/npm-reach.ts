import type { EvidenceReason, NpmSide } from '../schema.js';
import type { NpmRootSide } from './npm.js';

/** Why a traversal could not prove absence. Only these three outcomes are non-proving here. */
export type ReachLimit = Readonly<{
  outcome: 'unknown' | 'unsupported' | 'truncated';
  reasons: readonly EvidenceReason[];
}>;
/** Everything one changed direct anchor reaches in one root/side, or why that cannot be complete. */
export type Closure = Readonly<{
  steps: ReadonlyMap<string, NpmSide>;
  parents: ReadonlyMap<string, string | null>;
  limit: ReachLimit | null;
}>;
const UNKNOWN: ReachLimit = { outcome: 'unknown', reasons: ['unknown'] };
const UNSUPPORTED: ReachLimit = { outcome: 'unsupported', reasons: ['unsupported'] };
const TRUNCATED: ReachLimit = { outcome: 'truncated', reasons: ['budget'] };

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
export function nodeKey(node: NpmSide) {
  return JSON.stringify([node.root, node.lockPath, node.name, node.version, node.source]);
}
export function supportedEdge(key: string, specifier: string, target: NpmSide) {
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
type Slot =
  | Readonly<{ kind: 'target'; target: NpmSide }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'limit'; limit: ReachLimit }>;
/** Walks the install lookup chain; only a chain with no recorded slot and no unresolved position is absent. */
function slot(
  snapshot: NpmRootSide,
  unresolved: ReadonlySet<string>,
  path: string,
  key: string,
  spend: () => void,
): Slot {
  let parent = path;
  for (;;) {
    spend();
    const candidate = (parent ? parent + '/' : '') + 'node_modules/' + key;
    if (unresolved.has(candidate)) return { kind: 'limit', limit: UNKNOWN };
    const node = own(snapshot.packages, candidate);
    if (node)
      return node.instance
        ? { kind: 'target', target: node.instance }
        : { kind: 'limit', limit: UNSUPPORTED };
    if (!parent) return { kind: 'absent' };
    const index = parent.lastIndexOf('/node_modules/');
    parent = index < 0 ? '' : parent.slice(0, index);
  }
}
type NpmNode = NpmRootSide['packages'][string];
export const PACKAGE_KEY = /^(?:@[a-z\d._-]+\/)?[a-z\d][a-z\d._-]*$/iu;
/** The supported dependency targets of one node in canonical order; every skipped edge is noted. */
function expand(
  snapshot: NpmRootSide,
  unresolved: ReadonlySet<string>,
  path: string,
  node: NpmNode,
  spend: () => void,
  note: (limit: ReachLimit) => void,
): NpmSide[] {
  const maps = { ...node.dependencies, ...node.optionalDependencies };
  if (Object.keys(node.peerDependencies).some((key) => own(maps, key) === undefined))
    note(UNSUPPORTED);
  const found: NpmSide[] = [];
  for (const key of Object.keys(maps).sort()) {
    spend();
    if (!PACKAGE_KEY.test(key)) {
      note(UNSUPPORTED);
      continue;
    }
    const resolved = slot(snapshot, unresolved, path, key, spend);
    if (resolved.kind === 'limit') note(resolved.limit);
    else if (resolved.kind === 'target')
      if (supportedEdge(key, maps[key], resolved.target)) found.push(resolved.target);
      else note(UNSUPPORTED);
  }
  return found.sort((a, b) => (nodeKey(a) < nodeKey(b) ? -1 : nodeKey(a) > nodeKey(b) ? 1 : 0));
}
/** Supported dependency targets when a caller needs a path but not absence diagnostics. */
export function supportedTargets(
  snapshot: NpmRootSide,
  unresolved: ReadonlySet<string>,
  path: string,
  node: NpmRootSide['packages'][string],
  spend: () => void,
) {
  return expand(snapshot, unresolved, path, node, spend, () => undefined);
}
/**
 * Breadth-first closure from one anchor instance, with every skipped edge classified. A missing
 * slot is absence only under the lookup-chain rule; unresolved positions, instance-less entries,
 * linked entries (N1 records them without an instance), peer-only edges, unsupported specifiers, and exhausted work all make the closure
 * non-proving. Positive reachability found before the limit stays valid.
 */
export function closureFrom(
  snapshot: NpmRootSide,
  start: NpmSide,
  spend: () => void,
  isBudget: (error: unknown) => boolean,
): Closure {
  const steps = new Map([[start.lockPath, start]]),
    parents = new Map<string, string | null>([[start.lockPath, null]]),
    queue = [start.lockPath],
    unresolved = new Set(snapshot.unresolvedPaths);
  let limit: ReachLimit | null = null;
  const note = (next: ReachLimit) => {
    limit ??= next;
  };
  try {
    for (let i = 0; i < queue.length; i++) {
      spend();
      const node = own(snapshot.packages, queue[i]);
      if (!node) {
        note(UNKNOWN);
        continue;
      }
      const found = expand(snapshot, unresolved, queue[i], node, spend, note);
      for (const target of found)
        if (!parents.has(target.lockPath)) {
          parents.set(target.lockPath, queue[i]);
          steps.set(target.lockPath, target);
          queue.push(target.lockPath);
        }
    }
  } catch (error) {
    if (!isBudget(error)) throw error;
    note(TRUNCATED);
  }
  return { steps, parents, limit };
}
/** The shortest canonical path from the closure's start to `lockPath`, or undefined when unreached. */
export function closurePath(closure: Closure, lockPath: string): NpmSide[] | undefined {
  if (!closure.steps.has(lockPath)) return undefined;
  const path: NpmSide[] = [];
  for (let at: string | null | undefined = lockPath; at; at = closure.parents.get(at))
    path.unshift(closure.steps.get(at)!);
  return path;
}
