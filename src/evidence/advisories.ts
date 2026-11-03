import { createHash } from 'node:crypto';
import { parseReviewBinding, type ReviewBinding } from '../event.js';
import {
  PACKET_LIMITS,
  type PacketChange,
  type PacketSource,
  type EvidenceReason,
} from '../schema.js';
import type { Finding } from '../policy.js';
import { freeze } from './common.js';
import {
  advisoryCheck,
  advisoryLimits,
  advisoryText,
  copyAdvisoryData,
  AdvisoryFailure,
  type AdvisoryLimits,
  type AdvisoryReader,
  type AdvisoryTarget,
  type AdvisoryLookup,
  type AdvisoryRecord,
} from './advisory-read.js';

export type PublicPackageIdentity = Readonly<{
  memberId: string;
  side: 'base' | 'head';
  ecosystem: 'npm' | 'uv';
  name: string;
  version: string;
  sourceIdentity: string;
  sourceIds: readonly string[];
}>;
export type ActionVersionMapping = Readonly<{
  memberId: string;
  side: 'base' | 'head';
  action: string;
  ref: string;
  name: string;
  version: string;
  sourceIds: readonly string[];
}>;
export type AdvisoryInput = Readonly<{
  binding: ReviewBinding;
  changes: readonly PacketChange[];
  sources: readonly PacketSource[];
  findings: readonly Finding[];
  publicIdentities: readonly PublicPackageIdentity[];
  limits: AdvisoryLimits;
}>;
export type MemberAdvisoryLookup = Readonly<{
  memberId: string;
  side: 'base' | 'head';
  lookup: AdvisoryLookup | null;
  reasons: readonly EvidenceReason[];
}>;
export type AdvisoryEnrichment = {
  kind: 'enriched';
  binding: ReviewBinding;
  changes: PacketChange[];
  sources: PacketSource[];
  findings: Finding[];
  lookups: MemberAdvisoryLookup[];
};
export type AdvisoryResult =
  | Readonly<AdvisoryEnrichment>
  | { kind: 'invalid' }
  | { kind: 'unavailable'; reason: EvidenceReason };
