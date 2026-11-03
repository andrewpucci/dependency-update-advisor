import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GithubComparison } from '../github-read.js';
import { parseReviewBinding, type ReviewBinding } from '../event.js';
import {
  PACKET_LIMITS,
  type PacketChange,
  type PacketSource,
  type EvidenceReason,
} from '../schema.js';
import type { Finding } from '../policy.js';
import { freeze, isPlainObject } from './common.js';
import {
  advisoryCheck,
  advisoryLimits,
  advisoryText,
  copyAdvisoryData,
  AdvisoryFailure,
  comparisonAdvisory,
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
type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
export type AdvisoryInput = Readonly<{
  binding: ReviewBinding;
  changes: readonly ReadonlyData<PacketChange>[];
  sources: readonly ReadonlyData<PacketSource>[];
  findings: readonly Finding[];
  publicIdentities: readonly PublicPackageIdentity[];
  limits: AdvisoryLimits;
  comparisons?: readonly GithubComparison[];
  actionVersions?: readonly ActionVersionMapping[];
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
function actionTarget(
  input: AdvisoryInput,
  change: PacketChange,
  side: 'head' | 'base',
): AdvisoryTarget | null {
  const instance = side === 'head' ? change.to : change.from;
  if (!instance || !('action' in instance)) return null;
  const proof = input.actionVersions?.find((p) => p.memberId === change.id && p.side === side);
  if (
    !proof ||
    proof.action !== instance.action ||
    proof.ref !== instance.ref ||
    !advisoryText(proof.name) ||
    !advisoryText(proof.version) ||
    !proof.sourceIds.length
  )
    return null;
  const repository = instance.action.split('/').slice(0, 2).join('/');
  if (proof.name.toLowerCase() !== repository.toLowerCase()) return null;
  const valid = proof.sourceIds.every((ref) => {
    const source = input.sources.find((s) => s.id === ref),
      p = source?.provenance;
    if (
      source?.status !== 'available' ||
      !['release', 'compare', 'metadata'].includes(source.kind) ||
      !source.memberIds.includes(change.id) ||
      !source.ecosystems.includes('actions') ||
      p?.kind !== 'upstream'
    )
      return false;
    const url = new URL(p.url);
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.toLowerCase().startsWith('/' + repository.toLowerCase() + '/') &&
      p.subjects.some(
        (s) => s.memberId === change.id && s.side === side && s.value === instance.ref,
      )
    );
  });
  return valid ? { ecosystem: 'actions', name: proof.name, version: proof.version } : null;
}
function publicTarget(
  input: AdvisoryInput,
  change: PacketChange,
  side: 'head' | 'base',
): AdvisoryTarget | null {
  if (change.ecosystem === 'actions') return actionTarget(input, change, side);
  const instance = side === 'head' ? change.to : change.from;
  if (!instance || !('source' in instance) || instance.source.kind !== 'registry') return null;
  const origin = new URL(instance.source.identity);
  if (
    (change.ecosystem === 'npm'
      ? origin.origin !== 'https://registry.npmjs.org'
      : origin.origin !== 'https://pypi.org' ||
        !['/simple', '/simple/'].includes(origin.pathname)) ||
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
    ? {
        ecosystem: change.ecosystem === 'uv' ? 'pip' : 'npm',
        name: proof.name,
        version: proof.version,
      }
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
            ? 'Attributable advisory evidence identifies this exact target.'
            : 'No active matching reviewed advisory was returned by the complete exact-version query.',
          excerptTruncated: false,
          subjects: [{ memberId: change.id, side, value }],
          range: { from: side === 'base' ? value : null, to: side === 'head' ? value : null },
          ...(record
            ? { advisoryId: record.id, ...(record.range ? { affectedRange: record.range } : {}) }
            : {}),
        }
      : { kind: 'unavailable' },
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
type SideResult = {
  target: AdvisoryTarget | null;
  lookup: AdvisoryLookup | null;
  records: Map<string, PacketSource>;
};
function comparisonManifest(
  change: ReadonlyData<PacketChange>,
  side: 'head' | 'base',
  path: unknown,
) {
  const instance = side === 'head' ? change.to : change.from;
  if (!instance || !advisoryText(path)) return false;
  if ('workflow' in instance) return path === instance.workflow;
  const root = instance.root === '.' ? '' : instance.root + '/';
  return (
    change.ecosystem === 'npm'
      ? ['package.json', 'package-lock.json']
      : ['pyproject.toml', 'uv.lock']
  ).some((p) => path === root + p);
}
function comparisonRecords(
  input: AdvisoryInput,
  change: PacketChange,
  side: 'head' | 'base',
  target: AdvisoryTarget,
) {
  const records: AdvisoryRecord[] = [],
    reasons: EvidenceReason[] = [];
  for (const comparison of input.comparisons ?? []) {
    for (const row of comparison.records) {
      if (
        row.name !== target.name ||
        row.version !== target.version ||
        row.ecosystem !== target.ecosystem ||
        row.change_type !== (side === 'head' ? 'added' : 'removed') ||
        !comparisonManifest(change, side, row.manifest)
      )
        continue;
      const matches = input.changes.filter((c) => {
        const s = side === 'head' ? c.to : c.from;
        return (
          c.ecosystem === change.ecosystem &&
          s &&
          ('name' in s ? s.name : s.action) === target.name &&
          ('version' in s ? s.version : 'ref' in s ? s.ref : '') === target.version &&
          comparisonManifest(c, side, row.manifest)
        );
      });
      if (matches.length !== 1) {
        reasons.push('conflict');
        continue;
      }
      try {
        advisoryCheck(Array.isArray(row.vulnerabilities));
        for (const value of row.vulnerabilities) records.push(comparisonAdvisory(value));
      } catch (error) {
        reasons.push(error instanceof AdvisoryFailure ? error.reason : 'malformed');
      }
    }
  }
  return { records, reasons };
}
function withComparison(
  input: AdvisoryInput,
  change: PacketChange,
  side: 'head' | 'base',
  target: AdvisoryTarget,
  lookup: AdvisoryLookup,
): AdvisoryLookup {
  const compared = comparisonRecords(input, change, side, target);
  const records = [...lookup.records, ...compared.records];
  const reasons = [...new Set([...lookup.reasons, ...compared.reasons])];
  return {
    ...lookup,
    records,
    reasons,
    complete: lookup.complete && compared.reasons.length === 0,
    status: reasons.length ? (records.length ? 'partial' : 'unavailable') : lookup.status,
  };
}
async function collectSide(
  input: AdvisoryInput,
  change: PacketChange,
  side: 'head' | 'base',
  output: AdvisoryEnrichment,
  reader: AdvisoryReader,
): Promise<SideResult> {
  const target = publicTarget(input, change, side);
  const lookup = target
    ? withComparison(input, change, side, target, await reader.read(target))
    : null;
  const evidence = source(change, side, lookup);
  output.sources.push(evidence);
  if (side === 'head' || !change.to)
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
  const records = new Map<string, PacketSource>();
  for (const record of lookup?.records ?? []) {
    const positive = source(change, side, lookup, record);
    output.sources.push(positive);
    records.set(record.id, positive);
  }
  return { target, lookup, records };
}
function samePackage(base: SideResult | null, head: SideResult | null) {
  return (
    !!base?.target &&
    !!head?.target &&
    base.target.ecosystem === head.target.ecosystem &&
    base.target.name === head.target.name
  );
}
function attachFindings(
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
      output.findings.push({
        ...claim,
        rationale:
          'The update introduces this advisory: the complete current-version check excludes it.',
      });
      continue;
    }
    output.findings.push(claim);
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
    output.sources.push(absent);
    output.findings.push({
      ...finding(change, record, base!.records.get(record.id)!.id),
      applicability: 'resolved_by_proposed',
      references: [base!.records.get(record.id)!.id, absent.id],
      rationale: 'The complete proposed-version check excludes this current-version advisory.',
    });
  }
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
  advisoryCheck(
    input.actionVersions === undefined ||
      (Array.isArray(input.actionVersions) &&
        input.actionVersions.length <= PACKET_LIMITS.changes * 2),
  );
  advisoryCheck(
    input.comparisons === undefined ||
      (Array.isArray(input.comparisons) && input.comparisons.length <= PACKET_LIMITS.listEntries),
  );
  for (const c of input.comparisons ?? []) {
    const b = input.binding;
    advisoryCheck(
      isDeepStrictEqual(c.repository, b.repository) &&
        isDeepStrictEqual(c.headRepository, b.headRepository) &&
        c.baseSha === b.baseSha &&
        c.headSha === b.headSha &&
        c.mergeBaseSha === b.mergeBaseSha,
    );
    advisoryCheck(Array.isArray(c.records) && c.records.every(isPlainObject));
  }
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
    sources: structuredClone(input.sources) as PacketSource[],
    findings: [...input.findings],
    lookups: [],
  };
  try {
    for (const change of output.changes) {
      if ('basis' in change) continue;
      const head = change.to
        ? await collectSide(input, change, 'head', output, dependencies.reader)
        : null;
      const base = change.from
        ? await collectSide(input, change, 'base', output, dependencies.reader)
        : null;
      attachFindings(change, output, base, head);
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
