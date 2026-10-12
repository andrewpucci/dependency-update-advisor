import { expect, test, vi } from 'vite-plus/test';
import {
  verifyCiEvent,
  reverifyReviewBinding,
  type EventReads,
  type ReviewIdentity,
} from './event.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'c'.repeat(40);

function fixture() {
  const repository = { id: 101, full_name: 'example/consumer' };
  const actor = { id: 201, login: 'dependabot[bot]', type: 'Bot' };
  const association = {
    number: 42,
    base: { repo: { id: 101, name: 'consumer' } },
    head: { sha: HEAD, repo: { id: 101, name: 'consumer' } },
  };
  const run = {
    id: 401,
    workflow_id: 301,
    run_attempt: 1,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD,
    actor,
    repository,
    head_repository: repository,
    pull_requests: [association],
  };
  const input = {
    eventName: 'workflow_run',
    expected: {
      repository: { id: 101, owner: 'example', name: 'consumer' },
      workflow: { id: 301, path: '.github/workflows/ci.yml' },
    },
    payload: { action: 'completed', repository, workflow_run: structuredClone(run) },
  };
  const pullRequest = {
    number: 42,
    state: 'open',
    merged: false,
    user: actor,
    base: { repo: repository },
    head: { sha: HEAD, repo: repository },
  };
  const workflow = { id: 301, path: '.github/workflows/ci.yml' };
  const readWorkflow = vi.fn(async () => workflow);
  const readRun = vi.fn(async () => run);
  const readPullRequest = vi.fn(async () => pullRequest);
  const readReplay = vi.fn(async (identity: ReviewIdentity) => ({ identity, state: 'unseen' }));
  const reads: EventReads = { readWorkflow, readRun, readPullRequest, readReplay };
  return {
    input,
    run,
    pullRequest,
    workflow,
    reads,
    readWorkflow,
    readRun,
    readPullRequest,
    readReplay,
  };
}

test('binds one completed source attempt to the current open Dependabot PR', async () => {
  const f = fixture();
  const result = await verifyCiEvent(f.input, f.reads);
  expect(result.kind).toBe('verified');
  if (result.kind !== 'verified') throw new Error('expected binding');
  expect(result.binding).toMatchObject({
    repository: f.input.expected.repository,
    workflow: f.input.expected.workflow,
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headSha: HEAD,
    actorId: 201,
    conclusion: 'success',
    identity: [101, 301, 401, 1, 42, HEAD],
  });
  expect(f.readWorkflow).toHaveBeenCalledWith(f.input.expected.repository, 301);
  expect(f.readRun).toHaveBeenCalledWith(f.input.expected.repository, 401);
  expect(f.readPullRequest).toHaveBeenCalledWith(f.input.expected.repository, 42);
  expect(f.readReplay).toHaveBeenCalledWith([101, 301, 401, 1, 42, HEAD]);
});

test.each([null, [], 'payload', 42])('rejects malformed event payload %j', async (payload) => {
  const f = fixture();
  expect(await verifyCiEvent({ ...f.input, payload }, f.reads)).toMatchObject({
    kind: 'error',
    category: 'input',
  });
  expect(f.readWorkflow).not.toHaveBeenCalled();
});

test('rejects a mismatched workflow before API reads', async () => {
  const f = fixture();
  f.input.payload.workflow_run.workflow_id = 302;
  expect(await verifyCiEvent(f.input, f.reads)).toMatchObject({
    kind: 'error',
    category: 'mismatch',
  });
  expect(f.readWorkflow).not.toHaveBeenCalled();
});

test('skips non-PR source runs', async () => {
  const f = fixture();
  f.input.payload.workflow_run.event = 'push';
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'ineligible' });
});

test('skips an advanced PR head instead of rebinding', async () => {
  const f = fixture();
  f.pullRequest.head.sha = NEXT_HEAD;
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'obsolete' });
  expect(f.readReplay).not.toHaveBeenCalled();
});

test.each(['claimed', 'completed'])('skips a %s review identity', async (state) => {
  const f = fixture();
  f.readReplay.mockImplementation(async (identity) => ({ identity, state }));
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'duplicate' });
});

test('fails securely when the API run read throws', async () => {
  const f = fixture();
  f.readRun.mockRejectedValue(new Error('synthetic sensitive text'));
  const result = await verifyCiEvent(f.input, f.reads);
  expect(result).toEqual({ kind: 'error', category: 'read', field: 'run' });
  expect(f.readPullRequest).not.toHaveBeenCalled();
});

test('rejects an object masquerading as an open PR state without coercion', async () => {
  const f = fixture();
  const toString = vi.fn(() => 'open');
  Object.assign(f.pullRequest, { state: { toString } });
  expect(await verifyCiEvent(f.input, f.reads)).toMatchObject({ kind: 'error', category: 'input' });
  expect(toString).not.toHaveBeenCalled();
});

