import { expect, test } from 'vite-plus/test';
import { collectActionResearch } from './upstream-actions.js';
import { createUpstreamReader } from './upstream-read.js';
import type { PacketChange, ActionsSide } from '../schema.js';
import { collectAdvisoryActions } from '../../tests/parity/advisories.js';
import { enrichUpstream } from './upstream.js';
import { enrichAdvisories } from './advisories.js';
import { createAdvisoryReader } from './advisory-read.js';

const sha = 'a'.repeat(40);
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
function fixture(action = 'fixture/action', ref = sha, moved = false, versions = ['v1.2.3']) {
  let observed = 0;
  const calls: string[] = [];
  const r = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      calls.push(url);
      const path = new URL(url).pathname.replace('/repos/fixture/action', '');
      if (!path) return Response.json({ private: false, full_name: 'fixture/action' });
      if (path === '/commits/' + sha) return Response.json({ sha });
      if (path === '/git/ref/heads/main')
        return Response.json({
          ref: 'refs/heads/main',
          object: { type: 'commit', sha: moved && ++observed > 1 ? 'b'.repeat(40) : sha },
        });
      if (path === '/releases')
        return Response.json(
          versions.map((tag_name, i) => ({
            id: i + 1,
            tag_name,
            draft: false,
            published_at: '2026-10-01T00:00:00Z',
            name: tag_name,
            body: 'Release notes.',
            html_url: 'https://github.com/fixture/action/releases/tag/' + tag_name,
          })),
        );
      const tag = path.split('/git/ref/tags/')[1];
      if (versions.includes(tag))
        return Response.json({ ref: 'refs/tags/' + tag, object: { type: 'commit', sha } });
      return Response.json({}, { status: 404 });
    },
  });
  if (r.kind !== 'ready') throw new Error('reader');
  const to = {
    workflow: '.github/workflows/ci.yml',
    jobId: 'test',
    stepIndex: 0,
    action,
    ref,
    refKind: ref === sha ? 'sha' : 'branch',
    sourceId: 'file',
  };
  const change = {
    id: 'action',
    ecosystem: 'actions',
    kind: 'addition',
    role: 'direct',
    from: null,
    to,
    evidence: { upstream: { status: 'unavailable', reasons: ['missing'], sourceIds: [] } },
  } as PacketChange;
  return { ...r, change, calls };
}
test('a full SHA gains a version only from an exact release-tag commit match', async () => {
  const f = fixture();
  const result = await collectActionResearch(f.change, f.reader);
  expect(result.mappings).toHaveLength(1);
  expect(result.mappings[0]).toMatchObject({
    side: 'head',
    action: 'fixture/action',
    ref: sha,
    version: '1.2.3',
  });
  expect(f.change.to && 'ref' in f.change.to && f.change.to.ref).toBe(sha);
  f.reader.close();
});
test.each(['fixture/action/subdir', 'fixture/action/.github/workflows/reuse.yml'])(
  'root releases cannot establish component mapping for %s',
  async (action) => {
    const f = fixture(action);
    expect((await collectActionResearch(f.change, f.reader)).mappings).toHaveLength(0);
    f.reader.close();
  },
);
test('several concrete versions at one commit remain ambiguous', async () => {
  const f = fixture('fixture/action', sha, false, ['v1.2.3', 'v1.2.4']);
  expect((await collectActionResearch(f.change, f.reader)).mappings).toHaveLength(0);
  f.reader.close();
});
test('a branch moving during mapping invalidates the proof', async () => {
  const f = fixture('fixture/action', 'main', true);
  expect((await collectActionResearch(f.change, f.reader)).mappings).toHaveLength(0);
  f.reader.close();
});

