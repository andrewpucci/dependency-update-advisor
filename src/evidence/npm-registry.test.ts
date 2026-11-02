import { expect, test, vi } from 'vite-plus/test';
import { createNpmRegistryReader, interpretNpmLifecycle } from './npm-registry.js';
import type { PacketChange, NpmSide } from '../schema.js';
import type { NpmNode } from './npm.js';

const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const request = {
  name: '@fixture/widget',
  version: '1.2.3',
  integrity,
  source: {
    kind: 'registry',
    identity: 'https://registry.npmjs.org/@fixture/widget/-/widget-1.2.3.tgz',
  },
};
const limits = {
  maxRequests: 10,
  maxResponseBytes: 50_000,
  maxTotalBytes: 500_000,
  maxJsonEntries: 10_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 500_000,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
function document(extra = {}) {
  return {
    _id: '@fixture/widget@1.2.3',
    name: request.name,
    version: request.version,
    dist: { integrity },
    scripts: { test: 'node --test' },
    ...extra,
  };
}
function reader(response: unknown = document(), overrides = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const created = createNpmRegistryReader(
    { ...limits, ...overrides },
    {
      now: () => 0,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response instanceof Response
          ? response
          : new Response(JSON.stringify(response), {
              headers: { 'content-type': 'application/json' },
            });
      },
    },
  );
  if (created.kind !== 'ready') throw new Error('expected reader');
  return { ...created, calls };
}

test('reads full exact-version metadata using a locally constructed credential-free request', async () => {
  const f = reader();
  const result = await f.read(request);
  expect(result.kind).toBe('metadata');
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].url).toBe('https://registry.npmjs.org/%40fixture%2Fwidget/1.2.3');
  expect(f.calls[0].init).toMatchObject({
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    headers: { accept: 'application/json' },
  });
  expect(JSON.stringify(f.calls)).not.toContain('Authorization');
  if (result.kind === 'metadata') {
    expect(result.document.name).toBe(request.name);
    expect(Object.isFrozen(result.document)).toBe(true);
  }
});

