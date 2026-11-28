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
import { BATCH_URL_BYTES } from './batches.js';
import { limit } from '../limits.js';
import { PACKET_LIMITS } from '../schema.js';

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
  /** Batch and discovery requests, told apart from versioned singletons by their targets. */
  const batches = () => requests.filter((u) => isBatch(new URL(u)));
  const singletons = () => requests.filter((u) => !isBatch(new URL(u)));
  return { fetch, requests, batches, singletons };
}
/**
 * Batches and discovery share the singletons' page size, so the targets tell them apart: an npm
 * batch lists more than one target, and a discovery query names no version.
 */
const isBatch = (u: URL) => {
  const targets = u.searchParams.get('affects')!.split(',');
  return u.searchParams.get('ecosystem') === 'npm'
    ? targets.length > 1
    : targets.every((target) => !target.includes('@'));
};
const affectsOf = (u: string) => new URL(u).searchParams.get('affects')!.split(',');
function ready(
  kind: QueryKind,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  overrides = {},
  deps = {},
) {
  const factory = kind === 'reviewed' ? createAdvisoryReader : createMalwareReader;
  const reader = factory({ ...limits, ...overrides }, { fetch, now: () => 0, ...deps });
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
    expect(await reader.settle(npmTargets)).toBe(npmTargets.length);
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
    expect.objectContaining({
      complete: true,
      records: [expect.objectContaining({ id: shared.ghsa_id })],
    }),
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
  const before = fake.requests.length;
  expect(await reader.read(npmTargets[0])).toMatchObject({
    complete: false,
    records: [],
    reasons: ['unknown'],
  });
  reader.close();
  // The failed singleton decided during settle; reading does not resend it.
  expect(fake.requests).toHaveLength(before);
});

