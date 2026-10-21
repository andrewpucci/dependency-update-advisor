import { expect, test, vi } from 'vite-plus/test';
import {
  discoverManagedComment,
  publishManagedComment,
  type CommentDiscoveryDependencies,
  type CommentDependencies,
} from './comments.js';
import { record, type ReviewBinding } from './event.js';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const MARKER = '<!-- dependabot-intelligent-review -->';
const publisher = { appId: 801, botUserId: 802 };
const issueUrl = 'https://api.github.com/repos/example/consumer/issues/42';
const body = (head = HEAD) => `${MARKER}\n<!-- reviewed-head: ${head} -->\n## Synthetic review\n`;

function owned(id = 901, commentBody = body(OLD_HEAD)) {
  return {
    id,
    body: commentBody,
    user: { id: 802, type: 'Bot' },
    performed_via_github_app: { id: 801 },
    issue_url: issueUrl,
  };
}

function discoveryFixture(comments: unknown[] = []) {
  const repository = { id: 101, owner: 'example', name: 'consumer' };
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
    identity: [101, 301, 401, 1, 42, HEAD],
  };
  const input = { binding, publisher: { ...publisher } };
  const listComments = vi.fn<CommentDiscoveryDependencies['listComments']>(async () => ({
    status: 200,
    complete: true,
    data: comments,
  }));
  return { binding, input, listComments, dependencies: { listComments } };
}

test('discovers absence only from a complete successful collection at the bound target', async () => {
  const f = discoveryFixture();
  expect(await discoverManagedComment(f.input, f.dependencies)).toEqual({
    kind: 'discovered',
    comment: null,
  });
  expect(f.listComments).toHaveBeenCalledExactlyOnceWith({
    repository: f.binding.repository,
    pullNumber: 42,
  });
});

test('discovers only numeric App ownership with a first-line marker, even beyond one page', async () => {
  const unrelated = Array.from({ length: 100 }, (_, i) => ({
    ...owned(i + 1),
    user: { id: 700, type: 'User' },
  }));
  const f = discoveryFixture([
    ...unrelated,
    { ...owned(201), user: { id: 701, type: 'Bot', login: 'github-actions[bot]' } },
    { ...owned(202), body: `Quoted\n${MARKER}` },
    { ...owned(203), body: 'Another App-owned message' },
    { ...owned(901), issue_url: issueUrl.toUpperCase() },
  ]);
  expect(await discoverManagedComment(f.input, f.dependencies)).toEqual({
    kind: 'discovered',
    comment: { commentId: 901, reviewedHeadSha: OLD_HEAD },
  });
});

test.each([undefined, null, { id: 801 }])(
  'accepts optional compatible App attribution %j',
  async (app) => {
    const f = discoveryFixture([{ ...owned(), performed_via_github_app: app }]);
    expect(await discoverManagedComment(f.input, f.dependencies)).toMatchObject({
      kind: 'discovered',
      comment: { commentId: 901 },
    });
  },
);

test.each([
  { ...owned(), performed_via_github_app: { id: 999 } },
  { ...owned(), performed_via_github_app: 'invalid' },
  { ...owned(), issue_url: issueUrl.replace('/42', '/43') },
  { ...owned(), issue_url: issueUrl.replace('consumer', 'old-name') },
  { ...owned(), issue_url: `${issueUrl}?ignored=true` },
  { ...owned(), user: { id: 802, type: 'User' } },
  { ...owned(), id: '901' },
  { ...owned(), user: null },
  { ...owned(), body: null },
])('fails discovery on unsafe or unclassifiable API data %#', async (comment) => {
  const f = discoveryFixture([comment]);
  expect(await discoverManagedComment(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'discovery',
  });
});

test('reports all ambiguous owned IDs without choosing a winner or returning old-head metadata', async () => {
  const f = discoveryFixture([owned(901), owned(902)]);
  expect(await discoverManagedComment(f.input, f.dependencies)).toEqual({
    kind: 'error',
    category: 'discovery',
    field: 'comments',
    diagnostic: 'ambiguity',
    commentIds: [901, 902],
  });
});