test('tag/branch collisions cannot establish a mapping', async () => {
  const f = fixture('fixture/action', 'main', false, ['main', 'v1.2.3']);
  expect((await collectActionResearch(f.change, f.reader)).mappings).toHaveLength(0);
  f.reader.close();
});
test('actual X1 -> S2 mappings satisfy the existing S1 handoff', async () => {
  const f = await collectAdvisoryActions(false);
  const selected = f.input.changes.find(
    (c) => c.to && 'action' in c.to && c.to.action === 'voidzero-dev/setup-vp',
  );
  if (!selected) throw new Error('inventory');
  const input = {
    ...f.input,
    changes: [selected],
    sources: f.input.sources.map((s) => ({
      ...s,
      memberIds: s.memberIds.filter((id) => id === selected.id),
    })),
  };
  const action = selected.to;
  if (!action || !('action' in action)) throw new Error('Actions');
  const repository = action.action;
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace('/repos/' + repository, '');
      if (!path) return Response.json({ private: false, full_name: repository });
      if (path.startsWith('/commits/')) return Response.json({ sha: path.split('/').at(-1) });
      if (path === '/releases')
        return Response.json(
          ['v1.0.0', 'v2.0.0'].map((tag_name, i) => ({
            id: i + 1,
            tag_name,
            draft: false,
            published_at: '2026-10-01T00:00:00Z',
            body: 'Notes.',
            name: tag_name,
            html_url: 'https://github.com/' + repository + '/releases/tag/' + tag_name,
          })),
        );
      const tag = path.split('/git/ref/tags/')[1];
      if (tag === 'v1.0.0' || tag === 'v2.0.0')
        return Response.json({
          ref: 'refs/tags/' + tag,
          object: { type: 'commit', sha: (tag === 'v1.0.0' ? '1' : '2').repeat(40) },
        });
      return Response.json({}, { status: 404 });
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream({ ...input, limits }, opened);
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  expect(upstream.actionVersions).toHaveLength(2);
  const baseRef = selected.from && 'ref' in selected.from ? selected.from.ref : '';
  const baseAttempt = upstream.attempts.find(
    (a) => a.stage === 'mapping' && a.target.endsWith('@' + baseRef),
  );
  expect(baseAttempt?.side).toBe('base');
  expect(baseAttempt?.sourceIds.length).toBeGreaterThan(0);
  const queries: string[] = [];
  const advisory = createAdvisoryReader(f.input.limits, {
    now: () => 0,
    fetch: async (url) => {
      queries.push(url);
      return Response.json([]);
    },
  });
  if (advisory.kind !== 'ready') throw new Error('reader');
  const result = await enrichAdvisories(
    {
      ...input,
      changes: upstream.changes,
      sources: upstream.sources,
      actionVersions: upstream.actionVersions,
    },
    { reader: advisory },
  );
  expect(result.kind, JSON.stringify(result)).toBe('enriched');
  expect(queries.some((q) => new URL(q).searchParams.get('affects')?.endsWith('@2.0.0'))).toBe(
    true,
  );
  expect(queries.some((q) => new URL(q).searchParams.get('affects')?.endsWith('@1.0.0'))).toBe(
    true,
  );
  if (result.kind === 'enriched')
    expect(result.changes[0].evidence.vulnerability.status).toBe('available');
  advisory.close();
  opened.reader.close();
});
test('a selected release tag moving during another side invalidates the earlier mapping', async () => {
  const base = 'c'.repeat(40),
    head = 'd'.repeat(40);
  let moved = false;
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace('/repos/fixture/action', '');
      if (!path) return Response.json({ private: false, full_name: 'fixture/action' });
      if (path.startsWith('/commits/')) {
        const commit = path.split('/').at(-1);
        if (commit === head) moved = true;
        return Response.json({ sha: commit });
      }
      if (path === '/releases')
        return Response.json(
          ['v1.0.0', 'v2.0.0'].map((tag_name, i) => ({
            id: i + 1,
            tag_name,
            draft: false,
            published_at: '2026-10-01T00:00:00Z',
            body: 'Notes',
            html_url: 'https://github.com/fixture/action/releases/tag/' + tag_name,
          })),
        );
      const tag = path.split('/git/ref/tags/')[1];
      if (tag)
        return Response.json({
          ref: 'refs/tags/' + tag,
          object: {
            type: 'commit',
            sha: tag === 'v1.0.0' ? (moved ? 'e'.repeat(40) : base) : head,
          },
        });
      return Response.json({}, { status: 404 });
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const side = (ref: string): ActionsSide => ({
    workflow: '.github/workflows/ci.yml',
    jobId: 'job',
    stepIndex: 0,
    sourceId: 'file',
    action: 'fixture/action',
    ref,
    refKind: 'sha',
  });
  const change: PacketChange = {
    id: 'action',
    ecosystem: 'actions',
    kind: 'update',
    role: 'direct',
    from: side(base),
    to: side(head),
    evidence: {},
  };
  const result = await collectActionResearch(change, opened.reader);
  expect(result.mappings.some((m) => m.side === 'base')).toBe(false);
  expect(result.mappings.some((m) => m.side === 'head')).toBe(true);
  opened.reader.close();
});
test('base branch movement during comparison invalidates its applicable ref range', async () => {
  const base = 'a'.repeat(40),
    head = 'b'.repeat(40);
  let moved = false;
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace('/repos/fixture/action', '');
      if (!path) return Response.json({ private: false, full_name: 'fixture/action' });
      if (path === '/git/ref/heads/main')
        return Response.json({
          ref: 'refs/heads/main',
          object: { type: 'commit', sha: moved ? 'c'.repeat(40) : base },
        });
      if (path === '/commits/' + head) return Response.json({ sha: head });
      if (path === '/releases') return Response.json([]);
      if (path.startsWith('/compare/')) {
        moved = true;
        return Response.json({
          base_commit: { sha: base },
          merge_base_commit: { sha: base },
          status: 'ahead',
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          commits: [{ sha: head, commit: { message: 'Change' } }],
          files: [{ filename: 'index.js', patch: '@@\n+change' }],
        });
      }
      return Response.json({}, { status: 404 });
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const side = (ref: string, refKind: ActionsSide['refKind']): ActionsSide => ({
    action: 'fixture/action',
    ref,
    refKind,
    workflow: '.github/workflows/ci.yml',
    jobId: 'job',
    stepIndex: 0,
    sourceId: 'file',
  });
  const result = await collectActionResearch(
    {
      id: 'action',
      ecosystem: 'actions',
      kind: 'update',
      role: 'direct',
      from: side('main', 'branch'),
      to: side(head, 'sha'),
      evidence: {},
    },
    opened.reader,
  );
  expect(result.research.status).toBe('partial');
  expect(result.research.sources[0].range).toBeNull();
  opened.reader.close();
});
