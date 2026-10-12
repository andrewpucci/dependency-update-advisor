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
    actor: structuredClone(actor),
    repository: structuredClone(repository),
    head_repository: structuredClone(repository),
    pull_requests: [association],
  };
  const input = {
    eventName: 'workflow_run',
    expected: {
      repository: { id: 101, owner: 'example', name: 'consumer' },
      workflow: { id: 301, path: '.github/workflows/ci.yml' },
    },
    payload: {
      action: 'completed',
      repository: structuredClone(repository),
      workflow_run: structuredClone(run),
    },
  };
  const pullRequest = {
    number: 42,
    state: 'open',
    merged: false,
    user: structuredClone(actor),
    base: { repo: structuredClone(repository) },
    head: { sha: HEAD, repo: structuredClone(repository) },
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

function replace(root: unknown, path: string, value: unknown, remove = false) {
  const keys = path.split('.');
  let parent = root as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  const key = keys.at(-1)!;
  if (remove) delete parent[key];
  else parent[key] = value;
}

const runFields = [
  'id',
  'workflow_id',
  'run_attempt',
  'event',
  'status',
  'conclusion',
  'head_sha',
  'actor.id',
  'actor.login',
  'actor.type',
  'repository.id',
  'repository.full_name',
  'head_repository.id',
  'head_repository.full_name',
  'pull_requests',
  'pull_requests.0.number',
  'pull_requests.0.base.repo.id',
  'pull_requests.0.base.repo.name',
  'pull_requests.0.head.repo.id',
  'pull_requests.0.head.repo.name',
  'pull_requests.0.head.sha',
];
const prFields = [
  'number',
  'state',
  'merged',
  'user.id',
  'user.login',
  'user.type',
  'base.repo.id',
  'base.repo.full_name',
  'head.repo.id',
  'head.repo.full_name',
  'head.sha',
];
const requiredFields = [
  ...['eventName', 'payload.action', 'payload.repository.id', 'payload.repository.full_name'].map(
    (path) => [`input.${path}`, 'event'],
  ),
  ...['repository.id', 'repository.owner', 'repository.name', 'workflow.id', 'workflow.path'].map(
    (path) => [`input.expected.${path}`, 'expected'],
  ),
  ...runFields.map((path) => [`input.payload.workflow_run.${path}`, 'event']),
  ...runFields.map((path) => [`run.${path}`, 'run']),
  ...prFields.map((path) => [`pullRequest.${path}`, 'pullRequest']),
  ['workflow.id', 'workflow'],
  ['workflow.path', 'workflow'],
];

test.each(requiredFields)('rejects missing or null required field %s', async (path, field) => {
  for (const remove of [true, false]) {
    const f = fixture();
    replace(f, path!, null, remove);
    expect(await verifyCiEvent(f.input, f.reads)).toEqual({
      kind: 'error',
      category: 'input',
      field,
    });
    expect(f.readReplay).not.toHaveBeenCalled();
  }
});

const numericFields = [
  'input.expected.repository.id',
  'input.expected.workflow.id',
  ...[
    'id',
    'workflow_id',
    'run_attempt',
    'actor.id',
    'repository.id',
    'head_repository.id',
    'pull_requests.0.number',
    'pull_requests.0.base.repo.id',
    'pull_requests.0.head.repo.id',
  ].flatMap((path) => [`input.payload.workflow_run.${path}`, `run.${path}`]),
  'workflow.id',
  'pullRequest.number',
  'pullRequest.user.id',
  'pullRequest.base.repo.id',
  'pullRequest.head.repo.id',
];

test.each(numericFields)('rejects unsafe or coerced identity %s', async (path) => {
  for (const value of ['1', true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    replace(f, path, value);
    const result = await verifyCiEvent(f.input, f.reads);
    expect(result.kind).toBe('error');
    expect(result).toMatchObject({ category: 'input' });
    expect(result).not.toHaveProperty('binding');
  }
});

const disagreements: [string, unknown, string][] = [
  ['input.expected.repository.id', 102, 'event'],
  ['input.expected.repository.owner', 'other', 'event'],
  ['input.expected.repository.name', 'other', 'event'],
  ['input.expected.workflow.id', 302, 'event'],
  ['input.expected.workflow.path', '.github/workflows/other.yml', 'workflow'],
  ['input.payload.repository.id', 102, 'event'],
  ['input.payload.repository.full_name', 'other/consumer', 'event'],
  ['input.payload.repository.full_name', 'example/other', 'event'],
  ['input.payload.workflow_run.id', 402, 'run'],
  ['input.payload.workflow_run.actor.id', 202, 'run'],
  ['input.payload.workflow_run.head_repository.id', 102, 'event'],
  ['input.payload.workflow_run.head_repository.full_name', 'example/other', 'event'],
  ['input.payload.workflow_run.head_repository.full_name', 'other/consumer', 'run'],
  ['input.payload.workflow_run.head_sha', NEXT_HEAD, 'event'],
  ['input.payload.workflow_run.pull_requests.0.number', 43, 'run'],
  ['input.payload.workflow_run.repository.id', 102, 'event'],
  ['input.payload.workflow_run.repository.full_name', 'example/other', 'event'],
  ['input.payload.workflow_run.repository.full_name', 'other/consumer', 'event'],
  ['input.payload.workflow_run.workflow_id', 302, 'event'],
  ['input.payload.workflow_run.pull_requests.0.base.repo.id', 102, 'event'],
  ['input.payload.workflow_run.pull_requests.0.base.repo.name', 'other', 'event'],
  ['input.payload.workflow_run.pull_requests.0.head.repo.id', 102, 'event'],
  ['input.payload.workflow_run.pull_requests.0.head.repo.name', 'other', 'event'],
  ['input.payload.workflow_run.pull_requests.0.head.sha', NEXT_HEAD, 'event'],
  ['workflow.id', 302, 'workflow'],
  ['workflow.path', '.github/workflows/other.yml', 'workflow'],
  ['run.id', 402, 'run'],
  ['run.workflow_id', 302, 'run'],
  ['run.repository.id', 102, 'run'],
  ['run.repository.full_name', 'other/consumer', 'run'],
  ['run.repository.full_name', 'example/other', 'run'],
  ['run.head_repository.id', 102, 'run'],
  ['run.head_repository.full_name', 'other/consumer', 'run'],
  ['run.head_repository.full_name', 'example/other', 'run'],
  ['run.actor.id', 202, 'run'],
  ['run.actor.login', 'maintainer', 'run'],
  ['run.actor.type', 'User', 'run'],
  ['run.event', 'pull_request_target', 'run'],
  ['run.head_sha', NEXT_HEAD, 'run'],
  ['run.status', 'queued', 'run'],
  ['run.conclusion', 'failure', 'run'],
  ['run.pull_requests.0.number', 43, 'run'],
  ['run.pull_requests.0.base.repo.id', 102, 'run'],
  ['run.pull_requests.0.base.repo.name', 'other', 'run'],
  ['run.pull_requests.0.head.repo.id', 102, 'run'],
  ['run.pull_requests.0.head.repo.name', 'other', 'run'],
  ['run.pull_requests.0.head.sha', NEXT_HEAD, 'run'],
  ['pullRequest.number', 43, 'pullRequest'],
  ['pullRequest.base.repo.id', 102, 'pullRequest'],
  ['pullRequest.base.repo.full_name', 'other/consumer', 'pullRequest'],
  ['pullRequest.base.repo.full_name', 'example/other', 'pullRequest'],
  ['pullRequest.head.repo.id', 102, 'pullRequest'],
  ['pullRequest.head.repo.full_name', 'other/consumer', 'pullRequest'],
  ['pullRequest.head.repo.full_name', 'example/other', 'pullRequest'],
  ['pullRequest.user.id', 202, 'pullRequest'],
];

test.each(disagreements)(
  'rejects independent identity disagreement %s',
  async (path, value, field) => {
    const f = fixture();
    replace(f, path, value);
    expect(await verifyCiEvent(f.input, f.reads)).toEqual({
      kind: 'error',
      category: 'mismatch',
      field,
    });
    expect(f.readReplay).not.toHaveBeenCalled();
    if (field !== 'pullRequest' && path !== 'run.pull_requests.0.head.sha')
      expect(f.readPullRequest).not.toHaveBeenCalled();
  },
);

test.each(
  disagreements.filter(([path]) => path.startsWith('run.') || path.startsWith('pullRequest.')),
)('freshness rejects independent identity disagreement %s', async (path, value, field) => {
  const f = await boundFixture();
  replace(f, path, value);
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({
    kind: 'error',
    category: 'mismatch',
    field,
  });
  expect(f.readReplay).not.toHaveBeenCalled();
});

test.each([
  ...runFields.map((path) => `run.${path}`),
  ...prFields.map((path) => `pullRequest.${path}`),
])('freshness rejects invalid required field %s', async (path) => {
  const f = await boundFixture();
  replace(f, path, null);
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({
    kind: 'error',
    category: 'input',
    field: path.split('.')[0],
  });
});

test.each(['head_sha', 'pull_requests.0.head.sha'])(
  'rejects invalid full SHA at %s',
  async (path) => {
    for (const value of [HEAD.slice(0, 7), `${HEAD}a`, 'z'.repeat(40), ` ${HEAD}`, 123]) {
      const f = fixture();
      replace(f.input.payload.workflow_run, path, value);
      expect(await verifyCiEvent(f.input, f.reads)).toEqual({
        kind: 'error',
        category: 'input',
        field: 'event',
      });
    }
  },
);

test('normalizes repository and full-SHA case while preserving workflow path case', async () => {
  const f = fixture();
  for (const path of [
    'input.payload.repository.full_name',
    'input.payload.workflow_run.repository.full_name',
    'input.payload.workflow_run.head_repository.full_name',
    'run.repository.full_name',
    'run.head_repository.full_name',
    'pullRequest.base.repo.full_name',
    'pullRequest.head.repo.full_name',
  ])
    replace(f, path, 'Example/Consumer');
  for (const target of [f.run, f.input.payload.workflow_run]) {
    target.head_sha = HEAD.toUpperCase();
    target.pull_requests[0]!.head.sha = HEAD.toUpperCase();
    target.pull_requests[0]!.base.repo.name = 'Consumer';
    target.pull_requests[0]!.head.repo.name = 'CONSUMER';
  }
  f.input.expected.repository.owner = 'EXAMPLE';
  f.pullRequest.head.sha = HEAD.toUpperCase();
  const result = await verifyCiEvent(f.input, f.reads);
  expect(result.kind).toBe('verified');
  if (result.kind !== 'verified') throw new Error('expected binding');
  expect(result.binding.headSha).toBe(HEAD);
  expect(result.binding.repository).toEqual({ id: 101, owner: 'example', name: 'consumer' });
  f.workflow.path = '.github/workflows/CI.yml';
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({
    kind: 'error',
    category: 'mismatch',
    field: 'workflow',
  });
});

test.each([
  ' example/consumer',
  'example/consumer ',
  'example//consumer',
  'example/../consumer',
  'example/con\nsumer',
])('rejects malformed repository name %j', async (name) => {
  const f = fixture();
  f.input.payload.repository.full_name = name;
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({
    kind: 'error',
    category: 'input',
    field: 'event',
  });
});

test('accepts a consistently identified fork head without changing read targets', async () => {
  const f = fixture();
  for (const target of [f.run, f.input.payload.workflow_run]) {
    target.head_repository = { id: 102, full_name: 'fork/consumer' };
    target.pull_requests[0]!.head.repo.id = 102;
  }
  f.pullRequest.head.repo = { id: 102, full_name: 'fork/consumer' };
  const result = await verifyCiEvent(f.input, f.reads);
  expect(result.kind).toBe('verified');
  if (result.kind !== 'verified') throw new Error('expected binding');
  expect(result.binding.headRepository).toEqual({ id: 102, owner: 'fork', name: 'consumer' });
  expect(f.readPullRequest).toHaveBeenCalledWith(f.input.expected.repository, 42);
  expect(await reverifyReviewBinding(result.binding, f.reads)).toEqual({ kind: 'fresh' });
});

test.each(['event', 'api'])(
  'skips empty or multiple well-formed %s associations without guessing',
  async (side) => {
    for (const count of [0, 2]) {
      const f = fixture();
      const target = side === 'event' ? f.input.payload.workflow_run : f.run;
      const first = target.pull_requests[0]!;
      target.pull_requests = count === 0 ? [] : [first, { ...structuredClone(first), number: 43 }];
      expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'ineligible' });
      expect(f.readPullRequest).not.toHaveBeenCalled();
    }
  },
);

