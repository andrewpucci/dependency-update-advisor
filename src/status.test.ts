import { expect, test, vi } from 'vite-plus/test';
import { publishExecutionStatus, type StatusRequest, type StatusDependencies } from './status.js';
import type { ReviewBinding, ReviewIdentity } from './event.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'c'.repeat(40);

function acknowledgement(request: StatusRequest) {
  return {
    status: 201,
    data: {
      id: 601,
      state: request.state,
      context: request.context,
      target_url: request.target_url,
      description: request.description,
    },
  };
}

function fixture(kind = 'running') {
  const repository = { id: 101, owner: 'example', name: 'consumer' };
  const identity: ReviewIdentity = [101, 301, 401, 1, 42, HEAD];
  const binding: ReviewBinding = {
    repository,
    workflow: { id: 301, path: '.github/workflows/ci.yml' },
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headRepository: repository,
    headSha: HEAD,
    actorId: 201,
    conclusion: 'success',
    identity,
  };
  const repo = { id: 101, full_name: 'example/consumer' };
  const actor = { id: 201, login: 'dependabot[bot]', type: 'Bot' };
  const run = {
    id: 401,
    workflow_id: 301,
    run_attempt: 1,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD,
    actor,
    repository: repo,
    head_repository: repo,
    pull_requests: [
      {
        number: 42,
        base: { repo: { id: 101, name: 'consumer' } },
        head: { sha: HEAD, repo: { id: 101, name: 'consumer' } },
      },
    ],
  };
  const pr = {
    number: 42,
    state: 'open',
    merged: false,
    user: actor,
    base: { repo },
    head: { sha: HEAD, repo },
  };
  const input = {
    binding,
    reviewer: { runId: 501, runAttempt: 2 },
    outcome: { kind, identity, commentRecorded: true },
    previousCommentIsStale: false,
  };
  const order: string[] = [];
  const readRun = vi.fn<StatusDependencies['reads']['readRun']>(async () => {
    order.push('run');
    return run;
  });
  const readPullRequest = vi.fn<StatusDependencies['reads']['readPullRequest']>(async () => {
    order.push('pr');
    return pr;
  });
  const readOwnership = vi.fn<StatusDependencies['readOwnership']>(async (identity) => {
    order.push('ownership');
    return { identity, state: 'owned' };
  });
  const createStatus = vi.fn<StatusDependencies['createStatus']>(async (request) => {
    order.push('write');
    return {
      status: 201,
      data: {
        id: 601,
        state: request.state,
        context: request.context,
        target_url: request.target_url,
        description: request.description,
      },
    };
  });
  const dependencies = { reads: { readRun, readPullRequest }, readOwnership, createStatus };
  return {
    input,
    binding,
    run,
    pr,
    order,
    readRun,
    readPullRequest,
    readOwnership,
    createStatus,
    dependencies,
  };
}

test('publishes pending only between fresh ownership observations', async () => {
  const f = fixture();
  expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
    kind: 'published',
    publication: 'confirmed',
    receipt: { headSha: HEAD, state: 'pending', context: 'dependabot-review', statusId: 601 },
  });
  expect(f.createStatus).toHaveBeenCalledExactlyOnceWith({
    repository: f.binding.repository,
    sha: HEAD,
    state: 'pending',
    context: 'dependabot-review',
    target_url: 'https://github.com/example/consumer/actions/runs/501/attempts/2',
    description: 'Review in progress',
  });
  expect(f.order).toEqual(['run', 'pr', 'ownership', 'write', 'run', 'pr', 'ownership']);
});

test('rejects a changed head before pending without a fallback write', async () => {
  const f = fixture();
  f.pr.head.sha = NEXT_HEAD;
  expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
    kind: 'obsolete',
    publication: 'not-attempted',
  });
  expect(f.createStatus).not.toHaveBeenCalled();
});

test('retains the original receipt when the head changes during pending', async () => {
  const f = fixture();
  const create = f.createStatus.getMockImplementation()!;
  f.createStatus.mockImplementation(async (request) => {
    const response = await create(request);
    f.pr.head.sha = NEXT_HEAD;
    return response;
  });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
    kind: 'obsolete',
    publication: 'confirmed',
    receipt: { headSha: HEAD, state: 'pending', context: 'dependabot-review', statusId: 601 },
  });
  expect(f.createStatus).toHaveBeenCalledTimes(1);
});

