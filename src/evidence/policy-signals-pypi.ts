import type { PacketChange, PacketSource } from '../schema.js';
import { isPlainObject } from './common.js';
import { advisoryCheck, advisoryText, copyAdvisoryData } from './advisory-read.js';
import { isDeepStrictEqual } from 'node:util';
import { PACKET_LIMITS } from '../schema.js';
import type { GithubReadSession } from '../github-read.js';
import { readUvArtifacts, type UvArtifact } from './policy-signals-uv-artifacts.js';
import { supplyChainFinding, type Publisher } from './policy-signals-npm.js';
import { publishTimestamp } from './npm-publish-times.js';
import { resolveAdvisoryTarget } from './advisories.js';
import type { PolicyMetadataReader } from './policy-signals-read.js';
import {
  observe,
  recordSignal,
  attachSignalCoverage,
  retainSignalFinding,
  signalId,
  type Observation,
  type PolicySignalInput,
  type SignalEnrichment,
} from './policy-signals.js';

export type PyPIFile = {
  filename: string;
  digests: Record<string, unknown>;
  upload_time_iso_8601: unknown;
  yanked: unknown;
  yanked_reason?: unknown;
};
export type PyPIReleaseFacts = {
  publishedAt: Observation<number>;
  deprecated: Observation<{ marker: 'yanked'; reason?: string } | null>;
  license: Observation<string | null>;
  files: Observation<PyPIFile[]>;
};
export function pypiReleaseFacts(value: unknown, evaluationTime: number): PyPIReleaseFacts {
  const data = isPlainObject(value) ? value : {},
    info = isPlainObject(data.info) ? data.info : {};
  const files = observe(() => {
    advisoryCheck(Array.isArray(data.urls) && data.urls.length > 0, 'missing');
    const result = data.urls.map((raw) => {
      advisoryCheck(
        isPlainObject(raw) &&
          typeof raw.filename === 'string' &&
          raw.filename.length > 0 &&
          isPlainObject(raw.digests),
      );
      return {
        filename: raw.filename,
        digests: raw.digests,
        upload_time_iso_8601: raw.upload_time_iso_8601,
        yanked: raw.yanked,
        yanked_reason: raw.yanked_reason,
      };
    });
    advisoryCheck(new Set(result.map((f) => f.filename)).size === result.length, 'conflict');
    return result;
  });
  return {
    files,
    publishedAt: observe(() => {
      advisoryCheck(files.kind === 'known', files.kind === 'unchecked' ? files.reason : 'missing');
      const times = files.value.map((f) => {
        const t = publishTimestamp(f.upload_time_iso_8601, Number.MAX_SAFE_INTEGER);
        advisoryCheck(t !== null, 'malformed');
        advisoryCheck(t <= evaluationTime, 'conflict');
        return t;
      });
      return times.reduce((earliest, time) => Math.min(earliest, time), Infinity);
    }),
    deprecated: observe(() => {
      advisoryCheck(files.kind === 'known', files.kind === 'unchecked' ? files.reason : 'missing');
      advisoryCheck(files.value.every((f) => typeof f.yanked === 'boolean'));
      const states = new Set(files.value.map((f) => f.yanked));
      advisoryCheck(states.size === 1, 'conflict');
      const yanked = files.value[0].yanked as boolean;
      if (info.yanked !== undefined) {
        advisoryCheck(typeof info.yanked === 'boolean');
        advisoryCheck(info.yanked === yanked, 'conflict');
      }
      if (!yanked) return null;
      const reasons = [info.yanked_reason, ...files.value.map((f) => f.yanked_reason)].filter(
        (x) => x !== undefined && x !== null,
      );
      advisoryCheck(reasons.every((r) => typeof r === 'string'));
      advisoryCheck(new Set(reasons).size <= 1, 'conflict');
      const reason = reasons[0] as string | undefined;
      return {
        marker: 'yanked' as const,
        ...(reason !== undefined
          ? {
              reason:
                reason.replace(/[\p{Cc}\p{Cs}]/gu, ' ').slice(0, 350) +
                (reason.length > 350 ? ' [reason truncated]' : ''),
            }
          : {}),
      };
    }),
    license: observe(() => {
      const v = info.license_expression ?? info.license;
      if (v === undefined || v === null) return null;
      advisoryCheck(typeof v === 'string');
      return v;
    }),
  };
}
export type PyPIReleaseSides = Partial<
  Record<
    'base' | 'head',
    {
      facts: PyPIReleaseFacts;
      url: string | null;
      times: { source: PacketSource; publishedAt?: number };
    }
  >
