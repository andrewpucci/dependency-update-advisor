import {
  source,
  attachFindings,
  reconcileRecords,
  addSource,
  type SideResult,
} from './advisory-evidence.js';
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
import { freeze, isPlainObject, isEvidencePath } from './common.js';
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
      !['metadata', 'install-script'].includes(source.kind) ||
      !source.memberIds.includes(change.id) ||
      !source.ecosystems.includes(change.ecosystem) ||
      p?.kind !== 'upstream'
    )
      return false;
    const url = new URL(p.url);
    return (
      url.origin === origin.origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
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
  const reconciled = reconcileRecords([...lookup.records, ...compared.records]);
  const records = reconciled.records;
  const reasons = [...new Set([...lookup.reasons, ...compared.reasons, ...reconciled.reasons])];
  return {
    ...lookup,
    records,
    reasons,
    complete: lookup.complete && compared.reasons.length === 0 && reconciled.reasons.length === 0,
    status: reasons.length ? (records.length ? 'partial' : 'unavailable') : lookup.status,
  };
}
async function collectSide(
  input: AdvisoryInput,
  change: PacketChange,
  side: 'head' | 'base',
  output: AdvisoryEnrichment,
  reader: AdvisoryReader,
  cache: Map<string, AdvisoryLookup>,
): Promise<SideResult> {
  const target = publicTarget(input, change, side);
  let lookup: AdvisoryLookup | null = null;
  if (target) {
    const key = JSON.stringify(target);
    let checked = cache.get(key);
    if (!checked) {
      checked = await reader.read(target);
      cache.set(key, checked);
    }
    lookup = withComparison(input, change, side, target, checked);
  }
  const evidence = source(change, side, lookup);
  addSource(output, evidence);
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
    addSource(output, positive);
    records.set(record.id, positive);
  }
  return { target, lookup, records };
}
function instanceKey(instance: NonNullable<ReadonlyData<PacketChange>['from']>) {
  if ('action' in instance)
    return JSON.stringify([
      instance.workflow,
      instance.jobId,
      instance.stepIndex,
      instance.action,
      instance.ref,
      instance.refKind,
    ]);
  if ('specifiers' in instance)
    return JSON.stringify([
      instance.root,
      instance.name,
      Object.entries(instance.specifiers).sort(),
    ]);
  if ('lockPath' in instance)
    return JSON.stringify([
      instance.root,
      instance.lockPath,
      instance.name,
      instance.version,
      instance.source.kind,
      instance.source.identity,
    ]);
  return JSON.stringify([
    instance.root,
    instance.name,
    instance.version,
    instance.source.kind,
    instance.source.identity,
    instance.marker,
    instance.extras,
    instance.groups,
  ]);
}
function validateChanges(input: AdvisoryInput) {
  const instances = new Set<string>();
  for (const c of input.changes) {
    advisoryCheck(
      advisoryText(c.id) &&
        c.id.length <= PACKET_LIMITS.idCodeUnits &&
        ['npm', 'uv', 'actions'].includes(c.ecosystem),
    );
    advisoryCheck(
      ['direct', 'transitive', 'unknown'].includes(c.role) && isPlainObject(c.evidence),
    );
    advisoryCheck(
      (c.from === null || isPlainObject(c.from)) && (c.to === null || isPlainObject(c.to)),
    );
    advisoryCheck(
      c.kind === 'update'
        ? c.from && c.to
        : c.kind === 'addition'
          ? c.from === null && c.to
          : c.kind === 'removal' && c.from && c.to === null,
    );
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
          p.sha === (side === 'base' ? input.binding.baseSha : input.binding.headSha) &&
          isEvidencePath(p.path),
      );
      advisoryCheck(
        isDeepStrictEqual(
          p.repository,
          side === 'base' ? input.binding.repository : input.binding.headRepository,
        ),
      );
      const key = JSON.stringify([c.ecosystem, side, instanceKey(instance)]);
      advisoryCheck(!instances.has(key));
      instances.add(key);
    }
  }
}
function validateSources(input: AdvisoryInput) {
  for (const s of input.sources) {
    advisoryCheck(advisoryText(s.id) && s.id.length <= PACKET_LIMITS.idCodeUnits);
    advisoryCheck(
      Array.isArray(s.ecosystems) &&
        Array.isArray(s.memberIds) &&
        s.memberIds.length <= PACKET_LIMITS.listEntries,
    );
    advisoryCheck(s.memberIds.every((id) => input.changes.some((c) => c.id === id)));
    const p = s.provenance;
    advisoryCheck(isPlainObject(p));
    if (p.kind !== 'upstream') continue;
    const url = new URL(p.url);
    advisoryCheck(
      url.protocol === 'https:' &&
        url.hostname &&
        !url.username &&
        !url.password &&
        !/[\p{Cc}\p{Cs}]/u.test(p.url),
    );
    advisoryCheck(Array.isArray(p.subjects) && p.subjects.length <= PACKET_LIMITS.listEntries);
  }
  for (const f of input.findings) {
    advisoryCheck(input.changes.some((c) => c.id === f.memberId));
    advisoryCheck(
      Array.isArray(f.references) &&
        f.references.length > 0 &&
        f.references.length <= PACKET_LIMITS.listEntries,
    );
    advisoryCheck(
      f.references.every((id) =>
        input.sources.some((s) => s.id === id && s.memberIds.includes(f.memberId)),
      ),
    );
  }
}
function validateProofs(input: AdvisoryInput) {
  const proofs = [...input.publicIdentities, ...(input.actionVersions ?? [])];
  advisoryCheck(
    new Set(proofs.map((p) => JSON.stringify([p.memberId, p.side]))).size === proofs.length,
  );
  for (const p of proofs) {
    const change = input.changes.find((c) => c.id === p.memberId);
    advisoryCheck(change && (p.side === 'base' || p.side === 'head'));
    advisoryCheck(p.side === 'base' ? change.from : change.to);
    advisoryCheck(advisoryText(p.name) && advisoryText(p.version));
    advisoryCheck(
      Array.isArray(p.sourceIds) &&
        p.sourceIds.length > 0 &&
        p.sourceIds.length <= PACKET_LIMITS.listEntries,
    );
    advisoryCheck(
      new Set(p.sourceIds).size === p.sourceIds.length &&
        p.sourceIds.every((id) => input.sources.some((s) => s.id === id)),
    );
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
  validateSources(input);
  validateChanges(input);
  validateProofs(input);
}
export async function enrichAdvisories(
  value: AdvisoryInput,
  dependencies: { reader: AdvisoryReader },
): Promise<AdvisoryResult> {
  let input: AdvisoryInput;
  try {
    advisoryCheck(isPlainObject(value));
    const limits = advisoryLimits(value.limits);
    input = copyAdvisoryData(value, limits);
    validate(input);
  } catch (error) {
    return error instanceof AdvisoryFailure && error.reason === 'budget'
      ? { kind: 'unavailable', reason: 'budget' }
      : { kind: 'invalid' };
  }
  const output: AdvisoryEnrichment = {
    kind: 'enriched',
    binding: input.binding,
    changes: structuredClone(input.changes) as PacketChange[],
    sources: structuredClone(input.sources) as PacketSource[],
    findings: [...input.findings],
    lookups: [],
  };
  const cache = new Map<string, AdvisoryLookup>();
  try {
    advisoryCheck(fits(output, input), 'budget');
    for (const change of output.changes) {
      if ('basis' in change) continue;
      const checkpoint = {
        sources: output.sources.length,
        findings: output.findings.length,
        lookups: output.lookups.length,
      };
      const head = change.to
        ? await collectSide(input, change, 'head', output, dependencies.reader, cache)
        : null;
      const base = change.from
        ? await collectSide(input, change, 'base', output, dependencies.reader, cache)
        : null;
      attachFindings(change, output, base, head);
      if (!fits(output, input)) {
        output.sources.length = checkpoint.sources;
        output.findings.length = checkpoint.findings;
        output.lookups.length = checkpoint.lookups;
        const side = change.to ? 'head' : 'base',
          gap = source(change, side, null);
        gap.id += ':budget';
        gap.reasons = ['budget'];
        addSource(output, gap);
        change.evidence.vulnerability = {
          status: 'unavailable',
          reasons: ['budget'],
          sourceIds: [gap.id],
        };
        output.lookups.push({ memberId: change.id, side, lookup: null, reasons: ['budget'] });
        if (change.to && change.from)
          output.lookups.push({
            memberId: change.id,
            side: 'base',
            lookup: null,
            reasons: ['budget'],
          });
        advisoryCheck(fits(output, input), 'budget');
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
function fits(output: AdvisoryEnrichment, input: AdvisoryInput) {
  return (
    output.sources.length <= PACKET_LIMITS.sources &&
    output.findings.length <=
      Math.min(PACKET_LIMITS.findings, input.findings.length + input.limits.maxFindings) &&
    Buffer.byteLength(JSON.stringify(output)) <=
      Math.min(input.limits.maxRetainedBytes, PACKET_LIMITS.bytes)
  );
}
