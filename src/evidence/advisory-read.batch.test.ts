import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import {
  createAdvisoryReader,
  createMalwareReader,
  discoverySpellings,
  githubUrl,
  type AdvisoryLookup,
  type AdvisoryTarget,
  type QueryKind,
} from './advisory-read.js';
import { limit } from '../limits.js';

// Every record here is synthetic unless its test names a recorded fixture.
const limits = {
  maxRequests: 20,
  maxPages: 20,
  maxResponseBytes: 20_000,
  maxTotalBytes: 400_000,
  maxJsonEntries: 100_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 200_000,
  maxFindings: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const BATCH_PAGE = String(limit('advisory.batch.pageSize'));
const DISCOVERY_PAGE = String(limit('advisory.discovery.pageSize'));

type Route = (url: URL) => Response | undefined;
/** GitHub and OSV fake: each route may answer; anything unanswered is a loud 418. */
function server(...routes: Route[]) {
  const requests: string[] = [];
  const fetch = async (url: string) => {
    requests.push(url);
    for (const route of routes) {
      const answer = route(new URL(url));
      if (answer) return answer;
    }
    return Response.json({ message: 'unexpected request' }, { status: 418 });
  };
  /** Batch and discovery requests: the only ones sent at their page size. */
  const batches = () => requests.filter((u) => perPage(u) === BATCH_PAGE);
  const singletons = () => requests.filter((u) => perPage(u) === '100');
  return { fetch, requests, batches, singletons };
}
const perPage = (u: string) => new URL(u).searchParams.get('per_page');
const isBatch = (u: URL) => u.searchParams.get('per_page') === BATCH_PAGE;
const affectsOf = (u: string) => new URL(u).searchParams.get('affects')!.split(',');
function ready(
  kind: QueryKind,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  overrides = {},
) {
  const factory = kind === 'reviewed' ? createAdvisoryReader : createMalwareReader;
  const reader = factory({ ...limits, ...overrides }, { fetch, now: () => 0 });
  if (reader.kind !== 'ready' || !reader.settle) throw new Error('reader');
  return reader as typeof reader & { settle: NonNullable<typeof reader.settle> };
}
let next = 0;
/** A synthetic GitHub record naming each `[ecosystem, name, range]` entry. */
function record(kind: QueryKind, ...entries: [string, string, string][]) {
  const id = `GHSA-${String(next++).padStart(4, '0')}-bbbb-cccc`;
  return {
    ghsa_id: id,
    html_url: `https://github.com/advisories/${id}`,
    summary: `Synthetic ${id}`,
    type: kind,
    severity: 'high',
    withdrawn_at: null,
    vulnerabilities: entries.map(([ecosystem, name, range]) => ({
      package: { ecosystem, name },
      vulnerable_version_range: range,
    })),
  };
}
const npm = (name: string, version = '1.0.0') =>
  ({ ecosystem: 'npm', name, version }) as AdvisoryTarget;
const singletonUrl = (t: AdvisoryTarget, kind: QueryKind) =>
  githubUrl(t.ecosystem, [`${t.name}@${t.version}`], kind);
/** What a reader that never batched returns for `t` from an empty complete query. */
async function unbatched(kind: QueryKind, t: AdvisoryTarget): Promise<AdvisoryLookup> {
  const reader = ready(kind, server(() => Response.json([])).fetch);
  const lookup = await reader.read(t);
  reader.close();
  expect(lookup.complete).toBe(true);
  return lookup;
}

// S1 Batched Lookup Amendment fixtures, for npm (Batching Reconciliation D2, D4).

const npmTargets = [npm('widget'), npm('@scope/gadget', '2.0.0'), npm('left-pad', '1.3.0')];

test.each(['reviewed', 'malware'] as const)(
  'an empty complete %s npm batch clears every target, each in a fetched batch URL',
  async (kind) => {
    const fake = server((u) => (isBatch(u) ? Response.json([]) : undefined));
    const reader = ready(kind, fake.fetch);
    await reader.settle(npmTargets);
    expect(fake.requests).toHaveLength(1);
    const sent = fake.batches().flatMap(affectsOf);
    for (const t of npmTargets) {
      expect(sent).toContain(`${t.name}@${t.version}`);
      const lookup = await reader.read(t);
      // A cleared lookup is a complete empty singleton lookup, flagged as batched.
      expect(lookup).toEqual({ ...(await unbatched(kind, t)), batched: true });
      expect(lookup.url).toBe(singletonUrl(t, kind));
    }
    reader.close();
    expect(fake.requests).toHaveLength(1);
    expect(new URL(fake.requests[0]).searchParams.get('type')).toBe(kind);
  },
);
test.each(['reviewed', 'malware'] as const)(
  'a %s record naming one batched package is attributed to it, joining its ranges',
  async (kind) => {
    // The RubyGems entry names a batched npm package; other ecosystems never name targets.
    const hit = record(
      kind,
      ['npm', 'widget', '< 1.1.0'],
      ['rubygems', '@scope/gadget', '< 3.0.0'],
      ['npm', 'widget', '>= 2.0.0, < 2.1.0'],
    );
    const fake = server((u) => (isBatch(u) ? Response.json([hit]) : undefined));
    const reader = ready(kind, fake.fetch);
    await reader.settle(npmTargets);
    const widget = await reader.read(npmTargets[0]);
    const gadget = await reader.read(npmTargets[1]);
    reader.close();
    expect(fake.requests).toHaveLength(1);
    expect(widget).toMatchObject({
      complete: true,
      status: 'available',
      batched: true,
      url: singletonUrl(npmTargets[0], kind),
      records: [{ id: hit.ghsa_id, range: '< 1.1.0 || >= 2.0.0, < 2.1.0', severity: 'high' }],
    });
    expect(gadget).toMatchObject({ complete: true, records: [], batched: true });
  },
);
test('npm names are compared exactly, so a differently cased name is not a batched package', async () => {
  const hit = record('reviewed', ['npm', 'widget', '< 2.0.0'], ['npm', 'Left-Pad', '< 2.0.0']);
  const fake = server((u) => (isBatch(u) ? Response.json([hit]) : undefined));
  const reader = ready('reviewed', fake.fetch);
  await reader.settle(npmTargets);
  const widget = await reader.read(npmTargets[0]);
  const leftPad = await reader.read(npmTargets[2]);
  reader.close();
  expect(fake.requests).toHaveLength(1);
  expect(widget).toMatchObject({ batched: true, records: [{ id: hit.ghsa_id }] });
  expect(leftPad).toMatchObject({ complete: true, batched: true, records: [] });
});
test('a record naming two batched packages sends both singleton queries, which decide', async () => {
  const shared = record('reviewed', ['npm', 'widget', '< 2.0.0'], ['npm', 'left-pad', '< 1.0.0']);
  const fake = server((u) => {
    if (isBatch(u)) return Response.json([shared]);
    // Only widget's version is affected, so only its singleton returns the record.
    return Response.json(affectsOf(u.href)[0] === 'widget@1.0.0' ? [shared] : []);
  });
  const reader = ready('reviewed', fake.fetch);
  await reader.settle(npmTargets);
  expect(fake.singletons().sort()).toEqual(
    [singletonUrl(npmTargets[0], 'reviewed'), singletonUrl(npmTargets[2], 'reviewed')].sort(),
  );
  const [widget, gadget, leftPad] = [
    await reader.read(npmTargets[0]),
    await reader.read(npmTargets[1]),
    await reader.read(npmTargets[2]),
  ];
  reader.close();
  // The singletons ran during settle; reading makes no request.
  expect(fake.requests).toHaveLength(3);
  expect(widget).toEqual(
    expect.objectContaining({ complete: true, records: [expect.objectContaining({})] }),
  );
  expect(widget).not.toHaveProperty('batched');
  expect(leftPad).toMatchObject({ complete: true, records: [] });
  expect(leftPad).not.toHaveProperty('batched');
  expect(gadget).toMatchObject({ complete: true, records: [], batched: true });
});
test('a failed singleton for a shared record leaves that target incomplete with its reason', async () => {
  const shared = record('malware', ['npm', 'widget', '< 2.0.0'], ['npm', 'left-pad', '< 2.0.0']);
  const fake = server((u) =>
    isBatch(u) ? Response.json([shared]) : Response.json({}, { status: 503 }),
  );
  const reader = ready('malware', fake.fetch);
  await reader.settle(npmTargets);
  expect(await reader.read(npmTargets[0])).toMatchObject({
    complete: false,
    records: [],
    reasons: ['unknown'],
  });
  reader.close();
});

const page2 = (u: URL) => {
  const link = new URL(u);
  link.searchParams.set('after', 'page-2');
  return link.href;
};
test.each([
  [
    'a record naming no batched package',
    (u: URL) => (isBatch(u) ? Response.json([record('reviewed', ['npm', 'other', '<1'])]) : null),
  ],
  [
    'a failed second page',
    (u: URL) =>
      !isBatch(u)
        ? null
        : u.searchParams.has('after')
          ? Response.json({}, { status: 500 })
          : Response.json([], { headers: { link: `<${page2(u)}>; rel="next"` } }),
  ],
  [
    'an oversized page',
    (u: URL) =>
      isBatch(u)
        ? new Response(`[${' '.repeat(limits.maxResponseBytes)}]`, {
            headers: { 'content-type': 'application/json' },
          })
        : null,
  ],
  [
    'a malformed vulnerabilities entry',
    (u: URL) =>
      isBatch(u)
        ? Response.json([
            { ...record('reviewed', ['npm', 'widget', '<2']), vulnerabilities: [{ package: 1 }] },
          ])
        : null,
  ],
  [
    'an entry in another ecosystem without a name',
    (u: URL) =>
      isBatch(u)
        ? Response.json([
            {
              ...record('reviewed', ['npm', 'widget', '<2']),
              vulnerabilities: [
                { package: { ecosystem: 'npm', name: 'widget' }, vulnerable_version_range: '<2' },
                { package: { ecosystem: 'pip' }, vulnerable_version_range: '<2' },
              ],
            },
          ])
        : null,
  ],
])('%s makes the npm batch fall back to singleton queries', async (_label, batch) => {
  const fake = server((u) => batch(u) ?? Response.json([]));
  const reader = ready('reviewed', fake.fetch);
  await reader.settle(npmTargets);
  const settledRequests = fake.requests.length;
  expect(fake.singletons()).toHaveLength(0);
  for (const t of npmTargets) {
    const lookup = await reader.read(t);
    expect(lookup).toEqual(await unbatched('reviewed', t));
    expect(lookup).not.toHaveProperty('batched');
  }
  reader.close();
  // Every target, cleared or not by a partial answer, sent its own singleton query.
  expect(fake.requests.slice(settledRequests).sort()).toEqual(
    npmTargets.map((t) => singletonUrl(t, 'reviewed')).sort(),
  );
});
test('a GitHub rate limit leaves unsettled targets rate_limit and still lets OSV read', async () => {
  const fake = server((u) =>
    u.hostname === 'api.osv.dev' ? Response.json({}) : Response.json({}, { status: 429 }),
  );
  const reader = ready('reviewed', fake.fetch);
  // Two versions of one package go in separate batches; the second is never sent.
  await reader.settle([...npmTargets, npm('widget', '2.0.0')]);
  expect(fake.requests).toHaveLength(1);
  for (const t of [...npmTargets, npm('widget', '2.0.0')])
    expect(await reader.read(t)).toMatchObject({ complete: false, reasons: ['rate_limit'] });
  expect(fake.requests).toHaveLength(1);
  expect(await reader.read({ ecosystem: 'pip', name: 'pyyaml', version: '3.13' })).toMatchObject({
    complete: true,
  });
  reader.close();
});
test('two versions of one npm package are never in one batch', async () => {
  const fake = server(() => Response.json([]));
  const reader = ready('reviewed', fake.fetch);
  await reader.settle([npm('widget'), npm('left-pad'), npm('widget', '2.0.0')]);
  reader.close();
  expect(fake.batches().map(affectsOf)).toEqual([
    ['widget@1.0.0', 'left-pad@1.0.0'],
    ['widget@2.0.0'],
  ]);
});
test('read on an unsettled target behaves as without settle', async () => {
  const hit = record('reviewed', ['npm', 'widget', '< 2.0.0']);
  const fake = server(() => Response.json([hit]));
  const reader = ready('reviewed', fake.fetch);
  await reader.settle([npm('widget')]);
  const other = await reader.read(npm('widget', '3.0.0'));
  reader.close();
  expect(fake.requests).toEqual([
    githubUrl('npm', ['widget@1.0.0'], 'reviewed', BATCH_PAGE),
    singletonUrl(npm('widget', '3.0.0'), 'reviewed'),
  ]);
  expect(other).toMatchObject({ complete: true, records: [{ id: hit.ghsa_id }] });
  expect(other).not.toHaveProperty('batched');
});
test.each([
  ['reviewed', { ecosystem: 'pip', name: 'pyyaml', version: '3.13' }],
  ['malware', { ecosystem: 'actions', name: 'tj-actions/changed-files', version: '45.0.7' }],
] as const)('settle never batches %s %j targets', async (kind, t) => {
  const fake = server(() => Response.json([]));
  const reader = ready(kind, fake.fetch);
  await reader.settle([t, { ...t, version: '9.9.9' }]);
  expect(fake.requests).toHaveLength(0);
  expect(await reader.read(t)).not.toHaveProperty('batched');
  reader.close();
});

// S1 Batching Reconciliation fixtures: discovery batches (D3), Actions reviewed and pip malware.

const isDiscovery = (u: URL) => u.searchParams.get('per_page') === DISCOVERY_PAGE;
const pip = (name: string, version = '1.0.0') =>
  ({ ecosystem: 'pip', name, version }) as AdvisoryTarget;
// The long name's 243 spellings need several discovery requests.
const pipTargets = [
  pip('flo-pro-adk'),
  pip('opentelemetry-exporter-otlp-proto-http-extra'),
  pip('jupyter-server', '2.17.0'),
  pip('jupyter-server', '2.18.0'),
];
const actionsTargets = [
  { ecosystem: 'actions', name: 'TJ-Actions/Changed-Files', version: '45.0.7' },
  { ecosystem: 'actions', name: 'actions/checkout', version: '4.2.0' },
] as AdvisoryTarget[];

test.each([
  ['malware', pipTargets],
  ['reviewed', actionsTargets],
] as const)(
  'an empty complete %s discovery batch clears each target citing its unfetched versioned URL',
  async (kind, targets) => {
    const fake = server((u) => (isDiscovery(u) ? Response.json([]) : undefined));
    const reader = ready(kind, fake.fetch);
    await reader.settle(targets);
    const discovery = [...fake.requests];
    if (kind === 'malware') expect(discovery.length).toBeGreaterThan(1);
    expect(discovery.every((u) => isDiscovery(new URL(u)))).toBe(true);
    const sent = discovery.flatMap(affectsOf);
    for (const t of targets) {
      // Every spelling of each cleared target was fetched.
      for (const spelling of discoverySpellings(t.ecosystem, t.name))
        expect(sent).toContain(spelling);
      const lookup = await reader.read(t);
      expect(lookup).toEqual({ ...(await unbatched(kind, t)), batched: true });
      expect(lookup.url).toBe(singletonUrl(t, kind));
      expect(discovery).not.toContain(lookup.url);
    }
    reader.close();
    expect(fake.requests).toEqual(discovery);
  },
);

/** Recorded jupyter-server discovery records, retyped as malware, one stored name changed. */
function jupyterRecords() {
  const recorded = JSON.parse(
    readFileSync(
      new URL('./fixtures/name-forms/github-jupyter-server-discovery.json', import.meta.url),
      'utf8',
    ),
  ) as { body: Record<string, unknown>[] };
  return recorded.body.map((r) => ({
    ...r,
    type: 'malware',
    vulnerabilities: (r.vulnerabilities as { package: { ecosystem: string; name: string } }[]).map(
      (v) =>
        r.ghsa_id === 'GHSA-24qx-w28j-9m6p'
          ? { ...v, package: { ...v.package, name: 'Jupyter_Server' } }
          : v,
    ),
  }));
}
/** Answers the discovery request that lists `jupyter-server` with these records. */
const jupyterDiscovery =
  (records: unknown[]): Route =>
  (u) =>
    isDiscovery(u)
      ? Response.json(affectsOf(u.href).includes('jupyter-server') ? records : [])
      : undefined;

test('a Jupyter_Server stored form for jupyter-server is a hit with its versioned query', async () => {
  const fake = server(jupyterDiscovery(jupyterRecords()), () => Response.json([]));
  const reader = ready('malware', fake.fetch);
  await reader.settle(pipTargets);
  const versioned = fake.singletons();
  expect(versioned.map(affectsOf)).toEqual([
    ['Jupyter_Server@2.17.0', 'jupyter-server@2.17.0', 'jupyter_server@2.17.0'],
    ['Jupyter_Server@2.18.0', 'jupyter-server@2.18.0', 'jupyter_server@2.18.0'],
  ]);
  const before = fake.requests.length;
  const hit = await reader.read(pipTargets[2]);
  const cleared = await reader.read(pipTargets[0]);
  reader.close();
  expect(fake.requests).toHaveLength(before);
  // Discovery never attributes a record: the versioned query found none.
  expect(hit).toMatchObject({ complete: true, records: [], url: versioned[0] });
  expect(hit).not.toHaveProperty('batched');
  expect(cleared).toMatchObject({ complete: true, batched: true });
});
test('a discovery hit followed by a failed versioned query is incomplete with no finding', async () => {
  const fake = server(jupyterDiscovery(jupyterRecords()), () => Response.json({}, { status: 503 }));
  const reader = ready('malware', fake.fetch);
  await reader.settle(pipTargets);
  expect(await reader.read(pipTargets[2])).toMatchObject({
    complete: false,
    records: [],
    reasons: ['unknown'],
  });
  reader.close();
});
test('a discovery record naming no batched target makes the batch malformed and fall back', async () => {
  const stray = record('malware', ['pip', 'unrelated-package', '<1']);
  const fake = server(jupyterDiscovery([...jupyterRecords(), stray]), () => Response.json([]));
  const reader = ready('malware', fake.fetch);
  await reader.settle(pipTargets);
  const before = fake.requests.length;
  expect(fake.singletons()).toHaveLength(0);
  const lookup = await reader.read(pipTargets[0]);
  reader.close();
  expect(lookup).not.toHaveProperty('batched');
  // Per-target discovery, then the versioned query after its empty discovery.
  expect(fake.requests.slice(before).map(affectsOf)).toEqual([
    discoverySpellings('pip', 'flo-pro-adk'),
    ['flo-pro-adk@1.0.0'],
  ]);
});
test('a failed second discovery request makes every target in the batch fall back', async () => {
  let discovery = 0;
  const fake = server((u) =>
    isDiscovery(u) && ++discovery === 2 ? Response.json({}, { status: 503 }) : Response.json([]),
  );
  const reader = ready('malware', fake.fetch);
  await reader.settle(pipTargets);
  const batch = fake.requests.slice();
  // flo-pro-adk was carried by the first request, which succeeded.
  expect(affectsOf(batch[0])).toContain('flo-pro-adk');
  for (const t of pipTargets) {
    const before = fake.requests.length;
    const lookup = await reader.read(t);
    expect(lookup).not.toHaveProperty('batched');
    expect(fake.requests.length).toBeGreaterThan(before);
  }
  reader.close();
});
test('reading a settled discovery target makes no request', async () => {
  const fake = server(() => Response.json([]));
  const reader = ready('reviewed', fake.fetch);
  await reader.settle(actionsTargets);
  const before = fake.requests.length;
  for (const t of actionsTargets) expect(await reader.read(t)).toMatchObject({ batched: true });
  reader.close();
  expect(fake.requests).toHaveLength(before);
});
