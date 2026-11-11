import type { EvidenceReason, UvSide } from '../schema.js';
import { byCodeUnit } from './common.js';
import { uvInstance } from './uv-inventory.js';
import { resolveUvSelector } from './uv-roles.js';
import { UvGraphFailure, type GraphWork } from './uv-input.js';
import type { UvPathRoot } from './uv-paths.js';

/** Why a closure cannot prove absence; positive reachability found before the limit stays valid. */
export type UvReachLimit = Readonly<{
  outcome: 'unknown' | 'unsupported' | 'truncated';
  reasons: readonly EvidenceReason[];
}>;
export type UvClosure = Readonly<{
  keys: ReadonlySet<string>;
  parents: ReadonlyMap<string, string | null>;
  limit: UvReachLimit | null;
}>;
const UNKNOWN: UvReachLimit = { outcome: 'unknown', reasons: ['unknown'] };
const UNSUPPORTED: UvReachLimit = { outcome: 'unsupported', reasons: ['unsupported'] };
const TRUNCATED: UvReachLimit = { outcome: 'truncated', reasons: ['budget'] };

/** The distinct external package keys one node depends on; every unresolved or internal edge is noted. */
function expand(
  snapshot: UvPathRoot['root']['base' | 'head'],
  node: NonNullable<ReturnType<UvPathRoot['base']['nodes']['get']>>,
  work: GraphWork,
  note: (limit: UvReachLimit) => void,
): Set<string> {
  const selectors = [
    ...(node.pkg.dependencies ?? []),
    ...(node.pkg.optionalDependencies ?? []).flatMap((extra) => extra.declarations),
  ];
  const found = new Set<string>();
  for (const selector of selectors) {
    work.spend();
    const target = resolveUvSelector(snapshot, selector, work);
    if (!target) note(UNKNOWN);
    else if (!target.external) note(UNSUPPORTED);
    else found.add(target.key);
  }
  return found;
}
/**
 * Every package an anchor can reach in one root/side lock, ignoring environment markers and extras:
 * ordinary edges and every optional-dependency edge count, so a path that exists only on some
 * platform or extra is reachability, never absence. Unlike the same-context path search, this
 * never skips an edge for its marker or a node for its membership. A selector that does not resolve
 * to exactly one external package, or exhausted work, leaves the closure non-proving.
 */
export function uvClosureFrom(
  context: UvPathRoot,
  side: 'base' | 'head',
  startKey: string,
  work: GraphWork,
): UvClosure {
  const snapshot = context.root[side],
    nodes = context[side].nodes,
    keys = new Set([startKey]),
    parents = new Map<string, string | null>([[startKey, null]]),
    queue = [startKey];
  let limit: UvReachLimit | null = null;
  const note = (next: UvReachLimit) => {
    limit ??= next;
  };
  try {
    for (let i = 0; i < queue.length; i++) {
      work.spend();
      const node = nodes.get(queue[i]);
      if (!node) {
        note(UNKNOWN);
        continue;
      }
      const found = expand(snapshot, node, work, note);
      for (const key of [...found].sort(byCodeUnit))
        if (!keys.has(key)) {
          keys.add(key);
          parents.set(key, queue[i]);
          queue.push(key);
        }
    }
  } catch (error) {
    if (!(error instanceof UvGraphFailure) || error.reason !== 'budget') throw error;
    note(TRUNCATED);
  }
  return { keys, parents, limit };
}
/** The shortest canonical instance path to `endKey`, or null when unreached or not representable. */
export function uvClosurePath(
  context: UvPathRoot,
  side: 'base' | 'head',
  closure: UvClosure,
  endKey: string,
): UvSide[] | null {
  if (!closure.keys.has(endKey)) return null;
  const path: UvSide[] = [];
  for (let at: string | null | undefined = endKey; at; at = closure.parents.get(at)) {
    const node = context[side].nodes.get(at);
    const instance = node ? uvInstance(node, context.root, side) : null;
    if (!instance) return null;
    path.unshift(instance);
  }
  return path;
}