test.each([
  ['running', 'pending', 'Review in progress'],
  ['complete', 'success', 'Review completed'],
  ['incomplete', 'failure', 'Review unavailable or incomplete'],
] as const)('publishes the recorded %s outcome as %s', async (kind, state, description) => {
  const f = fixture();
  Object.assign(f.input.outcome, { kind, commentRecorded: true, recommendation: 'do_not_merge' });
  f.input.previousCommentIsStale = true;
  const result = await publishExecutionStatus(f.input, f.dependencies);
  expect(result).toMatchObject({ kind: 'published', publication: 'confirmed', receipt: { state } });
  expect(f.createStatus.mock.calls[0]![0]).toMatchObject({
    state,
    description: description + (state === 'success' ? '' : '. Previous comment is stale'),
  });
});

test.each([undefined, false, 'true', null])(
  'rejects complete outcomes with commentRecorded %j',
  async (commentRecorded) => {
    const f = fixture();
    Object.assign(f.input.outcome, { kind: 'complete', commentRecorded });
    expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'input',
      publication: 'not-attempted',
    });
    expect(f.createStatus).not.toHaveBeenCalled();
  },
);

test('CI success and a local merge override cannot complete an incomplete review', async () => {
  const f = fixture();
  Object.assign(f.input.outcome, {
    kind: 'incomplete',
    recommendation: 'merge',
    commentRecorded: true,
  });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'published',
    receipt: { state: 'failure' },
  });
});

test.each([401, 403, 404, 422, 429, 500, 503])(
  'returns an unknown write outcome for HTTP %i',
  async (status) => {
    const f = fixture();
    f.createStatus.mockResolvedValue({
      status,
      data: {
        id: 601,
        state: 'success',
        context: 'dependabot-review',
        target_url: 'https://github.com/',
        description: 'rejected',
      },
    });
    expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
      kind: 'error',
      category: 'write',
      field: 'status',
      publication: 'unknown',
      diagnostic: 'rejection',
    });
    expect(f.createStatus).toHaveBeenCalledTimes(1);
  },
);

test.each([
  [new Error('synthetic private exception'), 'transport'],
  [{ kind: 'timeout', message: 'synthetic private exception' }, 'timeout'],
] as const)('sanitizes a %j write failure', async (error, diagnostic) => {
  const f = fixture();
  f.createStatus.mockRejectedValue(error);
  expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
    kind: 'error',
    category: 'write',
    field: 'status',
    publication: 'unknown',
    diagnostic,
  });
  expect(f.createStatus).toHaveBeenCalledTimes(1);
});

const kinds = ['running', 'complete', 'incomplete'];
const changes = ['head', 'closed', 'merged', 'attempt', 'lost'] as const;
function advance(f: ReturnType<typeof fixture>, change: (typeof changes)[number]) {
  if (change === 'head') f.pr.head.sha = NEXT_HEAD;
  if (change === 'closed') f.pr.state = 'closed';
  if (change === 'merged') f.pr.merged = true;
  if (change === 'attempt')
    Object.assign(f.run, { run_attempt: 2, status: 'queued', conclusion: null });
  if (change === 'lost')
    f.readOwnership.mockImplementation(async (identity) => ({ identity, state: 'lost' }));
}

test.each(kinds.flatMap((kind) => changes.map((change) => ({ kind, change }))))(
  'stops $kind before writing after $change changes',
  async ({ kind, change }) => {
    const f = fixture(kind);
    advance(f, change);
    expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
      kind: 'obsolete',
      publication: 'not-attempted',
    });
    expect(f.createStatus).not.toHaveBeenCalled();
  },
);

test.each(kinds.flatMap((kind) => changes.map((change) => ({ kind, change }))))(
  'retains the $kind receipt when $change changes during dispatch',
  async ({ kind, change }) => {
    const f = fixture(kind);
    f.createStatus.mockImplementation(async (request) => {
      advance(f, change);
      return acknowledgement(request);
    });
    const state = kind === 'running' ? 'pending' : kind === 'complete' ? 'success' : 'failure';
    expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
      kind: 'obsolete',
      publication: 'confirmed',
      receipt: { headSha: HEAD, state, context: 'dependabot-review', statusId: 601 },
    });
    expect(f.createStatus).toHaveBeenCalledTimes(1);
    expect(f.createStatus.mock.calls[0]![0].sha).toBe(HEAD);
  },
);

test.each([
  null,
  {},
  { state: 'owned' },
  { identity: [], state: 'owned' },
  { identity: [101, 301, 401, 1, 43, HEAD], state: 'owned' },
  { identity: [101, 301, 401, 1, 42, HEAD], state: 'unseen' },
])('rejects unavailable or mismatched ownership %j', async (ownership) => {
  const f = fixture();
  f.readOwnership.mockResolvedValue(ownership);
  expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
    kind: 'error',
    category: 'ownership',
    field: 'ownership',
    publication: 'not-attempted',
  });
  expect(f.createStatus).not.toHaveBeenCalled();
});

