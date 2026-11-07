import { expect, test } from 'vite-plus/test';
import { collectAdvisoryNpm, collectAdvisoryUv } from '../../tests/parity/advisories.js';
import { enrichUpstream, attachUpstreamResearch } from './upstream.js';
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

test('enrichment is stable and detached when repeated with identical evidence', async () => {
  const input = await fixture(),
    a = reader();
  const first = await enrichUpstream(input, a);
  if (first.kind !== 'enriched') throw new Error('enrichment');
  const b = reader();
  const second = await enrichUpstream(
    { ...input, changes: first.changes, sources: first.sources, findings: first.findings },
    b,
  );
  expect(second).toEqual(first);
  a.reader.close();
  b.reader.close();
});
test('insufficient input retention is an explicit budget outcome', async () => {
  const input = await fixture();
  const constrained = { ...limits, maxRetainedBytes: 1 };
  const r = createUpstreamReader(constrained, {
    now: () => 0,
    fetch: async () => {
      throw new Error('unexpected request');
    },
  });
  if (r.kind !== 'ready') throw new Error('reader');
  expect(await enrichUpstream({ ...input, limits: constrained }, r)).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  r.reader.close();
});

test('independent partial fallbacks retain all earlier category citations', async () => {
  const input = await fixture(),
    r = reader();
  const result = await enrichUpstream(input, r);
  if (result.kind !== 'enriched') throw new Error('enrichment');
  const output = structuredClone(result),
    change = output.changes[0];
  const original = [...change.evidence.upstream.sourceIds];
  for (const suffix of ['range', 'changelog'])
    attachUpstreamResearch(input, output, change, {
      status: 'partial',
      reasons: ['unsupported'],
      attempts: [],
      sources: [
        {
          kind: 'metadata',
          url: 'https://github.com/fixture/orbit/' + suffix,
          title: suffix,
          text: 'Partial context.',
          range: null,
        },
      ],
    });
  expect(change.evidence.upstream.sourceIds).toHaveLength(original.length + 2);
  expect(original.every((id) => change.evidence.upstream.sourceIds.includes(id))).toBe(true);
  r.reader.close();
});
test('malformed category records and getters are rejected before any request', async () => {
  const input = await fixture(),
    r = reader();
  const broken = structuredClone(input);
  delete broken.changes[0].evidence.upstream;
  expect(await enrichUpstream(broken, r)).toEqual({ kind: 'invalid' });
  let invoked = false;
  const accessor = { ...input };
  Object.defineProperty(accessor, 'limits', {
    enumerable: true,
    get() {
      invoked = true;
      return limits;
    },
  });
  expect(await enrichUpstream(accessor, r)).toEqual({ kind: 'invalid' });
  expect(invoked).toBe(false);
  expect(r.calls).toHaveLength(0);
  r.reader.close();
});
test('missing metadata explicitly names the research stages that could not run', async () => {
  const input = await fixture();
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async () => Response.json({}, { status: 404 }),
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const result = await enrichUpstream(input, opened);
  if (result.kind !== 'enriched') throw new Error('enrichment');
  for (const stage of ['release', 'compare', 'range', 'changelog']) {
    expect(result.attempts.some((a) => a.stage === stage && a.outcome === 'skipped')).toBe(true);
  }
  opened.reader.close();
});
test('failed repeat lookups preserve prior upstream citations and coverage', async () => {
  const input = await fixture(),
    good = reader();
  const known = await enrichUpstream(input, good);
  if (known.kind !== 'enriched') throw new Error('enrichment');
  const bad = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async () => Response.json({}, { status: 404 }),
  });
  if (bad.kind !== 'ready') throw new Error('reader');
  const result = await enrichUpstream(
    { ...input, changes: known.changes, sources: known.sources },
    bad,
  );
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result.changes[0].evidence.upstream.sourceIds).toEqual(
    known.changes[0].evidence.upstream.sourceIds,
  );
  expect(result.changes[0].evidence.upstream.status).toBe(
    known.changes[0].evidence.upstream.status,
  );
  good.reader.close();
  bad.reader.close();
});
test('an empty registry description still yields a non-empty metadata excerpt', async () => {
  const f = await collectAdvisoryUv();
  const opened = createUpstreamReader(limits, {
    now: () => 0,
    fetch: async (url) => {
      const parts = new URL(url).pathname.split('/').map(decodeURIComponent);
      return Response.json({ info: { name: parts[2], version: parts[3], description: '' } });
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const result = await enrichUpstream(
    { ...f.input, sources: f.input.sources.filter((s) => !s.id.startsWith('proof:')), limits },
    opened,
  );
  if (result.kind !== 'enriched') throw new Error('enrichment');
  const metadata = result.sources.filter((s) => s.kind === 'metadata' && s.id.startsWith('s2:'));
  expect(metadata.length).toBeGreaterThan(0);
  expect(
    metadata.every((s) => s.provenance.kind === 'upstream' && s.provenance.excerpt.length > 0),
  ).toBe(true);
  opened.reader.close();
});