test.each(
  [[], [null], Array.from({ length: 1 }), [42], [{}]].map((associations) => ({ associations })),
)(
  'freshness fails securely for unusable association array $associations',
  async ({ associations }) => {
    const f = await boundFixture();
    Object.assign(f.run, { pull_requests: associations });
    expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({
      kind: 'error',
      category: associations.length === 0 ? 'mismatch' : 'input',
      field: 'run',
    });
  },
);

test('freshness rejects multiple well-formed associations', async () => {
  const f = await boundFixture();
  f.run.pull_requests.push(structuredClone(f.run.pull_requests[0]!));
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({
    kind: 'error',
    category: 'mismatch',
    field: 'run',
  });
});

test.each(['input.payload.workflow_run', 'run'])(
  'rejects invalid completed conclusions in %s',
  async (path) => {
    for (const value of [null, '', 'unknown', 'SUCCESS', 1, {}]) {
      const f = fixture();
      replace(f, `${path}.conclusion`, value);
      expect(await verifyCiEvent(f.input, f.reads)).toEqual({
        kind: 'error',
        category: 'input',
        field: path === 'run' ? 'run' : 'event',
      });
    }
  },
);

test('rejects an impossible future event attempt', async () => {
  const f = fixture();
  f.input.payload.workflow_run.run_attempt = 2;
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({
    kind: 'error',
    category: 'mismatch',
    field: 'run',
  });
});

