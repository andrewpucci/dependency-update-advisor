import { expect, test, vi } from 'vite-plus/test';
const collisions = vi.hoisted(() => ({ source: false }));
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    createHash: (algorithm: string) => {
      const actual = original.createHash(algorithm);
      return {
        update: (value: string) => {
          actual.update(value);
          return {
            digest: (encoding: 'hex') =>
              collisions.source && value.includes(',"source",')
                ? '0'.repeat(64)
                : actual.digest(encoding),
          };
        },
      };
    },
  };
});
import { collectUvMetadata } from './uv.js';
import type { ReviewBinding } from '../event.js';
import type {
  GithubComparison,
  GithubDiscovery,
  GithubFileResult,
  GithubReadSession,
} from '../github-read.js';
const repository = { id: 101, owner: 'example', name: 'consumer' },
  BASE = 'b'.repeat(40),
  HEAD = 'a'.repeat(40);
const binding: ReviewBinding = {
  repository,
  workflow: { id: 301, path: '.github/workflows/ci.yml' },
  runId: 401,
  runAttempt: 1,
  pullNumber: 42,
  headRepository: repository,
  headSha: HEAD,
  baseRef: 'main',
  baseSha: BASE,
  mergeBaseSha: BASE,
  actorId: 201,
  conclusion: 'success',
  identity: [101, 301, 401, 1, 42, HEAD],
};
const manifest = '[project]\nname="project"\ndependencies=["orbit>=1"]\n';
function lock(revision = 3) {
  return `version=1\nrevision=${revision}\nrequires-python=">=3.11"\n[[package]]\nname="project"\nsource={editable="."}\n[package.metadata]\nrequires-dist=[{name="orbit",specifier=">=1"}]\n[[package]]\nname="orbit"\nversion="1.0"\nsource={registry="https://pypi.org/simple"}\n`;
}
function fixture() {
  const input = {
    binding: structuredClone(binding),
    roots: ['.'],
    configRevision: { repository: structuredClone(repository), sha: BASE },
    limits: {
      maxFileBytes: 100000,
      maxTomlDepth: 32,
      maxTomlEntries: 100000,
      maxPackages: 1000,
      maxDeclarations: 1000,
      maxEdges: 1000,
      maxStringBytes: 4096,
      maxRequirementTokens: 200,
      maxMarkerDepth: 16,
      maxRoots: 20,
      maxRetainedBytes: 1000000,
    },
  };
  const discovery: { -readonly [K in keyof GithubDiscovery]: GithubDiscovery[K] } = {
    kind: 'available',
    binding: structuredClone(binding),
    complete: true,
    reasons: [],
    files: [{ path: 'pyproject.toml', previousPath: null, status: 'modified', blobSha: null }],
  };
  const comparison: { -readonly [K in keyof GithubComparison]: GithubComparison[K] } = {
    kind: 'available',
    repository,
    headRepository: repository,
    baseSha: BASE,
    headSha: HEAD,
    mergeBaseSha: BASE,
    records: [],
    reasons: [],
  };
  const files: Record<string, string | GithubFileResult> = {
    'base:pyproject.toml': manifest,
    'head:pyproject.toml': manifest,
    'base:uv.lock': lock(3),
    'head:uv.lock': lock(5),
  };
  const calls: string[] = [];
  const session: GithubReadSession = {
    discoverFiles: async () => {
      calls.push('discover');
      return discovery;
    },
    readFile: async (request) => {
      const { side, path } = request as { side: 'base' | 'head'; path: string };
      calls.push(`${side}:${path}`);
      const provenance = {
        side,
        path,
        repository: side === 'base' ? input.binding.repository : input.binding.headRepository,
        commitSha: side === 'base' ? BASE : HEAD,
      };
      const value = files[`${side}:${path}`];
      if (value === undefined) return { ...provenance, kind: 'absent', treeSha: 'd'.repeat(40) };
      if (typeof value !== 'string') return value;
      return {
        ...provenance,
        kind: 'available',
        blobSha: 'e'.repeat(40),
        bytes: new TextEncoder().encode(value),
      };
    },
    readComparison: async () => {
      calls.push('comparison');
      return comparison;
    },
    close: () => {
      calls.push('close');
    },
  };
  return { input, discovery, comparison, files, calls, session };
}
function metadata(r: Awaited<ReturnType<typeof collectUvMetadata>>) {
  expect(r.kind).toBe('metadata');
  if (r.kind !== 'metadata') throw new Error('expected metadata');
  return r;
}
test('reads immutable companions on both sides and exposes metadata without final inventory claims', async () => {
  const f = fixture(),
    r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(f.calls).toEqual([
    'discover',
    'base:pyproject.toml',
    'base:uv.lock',
    'head:pyproject.toml',
    'head:uv.lock',
    'comparison',
  ]);
  expect(r.gaps).toEqual([]);
  expect(r.roots[0].base.state).toBe('present');
  expect(r.roots[0].head.lock.data?.revision).toBe(5);
  expect(r.roots[0].base.manifest.data?.dependencies[0].name).toBe('orbit');
  expect(r.sources).toHaveLength(4);
  expect(r.sources.map((s) => s.side).sort()).toEqual(['base', 'base', 'head', 'head']);
  for (const key of ['changes', 'coverage', 'relationships', 'role'])
    expect(Object.hasOwn(r, key)).toBe(false);
  expect(r.sources.some((s) => Object.hasOwn(s, 'memberIds'))).toBe(false);
  expect(r.discovery).toMatchObject({ status: 'available', complete: true, applicable: true });
});
test('validates external input and provenance before any session reads', async () => {
  const f = fixture();
  for (const input of [
    { ...f.input, roots: ['../outside'] },
    { ...f.input, roots: ['/private/path'] },
    { ...f.input, roots: ['a:a'] },
    { ...f.input, roots: ['.', '.'] },
    { ...f.input, limits: { ...f.input.limits, maxPackages: 0 } },
    { ...f.input, configRevision: { repository: { ...repository, id: 9 }, sha: BASE } },
  ])
    expect(await collectUvMetadata(input, { session: f.session })).toEqual({ kind: 'invalid' });
  const accessor = Object.defineProperty({}, 'binding', {
    get() {
      throw new Error('should not read');
    },
    enumerable: true,
  });
  expect(await collectUvMetadata(accessor, { session: f.session })).toEqual({ kind: 'invalid' });
  expect(f.calls).toEqual([]);
});
test('obsolete discovery discards the attempt; mismatched discovery cannot produce metadata', async () => {
  const f = fixture();
  f.discovery.kind = 'obsolete';
  expect(await collectUvMetadata(f.input, { session: f.session })).toEqual({ kind: 'obsolete' });
  expect(f.calls).toEqual(['discover']);
  f.discovery.kind = 'available';
  f.discovery.binding = { ...f.input.binding, headSha: 'f'.repeat(40) };
  expect(await collectUvMetadata(f.input, { session: f.session })).toEqual({
    kind: 'unavailable',
    reason: 'conflict',
  });
});
test('nested and unconfigured changed roots remain selected; unchanged configured roots are not fetched', async () => {
  const f = fixture();
  f.discovery.files = [
    { path: 'nested/uv.lock', previousPath: null, status: 'modified', blobSha: null },
  ];
  for (const side of ['base', 'head']) {
    f.files[`${side}:nested/pyproject.toml`] = manifest;
    f.files[`${side}:nested/uv.lock`] = lock();
  }
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.roots.map((x) => x.root)).toEqual(['nested']);
  expect(r.gaps).toContainEqual({
    root: 'nested',
    side: null,
    path: null,
    entry: null,
    reason: 'unsupported',
  });
  expect(f.calls).not.toContain('base:pyproject.toml');
});
test('renames keep old/new roots and D1-proven absence independently', async () => {
  const f = fixture();
  f.input.roots = ['old', 'new'];
  f.discovery.files = [
    {
      path: 'new/pyproject.toml',
      previousPath: 'old/pyproject.toml',
      status: 'renamed',
      blobSha: null,
    },
  ];
  f.files['base:old/pyproject.toml'] = manifest;
  f.files['base:old/uv.lock'] = lock();
  f.files['head:new/pyproject.toml'] = manifest;
  f.files['head:new/uv.lock'] = lock(5);
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.roots.map((x) => [x.root, x.base.state, x.head.state])).toEqual([
    ['new', 'absent', 'present'],
    ['old', 'present', 'absent'],
  ]);
  expect(r.roots[0].base.manifest.treeSha).toBe('d'.repeat(40));
  expect(r.gaps).toEqual([]);
});
test('missing companions, generic unavailable reads and unsupported sides preserve other metadata', async () => {
  const f = fixture();
  delete f.files['base:uv.lock'];
  f.files['head:uv.lock'] = 'version=1\nrevision=4';
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.roots[0].base.state).toBe('partial');
  expect(r.roots[0].head.manifest.state).toBe('present');
  expect(r.gaps).toContainEqual({
    root: '.',
    side: 'base',
    path: 'uv.lock',
    entry: null,
    reason: 'missing',
  });
  expect(r.gaps).toContainEqual({
    root: '.',
    side: 'head',
    path: 'uv.lock',
    entry: null,
    reason: 'unsupported',
  });
  f.files['base:uv.lock'] = {
    kind: 'unavailable',
    side: 'base',
    path: 'uv.lock',
    repository,
    commitSha: BASE,
    reason: 'missing',
  };
  const again = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(again.roots[0].base.lock.state).toBe('unavailable');
});
test.each(['repository', 'commitSha', 'path', 'side', 'blobSha'] as const)(
  'rejects a wrong read %s and retains independent companions',
  async (field) => {
    const f = fixture();
    const row = {
      kind: 'available' as const,
      side: 'base' as const,
      path: 'uv.lock',
      repository,
      commitSha: BASE,
      blobSha: 'e'.repeat(40),
      bytes: new TextEncoder().encode(lock()),
    };
    f.files['base:uv.lock'] = {
      ...row,
      [field]:
        field === 'repository' ? { ...repository, id: 9 } : field === 'side' ? 'head' : 'wrong',
    } as GithubFileResult;
    const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
    expect(r.roots[0].base.lock.state).toBe('unavailable');
    expect(r.roots[0].head.lock.state).toBe('present');
    expect(r.gaps.some((g) => g.side === 'base' && g.reason === 'conflict')).toBe(true);
  },
);
test('fork head files retain the head repository identity', async () => {
  const f = fixture();
  f.input.binding = {
    ...f.input.binding,
    headRepository: { id: 102, owner: 'fork', name: 'consumer' },
  };
  f.discovery.binding = f.input.binding;
  f.comparison.headRepository = f.input.binding.headRepository;
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.roots[0].head.manifest.repository.id).toBe(102);
  expect(r.roots[0].base.manifest.repository.id).toBe(101);
});
test('incomplete discovery and base divergence survive beside usable file data', async () => {
  const f = fixture();
  f.discovery.kind = 'partial';
  f.discovery.complete = false;
  f.discovery.reasons = ['truncated'];
  f.input.binding = { ...f.input.binding, mergeBaseSha: 'c'.repeat(40) };
  f.discovery.binding = f.input.binding;
  f.comparison.mergeBaseSha = f.input.binding.mergeBaseSha;
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.roots[0].head.state).toBe('present');
  expect(r.discovery.complete).toBe(false);
  expect(r.gaps.map((g) => g.reason)).toContain('truncated');
  expect(r.gaps.map((g) => g.reason)).toContain('conflict');
});
test('repeated identical gaps are reported once', async () => {
  const f = fixture();
  f.discovery.files = [
    ...f.discovery.files,
    { path: '../a/uv.lock', previousPath: null, status: 'modified', blobSha: null },
    { path: '../b/uv.lock', previousPath: null, status: 'modified', blobSha: null },
  ];
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.gaps).toEqual([
    { root: null, side: null, path: null, entry: null, reason: 'malformed' },
  ]);
});
test('discovery made incomplete by base divergence still reads configured roots', async () => {
  const f = fixture();
  f.discovery.files = [];
  f.input.binding = { ...f.input.binding, mergeBaseSha: 'c'.repeat(40) };
  f.discovery.binding = f.input.binding;
  f.comparison.mergeBaseSha = f.input.binding.mergeBaseSha;
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.discovery).toMatchObject({ complete: false, applicable: true, reasons: ['conflict'] });
  expect(r.roots.map((x) => x.root)).toEqual(['.']);
  expect(f.calls).toEqual([
    'discover',
    'base:pyproject.toml',
    'base:uv.lock',
    'head:pyproject.toml',
    'head:uv.lock',
    'comparison',
  ]);
});
test('complete discovery with no uv input is inapplicable without final inventory coverage', async () => {
  const f = fixture();
  f.discovery.files = [];
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.roots).toEqual([]);
  expect(r.discovery.applicable).toBe(false);
  expect(f.calls).toEqual(['discover', 'comparison']);
});
test('retention keeps a deterministic root prefix and every omitted file scope visible', async () => {
  const f = fixture();
  f.input.roots = ['.', 'sub'];
  f.discovery.files = [
    ...f.discovery.files,
    { path: 'sub/uv.lock', previousPath: null, status: 'modified', blobSha: null },
  ];
  for (const side of ['base', 'head']) {
    f.files[`${side}:sub/pyproject.toml`] = manifest;
    f.files[`${side}:sub/uv.lock`] = lock();
  }
  const full = metadata(await collectUvMetadata(f.input, { session: f.session }));
  f.input.limits.maxRetainedBytes = Buffer.byteLength(JSON.stringify(full));
  expect(await collectUvMetadata(f.input, { session: f.session })).toEqual(full);
  f.input.limits.maxRetainedBytes--;
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.roots.map((x) => x.root)).toEqual(['.']);
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(f.input.limits.maxRetainedBytes);
  for (const side of ['base', 'head'])
    for (const path of ['sub/pyproject.toml', 'sub/uv.lock'])
      expect(r.gaps).toContainEqual({ root: 'sub', side, path, entry: null, reason: 'budget' });
  expect(r.sources.every((s) => !s.path.startsWith('sub/'))).toBe(true);
  f.input.limits.maxRetainedBytes = 1;
  expect(await collectUvMetadata(f.input, { session: f.session })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});