test.each([
  ['wrong version', document({ version: '9.9.9' })],
  ['wrong name', document({ name: 'other' })],
  [
    'wrong integrity',
    document({ dist: { integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64') } }),
  ],
  [
    'abbreviated content',
    new Response(JSON.stringify(document()), {
      headers: { 'content-type': 'application/vnd.npm.install-v1+json' },
    }),
  ],
  ['abbreviated object', document({ _id: undefined })],
  [
    'redirect',
    new Response(null, { status: 302, headers: { location: 'https://example.com/private' } }),
  ],
])('keeps %s unresolved', async (_name, value) => {
  const result = await reader(value).read(request);
  expect(result.kind).toBe('unavailable');
});

test('never contacts a custom/private source or queries an unbound artifact', async () => {
  const f = reader();
  for (const identity of [
    'https://private.example/widget.tgz',
    'https://user:password@registry.npmjs.org/widget.tgz',
  ]) {
    expect(await f.read({ ...request, source: { kind: 'registry', identity } })).toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported',
    });
  }
  expect(await f.read({ ...request, integrity: null })).toMatchObject({
    kind: 'unavailable',
    reason: 'missing',
  });
  expect(f.calls).toHaveLength(0);
});

test('binds every cached use to its own integrity and keeps caches attempt-local', async () => {
  const f = reader();
  expect((await f.read(request)).kind).toBe('metadata');
  expect((await f.read(request)).kind).toBe('metadata');
  expect(f.calls).toHaveLength(1);
  expect(
    await f.read({ ...request, integrity: 'sha512-' + Buffer.alloc(64, 3).toString('base64') }),
  ).toMatchObject({ kind: 'unavailable', reason: 'conflict' });
  const other = reader();
  expect((await other.read(request)).kind).toBe('metadata');
  expect(other.calls).toHaveLength(1);
});

test('matches sha1 integrity against dist.shasum', async () => {
  const sha = Buffer.alloc(20, 6);
  const result = await reader(document({ dist: { shasum: sha.toString('hex') } })).read({
    ...request,
    integrity: 'sha1-' + sha.toString('base64'),
  });
  expect(result.kind).toBe('metadata');
});

test.each([
  { maxResponseBytes: 8 },
  { maxRetainedBytes: 8 },
  { maxJsonEntries: 1 },
  { maxJsonDepth: 1 },
])('enforces response, retention, entry, and depth bounds: %j', async (override) => {
  expect(await reader(document(), override).read(request)).toMatchObject({
    kind: 'unavailable',
    reason: 'budget',
  });
});

test('a request budget stops subsequent uncached reads', async () => {
  const f = reader(document(), { maxRequests: 1 });
  await f.read(request);
  expect(await f.read({ ...request, version: '1.2.4' })).toMatchObject({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(f.calls).toHaveLength(1);
});

test('cancellation stops an ignored fetch and all subsequent reads', async () => {
  const controller = new AbortController();
  let calls = 0;
  const created = createNpmRegistryReader(limits, {
    now: () => 0,
    signal: controller.signal,
    fetch: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  if (created.kind !== 'ready') throw new Error('expected reader');
  const pending = created.read(request);
  controller.abort();
  expect(await pending).toMatchObject({ kind: 'unavailable', reason: 'unknown' });
  expect(await created.read(request)).toMatchObject({ kind: 'unavailable', reason: 'unknown' });
  expect(calls).toBe(1);
});

test('request deadlines bound a fetch and stalled body even when transport ignores abort', async () => {
  vi.useFakeTimers();
  try {
    for (const fetch of [
      async () => new Promise<Response>(() => {}),
      async () =>
        new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
          headers: { 'content-type': 'application/json' },
        }),
    ]) {
      const created = createNpmRegistryReader(limits, { now: () => 0, fetch });
      if (created.kind !== 'ready') throw new Error('expected reader');
      const pending = created.read(request);
      await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs);
      expect(await pending).toMatchObject({ kind: 'unavailable', reason: 'timeout' });
    }
  } finally {
    vi.useRealTimers();
  }
});

test('total deadlines and byte exhaustion stop later requests', async () => {
  let time = 0,
    calls = 0;
  const created = createNpmRegistryReader(limits, {
    now: () => time,
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify(document()), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  if (created.kind !== 'ready') throw new Error('expected reader');
  time = limits.totalTimeoutMs;
  expect(await created.read(request)).toMatchObject({ reason: 'timeout' });
  expect(calls).toBe(0);
  const size = Buffer.byteLength(JSON.stringify(document()));
  const f = reader(document(), { maxResponseBytes: size + 1, maxTotalBytes: 2 * size - 1 });
  expect((await f.read(request)).kind).toBe('metadata');
  expect(await f.read({ ...request, version: '1.2.4' })).toMatchObject({ reason: 'budget' });
  expect(await f.read({ ...request, version: '1.2.5' })).toMatchObject({ reason: 'budget' });
  expect(f.calls).toHaveLength(2);
});

test('rejects hostile descriptors without invoking them', async () => {
  let invoked = false;
  const value = {
    ...request,
    get integrity() {
      invoked = true;
      throw new Error('sensitive');
    },
  };
  const result = await reader().read(value);
  expect(result).toEqual({ kind: 'unavailable', reason: 'malformed' });
  expect(invoked).toBe(false);
});

test('disposes an unexpected redirect body without reading it', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    {
      status: 302,
      headers: { location: 'http://localhost/private' },
    },
  );
  expect(await reader(response).read(request)).toMatchObject({ reason: 'unsupported' });
  expect(cancelled).toBe(true);
});

async function lifecycleSide(
  version: string,
  signal: boolean | null,
  scripts: Record<string, string> = {},
  extra = {},
) {
  const instance: NpmSide = {
    root: '.',
    lockPath: 'node_modules/widget',
    name: request.name,
    version,
    source: { ...request.source, kind: 'registry' },
    sourceId: version === '1.2.2' ? 'base-lock' : 'head-lock',
  };
  const metadata = await reader(
    document({ _id: request.name + '@' + version, version, scripts, ...extra }),
  ).read({ ...request, version });
  const node: NpmNode = {
    instance,
    integrity,
    hasInstallScript: signal,
    dependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
    link: null,
  };
  return { node, metadata };
}
function lifecycleChange(from: NpmSide | null, to: NpmSide | null): PacketChange {
  return {
    id: 'changed-widget',
    ecosystem: 'npm',
    kind: from ? (to ? 'update' : 'removal') : 'addition',
    role: 'transitive',
    from,
    to,
    evidence: {},
  };
}

test.each([null, false])(
  'no explicit command is complete with a %s lock signal and full bound metadata',
  async (signal) => {
    const head = await lifecycleSide('1.2.3', signal);
    const result = interpretNpmLifecycle(lifecycleChange(null, head.node.instance), { head });
    expect(result.change.evidence.installScript).toMatchObject({
      status: 'available',
      reasons: [],
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: 'informational',
        detail: expect.stringContaining('implicit'),
      }),
    );
    expect(result.findings.some((f) => f.kind === 'supplyChainChange')).toBe(false);
  },
);

test.each([
  [null, { install: 'node setup.js' }, {}],
  [true, {}, {}],
  [false, {}, { gypfile: true }],
] as const)(
  'conflicting lock and command facts stay unresolved (%s)',
  async (signal, scripts, extra) => {
    const head = await lifecycleSide('1.2.3', signal, scripts, extra);
    const result = interpretNpmLifecycle(lifecycleChange(null, head.node.instance), { head });
    expect(result.change.evidence.installScript.status).not.toBe('available');
    expect(result.change.evidence.installScript.reasons).toContain('conflict');
    expect(result.findings.some((f) => f.kind === 'supplyChainChange')).toBe(false);
  },
);

test('changed commands under an unchanged true flag produce a finding bound to both sides', async () => {
  const base = await lifecycleSide('1.2.2', true, { install: 'node old.js' });
  const head = await lifecycleSide('1.2.3', true, { install: 'node new.js' });
  const change = lifecycleChange(base.node.instance, head.node.instance);
  const result = interpretNpmLifecycle(change, { base, head });
  expect(result.change.evidence.installScript.status).toBe('available');
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      kind: 'supplyChainChange',
      change: 'install_script',
      memberId: change.id,
      references: result.change.evidence.installScript.sourceIds,
    }),
  );
  expect(
    result.sources.flatMap((s) => (s.provenance.kind === 'upstream' ? s.provenance.subjects : [])),
  ).toEqual(
    expect.arrayContaining([
      { memberId: change.id, side: 'base', value: '1.2.2' },
      { memberId: change.id, side: 'head', value: '1.2.3' },
    ]),
  );
  expect(change.evidence).toEqual({});
});

