import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vite-plus/test';
import { collectAdvisoryNpm, collectAdvisoryUv } from '../../tests/parity/advisories.js';
import { graphqlTagAnswer } from '../../tests/parity/upstream.js';
import { enrichUpstream, attachUpstreamResearch, upstreamBounds } from './upstream.js';
import { limit } from '../limits.js';
import { createUpstreamReader, GITHUB_GRAPHQL_URL, type TagExistenceMap } from './upstream-read.js';

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
async function fixture(additions = 1, overrides: Partial<typeof limits> = {}) {
  const f = await collectAdvisoryNpm('empty', additions);
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
    limits: { ...limits, ...overrides },
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

/** Registry URL the npm reader requests for one side of a change. */
function registryUrl(instance: { name: string; version: string }) {
  return (
    'https://registry.npmjs.org/' +
    encodeURIComponent(instance.name) +
    '/' +
    encodeURIComponent(instance.version)
  );
}
function registryReader(
  overrides: Partial<typeof limits>,
  respond: (url: string) => Response | null = () => null,
) {
  const calls: string[] = [];
  const r = createUpstreamReader(
    { ...limits, ...overrides },
    {
      now: () => 0,
      fetch: async (url) => {
        calls.push(url);
        const custom = respond(url);
        if (custom) return custom;
        const parts = new URL(url).pathname.split('/').map(decodeURIComponent);
        return Response.json({
          _id: parts[1] + '@' + parts[2],
          name: parts[1],
          version: parts[2],
          dist: { integrity },
          description: 'Exact version description.',
        });
      },
    },
  );
  if (r.kind !== 'ready') throw new Error('reader');
  return { ...r, calls };
}
test("one member's oversized response leaves the others intact", async () => {
  const input = await fixture(3);
  const target = input.changes[1].to as { name: string; version: string };
  const r = registryReader({}, (url) =>
    url === registryUrl(target)
      ? Response.json({ description: 'x'.repeat(limits.maxResponseBytes + 1) })
      : null,
  );
  const result = await enrichUpstream(input, { reader: r.reader });
  expect(result.kind).toBe('enriched');
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result).not.toHaveProperty('stopped');
  const [first, second, ...rest] = result.changes;
  expect(first.evidence.upstream.status).toBe('partial');
  expect(second.evidence.upstream.reasons).toContain('budget');
  expect(second.evidence.upstream.reasons).not.toContain('missing');
  for (const change of rest) expect(change.evidence.upstream.status).toBe('partial');
  r.reader.close();
});
test("a member's attempt overflow rolls back only that member's research", async () => {
  const input = await fixture(3);
  const probe = registryReader({});
  const normal = await enrichUpstream(input, { reader: probe.reader });
  probe.reader.close();
  if (normal.kind !== 'enriched') throw new Error('enrichment');
  // The last member is the first to cross one attempt fewer than a normal run records.
  const last = input.changes[3];
  const maxAttempts = normal.attempts.length - 1;
  const r = registryReader({ maxAttempts });
  const result = await enrichUpstream(await fixture(3, { maxAttempts }), { reader: r.reader });
  r.reader.close();
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result).not.toHaveProperty('stopped');
  // Research overflows after metadata, so the member keeps its metadata and identity only.
  const upstream = result.changes[3].evidence.upstream;
  expect(upstream.status).toBe('partial');
  expect(upstream.reasons).toEqual(['unsupported', 'budget']);
  expect(upstream.sourceIds).toEqual(normal.changes[3].evidence.upstream.sourceIds);
  expect(result.publicIdentities.filter((p) => p.memberId === last.id)).toEqual(
    normal.publicIdentities.filter((p) => p.memberId === last.id),
  );
  expect(result.attempts.filter((a) => a.memberId === last.id).map((a) => a.stage)).toEqual([
    'metadata',
  ]);
  expect(result.attempts.length).toBeLessThanOrEqual(maxAttempts);
  for (const index of [0, 1, 2]) expect(result.changes[index]).toEqual(normal.changes[index]);
});
test('an enrichment whose attempts exactly fill its cap keeps every member research', async () => {
  // The fixture yields a fixed attempt count, not the register's 512, so the cap is the count
  // the normal run records; the one-attempt-short case is pinned by the overflow test above.
  const input = await fixture(3);
  const probe = registryReader({});
  const normal = await enrichUpstream(input, { reader: probe.reader });
  probe.reader.close();
  if (normal.kind !== 'enriched') throw new Error('enrichment');
  const maxAttempts = normal.attempts.length;
  const r = registryReader({ maxAttempts });
  const result = await enrichUpstream(await fixture(3, { maxAttempts }), { reader: r.reader });
  r.reader.close();
  expect(result).toEqual(normal);
});
test('a member over its bounds while reading ahead is rolled back, so later members still read', async () => {
  // The smallest share that still fits the input.
  const fits = async (bytes: number) => {
    const opened = createUpstreamReader(
      { ...limits, maxRetainedBytes: bytes },
      { now: () => 0, fetch: async () => Response.json({}, { status: 404 }) },
    );
    if (opened.kind !== 'ready') throw new Error('reader');
    const result = await enrichUpstream(await fixture(1, { maxRetainedBytes: bytes }), opened);
    opened.reader.close();
    return result.kind === 'enriched';
  };
  let maxRetainedBytes = 1;
  while (!(await fits(maxRetainedBytes))) maxRetainedBytes *= 2;
  for (let low = maxRetainedBytes / 2; low + 1 < maxRetainedBytes;) {
    const mid = Math.floor((low + maxRetainedBytes) / 2);
    if (await fits(mid)) maxRetainedBytes = mid;
    else low = mid;
  }
  const input = await fixture(1, { maxRetainedBytes });
  const update = input.changes[0] as {
    from: { name: string; version: string };
    to: { name: string; version: string };
  };
  const added = input.changes[1] as { to: { name: string; version: string } };
  // The proposed side's metadata is large, so retaining both sides overflows the first member.
  const r = registryReader({ maxRetainedBytes }, (url) =>
    url === registryUrl(update.to)
      ? Response.json({
          _id: update.to.name + '@' + update.to.version,
          name: update.to.name,
          version: update.to.version,
          dist: { integrity },
          description: 'x'.repeat(5000),
        })
      : null,
  );
  const result = await enrichUpstream(input, { reader: r.reader });
  r.reader.close();
  if (result.kind !== 'enriched') throw new Error('enrichment');
  // As in the member loop: the first member overflows and is rolled back, and the next still reads.
  expect(r.calls).toEqual([
    registryUrl(update.from),
    registryUrl(update.to),
    registryUrl(added.to),
  ]);
  expect(result.changes[0].evidence.upstream).toEqual({
    status: 'unavailable',
    reasons: ['budget'],
    sourceIds: [],
  });
  expect(result.attempts.map((a) => a.memberId)).not.toContain(input.changes[0].id);
  expect(result.attempts.map((a) => a.memberId)).toContain(input.changes[1].id);
});
test('share exhaustion keeps completed members and their identities', async () => {
  const input = await fixture(3);
  const probe = registryReader({});
  await enrichUpstream(input, { reader: probe.reader });
  probe.reader.close();
  const second = input.changes[1] as {
    from?: { name: string; version: string } | null;
    to?: { name: string; version: string } | null;
  };
  const secondUrl = registryUrl((second.from ?? second.to)!);
  const firstMemberRequests = probe.calls.indexOf(secondUrl);
  expect(firstMemberRequests).toBeGreaterThan(0);
  const bounded = fixture(3, { maxRequests: firstMemberRequests });
  const r = registryReader({ maxRequests: firstMemberRequests });
  const result = await enrichUpstream(await bounded, { reader: r.reader });
  expect(result.kind).toBe('enriched');
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result).toHaveProperty('stopped', 'budget');
  const firstSides = [input.changes[0].from, input.changes[0].to].filter(Boolean).length;
  const firstIdentities = result.publicIdentities.filter((p) => p.memberId === input.changes[0].id);
  expect(firstIdentities).toHaveLength(firstSides);
  for (const change of result.changes.slice(1))
    expect(change.evidence.upstream).toEqual({
      status: 'unavailable',
      reasons: ['budget'],
      sourceIds: [],
    });
  r.reader.close();
});
test('identities established before a stop in the middle of a member survive', async () => {
  const input = await fixture(3);
  const updated = input.changes[2] as { id: string; from: unknown; to: unknown };
  expect(updated.from && updated.to).toBeTruthy();
  const probe = registryReader({});
  await enrichUpstream(input, { reader: probe.reader });
  probe.reader.close();
  // Only the updated member's base read fits before the share runs out.
  const maxRequests = probe.calls.indexOf(
    registryUrl(updated.to as { name: string; version: string }),
  );
  expect(maxRequests).toBeGreaterThan(0);
  const r = registryReader({ maxRequests });
  const result = await enrichUpstream(await fixture(3, { maxRequests }), { reader: r.reader });
  r.reader.close();
  if (result.kind !== 'enriched') throw new Error('enrichment');
  expect(result.stopped).toBe('budget');
  expect(
    result.publicIdentities.filter((p) => p.memberId === updated.id).map((p) => p.side),
  ).toEqual(['base']);
  expect(result.changes[2].evidence.upstream.reasons).toEqual(['budget']);
  expect(result.changes[3].evidence.upstream).toEqual({
    status: 'unavailable',
    reasons: ['budget'],
    sourceIds: [],
  });
});

