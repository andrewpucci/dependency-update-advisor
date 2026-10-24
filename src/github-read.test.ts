import { expect, test, vi } from 'vite-plus/test';
import { createGithubReadSession, type GithubReadLimits } from './github-read.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const repository = { id: 101, owner: 'example', name: 'consumer' };
const repo = { id: 101, full_name: 'example/consumer' };
const binding = {
  repository,
  workflow: { id: 301, path: '.github/workflows/ci.yml' },
  runId: 401,
  runAttempt: 1,
  pullNumber: 42,
  headRepository: repository,
  headSha: HEAD,
  baseRef: 'main',
  baseSha: BASE,
  mergeBaseSha: BASE,
  actorId: 201,
  conclusion: 'success',
  identity: [101, 301, 401, 1, 42, HEAD],
};
const limits: GithubReadLimits = {
  maxRequests: 1000,
  maxPages: 40,
  maxFiles: 4000,
  maxJsonEntries: 100000,
  maxResponseBytes: 1000000,
  maxFileBytes: 100000,
  maxTotalBytes: 10000000,
  maxRetainedBytes: 1000000,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10000,
};
function pr(changed_files = 0) {
  return {
    number: 42,
    state: 'open',
    merged: false,
    user: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
    base: { ref: 'main', sha: BASE, repo },
    head: { sha: HEAD, repo },
    changed_files,
  };
}
function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}
function fixture(responses: Response[] = [json(pr())], overrides: Partial<GithubReadLimits> = {}) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return response;
  });
  return {
    input: { binding: structuredClone(binding), limits: { ...limits, ...overrides } },
    fetch,
    dependencies: { fetch, now: () => 0 },
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  const result = await createGithubReadSession(f.input, f.dependencies);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('expected ready session');
  return result.session;
}

test('creates a detached bound snapshot with fixed-origin GET and manual redirects', async () => {
  const f = fixture();
  const result = await createGithubReadSession(f.input, f.dependencies);
  expect(result).toMatchObject({ kind: 'ready', binding });
  expect(f.fetch).toHaveBeenCalledExactlyOnceWith(
    'https://api.github.com/repos/example/consumer/pulls/42',
    expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) }),
  );
  f.input.binding.repository.owner = 'attacker';
  if (result.kind !== 'ready') throw new Error('expected session');
  expect(result.binding.repository.owner).toBe('example');
  result.session.close();
});

test.each(Object.keys(limits))('requires valid caller limit %s before dispatch', async (key) => {
  for (const value of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    Object.assign(f.input.limits, { [key]: value });
    expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({ kind: 'invalid' });
    expect(f.fetch).not.toHaveBeenCalled();
  }
});

test.each([302, 404, 403, 429, 500])('maps status %s to safe fixed provenance', async (status) => {
  const f = fixture([json({ message: 'synthetic-private' }, status)]);
  const result = await createGithubReadSession(f.input, f.dependencies);
  expect(result).toEqual({
    kind: 'unavailable',
    reason: status === 429 ? 'rate_limit' : status === 404 ? 'missing' : 'unknown',
  });
});

test.each([
  [404, {}, 'missing'],
  [403, { 'x-ratelimit-remaining': '0' }, 'rate_limit'],
  [200, {}, 'malformed'],
])('classifies a bodiless %s response by its status', async (status, headers, reason) => {
  const f = fixture([new Response(null, { status, headers })]);
  expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({
    kind: 'unavailable',
    reason,
  });
});

test('enforces streamed bytes even with a false Content-Length and cancels the stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(101));
    },
    cancel() {
      cancelled = true;
    },
  });
  const f = fixture([new Response(stream, { headers: { 'content-length': '1' } })], {
    maxResponseBytes: 100,
  });
  expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(cancelled).toBe(true);
});

test('aborts an in-flight request at its deadline and rejects late success', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    let resolve: (response: Response) => void = () => {};
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    const pending = createGithubReadSession({ binding, limits }, { fetch, now: () => 0 });
    await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs);
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
    let cancelled = false;
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('requires a comparison only for observed base movement', async () => {
  const current = pr();
  current.base.sha = 'c'.repeat(40);
  const f = fixture([
    json(current),
    json({ base_commit: { sha: current.base.sha }, merge_base_commit: { sha: BASE } }),
  ]);
  const session = await ready(f);
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/repos/example/consumer/pulls/42',
    `https://api.github.com/repos/example/consumer/compare/${current.base.sha}...${HEAD}`,
  ]);
  session.close();
});