test('new attempt refresh and repeat delivery use the source identity, independent of reviewer IDs', async () => {
  const f = fixture();
  const seen = new Set<string>();
  f.readReplay.mockImplementation(async (identity) => ({
    identity,
    state: seen.has(JSON.stringify(identity)) ? 'completed' : 'unseen',
  }));
  const first = await verifyCiEvent(f.input, f.reads);
  if (first.kind !== 'verified') throw new Error('expected first binding');
  seen.add(JSON.stringify(first.binding.identity));
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'duplicate' });
  f.run.run_attempt = 2;
  f.input.payload.workflow_run.run_attempt = 2;
  Object.assign(f.input, { reviewerRunId: 999, reviewerAttempt: 7, githubSha: NEXT_HEAD });
  const next = await verifyCiEvent(f.input, f.reads);
  if (next.kind !== 'verified') throw new Error('expected new binding');
  expect(next.binding.identity).toEqual([101, 301, 401, 2, 42, HEAD]);
  seen.add(JSON.stringify(next.binding.identity));
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'duplicate' });
  f.input.payload.workflow_run.run_attempt = 1;
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'obsolete' });
});

test.each(['push', 'pull_request_target', 'workflow_dispatch'])(
  'skips well-formed source event %s',
  async (event) => {
    const f = fixture();
    f.input.payload.workflow_run.event = event;
    expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'ineligible' });
    expect(f.readRun).not.toHaveBeenCalled();
  },
);