test.each([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
])('accepts completed CI conclusion %s without changing it', async (conclusion) => {
  const f = fixture();
  f.run.conclusion = conclusion;
  f.input.payload.workflow_run.conclusion = conclusion;
  const result = await verifyCiEvent(f.input, f.reads);
  expect(result.kind).toBe('verified');
  if (result.kind !== 'verified') throw new Error('expected binding');
  expect(result.binding.conclusion).toBe(conclusion);
});

test('accepts a new CI attempt initiated by a human', async () => {
  const f = fixture();
  f.run.run_attempt = 2;
  Object.assign(f.run, { triggering_actor: { id: 999, login: 'maintainer', type: 'User' } });
  f.input.payload.workflow_run = structuredClone(f.run);
  const result = await verifyCiEvent(f.input, f.reads);
  expect(result.kind).toBe('verified');
  if (result.kind !== 'verified') throw new Error('expected binding');
  expect(result.binding.identity).toEqual([101, 301, 401, 2, 42, HEAD]);
  expect(result.binding.actorId).toBe(201);
});

test('treats a newer running attempt with null conclusion as obsolete', async () => {
  const f = fixture();
  Object.assign(f.run, {
    run_attempt: 2,
    status: 'in_progress',
    conclusion: null,
    pull_requests: [],
  });
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'obsolete' });
  expect(f.readPullRequest).not.toHaveBeenCalled();
});

async function boundFixture() {
  const f = fixture();
  const result = await verifyCiEvent(f.input, f.reads);
  if (result.kind !== 'verified') throw new Error('expected binding');
  f.readReplay.mockClear();
  return { ...f, binding: result.binding };
}

test('reverifies the same binding without demanding unseen replay state', async () => {
  const f = await boundFixture();
  f.readReplay.mockImplementation(async (identity) => ({ identity, state: 'claimed' }));
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({ kind: 'fresh' });
  expect(f.readReplay).not.toHaveBeenCalled();
});

test('freshness detects a newer running attempt without a terminal conclusion', async () => {
  const f = await boundFixture();
  Object.assign(f.run, { run_attempt: 2, status: 'queued', conclusion: null, pull_requests: [] });
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({ kind: 'obsolete' });
});

test('freshness reads the bound PR when closure empties run associations', async () => {
  const f = await boundFixture();
  f.run.pull_requests = [];
  f.pullRequest.state = 'closed';
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({ kind: 'obsolete' });
  expect(f.readPullRequest).toHaveBeenLastCalledWith(f.binding.repository, 42);
});

test('freshness detects a changed head even when its run association also advances', async () => {
  const f = await boundFixture();
  f.pullRequest.head.sha = NEXT_HEAD;
  f.run.pull_requests[0]!.head.sha = NEXT_HEAD;
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({ kind: 'obsolete' });
});

test('freshness rejects an unrelated associated PR even if the bound PR closes', async () => {
  const f = await boundFixture();
  f.run.pull_requests[0]!.number = 43;
  f.pullRequest.state = 'closed';
  expect(await reverifyReviewBinding(f.binding, f.reads)).toMatchObject({
    kind: 'error',
    category: 'mismatch',
  });
});

test('freshness keeps read failures distinct from malformed decoded data', async () => {
  const f = await boundFixture();
  f.readRun.mockRejectedValueOnce(new Error('private synthetic failure'));
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({
    kind: 'error',
    category: 'read',
    field: 'run',
  });
  Object.assign(f.run, { run_attempt: '1' });
  expect(await reverifyReviewBinding(f.binding, f.reads)).toMatchObject({
    kind: 'error',
    category: 'input',
  });
});

test('freshness refuses a forged identity tuple before API reads', async () => {
  const f = await boundFixture();
  f.readRun.mockClear();
  const forged = { ...f.binding, identity: [101, 301, 401, 1, 99, HEAD] };
  expect(await reverifyReviewBinding(forged, f.reads)).toEqual({
    kind: 'error',
    category: 'input',
    field: 'binding',
  });
  expect(f.readRun).not.toHaveBeenCalled();
});

test('freshness treats malformed multiple associations as invalid input', async () => {
  const f = await boundFixture();
  Object.assign(f.run, { pull_requests: [null, null] });
  expect(await reverifyReviewBinding(f.binding, f.reads)).toMatchObject({
    kind: 'error',
    category: 'input',
  });
});

test.each(['event', 'api'])(
  'rejects malformed multiple associations in the %s run',
  async (side) => {
    const f = fixture();
    const selected = side === 'event' ? f.input.payload.workflow_run : f.run;
    Object.assign(selected, { pull_requests: [selected.pull_requests[0], null] });
    expect(await verifyCiEvent(f.input, f.reads)).toMatchObject({
      kind: 'error',
      category: 'input',
    });
  },
);

test('classifies a recognized event status disagreeing with completion as a mismatch', async () => {
  const f = fixture();
  f.input.payload.workflow_run.status = 'in_progress';
  expect(await verifyCiEvent(f.input, f.reads)).toMatchObject({
    kind: 'error',
    category: 'mismatch',
  });
});
