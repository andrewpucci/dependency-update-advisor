import { expect, test } from 'vite-plus/test';
import { collectAdvisoryNpm, collectAdvisoryUv } from '../../tests/parity/advisories.js';
import { enrichUpstream } from './upstream.js';
import { createUpstreamReader } from './upstream-read.js';

const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const limits = {
  maxRequests: 30,
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
async function fixture() {
  const f = await collectAdvisoryNpm('empty', 1);
  const inventory = structuredClone(f.inventory);
  for (const root of inventory.roots)
    for (const side of [root.base, root.head])
      for (const node of Object.values(side.packages))
        if (node.instance) (node as { integrity: string | null }).integrity = integrity;
  return {
    binding: inventory.binding,
    changes: inventory.changes,
    sources: inventory.sources,
    findings: [],
    npmInventory: inventory,
    limits,
  };
}
function reader() {
  const calls: string[] = [];
  const r = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      calls.push(url);
      const parts = new URL(url).pathname.split('/').map(decodeURIComponent);
      return Response.json({
        _id: parts[1] + '@' + parts[2],
        name: parts[1],
        version: parts[2],
        dist: { integrity },
        description: 'Exact version description.',
      });
    },
  });
  if (r.kind !== 'ready') throw new Error('reader');
  return { ...r, calls };
}
test('actual N1 roots produce both-side S1 proofs while metadata stays partial', async () => {
  const input = await fixture(),
    r = reader();
  const result = await enrichUpstream(input, { reader: r.reader });
  expect(result.kind).toBe('enriched');
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result.changes.map((c) => c.id)).toEqual(input.changes.map((c) => c.id));
  expect(result.publicIdentities.length).toBeGreaterThan(0);
  expect(result.publicIdentities.some((p) => p.side === 'base')).toBe(true);
  expect(result.publicIdentities.some((p) => p.side === 'head')).toBe(true);
  expect(result.changes.every((c) => c.evidence.upstream.status === 'partial')).toBe(true);
  expect(
    result.publicIdentities.every((p) =>
      p.sourceIds.every((id) =>
        result.sources.some((s) => s.id === id && s.status === 'available'),
      ),
    ),
  ).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
  expect(input.changes[0].evidence.upstream.status).toBe('unavailable');
  r.reader.close();
});
test('bad bindings or detached npm nodes cannot authorize requests', async () => {
  const input = await fixture(),
    r = reader();
  expect(await enrichUpstream({ ...input, binding: {} }, { reader: r.reader })).toEqual({
    kind: 'invalid',
  });
  const bad = {
    ...input,
    npmInventory: { ...input.npmInventory, binding: { ...input.binding, headSha: 'e'.repeat(40) } },
  };
  expect(await enrichUpstream(bad, { reader: r.reader })).toEqual({ kind: 'invalid' });
  expect(r.calls).toHaveLength(0);
  r.reader.close();
});

test('real U1/U2 supplies PyPI proofs without losing uv side identity', async () => {
  const f = await collectAdvisoryUv();
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      const parts = new URL(url).pathname.split('/').map(decodeURIComponent);
      return Response.json({
        info: { name: parts[2], version: parts[3], description: 'Version metadata.' },
      });
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const result = await enrichUpstream(
    { ...f.input, sources: f.input.sources.filter((s) => !s.id.startsWith('proof:')), limits },
    opened,
  );
  expect(result.kind).toBe('enriched');
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result.publicIdentities).toHaveLength(2);
  expect(result.publicIdentities.every((p) => p.ecosystem === 'uv')).toBe(true);
  expect(result.changes.map((c) => [c.from, c.to])).toEqual(
    f.input.changes.map((c) => [c.from, c.to]),
  );
  opened.reader.close();
});