test.each(['head', 'closed', 'retarget', 'repo', 'author', 'count'])(
  'rejects conflicting or malformed metadata: %s',
  async (change) => {
    const value = pr();
    if (change === 'head') value.head.sha = 'c'.repeat(40);
    if (change === 'closed') value.state = 'closed';
    if (change === 'retarget') value.base.ref = 'other';
    if (change === 'repo') value.base.repo = { ...repo, id: 999 };
    if (change === 'author') value.user.id = 999;
    if (change === 'count') value.changed_files = -1;
    const f = fixture([json(value)]);
    expect(await createGithubReadSession(f.input, f.dependencies)).toEqual(
      ['head', 'closed', 'retarget'].includes(change)
        ? { kind: 'obsolete' }
        : { kind: 'unavailable', reason: change === 'count' ? 'malformed' : 'conflict' },
    );
  },
);

test('a streaming deadline cancels the body and request', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const f = fixture([
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    ]);
    const pending = createGithubReadSession(f.input, f.dependencies);
    await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs);
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(cancelled).toBe(true);
    expect(f.fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('validates cross-field limits and binding before dispatch', async () => {
  for (const patch of [
    { maxResponseBytes: limits.maxTotalBytes + 1 },
    { maxFileBytes: limits.maxTotalBytes + 1 },
    { requestTimeoutMs: limits.totalTimeoutMs + 1 },
  ]) {
    const f = fixture([], patch);
    expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({ kind: 'invalid' });
    expect(f.fetch).not.toHaveBeenCalled();
  }
  const f = fixture();
  f.input.binding.identity = [];
  expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({ kind: 'invalid' });
  expect(f.fetch).not.toHaveBeenCalled();
});

function row(index: number, status = 'modified', filename = `file-${index}.json`) {
  return { filename, status, sha: 'd'.repeat(40) };
}

test.each([0, 1, 100, 101])(
  'discovers %s files with terminal confirmation and bracketing',
  async (count) => {
    const rows = Array.from({ length: count }, (_, i) => row(i));
    const pages = [];
    for (let start = 0; start <= count; start += 100)
      pages.push(json(rows.slice(start, start + 100)));
    const f = fixture([json(pr(count)), json(pr(count)), ...pages, json(pr(count))]);
    const session = await ready(f);
    expect(await session.discoverFiles()).toMatchObject({
      kind: 'available',
      complete: true,
      files: rows.map((r) => ({
        path: r.filename,
        status: 'modified',
        previousPath: null,
        blobSha: r.sha,
      })),
      reasons: [],
    });
    const urls = f.fetch.mock.calls.map(([url]) => url);
    expect(urls[1]).toBe(urls[0]);
    expect(urls.at(-1)).toBe(urls[0]);
    expect(urls.filter((url) => url.includes('/files?'))).toHaveLength(Math.floor(count / 100) + 1);
    session.close();
  },
);

test('keeps rename paths across roots and ignores hostile content URLs and patches', async () => {
  const change = {
    ...row(1, 'renamed', '.github/workflows/build.yml'),
    previous_filename: 'nested/uv.lock',
    raw_url: 'https://attacker.invalid/private',
    patch: 'private',
  };
  const f = fixture([json(pr(1)), json(pr(1)), json([change]), json(pr(1))]);
  const result = await (await ready(f)).discoverFiles();
  expect(result).toMatchObject({
    kind: 'available',
    files: [{ path: '.github/workflows/build.yml', previousPath: 'nested/uv.lock' }],
  });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(
    f.fetch.mock.calls.every(([url]) =>
      url.startsWith('https://api.github.com/repos/example/consumer/'),
    ),
  ).toBe(true);
});

test.each(['duplicate', 'malformed', 'count', 'link', 'missing'])(
  'retains known rows after %s discovery failure',
  async (problem) => {
    const first = row(1);
    const page =
      problem === 'duplicate'
        ? [first, first]
        : problem === 'malformed'
          ? [first, { filename: '../bad', status: 'modified' }]
          : [first];
    const headers: HeadersInit =
      problem === 'link' ? { link: '<https://attacker.invalid/files?page=2>; rel="next"' } : {};
    const f = fixture([
      json(pr(2)),
      json(pr(2)),
      problem === 'missing' ? json({}, 404) : json(page, 200, headers),
      json(pr(2)),
    ]);
    const result = await (await ready(f)).discoverFiles();
    expect(result.kind).not.toBe('available');
    expect(result.complete).toBe(false);
    expect(result.files).toHaveLength(problem === 'missing' ? 0 : 1);
    expect(result.reasons.length).toBeGreaterThan(0);
  },
);

test('exactly 3000 files remains partial at the endpoint cap', async () => {
  const responses = [json(pr(3000)), json(pr(3000))];
  for (let page = 0; page < 30; page++)
    responses.push(json(Array.from({ length: 100 }, (_, i) => row(page * 100 + i))));
  responses.push(json(pr(3000)));
  const result = await (await ready(fixture(responses))).discoverFiles();
  expect(result).toMatchObject({ kind: 'partial', complete: false, reasons: ['truncated'] });
  expect(result.files).toHaveLength(3000);
});

test('base and merge-base divergence limits discovery without an ancestry request', async () => {
  const f = fixture([json(pr(1)), json(pr(1)), json([row(1)]), json(pr(1))]);
  f.input.binding.mergeBaseSha = 'c'.repeat(40);
  const result = await (await ready(f)).discoverFiles();
  expect(result).toMatchObject({ kind: 'partial', reasons: ['conflict'], complete: false });
  expect(f.fetch).toHaveBeenCalledTimes(4);
});

test('observed head movement discards usable discovery', async () => {
  const moved = pr(1);
  moved.head.sha = 'c'.repeat(40);
  const f = fixture([json(pr(1)), json(pr(1)), json([row(1)]), json(moved)]);
  expect(await (await ready(f)).discoverFiles()).toMatchObject({
    kind: 'obsolete',
    files: [],
    complete: false,
  });
});

test.each(['same', 'changed', 'failed'])(
  'classifies a base move after pagination: %s',
  async (change) => {
    const moved = pr(1);
    moved.base.sha = 'c'.repeat(40);
    const comparison =
      change === 'failed'
        ? json({}, 403)
        : json({
            base_commit: { sha: moved.base.sha },
            merge_base_commit: { sha: change === 'same' ? BASE : HEAD },
          });
    const f = fixture([json(pr(1)), json(pr(1)), json([row(1)]), json(moved), comparison]);
    const result = await (await ready(f)).discoverFiles();
    expect(result.kind).toBe(
      change === 'same' ? 'available' : change === 'changed' ? 'obsolete' : 'partial',
    );
    expect(result.files).toHaveLength(change === 'changed' ? 0 : 1);
    expect(result.binding.baseSha).toBe(BASE);
  },
);

test.each(['maxPages', 'maxFiles', 'maxRequests'] as const)(
  'retains evidence on shared %s exhaustion',
  async (key) => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i));
    const f = fixture([json(pr(101)), json(pr(101)), json(rows), json([row(101)]), json(pr(101))], {
      [key]: key === 'maxRequests' ? 3 : 1,
    });
    const result = await (await ready(f)).discoverFiles();
    expect(result).toMatchObject({ kind: 'partial', complete: false });
    expect(result.reasons).toContain('budget');
    expect(result.files.length).toBe(key === 'maxFiles' ? 1 : 100);
  },
);

