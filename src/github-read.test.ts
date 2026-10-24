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