test.each([
  MARKER,
  `${MARKER}\n<!-- reviewed-head: invalid -->`,
  `${body(OLD_HEAD)}<!-- reviewed-head: ${HEAD} -->`,
  `${body(OLD_HEAD)}<!-- review-digest: invalid -->`,
])(
  'allows repairing owned legacy metadata without inventing a stale indicator %#',
  async (legacy) => {
    const f = discoveryFixture([owned(901, legacy)]);
    expect(await discoverManagedComment(f.input, f.dependencies)).toEqual({
      kind: 'discovered',
      comment: { commentId: 901 },
    });
  },
);

test.each([
  { status: 200, complete: false, data: [] },
  { status: 200, data: [] },
  { status: 403, complete: true, data: [] },
  { status: 404, complete: true, data: [] },
  { status: 429, complete: true, data: [] },
  { status: 500, complete: true, data: [] },
  { status: 200, complete: true, data: null },
])('never treats unsuccessful or incomplete listing as absence %#', async (response) => {
  const f = discoveryFixture();
  f.listComments.mockResolvedValue(response);
  expect(await discoverManagedComment(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'discovery',
  });
});

test('contains rejected listings and validates input before reads', async () => {
  const f = discoveryFixture();
  f.listComments.mockRejectedValue(new Error('secret-like response'));
  expect(await discoverManagedComment(f.input, f.dependencies)).toEqual({
    kind: 'error',
    category: 'discovery',
    field: 'comments',
  });
  f.listComments.mockClear();
  expect(
    await discoverManagedComment({ ...f.input, publisher: { appId: '801' } }, f.dependencies),
  ).toMatchObject({ kind: 'error', category: 'input' });
  expect(
    await discoverManagedComment(
      { ...f.input, binding: { ...f.binding, identity: [] } },
      f.dependencies,
    ),
  ).toMatchObject({ kind: 'error', category: 'input' });
  expect(f.listComments).not.toHaveBeenCalled();
});

function publicationFixture(comments: unknown[] = []) {
  const f = discoveryFixture(comments);
  const actor = { id: 201, login: 'dependabot[bot]', type: 'Bot' };
  const repo = { id: 101, full_name: 'example/consumer' };
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
    ...f.input,
    result: {
      identity: f.binding.identity,
      kind: 'complete',
      body: body(),
      reviewDigest: undefined as string | undefined,
    },
    pending: { headSha: HEAD, state: 'pending', context: 'dependabot-review', statusId: 601 },
  };
  const order: string[] = [];
  f.listComments.mockImplementation(async () => {
    order.push('list');
    return { status: 200, complete: true, data: comments };
  });
  const readRun = vi.fn<CommentDependencies['reads']['readRun']>(async () => {
    order.push('run');
    return run;
  });
  const readPullRequest = vi.fn<CommentDependencies['reads']['readPullRequest']>(async () => {
    order.push('pr');
    return pr;
  });
  const readOwnership = vi.fn<CommentDependencies['readOwnership']>(async (identity) => {
    order.push('ownership');
    return { identity, state: 'owned' };
  });
  const createComment = vi.fn<CommentDependencies['createComment']>(async (request) => {
    order.push('create');
    return { status: 201, data: owned(901, request.body) };
  });
  const readComment = vi.fn<CommentDependencies['readComment']>(async (request) => {
    order.push('read');
    return {
      status: 200,
      data: comments.find((value) => record(value) && value.id === request.commentId),
    };
  });
  const updateComment = vi.fn<CommentDependencies['updateComment']>(async (request) => {
    order.push('update');
    return { status: 200, data: owned(request.commentId, request.body) };
  });
  const dependencies: CommentDependencies = {
    ...f.dependencies,
    reads: { readRun, readPullRequest },
    readOwnership,
    createComment,
    readComment,
    updateComment,
  };
  return {
    ...f,
    input,
    run,
    pr,
    order,
    readRun,
    readPullRequest,
    readOwnership,
    createComment,
    readComment,
    updateComment,
    dependencies,
  };
}

const receipt = (operation = 'created') => ({
  identity: [101, 301, 401, 1, 42, HEAD],
  headSha: HEAD,
  commentId: 901,
  operation,
});

