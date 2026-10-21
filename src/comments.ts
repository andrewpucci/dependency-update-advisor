import {
  parseReviewBinding,
  positiveId,
  record,
  reverifyReviewBinding,
  sameIdentity,
  type FreshnessReads,
  type RepositoryIdentity,
  type ReviewBinding,
  type ReviewIdentity,
  type VerificationError,
} from './event.js';

const MARKER = '<!-- dependabot-intelligent-review -->';
type Publisher = Readonly<{ appId: number; botUserId: number }>;
export type CommentTarget = Readonly<{ repository: RepositoryIdentity; pullNumber: number }>;
export type CommentDiscoveryDependencies = {
  listComments: (target: CommentTarget) => Promise<unknown>;
};
type DiscoveryError = {
  kind: 'error';
  category: 'input' | 'discovery';
  field: 'input' | 'binding' | 'publisher' | 'comments';
  diagnostic?: 'ambiguity';
  commentIds?: readonly number[];
};
export type CommentDiscoveryResult =
  | {
      kind: 'discovered';
      comment: Readonly<{ commentId: number; reviewedHeadSha?: string }> | null;
    }
  | DiscoveryError;
type BaseInput = { binding: ReviewBinding; publisher: Publisher };
type OwnedComment = Readonly<{ id: number; body: string }>;
type Selection = { kind: 'selected'; comment: OwnedComment | null } | DiscoveryError;

function inputError(field: DiscoveryError['field']): DiscoveryError {
  return { kind: 'error', category: 'input', field };
}

function parseBase(value: unknown): BaseInput | DiscoveryError {
  if (!record(value)) return inputError('input');
  const binding = parseReviewBinding(value.binding);
  if (!binding) return inputError('binding');
  const publisher = value.publisher;
  if (!record(publisher) || !positiveId(publisher.appId) || !positiveId(publisher.botUserId))
    return inputError('publisher');
  return {
    binding,
    publisher: Object.freeze({ appId: publisher.appId, botUserId: publisher.botUserId }),
  };
}