test.each(['run', 'pr', 'ownership'] as const)(
  'sanitizes pre/post-write %s exceptions',
  async (source) => {
    for (const after of [false, true]) {
      const f = fixture();
      const fail = () => {
        const mock =
          source === 'run' ? f.readRun : source === 'pr' ? f.readPullRequest : f.readOwnership;
        mock.mockRejectedValue(new Error('synthetic sensitive text'));
      };
      if (after)
        f.createStatus.mockImplementation(async (request) => {
          fail();
          return acknowledgement(request);
        });
      else fail();
      const result = await publishExecutionStatus(f.input, f.dependencies);
      expect(result).toMatchObject({
        kind: 'error',
        category: after ? 'post-write' : source === 'ownership' ? 'ownership' : 'verification',
        publication: after ? 'confirmed' : 'not-attempted',
      });
      expect(JSON.stringify(result)).not.toContain('synthetic sensitive text');
      expect(f.createStatus).toHaveBeenCalledTimes(after ? 1 : 0);
    }
  },
);

test.each(['run', 'pr', 'ownership'] as const)(
  'rejects malformed pre/post-write %s responses',
  async (source) => {
    for (const after of [false, true]) {
      const f = fixture();
      const corrupt = () => {
        const mock =
          source === 'run' ? f.readRun : source === 'pr' ? f.readPullRequest : f.readOwnership;
        mock.mockResolvedValue(null);
      };
      if (after)
        f.createStatus.mockImplementation(async (request) => {
          corrupt();
          return acknowledgement(request);
        });
      else corrupt();
      expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
        kind: 'error',
        category: after ? 'post-write' : source === 'ownership' ? 'ownership' : 'verification',
        publication: after ? 'confirmed' : 'not-attempted',
      });
      expect(f.createStatus).toHaveBeenCalledTimes(after ? 1 : 0);
    }
  },
);

test.each(['id', 'state', 'context', 'target_url', 'description', 'status'])(
  'rejects missing or conflicting acknowledgement %s',
  async (field) => {
    for (const missing of [true, false]) {
      const f = fixture();
      f.createStatus.mockImplementation(async (request) => {
        const response = acknowledgement(request);
        const target = field === 'status' ? response : response.data;
        if (missing) Reflect.deleteProperty(target, field);
        else
          Reflect.set(
            target,
            field,
            field === 'id' ? '601' : field === 'status' ? '201' : 'unexpected',
          );
        return response;
      });
      expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
        kind: 'error',
        category: 'write',
        publication: 'unknown',
        diagnostic: 'acknowledgement',
      });
      expect(f.createStatus).toHaveBeenCalledTimes(1);
    }
  },
);

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
  'rejects invalid status ID %j',
  async (id) => {
    const f = fixture();
    f.createStatus.mockImplementation(async (request) => {
      const response = acknowledgement(request);
      response.data.id = id;
      return response;
    });
    expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'write',
      publication: 'unknown',
    });
  },
);

test.each(['binding', 'reviewer', 'outcome', 'previousCommentIsStale'])(
  'rejects malformed %s input without writing',
  async (field) => {
    const f = fixture();
    const input = { ...f.input, [field]: null };
    expect(await publishExecutionStatus(input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'input',
      publication: 'not-attempted',
    });
    expect(f.createStatus).not.toHaveBeenCalled();
  },
);

test.each([null, undefined, [], 1, 'input'])('rejects primitive input %j', async (input) => {
  const f = fixture();
  expect(await publishExecutionStatus(input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'input',
    publication: 'not-attempted',
  });
  expect(f.readRun).not.toHaveBeenCalled();
  expect(f.createStatus).not.toHaveBeenCalled();
});

test.each([0, -1, '501', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid reviewer IDs %j',
  async (runId) => {
    const f = fixture();
    Object.assign(f.input.reviewer, { runId });
    expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'input',
    });
    expect(f.createStatus).not.toHaveBeenCalled();
  },
);

test.each([0, 1, 2, 3, 4, 5])(
  'rejects independent outcome identity mismatch at %i',
  async (index) => {
    const f = fixture('complete');
    f.input.outcome.identity = [...f.binding.identity] as ReviewIdentity;
    Reflect.set(f.input.outcome.identity, index, index === 5 ? NEXT_HEAD : 999);
    expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'input',
    });
    expect(f.createStatus).not.toHaveBeenCalled();
  },
);