test.each(['outer event', 'action', 'original actor', 'PR author'])(
  'skips ineligible %s',
  async (field) => {
    const f = fixture();
    if (field === 'outer event') f.input.eventName = 'pull_request';
    if (field === 'action') f.input.payload.action = 'requested';
    if (field === 'original actor') f.input.payload.workflow_run.actor.login = 'maintainer';
    if (field === 'PR author') f.pullRequest.user.type = 'User';
    expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'ineligible' });
    expect(f.readReplay).not.toHaveBeenCalled();
  },
);

test.each(['closed', 'merged'])('initial and freshness checks detect a %s PR', async (state) => {
  const f = await boundFixture();
  if (state === 'closed') f.pullRequest.state = 'closed';
  else f.pullRequest.merged = true;
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({ kind: 'skip', reason: 'obsolete' });
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({ kind: 'obsolete' });
});

test.each(['workflow', 'run', 'pullRequest', 'replay'])(
  'sanitizes all failed %s reads',
  async (field) => {
    for (const status of [403, 404, 429, 'transport', 'decode']) {
      const f = fixture();
      const method = {
        workflow: f.readWorkflow,
        run: f.readRun,
        pullRequest: f.readPullRequest,
        replay: f.readReplay,
      }[field]!;
      method.mockRejectedValue(new Error(`synthetic-secret ${status}`));
      expect(await verifyCiEvent(f.input, f.reads)).toEqual({
        kind: 'error',
        category: field === 'replay' ? 'replay' : 'read',
        field,
      });
    }
  },
);

