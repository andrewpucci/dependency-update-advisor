import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  PACKET_LIMITS,
  type PacketChange,
  type PacketSource,
  type EvidenceReason,
} from '../schema.js';
import type { ReviewBinding } from '../event.js';
import type { Finding } from '../policy.js';
import { freeze } from './common.js';
import { prepareAdvisoryInput, resolveAdvisoryTarget, type AdvisoryInput } from './advisories.js';
import { advisoryCheck, AdvisoryFailure, type AdvisoryReader } from './advisory-read.js';
import { collectMemberMalware } from './policy-signals-malware.js';
import type { NpmPublishTimeReader, NpmTimesResult } from './npm-publish-times.js';
import type { UpstreamInput } from './upstream.js';
import { metadataTarget } from './upstream.js';
import { collectNpmPolicySignals, type NpmPolicyReader } from './policy-signals-npm.js';

export type PolicySignalInput = AdvisoryInput & {
  evaluationTime: number;
  limits: AdvisoryInput['limits'] & { maxAttempts: number };
  npmInventory?: UpstreamInput['npmInventory'];
};
export type SignalAttempt = {
  memberId: string;
  side: 'base' | 'head';
  category: string;
  url: string | null;
  outcome: 'available' | 'unavailable' | 'skipped';
  reasons: EvidenceReason[];
  sourceIds: string[];
  truncated: boolean;
};
export type SignalEnrichment = {
  kind: 'enriched';
  binding: ReviewBinding;
  changes: PacketChange[];
  sources: PacketSource[];
  findings: Finding[];
  attempts: SignalAttempt[];
};
export type PolicySignalResult =
  | Readonly<SignalEnrichment>
  | { kind: 'invalid' }
  | { kind: 'unavailable'; reason: EvidenceReason };
export type SignalDependencies = {
  malwareReader: AdvisoryReader;
  publishTimeReader?: NpmPublishTimeReader;
  npmReader?: NpmPolicyReader;
};
export type Observation<T> =
  | { kind: 'known'; value: T }
  | { kind: 'unchecked'; reason: EvidenceReason };
export function observe<T>(read: () => T): Observation<T> {
  try {
    return { kind: 'known', value: read() };
  } catch (error) {
    return {
      kind: 'unchecked',
      reason: error instanceof AdvisoryFailure ? error.reason : 'malformed',
    };
  }
}
export type OptionalCategory = 'publishTime' | 'deprecation' | 'trust' | 'publisher' | 'license';
export function recordSignal(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  side: 'base' | 'head',
  category: OptionalCategory,
  known: { url: string; value: unknown; reasons?: EvidenceReason[]; bothSides?: boolean } | null,
  reason: EvidenceReason = 'unsupported',
): PacketSource {
  const instance = side === 'base' ? change.from : change.to;
  advisoryCheck(instance);
  const value = 'version' in instance ? instance.version : 'ref' in instance ? instance.ref : '';
  const excerpt = known ? JSON.stringify(known.value) : '';
  if (known && excerpt.length > PACKET_LIMITS.excerptCodeUnits) {
    known = null;
    reason = 'truncated';
  }
  const source: PacketSource = {
    id: signalId(input.binding.identity, change.id, side, category, known ?? reason),
    kind: category === 'license' ? 'metadata' : category,
    ecosystems: [change.ecosystem],
    memberIds: [change.id],
    status: known ? (known.reasons?.length ? 'partial' : 'available') : 'unavailable',
    reasons: known ? (known.reasons ?? []) : [reason],
    provenance: known
      ? {
          kind: 'upstream',
          url: known.url,
          title: 'Exact ' + category + ' observation',
          excerpt,
          excerptTruncated: false,
          subjects: known.bothSides
            ? (['base', 'head'] as const).flatMap((s) => {
                const i = s === 'base' ? change.from : change.to;
                return i
                  ? [
                      {
                        memberId: change.id,
                        side: s,
                        value: 'version' in i ? i.version : 'ref' in i ? i.ref : '',
                      },
                    ]
                  : [];
              })
            : [{ memberId: change.id, side, value }],
          range: known.bothSides
            ? {
                from: change.from && 'version' in change.from ? change.from.version : null,
                to: change.to && 'version' in change.to ? change.to.version : null,
              }
            : { from: side === 'base' ? value : null, to: side === 'head' ? value : null },
        }
      : { kind: 'unavailable' },
  };
  retainSignalSource(output, source);
  output.attempts.push({
    memberId: change.id,
    side,
    category,
    url: known?.url ?? null,
    outcome: known ? 'available' : reason === 'unsupported' ? 'skipped' : 'unavailable',
    reasons: source.reasons,
    sourceIds: [source.id],
    truncated: reason === 'truncated' && !known,
  });
  return source;
}
export function attachSignalCoverage(
  change: PacketChange,
  category: Exclude<OptionalCategory, 'license'>,
  sources: PacketSource[],
) {
  const reasons = [...new Set(sources.flatMap((s) => s.reasons))];
  change.evidence[category] = {
    status: reasons.length
      ? sources.some((s) => s.status === 'available')
        ? 'partial'
        : 'unavailable'
      : 'available',
    sourceIds: sources.map((s) => s.id),
    reasons,
  };
}
export type NpmTimeSides = Partial<
  Record<'base' | 'head', { source: PacketSource; publishedAt?: number }>