test('reports an outcome identity mismatch even when the binding is obsolete', async () => {
  const f = fixture('complete');
  f.input.outcome.identity = [...f.binding.identity] as ReviewIdentity;
  Reflect.set(f.input.outcome.identity, 5, NEXT_HEAD);
  f.pr.head.sha = NEXT_HEAD;
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'input',
    field: 'outcome',
  });
  expect(f.readRun).not.toHaveBeenCalled();
  expect(f.createStatus).not.toHaveBeenCalled();
});

test('rejects a reviewer run that reuses the source CI run ID', async () => {
  const f = fixture();
  f.input.reviewer.runId = f.binding.runId;
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'input',
    field: 'reviewer',
  });
  expect(f.createStatus).not.toHaveBeenCalled();
});

test('dispatches and attributes the canonical lowercase head SHA', async () => {
  const f = fixture();
  Object.assign(f.binding, { headSha: HEAD.toUpperCase() });
  const result = await publishExecutionStatus(f.input, f.dependencies);
  expect(result).toMatchObject({ kind: 'published', receipt: { headSha: HEAD } });
  expect(f.createStatus.mock.calls[0]![0].sha).toBe(HEAD);
});

test.each([200, 202])(
  'treats unexpected success status %i as an unconfirmed acknowledgement',
  async (status) => {
    const f = fixture();
    f.createStatus.mockImplementation(async (request) => ({ ...acknowledgement(request), status }));
    expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'write',
      diagnostic: 'acknowledgement',
      publication: 'unknown',
    });
  },
);

test('owns binding, reviewer, outcome, and stale metadata before the first read', async () => {
  const f = fixture('complete');
  f.readRun.mockImplementationOnce(async () => {
    Object.assign(f.input.binding, { headSha: NEXT_HEAD });
    Object.assign(f.input.binding.repository, { name: 'replacement' });
    f.input.reviewer.runId = 999;
    f.input.outcome.kind = 'incomplete';
    f.input.previousCommentIsStale = true;
    return f.run;
  });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'published',
    receipt: { headSha: HEAD, state: 'success' },
  });
  expect(f.createStatus.mock.calls[0]![0]).toMatchObject({
    repository: { name: 'consumer' },
    sha: HEAD,
    target_url: 'https://github.com/example/consumer/actions/runs/501/attempts/2',
    description: 'Review completed',
  });
});

test('uses only bounded repository fields even when extra payload fields are present', async () => {
  const f = fixture();
  Object.assign(f.binding.repository, { untrusted: 'synthetic sensitive data' });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'published',
  });
  expect(f.createStatus.mock.calls[0]![0].repository).toEqual({
    id: 101,
    owner: 'example',
    name: 'consumer',
  });
});

test('attributes fork heads to the consumer repository and separates reviewer/source run IDs', async () => {
  const f = fixture('complete');
  Object.assign(f.binding, {
    headRepository: { id: 102, owner: 'other', name: 'fork' },
    conclusion: 'cancelled',
  });
  Object.assign(f.run, {
    head_repository: { id: 102, full_name: 'other/fork' },
    conclusion: 'cancelled',
  });
  f.run.pull_requests[0]!.head.repo = { id: 102, name: 'fork' };
  f.pr.head.repo = { id: 102, full_name: 'other/fork' };
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'published',
  });
  expect(f.createStatus.mock.calls[0]![0].repository).toEqual({
    id: 101,
    owner: 'example',
    name: 'consumer',
  });
  expect(f.createStatus.mock.calls[0]![0].target_url).toContain('/runs/501/attempts/2');
  expect(f.readRun).toHaveBeenCalledWith(f.binding.repository, 401);
});

test.each([false, undefined])('omits the stale suffix when W2 reports %j', async (stale) => {
  const f = fixture();
  Object.assign(f.input, { previousCommentIsStale: stale });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'published',
  });
  expect(f.createStatus.mock.calls[0]![0].description).toBe('Review in progress');
});

test.each([
  null,
  {},
  { status: 201 },
  { status: 201, data: null },
  { status: NaN },
  { status: -1 },
  { status: 201.5 },
])('rejects malformed transport envelope %j', async (response) => {
  const f = fixture();
  f.createStatus.mockResolvedValue(response);
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'write',
    diagnostic: 'acknowledgement',
    publication: 'unknown',
  });
  expect(f.createStatus).toHaveBeenCalledTimes(1);
});

