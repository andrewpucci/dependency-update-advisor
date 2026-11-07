import { createHash } from 'node:crypto';
import { expect, test } from 'vite-plus/test';
import { createUpstreamReader } from './upstream-read.js';
import { collectRangeFallback, collectChangelog } from './upstream-range.js';

const limits = {
  maxRequests: 100,
  maxPages: 20,
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
const metadata = { repository: { url: 'https://github.com/fixture/orbit' } };
const before = { ecosystem: 'npm' as const, name: 'orbit', version: '1.0.0', metadata };
const after = { ...before, version: '2.0.0' };
function file(text: string) {
  const bytes = Buffer.from(text);
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
function fixture() {
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      const u = new URL(url),
        path = u.pathname.replace('/repos/fixture/orbit', '');
      if (!path) return Response.json({ private: false, full_name: 'fixture/orbit' });
      if (path === '/releases')
        return Response.json(
          ['v1.0.0', 'v1.5.0', 'v3.0.0'].map((tag_name, i) => ({
            id: i + 1,
            tag_name,
            draft: false,
            published_at: '2026-10-01T00:00:00Z',
            name: tag_name,
            body: 'Intermediate notes.',
            html_url: 'https://github.com/fixture/orbit/releases/tag/' + tag_name,
          })),
        );
      const tag = path.split('/git/ref/tags/')[1];
      if (tag === 'v1.5.0' || tag === 'v2.0.0')
        return Response.json({
          ref: 'refs/tags/' + tag,
          object: { type: 'commit', sha: (tag === 'v1.5.0' ? 'd' : 'a').repeat(40) },
        });
      if (path === '/contents/package.json')
        return Response.json(
          file(
            JSON.stringify({
              name: 'orbit',
              version: u.searchParams.get('ref') === 'd'.repeat(40) ? '1.5.0' : '2.0.0',
            }),
          ),
        );
      if (path === '/contents/CHANGELOG.md')
        return Response.json(file('# Changes\nUnscoped historical changelog.'));
      return Response.json({}, { status: 404 });
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  return opened;
}
test('intermediate releases retain native ranges without inventing target coverage', async () => {
  const f = fixture();
  const result = await collectRangeFallback(before, after, f.reader);
  expect(result.status).toBe('partial');
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].range).toBeNull();
  expect(result.attempts.some((a) => a.range?.from === '1.5.0' && a.range.to === '1.5.0')).toBe(
    true,
  );
  expect(result.sources[0].text).toContain('context');
  f.reader.close();
});
test('changelog fallback is bound to an established full commit and stays partial', async () => {
  const f = fixture();
  const result = await collectChangelog(after, f.reader);
  expect(result.status).toBe('partial');
  expect(result.sources[0].url).toContain('/blob/' + 'a'.repeat(40) + '/CHANGELOG.md');
  expect(result.sources[0].range).toBeNull();
  f.reader.close();
});
test('downgrades cannot reuse upgrade release intervals', async () => {
  const f = fixture();
  expect((await collectRangeFallback(after, before, f.reader)).status).toBe('unavailable');
  f.reader.close();
});