>;
async function collectNpmTimes(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  reader?: NpmPublishTimeReader,
): Promise<NpmTimeSides> {
  const sides: NpmTimeSides = {},
    cache = new Map<string, NpmTimesResult>();
  for (const side of ['head', 'base'] as const) {
    const instance = side === 'head' ? change.to : change.from;
    if (!instance || !('version' in instance) || !('source' in instance)) continue;
    const target = resolveAdvisoryTarget(input, change, side);
    const versions = target
      ? [
          ...new Set(
            [change.from, change.to].flatMap((s) =>
              s && 'version' in s && 'name' in s && s.name === target.name ? [s.version] : [],
            ),
          ),
        ]
      : [];
    const key = JSON.stringify([target?.name, versions]);
    const result =
      cache.get(key) ??
      (target && reader
        ? await reader.read({
            name: target.name,
            versions,
            source: instance.source,
            evaluationTime: input.evaluationTime,
          })
        : { kind: 'unavailable' as const, reason: 'unsupported' as const });
    cache.set(key, result);
    const publishedAt = result.kind === 'times' ? result.times[instance.version] : undefined;
    const source = recordSignal(
      input,
      output,
      change,
      side,
      'publishTime',
      publishedAt === undefined
        ? null
        : { url: result.kind === 'times' ? result.url : '', value: { publishedAt } },
      result.kind === 'times' ? (result.reasons[instance.version] ?? 'missing') : result.reason,
    );
    sides[side] = { source, ...(source.status === 'available' ? { publishedAt } : {}) };
    if (side === 'head' && publishedAt !== undefined && source.status === 'available')
      retainSignalFinding(output, {
        id: signalId(source.id, 'releaseMetadata'),
        memberId: change.id,
        kind: 'releaseMetadata',
        publishedAt,
        references: [source.id],
        rationale: 'The public registry records this exact proposed version publication time.',
        remediation: ['Re-run after the configured release-age window ends.'],
        validation: ['Check the configured release-age policy and exact timestamp.'],
      });
  }
  const reviewed = sides[change.to ? 'head' : 'base'];
  if (reviewed) attachSignalCoverage(change, 'publishTime', [reviewed.source]);
  return sides;
}

export const signalId = (...values: unknown[]) =>
  'signal:' + createHash('sha256').update(JSON.stringify(values)).digest('hex');
export function retainSignalSource(output: SignalEnrichment, source: PacketSource) {
  const previous = output.sources.find((s) => s.id === source.id);
  advisoryCheck(!previous || isDeepStrictEqual(previous, source), 'conflict');
  if (!previous) output.sources.push(source);
}
export function retainSignalFinding(output: SignalEnrichment, finding: Finding) {
  const previous = output.findings.find((f) => f.id === finding.id);
  advisoryCheck(!previous || isDeepStrictEqual(previous, finding), 'conflict');
  if (!previous) output.findings.push(finding);
}
export function signalBounds(input: PolicySignalInput, output: SignalEnrichment) {
  advisoryCheck(
    output.changes.every((c) =>
      Object.values(c.evidence).every((e) => e.sourceIds.length <= PACKET_LIMITS.listEntries),
    ),
    'budget',
  );
  advisoryCheck(
    output.attempts.length <= input.limits.maxAttempts &&
      output.sources.length <= PACKET_LIMITS.sources &&
      output.findings.length <=
        Math.min(PACKET_LIMITS.findings, input.findings.length + input.limits.maxFindings) &&
      Buffer.byteLength(JSON.stringify(output)) <=
        Math.min(PACKET_LIMITS.bytes, input.limits.maxRetainedBytes),
    'budget',
  );
}
/** Required malware runs before optional adapters; input/outputs never share mutable records. */
export async function enrichPolicySignals(
  value: unknown,
  dependencies: SignalDependencies,
): Promise<PolicySignalResult> {
  const prepared = prepareAdvisoryInput(value as AdvisoryInput);
  if (!prepared.ok)
    return prepared.result.kind === 'unavailable' ? prepared.result : { kind: 'invalid' };
  const input = prepared.input as PolicySignalInput;
  if (
    !Number.isSafeInteger(input.evaluationTime) ||
    input.evaluationTime < 0 ||
    !Number.isSafeInteger(input.limits.maxAttempts) ||
    input.limits.maxAttempts < 1
  )
    return { kind: 'invalid' };
  try {
    if (input.npmInventory) {
      advisoryCheck(
        input.npmInventory.kind === 'inventory' &&
          isDeepStrictEqual(input.npmInventory.binding, input.binding),
      );
      for (const c of input.changes)
        if (c.ecosystem === 'npm' && !('basis' in c))
          for (const side of ['base', 'head'] as const) metadataTarget(input, c, side);
    }
  } catch {
    return { kind: 'invalid' };
  }
  const output: SignalEnrichment = {
    kind: 'enriched',
    binding: input.binding,
    changes: structuredClone(input.changes) as PacketChange[],
    sources: structuredClone(input.sources) as PacketSource[],
    findings: structuredClone(input.findings) as Finding[],
    attempts: [],
  };
  try {
    signalBounds(input, output);
    const cache = new Map();
    for (const change of output.changes) {
      if ('basis' in change) continue;
      await collectMemberMalware(input, output, change, dependencies.malwareReader, cache);
      signalBounds(input, output);
    }
    for (const change of output.changes) {
      if (change.ecosystem === 'npm' && !('basis' in change)) {
        const times = await collectNpmTimes(input, output, change, dependencies.publishTimeReader);
        await collectNpmPolicySignals(input, output, change, times, dependencies.npmReader);
      }
      signalBounds(input, output);
    }
    return freeze(output);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof AdvisoryFailure ? error.reason : 'unknown',
    };
  }
}