test('accepts a same-endpoint next-page hint but rejects a loop without following it', async () => {
  const path = 'https://api.github.com/repos/example/consumer/pulls/42/files';
  const rows = Array.from({ length: 100 }, (_, i) => row(i));
  for (const next of [2, 1]) {
    const f = fixture([
      json(pr(100)),
      json(pr(100)),
      json(rows, 200, { link: `<${path}?per_page=100&page=${next}>; rel="next"` }),
      ...(next === 2 ? [json([])] : []),
      json(pr(100)),
    ]);
    expect((await (await ready(f)).discoverFiles()).kind).toBe(
      next === 2 ? 'available' : 'partial',
    );
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith('page=2'))).toBe(next === 2);
  }
});

test('accepts GitHub repository-ID pagination links only for the bound repository', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(i));
  for (const id of [101, 999]) {
    const path = `https://api.github.com/repositories/${id}/pulls/42/files`;
    const f = fixture([
      json(pr(100)),
      json(pr(100)),
      json(rows, 200, { link: `<${path}?per_page=100&page=2>; rel="next"` }),
      ...(id === 101 ? [json([])] : []),
      json(pr(100)),
    ]);
    expect(await (await ready(f)).discoverFiles()).toMatchObject(
      id === 101
        ? { kind: 'available', complete: true }
        : { kind: 'partial', reasons: ['conflict'] },
    );
    expect(f.fetch.mock.calls.some(([url]) => url.includes('/repositories/'))).toBe(false);
  }
});

const TREE = 'd'.repeat(40);
const BLOB = 'e'.repeat(40);
function commit(sha = BASE, tree = TREE) {
  return { sha, tree: { sha: tree } };
}
function tree(entries: unknown[], sha = TREE, truncated = false) {
  return { sha, truncated, tree: entries };
}
function entry(path = 'uv.lock', mode = '100644', type = 'blob', sha = BLOB) {
  return { path, mode, type, sha };
}
function blob(bytes: Uint8Array = new TextEncoder().encode('complete lockfile'), sha = BLOB) {
  return {
    sha,
    encoding: 'base64',
    size: bytes.length,
    content: Buffer.from(bytes).toString('base64'),
  };
}

