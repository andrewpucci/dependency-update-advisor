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
import { freeze, isPlainObject, isEvidencePath } from './common.js';
import { collectActionResearch, type ActionMappingDraft } from './upstream-actions.js';
import { collectRangeFallback, collectChangelog } from './upstream-range.js';
import {
  collectTargetRelease,
  collectPackageComparison,
  type UpstreamResearch,
  type UpstreamDocument,
} from './upstream-github.js';
import {
  requireUpstream,
  upstreamCopy,
  upstreamLimits,
  upstreamText,
  UpstreamFailure,
  upstreamFailureReason,
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
  if ('workflow' in instance) {
    requireUpstream(
      change.ecosystem === 'actions' &&
        p.path === instance.workflow &&
        upstreamText(instance.jobId),
    );
    requireUpstream(upstreamText(instance.action) && upstreamText(instance.ref));
    requireUpstream(['sha', 'tag', 'branch', 'unknown'].includes(instance.refKind));
    requireUpstream(instance.refKind !== 'sha' || /^[a-f\d]{40}$/u.test(instance.ref));
  } else {
    requireUpstream(instance.root === '.' || isEvidencePath(instance.root));
  }
}
function validateEvidence(input: UpstreamInput, change: PacketChange) {
  if ('basis' in change) {
    requireUpstream(Object.keys(change.evidence).length === 0);
    return;
  }
  const required = ['upstream', 'vulnerability', 'malware'];
  if (change.ecosystem === 'npm') required.push('installScript');
  requireUpstream(required.every((key) => isPlainObject(change.evidence[key])));
  for (const entry of Object.values(change.evidence)) {
    requireUpstream(
      isPlainObject(entry) && ['available', 'partial', 'unavailable'].includes(entry.status),
    );
    requireUpstream(
      Array.isArray(entry.reasons) && entry.reasons.length <= PACKET_LIMITS.listEntries,
    );
    requireUpstream(
      Array.isArray(entry.sourceIds) && entry.sourceIds.length <= PACKET_LIMITS.listEntries,
    );
    requireUpstream(entry.status !== 'available' || entry.sourceIds.length > 0);
    requireUpstream(
      entry.sourceIds.every((id) =>
        input.sources.some((s) => s.id === id && s.memberIds.includes(change.id)),
      ),
    );
  }
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
    requireUpstream(change.id.length <= PACKET_LIMITS.idCodeUnits);
    requireUpstream(['update', 'addition', 'removal'].includes(change.kind));
    requireUpstream(
      change.kind === 'update'
        ? !!change.from && !!change.to
        : change.kind === 'addition'
          ? change.from === null && !!change.to
          : !!change.from && change.to === null,
    );
    validateEvidence(input, change);
    for (const side of ['base', 'head'] as const) inventorySource(input, change, side);
  }
  for (const finding of input.findings) {
    requireUpstream(input.changes.some((c) => c.id === finding.memberId));
    requireUpstream(
      Array.isArray(finding.references) &&
        finding.references.every((id: unknown) =>
          input.sources.some((s) => s.id === id && s.memberIds.includes(finding.memberId)),
        ),
    );
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
  if (change.ecosystem === 'actions' || 'basis' in change) return null;
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return null;
  if (change.ecosystem === 'uv')
    return {
      kind: 'pypi',
      name: instance.name,
      version: instance.version,
      source: instance.source,
    };
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
  return lookup;
}
function researchSource(
  input: UpstreamInput,
  change: PacketChange,
  doc: UpstreamDocument,
  research: UpstreamResearch,
): PacketSource {
  const side = change.to ? 'head' : 'base',
    instance = change.to ?? change.from;
  requireUpstream(instance);
  const value = 'version' in instance ? instance.version : 'ref' in instance ? instance.ref : null;
  requireUpstream(value);
  const excerpt = upstreamExcerpt(doc.text);
  const range =
    side === 'base' && doc.range?.from === null ? { from: doc.range.to, to: null } : doc.range;
  const subjects = [{ memberId: change.id, side: side as 'base' | 'head', value }];
  if (range?.from && range.to && change.from && side === 'head')
    subjects.unshift({ memberId: change.id, side: 'base', value: range.from });
  return {
    id: upstreamId([input.binding.identity, change.id, doc.kind, doc.url, 'research']),
    kind: doc.kind,
    ecosystems: [change.ecosystem],
    memberIds: [change.id],
    status: research.status === 'available' && !excerpt.excerptTruncated ? 'available' : 'partial',
    reasons:
      research.status === 'available' && !excerpt.excerptTruncated
        ? []
        : excerpt.excerptTruncated
          ? ['truncated']
          : research.reasons,
    provenance: {
      kind: 'upstream',
      url: doc.url,
      title: upstreamExcerpt(doc.title).excerpt,
      ...excerpt,
      subjects,
      range,
    },
  };
}
function researchAttempts(
  output: UpstreamEnrichment,
  change: PacketChange,
  research: UpstreamResearch,
  added: PacketSource[],
) {
  const side = change.to ? 'head' : 'base';
  for (const a of research.attempts)
    output.attempts.push({
      ...a,
      memberId: change.id,
      side,
      sourceIds: added
        .filter((s) => s.provenance.kind === 'upstream' && s.provenance.url === a.url)
        .map((s) => s.id),
      truncated: added.some(
        (s) => s.provenance.kind === 'upstream' && s.provenance.excerptTruncated,
      ),
    });
}
function researchCoverage(change: PacketChange, research: UpstreamResearch, added: PacketSource[]) {
  const previous = change.evidence.upstream;
  if (added.length && added.every((s) => s.status === 'available')) {
    change.evidence.upstream = {
      status: 'available',
      sourceIds: added.map((s) => s.id),
      reasons: [],
    };
    return;
  }
  if (previous.status === 'available') return;
  const sourceIds = [...new Set([...previous.sourceIds, ...added.map((s) => s.id)])];
  requireUpstream(sourceIds.length <= PACKET_LIMITS.listEntries, 'budget');
  change.evidence.upstream = {
    status: sourceIds.length ? 'partial' : 'unavailable',
    sourceIds,
    reasons: [
      ...new Set([...previous.reasons, ...research.reasons, ...added.flatMap((s) => s.reasons)]),
    ],
  };
}
export function attachUpstreamResearch(
  input: UpstreamInput,
  output: UpstreamEnrichment,
  change: PacketChange,
  research: UpstreamResearch,
) {
  const added = research.sources.map((doc) => researchSource(input, change, doc, research));
  for (const source of added) retain(output, source);
  researchAttempts(output, change, research, added);
  researchCoverage(change, research, added);
}
function upstreamComplete(change: PacketChange) {
  return change.evidence.upstream.status === 'available';
}
async function packageResearch(
  input: UpstreamInput,
  output: UpstreamEnrichment,
  change: PacketChange,
  lookups: Map<string, UpstreamLookup>,
  reader: UpstreamReader,
) {
  if (change.ecosystem === 'actions' || 'basis' in change) return;
  const instance = change.to ?? change.from,
    lookup = lookups.get(change.to ? 'head' : 'base');
  if (!instance) return;
  if (!lookup?.data) {
    skippedStages(
      output,
      change,
      ['release', 'compare', 'range', 'changelog'],
      lookup?.reasons ?? ['missing'],
      'No attributable metadata',
    );
    return;
  }
  const research = await collectTargetRelease(
    {
      ecosystem: change.ecosystem,
      name: instance.name,
      version: instance.version,
      metadata: lookup.data,
    },
    reader,
  );
  attachUpstreamResearch(input, output, change, research);
  if (upstreamComplete(change)) {
    skippedStages(
      output,
      change,
      ['compare', 'range', 'changelog'],
      [],
      'Target notes satisfied upstream research',
    );
    return;
  }
  const base = lookups.get('base');
  if (!upstreamComplete(change) && change.from && change.to && base?.data) {
    const compared = await collectPackageComparison(
      {
        ecosystem: change.ecosystem,
        name: change.from.name,
        version: change.from.version,
        metadata: base.data,
      },
      {
        ecosystem: change.ecosystem,
        name: change.to.name,
        version: change.to.version,
        metadata: lookup.data,
      },
      reader,
    );
    attachUpstreamResearch(input, output, change, compared);
  }
  if (upstreamComplete(change)) {
    skippedStages(
      output,
      change,
      ['range', 'changelog'],
      [],
      'Comparison satisfied upstream research',
    );
    return;
  }
  const target = {
    ecosystem: change.ecosystem,
    name: instance.name,
    version: instance.version,
    metadata: lookup.data,
  };
  if (change.from && change.to && base?.data) {
    const range = await collectRangeFallback(
      {
        ecosystem: change.ecosystem,
        name: change.from.name,
        version: change.from.version,
        metadata: base.data,
      },
      target,
      reader,
    );
    attachUpstreamResearch(input, output, change, range);
  } else
    skippedStages(
      output,
      change,
      ['compare', 'range'],
      base?.reasons ?? ['unsupported'],
      'No proven two-side range',
    );
  attachUpstreamResearch(input, output, change, await collectChangelog(target, reader));
  const sourceIds = output.sources
    .filter(
      (s) =>
        s.kind === 'metadata' &&
        s.provenance.kind === 'upstream' &&
        s.provenance.url === lookup.url &&
        s.provenance.subjects.some(
          (subject) =>
            subject.memberId === change.id && subject.side === (change.to ? 'head' : 'base'),
        ),
    )
    .map((s) => s.id);
  output.attempts.push({
    memberId: change.id,
    side: change.to ? 'head' : 'base',
    stage: 'metadata',
    target: 'Metadata fallback already fetched for exact identity',
    range: null,
    url: lookup.url,
    outcome: 'available',
    reasons: [],
    sourceIds,
    truncated: false,
  });
}
function skippedStages(
  output: UpstreamEnrichment,
  change: PacketChange,
  stages: UpstreamAttempt['stage'][],
  reasons: readonly EvidenceReason[],
  detail: string,
) {
  for (const stage of stages)
    output.attempts.push({
      memberId: change.id,
      side: change.to ? 'head' : 'base',
      stage,
      target: detail,
      range: null,
      url: null,
      outcome: 'skipped',
      reasons,
      sourceIds: [],
      truncated: false,
    });
}
function attachActionMappings(
  input: UpstreamInput,
  output: UpstreamEnrichment,
  change: PacketChange,
  mappings: readonly ActionMappingDraft[],
) {
  for (const mapping of mappings) {
    const doc = mapping.document,
      excerpt = upstreamExcerpt(doc.text);
    const source: PacketSource = {
      id: upstreamId([input.binding.identity, change.id, mapping.side, 'mapping', doc.url]),
      kind: 'metadata',
      ecosystems: ['actions'],
      memberIds: [change.id],
      status: excerpt.excerptTruncated ? 'partial' : 'available',
      reasons: excerpt.excerptTruncated ? ['truncated'] : [],
      provenance: {
        kind: 'upstream',
        url: doc.url,
        title: upstreamExcerpt(doc.title).excerpt,
        ...excerpt,
        subjects: [{ memberId: change.id, side: mapping.side, value: mapping.ref }],
        range: doc.range,
      },
    };
    retain(output, source);
    if (!excerpt.excerptTruncated)
      output.actionVersions.push({
        memberId: change.id,
        side: mapping.side,
        action: mapping.action,
        ref: mapping.ref,
        name: mapping.name,
        version: mapping.version,
        sourceIds: [source.id],
      });
    if (
      (change.to ? mapping.side === 'head' : mapping.side === 'base') &&
      change.evidence.upstream.status === 'unavailable'
    )
      change.evidence.upstream = {
        status: 'partial',
        reasons: ['unsupported'],
        sourceIds: [source.id],
      };
  }
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
    dependencies.reader.spend(Buffer.byteLength(JSON.stringify(input)));
  } catch (error) {
    return upstreamFailureReason(error) === 'budget'
      ? { kind: 'unavailable', reason: 'budget' }
      : { kind: 'invalid' };
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
      if (change.ecosystem === 'actions') {
        const result = await collectActionResearch(change, dependencies.reader);
        attachActionMappings(input, output, change, result.mappings);
        attachUpstreamResearch(input, output, change, result.research);
        bounds(output, input.limits);
        continue;
      }
      const lookups = new Map<string, UpstreamLookup>();
      for (const side of ['base', 'head'] as const) {
        const lookup = await metadata(input, output, change, side, dependencies.reader);
        if (lookup) lookups.set(side, lookup);
        bounds(output, input.limits);
      }
      await packageResearch(input, output, change, lookups, dependencies.reader);
      bounds(output, input.limits);
    }
    return freeze(output);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof UpstreamFailure ? error.reason : 'unknown',
    };
  }
}
