import { expect, test } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import { createUpstreamReader } from './upstream-read.js';
import {
  collectTargetRelease,
  resolveUpstreamRef,
  collectExactComparison,
} from './upstream-github.js';

const sha = 'a'.repeat(40);
const limits = {
  maxRequests: 50,
  maxPages: 10,
  maxTagCandidates: 20,
  maxTagDepth: 5,
  maxResponseBytes: 50_000,
  maxTotalBytes: 500_000,
  maxJsonEntries: 100_000,
  maxJsonDepth: 64,
  maxWork: 200_000,
  maxRetainedBytes: 1_000_000,
  maxAttempts: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const target = {
  ecosystem: 'npm' as const,
  name: 'orbit',
  version: '2.0.0',
  metadata: { repository: { url: 'https://github.com/fixture/orbit.git' } },
};
function file(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    type: 'file',
    encoding: 'base64',
    content: bytes.toString('base64'),
    sha: createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex'),
  };
}
function setup(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      calls.push(url);
      const path = new URL(url).pathname.replace('/repos/fixture/orbit', '');
      const data: Record<string, unknown> = {
        '': { full_name: 'fixture/orbit', private: false },
        '/git/ref/tags/v2.0.0': { ref: 'refs/tags/v2.0.0', object: { type: 'commit', sha } },
        '/contents/package.json': file({ name: 'orbit', version: '2.0.0' }),
        '/releases/tags/v2.0.0': {
          id: 1,
          tag_name: 'v2.0.0',
          draft: false,
          published_at: '2026-10-01T00:00:00Z',
          html_url: 'https://github.com/fixture/orbit/releases/tag/v2.0.0',
          name: 'Orbit 2.0.0',
          body: 'Exact target notes.',
        },
        ...overrides,
      };
      const value = typeof data[path] === 'function' ? data[path](url) : data[path];
      if (value instanceof Response) return value;
      return path in data ? Response.json(value) : Response.json({}, { status: 404 });
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  return { ...opened, calls };
}
test('target notes require exact immutable package correspondence', async () => {
  const f = setup();
  const result = await collectTargetRelease(target, f.reader);
  expect(result.status).toBe('available');
  expect(result.sources[0]).toMatchObject({ kind: 'release', range: { from: null, to: '2.0.0' } });
  expect(result.sources[0].text).toContain('Exact target notes.');
  expect(f.calls.filter((url) => url.includes('/git/ref/'))).toHaveLength(2);
  f.reader.close();
});
test('a matching tag in another monorepo component cannot supply notes', async () => {
  const f = setup({
    '/contents/package.json': file({ name: 'other-component', version: '2.0.0' }),
  });
  expect((await collectTargetRelease(target, f.reader)).status).toBe('unavailable');
  expect(f.calls.some((url) => url.includes('/releases/tags/'))).toBe(false);
  f.reader.close();
});
test('annotated tag cycles are bounded and never become commit proofs', async () => {
  const f = setup({
    '/git/ref/tags/v2.0.0': { ref: 'refs/tags/v2.0.0', object: { type: 'tag', sha } },
    ['/git/tags/' + sha]: { sha, object: { type: 'tag', sha } },
  });
  expect((await resolveUpstreamRef('fixture/orbit', 'tags/v2.0.0', f.reader)).status).toBe(
    'unavailable',
  );
  f.reader.close();
});
test.each([{ body: '' }, { draft: true }, { tag_name: 'v9.0.0' }])(
  'invalid release content cannot become reviewed evidence (%j)',
  async (override) => {
    const f = setup({
      '/releases/tags/v2.0.0': {
        id: 1,
        tag_name: 'v2.0.0',
        draft: false,
        published_at: '2026-10-01T00:00:00Z',
        html_url: 'https://github.com/fixture/orbit/releases/tag/v2.0.0',
        name: 'Orbit 2.0.0',
        body: 'Notes',
        ...override,
      },
    });
    expect((await collectTargetRelease(target, f.reader)).status).toBe('unavailable');
    f.reader.close();
  },
);

test('complete comparison retains exact direction and reviewed commits', async () => {
  const base = 'c'.repeat(40);
  const f = setup({
    ['/compare/' + base + '...' + sha]: {
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      status: 'ahead',
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      commits: [{ sha, commit: { message: 'Target change' } }],
      files: [{ filename: 'index.js', patch: '@@ change' }],
    },
  });
  const result = await collectExactComparison(
    'fixture/orbit',
    { sha: base, value: '1.0.0' },
    { sha, value: '2.0.0' },
    f.reader,
  );
  expect(result.status).toBe('available');
  expect(result.sources[0]).toMatchObject({ range: { from: '1.0.0', to: '2.0.0' } });
  expect(result.sources[0].text).toContain('Target change');
  f.reader.close();
});
test('a failed comparison continuation preserves earlier commits as partial', async () => {
  const base = 'c'.repeat(40),
    path = '/compare/' + base + '...' + sha;
  const f = setup({
    [path]: (url: string) =>
      new URL(url).searchParams.get('page') === '1'
        ? Response.json(
            {
              base_commit: { sha: base },
              merge_base_commit: { sha: base },
              status: 'ahead',
              ahead_by: 2,
              behind_by: 0,
              total_commits: 2,
              commits: [{ sha: 'd'.repeat(40), commit: { message: 'Earlier retained commit' } }],
              files: [{ filename: 'index.js', patch: '@@ change' }],
            },
            {
              headers: {
                link:
                  '<https://api.github.com/repos/fixture/orbit' +
                  path +
                  '?per_page=100&page=2>; rel="next"',
              },
            },
          )
        : Response.json({}, { status: 500 }),
  });
  const result = await collectExactComparison(
    'fixture/orbit',
    { sha: base, value: '1.0.0' },
    { sha, value: '2.0.0' },
    f.reader,
  );
  expect(result.status).toBe('partial');
  expect(result.sources[0].text).toContain('Earlier retained commit');
  expect(result.reasons.length).toBeGreaterThan(0);
  f.reader.close();
});

test.each(['diverged', 'missing-patch', 'wrong-base', 'hostile-next'])(
  'comparison %s cannot claim complete range coverage',
  async (mode) => {
    const base = 'c'.repeat(40),
      path = '/compare/' + base + '...' + sha;
    const payload = {
      base_commit: { sha: mode === 'wrong-base' ? sha : base },
      merge_base_commit: { sha: mode === 'diverged' ? 'e'.repeat(40) : base },
      status: mode === 'diverged' ? 'diverged' : 'ahead',
      ahead_by: 1,
      behind_by: mode === 'diverged' ? 1 : 0,
      total_commits: 1,
      commits: [{ sha, commit: { message: 'Retained' } }],
      files:
        mode === 'missing-patch'
          ? [{ filename: 'image.png' }]
          : [{ filename: 'index.js', patch: 'change' }],
    };
    const f = setup({
      [path]:
        mode === 'hostile-next'
          ? Response.json(payload, { headers: { link: '<https://evil.example/page>; rel="next"' } })
          : payload,
    });
    const result = await collectExactComparison(
      'fixture/orbit',
      { sha: base, value: '1.0.0' },
      { sha, value: '2.0.0' },
      f.reader,
    );
    expect(result.status).not.toBe('available');
    expect(f.calls.every((url) => new URL(url).hostname === 'api.github.com')).toBe(true);
    f.reader.close();
  },
);