test.each(['base', 'head'] as const)(
  'reads a complete immutable %s blob with full provenance',
  async (side) => {
    const sha = side === 'base' ? BASE : HEAD;
    const f = fixture([json(pr()), json(commit(sha)), json(tree([entry()])), json(blob())]);
    const result = await (await ready(f)).readFile({ side, path: 'uv.lock' });
    expect(result).toMatchObject({
      kind: 'available',
      side,
      repository,
      commitSha: sha,
      path: 'uv.lock',
      blobSha: BLOB,
    });
    if (result.kind !== 'available') throw new Error('expected bytes');
    expect(new TextDecoder().decode(result.bytes)).toBe('complete lockfile');
    expect(f.fetch.mock.calls.slice(1).map(([url]) => url)).toEqual([
      `https://api.github.com/repos/example/consumer/git/commits/${sha}`,
      `https://api.github.com/repos/example/consumer/git/trees/${TREE}`,
      `https://api.github.com/repos/example/consumer/git/blobs/${BLOB}`,
    ]);
  },
);

test('resolves nested hidden companions and literal percent names through nonrecursive trees', async () => {
  const subtree = 'f'.repeat(40);
  const f = fixture([
    json(pr()),
    json(commit()),
    json(tree([entry('.github', '040000', 'tree', subtree)])),
    json(tree([entry('100%20.yml')], subtree)),
    json(blob()),
  ]);
  expect(
    await (await ready(f)).readFile({ side: 'base', path: '.github/100%20.yml' }),
  ).toMatchObject({ kind: 'available', path: '.github/100%20.yml' });
  expect(
    f.fetch.mock.calls.every(([url]) => !url.includes('recursive') && !url.includes('100%')),
  ).toBe(true);
});

test('keeps zero bytes, proven absence, and failed tree lookup distinct', async () => {
  const empty = fixture([
    json(pr()),
    json(commit()),
    json(tree([entry()])),
    json(blob(new Uint8Array())),
  ]);
  const result = await (await ready(empty)).readFile({ side: 'base', path: 'uv.lock' });
  expect(result).toMatchObject({ kind: 'available', bytes: new Uint8Array() });
  const absent = fixture([json(pr()), json(commit()), json(tree([]))]);
  expect(await (await ready(absent)).readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'absent',
    treeSha: TREE,
  });
  const failed = fixture([json(pr()), json(commit()), json({}, 404)]);
  expect(await (await ready(failed)).readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'unavailable',
    reason: 'missing',
  });
});

test.each([
  '/absolute',
  '../up',
  'a/../up',
  'a//b',
  'a\\b',
  'a/./b',
  'https://attacker.invalid',
  'bad\nname',
  'a'.repeat(1025),
  '',
])('rejects unsafe file path %j without a file request', async (path) => {
  const f = fixture();
  const session = await ready(f);
  expect(await session.readFile({ side: 'base', path })).toEqual({ kind: 'invalid' });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ['120000', 'blob'],
  ['160000', 'commit'],
  ['040000', 'tree'],
  ['100600', 'blob'],
])('refuses a nonregular file %s %s', async (mode, type) => {
  const f = fixture([json(pr()), json(commit()), json(tree([entry('uv.lock', mode, type)]))]);
  expect(await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'unavailable',
    reason: 'unsupported',
  });
  expect(f.fetch).toHaveBeenCalledTimes(3);
});

test.each([
  ['backslash name', entry('foo\\bar')],
  ['unlisted mode', entry('legacy.txt', '100664')],
  ['duplicate sibling', entry('other.txt')],
])('resolves a requested path beside an unusual sibling: %s', async (_name, sibling) => {
  const siblings = [sibling, sibling];
  const f = fixture([json(pr()), json(commit()), json(tree([...siblings, entry()])), json(blob())]);
  expect(await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'available',
    blobSha: BLOB,
  });
});

test.each([
  ['missing sha', { path: 'other.txt', mode: '100644', type: 'blob' }],
  ['non-record', 'other.txt'],
])('still requires a well-formed sibling listing: %s', async (_name, sibling) => {
  const f = fixture([json(pr()), json(commit()), json(tree([sibling, entry()]))]);
  expect(await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'unavailable',
    reason: 'malformed',
  });
});

