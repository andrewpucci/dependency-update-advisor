import { expect, test } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import { createUpstreamReader } from './upstream-read.js';
import { collectTargetRelease, resolveUpstreamRef } from './upstream-github.js';

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
      return path in data ? Response.json(data[path]) : Response.json({}, { status: 404 });
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