test.each(['complete', 'incomplete'])(
  'records a %s result only between fresh ownership observations',
  async (kind) => {
    const f = publicationFixture();
    f.input.result.kind = kind;
    expect(await publishManagedComment(f.input, f.dependencies)).toEqual({
      kind: 'recorded',
      mutation: 'confirmed',
      receipt: receipt(),
    });
    expect(f.createComment).toHaveBeenCalledExactlyOnceWith({
      repository: f.binding.repository,
      pullNumber: 42,
      body: f.input.result.body,
    });
    expect(f.order).toEqual(['list', 'run', 'pr', 'ownership', 'create', 'run', 'pr', 'ownership']);
  },
);

test.each([
  { pending: true },
  { pending: { state: 'success', headSha: HEAD, context: 'dependabot-review', statusId: 601 } },
  { pending: { state: 'pending', headSha: OLD_HEAD, context: 'dependabot-review', statusId: 601 } },
  { pending: { state: 'pending', headSha: HEAD, context: 'other', statusId: 601 } },
  { pending: { state: 'pending', headSha: HEAD, context: 'dependabot-review', statusId: '601' } },
  { result: { identity: [], kind: 'complete', body: body() } },
  { result: { identity: [101, 301, 401, 1, 42, HEAD], kind: 'running', body: body() } },
])('rejects inconsistent publication input before reads %#', async (patch) => {
  const f = publicationFixture();
  expect(await publishManagedComment({ ...f.input, ...patch }, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'input',
    mutation: 'not-attempted',
  });
  expect(f.order).toEqual([]);
});

test.each([
  '',
  body(OLD_HEAD),
  body().replace(MARKER, 'quoted marker'),
  `${body()}${MARKER}`,
  `${body()}<!-- reviewed-head: ${HEAD} -->`,
  `${body()}<!-- review-digest: ${'a'.repeat(64)} -->`,
  body().replace(HEAD, HEAD.toUpperCase()),
])('rejects unsafe rendered metadata before reads %#', async (invalidBody) => {
  const f = publicationFixture();
  f.input.result.body = invalidBody;
  expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'input',
    mutation: 'not-attempted',
  });
  expect(f.order).toEqual([]);
});

test('enforces the exact body ceiling and optional digest agreement', async () => {
  const f = publicationFixture();
  const digest = 'd'.repeat(64);
  f.input.result.reviewDigest = digest;
  f.input.result.body = `${MARKER}\n<!-- reviewed-head: ${HEAD} -->\n<!-- review-digest: ${digest} -->\n`;
  f.input.result.body = f.input.result.body.padEnd(50000, 'x');
  expect((await publishManagedComment(f.input, f.dependencies)).kind).toBe('recorded');
  f.order.length = 0;
  f.input.result.body += 'x';
  expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({ category: 'input' });
  expect(f.order).toEqual([]);
  f.input.result.body = body();
  expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({ category: 'input' });
});

test.each(['head', 'closed', 'merged', 'attempt', 'lost', 'verification', 'ownership'])(
  'rejects %s changes before create',
  async (change) => {
    const f = publicationFixture();
    if (change === 'head') f.pr.head.sha = OLD_HEAD;
    if (change === 'closed') f.pr.state = 'closed';
    if (change === 'merged') f.pr.merged = true;
    if (change === 'attempt') f.run.run_attempt = 2;
    if (change === 'lost')
      f.readOwnership.mockResolvedValue({ identity: f.binding.identity, state: 'lost' });
    if (change === 'verification') f.readRun.mockRejectedValue(new Error('private'));
    if (change === 'ownership') f.readOwnership.mockResolvedValue({ identity: [], state: 'owned' });
    const result = await publishManagedComment(f.input, f.dependencies);
    expect(result).toMatchObject({
      kind: change === 'verification' || change === 'ownership' ? 'error' : 'obsolete',
      mutation: 'not-attempted',
    });
    expect(f.createComment).not.toHaveBeenCalled();
  },
);

test.each([401, 403, 404, 422, 429, 500])(
  'contains rejected create HTTP %i without retry',
  async (status) => {
    const f = publicationFixture();
    f.createComment.mockResolvedValue({ status, data: 'private response' });
    expect(await publishManagedComment(f.input, f.dependencies)).toEqual({
      kind: 'error',
      category: 'write',
      field: 'comments',
      mutation: 'unknown',
      diagnostic: 'rejection',
    });
    expect(f.createComment).toHaveBeenCalledTimes(1);
  },
);