test('sanitizes freshness PR read failures', async () => {
  const f = await boundFixture();
  f.readPullRequest.mockRejectedValue(new Error('synthetic-secret 404'));
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({
    kind: 'error',
    category: 'read',
    field: 'pullRequest',
  });
});

test.each([null, {}, { state: 'unseen' }, { identity: [], state: 'unseen' }])(
  'rejects malformed replay snapshot %j',
  async (replay) => {
    const f = fixture();
    f.reads.readReplay = vi.fn(async () => replay);
    expect(await verifyCiEvent(f.input, f.reads)).toEqual({
      kind: 'error',
      category: 'replay',
      field: 'replay',
    });
  },
);

test.each(['unknown', null, undefined, {}, false])(
  'rejects uncertain replay state %j',
  async (state) => {
    const f = fixture();
    f.reads.readReplay = vi.fn(async (identity) => ({ identity, state }));
    expect(await verifyCiEvent(f.input, f.reads)).toEqual({
      kind: 'error',
      category: 'replay',
      field: 'replay',
    });
  },
);

test.each([0, 1, 2, 3, 4, 5])('rejects conflicting replay identity component %i', async (index) => {
  const f = fixture();
  f.reads.readReplay = vi.fn(async (identity: ReviewIdentity) => ({
    identity: identity.map((value, position) =>
      position === index ? (typeof value === 'number' ? value + 1 : NEXT_HEAD) : value,
    ),
    state: 'unseen',
  }));
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({
    kind: 'error',
    category: 'replay',
    field: 'replay',
  });
});

test('ignores hostile unused fields and never passes them into reads or bindings', async () => {
  const f = fixture();
  const extra = {
    url: 'https://invalid.example/synthetic-secret',
    name: 'CI',
    head_branch: 'dependabot/fake',
    title: 'synthetic-secret',
    token: 'synthetic-secret',
  };
  for (const target of [
    f.input.payload,
    f.input.payload.workflow_run,
    f.run,
    f.workflow,
    f.pullRequest,
    f.run.pull_requests[0]!,
  ])
    Object.assign(target, extra);
  const result = await verifyCiEvent(f.input, f.reads);
  expect(result.kind).toBe('verified');
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  for (const method of [f.readWorkflow, f.readRun, f.readPullRequest, f.readReplay])
    expect(JSON.stringify(method.mock.calls)).not.toContain('synthetic-secret');
  expect(f.readRun).toHaveBeenCalledWith({ id: 101, owner: 'example', name: 'consumer' }, 401);
  f.input.payload.workflow_run.workflow_id = 302;
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({
    kind: 'error',
    category: 'mismatch',
    field: 'event',
  });
});

