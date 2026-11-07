import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseReviewBinding, type ReviewBinding } from '../event.js';
import {
  PACKET_LIMITS,
  type PacketChange,
  type PacketSource,
  type EvidenceReason,
  type SourceProvenance,
} from '../schema.js';
import type { Finding } from '../policy.js';
import type { NpmInventoryResult, NpmNode } from './npm.js';
import type { PublicPackageIdentity, ActionVersionMapping } from './advisories.js';
import { freeze, isPlainObject } from './common.js';
import {
  requireUpstream,
  upstreamCopy,
  upstreamLimits,
  upstreamText,
  UpstreamFailure,
  type UpstreamLimits,
  type UpstreamLookup,
  type UpstreamReader,
  type UpstreamTarget,
} from './upstream-read.js';

type Inventory = Extract<NpmInventoryResult, { kind: 'inventory' }>;
export type UpstreamInput = Readonly<{
  binding: ReviewBinding;
  changes: readonly PacketChange[];
  sources: readonly PacketSource[];
  findings: readonly Finding[];
  limits: UpstreamLimits;
  npmInventory?: Inventory;
}>;
export type UpstreamAttempt = Readonly<{
  memberId: string;
  side: 'base' | 'head';
  stage: 'metadata' | 'release' | 'compare' | 'range' | 'changelog' | 'mapping';
  target: string;
  range: { from: string | null; to: string | null } | null;
  url: string | null;
  outcome: 'available' | 'unavailable' | 'skipped';
  reasons: readonly EvidenceReason[];
  sourceIds: readonly string[];
  truncated: boolean;
}>;
export type UpstreamEnrichment = {
  kind: 'enriched';
  binding: ReviewBinding;
  changes: PacketChange[];
  sources: PacketSource[];
  findings: Finding[];
  attempts: UpstreamAttempt[];
  publicIdentities: PublicPackageIdentity[];
  actionVersions: ActionVersionMapping[];
};
export type UpstreamResult =
  | Readonly<UpstreamEnrichment>
  | { kind: 'invalid' }
  | { kind: 'unavailable'; reason: EvidenceReason };