test('a missing side never becomes a verified changed-script finding', async () => {
  const head = await lifecycleSide('1.2.3', true, { install: 'node new.js' });
  const base = await lifecycleSide('1.2.2', true, { install: 'node old.js' });
  const result = interpretNpmLifecycle(lifecycleChange(base.node.instance, head.node.instance), {
    head,
  });
  expect(result.change.evidence.installScript.status).toBe('partial');
  expect(result.findings.some((f) => f.kind === 'supplyChainChange')).toBe(false);
});

test('removed commands and removed packages are observations, not proposed-risk findings', async () => {
  const base = await lifecycleSide('1.2.2', true, { install: 'node old.js' });
  const head = await lifecycleSide('1.2.3', null);
  for (const change of [
    lifecycleChange(base.node.instance, head.node.instance),
    lifecycleChange(base.node.instance, null),
  ]) {
    const result = interpretNpmLifecycle(change, { base, head });
    expect(result.change.evidence.installScript.status).toBe('available');
    expect(result.findings.some((f) => f.kind === 'supplyChainChange')).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: 'informational',
        detail: expect.stringContaining('removed'),
      }),
    );
  }
});

test('identical commands do not produce a changed-script finding and command text never enters excerpts', async () => {
  const command = 'node setup.js\nnode finish.js';
  const base = await lifecycleSide('1.2.2', true, { install: command });
  const head = await lifecycleSide('1.2.3', true, { install: command }, { gypfile: true });
  const result = interpretNpmLifecycle(lifecycleChange(base.node.instance, head.node.instance), {
    base,
    head,
  });
  expect(result.change.evidence.installScript.status).toBe('available');
  expect(result.findings.some((f) => f.kind === 'supplyChainChange')).toBe(false);
  expect(JSON.stringify(result.sources)).not.toContain('setup.js');
});

test('declarations retain empty evidence and acquire no lifecycle claims', () => {
  const change: PacketChange = {
    id: 'declaration',
    ecosystem: 'npm',
    basis: 'declaration',
    role: 'direct',
    kind: 'addition',
    from: null,
    to: { root: '.', name: 'widget', specifiers: { dependencies: '^1' }, sourceId: 'manifest' },
    evidence: {},
  };
  expect(interpretNpmLifecycle(change, {})).toEqual({ change, sources: [], findings: [] });
});
