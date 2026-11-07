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
import { prepareAdvisoryInput, type AdvisoryInput } from './advisories.js';
import { advisoryCheck, AdvisoryFailure, type AdvisoryReader } from './advisory-read.js';
import { collectMemberMalware } from './policy-signals-malware.js';

export type PolicySignalInput = AdvisoryInput & {
  evaluationTime: number;
  limits: AdvisoryInput['limits'] & { maxAttempts: number };
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
export type SignalDependencies = { malwareReader: AdvisoryReader };

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
    return freeze(output);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof AdvisoryFailure ? error.reason : 'unknown',
    };
  }
}
