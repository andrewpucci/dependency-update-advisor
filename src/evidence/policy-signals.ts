import {
  recordSignal,
  attachSignalCoverage,
  retainSignalFinding,
  signalId,
  signalBounds,
  reserveOptionalSignals,
  runOptionalSignals,
} from './policy-signals-evidence.js';
export {
  observe,
  recordSignal,
  attachSignalCoverage,
  retainSignalFinding,
  retainSignalSource,
  signalId,
  signalBounds,
} from './policy-signals-evidence.js';
export type { OptionalCategory } from './policy-signals-evidence.js';
import { isDeepStrictEqual } from 'node:util';
import { type PacketChange, type PacketSource, type EvidenceReason } from '../schema.js';
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
import { collectPyPIReleaseSignals } from './policy-signals-pypi.js';
import type { PolicyMetadataReader } from './policy-signals-read.js';
import type { GithubReadSession } from '../github-read.js';
import { artifactLimits, type ArtifactLimits } from './policy-signals-uv-artifacts.js';
import { collectActionsPolicySignals } from './policy-signals-actions.js';
import type { UpstreamReader } from './upstream-read.js';
import { collectLicenseSignals } from './policy-signals-licenses.js';

export type PolicySignalInput = AdvisoryInput & {
  evaluationTime: number;
  limits: AdvisoryInput['limits'] & { maxAttempts: number };
  npmInventory?: UpstreamInput['npmInventory'];
  artifactLimits?: ArtifactLimits;
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
  metadataReader?: PolicyMetadataReader;
  artifactSession?: GithubReadSession;
  upstreamReader?: UpstreamReader;
};
export type Observation<T> =
  | { kind: 'known'; value: T }
  | { kind: 'unchecked'; reason: EvidenceReason };
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
    if (input.artifactLimits) artifactLimits(input.artifactLimits);
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
    reserveOptionalSignals(input, output);
    for (const change of output.changes) {
      if ('basis' in change) continue;
      await runOptionalSignals(input, output, change, async () => {
        if (change.ecosystem === 'npm' && !('basis' in change)) {
          const times = await collectNpmTimes(
            input,
            output,
            change,
            dependencies.publishTimeReader,
          );
          const sides = await collectNpmPolicySignals(
            input,
            output,
            change,
            times,
            dependencies.npmReader,
          );
          collectLicenseSignals(
            input,
            output,
            change,
            Object.fromEntries(
              Object.entries(sides).map(([side, s]) => [
                side,
                { license: s.facts.license, url: s.url },
              ]),
            ),
          );
        }
        if (change.ecosystem === 'uv') {
          const sides = await collectPyPIReleaseSignals(
            input,
            output,
            change,
            dependencies.metadataReader,
            dependencies.artifactSession,
          );
          collectLicenseSignals(
            input,
            output,
            change,
            Object.fromEntries(
              Object.entries(sides).map(([side, s]) => [
                side,
                { license: s.facts.license, url: s.url },
              ]),
            ),
          );
        }
        if (change.ecosystem === 'actions') {
          await collectActionsPolicySignals(input, output, change, dependencies.upstreamReader);
          collectLicenseSignals(input, output, change, {});
        }
      });
    }
    return freeze(output);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof AdvisoryFailure ? error.reason : 'unknown',
    };
  }
}
