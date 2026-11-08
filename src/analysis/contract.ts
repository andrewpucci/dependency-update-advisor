import { freeze } from '../evidence/common.js';
import { projectBatch, snapshotData, type BatchSnapshot } from './projection.js';
import { parseAssessments, rejectedAnalysis, type AnalysisResult } from './validation.js';
export type { AnalysisResult, ValidatedAssessment, ResolvedReference } from './validation.js';

export const ANALYSIS_LIMITS = Object.freeze({
  maxUnits: 8,
  sourceBytes: 2_048,
  unitBytes: 65_536,
  requestBytes: 262_144,
  completionTokens: 4_096,
  requestTimeoutMs: 120_000,
  responseBytes: 3_211_264,
  textBytes: 1_024,
  featureBytes: 512,
  followupBytes: 280,
  steps: 8,
  references: 32,
});
export type AnalysisLimits = { readonly [K in keyof typeof ANALYSIS_LIMITS]: number };
export type AnalysisCategory =
  | 'input'
  | 'configuration'
  | 'projection'
  | 'budget'
  | 'reference'
  | 'policy'
  | 'schema';
export type AnalysisFailure = Readonly<{
  kind: 'invalid' | 'unavailable';
  category: AnalysisCategory;
  attempted: false;
}>;
export type AnalysisRequest = Readonly<{
  model: string;
  temperature: 0;
  n: 1;
  stream: false;
  max_tokens: number;
  response_format: Readonly<{ type: 'json_object' }>;
  messages: readonly [
    Readonly<{ role: 'system'; content: string }>,
    Readonly<{ role: 'user'; content: string }>,
  ];
}>;
export type PreparedAnalysisBatch = Readonly<{
  batchId: string;
  unitIds: readonly string[];
  requestBytes: number;
  request: AnalysisRequest;
}>;
export type PreparationResult =
  | { kind: 'prepared'; batch: PreparedAnalysisBatch }
  | AnalysisFailure;
const snapshots = new WeakMap<PreparedAnalysisBatch, BatchSnapshot>();

/** Caller establishes T4/C1 provenance; preparation owns policy, aliases and a detached snapshot. */
export function prepareAnalysisBatch(value: unknown): PreparationResult {
  const result = projectBatch(value, ANALYSIS_LIMITS);
  if ('kind' in result) return result;
  const batch = freeze({
    batchId: result.batchId,
    unitIds: result.selected.map((unit) => unit.id),
    requestBytes: result.requestBytes,
    request: result.request,
  });
  snapshots.set(batch, result);
  return { kind: 'prepared', batch };
}

/** Internal transport/validator access accepts an owned handle, never a structural lookalike. */
export function preparedSnapshot(batch: PreparedAnalysisBatch): BatchSnapshot | undefined {
  return snapshots.get(batch);
}

export type AnalysisReply = Readonly<{ batchId: string }>;
const replies = new WeakMap<AnalysisReply, { batch: PreparedAnalysisBatch; value: unknown }>();

/** Capture response ownership around the adapter's receive callback; raw bodies cannot be rebound. */
export async function receiveAnalysisReply(
  batch: PreparedAnalysisBatch,
  receive: () => Promise<unknown>,
): Promise<AnalysisReply> {
  const snapshot = snapshots.get(batch);
  if (!snapshot) return Object.freeze({ batchId: '' });
  const candidate = await receive();
  let value: unknown = null;
  try {
    value = snapshotData(candidate, {
      entries: snapshot.limits.responseBytes,
      bytes: snapshot.limits.responseBytes,
    });
  } catch {
    /* Invalid data is rejected by the same closed schema, without echoing parser details. */
  }
  const reply = Object.freeze({ batchId: batch.batchId });
  replies.set(reply, { batch, value });
  return reply;
}

export function validateAnalysisReply(
  batch: PreparedAnalysisBatch,
  reply: AnalysisReply,
): AnalysisResult {
  const snapshot = snapshots.get(batch),
    bound = replies.get(reply);
  if (!snapshot) return { kind: 'invalid', category: 'reference', attempted: false };
  if (!bound || bound.batch !== batch) return rejectedAnalysis(snapshot, 'reference');
  return parseAssessments(bound.value, snapshot);
}