function metadata(body: string): { headSha: string; reviewDigest?: string } | null {
  const lines = body.split('\n');
  if (lines[0] !== MARKER || body.split(MARKER).length !== 2) return null;
  if ((body.match(/<!--\s*reviewed-head\b/gu) ?? []).length !== 1) return null;
  const head = /^<!-- reviewed-head: ([a-f\d]{40}) -->$/u.exec(lines[1] ?? '');
  if (!head) return null;
  const digests = (body.match(/<!--\s*review-digest\b/gu) ?? []).length;
  if (digests === 0) return { headSha: head[1] };
  const digest = /^<!-- review-digest: ([a-f\d]{64}) -->$/u.exec(lines[2] ?? '');
  return digests === 1 && digest ? { headSha: head[1], reviewDigest: digest[1] } : null;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function ownedComment(value: unknown, input: BaseInput): OwnedComment | null {
  if (
    !record(value) ||
    !positiveId(value.id) ||
    typeof value.body !== 'string' ||
    !record(value.user) ||
    !positiveId(value.user.id) ||
    typeof value.user.type !== 'string'
  )
    throw new Error('comments');
  if (value.user.id !== input.publisher.botUserId) return null;
  if (value.user.type !== 'Bot') throw new Error('comments');
  const app = value.performed_via_github_app;
  if (app !== undefined && app !== null && (!record(app) || app.id !== input.publisher.appId))
    throw new Error('comments');
  if (value.body.split('\n', 1)[0] !== MARKER) return null;
  const { repository, pullNumber } = input.binding;
  const expected = `https://api.github.com/repos/${repository.owner}/${repository.name}/issues/${pullNumber}`;
  if (typeof value.issue_url !== 'string' || asciiLower(value.issue_url) !== expected)
    throw new Error('comments');
  return Object.freeze({ id: value.id, body: value.body });
}

async function selectComment(
  input: BaseInput,
  deps: CommentDiscoveryDependencies,
): Promise<Selection> {
  try {
    const target = Object.freeze({
      repository: input.binding.repository,
      pullNumber: input.binding.pullNumber,
    });
    const response = await deps.listComments(target);
    if (!record(response)) throw new Error('comments');
    const snapshot = structuredClone({
      status: response.status,
      complete: response.complete,
      data: response.data,
    });
    if (snapshot.status !== 200 || snapshot.complete !== true || !Array.isArray(snapshot.data))
      throw new Error('comments');
    const comments: OwnedComment[] = [];
    for (const value of snapshot.data) {
      const comment = ownedComment(value, input);
      if (comment) comments.push(comment);
    }
    if (comments.length > 1)
      return {
        kind: 'error',
        category: 'discovery',
        field: 'comments',
        diagnostic: 'ambiguity',
        commentIds: Object.freeze(comments.map((comment) => comment.id)),
      };
    return { kind: 'selected', comment: comments[0] ?? null };
  } catch {
    return { kind: 'error', category: 'discovery', field: 'comments' };
  }
}

/** Read-only discovery; transport must supply the complete bounded collection. */
export async function discoverManagedComment(
  value: unknown,
  deps: CommentDiscoveryDependencies,
): Promise<CommentDiscoveryResult> {
  let input: BaseInput | DiscoveryError;
  try {
    if (!record(value)) return inputError('input');
    input = parseBase(structuredClone({ binding: value.binding, publisher: value.publisher }));
  } catch {
    return inputError('input');
  }
  if ('kind' in input) return input;
  const selected = await selectComment(input, deps);
  if (selected.kind === 'error') return selected;
  const comment = selected.comment;
  const old = comment ? metadata(comment.body) : null;
  return {
    kind: 'discovered',
    comment: comment
      ? Object.freeze({ commentId: comment.id, ...(old ? { reviewedHeadSha: old.headSha } : {}) })
      : null,
  };
}

export type CommentCreateRequest = CommentTarget & Readonly<{ body: string }>;
export type CommentReadRequest = Readonly<{ repository: RepositoryIdentity; commentId: number }>;
export type CommentUpdateRequest = CommentReadRequest & Readonly<{ body: string }>;
export type CommentDependencies = CommentDiscoveryDependencies & {
  reads: FreshnessReads;
  readOwnership: (identity: ReviewIdentity) => Promise<unknown>;
  createComment: (request: CommentCreateRequest) => Promise<unknown>;
  readComment: (request: CommentReadRequest) => Promise<unknown>;
  updateComment: (request: CommentUpdateRequest) => Promise<unknown>;
};
export type CommentReceipt = Readonly<{
  identity: ReviewIdentity;
  headSha: string;
  commentId: number;
  operation: 'created' | 'updated' | 'identical';
}>;
type WrittenReceipt = CommentReceipt & Readonly<{ operation: 'created' | 'updated' }>;
type ConfirmedMutation = { mutation: 'confirmed'; receipt: WrittenReceipt };
type Unwritten = { mutation: 'not-attempted' };
type GateError = {
  kind: 'error';
  category: 'verification' | 'ownership';
  field: VerificationError['field'] | 'ownership';
};
type PublicationInputError = { kind: 'error'; category: 'input'; field: 'result' | 'pending' };
type WriteError = {
  kind: 'error';
  category: 'write';
  field: 'comments';
  mutation: 'unknown';
  diagnostic: 'rejection' | 'transport' | 'timeout' | 'acknowledgement';
};
export type CommentResult =
  | ({ kind: 'recorded' } & ConfirmedMutation)
  | {
      kind: 'recorded';
      mutation: 'not-attempted';
      receipt: CommentReceipt & Readonly<{ operation: 'identical' }>;
    }
  | ({ kind: 'obsolete' } & (ConfirmedMutation | Unwritten))
  | ((DiscoveryError | PublicationInputError | GateError) & Unwritten)
  | WriteError
  | ({ kind: 'error'; category: 'post-write'; field: GateError['field'] } & ConfirmedMutation);
type PublicationInput = BaseInput & { body: string };

function parsePublication(
  value: unknown,
): PublicationInput | DiscoveryError | PublicationInputError {
  if (!record(value)) return inputError('input');
  const snapshot = structuredClone({
    binding: value.binding,
    publisher: value.publisher,
    result: value.result,
    pending: value.pending,
  });
  const base = parseBase(snapshot);
  if ('kind' in base) return base;
  const result = snapshot.result;
  if (
    !record(result) ||
    !sameIdentity(result.identity, base.binding.identity) ||
    (result.kind !== 'complete' && result.kind !== 'incomplete') ||
    typeof result.body !== 'string' ||
    result.body.length > 50000
  )
    return { kind: 'error', category: 'input', field: 'result' };
  const meta = metadata(result.body);
  if (!meta || meta.headSha !== base.binding.headSha || meta.reviewDigest !== result.reviewDigest)
    return { kind: 'error', category: 'input', field: 'result' };
  const pending = snapshot.pending;
  if (
    !record(pending) ||
    pending.state !== 'pending' ||
    pending.context !== 'dependabot-review' ||
    pending.headSha !== base.binding.headSha ||
    !positiveId(pending.statusId)
  )
    return { kind: 'error', category: 'input', field: 'pending' };
  return { ...base, body: result.body };
}

async function publicationGate(
  binding: ReviewBinding,
  deps: CommentDependencies,
): Promise<{ kind: 'fresh' } | { kind: 'obsolete' } | GateError> {
  const freshness = await reverifyReviewBinding(binding, deps.reads);
  if (freshness.kind === 'obsolete') return freshness;
  if (freshness.kind === 'error')
    return { kind: 'error', category: 'verification', field: freshness.field };
  try {
    const value = await deps.readOwnership(binding.identity);
    if (record(value)) {
      const claim = structuredClone({ identity: value.identity, state: value.state });
      if (sameIdentity(claim.identity, binding.identity)) {
        if (claim.state === 'owned') return { kind: 'fresh' };
        if (claim.state === 'lost') return { kind: 'obsolete' };
      }
    }
  } catch {
    /* Raw ownership errors never enter diagnostics. */
  }
  return { kind: 'error', category: 'ownership', field: 'ownership' };
}

function writeError(diagnostic: WriteError['diagnostic']): WriteError {
  return { kind: 'error', category: 'write', field: 'comments', mutation: 'unknown', diagnostic };
}

async function writeComment(
  input: PublicationInput,
  deps: CommentDependencies,
  selected: OwnedComment | null,
): Promise<WrittenReceipt | WriteError> {
  const fields = { repository: input.binding.repository, body: input.body };
  let response: unknown;
  try {
    response = selected
      ? await deps.updateComment(Object.freeze({ ...fields, commentId: selected.id }))
      : await deps.createComment(
          Object.freeze({ ...fields, pullNumber: input.binding.pullNumber }),
        );
  } catch (error) {
    try {
      if (record(error) && error.kind === 'timeout') return writeError('timeout');
    } catch {
      /* Exception properties are untrusted. */
    }
    return writeError('transport');
  }
  try {
    if (!record(response)) return writeError('acknowledgement');
    const ack = structuredClone({ status: response.status, data: response.data });
    if (
      typeof ack.status === 'number' &&
      Number.isInteger(ack.status) &&
      ack.status >= 100 &&
      ack.status <= 599 &&
      (ack.status < 200 || ack.status > 299)
    )
      return writeError('rejection');
    const comment = ack.status === (selected ? 200 : 201) ? ownedComment(ack.data, input) : null;
    const expectedCommentId = selected?.id ?? comment?.id;
    if (!comment || comment.body !== input.body || comment.id !== expectedCommentId)
      return writeError('acknowledgement');
    return Object.freeze({
      identity: input.binding.identity,
      headSha: input.binding.headSha,
      commentId: comment.id,
      operation: selected ? 'updated' : 'created',
    });
  } catch {
    return writeError('acknowledgement');
  }
}

async function rereadComment(
  input: PublicationInput,
  selected: OwnedComment,
  deps: CommentDependencies,
): Promise<boolean> {
  try {
    const response = await deps.readComment(
      Object.freeze({ repository: input.binding.repository, commentId: selected.id }),
    );
    if (!record(response)) return false;
    const snapshot = structuredClone({ status: response.status, data: response.data });
    const comment = snapshot.status === 200 ? ownedComment(snapshot.data, input) : null;
    return comment !== null && comment.id === selected.id && comment.body === selected.body;
  } catch {
    return false;
  }
}

/** One mutation attempt; W2 owns pending provenance, job failure, and status ordering. */
export async function publishManagedComment(
  value: unknown,
  deps: CommentDependencies,
): Promise<CommentResult> {
  let input: PublicationInput | DiscoveryError | PublicationInputError;
  try {
    input = parsePublication(value);
  } catch {
    input = inputError('input');
  }
  if ('kind' in input) return { ...input, mutation: 'not-attempted' };
  const selection = await selectComment(input, deps);
  if (selection.kind === 'error') return { ...selection, mutation: 'not-attempted' };
  const selected = selection.comment;
  if (selected && !(await rereadComment(input, selected, deps)))
    return { kind: 'error', category: 'discovery', field: 'comments', mutation: 'not-attempted' };
  const before = await publicationGate(input.binding, deps);
  if (before.kind !== 'fresh') return { ...before, mutation: 'not-attempted' };
  if (selected?.body === input.body)
    return {
      kind: 'recorded',
      mutation: 'not-attempted',
      receipt: Object.freeze({
        identity: input.binding.identity,
        headSha: input.binding.headSha,
        commentId: selected.id,
        operation: 'identical',
      }),
    };
  const receipt = await writeComment(input, deps, selected);
  if ('kind' in receipt) return receipt;
  const after = await publicationGate(input.binding, deps);
  if (after.kind === 'error')
    return {
      kind: 'error',
      category: 'post-write',
      field: after.field,
      mutation: 'confirmed',
      receipt,
    };
  return { kind: after.kind === 'fresh' ? 'recorded' : 'obsolete', mutation: 'confirmed', receipt };
}
