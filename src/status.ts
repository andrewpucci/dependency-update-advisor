import {
  reverifyReviewBinding,
  type FreshnessReads,
  type RepositoryIdentity,
  type ReviewBinding,
  type ReviewIdentity,
  type VerificationError,
} from './event.js';

export type ExecutionState = 'pending' | 'success' | 'failure';
export type StatusRequest = Readonly<{
  repository: RepositoryIdentity;
  sha: string;
  state: ExecutionState;
  context: 'dependabot-review';
  target_url: string;
  description: string;
}>;
export type StatusReceipt = Readonly<{
  headSha: string;
  state: ExecutionState;
  context: 'dependabot-review';
  statusId: number;
}>;
type Confirmed = { publication: 'confirmed'; receipt: StatusReceipt };
type Unwritten = { publication: 'not-attempted' };
type ErrorField =
  | VerificationError['field']
  | 'input'
  | 'reviewer'
  | 'outcome'
  | 'ownership'
  | 'status';
type GateError = {
  kind: 'error';
  category: 'input' | 'verification' | 'ownership';
  field: ErrorField;
};
export type StatusResult =
  | ({ kind: 'published' } & Confirmed)
  | ({ kind: 'obsolete' } & (Confirmed | Unwritten))
  | (GateError & Unwritten)
  | {
      kind: 'error';
      category: 'write';
      field: 'status';
      publication: 'unknown';
      diagnostic: 'rejection' | 'transport' | 'timeout' | 'acknowledgement';
    }
  | ({ kind: 'error'; category: 'post-write'; field: ErrorField } & Confirmed);
export type StatusDependencies = {
  reads: FreshnessReads;
  readOwnership: (identity: ReviewIdentity) => Promise<unknown>;
  createStatus: (request: StatusRequest) => Promise<unknown>;
};
type Input = {
  binding: unknown;
  reviewer: { runId: number; runAttempt: number };
  identity: unknown;
  stale: boolean;
  state: ExecutionState;
};
type Gate = { kind: 'fresh'; binding: ReviewBinding } | { kind: 'obsolete' } | GateError;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sameIdentity(value: unknown, expected: ReviewIdentity): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((part, index) => part === value[index])
  );
}

function parseInput(value: unknown): Input | null {
  if (
    !record(value) ||
    !Object.hasOwn(value, 'binding') ||
    !record(value.reviewer) ||
    !positiveId(value.reviewer.runId) ||
    !positiveId(value.reviewer.runAttempt) ||
    !record(value.outcome) ||
    !['running', 'complete', 'incomplete'].includes(value.outcome.kind as string) ||
    (value.outcome.kind === 'complete' && value.outcome.commentRecorded !== true) ||
    (value.previousCommentIsStale !== undefined &&
      typeof value.previousCommentIsStale !== 'boolean')
  )
    return null;
  return {
    binding: structuredClone(value.binding),
    reviewer: { runId: value.reviewer.runId, runAttempt: value.reviewer.runAttempt },
    identity: structuredClone(value.outcome.identity),
    stale: value.previousCommentIsStale === true,
    state:
      value.outcome.kind === 'complete'
        ? 'success'
        : value.outcome.kind === 'incomplete'
          ? 'failure'
          : 'pending',
  };
}

async function checkGate(value: unknown, deps: StatusDependencies): Promise<Gate> {
  const freshness = await reverifyReviewBinding(value, deps.reads);
  if (freshness.kind === 'obsolete') return freshness;
  if (freshness.kind === 'error')
    return {
      kind: 'error',
      category: freshness.field === 'binding' ? 'input' : 'verification',
      field: freshness.field,
    };
  // T1 validated this private snapshot; its normalization must not authorize a replacement head.
  const binding = value as ReviewBinding;
  const identity = Object.freeze([...binding.identity]) as ReviewIdentity;
  try {
    const ownership = await deps.readOwnership(identity);
    if (record(ownership) && sameIdentity(ownership.identity, identity)) {
      if (ownership.state === 'owned') return { kind: 'fresh', binding };
      if (ownership.state === 'lost') return { kind: 'obsolete' };
    }
  } catch {
    /* Raw claim failures never enter diagnostics. */
  }
  return { kind: 'error', category: 'ownership', field: 'ownership' };
}

function requestFor(input: Input, binding: ReviewBinding): StatusRequest {
  const repository = Object.freeze({ ...binding.repository });
  return Object.freeze({
    repository,
    sha: binding.headSha,
    state: input.state,
    context: 'dependabot-review',
    target_url: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/runs/${input.reviewer.runId}/attempts/${input.reviewer.runAttempt}`,
    description:
      {
        pending: 'Review in progress',
        success: 'Review completed',
        failure: 'Review unavailable or incomplete',
      }[input.state] +
      (input.stale && input.state !== 'success' ? '. Previous comment is stale' : ''),
  });
}

function acknowledged(value: unknown, request: StatusRequest): StatusReceipt | null {
  if (!record(value) || value.status !== 201 || !record(value.data)) return null;
  const data = value.data;
  if (
    !positiveId(data.id) ||
    data.state !== request.state ||
    data.context !== request.context ||
    data.target_url !== request.target_url ||
    data.description !== request.description
  )
    return null;
  return Object.freeze({
    headSha: request.sha,
    state: request.state,
    context: request.context,
    statusId: data.id,
  });
}

function writeError(
  diagnostic: 'rejection' | 'transport' | 'timeout' | 'acknowledgement',
): StatusResult {
  return { kind: 'error', category: 'write', field: 'status', publication: 'unknown', diagnostic };
}

/** One status attempt; W2 owns job failure, comment ordering, and any guarded recovery. */
export async function publishExecutionStatus(
  value: unknown,
  deps: StatusDependencies,
): Promise<StatusResult> {
  let input: Input | null;
  try {
    input = parseInput(value);
  } catch {
    input = null;
  }
  if (!input)
    return { kind: 'error', category: 'input', field: 'input', publication: 'not-attempted' };
  const gate = await checkGate(input.binding, deps);
  if (gate.kind !== 'fresh') return { ...gate, publication: 'not-attempted' };
  if (!sameIdentity(input.identity, gate.binding.identity))
    return {
      kind: 'error',
      category: 'input',
      field: 'outcome',
      publication: 'not-attempted',
    };
  const request = requestFor(input, gate.binding);
  let receipt: StatusReceipt | null;
  try {
    const response = await deps.createStatus(request);
    if (record(response) && typeof response.status === 'number' && response.status !== 201)
      return writeError('rejection');
    receipt = acknowledged(response, request);
    if (!receipt) return writeError('acknowledgement');
  } catch (error) {
    return writeError(record(error) && error.kind === 'timeout' ? 'timeout' : 'transport');
  }
  const after = await checkGate(input.binding, deps);
  if (after.kind === 'error')
    return {
      kind: 'error',
      category: 'post-write',
      field: after.field,
      publication: 'confirmed',
      receipt,
    };
  return {
    kind: after.kind === 'obsolete' ? 'obsolete' : 'published',
    publication: 'confirmed',
    receipt,
  };
}
