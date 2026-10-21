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
type WriteFailure = Extract<StatusResult, { category: 'write' }>;
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
  if (!record(value)) return null;
  const snapshot = structuredClone({
    binding: value.binding,
    reviewer: value.reviewer,
    outcome: value.outcome,
    previousCommentIsStale: value.previousCommentIsStale,
  });
  const { reviewer, outcome } = snapshot;
  if (
    !record(reviewer) ||
    !positiveId(reviewer.runId) ||
    !positiveId(reviewer.runAttempt) ||
    !record(outcome) ||
    (outcome.kind !== 'running' && outcome.kind !== 'complete' && outcome.kind !== 'incomplete') ||
    (outcome.kind === 'complete' && outcome.commentRecorded !== true) ||
    (snapshot.previousCommentIsStale !== undefined &&
      typeof snapshot.previousCommentIsStale !== 'boolean')
  )
    return null;
  return {
    binding: snapshot.binding,
    reviewer: { runId: reviewer.runId, runAttempt: reviewer.runAttempt },
    identity: outcome.identity,
    stale: snapshot.previousCommentIsStale === true,
    state:
      outcome.kind === 'complete'
        ? 'success'
        : outcome.kind === 'incomplete'
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
  const repository = Object.freeze({
    id: binding.repository.id,
    owner: binding.repository.owner,
    name: binding.repository.name,
  });
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
): WriteFailure {
  return { kind: 'error', category: 'write', field: 'status', publication: 'unknown', diagnostic };
}

async function writeStatus(
  request: StatusRequest,
  createStatus: StatusDependencies['createStatus'],
): Promise<StatusReceipt | WriteFailure> {
  try {
    const response = await createStatus(request);
    if (
      record(response) &&
      typeof response.status === 'number' &&
      Number.isInteger(response.status) &&
      response.status >= 100 &&
      response.status <= 599 &&
      response.status !== 201
    )
      return writeError('rejection');
    const receipt = acknowledged(response, request);
    if (!receipt) return writeError('acknowledgement');
    return receipt;
  } catch (error) {
    try {
      if (record(error) && error.kind === 'timeout') return writeError('timeout');
    } catch {
      /* Exception objects are untrusted too. */
    }
    return writeError('transport');
  }
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
  const receipt = await writeStatus(request, deps.createStatus);
  if ('kind' in receipt) return receipt;
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