function inventorySource(input: UpstreamInput, change: PacketChange, side: 'base' | 'head') {
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return;
  requireUpstream(upstreamText(instance.sourceId));
  const source = input.sources.find((s) => s.id === instance.sourceId);
  requireUpstream(
    source?.kind === 'file' && source.status === 'available' && source.provenance.kind === 'file',
  );
  const p = source.provenance;
  requireUpstream(
    p.revision === side &&
      p.sha === (side === 'base' ? input.binding.baseSha : input.binding.headSha),
  );
  requireUpstream(isDeepStrictEqual(p.repository, input.binding.repository));
  requireUpstream(
    source.memberIds.includes(change.id) && source.ecosystems.includes(change.ecosystem),
  );
  if ('name' in instance) requireUpstream(upstreamText(instance.name));
  if ('version' in instance) requireUpstream(upstreamText(instance.version));
}
function prepare(value: unknown, limits: UpstreamLimits): UpstreamInput {
  const cloned = upstreamCopy(value, limits);
  requireUpstream(isPlainObject(cloned));
  const input = cloned as unknown as UpstreamInput;
  requireUpstream(isDeepStrictEqual(parseReviewBinding(input.binding), input.binding));
  requireUpstream(Array.isArray(input.changes) && input.changes.length <= PACKET_LIMITS.changes);
  requireUpstream(Array.isArray(input.sources) && input.sources.length <= PACKET_LIMITS.sources);
  requireUpstream(Array.isArray(input.findings) && input.findings.length <= PACKET_LIMITS.findings);
  requireUpstream(new Set(input.sources.map((s) => s.id)).size === input.sources.length);
  requireUpstream(new Set(input.changes.map((c) => c.id)).size === input.changes.length);
  for (const change of input.changes) {
    requireUpstream(upstreamText(change.id) && ['npm', 'uv', 'actions'].includes(change.ecosystem));
    requireUpstream(['direct', 'transitive', 'unknown'].includes(change.role));
    requireUpstream(isPlainObject(change.evidence));
    for (const side of ['base', 'head'] as const) inventorySource(input, change, side);
  }
  if (input.npmInventory) {
    requireUpstream(input.npmInventory.kind === 'inventory');
    requireUpstream(isDeepStrictEqual(input.npmInventory.binding, input.binding));
    requireUpstream(
      input.npmInventory.changes.every((c) =>
        input.changes.some(
          (x) =>
            x.id === c.id && isDeepStrictEqual(x.from, c.from) && isDeepStrictEqual(x.to, c.to),
        ),
      ),
    );
  }
  for (const change of input.changes) {
    if (change.ecosystem !== 'npm' || 'basis' in change) continue;
    for (const side of ['base', 'head'] as const) npmNode(input, change, side);
  }
  return input;
}
function npmNode(
  input: UpstreamInput,
  change: PacketChange,
  side: 'base' | 'head',
): NpmNode | null {
  const instance = side === 'base' ? change.from : change.to;
  if (!instance || !('lockPath' in instance)) return null;
  const root = input.npmInventory?.roots.find((r) => r.root === instance.root);
  const node = root?.[side].packages[instance.lockPath];
  requireUpstream(!node || isDeepStrictEqual(node.instance, instance));
  if (node && root) {
    requireUpstream(root[side].state === 'present' && root[side].lockId === instance.sourceId);
    const source = input.sources.find((s) => s.id === instance.sourceId);
    requireUpstream(
      source?.provenance.kind === 'file' &&
        source.provenance.path ===
          (instance.root === '.' ? '' : instance.root + '/') + 'package-lock.json',
    );
  }
  return node ?? null;
}
function metadataTarget(
  input: UpstreamInput,
  change: PacketChange,
  side: 'base' | 'head',
): UpstreamTarget | null {
  if (change.ecosystem !== 'npm' || 'basis' in change) return null;
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return null;
  const node = npmNode(input, change, side);
  if (!node?.integrity) return null;
  return {
    kind: 'npm',
    name: instance.name,
    version: instance.version,
    source: instance.source,
    integrity: node.integrity,
  };
}
export function upstreamId(parts: unknown[]) {
  return 's2:' + createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function upstreamExcerpt(text: string) {
  const clean = text.replace(/[\p{Cc}\p{Cs}]/gu, (point) =>
    ['\t', '\n', '\r'].includes(point) ? point : ' ',
  );
  let excerpt = '',
    bytes = 0;
  for (const point of clean) {
    const next = Buffer.byteLength(point);
    if (bytes + next > PACKET_LIMITS.textBytes) break;
    excerpt += point;
    bytes += next;
  }
  return { excerpt, excerptTruncated: excerpt !== clean };
}
function metadataSource(
  input: UpstreamInput,
  change: PacketChange,
  side: 'base' | 'head',
  lookup: UpstreamLookup,
): PacketSource {
  const instance = side === 'base' ? change.from : change.to;
  requireUpstream(instance && 'version' in instance && lookup.url && lookup.data);
  const description =
    typeof lookup.data.description === 'string'
      ? lookup.data.description
      : 'Exact public registry package/version metadata; no release notes were reviewed.';
  const provenance: SourceProvenance = {
    kind: 'upstream',
    url: lookup.url,
    title: `${instance.name} ${instance.version} metadata`,
    ...upstreamExcerpt(description),
    subjects: [{ memberId: change.id, side, value: instance.version }],
    range:
      side === 'base' ? { from: instance.version, to: null } : { from: null, to: instance.version },
  };
  return {
    id: upstreamId([input.binding.identity, change.id, side, 'metadata', lookup.url]),
    kind: 'metadata',
    ecosystems: [change.ecosystem],
    memberIds: [change.id],
    status: 'available',
    reasons: [],
    provenance,
  };
}
function retain(output: UpstreamEnrichment, source: PacketSource) {
  const previous = output.sources.find((s) => s.id === source.id);
  requireUpstream(!previous || isDeepStrictEqual(previous, source), 'conflict');
  if (!previous) output.sources.push(source);
}
function bounds(output: UpstreamEnrichment, limits: UpstreamLimits) {
  requireUpstream(
    output.sources.length <= PACKET_LIMITS.sources && output.attempts.length <= limits.maxAttempts,
    'budget',
  );
  requireUpstream(
    Buffer.byteLength(JSON.stringify(output)) <=
      Math.min(limits.maxRetainedBytes, PACKET_LIMITS.bytes),
    'budget',
  );
}
async function metadata(
  input: UpstreamInput,
  output: UpstreamEnrichment,
  change: PacketChange,
  side: 'base' | 'head',
  reader: UpstreamReader,
) {
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return;
  const target = metadataTarget(input, change, side);
  const lookup: UpstreamLookup = target
    ? await reader.read(target)
    : { status: 'unavailable', fetched: false, url: null, data: null, reasons: ['unsupported'] };
  const sourceIds: string[] = [];
  if (lookup.status === 'available') {
    const source = metadataSource(input, change, side, lookup);
    retain(output, source);
    sourceIds.push(source.id);
    requireUpstream('version' in instance && change.ecosystem !== 'actions');
    output.publicIdentities.push({
      memberId: change.id,
      side,
      ecosystem: change.ecosystem,
      name: instance.name,
      version: instance.version,
      sourceIdentity: instance.source.identity,
      sourceIds,
    });
  }
  output.attempts.push({
    memberId: change.id,
    side,
    stage: 'metadata',
    target:
      'name' in instance
        ? `${instance.name}@${'version' in instance ? instance.version : ''}`
        : instance.action + '@' + instance.ref,
    range:
      'version' in instance
        ? side === 'base'
          ? { from: instance.version, to: null }
          : { from: null, to: instance.version }
        : null,
    url: lookup.url,
    outcome:
      lookup.status === 'available' ? 'available' : lookup.fetched ? 'unavailable' : 'skipped',
    reasons: lookup.reasons,
    sourceIds,
    truncated: sourceIds.some((id) => {
      const p = output.sources.find((s) => s.id === id)?.provenance;
      return p?.kind === 'upstream' && p.excerptTruncated;
    }),
  });
  if (change.to ? side === 'head' : side === 'base')
    change.evidence.upstream = {
      status: sourceIds.length ? 'partial' : 'unavailable',
      sourceIds,
      reasons: sourceIds.length ? ['unsupported'] : [...lookup.reasons],
    };
}
/** Enrich exact inventory identities; caller retains inventory coverage and relationships separately. */
export async function enrichUpstream(
  value: unknown,
  dependencies: { reader: UpstreamReader },
): Promise<UpstreamResult> {
  let input: UpstreamInput;
  try {
    const raw = value as { limits?: unknown };
    requireUpstream(isPlainObject(raw));
    const limits = upstreamLimits(raw.limits);
    requireUpstream(isDeepStrictEqual(limits, dependencies.reader.limits));
    input = prepare(value, limits);
  } catch {
    return { kind: 'invalid' };
  }
  const output: UpstreamEnrichment = {
    kind: 'enriched',
    binding: input.binding,
    changes: structuredClone(input.changes) as PacketChange[],
    sources: structuredClone(input.sources) as PacketSource[],
    findings: [...input.findings],
    attempts: [],
    publicIdentities: [],
    actionVersions: [],
  };
  try {
    bounds(output, input.limits);
    for (const change of output.changes) {
      if ('basis' in change) continue;
      for (const side of ['base', 'head'] as const) {
        await metadata(input, output, change, side, dependencies.reader);
        bounds(output, input.limits);
      }
    }
    return freeze(output);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof UpstreamFailure ? error.reason : 'unknown',
    };
  }
}