const page2 = (u: URL, cursor = 'page-2') => {
  const link = new URL(u);
  link.searchParams.set('after', cursor);
  return link.href;
};
/** A record naming two batched packages, changed so that one field fails S1's validation. */
const sharedWith = (change: Record<string, unknown>) => ({
  ...record('reviewed', ['npm', 'widget', '< 2.0.0'], ['npm', 'left-pad', '< 2.0.0']),
  ...change,
});
const invalidShared: [string, Record<string, unknown>][] = [
  ['no summary', { summary: undefined }],
  ['an unknown severity', { severity: 'bogus' }],
  ['an invalid withdrawn time', { withdrawn_at: 'not-a-date' }],
  [
    'a missing range',
    {
      vulnerabilities: [
        { package: { ecosystem: 'npm', name: 'widget' } },
        { package: { ecosystem: 'npm', name: 'left-pad' }, vulnerable_version_range: '<2' },
      ],
    },
  ],
];
test.each([
  ...invalidShared.map(([label, change]): [string, (u: URL) => Response | null] => [
    `a two-package record with ${label}`,
    (u: URL) => (isBatch(u) ? Response.json([sharedWith(change)]) : null),
  ]),
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
test('a continuation URL over the batch URL cap is budget, and the batch falls back', async () => {
  // Enough long names to fill one batch's first URL close to the cap less the cursor headroom.
  const count = Math.ceil(BATCH_URL_BYTES / 80);
  const targets = Array.from({ length: count }, (_, i) => npm(`p${i}-${'x'.repeat(80)}`));
  const cursor = 'c'.repeat(PACKET_LIMITS.identityBytes);
  const fake = server((u) => {
    if (!isBatch(u) || u.searchParams.has('after')) return Response.json([]);
    return Response.json([], { headers: { link: `<${page2(u, cursor)}>; rel="next"` } });
  });
  const reader = ready('reviewed', fake.fetch, { maxRequests: 100, maxPages: 100 });
  const settled = await reader.settle(targets);
  const firsts = fake.batches().filter((u) => !new URL(u).searchParams.has('after'));
  const overCap = firsts.filter((u) => page2(new URL(u), cursor).length > BATCH_URL_BYTES);
  expect(overCap.length).toBeGreaterThan(0);
  const fellBack = targets.filter((t) =>
    overCap.some((u) => affectsOf(u).includes(`${t.name}@${t.version}`)),
  );
  expect(settled).toBe(targets.length - fellBack.length);
  for (const t of fellBack) expect(await reader.read(t)).not.toHaveProperty('batched');
  reader.close();
});
test('an attributed record past the findings bound leaves its target to its singleton', async () => {
  const hits = [
    record('reviewed', ['npm', 'widget', '<2']),
    record('reviewed', ['npm', 'widget', '<3']),
  ];
  const fake = server((u) => (isBatch(u) ? Response.json(hits) : Response.json([])));
  const reader = ready('reviewed', fake.fetch, { maxFindings: 1 });
  expect(await reader.settle(npmTargets)).toBe(npmTargets.length - 1);
  const before = fake.requests.length;
  expect(await reader.read(npmTargets[0])).not.toHaveProperty('batched');
  expect(fake.requests.slice(before)).toEqual([singletonUrl(npmTargets[0], 'reviewed')]);
  reader.close();
});
test('a record on the second page of a batch is attributed', async () => {
  const hit = record('reviewed', ['npm', 'widget', '< 2.0.0']);
  const fake = server((u) =>
    !isBatch(u)
      ? undefined
      : u.searchParams.has('after')
        ? Response.json([hit])
        : Response.json([], { headers: { link: `<${page2(u)}>; rel="next"` } }),
  );
  const reader = ready('reviewed', fake.fetch);
  await reader.settle(npmTargets);
  expect(fake.requests).toHaveLength(2);
  expect(await reader.read(npmTargets[0])).toMatchObject({
    batched: true,
    records: [{ id: hit.ghsa_id }],
  });
  reader.close();
});
test('a withdrawn batch record is attributed as withdrawn', async () => {
  const hit = {
    ...record('reviewed', ['npm', 'widget', '<2']),
    withdrawn_at: '2026-01-01T00:00:00Z',
  };
  const reader = ready('reviewed', server(() => Response.json([hit])).fetch);
  await reader.settle(npmTargets);
  expect(await reader.read(npmTargets[0])).toMatchObject({
    batched: true,
    records: [{ id: hit.ghsa_id, withdrawn: true }],
  });
  reader.close();
});
test('duplicate targets are batched once and settled once', async () => {
  const fake = server(() => Response.json([]));
  const reader = ready('reviewed', fake.fetch);
  expect(await reader.settle([npmTargets[0], npmTargets[1], { ...npmTargets[0] }])).toBe(2);
  expect(fake.batches().map(affectsOf)).toEqual([['widget@1.0.0', '@scope/gadget@2.0.0']]);
  // Settled targets are not batched again: the second pre-pass is a batch of one.
  expect(await reader.settle(npmTargets)).toBe(1);
  expect(fake.requests.map(affectsOf)[1]).toEqual(['left-pad@1.3.0']);
  reader.close();
});
test('settle on a busy reader settles nothing and says so', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = server(() => Response.json([]));
  const reader = ready('reviewed', async (url) => {
    await gate;
    return fake.fetch(url);
  });
  const pending = reader.read(npm('other'));
  expect(await reader.settle(npmTargets)).toBeNull();
  release();
  await pending;
  expect(fake.batches()).toHaveLength(0);
  expect(await reader.settle(npmTargets)).toBe(npmTargets.length);
  reader.close();
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
test('a record from the batch holding one version is attributed to that version only', async () => {
  const hit = record('reviewed', ['npm', 'widget', '< 2.0.0']);
  const fake = server((u) =>
    // Each version is a batch of one, whose URL is its singleton's.
    Response.json(affectsOf(u.href).includes('widget@1.0.0') ? [hit] : []),
  );
  const reader = ready('reviewed', fake.fetch);
  await reader.settle([npm('widget'), npm('widget', '2.0.0')]);
  expect(await reader.read(npm('widget'))).toMatchObject({
    batched: true,
    records: [{ id: hit.ghsa_id }],
  });
  expect(await reader.read(npm('widget', '2.0.0'))).toMatchObject({ batched: true, records: [] });
  reader.close();
});
test('two versions of one npm package are never in one batch', async () => {
  const fake = server(() => Response.json([]));
  const reader = ready('reviewed', fake.fetch);
  await reader.settle([npm('widget'), npm('left-pad'), npm('widget', '2.0.0')]);
  reader.close();
  // The second version is a batch of one, whose URL is its singleton's.
  expect(fake.requests.map(affectsOf)).toEqual([
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

/** A discovery query is package-only: no `affects` entry names a version. */
const isDiscovery = (u: URL) =>
  u.searchParams
    .get('affects')!
    .split(',')
    .every((target) => !target.includes('@'));
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
const long = pipTargets[1];
const carries = (u: string, t: AdvisoryTarget) =>
  affectsOf(u).some((s) => discoverySpellings(t.ecosystem, t.name).includes(s));
test('a failed second request of a discovery batch makes every target in it fall back', async () => {
  let discovery = 0;
  const fake = server((u) =>
    isDiscovery(u) && carries(u.href, long) && ++discovery === 2
      ? Response.json({}, { status: 503 })
      : Response.json([]),
  );
  const reader = ready('malware', fake.fetch);
  const both = [long, { ...long, version: '2.0.0' }];
  const small = [pipTargets[0], pip('pillow', '8.0.0')];
  // The long name's spellings need several requests, so it is a batch of its own.
  expect(await reader.settle([...small, ...both])).toBe(small.length);
  expect(fake.requests.filter((u) => carries(u, long)).length).toBeGreaterThan(1);
  // The separate small batch, one request for both packages, still settles.
  expect(fake.requests.filter((u) => small.every((t) => carries(u, t)))).toHaveLength(1);
  for (const t of small)
    expect(await reader.read(t)).toMatchObject({
      batched: true,
      complete: true,
      status: 'available',
    });
  for (const t of both) {
    const before = fake.requests.length;
    expect(await reader.read(t)).not.toHaveProperty('batched');
    expect(fake.requests.length).toBeGreaterThan(before);
  }
  reader.close();
});
test('a failed second page drops every package of a shared discovery batch', async () => {
  const small = [pipTargets[0], pipTargets[2], pip('pillow', '8.0.0')];
  const fake = server((u) =>
    !isDiscovery(u)
      ? undefined
      : u.searchParams.has('after')
        ? Response.json({}, { status: 503 })
        : Response.json([], { headers: { link: `<${page2(u)}>; rel="next"` } }),
  );
  const reader = ready('malware', fake.fetch);
  expect(await reader.settle(small)).toBe(0);
  // One request carried all three packages.
  expect(fake.requests.filter((u) => !new URL(u).searchParams.has('after'))).toHaveLength(1);
  reader.close();
});
test('an oversized discovery page drops only its own batch', async () => {
  const fake = server((u) =>
    isDiscovery(u) && carries(u.href, long)
      ? new Response(`[${' '.repeat(limits.maxResponseBytes)}]`, {
          headers: { 'content-type': 'application/json' },
        })
      : Response.json([]),
  );
  const reader = ready('malware', fake.fetch);
  expect(await reader.settle(pipTargets)).toBe(3);
  expect(await reader.read(pipTargets[0])).toMatchObject({ batched: true });
  expect(await reader.read(pipTargets[3])).toMatchObject({ batched: true });
  expect(await reader.read(long)).not.toHaveProperty('batched');
  reader.close();
});
test('packages share a discovery batch only while their spellings fit one request', async () => {
  // More spellings than one request holds: 9 per name.
  const many = Array.from(
    { length: Math.ceil(limit('advisory.discovery.urlBytes') / 100) },
    (_, i) => pip(`pkg${i}-alpha-beta`),
  );
  const fake = server(() => Response.json([]));
  const reader = ready('malware', fake.fetch);
  expect(await reader.settle(many)).toBe(many.length);
  reader.close();
  expect(fake.requests.length).toBeGreaterThan(1);
  for (const t of many)
    expect(fake.requests.filter((u) => carries(u, t)).map(affectsOf)).toEqual([
      expect.arrayContaining(discoverySpellings('pip', t.name)),
    ]);
});
test('a continuation URL over the discovery cap is budget, and the batch falls back', async () => {
  const fake = server((u) => {
    if (!isDiscovery(u) || u.searchParams.has('after')) return Response.json([]);
    return Response.json([], {
      headers: { link: `<${page2(u, 'c'.repeat(600))}>; rel="next"` },
    });
  });
  const reader = ready('malware', fake.fetch);
  expect(await reader.settle([long])).toBe(0);
  reader.close();
});
test('a discovery plan that rewrites a request settles nothing', async () => {
  const fake = server(() => Response.json([]));
  // Every spelling is still listed, but under another query type.
  const retype = (urls: string[]) => urls.map((u) => u.replace('type=malware', 'type=reviewed'));
  const reader = ready('malware', fake.fetch, {}, { discoveryPlan: retype });
  expect(await reader.settle([pipTargets[0]])).toBe(0);
  expect(fake.requests).toHaveLength(0);
  reader.close();
});
test('a discovery batch whose requests miss a spelling settles nothing', async () => {
  const fake = server(() => Response.json([]));
  // The test seam drops the first request, so the long name's first spellings are never fetched.
  const reader = ready(
    'malware',
    fake.fetch,
    {},
    { discoveryPlan: (urls: string[]) => urls.slice(1) },
  );
  expect(await reader.settle([long])).toBe(0);
  expect(fake.requests.length).toBeGreaterThan(0);
  expect(await reader.read(long)).not.toHaveProperty('batched');
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
