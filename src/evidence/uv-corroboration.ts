import { isDeepStrictEqual } from 'node:util';
import {
  PACKET_LIMITS,
  type PacketSource,
  type EvidenceReason,
  type SourceSubject,
} from '../schema.js';
import type { UvInventory, UvChange, UvObservation } from './uv-graph.js';
import type { UvMetadata } from './uv.js';
import { isPlainObject, byCodeUnit } from './common.js';
import { UvGraphFailure, uvReasons, type GraphWork } from './uv-input.js';

type Claim =
  | { kind: 'count'; count: number; text: string }
  | { kind: 'package'; name: string; from: string; to: string; text: string };
type Description = {
  status: 'available';
  repository: unknown;
  pullNumber: number;
  headSha: string;
  text: string;
};
function failedSource(result: UvInventory, work: GraphWork): PacketSource {
  return {
    id: work.id('dependabot', [result.binding.identity, result.binding.baseSha, 'unavailable']),
    kind: 'dependabot',
    ecosystems: ['uv'],
    memberIds: [],
    status: 'unavailable',
    reasons: ['missing'],
    provenance: { kind: 'unavailable' },
  };
}
export function startUvCorroboration(result: UvInventory, work: GraphWork) {
  const source = failedSource(result, work);
  result.sources.push(source);
  result.corroboration = { status: 'unattempted', reasons: ['missing'] };
  return source;
}
function reject(
  result: UvInventory,
  source: PacketSource,
  reason: EvidenceReason,
  maxBytes: number,
  status: 'unavailable' | 'unattempted' = 'unavailable',
) {
  const set = (r: EvidenceReason) => {
    result.sources = result.sources.map((s) =>
      s.id === source.id ? { ...source, reasons: [r] } : s,
    );
    result.corroboration = { status, reasons: [r] };
  };
  set(reason);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) set('budget');
}
function shape(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}
function safeDescriptionText(text: string) {
  for (const character of text)
    if (/[\p{Cc}\p{Cs}]/u.test(character) && !['\r', '\n', '\t'].includes(character)) return false;
  return true;
}
function description(
  value: unknown,
  result: UvInventory,
  maxBytes: number,
  work: GraphWork,
): Description {
  if (!shape(value) || value.status !== 'available' || Object.keys(value).length !== 5)
    throw new UvGraphFailure('malformed');
  const b = result.binding;
  if (
    !shape(value.repository) ||
    Object.keys(value.repository).length !== 3 ||
    typeof value.repository.id !== 'number' ||
    typeof value.repository.owner !== 'string' ||
    typeof value.repository.name !== 'string' ||
    typeof value.pullNumber !== 'number' ||
    typeof value.headSha !== 'string' ||
    typeof value.text !== 'string'
  )
    throw new UvGraphFailure('malformed');
  if (
    !isDeepStrictEqual(value.repository, b.repository) ||
    value.pullNumber !== b.pullNumber ||
    value.headSha !== b.headSha
  )
    throw new UvGraphFailure('conflict');
  if (value.text.length > maxBytes || Buffer.byteLength(value.text) > maxBytes)
    throw new UvGraphFailure('budget');
  work.spend(value.text.length);
  if (!safeDescriptionText(value.text)) throw new UvGraphFailure('malformed');
  return value as Description;
}
function claims(text: string): Claim[] {
  const found = new Map<string, Claim>();
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.length > 4096) continue;
    const line = raw
      .trim()
      .replace(/\[([A-Za-z0-9.!+_-]{1,1024})\]\(https:\/\/[^\s)]{1,1024}\)/gu, '$1')
      .replaceAll('`', '');
    const count = /^Resolved uv changes: ([0-9]{1,6})\.?$/u.exec(line);
    if (count) {
      const c: Claim = {
        kind: 'count',
        count: Number(count[1]),
        text: `Resolved uv changes: ${Number(count[1])}.`,
      };
      found.set(c.text, c);
      continue;
    }
    const p =
      /^Bumps ([A-Za-z0-9][A-Za-z0-9._-]{0,1023}) from ([A-Za-z0-9][A-Za-z0-9.!+_-]{0,1023}) to ([A-Za-z0-9][A-Za-z0-9.!+_-]{0,1023}?)\.?$/u.exec(
        line,
      );
    if (!p) continue;
    const name = p[1].toLowerCase().replace(/[-_.]+/gu, '-');
    const c: Claim = {
      kind: 'package',
      name,
      from: p[2],
      to: p[3],
      text: `Bumps ${name} from ${p[2]} to ${p[3]}.`,
    };
    found.set(c.text, c);
  }
  return [...found.values()].sort((a, b) => byCodeUnit(a.text, b.text));
}
function scopedClaims(all: Claim[], metadata: UvMetadata) {
  const names = new Set(
    metadata.roots.flatMap((r) =>
      [r.base, r.head].flatMap(
        (s) => s.lock.data?.packages.filter((p) => p.external).map((p) => p.name) ?? [],
      ),
    ),
  );
  return all.filter((c) => c.kind === 'count' || names.has(c.name));
}
function compare(all: Claim[], changes: UvChange[]) {
  const members = new Map<string, UvChange>();
  let conflict = false;
  for (const c of all) {
    const scoped =
      c.kind === 'count' ? changes : changes.filter((m) => (m.to ?? m.from)!.name === c.name);
    scoped.forEach((m) => members.set(m.id, m));
    if (c.kind === 'count') {
      if (c.count !== changes.length) conflict = true;
      continue;
    }
    if (
      !scoped.some((m) => m.from?.version === c.from) ||
      !scoped.some((m) => m.to?.version === c.to)
    )
      conflict = true;
  }
  return { conflict, members: [...members.values()].sort((a, b) => byCodeUnit(a.id, b.id)) };
}
function sourceChunks(members: UvChange[]) {
  const chunks: { ids: string[]; subjects: SourceSubject[] }[] = [];
  let chunk = { ids: [] as string[], subjects: [] as SourceSubject[] };
  for (const m of members) {
    const subjects: SourceSubject[] = [];
    if (m.from) subjects.push({ memberId: m.id, side: 'base', value: m.from.version });
    if (m.to) subjects.push({ memberId: m.id, side: 'head', value: m.to.version });
    if (chunk.subjects.length + subjects.length > PACKET_LIMITS.listEntries) {
      chunks.push(chunk);
      chunk = { ids: [], subjects: [] };
    }
    chunk.ids.push(m.id);
    chunk.subjects.push(...subjects);
  }
  if (chunk.ids.length) chunks.push(chunk);
  return chunks;
}
function candidate(
  result: UvInventory,
  source: PacketSource,
  all: Claim[],
  members: UvChange[],
  conflict: boolean,
  work: GraphWork,
): UvInventory {
  const lines = all.map((c) => c.text),
    fullExcerpt = lines.join('\n'),
    excerpt = fullExcerpt.slice(0, PACKET_LIMITS.textBytes);
  const assertionId = work.id('assertions', lines);
  const records: PacketSource[] = sourceChunks(members).map((chunk) => ({
    id: work.id('dependabot', [result.binding.identity, assertionId, chunk.ids, conflict]),
    kind: 'dependabot',
    ecosystems: ['uv'],
    memberIds: chunk.ids,
    status: conflict ? 'partial' : 'available',
    reasons: conflict ? ['conflict'] : [],
    provenance: {
      kind: 'upstream',
      url: `https://github.com/${encodeURIComponent(result.binding.repository.owner)}/${encodeURIComponent(result.binding.repository.name)}/pull/${result.binding.pullNumber}`,
      title: 'Dependabot description assertions (normalized)',
      excerpt,
      excerptTruncated: fullExcerpt.length > excerpt.length,
      subjects: chunk.subjects,
      range: null,
    },
  }));
  if (!records.length)
    records.push({ ...source, reasons: [conflict ? 'conflict' : 'unsupported'] });
  const observation: UvObservation = {
    kind: 'corroboration',
    root: null,
    side: null,
    path: null,
    entry: null,
    reason: conflict ? 'conflict' : 'matched',
    sourceIds: records.map((r) => r.id),
    memberIds: members.map((m) => m.id),
    value: {
      assertions: lines.slice(0, PACKET_LIMITS.listEntries),
      assertionsTruncated: lines.length > PACKET_LIMITS.listEntries,
      observedChangeCount: result.changes.length,
    },
    nextAction: conflict
      ? 'Reconcile the current PR description with the immutable uv inventory.'
      : 'Retain these hints separately from immutable package proof and required research.',
  };
  const next: UvInventory = {
    ...result,
    sources: [...result.sources.filter((s) => s.id !== source.id), ...records],
    observations: [...result.observations, observation],
    gaps: [...result.gaps],
    corroboration: {
      status: conflict ? 'partial' : members.length ? 'available' : 'unavailable',
      reasons: conflict ? ['conflict'] : members.length ? [] : ['unsupported'],
    },
  };
  if (conflict) {
    const reasons = [...new Set([...next.coverage.reasons, 'conflict' as const])].sort(byCodeUnit);
    next.gaps.push({
      root: null,
      side: null,
      path: null,
      entry: 'corroboration',
      reason: 'conflict',
      nextAction: observation.nextAction,
    });
    next.coverage = { status: 'partial', reasons, sourceIds: next.coverage.sourceIds };
    next.sources = next.sources.map((s) =>
      s.kind === 'file-list'
        ? {
            ...s,
            status: 'partial',
            reasons,
            provenance:
              s.provenance.kind === 'inventory'
                ? { ...s.provenance, absentEcosystems: [] }
                : s.provenance,
          }
        : s,
    );
  }
  return next;
}
export function corroborateUv(
  result: UvInventory,
  metadata: UvMetadata,
  value: unknown,
  source: PacketSource,
  work: GraphWork,
  maxBytes: number,
) {
  try {
    if (value === undefined) {
      reject(result, source, 'missing', maxBytes, 'unattempted');
      return;
    }
    if (shape(value) && value.status === 'unattempted' && Object.keys(value).length === 1) {
      reject(result, source, 'missing', maxBytes, 'unattempted');
      return;
    }
    if (
      shape(value) &&
      value.status === 'unavailable' &&
      Object.keys(value).length === 2 &&
      uvReasons.includes(value.reason as EvidenceReason)
    ) {
      reject(result, source, value.reason as EvidenceReason, maxBytes);
      return;
    }
    const text = description(value, result, maxBytes, work).text;
    work.spend(
      metadata.roots.reduce(
        (n, r) =>
          n + (r.base.lock.data?.packages.length ?? 0) + (r.head.lock.data?.packages.length ?? 0),
        0,
      ),
    );
    const all = scopedClaims(claims(text), metadata);
    if (!all.length) {
      reject(result, source, 'unsupported', maxBytes);
      return;
    }
    if (!['complete', 'not_applicable'].includes(result.coverage.status)) {
      reject(result, source, 'unknown', maxBytes);
      return;
    }
    // Reserve comparison and source-construction work before learning a contradiction.
    work.spend(
      64 * (all.length + result.changes.length + result.sources.length + 1) +
        all.length * result.changes.length,
    );
    const capacity = candidate(result, source, all, result.changes, true, work);
    if (
      capacity.sources.length > PACKET_LIMITS.sources ||
      Buffer.byteLength(JSON.stringify(capacity)) > maxBytes
    ) {
      reject(result, source, 'budget', maxBytes);
      return;
    }
    const compared = compare(all, result.changes),
      next = candidate(result, source, all, compared.members, compared.conflict, work);
    Object.assign(result, next);
  } catch (error) {
    reject(result, source, error instanceof UvGraphFailure ? error.reason : 'malformed', maxBytes);
  }
}
