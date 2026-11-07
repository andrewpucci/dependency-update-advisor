import { expect, test } from 'vite-plus/test';
import { enrichPolicySignals } from './policy-signals.js';
import { attachActionInventoryFindings } from './policy-signals-actions.js';
import { createMalwareReader } from './advisory-read.js';
import { createUpstreamReader } from './upstream-read.js';
import { enrichUpstream } from './upstream.js';
import { upstreamScenario, upstreamTestLimits } from '../../tests/parity/upstream.js';
import { validateReviewPacket } from '../schema.js';
import type { PacketChange } from '../schema.js';
import type { SignalEnrichment, PolicySignalInput } from './policy-signals.js';

test.each(['earliest', 'future', 'failed-page', 'moved', 'unmapped'])(
  'Actions %s release evidence preserves exact refs and optional failure',
  async (mode) => {
    const f = await upstreamScenario();
    const ur = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
    if (ur.kind !== 'ready') throw new Error('reader');
    const upstream = await enrichUpstream(f.input, ur);
    ur.reader.close();
    if (upstream.kind !== 'enriched') throw new Error('upstream');
    let tagReads = 0;
    const reader = createUpstreamReader(upstreamTestLimits, {
      now: () => 0,
      fetch: async (url, init) => {
        const u = new URL(url),
          tail = u.pathname.split('/').slice(4).join('/');
        if (tail === 'releases') {
          if (u.searchParams.get('page') === '2') return Response.json({}, { status: 503 });
          const releases = [
            {
              id: 2,
              tag_name: 'v2.0.0',
              draft: false,
              published_at: '2026-11-01T00:00:00Z',
              html_url: 'https://github.com/fixture/action/releases/tag/v2.0.0',
            },
            {
              id: 3,
              tag_name: '2.0.0',
              draft: false,
              published_at: mode === 'future' ? '2099-01-01T00:00:00Z' : '2026-10-01T00:00:00Z',
              html_url: 'https://github.com/fixture/action/releases/tag/2.0.0',
            },
          ];
          const repo = u.pathname.split('/').slice(2, 4).join('/');
          releases.forEach((r) => {
            r.html_url = `https://github.com/${repo}/releases/tag/${r.tag_name}`;
          });
          const next = new URL(url);
          next.searchParams.set('page', '2');
          return Response.json(releases, {
            headers: mode === 'failed-page' ? { link: `<${next}>; rel="next"` } : {},
          });
        }
        if (tail === 'git/ref/tags/2.0.0') {
          tagReads++;
          return Response.json({
            ref: 'refs/tags/2.0.0',
            object: {
              type: 'commit',
              sha: (mode === 'moved' && tagReads > 1 ? '3' : '2').repeat(40),
            },
          });
        }
        return f.fetch(url, init);
      },
    });
    const malware = createMalwareReader(f.advisoryLimits, {
      now: () => 0,
      fetch: async () => Response.json([]),
    });
    if (reader.kind !== 'ready' || malware.kind !== 'ready') throw new Error('reader');
    const input = {
      ...upstream,
      actionVersions: mode === 'unmapped' ? [] : upstream.actionVersions,
      evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
      limits: { ...f.advisoryLimits, maxAttempts: 1000 },
    };
    const out = await enrichPolicySignals(input, {
      malwareReader: malware,
      upstreamReader: reader.reader,
    });
    malware.close();
    reader.reader.close();
    if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
    const action = out.changes.find((c) => c.ecosystem === 'actions')!;
    expect(action.evidence.publishTime.status).toBe(
      mode === 'earliest' ? 'available' : 'unavailable',
    );
    if (mode === 'earliest') {
      const fact = out.findings.find(
        (f) => f.memberId === action.id && f.kind === 'releaseMetadata',
      );
      expect(fact).toMatchObject({ publishedAt: Date.parse('2026-10-01T00:00:00Z') });
      const source = out.sources.find((s) => s.id === action.evidence.publishTime.sourceIds[0]);
      expect(source?.provenance).toMatchObject({ excerpt: expect.stringContaining('2.0.0') });
    }
    expect(action.from).toEqual(upstream.changes.find((c) => c.id === action.id)?.from);
    expect(action.to).toEqual(upstream.changes.find((c) => c.id === action.id)?.to);
    const packet = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes: out.changes,
        sources: out.sources,
        findings: out.findings,
        coverage: f.coverage,
        relationships: f.relationships,
      },
      f.expected,
    );
    expect(packet.ok, JSON.stringify(packet)).toBe(true);
  },
);
test.each(['owner', 'mutable', 'sha', 'subpath', 'addition'])(
  'immutable %s Actions occurrences produce only contracted inventory findings',
  async (mode) => {
    const f = await upstreamScenario();
    const c = structuredClone(
      f.input.changes.find((c) => c.ecosystem === 'actions')!,
    ) as PacketChange;
    if (c.ecosystem !== 'actions' || !c.from || !c.to) throw new Error('action');
    if (mode === 'owner') c.to.action = 'new-owner/new-repo';
    if (mode === 'mutable') {
      c.to.ref = 'v2';
      c.to.refKind = 'tag';
    }
    if (mode === 'subpath') c.to.action += '/component';
    if (mode === 'addition') {
      c.from = null;
      c.kind = 'addition';
    }
    const input = {
      ...f.input,
      evaluationTime: 0,
      limits: { ...f.advisoryLimits, maxAttempts: 100 },
    } as PolicySignalInput;
    const out: SignalEnrichment = {
      kind: 'enriched',
      binding: input.binding,
      changes: [c],
      sources: structuredClone(input.sources) as SignalEnrichment['sources'],
      findings: [],
      attempts: [],
    };
    attachActionInventoryFindings(input, out, c);
    expect(out.findings.map((f) => (f.kind === 'supplyChainChange' ? f.change : f.kind))).toEqual(
      mode === 'owner' ? ['action_identity'] : mode === 'mutable' ? ['mutable_action_ref'] : [],
    );
  },
);