test.each([
  ['maxTomlEntries', 44],
  ['maxPackages', 4],
  ['maxDeclarations', 4],
  ['maxTomlDepth', 6],
  ['maxStringBytes', 23],
  ['maxRequirementTokens', 3],
] as const)(
  'enforces exact/over %s through the real collector across both sides',
  async (key, boundary) => {
    const f = fixture();
    f.input.limits[key] = boundary;
    const at = metadata(await collectUvMetadata(f.input, { session: f.session }));
    expect(at.gaps).toEqual([]);
    f.input.limits[key] = boundary - 1;
    const over = metadata(await collectUvMetadata(f.input, { session: f.session }));
    expect(over.gaps.some((g) => g.reason === 'budget')).toBe(true);
  },
);
test('enforces file, edge, marker and selected-root caps at boundaries', async () => {
  const f = fixture();
  f.input.limits.maxStringBytes = 100;
  f.input.limits.maxFileBytes = Buffer.byteLength(lock());
  expect(metadata(await collectUvMetadata(f.input, { session: f.session })).gaps).toEqual([]);
  f.input.limits.maxFileBytes--;
  expect(
    metadata(await collectUvMetadata(f.input, { session: f.session })).gaps.some(
      (g) => g.reason === 'budget',
    ),
  ).toBe(true);
  const edges = fixture();
  for (const side of ['base', 'head'])
    edges.files[`${side}:uv.lock`] = lock().replace(
      '[package.metadata]',
      'dependencies=[{name="one"},{name="two"}]\n[package.metadata]',
    );
  edges.input.limits.maxEdges = 4;
  expect(metadata(await collectUvMetadata(edges.input, { session: edges.session })).gaps).toEqual(
    [],
  );
  edges.input.limits.maxEdges = 3;
  expect(
    metadata(await collectUvMetadata(edges.input, { session: edges.session })).gaps.some(
      (g) => g.side === 'head' && g.reason === 'budget',
    ),
  ).toBe(true);
  const marker = fixture();
  marker.files['head:pyproject.toml'] = manifest.replace('orbit>=1', "orbit>=1; ((extra == 'x'))");
  marker.input.limits.maxMarkerDepth = 2;
  expect(metadata(await collectUvMetadata(marker.input, { session: marker.session })).gaps).toEqual(
    [],
  );
  marker.input.limits.maxMarkerDepth = 1;
  expect(
    metadata(await collectUvMetadata(marker.input, { session: marker.session })).gaps.some(
      (g) => g.reason === 'budget',
    ),
  ).toBe(true);
  const roots = fixture();
  roots.discovery.files = [
    ...roots.discovery.files,
    { path: 'sub/uv.lock', previousPath: null, status: 'modified', blobSha: null },
  ];
  roots.input.roots = ['.'];
  roots.input.limits.maxRoots = 1;
  const r = metadata(await collectUvMetadata(roots.input, { session: roots.session }));
  expect(r.roots).toHaveLength(1);
  expect(r.gaps).toContainEqual({
    root: 'sub',
    side: null,
    path: null,
    entry: null,
    reason: 'budget',
  });
});
test('output and sources are detached and deeply frozen, with independent stable file identities', async () => {
  const f = fixture(),
    r = metadata(await collectUvMetadata(f.input, { session: f.session })),
    saved = JSON.stringify(r);
  expect(new Set(r.sources.map((s) => s.id)).size).toBe(4);
  expect(() => {
    (r.roots as unknown[]).push({});
  }).toThrow();
  expect(() => {
    Reflect.set(r.roots[0].base.manifest.data!, 'name', 'mutated');
  }).not.toThrow();
  expect(Object.isFrozen(r.roots[0].base.manifest.data!.dependencies[0])).toBe(true);
  f.input.roots.push('new');
  f.discovery.files = [];
  expect(JSON.stringify(r)).toBe(saved);
  const again = metadata(await collectUvMetadata(fixture().input, { session: fixture().session }));
  expect(again).toEqual(r);
});
test('reordered discovery and TOML tables preserve deterministic semantic order and IDs at fixed mocked provenance', async () => {
  const f = fixture(),
    g = fixture();
  const a =
      '[project]\nname="project"\ndependencies=["orbit>=1"]\n[project.optional-dependencies]\na=[]\nz=[]\n',
    b =
      '[project]\ndependencies=["orbit>=1"]\nname="project"\n[project.optional-dependencies]\nz=[]\na=[]\n';
  for (const side of ['base', 'head']) {
    f.files[`${side}:pyproject.toml`] = a;
    g.files[`${side}:pyproject.toml`] = b;
  }
  g.discovery.files = [
    { path: 'uv.lock', previousPath: null, status: 'modified' as const, blobSha: null },
    ...g.discovery.files,
  ].reverse();
  expect(await collectUvMetadata(f.input, { session: f.session })).toEqual(
    await collectUvMetadata(g.input, { session: g.session }),
  );
});
test('comparison identity or availability failures never enter file parser gaps', async () => {
  const f = fixture();
  f.comparison.headSha = 'f'.repeat(40);
  const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
  expect(r.comparison).toEqual({ status: 'unavailable', reasons: ['conflict'] });
  expect(r.gaps).toEqual([]);
  expect(r.roots[0].head.state).toBe('present');
});
test('all positive-safe-integer budget fields are required and inconsistent bounds make no reads', async () => {
  const f = fixture();
  for (const key of Object.keys(f.input.limits))
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(
        await collectUvMetadata(
          { ...f.input, limits: { ...f.input.limits, [key]: value } },
          { session: f.session },
        ),
      ).toEqual({ kind: 'invalid' });
  expect(
    await collectUvMetadata(
      {
        ...f.input,
        limits: { ...f.input.limits, maxStringBytes: f.input.limits.maxFileBytes + 1 },
      },
      { session: f.session },
    ),
  ).toEqual({ kind: 'invalid' });
  expect(f.calls).toEqual([]);
});