test.each([
  'truncated',
  'wrongTree',
  'wrongCommit',
  'duplicate',
  'wrongBlob',
  'wrongSize',
  'encoding',
  'base64',
  'padBits',
])('rejects contradictory or incomplete immutable input: %s', async (problem) => {
  const c = commit();
  const t = tree([entry()]);
  const b = blob();
  if (problem === 'truncated') t.truncated = true;
  if (problem === 'wrongTree') t.sha = HEAD;
  if (problem === 'wrongCommit') c.sha = HEAD;
  if (problem === 'duplicate') t.tree.push(entry());
  if (problem === 'wrongBlob') b.sha = HEAD;
  if (problem === 'wrongSize') b.size++;
  if (problem === 'encoding') b.encoding = 'utf-8';
  if (problem === 'base64') b.content = '@@@@';
  if (problem === 'padBits') {
    b.size = 1;
    b.content = 'Zh==';
  }
  const f = fixture([json(pr()), json(c), json(t), json(b)]);
  const result = await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' });
  expect(result.kind).toBe('unavailable');
  expect(result).not.toHaveProperty('bytes');
});

test('uses fork head identity and never reuses base bytes or buffers for a head read', async () => {
  const fork = { id: 102, owner: 'example', name: 'fork' };
  const current = pr();
  current.head.repo = { id: 102, full_name: 'example/fork' };
  const first = new TextEncoder().encode('base');
  const second = new TextEncoder().encode('head');
  const f = fixture([
    json(current),
    json(commit()),
    json(tree([entry()])),
    json(blob(first)),
    json(commit(HEAD)),
    json(tree([entry()])),
    json(blob(second)),
  ]);
  f.input.binding.headRepository = fork;
  const session = await ready(f);
  const base = await session.readFile({ side: 'base', path: 'uv.lock' });
  const head = await session.readFile({ side: 'head', path: 'uv.lock' });
  expect(head).toMatchObject({ kind: 'available', repository: fork, commitSha: HEAD });
  if (base.kind !== 'available' || head.kind !== 'available')
    throw new Error('expected file bytes');
  base.bytes.fill(0);
  expect(new TextDecoder().decode(head.bytes)).toBe('head');
  expect(f.fetch.mock.calls[4][0]).toBe(
    `https://api.github.com/repos/example/fork/git/commits/${HEAD}`,
  );
});

test.each([3, 4])(
  'accepts exact decoded file budget and rejects overflow at %s bytes',
  async (maxFileBytes) => {
    const f = fixture(
      [
        json(pr()),
        json(commit()),
        json(tree([entry()])),
        json(blob(new TextEncoder().encode('four'))),
      ],
      { maxFileBytes },
    );
    const result = await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' });
    expect(result.kind).toBe(maxFileBytes === 4 ? 'available' : 'unavailable');
    if (maxFileBytes === 3) expect(result).toMatchObject({ reason: 'budget' });
  },
);

test('accepts GitHub newline-wrapped base64 without trimming arbitrary characters', async () => {
  const value = blob(new TextEncoder().encode('four'));
  value.content = `Zm91\ncg==\n`;
  const f = fixture([json(pr()), json(commit()), json(tree([entry()])), json(value)]);
  expect(await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'available',
  });
});

function dependency(name = 'example-package') {
  return {
    change_type: 'added',
    manifest: 'package-lock.json',
    ecosystem: 'npm',
    name,
    version: '1.0.0',
    vulnerabilities: [],
  };
}

test.each([{ records: [] }, { records: [dependency()] }])(
  'preserves bounded comparison records without an inventory claim: %j',
  async ({ records }) => {
    const f = fixture([json(pr()), json(records)]);
    const result = await (await ready(f)).readComparison();
    expect(result).toEqual({
      kind: 'available',
      repository,
      baseSha: BASE,
      headRepository: repository,
      headSha: HEAD,
      mergeBaseSha: BASE,
      records,
      reasons: [],
    });
    expect(f.fetch.mock.calls[1][0]).toBe(
      `https://api.github.com/repos/example/consumer/dependency-graph/compare/${BASE}...${HEAD}`,
    );
    expect(result).not.toHaveProperty('complete');
  },
);

test.each(['malformed', 'entries'])(
  'retains validated comparison prefix on %s',
  async (problem) => {
    const f = fixture([
      json(pr()),
      json([dependency(), problem === 'malformed' ? null : dependency('second')]),
    ]);
    if (problem === 'entries') f.input.limits.maxJsonEntries = 30;
    const result = await (await ready(f)).readComparison();
    expect(result).toMatchObject({
      kind: 'partial',
      records: [dependency()],
      reasons: [problem === 'malformed' ? 'malformed' : 'budget'],
    });
  },
);

test('broken JSON and omitted comparison stay unavailable without records', async () => {
  for (const response of [new Response('[{"name":"valid"},'), json({}), json(null)]) {
    const result = await (await ready(fixture([json(pr()), response]))).readComparison();
    expect(result).toMatchObject({ kind: 'unavailable', records: [], reasons: ['malformed'] });
  }
});