test.each([
  { status: 200, data: owned(901, body()) },
  { status: 201, data: { ...owned(901, body()), id: null } },
  { status: 201, data: owned(901, body(OLD_HEAD)) },
  { status: 201, data: { ...owned(901, body()), user: { id: 123, type: 'Bot' } } },
  { status: 201, data: { ...owned(901, body()), issue_url: `${issueUrl}/other` } },
])('rejects malformed create acknowledgements %#', async (acknowledgement) => {
  const f = publicationFixture();
  f.createComment.mockResolvedValue(acknowledgement);
  expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({
    kind: 'error',
    category: 'write',
    diagnostic: 'acknowledgement',
    mutation: 'unknown',
  });
  expect(f.createComment).toHaveBeenCalledTimes(1);
  expect(f.readRun).toHaveBeenCalledTimes(1);
});

test.each([new Error('private'), { kind: 'timeout' }])(
  'contains create exceptions %#',
  async (error) => {
    const f = publicationFixture();
    f.createComment.mockRejectedValue(error);
    expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({
      category: 'write',
      mutation: 'unknown',
      diagnostic: error instanceof Error ? 'transport' : 'timeout',
    });
    expect(f.createComment).toHaveBeenCalledTimes(1);
  },
);

test.each(['head', 'attempt', 'lost', 'verification', 'ownership'])(
  'retains confirmed original receipt on post-create %s',
  async (change) => {
    const f = publicationFixture();
    f.createComment.mockImplementation(async (request) => {
      if (change === 'head') f.pr.head.sha = OLD_HEAD;
      if (change === 'attempt') f.run.run_attempt = 2;
      if (change === 'lost')
        f.readOwnership.mockResolvedValue({ identity: f.binding.identity, state: 'lost' });
      if (change === 'verification') f.readRun.mockRejectedValue(new Error('private'));
      if (change === 'ownership')
        f.readOwnership.mockResolvedValue({ identity: [], state: 'owned' });
      return { status: 201, data: owned(901, request.body) };
    });
    const result = await publishManagedComment(f.input, f.dependencies);
    expect(result).toMatchObject({
      kind: ['verification', 'ownership'].includes(change) ? 'error' : 'obsolete',
      mutation: 'confirmed',
      receipt: receipt(),
    });
    if (result.kind === 'error') expect(result.category).toBe('post-write');
    expect(f.createComment).toHaveBeenCalledTimes(1);
  },
);

test('updates only the owned target after rereading it, including legacy metadata repair', async () => {
  const f = publicationFixture([owned(901, MARKER)]);
  expect(await publishManagedComment(f.input, f.dependencies)).toEqual({
    kind: 'recorded',
    mutation: 'confirmed',
    receipt: receipt('updated'),
  });
  expect(f.readComment).toHaveBeenCalledExactlyOnceWith({
    repository: f.binding.repository,
    commentId: 901,
  });
  expect(f.updateComment).toHaveBeenCalledExactlyOnceWith({
    repository: f.binding.repository,
    commentId: 901,
    body: body(),
  });
  expect(f.createComment).not.toHaveBeenCalled();
  expect(f.order).toEqual([
    'list',
    'read',
    'run',
    'pr',
    'ownership',
    'update',
    'run',
    'pr',
    'ownership',
  ]);
});

test('confirms an exactly identical owned body without mutation after the final gates', async () => {
  const f = publicationFixture([owned(901, body())]);
  expect(await publishManagedComment(f.input, f.dependencies)).toEqual({
    kind: 'recorded',
    mutation: 'not-attempted',
    receipt: receipt('identical'),
  });
  expect(f.order).toEqual(['list', 'read', 'run', 'pr', 'ownership']);
  expect(f.createComment).not.toHaveBeenCalled();
  expect(f.updateComment).not.toHaveBeenCalled();
});

test('same head and digest do not suppress a newer eligible attempt or changed body', async () => {
  const digest = 'd'.repeat(64);
  const brief = `${MARKER}\n<!-- reviewed-head: ${HEAD} -->\n<!-- review-digest: ${digest} -->\n`;
  const f = publicationFixture([owned(901, brief + 'old')]);
  Object.assign(f.binding, { runAttempt: 2, identity: [101, 301, 401, 2, 42, HEAD] });
  f.run.run_attempt = 2;
  f.input.result.identity = f.binding.identity;
  f.input.result.body = brief + 'new';
  f.input.result.reviewDigest = digest;
  expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({
    kind: 'recorded',
    receipt: { operation: 'updated', identity: [101, 301, 401, 2, 42, HEAD] },
  });
  expect(f.updateComment).toHaveBeenCalledTimes(1);
});