const id = (value: unknown) =>
  'advisory:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function publicTarget(
  input: AdvisoryInput,
  change: PacketChange,
  side: 'head' | 'base',
): AdvisoryTarget | null {
  const instance = side === 'head' ? change.to : change.from;
  if (
    !instance ||
    !('source' in instance) ||
    change.ecosystem !== 'npm' ||
    instance.source.kind !== 'registry'
  )
    return null;
  const origin = new URL(instance.source.identity);
  if (
    origin.origin !== 'https://registry.npmjs.org' ||
    origin.username ||
    origin.password ||
    origin.hash ||
    origin.search
  )
    return null;
  const proof = input.publicIdentities.find((p) => p.memberId === change.id && p.side === side);
  if (
    !proof ||
    proof.ecosystem !== change.ecosystem ||
    proof.name !== instance.name ||
    proof.version !== instance.version ||
    proof.sourceIdentity !== instance.source.identity ||
    !proof.sourceIds.length
  )
    return null;
  const valid = proof.sourceIds.every((ref) => {
    const source = input.sources.find((s) => s.id === ref),
      p = source?.provenance;
    if (
      source?.status !== 'available' ||
      !source.memberIds.includes(change.id) ||
      !source.ecosystems.includes(change.ecosystem) ||
      p?.kind !== 'upstream'
    )
      return false;
    return (
      new URL(p.url).origin === origin.origin &&
      p.subjects.some(
        (s) => s.memberId === change.id && s.side === side && s.value === instance.version,
      )
    );
  });
  return valid && advisoryText(proof.name) && advisoryText(proof.version)
    ? { ecosystem: 'npm', name: proof.name, version: proof.version }
    : null;
}
function source(
  change: PacketChange,
  side: 'head' | 'base',
  lookup: AdvisoryLookup | null,
  record?: AdvisoryRecord,
): PacketSource {
  const instance = side === 'head' ? change.to : change.from;
  advisoryCheck(instance);
  const value = 'ref' in instance ? instance.ref : 'version' in instance ? instance.version : '';
  const success = !!lookup && (record || lookup.complete);
  return {
    id: id([change.id, side, record?.id ?? 'lookup']),
    kind: 'advisory',
    ecosystems: [change.ecosystem],
    memberIds: [change.id],
    status: success ? 'available' : 'unavailable',
    reasons: success ? [] : [...(lookup?.reasons ?? ['unsupported'])],
    provenance: success
      ? {
          kind: 'upstream',
          url: record?.url ?? lookup!.url,
          title: record?.title ?? 'Exact-version reviewed advisory lookup',
          excerpt: record
            ? 'The exact-version query returned this advisory.'
            : 'No active matching reviewed advisory was returned by the complete exact-version query.',
          excerptTruncated: false,
          subjects: [{ memberId: change.id, side, value }],
          range: { from: side === 'base' ? value : null, to: side === 'head' ? value : null },
          ...(record ? { advisoryId: record.id, affectedRange: record.range } : {}),
        }
      : { kind: 'unavailable' },
  };
}
function finding(change: PacketChange, record: AdvisoryRecord, ref: string): Finding {
  return {
    id: id([change.id, record.id, 'finding']),
    memberId: change.id,
    kind: 'vulnerability',
    applicability: record.withdrawn ? 'withdrawn' : 'affects_proposed',
    ...(record.severity ? { severity: record.severity } : {}),
    affectedRange: record.range,
    references: [ref],
    rationale: record.withdrawn
      ? 'The cited advisory was withdrawn.'
      : 'The cited reviewed advisory affects the exact proposed target.',
    remediation: [],
    validation: [],
  };
}
function validate(input: AdvisoryInput) {
  advisoryCheck(parseReviewBinding(input.binding));
  advisoryCheck(Array.isArray(input.changes) && input.changes.length <= PACKET_LIMITS.changes);
  advisoryCheck(Array.isArray(input.sources) && input.sources.length <= PACKET_LIMITS.sources);
  advisoryCheck(Array.isArray(input.findings) && input.findings.length <= PACKET_LIMITS.findings);
  advisoryCheck(
    Array.isArray(input.publicIdentities) &&
      input.publicIdentities.length <= PACKET_LIMITS.changes * 2,
  );
  advisoryCheck(new Set(input.changes.map((c) => c.id)).size === input.changes.length);
  advisoryCheck(new Set(input.sources.map((s) => s.id)).size === input.sources.length);
  for (const c of input.changes) {
    advisoryCheck(advisoryText(c.id) && ['npm', 'uv', 'actions'].includes(c.ecosystem));
    for (const [side, instance] of [
      ['base', c.from],
      ['head', c.to],
    ] as const) {
      if (!instance) continue;
      const s = input.sources.find((s) => s.id === instance.sourceId),
        p = s?.provenance;
      advisoryCheck(
        s?.kind === 'file' &&
          s.status === 'available' &&
          s.memberIds.includes(c.id) &&
          s.ecosystems.includes(c.ecosystem),
      );
      advisoryCheck(
        p?.kind === 'file' &&
          p.revision === side &&
          p.sha === (side === 'base' ? input.binding.baseSha : input.binding.headSha),
      );
      advisoryCheck(p.repository.id === input.binding.repository.id);
    }
  }
}
export async function enrichAdvisories(
  value: AdvisoryInput,
  dependencies: { reader: AdvisoryReader },
): Promise<AdvisoryResult> {
  let input: AdvisoryInput;
  try {
    const limits = advisoryLimits(value.limits);
    input = copyAdvisoryData(value, limits);
    validate(input);
  } catch {
    return { kind: 'invalid' };
  }
  const output: AdvisoryEnrichment = {
    kind: 'enriched',
    binding: input.binding,
    changes: structuredClone(input.changes) as PacketChange[],
    sources: [...input.sources],
    findings: [...input.findings],
    lookups: [],
  };
  try {
    for (const change of output.changes) {
      if ('basis' in change) continue;
      const side = change.to ? 'head' : 'base';
      const target = publicTarget(input, change, side);
      const lookup = target ? await dependencies.reader.read(target) : null;
      const evidence = source(change, side, lookup);
      output.sources.push(evidence);
      change.evidence.vulnerability = {
        status: lookup?.complete ? 'available' : lookup?.records.length ? 'partial' : 'unavailable',
        reasons: lookup?.complete ? [] : [...(lookup?.reasons ?? ['unsupported'])],
        sourceIds: [evidence.id],
      };
      output.lookups.push({
        memberId: change.id,
        side,
        lookup,
        reasons: lookup?.reasons ?? ['unsupported'],
      });
      for (const record of lookup?.records ?? []) {
        const positive = source(change, side, lookup, record);
        output.sources.push(positive);
        if (side === 'head') output.findings.push(finding(change, record, positive.id));
      }
    }
    advisoryCheck(
      output.sources.length <= PACKET_LIMITS.sources &&
        output.findings.length <=
          Math.min(PACKET_LIMITS.findings, input.findings.length + input.limits.maxFindings),
      'budget',
    );
    advisoryCheck(
      Buffer.byteLength(JSON.stringify(output)) <=
        Math.min(input.limits.maxRetainedBytes, PACKET_LIMITS.bytes),
      'budget',
    );
    return freeze(output);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof AdvisoryFailure ? error.reason : 'unknown',
    };
  }
}