>;
export async function collectPyPIReleaseSignals(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  reader?: PolicyMetadataReader,
  session?: GithubReadSession,
): Promise<PyPIReleaseSides> {
  const sides: PyPIReleaseSides = {};
  for (const side of ['base', 'head'] as const) {
    const instance = side === 'base' ? change.from : change.to;
    if (!instance || !('version' in instance) || !('source' in instance)) continue;
    const target = resolveAdvisoryTarget(input, change, side);
    const result =
      target && reader
        ? await reader.read({
            kind: 'pypi',
            name: target.name,
            version: target.version,
            source: instance.source,
          })
        : { kind: 'unavailable' as const, reason: 'unsupported' as const };
    const facts =
      result.kind === 'data'
        ? pypiReleaseFacts(result.data, input.evaluationTime)
        : {
            publishedAt: {
              kind: 'unchecked' as const,
              reason: result.kind === 'unavailable' ? result.reason : ('missing' as const),
            },
            deprecated: {
              kind: 'unchecked' as const,
              reason: result.kind === 'unavailable' ? result.reason : ('missing' as const),
            },
            license: {
              kind: 'unchecked' as const,
              reason: result.kind === 'unavailable' ? result.reason : ('missing' as const),
            },
            files: {
              kind: 'unchecked' as const,
              reason: result.kind === 'unavailable' ? result.reason : ('missing' as const),
            },
          };
    const url = result.kind === 'data' ? result.url : null,
      t = facts.publishedAt;
    const source = recordSignal(
      input,
      output,
      change,
      side,
      'publishTime',
      t.kind === 'known' && url
        ? { url, value: { publishedAt: t.value, derivation: 'earliest release file upload' } }
        : null,
      t.kind === 'unchecked' ? t.reason : 'missing',
    );
    sides[side] = {
      facts,
      url,
      times: {
        source,
        ...(t.kind === 'known' && source.status === 'available' ? { publishedAt: t.value } : {}),
      },
    };
    if (side === 'head') {
      const d = facts.deprecated,
        dep = recordSignal(
          input,
          output,
          change,
          side,
          'deprecation',
          d.kind === 'known' && url ? { url, value: { deprecated: d.value } } : null,
          d.kind === 'unchecked' ? d.reason : 'missing',
        );
      attachSignalCoverage(change, 'deprecation', [dep]);
      for (const [value, ref] of [
        [t.kind === 'known' ? { publishedAt: t.value } : null, source],
        [d.kind === 'known' && d.value ? { deprecated: d.value } : null, dep],
      ] as const) {
        if (value && ref.status === 'available')
          retainSignalFinding(output, {
            id: signalId(ref.id, 'releaseMetadata'),
            memberId: change.id,
            kind: 'releaseMetadata',
            ...value,
            references: [ref.id],
            rationale: 'The exact PyPI release supplies the cited release metadata.',
            remediation: ['Review release age and any yank reason before merging.'],
            validation: ['Recheck the exact release metadata.'],
          });
      }
    }
  }
  const reviewed = sides[change.to ? 'head' : 'base'];
  if (reviewed) attachSignalCoverage(change, 'publishTime', [reviewed.times.source]);
  await collectPyPIPublishing(input, output, change, sides, reader, session);
  return sides;
}
export function pypiProvenanceFacts(
  value: unknown,
  artifact: UvArtifact,
  reader: PolicyMetadataReader,
): Observation<Publisher> {
  return observe(() => {
    advisoryCheck(
      isPlainObject(value) &&
        value.version === 1 &&
        Array.isArray(value.attestation_bundles) &&
        value.attestation_bundles.length > 0,
      'unsupported',
    );
    const publishers = value.attestation_bundles.map((bundle) => {
      reader.spend(1);
      advisoryCheck(
        isPlainObject(bundle) &&
          isPlainObject(bundle.publisher) &&
          Array.isArray(bundle.attestations) &&
          bundle.attestations.length > 0,
      );
      const p = bundle.publisher;
      advisoryCheck(
        p.kind === 'GitHub' &&
          advisoryText(p.repository) &&
          /^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(p.repository) &&
          advisoryText(p.workflow) &&
          (p.environment === undefined || typeof p.environment === 'string'),
        'unsupported',
      );
      for (const attestation of bundle.attestations) {
        advisoryCheck(
          isPlainObject(attestation) &&
            attestation.version === 1 &&
            isPlainObject(attestation.envelope) &&
            isPlainObject(attestation.verification_material),
          'unsupported',
        );
        const envelope = attestation.envelope;
        advisoryCheck(
          typeof attestation.verification_material.certificate === 'string' &&
            attestation.verification_material.certificate.length > 0 &&
            Array.isArray(attestation.verification_material.transparency_entries) &&
            attestation.verification_material.transparency_entries.length > 0,
          'unsupported',
        );
        advisoryCheck(
          typeof envelope.statement === 'string' &&
            /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(
              envelope.statement,
            ) &&
            typeof envelope.signature === 'string' &&
            envelope.signature.length > 0,
        );
        const work = { entries: 0 };
        const decoded = copyAdvisoryData(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.from(envelope.statement, 'base64'),
            ),
          ),
          {
            ...reader.limits,
            maxPages: reader.limits.maxRequests,
            maxFindings: PACKET_LIMITS.findings,
          },
          work,
        );
        reader.spend(work.entries);
        advisoryCheck(
          isPlainObject(decoded) &&
            decoded._type === 'https://in-toto.io/Statement/v1' &&
            [
              'https://docs.pypi.org/attestations/publish/v1',
              'https://slsa.dev/provenance/v1',
            ].includes(String(decoded.predicateType)),
          'unsupported',
        );
        advisoryCheck(
          Array.isArray(decoded.subject) &&
            decoded.subject.length === 1 &&
            isPlainObject(decoded.subject[0]) &&
            isPlainObject(decoded.subject[0].digest) &&
            decoded.subject[0].name === artifact.filename &&
            decoded.subject[0].digest.sha256 === artifact.sha256,
          'conflict',
        );
      }
      return {
        kind: 'trusted' as const,
        provider: 'pypi:GitHub',
        configuration: JSON.stringify([
          p.repository.toLowerCase(),
          p.workflow,
          p.environment ?? '',
        ]),
      };
    });
    advisoryCheck(
      publishers.every((p) => isDeepStrictEqual(p, publishers[0])),
      'conflict',
    );
    return publishers[0];
  });
}
type PyPIPublishingSide = {
  trust: PacketSource[];
  publisher: PacketSource[];
  provenance: Observation<boolean>;
  account: Observation<Publisher>;
};
async function collectPyPIPublishing(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  releases: PyPIReleaseSides,
  reader?: PolicyMetadataReader,
  session?: GithubReadSession,
) {
  const sides: Partial<Record<'base' | 'head', PyPIPublishingSide>> = {};
  for (const side of ['base', 'head'] as const) {
    const instance = side === 'base' ? change.from : change.to;
    if (!instance || !('source' in instance) || !('version' in instance)) continue;
    const trust: PacketSource[] = [],
      publisher: PacketSource[] = [],
      observations: { provenance: boolean; account: Publisher | null }[] = [];
    const artifacts = await readUvArtifacts(input, change, side, session, input.artifactLimits),
      files = releases[side]?.facts.files;
    let failure: import('../schema.js').EvidenceReason | undefined;
    if (artifacts.kind === 'known' && files?.kind === 'known' && reader) {
      for (const artifact of artifacts.value) {
        const work = observe(() => reader.spend(1));
        if (work.kind === 'unchecked') {
          failure = work.reason;
          break;
        }
        const live = files.value.find((f) => f.filename === artifact.filename);
        if (!live || live.digests.sha256 !== artifact.sha256) {
          failure = 'conflict';
          break;
        }
        const result = await reader.read({
          kind: 'pypi-provenance',
          name: instance.name,
          version: instance.version,
          source: instance.source,
          filename: artifact.filename,
        });
        const fact =
          result.kind === 'data' ? pypiProvenanceFacts(result.data, artifact, reader) : null;
        if (result.kind === 'unavailable' || fact?.kind === 'unchecked') {
          failure =
            result.kind === 'unavailable'
              ? result.reason
              : fact!.kind === 'unchecked'
                ? fact!.reason
                : 'unknown';
          break;
        }
        const url = result.kind === 'absent' || result.kind === 'data' ? result.url : '';
        const account = fact?.kind === 'known' ? fact.value : null;
        observations.push({ provenance: result.kind === 'data', account });
        trust.push(
          recordSignal(input, output, change, side, 'trust', {
            url,
            value: { level: 'registry_reported', ...artifact, provenance: result.kind === 'data' },
          }),
        );
        publisher.push(
          recordSignal(
            input,
            output,
            change,
            side,
            'publisher',
            account ? { url, value: { ...artifact, account } } : null,
            'missing',
          ),
        );
      }
    } else
      failure =
        artifacts.kind === 'unchecked'
          ? artifacts.reason
          : files?.kind === 'unchecked'
            ? files.reason
            : 'unsupported';
    const provenance: Observation<boolean> =
      !failure &&
      observations.length &&
      observations.every((o) => o.provenance === observations[0].provenance)
        ? { kind: 'known', value: observations[0].provenance }
        : { kind: 'unchecked', reason: failure ?? 'conflict' };
    const first = observations[0]?.account;
    const account: Observation<Publisher> =
      !failure && first && observations.every((o) => isDeepStrictEqual(o.account, first))
        ? { kind: 'known', value: first }
        : {
            kind: 'unchecked',
            reason: failure ?? (observations.some((o) => o.account) ? 'conflict' : 'missing'),
          };
    if (provenance.kind === 'unchecked')
      trust.push(recordSignal(input, output, change, side, 'trust', null, provenance.reason));
    if (account.kind === 'unchecked' && !publisher.some((p) => p.status === 'unavailable'))
      publisher.push(recordSignal(input, output, change, side, 'publisher', null, account.reason));
    // Registry account provenance is independent from the unexposed maintainer snapshot.
    publisher.push(recordSignal(input, output, change, side, 'publisher', null, 'unsupported'));
    sides[side] = { trust, publisher, provenance, account };
  }
  for (const category of ['trust', 'publisher'] as const)
    attachSignalCoverage(
      change,
      category,
      Object.values(sides).flatMap((s) => s[category]),
    );
  const a = sides.base,
    b = sides.head;
  if (!a || !b) return;
  if (
    a.account.kind === 'known' &&
    b.account.kind === 'known' &&
    !isDeepStrictEqual(a.account.value, b.account.value)
  )
    supplyChainFinding(
      input,
      output,
      change,
      'publisher',
      'PyPI account',
      [...a.publisher, ...b.publisher].filter((s) => s.status !== 'unavailable'),
    );
  if (
    a.provenance.kind === 'known' &&
    a.provenance.value &&
    b.provenance.kind === 'known' &&
    !b.provenance.value
  ) {
    const from = releases.base?.times.publishedAt,
      to = releases.head?.times.publishedAt;
    if (from === undefined || to === undefined) {
      const gap = recordSignal(input, output, change, 'head', 'trust', null, 'missing');
      attachSignalCoverage(change, 'trust', [...a.trust, ...b.trust, gap]);
      return;
    }
    if (from >= to) return;
    const chronology = recordSignal(input, output, change, 'head', 'trust', {
      url: releases.head!.url!,
      value: { mechanism: 'chronology', fromPublishedAt: from, toPublishedAt: to },
      bothSides: true,
    });
    supplyChainFinding(input, output, change, 'trust_downgrade', 'PyPI provenance', [
      ...a.trust,
      ...b.trust,
      chronology,
    ]);
  }
}
