import { expect, test, vi } from 'vite-plus/test';
import { publishExecutionStatus, type StatusRequest } from './status.js';
import type { ReviewBinding, ReviewIdentity } from './event.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'c'.repeat(40);

function fixture() {
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
    outcome: { kind: 'running', identity },
    previousCommentIsStale: false,
  };
  const order: string[] = [];
  const readRun = vi.fn(async () => {
    order.push('run');
    return run;
  });
  const readPullRequest = vi.fn(async () => {
    order.push('pr');
    return pr;
  });
  const readOwnership = vi.fn(async (identity: ReviewIdentity) => {
    order.push('ownership');
    return { identity, state: 'owned' };
  });
  const createStatus = vi.fn(async (request: StatusRequest) => {
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
