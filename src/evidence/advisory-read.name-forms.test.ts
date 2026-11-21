import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import { createAdvisoryReader, createMalwareReader } from './advisory-read.js';
import { createResearchCache } from './research-cache.js';

const limits = {
  maxRequests: 20,
  maxPages: 20,
  maxResponseBytes: 1_048_576,
  maxTotalBytes: 8_388_608,
  maxJsonEntries: 100_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 1_048_576,
  maxFindings: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
type Fixture = {
  request: { url: string; body?: unknown };
  status: number;
  body: unknown;
  link?: string;
};
/** Responses recorded from GitHub and OSV, trimmed to the fields the reader validates. */
export function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/name-forms/${name}.json`, import.meta.url), 'utf8'),
  ) as Fixture;
}
const key = (url: string, body?: unknown) => JSON.stringify([url, body ?? null]);
/** Serves only the given fixtures; any other request fails loudly and is recorded. */
export function served(...fixtures: Fixture[]) {
  const responses = new Map(fixtures.map((f) => [key(f.request.url, f.request.body), f]));
  const requests: { url: string; init: RequestInit; body?: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url, init, body });
    const f = responses.get(key(url, body));
    if (!f) return Response.json({ message: 'unexpected request' }, { status: 418 });
    return Response.json(f.body, {
      status: f.status,
      headers: f.link ? { link: f.link } : {},
    });
  };
  return { fetch, requests };
}

test('pip reviewed lookup finds advisories stored as PyYAML for pyyaml 3.13', async () => {
  const server = served(
    fixture('osv-pyyaml-3.13'),
    // The query the reader sent before the fix; GitHub stores these advisories as `PyYAML`.
    fixture('github-pyyaml-3.13'),
  );
  const reader = createAdvisoryReader(limits, { fetch: server.fetch, now: () => 0 });
  if (reader.kind !== 'ready') throw new Error('reader');
  const result = await reader.read({ ecosystem: 'pip', name: 'pyyaml', version: '3.13' });
  reader.close();
  expect(result).toMatchObject({ complete: true, status: 'available' });
  expect(result.records.map((r) => r.id).sort()).toEqual([
    'GHSA-8q59-q68h-6hv4',
    'GHSA-rprw-h62v-c2w7',
  ]);
});

const pyyaml = { ecosystem: 'pip', name: 'pyyaml', version: '3.13' } as const;
const osvQuery = (name: string, version: string) => ({
  package: { ecosystem: 'PyPI', name },
  version,
});
function osvReader(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const reader = createAdvisoryReader(limits, { fetch, now: () => 0 });
  if (reader.kind !== 'ready') throw new Error('reader');
  return reader;
}
/** Answers every OSV query with `body`, recording requests. */
function osvAnswer(...bodies: unknown[]) {
  const requests: { url: string; init: RequestInit; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) as unknown });
    return Response.json(bodies[Math.min(requests.length, bodies.length) - 1]);
  };
  return { fetch, requests };
}
const ghsa = fixture('osv-pyyaml-3.13').body as { vulns: Record<string, unknown>[] };
/** A recorded GitHub-reviewed OSV record, changed for one synthetic case. */
const synthetic = (change: Record<string, unknown>) => ({
  ...ghsa.vulns.find((v) => String(v.id).startsWith('GHSA'))!,
  ...change,
});

test('sends one exact OSV query with only JSON headers', async () => {
  const server = served(fixture('osv-pyyaml-3.13'));
  const reader = osvReader(server.fetch);
  await reader.read(pyyaml);
  reader.close();
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0].url).toBe('https://api.osv.dev/v1/query');
  expect(server.requests[0].body).toEqual(osvQuery('pyyaml', '3.13'));
  expect(server.requests[0].init).toMatchObject({
    method: 'POST',
    credentials: 'omit',
    redirect: 'manual',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
  });
  expect(Object.keys(server.requests[0].init.headers as object).sort()).toEqual([
    'accept',
    'content-type',
  ]);
});
test("OSV's {} is a complete empty lookup that cites the query URL", async () => {
  const reader = osvReader(served(fixture('osv-pyyaml-6.0.2')).fetch);
  const result = await reader.read({ ...pyyaml, version: '6.0.2' });
  reader.close();
  expect(result).toMatchObject({
    complete: true,
    status: 'available',
    records: [],
    url: 'https://api.osv.dev/v1/query',
  });
});
test.each([{ vulns: [], extra: true }, { vulns: {} }, { next_page_token: 7 }, []])(
  'an OSV body shaped %j is malformed, never empty',
  async (body) => {
    const reader = osvReader(osvAnswer(body).fetch);
    expect(await reader.read(pyyaml)).toMatchObject({ complete: false, reasons: ['malformed'] });
    reader.close();
  },
);
test('two pip targets send two OSV queries with their own bodies', async () => {
  const answer = osvAnswer({});
  const reader = osvReader(answer.fetch);
  await reader.read(pyyaml);
  await reader.read({ ecosystem: 'pip', name: 'django', version: '4.2.0' });
  reader.close();
  expect(answer.requests.map((r) => r.body)).toEqual([
    osvQuery('pyyaml', '3.13'),
    osvQuery('django', '4.2.0'),
  ]);
});
test('keeps every same-package range of a Django advisory, in record order', async () => {
  const recorded = fixture('osv-django-4.2.0');
  const reader = osvReader(served(recorded).fetch);
  const result = await reader.read({ ecosystem: 'pip', name: 'django', version: '4.2.0' });
  reader.close();
  expect(result.complete).toBe(true);
  const vulns = (recorded.body as { vulns: { id: string; affected: unknown[] }[] }).vulns;
  const ghsaIds = vulns.filter((v) => v.id.startsWith('GHSA')).map((v) => v.id);
  expect(result.records.map((r) => r.id)).toEqual(ghsaIds);
  const three = vulns.find((v) => v.id.startsWith('GHSA') && v.affected.length === 3)!;
  expect(result.records.find((r) => r.id === three.id)?.range?.split(' || ')).toHaveLength(3);
});
test('keeps only GitHub-reviewed GHSA records and only the target package entries', async () => {
  const reader = osvReader(served(fixture('osv-pillow-8.0.0')).fetch);
  const result = await reader.read({ ecosystem: 'pip', name: 'pillow', version: '8.0.0' });
  reader.close();
  expect(result.complete).toBe(true);
  expect(result.records.map((r) => r.id).sort()).toEqual([
    'GHSA-57h3-9rgr-c24m',
    'GHSA-j7hp-h8jx-5ppr',
    'GHSA-wqgw-9xfh-qf2g',
  ]);
  expect(result.records.find((r) => r.id === 'GHSA-j7hp-h8jx-5ppr')).toMatchObject({
    url: 'https://github.com/advisories/GHSA-j7hp-h8jx-5ppr',
    range: '< 10.0.1',
  });
  // GitHub records these as critical, high, and medium; S1 maps medium to moderate.
  expect(Object.fromEntries(result.records.map((r) => [r.id, r.severity]))).toEqual({
    'GHSA-57h3-9rgr-c24m': 'critical',
    'GHSA-j7hp-h8jx-5ppr': 'high',
    'GHSA-wqgw-9xfh-qf2g': 'moderate',
  });
});
test.each([
  ['pyyaml', '3.13', { 'GHSA-8q59-q68h-6hv4': 'critical', 'GHSA-rprw-h62v-c2w7': 'critical' }],
  [
    'django',
    '4.2.0',
    {
      'GHSA-2mcm-79hx-8fxw': 'low',
      'GHSA-3h9f-r86x-qvjx': 'low',
      'GHSA-8498-2h75-472j': 'moderate',
    },
  ],
] as const)(
  'maps the severity of every recorded %s %s OSV record',
  async (name, version, expected) => {
    const reader = osvReader(served(fixture(`osv-${name}-${version}`)).fetch);
    const result = await reader.read({ ecosystem: 'pip', name, version });
    reader.close();
    expect(result.complete).toBe(true);
    expect(Object.fromEntries(result.records.map((r) => [r.id, r.severity]))).toEqual(expected);
  },
);
test.each([
  ['unreviewed', { database_specific: { github_reviewed: false, severity: 'HIGH' } }],
  ['string-true', { database_specific: { github_reviewed: 'true', severity: 'HIGH' } }],
  ['malformed id', { id: 'GHSA-NOPE' }],
])('a synthetic %s OSV record is excluded', async (_label, change) => {
  const reader = osvReader(osvAnswer({ vulns: [synthetic(change)] }).fetch);
  expect(await reader.read(pyyaml)).toMatchObject({ complete: true, records: [] });
  reader.close();
});
test.each([
  ['withdrawn', { withdrawn: '2026-01-01T00:00:00Z' }, { withdrawn: true }],
  [
    'last_affected',
    {
      affected: [
        {
          package: { ecosystem: 'PyPI', name: 'PyYAML' },
          ranges: [
            { type: 'ECOSYSTEM', events: [{ introduced: '5.1' }, { last_affected: '5.3' }] },
          ],
        },
      ],
    },
    { range: '>= 5.1, <= 5.3' },
  ],
])('maps a synthetic %s OSV record', async (_label, change, expected) => {
  const reader = osvReader(osvAnswer({ vulns: [synthetic(change)] }).fetch);
  const result = await reader.read(pyyaml);
  reader.close();
  expect(result.complete).toBe(true);
  expect(result.records[0]).toMatchObject(expected);
});
const entry = (ranges: unknown) => [{ package: { ecosystem: 'PyPI', name: 'pyyaml' }, ranges }];
test.each([
  ['invalid withdrawn time', { withdrawn: 'yesterday' }, 'malformed'],
  [
    'unexpected severity',
    { database_specific: { github_reviewed: true, severity: 'URGENT' } },
    'malformed',
  ],
  [
    'no matching entry',
    {
      // A well-formed range, so only the ecosystem filter can reject this entry.
      affected: [
        {
          package: { ecosystem: 'npm', name: 'pyyaml' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }],
        },
      ],
    },
    'conflict',
  ],
  [
    'two ranges in one entry',
    {
      affected: entry([
        { type: 'ECOSYSTEM', events: [{ introduced: '0' }] },
        { type: 'ECOSYSTEM', events: [{ introduced: '1' }] },
      ]),
    },
    'conflict',
  ],
  [
    'fixed and last_affected',
    {
      affected: entry([
        {
          type: 'ECOSYSTEM',
          events: [{ introduced: '0' }, { fixed: '2' }, { last_affected: '1' }],
        },
      ]),
    },
    'conflict',
  ],
  [
    'a non-ecosystem range',
    { affected: entry([{ type: 'GIT', events: [{ introduced: '0' }] }]) },
    'conflict',
  ],
])('a synthetic OSV record with %s fails with its fixed reason', async (_label, change, reason) => {
  const reader = osvReader(osvAnswer({ vulns: [synthetic(change)] }).fetch);
  expect(await reader.read(pyyaml)).toMatchObject({ complete: false, reasons: [reason] });
  reader.close();
});
test('follows next_page_token as page_token, even after an empty page', async () => {
  const answer = osvAnswer({ next_page_token: 'p2' }, { vulns: [synthetic({})] });
  const reader = osvReader(answer.fetch);
  const result = await reader.read(pyyaml);
  reader.close();
  expect(result).toMatchObject({ complete: true });
  expect(result.records).toHaveLength(1);
  expect(answer.requests.map((r) => r.body)).toEqual([
    osvQuery('pyyaml', '3.13'),
    { ...osvQuery('pyyaml', '3.13'), page_token: 'p2' },
  ]);
});
test('a repeated page token leaves the lookup incomplete', async () => {
  const reader = osvReader(osvAnswer({ next_page_token: 'same' }).fetch);
  expect(await reader.read(pyyaml)).toMatchObject({ complete: false, reasons: ['conflict'] });
  reader.close();
});
test('an OSV redirect is unsupported', async () => {
  const reader = osvReader(
    async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }),
  );
  expect(await reader.read(pyyaml)).toMatchObject({ complete: false, reasons: ['unsupported'] });
  reader.close();
});

const tj = { ecosystem: 'actions', name: 'TJ-Actions/Changed-Files', version: '45.0.7' } as const;
type Route = (url: URL) => Response | undefined;
/** GitHub-only fake: each route may answer; anything unanswered is a loud 418. */
function github(...routes: Route[]) {
  const requests: string[] = [];
  const fetch = async (url: string) => {
    requests.push(url);
    for (const route of routes) {
      const answer = route(new URL(url));
      if (answer) return answer;
    }
    return Response.json({ message: 'unexpected request' }, { status: 418 });
  };
  const discovery = () => requests.filter((u) => new URL(u).searchParams.get('per_page') === '50');
  const versioned = () => requests.filter((u) => new URL(u).searchParams.get('per_page') === '100');
  return { fetch, requests, discovery, versioned };
}
const isDiscovery = (u: URL) => u.searchParams.get('per_page') === '50';
const ready = (
  factory: typeof createAdvisoryReader,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  overrides = {},
) => {
  const reader = factory({ ...limits, ...overrides }, { fetch, now: () => 0 });
  if (reader.kind !== 'ready') throw new Error('reader');
  return reader;
};

test('an Actions lookup finds the advisory GitHub stores in lowercase', async () => {
  const server = served(
    fixture('github-tj-actions-discovery'),
    fixture('github-tj-actions-versioned'),
  );
  const reader = ready(createAdvisoryReader, server.fetch);
  const result = await reader.read(tj);
  reader.close();
  expect(result).toMatchObject({
    complete: true,
    url: fixture('github-tj-actions-versioned').request.url,
  });
  expect(result.records.map((r) => r.id)).toEqual(['GHSA-mrrh-fwg8-r2c3']);
});
test('base and head share one discovery read, even a failed one', async () => {
  for (const fails of [false, true]) {
    const server = github((u) =>
      isDiscovery(u)
        ? fails
          ? Response.json({}, { status: 500 })
          : Response.json([])
        : Response.json([]),
    );
    const reader = ready(createAdvisoryReader, server.fetch);
    const results = [await reader.read(tj), await reader.read({ ...tj, version: '46.0.1' })];
    reader.close();
    expect(server.discovery()).toHaveLength(1);
    expect(server.versioned()).toHaveLength(fails ? 0 : 2);
    for (const result of results)
      expect(result).toMatchObject(
        fails ? { complete: false, reasons: ['unknown'], url: '' } : { complete: true },
      );
    if (!fails)
      expect(new URL(results[0].url).searchParams.get('affects')).toBe(
        'TJ-Actions/Changed-Files@45.0.7',
      );
  }
});
test('a discovery record that names no spelling of the package is malformed', async () => {
  const stray = (fixture('github-tj-actions-discovery').body as Record<string, unknown>[]).map(
    (r) => ({
      ...r,
      vulnerabilities: [
        { package: { ecosystem: 'actions', name: 'other/action' }, vulnerable_version_range: '<1' },
      ],
    }),
  );
  const server = github((u) => (isDiscovery(u) ? Response.json(stray) : undefined));
  const reader = ready(createAdvisoryReader, server.fetch);
  expect(await reader.read(tj)).toMatchObject({ complete: false, reasons: ['malformed'] });
  reader.close();
  expect(server.versioned()).toHaveLength(0);
});
test('stored forms whose versioned URL exceeds the citation bound are unsupported', async () => {
  const name = 'some-owner/' + 'a'.repeat(60);
  const forms = Array.from({ length: 20 }, (_, i) => {
    const at = 'some-owner/'.length + i;
    return name.slice(0, at) + name[at].toUpperCase() + name.slice(at + 1);
  });
  const many = [
    {
      ...(fixture('github-tj-actions-discovery').body as Record<string, unknown>[])[0],
      vulnerabilities: forms.map((f) => ({
        package: { ecosystem: 'actions', name: f },
        vulnerable_version_range: '<1',
      })),
    },
  ];
  const server = github((u) => (isDiscovery(u) ? Response.json(many) : undefined));
  const reader = ready(createAdvisoryReader, server.fetch);
  expect(await reader.read({ ecosystem: 'actions', name, version: '1.0.0' })).toMatchObject({
    complete: false,
    reasons: ['unsupported'],
  });
  reader.close();
  expect(server.versioned()).toHaveLength(0);
});
test('an OSV rate limit stops OSV requests but not a GitHub Actions lookup', async () => {
  const tjServed = served(
    fixture('github-tj-actions-discovery'),
    fixture('github-tj-actions-versioned'),
  );
  let osvCalls = 0;
  const reader = ready(createAdvisoryReader, async (url, init) => {
    if (url.startsWith('https://api.osv.dev/')) {
      osvCalls++;
      return Response.json({}, { status: 429 });
    }
    return tjServed.fetch(url, init);
  });
  expect(await reader.read(pyyaml)).toMatchObject({ complete: false, reasons: ['rate_limit'] });
  expect(await reader.read({ ...pyyaml, version: '5.4' })).toMatchObject({
    reasons: ['rate_limit'],
  });
  expect(await reader.read(tj)).toMatchObject({ complete: true });
  reader.close();
  expect(osvCalls).toBe(1);
});

const flo = { ecosystem: 'pip', name: 'flo-pro-adk', version: '1.0.0' } as const;
test('a pip malware lookup discovers every separator spelling, then queries the stored form', async () => {
  const server = served(
    fixture('github-flo-pro-adk-malware-discovery'),
    fixture('github-flo-pro-adk-malware-versioned'),
  );
  const reader = ready(createMalwareReader, server.fetch);
  const result = await reader.read(flo);
  reader.close();
  expect(result).toMatchObject({ complete: true });
  expect(result.records.map((r) => r.id)).toEqual(['GHSA-q9fg-wfvh-ggp3']);
  const discovery = new URL(server.requests[0].url);
  expect(discovery.searchParams.get('type')).toBe('malware');
  expect(discovery.searchParams.get('affects')?.split(',')).toHaveLength(9);
});
const long = {
  ecosystem: 'pip',
  name: 'opentelemetry-exporter-otlp-proto-http-extra',
  version: '1.0.0',
} as const;
const spellingsOf = (urls: string[]) =>
  urls.flatMap((u) => new URL(u).searchParams.get('affects')!.split(','));
test('a long name splits discovery so every spelling is sent once with cursor headroom', async () => {
  const server = github(() => Response.json([]));
  const reader = ready(createMalwareReader, server.fetch);
  const result = await reader.read(long);
  reader.close();
  expect(result).toMatchObject({ complete: true });
  const urls = server.discovery();
  expect(urls.length).toBeGreaterThan(1);
  for (const u of urls) expect(u.length).toBeLessThanOrEqual(4096 - 256);
  const sent = spellingsOf(urls);
  expect(sent).toHaveLength(243);
  expect(new Set(sent).size).toBe(243);
  expect(sent).toContain('opentelemetry_exporter.otlp-proto_http.extra');
  expect(new URL(result.url).searchParams.get('affects')).toBe(`${long.name}@1.0.0`);
});
test('a continuation URL over the discovery cap is a budget gap', async () => {
  const server = github((u) => {
    if (!isDiscovery(u) || u.searchParams.has('after')) return undefined;
    const next = new URL(u);
    next.searchParams.set('after', 'c'.repeat(600));
    return Response.json([], { headers: { link: `<${next.href}>; rel="next"` } });
  });
  const reader = ready(createMalwareReader, server.fetch);
  expect(await reader.read(long)).toMatchObject({ complete: false, reasons: ['budget'] });
  reader.close();
  expect(server.requests).toHaveLength(1);
});
test('a failure in a later split request sends no versioned query', async () => {
  let discovery = 0;
  const server = github((u) =>
    isDiscovery(u)
      ? ++discovery === 2
        ? Response.json({}, { status: 503 })
        : Response.json([])
      : undefined,
  );
  const reader = ready(createMalwareReader, server.fetch);
  expect(await reader.read(long)).toMatchObject({ complete: false, reasons: ['unknown'] });
  reader.close();
  expect(server.versioned()).toHaveLength(0);
});
test('a name over the spelling ceiling sends no request', async () => {
  const server = github(() => Response.json([]));
  const reader = ready(createMalwareReader, server.fetch);
  expect(await reader.read({ ...long, name: 'a-b-c-d-e-f-g' })).toMatchObject({
    complete: false,
    reasons: ['unsupported'],
  });
  reader.close();
  expect(server.requests).toHaveLength(0);
});
test('a stored name differing in case and separator counts, and every form is queried', async () => {
  // Synthetic: recorded jupyter-server discovery records, retyped as malware, one stored name changed.
  const records = (
    fixture('github-jupyter-server-discovery').body as Record<string, unknown>[]
  ).map((r) => ({
    ...r,
    type: 'malware',
    vulnerabilities: (r.vulnerabilities as { package: { ecosystem: string; name: string } }[]).map(
      (v) =>
        r.ghsa_id === 'GHSA-24qx-w28j-9m6p'
          ? { ...v, package: { ...v.package, name: 'Jupyter_Server' } }
          : v,
    ),
  }));
  const server = github((u) => (isDiscovery(u) ? Response.json(records) : Response.json([])));
  const reader = ready(createMalwareReader, server.fetch);
  const result = await reader.read({ ecosystem: 'pip', name: 'jupyter-server', version: '2.17.0' });
  reader.close();
  expect(result).toMatchObject({ complete: true });
  expect(new URL(server.versioned()[0]).searchParams.get('affects')).toBe(
    'Jupyter_Server@2.17.0,jupyter-server@2.17.0,jupyter_server@2.17.0',
  );
});
test('reviewed Actions discovery and malware discovery use their own query types', async () => {
  for (const [factory, type] of [
    [createAdvisoryReader, 'reviewed'],
    [createMalwareReader, 'malware'],
  ] as const) {
    const server = github(() => Response.json([]));
    const reader = ready(factory, server.fetch);
    await reader.read(tj);
    reader.close();
    expect(server.requests.map((u) => new URL(u).searchParams.get('type'))).toEqual([type, type]);
  }
});

test.each([
  ['pip', 'fixture'],
  ['actions', 'fixture/action'],
] as const)(
  'a %s malware lookup keeps a positive found before its last page fails',
  async (ecosystem, name) => {
    const positive = {
      ghsa_id: 'GHSA-aaaa-bbbb-cccc',
      html_url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      summary: 'Synthetic malware',
      type: 'malware',
      severity: null,
      withdrawn_at: null,
      vulnerabilities: [{ package: { ecosystem, name }, vulnerable_version_range: '= 1.0.0' }],
    };
    const server = github((u) => {
      if (isDiscovery(u)) return Response.json([]);
      if (u.searchParams.has('after')) return Response.json({}, { status: 503 });
      const next = new URL(u);
      next.searchParams.set('after', 'page-2');
      return Response.json([positive], { headers: { link: `<${next.href}>; rel="next"` } });
    });
    const reader = ready(createMalwareReader, server.fetch);
    const result = await reader.read({ ecosystem, name, version: '1.0.0' });
    reader.close();
    expect(server.discovery()).toHaveLength(1);
    expect(result).toMatchObject({
      complete: false,
      status: 'partial',
      reasons: ['unknown'],
      records: [{ id: 'GHSA-aaaa-bbbb-cccc' }],
    });
  },
);
test('an exact-version advisory entry arrives from OSV as its own range and is kept', async () => {
  const reader = osvReader(served(fixture('osv-jupyter-server-1.0.0')).fetch);
  const result = await reader.read({ ecosystem: 'pip', name: 'jupyter-server', version: '1.0.0' });
  reader.close();
  expect(result).toMatchObject({ complete: true });
  expect(result.records.find((r) => r.id === 'GHSA-q874-g24w-4q9g')?.range).toBe(
    '< 1.17.1 || >= 2.0.0a0, < 2.0.0a1',
  );
});

// Fail-secure gaps from the fresh-context review: each malformed record must leave the lookup
// incomplete, never complete and empty.
test.each([
  ['a non-object record', { vulns: [1] }],
  ['a non-array affected list', { vulns: [synthetic({ affected: {} })] }],
  ['a record with no summary', { vulns: [synthetic({ summary: undefined })] }],
])('an OSV response with %s is malformed', async (_label, body) => {
  const reader = osvReader(osvAnswer(body).fetch);
  expect(await reader.read(pyyaml)).toMatchObject({
    complete: false,
    records: [],
    reasons: ['malformed'],
  });
  reader.close();
});
test.each([
  ['a duplicate event', [{ introduced: '0' }, { introduced: '1' }, { fixed: '2' }]],
  ['no introduced event', [{ fixed: '2' }]],
  ['a two-key event', [{ introduced: '0', fixed: '2' }]],
])('an OSV range with %s is a conflict', async (_label, events) => {
  const reader = osvReader(
    osvAnswer({ vulns: [synthetic({ affected: entry([{ type: 'ECOSYSTEM', events }]) })] }).fetch,
  );
  expect(await reader.read(pyyaml)).toMatchObject({ complete: false, reasons: ['conflict'] });
  reader.close();
});
test('a null OSV withdrawn time is an active record', async () => {
  const reader = osvReader(osvAnswer({ vulns: [synthetic({ withdrawn: null })] }).fetch);
  const result = await reader.read(pyyaml);
  reader.close();
  expect(result).toMatchObject({ complete: true, records: [{ withdrawn: false }] });
});
test('OSV records from an earlier page survive a later page failure', async () => {
  const requests: unknown[] = [];
  const reader = osvReader(async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    return requests.length === 1
      ? Response.json({ vulns: [synthetic({})], next_page_token: 'p2' })
      : Response.json({}, { status: 503 });
  });
  const result = await reader.read(pyyaml);
  reader.close();
  expect(result).toMatchObject({ complete: false, status: 'partial', reasons: ['unknown'] });
  expect(result.records).toHaveLength(1);
});
test('the OSV body carries the normalized name with its separators', async () => {
  const answer = osvAnswer({});
  const reader = osvReader(answer.fetch);
  await reader.read({ ecosystem: 'pip', name: 'jupyter-server', version: '1.0.0' });
  reader.close();
  expect(answer.requests[0].body).toEqual(osvQuery('jupyter-server', '1.0.0'));
});
test('a GitHub rate limit stops GitHub requests but not an OSV lookup', async () => {
  let github = 0;
  const reader = ready(createAdvisoryReader, async (url) => {
    if (url.startsWith('https://api.osv.dev/')) return Response.json({ vulns: [synthetic({})] });
    github++;
    return Response.json({}, { status: 429 });
  });
  expect(await reader.read(tj)).toMatchObject({ complete: false, reasons: ['rate_limit'] });
  expect(await reader.read({ ...tj, version: '46.0.1' })).toMatchObject({
    reasons: ['rate_limit'],
  });
  // The OSV body streams after GitHub stopped, so this also checks the provider of each body read.
  expect(await reader.read(pyyaml)).toMatchObject({ complete: true, records: [{}] });
  reader.close();
  expect(github).toBe(1);
});
test('close stops OSV lookups too', async () => {
  const answer = osvAnswer({});
  const reader = osvReader(answer.fetch);
  reader.close();
  expect(await reader.read(pyyaml)).toMatchObject({ complete: false, reasons: ['unknown'] });
  expect(answer.requests).toHaveLength(0);
});
test.each([
  [
    'an invalid range',
    [{ package: { ecosystem: 'npm', name: 'widget' }, vulnerable_version_range: '' }],
  ],
  [
    'no entry for the package',
    [{ package: { ecosystem: 'npm', name: 'other' }, vulnerable_version_range: '<1' }],
  ],
])('a GitHub record with %s is a conflict', async (_label, vulnerabilities) => {
  const record = {
    ...(fixture('github-tj-actions-versioned').body as Record<string, unknown>[])[0],
    vulnerabilities,
  };
  const reader = ready(createAdvisoryReader, async () => Response.json([record]));
  expect(await reader.read({ ecosystem: 'npm', name: 'widget', version: '1.0.0' })).toMatchObject({
    complete: false,
    reasons: ['conflict'],
  });
  reader.close();
});

// Exact boundaries: each value at the limit is allowed, and one byte more is not.
const queryUrl = (ecosystem: string, affects: string[], type: string, perPage: string) => {
  const url = new URL('https://api.github.com/advisories');
  url.search = new URLSearchParams({
    ecosystem,
    affects: affects.join(','),
    type,
    per_page: perPage,
  }).toString();
  return url.href;
};
test('a versioned URL of exactly 1,024 bytes is sent; one byte longer is unsupported', async () => {
  const fixed = queryUrl('actions', ['o/@1.0.0'], 'reviewed', '100').length;
  for (const extra of [0, 1]) {
    const name = 'o/' + 'a'.repeat(1024 - fixed + extra);
    const server = github(() => Response.json([]));
    const reader = ready(createAdvisoryReader, server.fetch);
    const result = await reader.read({ ecosystem: 'actions', name, version: '1.0.0' });
    reader.close();
    if (extra === 0) {
      expect(server.versioned()[0].length).toBe(1024);
      expect(result.complete).toBe(true);
    } else {
      expect(result).toMatchObject({ complete: false, reasons: ['unsupported'] });
      expect(server.versioned()).toHaveLength(0);
    }
  }
});
test('discovery fills a request up to exactly 256 bytes under the cap', async () => {
  // Find a five-separator name whose spellings fill one request to exactly 3,840 bytes.
  let found: { name: string; count: number } | undefined;
  for (let n = 1; n < 400 && !found; n++) {
    const name = 'p'.repeat(n) + '-b-c-d-e-f';
    const fixed = queryUrl('pip', [name], 'malware', '50').length - name.length;
    const room = 4096 - 256 - fixed + 3;
    if (room % (name.length + 3) === 0 && room / (name.length + 3) <= 243)
      found = { name, count: room / (name.length + 3) };
  }
  if (!found) throw new Error('no exact-fill name');
  const server = github(() => Response.json([]));
  const reader = ready(createMalwareReader, server.fetch);
  await reader.read({ ecosystem: 'pip', name: found.name, version: '1.0.0' });
  reader.close();
  const first = server.discovery()[0];
  expect(first.length).toBe(4096 - 256);
  expect(new URL(first).searchParams.get('affects')!.split(',')).toHaveLength(found.count);
});
test('a continuation URL of exactly 4,096 bytes is followed; one byte longer is budget', async () => {
  for (const extra of [0, 1]) {
    let followed = false;
    const server = github((u) => {
      if (!isDiscovery(u)) return Response.json([]);
      if (u.searchParams.has('after')) {
        followed = true;
        return Response.json([]);
      }
      const next = new URL(u);
      next.searchParams.set('after', 'c');
      const cursor = 'c'.repeat(1 + 4096 - next.href.length + extra);
      next.searchParams.set('after', cursor);
      return Response.json([], { headers: { link: `<${next.href}>; rel="next"` } });
    });
    const reader = ready(createMalwareReader, server.fetch);
    const result = await reader.read(long);
    reader.close();
    expect(followed).toBe(extra === 0);
    if (extra === 1) expect(result).toMatchObject({ complete: false, reasons: ['budget'] });
  }
});

test('one run cache answers each pip package from its own OSV query', async () => {
  // Every OSV query is a POST to one URL, so only the request body tells two packages apart.
  const server = served(fixture('osv-pyyaml-3.13'), fixture('osv-django-4.2.0'));
  const cache = createResearchCache({ maxEntryBytes: 1_048_576, maxTotalBytes: 8_388_608 });
  const read = async (name: string, version: string) => {
    const reader = createAdvisoryReader(limits, { fetch: server.fetch, now: () => 0, cache });
    if (reader.kind !== 'ready') throw new Error('reader');
    const result = await reader.read({ ecosystem: 'pip', name, version });
    reader.close();
    return result;
  };
  const yaml = await read('pyyaml', '3.13');
  const django = await read('django', '4.2.0');
  const again = await read('django', '4.2.0');
  expect(yaml).toMatchObject({ complete: true, status: 'available' });
  expect(django).toMatchObject({ complete: true, status: 'available' });
  expect(django.records.map((r) => r.id).sort()).toEqual(
    (fixture('osv-django-4.2.0').body as { vulns: { id: string }[] }).vulns
      .map((v) => v.id)
      .filter((id) => id.startsWith('GHSA'))
      .sort(),
  );
  expect(again.records).toEqual(django.records);
  expect(server.requests.map((r) => r.body)).toEqual([
    osvQuery('pyyaml', '3.13'),
    osvQuery('django', '4.2.0'),
  ]);
});
