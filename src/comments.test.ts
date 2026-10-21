import { expect, test, vi } from 'vite-plus/test';
import { discoverManagedComment, type CommentDiscoveryDependencies } from './comments.js';
import type { ReviewBinding } from './event.js';

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