test.each([
  [403, {}, 'unknown'],
  [403, { 'x-ratelimit-remaining': '0' }, 'rate_limit'],
  [403, { 'retry-after': '60' }, 'rate_limit'],
  [403, { 'retry-after': 'nonsense', 'x-ratelimit-remaining': '-1' }, 'unknown'],
  [429, {}, 'rate_limit'],
  [401, {}, 'permission'],
  [404, {}, 'missing'],
] as const)(
  'classifies comparison HTTP %s with validated context %j',
  async (status, headers, reason) => {
    const f = fixture([json(pr()), json({ message: 'untrusted-private-text' }, status, headers)]);
    const result = await (await ready(f)).readComparison();
    expect(result).toMatchObject({ kind: 'unavailable', records: [], reasons: [reason] });
    expect(JSON.stringify(result)).not.toContain('untrusted-private-text');
    expect(f.fetch).toHaveBeenCalledTimes(2);
  },
);

test('recognizes documented permission context without copying its message into results', async () => {
  const f = fixture([json(pr()), json({ message: 'Resource not accessible by integration' }, 403)]);
  expect(await (await ready(f)).readComparison()).toMatchObject({
    kind: 'unavailable',
    reasons: ['permission'],
  });
});

test('comparison failure does not downgrade complete immutable discovery or erase file bytes', async () => {
  const f = fixture([
    json(pr(1)),
    json(pr(1)),
    json([row(1)]),
    json(pr(1)),
    json(commit()),
    json(tree([entry()])),
    json(blob()),
    json({}, 403),
  ]);
  const session = await ready(f);
  const discovery = await session.discoverFiles();
  const file = await session.readFile({ side: 'base', path: 'uv.lock' });
  const comparison = await session.readComparison();
  expect(discovery).toMatchObject({ kind: 'available', complete: true });
  expect(file.kind).toBe('available');
  expect(comparison).toMatchObject({ kind: 'unavailable', reasons: ['unknown'] });
  expect(discovery.complete).toBe(true);
});

test('a broken streamed transfer is truncated evidence, never a successful empty comparison', async () => {
  let step = 0;
  const f = fixture([
    json(pr()),
    new Response(
      new ReadableStream({
        pull(controller) {
          if (step++ === 0) controller.enqueue(new TextEncoder().encode('[{"name":"prefix"}'));
          else controller.error(new Error('synthetic-private-transfer'));
        },
      }),
    ),
  ]);
  const result = await (await ready(f)).readComparison();
  expect(result).toMatchObject({ kind: 'unavailable', records: [], reasons: ['truncated'] });
});

