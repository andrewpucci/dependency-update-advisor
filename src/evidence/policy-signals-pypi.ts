import type { PacketChange, PacketSource } from '../schema.js';
import { isPlainObject } from './common.js';
import { advisoryCheck } from './advisory-read.js';
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
        const t = publishTimestamp(f.upload_time_iso_8601, evaluationTime);
        advisoryCheck(t !== null, 'malformed');
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
  return sides;
}
