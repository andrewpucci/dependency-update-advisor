import { PACKET_LIMITS, type PacketSource } from '../schema.js';
import type { UvMetadata } from './uv.js';
import type { UvInventory } from './uv-graph.js';
import { byCodeUnit, freeze } from './common.js';
import { checkGraphData, UvGraphFailure, type GraphWork } from './uv-input.js';

function splitSources(result: UvInventory, work: GraphWork) {
  const sources: PacketSource[] = [],
    parts = new Map<string, PacketSource[]>();
  for (const s of result.sources) {
    work.spend();
    s.memberIds = [...new Set(s.memberIds)].sort(byCodeUnit);
    const chunks: PacketSource[] = [];
    for (let at = 0; at < Math.max(1, s.memberIds.length); at += PACKET_LIMITS.listEntries) {
      work.spend();
      const memberIds = s.memberIds.slice(at, at + PACKET_LIMITS.listEntries);
      const id =
        s.memberIds.length <= PACKET_LIMITS.listEntries
          ? s.id
          : work.id('file-part', [s.id, memberIds]);
      chunks.push({ ...s, id, memberIds });
    }
    parts.set(s.id, chunks);
    sources.push(...chunks);
  }
  for (const c of result.changes)
    for (const side of [c.from, c.to])
      if (side) {
        work.spend();
        const chunk = parts.get(side.sourceId)?.find((s) => s.memberIds.includes(c.id));
        if (!chunk) throw new UvGraphFailure('conflict');
        side.sourceId = chunk.id;
      }
  if (sources.length > PACKET_LIMITS.sources) throw new UvGraphFailure('budget');
  result.sources = sources.sort((a, b) => byCodeUnit(a.id, b.id));
}
function inventoryCoverage(result: UvInventory, metadata: UvMetadata) {
  const reasons = [...new Set(result.gaps.map((g) => g.reason))].sort(byCodeUnit);
  const applicable = metadata.discovery.applicable || metadata.roots.length > 0;
  const usable = metadata.roots.some((r) =>
    [r.base, r.head].some((s) => s.manifest.data !== null || s.lock.data !== null),
  );
  const status = reasons.length
    ? usable
      ? 'partial'
      : 'unavailable'
    : applicable
      ? 'complete'
      : 'not_applicable';
  const summary = result.sources.find((s) => s.kind === 'file-list')!;
  summary.status = status === 'complete' || status === 'not_applicable' ? 'available' : status;
  summary.reasons = reasons;
  if (summary.provenance.kind === 'inventory')
    summary.provenance.absentEcosystems = status === 'not_applicable' ? ['uv'] : [];
  result.coverage = { status, reasons, sourceIds: [summary.id] };
}
function attachObservations(result: UvInventory, work: GraphWork) {
  for (const o of result.observations) {
    const keys = [o.entry];
    if (
      o.value &&
      typeof o.value === 'object' &&
      'target' in o.value &&
      typeof o.value.target === 'string'
    )
      keys.push(o.value.target);
    for (const c of result.changes) {
      work.spend();
      if (o.root === null || o.root !== (c.to ?? c.from)!.root) continue;
      const sides = o.side === 'base' ? [c.from] : o.side === 'head' ? [c.to] : [c.from, c.to];
      if (
        sides.some(
          (s) =>
            s &&
            keys.includes(
              JSON.stringify([s.name, s.version, { kind: 'registry', url: s.source.identity }]),
            ),
        )
      )
        o.memberIds.push(c.id);
    }
    o.memberIds = [...new Set(o.memberIds)].sort(byCodeUnit);
  }
  result.observations.sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
}
export function prepareUvOutput(
  result: UvInventory,
  metadata: UvMetadata,
  work: GraphWork,
  maxBytes: number,
) {
  result.changes.sort((a, b) => byCodeUnit(a.id, b.id));
  result.gaps.sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
  result.fileIdentities.sort((a, b) => byCodeUnit(a.id, b.id));
  splitSources(result, work);
  inventoryCoverage(result, metadata);
  attachObservations(result, work);
  checkGraphData(result, work, maxBytes);
}
export function finishUvOutput(result: UvInventory, maxBytes: number) {
  result.sources.sort((a, b) => byCodeUnit(a.id, b.id));
  result.gaps.sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
  result.observations.sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
  result.findings.sort((a, b) => byCodeUnit(a.id, b.id));
  result.relationships.sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new UvGraphFailure('budget');
  return freeze(result);
}