test('protects request and ownership targets from mutation by injected callbacks', async () => {
  const f = fixture();
  f.readOwnership.mockImplementation(async (identity) => {
    expect(Reflect.set(identity, 0, 999)).toBe(false);
    return { identity, state: 'owned' };
  });
  f.createStatus.mockImplementation(async (request) => {
    expect(Reflect.set(request, 'sha', NEXT_HEAD)).toBe(false);
    expect(Reflect.set(request.repository, 'name', 'replacement')).toBe(false);
    return acknowledgement(request);
  });
  const result = await publishExecutionStatus(f.input, f.dependencies);
  expect(result).toMatchObject({ kind: 'published', receipt: { headSha: HEAD } });
  if ('receipt' in result) expect(Reflect.set(result.receipt, 'statusId', 999)).toBe(false);
});

test('constructs the reviewer URL from encoded identities rather than payload URLs', async () => {
  const f = fixture();
  Object.assign(f.binding.repository, { owner: 'example?query#fragment' });
  Object.assign(f.run.repository, { full_name: 'example?query#fragment/consumer' });
  Object.assign(f.input.reviewer, { html_url: 'https://untrusted.invalid/' });
  Object.assign(f.run, { html_url: 'https://untrusted.invalid/' });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'published',
  });
  const url = new URL(f.createStatus.mock.calls[0]![0].target_url);
  expect(url.origin).toBe('https://github.com');
  expect(url.search).toBe('');
  expect(url.hash).toBe('');
  expect(url.pathname).toBe('/example%3Fquery%23fragment/consumer/actions/runs/501/attempts/2');
});

test.each(['repository', 'workflow', 'run', 'actor', 'association', 'headRepository'] as const)(
  'classifies pre/post-write %s identity mismatches',
  async (identity) => {
    for (const after of [false, true]) {
      const f = fixture('complete');
      const mismatch = () => {
        if (identity === 'repository') f.run.repository.id = 999;
        if (identity === 'workflow') f.run.workflow_id = 999;
        if (identity === 'run') f.run.id = 999;
        if (identity === 'actor') f.run.actor.id = 999;
        if (identity === 'association') f.run.pull_requests[0]!.number = 999;
        if (identity === 'headRepository') f.pr.head.repo = { id: 999, full_name: 'other/fork' };
      };
      if (after)
        f.createStatus.mockImplementation(async (request) => {
          mismatch();
          return acknowledgement(request);
        });
      else mismatch();
      expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
        kind: 'error',
        category: after ? 'post-write' : 'verification',
        publication: after ? 'confirmed' : 'not-attempted',
      });
      expect(f.createStatus).toHaveBeenCalledTimes(after ? 1 : 0);
    }
  },
);

test.each([0, 1, 2, 3, 4, 5])(
  'rejects a forged binding identity at %i before reads',
  async (index) => {
    const f = fixture();
    Reflect.set(f.input.binding.identity, index, index === 5 ? NEXT_HEAD : 999);
    expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'input',
      field: 'binding',
      publication: 'not-attempted',
    });
    expect(f.readRun).not.toHaveBeenCalled();
    expect(f.createStatus).not.toHaveBeenCalled();
  },
);

test.each(['success', 'failure', '', null, 1, {}])(
  'rejects unrecognized outcome kind %j',
  async (kind) => {
    const f = fixture();
    Object.assign(f.input.outcome, { kind });
    expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
      kind: 'error',
      category: 'input',
    });
    expect(f.createStatus).not.toHaveBeenCalled();
  },
);

test('sanitizes uncloneable input and input access failures', async () => {
  const f = fixture();
  Object.assign(f.input.binding, { unused: () => 'synthetic sensitive text' });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'input',
  });
  const input = {
    get binding() {
      throw new Error('synthetic sensitive text');
    },
  };
  const result = await publishExecutionStatus(input, f.dependencies);
  expect(result).toMatchObject({ kind: 'error', category: 'input' });
  expect(JSON.stringify(result)).not.toContain('synthetic sensitive text');
  expect(f.createStatus).not.toHaveBeenCalled();
});

test('snapshots outcome getters once so validation cannot change into success', async () => {
  const f = fixture();
  let reads = 0;
  Object.assign(f.input.outcome, { commentRecorded: false });
  Object.defineProperty(f.input.outcome, 'kind', {
    enumerable: true,
    get: () => (++reads <= 2 ? 'running' : 'complete'),
  });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toMatchObject({
    kind: 'published',
    receipt: { state: 'pending' },
  });
  expect(reads).toBe(1);
});

test('sanitizes write exceptions whose timeout discriminator itself throws', async () => {
  const f = fixture();
  f.createStatus.mockRejectedValue({
    get kind() {
      throw new Error('synthetic sensitive text');
    },
  });
  expect(await publishExecutionStatus(f.input, f.dependencies)).toEqual({
    kind: 'error',
    category: 'write',
    field: 'status',
    publication: 'unknown',
    diagnostic: 'transport',
  });
});
