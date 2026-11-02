import { isDeepStrictEqual } from 'node:util';
import { PACKET_LIMITS, type UvSide, type RelationshipProof } from '../schema.js';
import type { Finding } from '../policy.js';
import type { UvInventory, UvChange, UvObservation } from './uv-graph.js';
import type { UvRootSnapshot } from './uv.js';
import { resolveUvSelector, type UvRoles, type UvRoleNode } from './uv-roles.js';
import { uvInstance, uvSemantic } from './uv-inventory.js';
import { byCodeUnit } from './common.js';
import { checkGraphData, UvGraphFailure, type GraphWork } from './uv-input.js';

export type UvPathRoot = { root: UvRootSnapshot; base: UvRoles; head: UvRoles };
type Path = Extract<RelationshipProof, { ecosystem: 'uv' }>;
function key(s: UvSide) {
  return JSON.stringify([s.name, s.version, { kind: 'registry', url: s.source.identity }]);
}
export function startUvRelationships(result: UvInventory): UvObservation {
  const summary: UvObservation = {
    kind: 'relationship',
    root: null,
    side: null,
    path: null,
    entry: null,
    // Reserve the terminal envelope before optional work; exhaustion only shortens this marker.
    reason: 'complete',
    sourceIds: [],
    memberIds: [],
    value: null,
    nextAction: 'Assess members without a supported immutable path independently.',
  };
  result.observations.push(summary);
  return summary;
}
function contextGuard(side: UvSide): string | null | undefined {
  if (side.marker === null) return null;
  const markers = JSON.parse(side.marker) as string[];
  return markers.length === 1 ? markers[0] : undefined;
}
function compatible(node: UvSide, start: UvSide, edge: string | null) {
  const guard = contextGuard(start);
  return (
    guard !== undefined &&
    node.marker === start.marker &&
    isDeepStrictEqual(node.extras, start.extras) &&
    (edge === null || edge === guard)
  );
}
function children(
  context: UvPathRoot,
  side: 'base' | 'head',
  node: UvRoleNode,
  start: UvSide,
  work: GraphWork,
) {
  const rows: UvSide[] = [];
  for (const edge of node.pkg.dependencies ?? []) {
    work.spend();
    const target = resolveUvSelector(context.root[side], edge, work);
    const targetNode = target ? context[side].nodes.get(target.key) : undefined;
    const instance = targetNode ? uvInstance(targetNode, context.root, side) : null;
    if (instance && targetNode?.membershipComplete && compatible(instance, start, edge.marker))
      rows.push(instance);
  }
  return rows.sort((a, b) => byCodeUnit(uvSemantic(a), uvSemantic(b)));
}
function pathTo(
  context: UvPathRoot,
  side: 'base' | 'head',
  start: UvSide,
  end: UvSide,
  work: GraphWork,
): UvSide[] | null {
  if (!compatible(end, start, null)) return null;
  const queue = [start],
    parents = new Map<string, UvSide | null>([[key(start), null]]);
  for (let i = 0; i < queue.length; i++) {
    work.spend();
    const step = queue[i];
    if (key(step) === key(end)) {
      const path: UvSide[] = [];
      let cursor: UvSide | null = step;
      while (cursor) {
        work.spend();
        path.unshift(cursor);
        cursor = parents.get(key(cursor)) ?? null;
      }
      return path;
    }
    const node = context[side].nodes.get(key(step));
    if (!node || !node.membershipComplete) continue;
    for (const child of children(context, side, node, start, work))
      if (!parents.has(key(child))) {
        parents.set(key(child), step);
        queue.push(child);
      }
  }
  return null;
}
function eligibility(result: UvInventory, member: UvChange) {
  if (member.role === 'unknown') return 'unknown_role';
  if (result.coverage.status !== 'complete') return 'inventory_incomplete';
  const root = (member.to ?? member.from)!.root;
  const changes = result.changes.filter((c) => (c.to ?? c.from)!.root === root);
  if (changes.some((c) => c.role === 'unknown')) return 'unknown_role';
  const anchors = changes.filter((c) => c.role === 'direct');
  if (anchors.length !== 1) return anchors.length ? 'multiple_direct_changes' : 'no_direct_change';
  return anchors[0];
}
function proofFor(
  result: UvInventory,
  contexts: UvPathRoot[],
  member: UvChange,
  work: GraphWork,
): Path | string {
  const anchor = eligibility(result, member);
  if (typeof anchor === 'string') return anchor;
  const side = member.kind === 'removal' ? 'base' : 'head',
    start = side === 'base' ? anchor.from : anchor.to,
    end = side === 'base' ? member.from : member.to;
  if (!start || !end) return 'wrong_side';
  if (start.sourceId !== end.sourceId) return 'source_split';
  const context = contexts.find((c) => c.root.root === end.root);
  if (!context) return 'snapshot_missing';
  const path = pathTo(context, side, start, end, work);
  if (!path) return 'missing_relationship';
  if (path.length > PACKET_LIMITS.pathInstances) return 'path_limit';
  return {
    ecosystem: 'uv',
    fromId: anchor.id,
    toId: member.id,
    side,
    sourceId: start.sourceId,
    path: path.map((p) => ({ ...p, sourceId: start.sourceId })),
  };
}
function isShared(result: UvInventory, contexts: UvPathRoot[], proof: Path, work: GraphWork) {
  const end = proof.path.at(-1)!,
    context = contexts.find((c) => c.root.root === end.root)!;
  const changed = new Set(
    result.changes
      .map((c) => (proof.side === 'base' ? c.from : c.to))
      .filter((s): s is UvSide => s !== null && s.root === end.root)
      .map(key),
  );
  for (const node of context[proof.side].nodes.values()) {
    work.spend();
    if (node.role !== 'direct' || changed.has(node.pkg.key)) continue;
    const start = uvInstance(node, context.root, proof.side);
    if (start && pathTo(context, proof.side, start, end, work)) return true;
  }
  return false;
}
function observation(member: UvChange, reason: string): UvObservation {
  const side = member.kind === 'removal' ? 'base' : 'head',
    instance = (side === 'base' ? member.from : member.to)!;
  return {
    kind: 'relationship',
    root: instance.root,
    side,
    path: instance.root === '.' ? 'uv.lock' : `${instance.root}/uv.lock`,
    entry: key(instance),
    reason,
    sourceIds: [instance.sourceId],
    memberIds: [member.id],
    value: null,
    nextAction:
      reason === 'shared'
        ? 'Retain this known sharing without claiming exclusive ownership.'
        : 'Assess this exact member independently and resolve any required evidence gaps.',
  };
}
function finding(member: UvChange, note: UvObservation, work: GraphWork): Finding {
  const detail =
    note.reason === 'shared'
      ? 'An unchanged direct dependency also has a supported path to this member. Grouping does not prove exclusive ownership or causation.'
      : `Relationship remains unproven: ${note.reason}.`;
  return {
    id: work.id('relationship', [member.id, note.reason]),
    kind: 'informational',
    memberId: member.id,
    detail,
    references: note.sourceIds,
    rationale: 'Each changed instance retains its own evidence requirements.',
    remediation: [note.nextAction],
    validation: ['Inspect the exact cited immutable lockfile instance and selectors.'],
  };
}
function relationshipAddition(
  result: UvInventory,
  contexts: UvPathRoot[],
  member: UvChange,
  work: GraphWork,
) {
  const proof = proofFor(result, contexts, member, work);
  const note =
    typeof proof === 'string'
      ? observation(member, proof)
      : isShared(result, contexts, proof, work)
        ? observation(member, 'shared')
        : null;
  return {
    relationships: typeof proof === 'string' ? [] : [proof],
    observations: note ? [note] : [],
    findings: note ? [finding(member, note, work)] : [],
  };
}
export function proveUvRelationships(
  result: UvInventory,
  contexts: UvPathRoot[],
  work: GraphWork,
  maxBytes: number,
  summary: UvObservation,
) {
  if (result.changes.length > PACKET_LIMITS.changes) {
    summary.reason = 'budget';
    return;
  }
  for (const member of result.changes) {
    if (member.role === 'direct') continue;
    try {
      const addition = relationshipAddition(result, contexts, member, work);
      checkGraphData(addition, work, maxBytes);
      const projected = {
        ...result,
        relationships: [...result.relationships, ...addition.relationships],
        observations: [...result.observations, ...addition.observations],
        findings: [...result.findings, ...addition.findings],
      };
      const completionBytes = 'complete'.length - summary.reason.length;
      if (Buffer.byteLength(JSON.stringify(projected)) + completionBytes > maxBytes) {
        summary.reason = 'budget';
        return;
      }
      result.relationships.push(...addition.relationships);
      result.observations.push(...addition.observations);
      result.findings.push(...addition.findings);
    } catch (error) {
      if (!(error instanceof UvGraphFailure) || error.reason !== 'budget') throw error;
      summary.reason = 'budget';
      return;
    }
  }
  summary.reason = 'complete';
}