test.each([
  { status: 404 },
  { status: 200, data: owned(902) },
  { status: 200, data: owned(901, 'marker removed') },
  { status: 200, data: owned(901, body(OLD_HEAD) + 'edited') },
  { status: 200, data: { ...owned(), user: { id: 999, type: 'Bot' } } },
  { status: 200, data: { ...owned(), issue_url: issueUrl.replace('/42', '/43') } },
])('rejects a changed or missing reread without create fallback %#', async (response) => {
  const f = publicationFixture([owned()]);
  f.readComment.mockResolvedValue(response);
  expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({
    category: 'discovery',
    mutation: 'not-attempted',
  });
  expect(f.order).toEqual(['list']);
  expect(f.createComment).not.toHaveBeenCalled();
  expect(f.updateComment).not.toHaveBeenCalled();
});

test.each(['head', 'closed', 'attempt', 'lost', 'verification', 'ownership'])(
  'rejects an identical-body %s change without a receipt or post-write error',
  async (change) => {
    const f = publicationFixture([owned(901, body())]);
    if (change === 'head') f.pr.head.sha = OLD_HEAD;
    if (change === 'closed') f.pr.state = 'closed';
    if (change === 'attempt') f.run.run_attempt = 2;
    if (change === 'lost')
      f.readOwnership.mockResolvedValue({ identity: f.binding.identity, state: 'lost' });
    if (change === 'verification') f.readRun.mockRejectedValue(new Error('private'));
    if (change === 'ownership') f.readOwnership.mockResolvedValue(null);
    const result = await publishManagedComment(f.input, f.dependencies);
    expect(result).toMatchObject({
      kind: ['verification', 'ownership'].includes(change) ? 'error' : 'obsolete',
      mutation: 'not-attempted',
    });
    expect(result).not.toHaveProperty('receipt');
    if (result.kind === 'error') expect(result.category).not.toBe('post-write');
    expect(f.updateComment).not.toHaveBeenCalled();
    expect(f.createComment).not.toHaveBeenCalled();
  },
);

test.each(['head', 'merged', 'attempt', 'lost', 'verification', 'ownership'])(
  'retains original receipts after an update with post-write %s',
  async (change) => {
    const f = publicationFixture([owned()]);
    f.updateComment.mockImplementation(async (request) => {
      if (change === 'head') f.pr.head.sha = OLD_HEAD;
      if (change === 'merged') f.pr.merged = true;
      if (change === 'attempt') f.run.run_attempt = 2;
      if (change === 'lost')
        f.readOwnership.mockResolvedValue({ identity: f.binding.identity, state: 'lost' });
      if (change === 'verification') f.readRun.mockRejectedValue(new Error('private'));
      if (change === 'ownership') f.readOwnership.mockResolvedValue(null);
      return { status: 200, data: owned(request.commentId, request.body) };
    });
    const result = await publishManagedComment(f.input, f.dependencies);
    expect(result).toMatchObject({
      kind: ['verification', 'ownership'].includes(change) ? 'error' : 'obsolete',
      mutation: 'confirmed',
      receipt: receipt('updated'),
    });
    if (result.kind === 'error') expect(result.category).toBe('post-write');
    expect(f.createComment).not.toHaveBeenCalled();
    expect(f.updateComment).toHaveBeenCalledTimes(1);
  },
);

test.each([
  { status: 404 },
  { status: 201, data: owned(901, body()) },
  { status: 200, data: owned(902, body()) },
  { status: 200, data: owned(901, body(OLD_HEAD)) },
  { status: 200, data: { ...owned(901, body()), performed_via_github_app: { id: 999 } } },
])('contains failed update acknowledgements without retry %#', async (response) => {
  const f = publicationFixture([owned()]);
  f.updateComment.mockResolvedValue(response);
  expect(await publishManagedComment(f.input, f.dependencies)).toMatchObject({
    category: 'write',
    mutation: 'unknown',
  });
  expect(f.updateComment).toHaveBeenCalledTimes(1);
  expect(f.createComment).not.toHaveBeenCalled();
});