test('upstream bounds keep exactly research.maxAttempts attempts and refuse one more', async () => {
  const input = await fixture(3);
  const probe = registryReader({});
  const normal = await enrichUpstream(input, { reader: probe.reader });
  probe.reader.close();
  if (normal.kind !== 'enriched') throw new Error('enrichment');
  const cap = limit('research.maxAttempts');
  // Room for the padded attempts, so the attempt count, not retained bytes, is what binds.
  const limits = { ...input.limits, maxAttempts: cap, maxRetainedBytes: limit('packet.bytes') };
  const padded = (count: number) => ({
    ...normal,
    attempts: Array.from({ length: count }, (_, i) => normal.attempts[i % normal.attempts.length]),
  });
  expect(() => upstreamBounds(padded(cap), limits)).not.toThrow();
  let reason: unknown;
  try {
    upstreamBounds(padded(cap + 1), limits);
  } catch (error) {
    reason = (error as { reason?: unknown }).reason;
  }
  expect(reason).toBe('budget');
});

describe('the batched tag existence pre-pass', () => {
  const sha = 'b'.repeat(40);
  // Only the anchor's proposed tag exists. Its release is missing, so the comparison probes its base.
  const present = new Set(['fixture-anchor@1.1.0']);
  const absentTags = ['fixture-anchor@1.0.0', 'synthetic-child-0@1.0.0'];
  function blob(value: unknown) {
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
  function monorepo(
    graphql: (init: RequestInit) => Response = (init) =>
      graphqlTagAnswer(init, (_, tag) => present.has(tag)),
    githubToken = true,
    readerLimits: Partial<typeof limits> = {},
  ) {
    const calls: string[] = [];
    const sent: { variables: Record<string, string> }[] = [];
    const existence: TagExistenceMap = new Map();
    const opened = createUpstreamReader(
      { ...limits, ...readerLimits },
      {
        now: () => 0,
        githubToken,
        existence,
        fetch: async (url, init) => {
          calls.push(url);
          const parsed = new URL(url);
          if (parsed.origin === 'https://registry.npmjs.org') {
            const [, name, version] = parsed.pathname.split('/').map(decodeURIComponent);
            return Response.json({
              _id: name + '@' + version,
              name,
              version,
              dist: { integrity },
              description: 'Exact version description.',
              repository: {
                url: 'https://github.com/fixture/mono.git',
                directory: 'packages/' + name,
              },
            });
          }
          if (url === GITHUB_GRAPHQL_URL) {
            sent.push(JSON.parse(String(init.body)));
            return graphql(init);
          }
          const path = decodeURIComponent(parsed.pathname).replace('/repos/fixture/mono', '');
          const tag = path.slice('/git/ref/tags/'.length);
          if (path === '') return Response.json({ full_name: 'fixture/mono', private: false });
          if (path.startsWith('/git/ref/tags/') && present.has(tag))
            return Response.json({ ref: 'refs/tags/' + tag, object: { type: 'commit', sha } });
          if (path === '/contents/packages/fixture-anchor/package.json')
            return Response.json(blob({ name: 'fixture-anchor', version: '1.1.0' }));
          if (path === '/releases') return Response.json([]);
          return Response.json({}, { status: 404 });
        },
      },
    );
    if (opened.kind !== 'ready') throw new Error('reader');
    return { reader: opened.reader, calls, sent, existence };
  }
  const restTagProbes = (calls: string[]) =>
    calls.filter((url) => url.includes('/git/ref/')).map((url) => decodeURIComponent(url));
  async function run(r: ReturnType<typeof monorepo>, additions = 1) {
    const input = await fixture(additions, r.reader.limits);
    const result = await enrichUpstream(input, { reader: r.reader });
    r.reader.close();
    if (result.kind !== 'enriched') throw new Error('enrichment');
    return result;
  }

  test('a share that runs out while reading ahead keeps that metadata and sends no GitHub read', async () => {
    // Three members; the second member's head read is the first one the share refuses.
    const r = monorepo(undefined, true, { maxRequests: 2 });
    const result = await run(r, 2);
    const [first, stopped, later] = result.changes.map((change) => change.id);
    expect(result.stopped).toBe('budget');
    expect(r.calls.filter((url) => url.includes('api.github.com'))).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(result.attempts.map((a) => [a.memberId, a.side, a.stage, a.outcome, a.reasons])).toEqual(
      [
        [first, 'head', 'metadata', 'available', []],
        [stopped, 'base', 'metadata', 'available', []],
        [stopped, 'head', 'metadata', 'skipped', ['budget']],
      ],
    );
    expect(result.publicIdentities.map((p) => [p.memberId, p.side])).toEqual([
      [first, 'head'],
      [stopped, 'base'],
    ]);
    const [firstUpstream, ...rest] = result.changes.map((change) => change.evidence.upstream);
    expect(firstUpstream).toMatchObject({ status: 'partial', reasons: ['unsupported', 'budget'] });
    expect(firstUpstream.sourceIds).toHaveLength(1);
    for (const upstream of rest)
      expect(upstream).toEqual({ status: 'unavailable', reasons: ['budget'], sourceIds: [] });
    expect(later).toBeDefined();
  });

  test('an absent tag is missing with no REST request, and the result is unchanged', async () => {
    const today = monorepo(undefined, false);
    const expected = await run(today);
    const batched = monorepo();
    expect(await run(batched)).toEqual(expected);
    expect(today.sent).toEqual([]);
    for (const tag of absentTags) {
      expect(restTagProbes(today.calls).some((url) => url.endsWith('/tags/' + tag))).toBe(true);
      expect(restTagProbes(batched.calls).some((url) => url.endsWith('/tags/' + tag))).toBe(false);
    }
    // One GraphQL POST stands in for every absent probe.
    expect(batched.calls.length).toBeLessThan(today.calls.length);
    expect(batched.existence.get(JSON.stringify(['fixture/mono', 'synthetic-child-0@1.0.0']))).toBe(
      'absent',
    );
  });

  test('a present tag is proved over REST exactly as today', async () => {
    const today = monorepo(undefined, false);
    await run(today);
    const batched = monorepo();
    await run(batched);
    const proposed = (calls: string[]) =>
      restTagProbes(calls).filter((url) => url.endsWith('/tags/fixture-anchor@1.1.0'));
    expect(proposed(batched.calls).length).toBeGreaterThan(0);
    expect(proposed(batched.calls)).toEqual(proposed(today.calls));
    expect(batched.calls.filter((url) => url.includes('/contents/'))).toEqual(
      today.calls.filter((url) => url.includes('/contents/')),
    );
  });

  test('sibling packages in one repository, and both sides of a comparison, share one query', async () => {
    const r = monorepo();
    await run(r);
    expect(r.sent).toHaveLength(1);
    const tags = Object.entries(r.sent[0].variables)
      .filter(([key]) => key.startsWith('q'))
      .map(([, value]) => value);
    expect(tags.sort()).toEqual(
      ['fixture-anchor@1.0.0', 'fixture-anchor@1.1.0', 'synthetic-child-0@1.0.0'].map(
        (tag) => 'refs/tags/' + tag,
      ),
    );
  });

  test("a missing candidate's attempt cites the release-tag page link, not a REST URL", async () => {
    const result = await run(monorepo());
    const attempt = result.attempts.find(
      (a) => a.stage === 'release' && a.target === 'synthetic-child-0@1.0.0',
    );
    expect(attempt).toMatchObject({
      url: 'https://github.com/fixture/mono/releases/tag/synthetic-child-0%401.0.0',
      outcome: 'unavailable',
      reasons: ['missing'],
    });
  });

  test.each([
    ['an error naming every alias', (init: RequestInit) => unknownAnswer(init)],
    ['a server error', () => Response.json({}, { status: 502 })],
  ])('an unknown answer (%s) is probed over REST as today', async (_, graphql) => {
    const today = monorepo(undefined, false);
    const expected = await run(today);
    const batched = monorepo(graphql);
    expect(await run(batched)).toEqual(expected);
    expect(batched.sent).toHaveLength(1);
    expect(restTagProbes(batched.calls)).toEqual(restTagProbes(today.calls));
    for (const tag of [...absentTags, ...present])
      expect(restTagProbes(batched.calls).some((url) => url.endsWith('/tags/' + tag))).toBe(true);
  });

  test('after a GraphQL secondary limit, dispatch stops and unsettled candidates get rate_limit', async () => {
    const r = monorepo(() =>
      Response.json(
        { message: 'You have exceeded a secondary rate limit.' },
        { status: 403, headers: { 'retry-after': '3600' } },
      ),
    );
    const result = await run(r);
    const graphqlAt = r.calls.indexOf(GITHUB_GRAPHQL_URL);
    expect(graphqlAt).toBeGreaterThan(-1);
    const github = r.calls.slice(graphqlAt + 1).filter((url) => url.includes('api.github.com'));
    expect(github).toEqual([]);
    expect(result.changes.length).toBeGreaterThan(0);
    for (const change of result.changes)
      expect(change.evidence.upstream.reasons).toContain('rate_limit');
  });
});
function unknownAnswer(init: RequestInit) {
  const { variables } = JSON.parse(String(init.body)) as { variables: Record<string, string> };
  const aliases = Object.keys(variables)
    .filter((key) => key.startsWith('q'))
    .map((key) => 'c' + key.slice(1));
  return Response.json({
    data: { ...Object.fromEntries(aliases.map((alias) => [alias, null])), rateLimit: { cost: 1 } },
    errors: aliases.map((alias) => ({ type: 'NOT_FOUND', path: [alias], message: 'Not found.' })),
  });
}