test('owns immutable snapshots before awaits and after input mutation', async () => {
  const f = fixture();
  f.readWorkflow.mockImplementation(async () => {
    f.input.payload.workflow_run.id = 999;
    f.input.expected.repository.owner = 'attacker';
    return f.workflow;
  });
  const result = await verifyCiEvent(f.input, f.reads);
  if (result.kind !== 'verified') throw new Error('expected binding');
  const snapshot = structuredClone(result.binding);
  f.run.repository.id = 999;
  f.pullRequest.head.repo.full_name = 'attacker/repo';
  expect(result.binding).toEqual(snapshot);
  for (const value of [
    result.binding,
    result.binding.repository,
    result.binding.workflow,
    result.binding.headRepository,
    result.binding.identity,
  ])
    expect(Object.isFrozen(value)).toBe(true);
  expect(() => Object.assign(result.binding, { runId: 999 })).toThrow(TypeError);
  expect(() => Object.assign(result.binding.repository, { id: 999 })).toThrow(TypeError);
  expect(() => Object.assign(result.binding.identity, { 0: 999 })).toThrow(TypeError);
});

test.each([
  'repository.id',
  'workflow.id',
  'runId',
  'runAttempt',
  'pullNumber',
  'headRepository.id',
  'headSha',
  'actorId',
  'conclusion',
  'identity',
])('freshness rejects malformed supplied binding %s before reads', async (path) => {
  const f = await boundFixture();
  const candidate = structuredClone(f.binding);
  replace(candidate, path, null);
  f.readRun.mockClear();
  expect(await reverifyReviewBinding(candidate, f.reads)).toEqual({
    kind: 'error',
    category: 'input',
    field: 'binding',
  });
  expect(f.readRun).not.toHaveBeenCalled();
});

test('freshness copies a mutable supplied binding before reads', async () => {
  const f = await boundFixture();
  const candidate = structuredClone(f.binding);
  f.readRun.mockImplementation(async () => {
    replace(candidate, 'pullNumber', 99);
    replace(candidate, 'headSha', NEXT_HEAD);
    return f.run;
  });
  expect(await reverifyReviewBinding(candidate, f.reads)).toEqual({ kind: 'fresh' });
  expect(f.readPullRequest).toHaveBeenLastCalledWith(f.binding.repository, 42);
});

test.each([
  ['login', 'maintainer'],
  ['type', 'User'],
])('freshness rejects changed PR-author %s with the same numeric ID', async (field, value) => {
  const f = await boundFixture();
  replace(f.pullRequest.user, field!, value);
  expect(await reverifyReviewBinding(f.binding, f.reads)).toEqual({
    kind: 'error',
    category: 'mismatch',
    field: 'pullRequest',
  });
});

test('freshness rejects an API attempt older than the bound attempt', async () => {
  const f = fixture();
  f.run.run_attempt = 2;
  f.input.payload.workflow_run.run_attempt = 2;
  const result = await verifyCiEvent(f.input, f.reads);
  if (result.kind !== 'verified') throw new Error('expected binding');
  f.run.run_attempt = 1;
  expect(await reverifyReviewBinding(result.binding, f.reads)).toEqual({
    kind: 'error',
    category: 'mismatch',
    field: 'run',
  });
});

test('rejects inherited required identities', async () => {
  const f = fixture();
  const inherited = Object.create(f.input.payload.workflow_run);
  f.input.payload.workflow_run = inherited;
  expect(await verifyCiEvent(f.input, f.reads)).toEqual({
    kind: 'error',
    category: 'input',
    field: 'event',
  });
});