test('page exhaustion stops the entire session without resetting for file reads', async () => {
  const f = fixture(
    [json(pr(101)), json(pr(101)), json(Array.from({ length: 100 }, (_, i) => row(i)))],
    { maxPages: 1 },
  );
  const session = await ready(f);
  expect(await session.discoverFiles()).toMatchObject({ kind: 'partial', reasons: ['budget'] });
  const dispatches = f.fetch.mock.calls.length;
  expect(await session.readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(f.fetch).toHaveBeenCalledTimes(dispatches);
});

test('session deadline rejects idle expiry and a backwards clock without dispatch', async () => {
  for (const now of [limits.totalTimeoutMs, -1]) {
    let time = 0;
    const f = fixture();
    const session = await ready({ ...f, dependencies: { ...f.dependencies, now: () => time } });
    time = now;
    expect(await session.readComparison()).toMatchObject({
      kind: 'unavailable',
      reasons: [now === -1 ? 'unknown' : 'timeout'],
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  }
});

test.each(['maxResponseBytes', 'maxTotalBytes'] as const)(
  'counts UTF-8 streamed bytes at exact %s boundary',
  async (key) => {
    const value = { ...pr(), ignored: 'é😀' };
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    for (const delta of [0, -1]) {
      const patch = {
        [key]: bytes + delta,
        ...(key === 'maxTotalBytes' ? { maxResponseBytes: bytes + delta, maxFileBytes: 1 } : {}),
      };
      const f = fixture([json(value)], patch);
      const result = await createGithubReadSession(f.input, f.dependencies);
      expect(result.kind).toBe(delta === 0 ? 'ready' : 'unavailable');
      if (result.kind === 'ready') result.session.close();
      else expect(result).toEqual({ kind: 'unavailable', reason: 'budget' });
    }
  },
);

test.each([3, 4])(
  'requires final metadata to complete discovery within %s requests',
  async (maxRequests) => {
    const f = fixture([json(pr(1)), json(pr(1)), json([row(1)]), json(pr(1))], { maxRequests });
    const result = await (await ready(f)).discoverFiles();
    expect(result.kind).toBe(maxRequests === 4 ? 'available' : 'partial');
    expect(f.fetch).toHaveBeenCalledTimes(maxRequests);
  },
);

test.each([1, 2])('accepts exact file entry count and rejects one beyond %s', async (maxFiles) => {
  const f = fixture([json(pr(2)), json(pr(2)), json([row(1), row(2)]), json(pr(2))], { maxFiles });
  const result = await (await ready(f)).discoverFiles();
  expect(result.kind).toBe(maxFiles === 2 ? 'available' : 'partial');
  expect(result.files).toHaveLength(maxFiles);
});

test('retained results share a cumulative byte budget with exact UTF-8 accounting', async () => {
  const sample = fixture([json(pr()), json([dependency('é😀')])]);
  const output = await (await ready(sample)).readComparison();
  const exact =
    Buffer.byteLength(JSON.stringify({ binding }), 'utf8') +
    Buffer.byteLength(JSON.stringify(output), 'utf8');
  for (const delta of [0, -1]) {
    const f = fixture([json(pr()), json([dependency('é😀')]), json([])], {
      maxRetainedBytes: exact + delta,
    });
    const session = await ready(f);
    const first = await session.readComparison();
    expect(first.kind).toBe(delta === 0 ? 'available' : 'unavailable');
    const second = await session.readComparison();
    expect(second).toMatchObject({ kind: 'unavailable', reasons: ['budget'] });
    expect(first.records).toHaveLength(delta === 0 ? 1 : 0);
  }
});

test('HTTP error-body bytes consume the same total budget as later file reads', async () => {
  const metadataBytes = Buffer.byteLength(JSON.stringify(pr()), 'utf8');
  const errorBytes = 500;
  const f = fixture(
    [json(pr()), new Response('x'.repeat(errorBytes), { status: 403 }), json(commit())],
    { maxResponseBytes: 500, maxFileBytes: 1, maxTotalBytes: metadataBytes + errorBytes },
  );
  const session = await ready(f);
  expect(await session.readComparison()).toMatchObject({ reasons: ['unknown'] });
  expect(await session.readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(await session.readComparison()).toMatchObject({ reasons: ['budget'] });
  expect(f.fetch).toHaveBeenCalledTimes(3);
});

test('overlapping operations fail promptly and close aborts an active body', async () => {
  let cancelled = false;
  const f = fixture([
    json(pr()),
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  ]);
  const session = await ready(f);
  const pending = session.readComparison();
  await Promise.resolve();
  await Promise.resolve();
  expect(await session.readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'unavailable',
    reason: 'conflict',
  });
  session.close();
  expect(await pending).toMatchObject({ kind: 'unavailable', reasons: ['budget'] });
  expect(cancelled).toBe(true);
  expect(await session.discoverFiles()).toMatchObject({ kind: 'unavailable', reasons: ['budget'] });
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

test('partial file inventory retains mixed ecosystem paths without authorizing absence', async () => {
  const paths = ['package-lock.json', '.github/workflows/ci.yml', 'nested/uv.lock'];
  const f = fixture([
    json(pr(4)),
    json(pr(4)),
    json([...paths.map((p, i) => row(i, 'modified', p)), null]),
    json(pr(4)),
  ]);
  const result = await (await ready(f)).discoverFiles();
  expect(result).toMatchObject({ kind: 'partial', complete: false, reasons: ['malformed'] });
  expect(result.files.map((file) => file.path)).toEqual(paths);
  expect(result).not.toHaveProperty('absentEcosystems');
});

test.each([25, 26])(
  'accepts exact cumulative JSON-entry boundary at %s',
  async (maxJsonEntries) => {
    const f = fixture([json(pr()), json([dependency()])], { maxJsonEntries });
    const result = await (await ready(f)).readComparison();
    expect(result.kind).toBe(maxJsonEntries === 26 ? 'available' : 'unavailable');
    if (maxJsonEntries === 25) expect(result.reasons).toEqual(['budget']);
  },
);

test('retention overflow preserves only the prefix that fits and stops later dispatch', async () => {
  const first = { path: 'file-1.json', previousPath: null, status: 'modified', blobSha: TREE };
  const expected = {
    kind: 'partial',
    binding,
    files: [first],
    complete: false,
    reasons: ['budget'],
  };
  const maxRetainedBytes =
    Buffer.byteLength(JSON.stringify({ binding }), 'utf8') +
    Buffer.byteLength(JSON.stringify(expected), 'utf8');
  const f = fixture([json(pr(2)), json(pr(2)), json([row(1), row(2)]), json(pr(2))], {
    maxRetainedBytes,
  });
  const session = await ready(f);
  expect(await session.discoverFiles()).toEqual(expected);
  expect(await session.readComparison()).toMatchObject({
    kind: 'unavailable',
    reasons: ['budget'],
  });
  expect(f.fetch).toHaveBeenCalledTimes(4);
});

test('decoded bytes and metadata both count against cumulative retention', async () => {
  const sample = fixture([json(pr()), json(commit()), json(tree([entry()])), json(blob())]);
  const result = await (await ready(sample)).readFile({ side: 'base', path: 'uv.lock' });
  if (result.kind !== 'available') throw new Error('expected bytes');
  const { bytes, ...metadata } = result;
  const exact =
    Buffer.byteLength(JSON.stringify({ binding }), 'utf8') +
    Buffer.byteLength(JSON.stringify(metadata), 'utf8') +
    bytes.byteLength;
  for (const delta of [0, -1]) {
    const f = fixture([json(pr()), json(commit()), json(tree([entry()])), json(blob())], {
      maxRetainedBytes: exact + delta,
    });
    const output = await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' });
    expect(output.kind).toBe(delta === 0 ? 'available' : 'unavailable');
    if (delta === -1) expect(output).toMatchObject({ reason: 'budget' });
  }
});

test('total deadline shortens the last request and does not wait for its full timeout', async () => {
  vi.useFakeTimers();
  try {
    let time = 0;
    const f = fixture([json(pr()), new Response(new ReadableStream())]);
    const session = await ready({ ...f, dependencies: { ...f.dependencies, now: () => time } });
    time = limits.totalTimeoutMs - 100;
    const pending = session.readComparison();
    await vi.advanceTimersByTimeAsync(99);
    expect(f.fetch.mock.calls[1][1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: 'unavailable', reasons: ['timeout'] });
    expect(f.fetch.mock.calls[1][1].signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('rejects contradictory last/next pagination hints in either header order', async () => {
  const path = 'https://api.github.com/repos/example/consumer/pulls/42/files?per_page=100&page=';
  const hints = [`<${path}1>; rel="last"`, `<${path}2>; rel="next"`];
  for (const values of [hints, [...hints].reverse()]) {
    const f = fixture([
      json(pr(100)),
      json(pr(100)),
      json(
        Array.from({ length: 100 }, (_, i) => row(i)),
        200,
        { link: values.join(', ') },
      ),
      json(pr(100)),
    ]);
    expect(await (await ready(f)).discoverFiles()).toMatchObject({
      kind: 'partial',
      reasons: ['conflict'],
    });
    expect(f.fetch).toHaveBeenCalledTimes(4);
  }
});

test('large valid caller durations use bounded platform timer intervals', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  try {
    const f = fixture([json(pr())], {
      requestTimeoutMs: 2 ** 31 + 10,
      totalTimeoutMs: 2 ** 31 + 20,
    });
    const session = await ready(f);
    expect(
      timeout.mock.calls.every((call) => typeof call[1] === 'number' && call[1] <= 2 ** 31 - 1),
    ).toBe(true);
    session.close();
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

test('rejects a full-length-looking object SHA with a trailing newline before dependent reads', async () => {
  const f = fixture([json(pr()), json(commit(BASE, `${TREE}\n`))]);
  expect(await (await ready(f)).readFile({ side: 'base', path: 'uv.lock' })).toMatchObject({
    kind: 'unavailable',
    reason: 'malformed',
  });
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

test('decoded error responses also consume the cumulative JSON-entry budget', async () => {
  const f = fixture(
    [json(pr()), json({ message: 'Resource not accessible by integration', ignored: [1] }, 403)],
    { maxJsonEntries: 20 },
  );
  expect(await (await ready(f)).readComparison()).toMatchObject({
    kind: 'unavailable',
    reasons: ['budget'],
  });
});

test('cancels an unexpected redirected response body without reading or following it', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  Object.defineProperty(response, 'redirected', { value: true });
  const f = fixture([response]);
  expect(await createGithubReadSession(f.input, f.dependencies)).toEqual({
    kind: 'unavailable',
    reason: 'unknown',
  });
  expect(cancelled).toBe(true);
});

test('an observed clock deadline aborts the transport before its scheduled timer fires', async () => {
  let time = 0;
  const f = fixture([json(pr()), json([])]);
  const session = await ready({ ...f, dependencies: { ...f.dependencies, now: () => time } });
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    time = limits.totalTimeoutMs;
    return original(url, init);
  });
  expect(await session.readComparison()).toMatchObject({
    kind: 'unavailable',
    reasons: ['timeout'],
  });
  expect(f.fetch.mock.calls[1][1].signal?.aborted).toBe(true);
});

test('deep JSON that cannot be serialized stays an explicit comparison limit', async () => {
  const text = `[${JSON.stringify(dependency())},{"nested":${'['.repeat(12000)}0${']'.repeat(12000)}}]`;
  const f = fixture([json(pr()), new Response(text)]);
  expect(await (await ready(f)).readComparison()).toMatchObject({
    kind: 'partial',
    records: [dependency()],
    reasons: ['unsupported'],
  });
});
