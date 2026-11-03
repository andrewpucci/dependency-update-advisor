import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PacketChange, PacketSource, EvidenceReason } from '../schema.js';
import type { Finding } from '../policy.js';
import {
  advisoryCheck,
  type AdvisoryTarget,
  type AdvisoryLookup,
  type AdvisoryRecord,
} from './advisory-read.js';
import type { AdvisoryEnrichment } from './advisories.js';
export function reconcileRecords(values: readonly AdvisoryRecord[]) {
  const records = new Map<string, AdvisoryRecord>(),
    conflicts = new Set<string>();
  for (const record of values) {
    const old = records.get(record.id);
    if (
      old &&
      (old.withdrawn !== record.withdrawn ||
        old.severity !== record.severity ||
        (old.range !== undefined && record.range !== undefined && old.range !== record.range))
    )
      conflicts.add(record.id);
    else
      records.set(
        record.id,
        old ? { ...old, ...(record.range ? { range: record.range } : {}) } : record,
      );
  }
  return {
    records: [...records.values()].filter((r) => !conflicts.has(r.id)),
    reasons: conflicts.size ? ['conflict' as EvidenceReason] : [],
  };
}
export function addSource(output: AdvisoryEnrichment, value: PacketSource) {
  const old = output.sources.find((s) => s.id === value.id);
  advisoryCheck(!old || isDeepStrictEqual(old, value), 'conflict');
  if (!old) output.sources.push(value);
}
function ghsa(output: AdvisoryEnrichment, value: Finding) {
  const identities = value.references
    .map((ref) => output.sources.find((s) => s.id === ref)?.provenance)
    .filter((p) => p?.kind === 'upstream')
    .map((p) => p.advisoryId);
  return identities[0];
}
function addFinding(
  output: AdvisoryEnrichment,
  value: Extract<Finding, { kind: 'vulnerability' }>,
) {
  const identity = ghsa(output, value);
  const old = output.findings.find(
    (f) =>
      f.kind === 'vulnerability' && f.memberId === value.memberId && ghsa(output, f) === identity,
  );
  if (!old) {
    output.findings.push(value);
    return;
  }
  advisoryCheck(
    old.kind === 'vulnerability' &&
      old.applicability === value.applicability &&
      old.severity === value.severity &&
      (!old.affectedRange || !value.affectedRange || old.affectedRange === value.affectedRange),
    'conflict',
  );
}
const id = (value: unknown) =>
  'advisory:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function subjectValue(change: PacketChange, side: 'head' | 'base') {
  const instance = side === 'head' ? change.to : change.from;
  advisoryCheck(instance);
  return 'ref' in instance ? instance.ref : 'version' in instance ? instance.version : '';
}
function provenance(
  change: PacketChange,
  side: 'head' | 'base',
  lookup: AdvisoryLookup,
  record?: AdvisoryRecord,
): Extract<PacketSource['provenance'], { kind: 'upstream' }> {
  const value = subjectValue(change, side);
  return {
    kind: 'upstream',
    url: record?.url ?? lookup.url,
    title: record?.title ?? 'Exact-version reviewed advisory lookup',
    excerpt: record
      ? 'Attributable advisory evidence identifies this exact target.'
      : 'The complete exact-version query checked reviewed advisories for this target.',
    excerptTruncated: false,
    subjects: [{ memberId: change.id, side, value }],
    range: { from: side === 'base' ? value : null, to: side === 'head' ? value : null },
    ...(record
      ? { advisoryId: record.id, ...(record.range ? { affectedRange: record.range } : {}) }
      : {}),
  };
}
export function source(
  change: PacketChange,
  side: 'head' | 'base',
  lookup: AdvisoryLookup | null,
  record?: AdvisoryRecord,
): PacketSource {
  const success = !!lookup && (record || lookup.complete);
  return {
    id: id([change.id, side, record?.id ?? 'lookup']),
    kind: 'advisory',
    ecosystems: [change.ecosystem],
    memberIds: [change.id],
    status: success ? 'available' : 'unavailable',
    reasons: success ? [] : [...(lookup?.reasons ?? ['unsupported'])],
    provenance: success ? provenance(change, side, lookup!, record) : { kind: 'unavailable' },
  };
}
function finding(
  change: PacketChange,
  record: AdvisoryRecord,
  ref: string,
): Extract<Finding, { kind: 'vulnerability' }> {
  return {
    id: id([change.id, record.id, 'finding']),
    memberId: change.id,
    kind: 'vulnerability',
    applicability: record.withdrawn ? 'withdrawn' : 'affects_proposed',
    ...(record.severity ? { severity: record.severity } : {}),
    ...(record.range ? { affectedRange: record.range } : {}),
    references: [ref],
    rationale: record.withdrawn
      ? 'The cited advisory was withdrawn.'
      : 'The cited reviewed advisory affects the exact proposed target.',
    remediation: [],
    validation: [],
  };
}
export type SideResult = {
  target: AdvisoryTarget | null;
  lookup: AdvisoryLookup | null;
  records: Map<string, PacketSource>;
};
function samePackage(base: SideResult | null, head: SideResult | null) {
  return (
    !!base?.target &&
    !!head?.target &&
    base.target.ecosystem === head.target.ecosystem &&
    base.target.name === head.target.name
  );
}
export function attachFindings(
  change: PacketChange,
  output: AdvisoryEnrichment,
  base: SideResult | null,
  head: SideResult | null,
) {
  for (const record of head?.lookup?.records ?? []) {
    const claim = finding(change, record, head!.records.get(record.id)!.id);
    if (
      !record.withdrawn &&
      samePackage(base, head) &&
      base?.lookup?.complete &&
      !base.lookup.records.some((r) => r.id === record.id)
    ) {
      addFinding(output, {
        ...claim,
        rationale:
          'The update introduces this advisory: the complete current-version check excludes it.',
      });
      continue;
    }
    addFinding(output, claim);
  }
  if (!samePackage(base, head) || !head?.lookup?.complete) return;
  for (const record of base?.lookup?.records ?? []) {
    if (record.withdrawn || head.lookup.records.some((r) => r.id === record.id)) continue;
    const absent = source(change, 'head', head.lookup, record);
    if (absent.provenance.kind === 'upstream') {
      absent.provenance.url = head.lookup.url;
      absent.provenance.excerpt =
        'The complete proposed-version query excludes this current-version advisory.';
    }
    addSource(output, absent);
    addFinding(output, {
      ...finding(change, record, base!.records.get(record.id)!.id),
      applicability: 'resolved_by_proposed',
      references: [base!.records.get(record.id)!.id, absent.id],
      rationale: 'The complete proposed-version check excludes this current-version advisory.',
    });
  }
}