test('source identity collisions cannot leave unattributable usable data', async () => {
  const f = fixture();
  collisions.source = true;
  try {
    const r = metadata(await collectUvMetadata(f.input, { session: f.session }));
    expect(r.gaps.some((g) => g.reason === 'conflict')).toBe(true);
    for (const root of r.roots)
      for (const side of [root.base, root.head])
        for (const file of [side.manifest, side.lock])
          if (file.data) expect(r.sources.some((s) => s.id === file.sourceId)).toBe(true);
  } finally {
    collisions.source = false;
  }
});
test('sparse root arrays and accessor/proxy bindings cannot evade runtime validation', async () => {
  const f = fixture(),
    roots: string[] = [];
  roots.length = 1;
  Object.defineProperty(roots, 'extra', { value: '.', enumerable: true });
  expect(await collectUvMetadata({ ...f.input, roots }, { session: f.session })).toEqual({
    kind: 'invalid',
  });
  expect(
    await collectUvMetadata({ ...f.input, roots: new Proxy(['.'], {}) }, { session: f.session }),
  ).toEqual({ kind: 'invalid' });
  expect(
    await collectUvMetadata(
      { ...f.input, binding: new Proxy(f.input.binding, {}) },
      { session: f.session },
    ),
  ).toEqual({ kind: 'invalid' });
  expect(f.calls).toEqual([]);
});
