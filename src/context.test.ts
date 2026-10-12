import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { loadTrustedReviewConfig, parseReviewConfig } from './config.js';
import {
  collectSourceContext,
  validateSourceContextInput,
  type SourceContextInput,
} from './context.js';

const fixtures: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'source-context-test-'));
  fixtures.push(root);
  await fs.mkdir(join(root, 'src'));
  await fs.writeFile(join(root, 'src/a.ts'), 'import value from "example-package";');
  return root;
}

function input(
  root: string,
  context: object = {},
  visibility: unknown = 'private',
): SourceContextInput {
  return {
    config: parseReviewConfig(JSON.stringify({ version: 1, context })),
    checkoutRoot: root,
    visibility,
    dependencies: [{ id: 'unit-1', name: 'example-package' }],
    trackedFiles: (async function* () {
      yield 'src/a.ts';
    })(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

function enabled(root: string, files = ['src/a.ts'], visibility = 'private') {
  const request = input(root, { sendSourceExcerptsToModel: true, excerptFiles: files }, visibility);
  request.trackedFiles = (async function* () {
    yield* files;
  })();
  return request;
}

test('confirmed missing config retains zero-read defaults through C1 and C2', async () => {
  const root = await fixture();
  const request = input(root);
  request.config = await loadTrustedReviewConfig(root);
  const open = vi.spyOn(fs, 'open');
  expect(await collectSourceContext(request)).toEqual({
    ok: true,
    status: 'disabled',
    dependencies: [],
    reasons: [],
  });
  expect(open).not.toHaveBeenCalled();
});

test('a sparse identity array is not a usable runtime packet', async () => {
  const root = await fixture();
  const request = enabled(root);
  request.dependencies = Array(1);
  await expect(collectSourceContext(request)).resolves.toMatchObject({
    ok: false,
    error: { category: 'input' },
  });
});

test('caller metadata fields cannot enter the source-context result', async () => {
  const root = await fixture();
  const request = enabled(root);
  const dependencies = [
    { id: 'unit-1', name: 'example-package', extra: 'synthetic-private-detail' },
  ];
  request.dependencies = dependencies;
  const result = await collectSourceContext(request);
  expect(result).toMatchObject({ ok: true, status: 'available' });
  expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
});

test('128 identities and 256-unit strings remain accepted when metadata fits', async () => {
  const root = await fixture();
  const request = enabled(root);
  request.dependencies = Array.from({ length: 128 }, (_, i) => ({
    id: String(i),
    name: 'example-package',
  }));
  const result = await collectSourceContext(request);
  if (!result.ok) throw new Error('expected context');
  expect(result.dependencies).toHaveLength(128);
  const name = 'e'.repeat(256);
  await source(root, 'src/a.ts', name);
  request.dependencies = [{ id: 'i'.repeat(256), name }];
  request.trackedFiles = (async function* () {
    yield 'src/a.ts';
  })();
  expect(await collectSourceContext(request)).toMatchObject({ ok: true, status: 'available' });
});

test('a nonregular descriptor is closed without a content read', async () => {
  const root = await fixture();
  const realOpen = fs.open;
  let closed = false;
  const read = vi.fn();
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const stat = await handle.stat();
    vi.spyOn(stat, 'isFile').mockReturnValue(false);
    vi.spyOn(handle, 'stat').mockResolvedValue(stat);
    vi.spyOn(handle, 'read').mockImplementation(read);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closed = true;
      await close();
    });
    return handle;
  });
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: false,
    error: { category: 'path' },
  });
  expect(read).not.toHaveBeenCalled();
  expect(closed).toBe(true);
});

test('unexpected early EOF fails and closes the source descriptor', async () => {
  const root = await fixture();
  const realOpen = fs.open;
  let closed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    vi.spyOn(handle, 'read').mockImplementation(async () => ({
      bytesRead: 0,
      buffer: Buffer.alloc(0),
    }));
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closed = true;
      await close();
    });
    return handle;
  });
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: false,
    error: { category: 'read' },
  });
  expect(closed).toBe(true);
});

test.each(['TESTS/usage.ts', 'CONFig/client.ts', 'Assets/view.ts', 'id_rsa.ts', 'usage.key'])(
  'case and credential names cannot bypass exclusions: %s',
  async (relativePath) => {
    const root = await fixture();
    const path = `src/${relativePath}`;
    await source(root, path, 'example-package');
    const open = vi.spyOn(fs, 'open');
    expect(await collectSourceContext(enabled(root, [path]))).toMatchObject({
      ok: true,
      dependencies: [{ facts: [] }],
    });
    expect(open).not.toHaveBeenCalled();
  },
);

test('exact 500-unit excerpts and multibyte file-byte boundaries are enforced', async () => {
  const root = await fixture();
  await source(root, 'src/a.ts', `example-package${'x'.repeat(485)}`);
  let result = await collectSourceContext(enabled(root));
  if (!result.ok) throw new Error('expected context');
  expect(result.status).toBe('available');
  expect(result.dependencies[0].facts[0].excerpt).toHaveLength(500);
  expect(result.dependencies[0].facts[0].excerptTruncated).toBe(false);
  const text = `example-package${'é'.repeat(32_760)}x`;
  expect(Buffer.byteLength(text)).toBe(65_536);
  await source(root, 'src/a.ts', text);
  result = await collectSourceContext(enabled(root));
  expect(result).toMatchObject({
    ok: true,
    dependencies: [{ facts: [{ excerptTruncated: true }] }],
  });
  await source(root, 'src/a.ts', `${text}x`);
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    dependencies: [{ facts: [], reasons: ['file-byte-limit'] }],
  });
});

async function source(root: string, path: string, text: string | Uint8Array) {
  const target = join(root, path);
  await fs.mkdir(join(target, '..'), { recursive: true });
  await fs.writeFile(target, text);
}

test('collector projects only a single trusted line with a relative path', async () => {
  const root = await fixture();
  await source(
    root,
    'src/a.ts',
    'unrelated line\n  import value from "example-package";\nadjacent private-looking line',
  );
  const result = await collectSourceContext(enabled(root));
  expect(result).toEqual({
    ok: true,
    status: 'available',
    reasons: [],
    dependencies: [
      {
        id: 'unit-1',
        name: 'example-package',
        status: 'available',
        reasons: [],
        facts: [
          {
            kind: 'package-usage',
            path: 'src/a.ts',
            excerpt: 'import value from "example-package";',
            excerptTruncated: false,
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('adjacent');
  expect(JSON.stringify(result)).not.toContain(root);
});

test.each(['public', 'private'])(
  'collector never reads opt-out source for %s',
  async (visibility) => {
    const root = await fixture();
    const open = vi.spyOn(fs, 'open');
    const request = input(
      root,
      { sendSourceExcerptsToModel: false, excerptFiles: ['src/a.ts'] },
      visibility,
    );
    const enumerate = vi.fn(async function* () {
      yield 'src/a.ts';
    });
    request.trackedFiles = { [Symbol.asyncIterator]: enumerate };
    expect(await collectSourceContext(request)).toEqual({
      ok: true,
      status: 'disabled',
      dependencies: [],
      reasons: [],
    });
    expect(open).not.toHaveBeenCalled();
    expect(enumerate).not.toHaveBeenCalled();
  },
);

test('empty public selection and empty roots read no source and do not enumerate', async () => {
  const root = await fixture();
  const request = enabled(root, [], 'public');
  const enumerate = vi.fn(async function* () {
    yield 'src/a.ts';
  });
  request.trackedFiles = { [Symbol.asyncIterator]: enumerate };
  expect(await collectSourceContext(request)).toMatchObject({
    ok: true,
    status: 'unavailable',
    dependencies: [{ facts: [] }],
  });
  expect(enumerate).not.toHaveBeenCalled();
  const emptyRoots = enabled(root);
  emptyRoots.config = parseReviewConfig(
    '{"version":1,"context":{"sendSourceExcerptsToModel":true,"sourceRoots":[],"excerptFiles":["src/a.ts"]}}',
  );
  expect(await collectSourceContext(emptyRoots)).toMatchObject({ ok: true, status: 'unavailable' });
});

test.each(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'svelte'])(
  'permits baseline source type %s',
  async (suffix) => {
    const root = await fixture();
    const path = `src/usage.${suffix}`;
    await source(root, path, 'example-package');
    expect(await collectSourceContext(enabled(root, [path]))).toMatchObject({
      ok: true,
      dependencies: [{ facts: [{ path }] }],
    });
  },
);

test.each([
  'tests/usage.ts',
  'fixtures/usage.ts',
  'mocks/usage.ts',
  'snapshots/usage.ts',
  'generated/usage.ts',
  'vendor/usage.ts',
  'node_modules/usage.ts',
  'dist/usage.ts',
  'assets/usage.ts',
  'uploads/usage.ts',
  'content/usage.ts',
  'data/usage.ts',
  'config/usage.ts',
  'secrets/usage.ts',
  'private-keys/usage.ts',
  'usage.test.ts',
  'usage.spec.ts',
  'usage.mock.ts',
  'usage.fixture.ts',
  'usage.snapshot.ts',
  'usage.generated.ts',
  'usage.gen.ts',
  'usage.min.js',
  'usage.d.ts',
  'usage.d.mts',
  'usage.config.ts',
  'config.ts',
  'settings.ts',
  'tsconfig.ts',
  'credentials.ts',
  'usage.py',
  'usage.json',
  'usage.TS',
])('exact lists cannot authorize excluded %s', async (relativePath) => {
  const root = await fixture();
  const path = `src/${relativePath}`;
  await source(root, path, 'example-package');
  const open = vi.spyOn(fs, 'open');
  const result = await collectSourceContext(enabled(root, [path]));
  expect(result).toMatchObject({ ok: true, dependencies: [{ facts: [] }] });
  expect(open).not.toHaveBeenCalled();
});

test.each(['tester.ts', 'configure.ts', 'generator.ts', 'mineral.ts', 'model.ts'])(
  'nearby ordinary filename %s remains eligible',
  async (file) => {
    const root = await fixture();
    const path = `src/${file}`;
    await source(root, path, 'example-package');
    expect(await collectSourceContext(enabled(root, [path]))).toMatchObject({
      ok: true,
      status: 'available',
    });
  },
);

test('exact lists intersect roots and checked-in membership without discovering extra files', async () => {
  const root = await fixture();
  await source(root, 'lib/a.ts', 'example-package');
  await source(root, 'src/untracked.ts', 'example-package');
  const request = enabled(root, ['lib/a.ts', 'src/untracked.ts']);
  request.trackedFiles = (async function* () {
    yield 'lib/a.ts';
    yield 'src/a.ts';
  })();
  const open = vi.spyOn(fs, 'open');
  const result = await collectSourceContext(request);
  expect(result).toMatchObject({ ok: true, dependencies: [{ facts: [] }] });
  expect(open).not.toHaveBeenCalled();
});

test.each([
  'example-package; token = "synthetic"',
  'safe = "example-package"; api_key: "synthetic"',
  'example-package; Authorization: Bearer synthetic',
  'example-package; Basic c3ludGhldGlj',
  `example-package; ghp_${'a'.repeat(20)}`,
  `example-package; github_pat_${'a'.repeat(20)}`,
  `example-package; AKIA${'A'.repeat(16)}`,
  `example-package; sk-${'a'.repeat(16)}`,
  'example-package; https://synthetic:synthetic@example.invalid',
  'example-package; synthetic@example.invalid',
  'example-package; /Users/synthetic/private',
  'example-package; C:\\Users\\synthetic\\private',
  `example-package ${'x'.repeat(600)} token = "synthetic"`,
  'example-package\u0000hidden',
])('drops a suspicious complete line before projection: %s', async (line) => {
  const root = await fixture();
  await source(root, 'src/a.ts', line);
  const result = await collectSourceContext(enabled(root));
  expect(result).toMatchObject({
    ok: true,
    status: 'partial',
    dependencies: [{ facts: [], reasons: ['suspicious-line'] }],
  });
  expect(JSON.stringify(result)).not.toContain(line);
});

test('a safe later line can follow a rejected inline match', async () => {
  const root = await fixture();
  await source(
    root,
    'src/a.ts',
    'example-package; token = "synthetic"\nimport value from "example-package";',
  );
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    status: 'partial',
    dependencies: [
      {
        facts: [{ excerpt: 'import value from "example-package";' }],
        reasons: ['suspicious-line'],
      },
    ],
  });
});

test.each([
  '-----BEGIN PRIVATE KEY-----\nexample-package\n-----END PRIVATE KEY-----',
  'const privateKey = `\nexample-package\n`;',
  'const apiKey = [\n"example-package"\n];',
  'const client_secret = {\n"example-package": true\n};',
  'const password = "\nexample-package',
  '// @generated\nexample-package',
])('whole-file gates omit generated or multiline sensitive source', async (text) => {
  const root = await fixture();
  await source(root, 'src/a.ts', text);
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    dependencies: [{ facts: [] }],
  });
});

test.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])(
  'emits only one source line for delimiter %j',
  async (delimiter) => {
    const root = await fixture();
    await source(root, 'src/a.ts', `example-package${delimiter}never sent`);
    expect(await collectSourceContext(enabled(root))).toMatchObject({
      ok: true,
      dependencies: [{ facts: [{ excerpt: 'example-package' }] }],
    });
  },
);

test('line and fact caps retain identity, complete characters, and visible limits', async () => {
  const root = await fixture();
  await source(root, 'src/a.ts', `example-package${'x'.repeat(484)}😀`);
  let result = await collectSourceContext(enabled(root));
  expect(result).toMatchObject({
    ok: true,
    status: 'partial',
    dependencies: [{ facts: [{ excerptTruncated: true }] }],
  });
  if (!result.ok) throw new Error('expected source context');
  expect(result.dependencies[0].facts[0].excerpt).toHaveLength(499);
  await source(root, 'src/a.ts', `${'x'.repeat(501)}example-package`);
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    dependencies: [{ facts: [], reasons: ['excerpt-limit'] }],
  });
  const paths = Array.from({ length: 21 }, (_, i) => `src/usage-${String(i).padStart(2, '0')}.ts`);
  for (const path of paths) await source(root, path, 'example-package');
  result = await collectSourceContext(enabled(root, paths.reverse()));
  if (!result.ok) throw new Error('expected source context');
  expect(result.dependencies[0].facts).toHaveLength(20);
  expect(result.dependencies[0].facts[0].path).toBe('src/usage-00.ts');
  expect(result.dependencies[0].reasons).toContain('fact-limit');
});

test('file cap distinguishes complete exact-boundary content from an overflow', async () => {
  const root = await fixture();
  await source(root, 'src/a.ts', `example-package${'x'.repeat(65_536 - 15)}`);
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    dependencies: [{ facts: [{ excerptTruncated: true }] }],
  });
  await source(root, 'src/a.ts', `example-package${'x'.repeat(65_537 - 15)}`);
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    dependencies: [{ facts: [], reasons: ['file-byte-limit'] }],
  });
});

test('invalid UTF-8 fails without usable partial context', async () => {
  const root = await fixture();
  await source(root, 'src/b.ts', new Uint8Array([0xff]));
  const result = await collectSourceContext(enabled(root, ['src/a.ts', 'src/b.ts']));
  expect(result).toMatchObject({ ok: false, error: { category: 'read' } });
  expect(result).not.toHaveProperty('dependencies');
});

test('malformed runtime identities fail without throwing or opening contents', async () => {
  const root = await fixture();
  const open = vi.spyOn(fs, 'open');
  for (const dependency of [null, undefined, 1, 'synthetic', {}, { id: 'a', name: 2 }]) {
    const request = enabled(root);
    request.dependencies = [dependency] as unknown as SourceContextInput['dependencies'];
    await expect(collectSourceContext(request)).resolves.toMatchObject({
      ok: false,
      error: { category: 'input' },
    });
  }
  expect(open).not.toHaveBeenCalled();
});

test('changed parser arrays cannot expand C1 count limits before metadata I/O', async () => {
  const root = await fixture();
  const request = enabled(root);
  if (!request.config.ok) throw new Error('expected parsed config');
  request.config.config.context.excerptFiles = Array(129).fill('src/a.ts');
  const lstat = vi.spyOn(fs, 'lstat');
  expect(await collectSourceContext(request)).toMatchObject({ ok: false });
  expect(lstat).not.toHaveBeenCalled();
});

test('JSON-escaped identity metadata overflows before contents or inventory are read', async () => {
  const root = await fixture();
  const request = enabled(root);
  request.dependencies = Array.from({ length: 128 }, (_, i) => ({
    id: `${i}${'"'.repeat(240)}`,
    name: '"'.repeat(256),
  }));
  const open = vi.spyOn(fs, 'open');
  const enumerate = vi.fn(async function* () {
    yield 'src/a.ts';
  });
  request.trackedFiles = { [Symbol.asyncIterator]: enumerate };
  expect(await collectSourceContext(request)).toMatchObject({
    ok: false,
    error: { category: 'budget' },
  });
  expect(open).not.toHaveBeenCalled();
  expect(enumerate).not.toHaveBeenCalled();
});

test.each([10_000, 10_001])(
  'inventory budget bounds %i records including duplicates',
  async (matchAt) => {
    const root = await fixture();
    const request = enabled(root);
    let calls = 0,
      closed = false;
    request.trackedFiles = (async function* () {
      try {
        for (let i = 1; i <= matchAt; i++) {
          calls++;
          yield i === matchAt ? 'src/a.ts' : 'src/other.ts';
        }
      } finally {
        closed = true;
      }
    })();
    const result = await collectSourceContext(request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected context');
    expect(calls).toBe(matchAt);
    expect(closed).toBe(true);
    if (matchAt === 10_000) expect(result.dependencies[0].facts).toHaveLength(1);
    else {
      expect(result.dependencies[0].facts).toHaveLength(0);
      expect(result.reasons).toContain('inventory-limit');
    }
  },
);

test('inventory iteration stops after exact membership and closes on early exit', async () => {
  const root = await fixture();
  const request = enabled(root);
  let closed = false;
  request.trackedFiles = (async function* () {
    try {
      yield 'src/a.ts';
      throw new Error('must not iterate after membership');
    } finally {
      closed = true;
    }
  })();
  expect(await collectSourceContext(request)).toMatchObject({ ok: true, status: 'available' });
  expect(closed).toBe(true);
});

test('inventory exceptions have no source facts or raw diagnostics', async () => {
  const root = await fixture();
  const request = enabled(root, ['src/a.ts', 'src/absent.ts']);
  await source(root, 'src/absent.ts', 'example-package');
  request.trackedFiles = (async function* () {
    yield 'src/a.ts';
    throw new Error('synthetic-private-detail');
  })();
  expect(await collectSourceContext(request)).toEqual({
    ok: false,
    error: { file: '.github/dependabot-review.json', category: 'read', field: '$' },
  });
});

test.each([
  '/src/a.ts',
  'src/../a.ts',
  'C:\\source.ts',
  'src//a.ts',
  'src/a.ts\n',
  'x'.repeat(1_025),
])('rejects malformed inventory path without echoing it', async (path) => {
  const root = await fixture();
  const request = enabled(root);
  request.trackedFiles = (async function* () {
    yield path;
  })();
  const open = vi.spyOn(fs, 'open');
  const result = await collectSourceContext(request);
  expect(result).toMatchObject({ ok: false, error: { category: 'path' } });
  expect(open).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(path);
});

test('UTF-8 path budget accepts 1,024 bytes and rejects 1,025 before stat', async () => {
  const root = await fixture();
  const parent = `${'s'.repeat(200)}/${'s'.repeat(200)}/${'s'.repeat(200)}/${'s'.repeat(200)}`;
  const path = `src/${parent}/${'é'.repeat(106)}a.ts`;
  expect(Buffer.byteLength(path)).toBe(1_024);
  const fileStat = await fs.stat(join(root, 'src/a.ts'));
  const directoryStat = await fs.stat(join(root, 'src'));
  const lstat = vi
    .spyOn(fs, 'lstat')
    .mockImplementation(async (target) =>
      String(target).endsWith(path) ? fileStat : directoryStat,
    );
  const request = enabled(root, [path]);
  request.config = parseReviewConfig(
    JSON.stringify({
      version: 1,
      context: { sourceRoots: ['src'], sendSourceExcerptsToModel: true, excerptFiles: [path] },
    }),
  );
  expect(await validateSourceContextInput(request)).toMatchObject({ ok: true, state: 'ready' });
  const oversized = path.replace('a.ts', 'aa.ts');
  lstat.mockClear();
  expect(await collectSourceContext(enabled(root, [oversized]))).toMatchObject({
    ok: false,
    error: { category: 'path' },
  });
  expect(lstat).not.toHaveBeenCalled();
});

test('overlapping roots and repeated inventory paths yield one fact per file', async () => {
  const root = await fixture();
  await source(root, 'src/lib/a.ts', 'example-package\nexample-package');
  const request = enabled(root, ['src/lib/a.ts']);
  request.config = parseReviewConfig(
    '{"version":1,"context":{"sourceRoots":["src","src/lib","src"],"excerptFiles":["src/lib/a.ts"],"sendSourceExcerptsToModel":true}}',
  );
  request.trackedFiles = (async function* () {
    yield 'src/lib/a.ts';
    yield 'src/lib/a.ts';
  })();
  expect(await collectSourceContext(request)).toMatchObject({
    ok: true,
    dependencies: [{ facts: [{ path: 'src/lib/a.ts' }] }],
  });
  const result = await collectSourceContext(enabled(root, ['src/lib/a.ts']));
  if (!result.ok) throw new Error('expected context');
  expect(result.dependencies[0].facts).toHaveLength(1);
});

test('all 128 exact files remain bounded and no-match is unavailable evidence', async () => {
  const root = await fixture();
  const paths = Array.from({ length: 128 }, (_, i) => `src/usage-${i}.ts`);
  for (const path of paths) await source(root, path, 'no usage here');
  const result = await collectSourceContext(enabled(root, paths));
  expect(result).toMatchObject({
    ok: true,
    status: 'unavailable',
    dependencies: [{ status: 'unavailable', reasons: ['no-match'], facts: [] }],
  });
});

test('total returned bytes, including overflow probes, never exceed one MiB', async () => {
  const root = await fixture();
  const paths = Array.from({ length: 18 }, (_, i) => `src/usage-${String(i).padStart(2, '0')}.ts`);
  for (const path of paths) await source(root, path, `example-package${'x'.repeat(65_537 - 15)}`);
  const realOpen = fs.open;
  let bytes = 0,
    handles = 0,
    closes = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    handles++;
    const read = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation(async (options) => {
      const result = await read(options);
      bytes += result.bytesRead;
      return result;
    });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closes++;
      await close();
    });
    return handle;
  });
  const result = await collectSourceContext(enabled(root, paths));
  expect(result).toMatchObject({ ok: true, status: 'partial', dependencies: [{ facts: [] }] });
  expect(bytes).toBe(1_048_576);
  expect(handles).toBe(16);
  expect(closes).toBe(handles);
  if (!result.ok) throw new Error('expected context');
  expect(result.reasons).toContain('total-read-limit');
});

test('short reads continue to the complete descriptor size and close the handle', async () => {
  const root = await fixture();
  const realOpen = fs.open;
  let reads = 0,
    closed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation(async (options) => {
      reads++;
      const configuration = options ?? {};
      return read({ ...configuration, length: Math.min(configuration.length ?? 3, 3) });
    });
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      closed = true;
      await close();
    });
    return handle;
  });
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    status: 'available',
  });
  expect(reads).toBeGreaterThan(1);
  expect(closed).toBe(true);
});

test.each(['stat', 'read', 'close'])(
  'descriptor %s errors discard even earlier valid facts',
  async (method) => {
    const root = await fixture();
    await source(root, 'src/b.ts', 'example-package');
    const realOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith('/b.ts')) {
        if (method === 'close') {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            await close();
            throw new Error('synthetic-private-detail');
          });
        } else
          vi.spyOn(handle, method === 'stat' ? 'stat' : 'read').mockRejectedValue(
            new Error('synthetic-private-detail'),
          );
      }
      return handle;
    });
    const result = await collectSourceContext(enabled(root, ['src/a.ts', 'src/b.ts']));
    expect(result).toMatchObject({ ok: false, error: { category: 'read' } });
    expect(result).not.toHaveProperty('dependencies');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
  },
);

test('serialization budget retains every identity and bounds UTF-8 plus JSON escaping', async () => {
  const root = await fixture();
  const names = Array.from({ length: 32 }, (_, i) => `example-package-${i}`);
  const paths = Array.from({ length: 20 }, (_, i) => `src/usage-${i}.ts`);
  for (const path of paths)
    await source(root, path, names.map((name) => `${name}${'"'.repeat(400)}`).join('\n'));
  const request = enabled(root, paths);
  request.dependencies = names.map((name, i) => ({ id: `unit-${i}`, name }));
  const result = await collectSourceContext(request);
  if (!result.ok) throw new Error('expected context');
  expect(result.dependencies).toHaveLength(32);
  expect(result.reasons).toContain('context-byte-limit');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
  expect(result.status).toBe('partial');
});

test.each([
  'import { tokenizer } from "example-package";',
  'import token from "@scope/example-package";',
  '\texample-package',
])('ordinary names, scoped packages, and tabs are safe: %s', async (line) => {
  const root = await fixture();
  await source(root, 'src/a.ts', line);
  expect(await collectSourceContext(enabled(root))).toMatchObject({
    ok: true,
    status: 'available',
    dependencies: [{ facts: [{ excerpt: line.trimStart() }] }],
  });
});

test.each([{}, { sendSourceExcerptsToModel: false, excerptFiles: ['src/a.ts'] }])(
  'opt-out validates paths without opening source contents',
  async (context) => {
    const root = await fixture();
    const request = input(root, context);
    const open = vi.spyOn(fs, 'open');
    const enumerate = vi.fn(async function* () {
      yield 'src/a.ts';
    });
    request.trackedFiles = { [Symbol.asyncIterator]: enumerate };
    expect(await validateSourceContextInput(request)).toEqual({ ok: true, state: 'disabled' });
    expect(open).not.toHaveBeenCalled();
    expect(enumerate).not.toHaveBeenCalled();
  },
);

test.each(['public', 'private'])(
  'exact trusted files reach the ready boundary for %s',
  async (visibility) => {
    const root = await fixture();
    const result = await validateSourceContextInput(
      input(
        root,
        {
          sourceRoots: ['src'],
          sendSourceExcerptsToModel: true,
          excerptFiles: ['src/a.ts'],
        },
        visibility,
      ),
    );
    expect(result).toMatchObject({ ok: true, state: 'ready', roots: ['src'], files: ['src/a.ts'] });
    expect(result).not.toHaveProperty('facts');
  },
);

test('private opt-in needs a nonempty exact list; public empty lists select nothing', async () => {
  const root = await fixture();
  const open = vi.spyOn(fs, 'open');
  expect(
    await validateSourceContextInput(input(root, { sendSourceExcerptsToModel: true })),
  ).toMatchObject({
    ok: false,
    error: { category: 'config', field: 'context.excerptFiles' },
  });
  expect(
    await validateSourceContextInput(input(root, { sendSourceExcerptsToModel: true }, 'public')),
  ).toMatchObject({
    ok: true,
    state: 'unavailable',
    files: [],
  });
  expect(open).not.toHaveBeenCalled();
});

test.each(['unknown', undefined, null, false])(
  'unknown visibility fails safely: %s',
  async (visibility) => {
    const root = await fixture();
    const request = input(root);
    request.visibility = visibility;
    expect(await validateSourceContextInput(request)).toMatchObject({
      ok: false,
      error: { category: 'input' },
    });
  },
);

test.each(['/src', '../src', 'src/../src', 'C:\\source', 'src/*', '.hidden', 'src/secrets'])(
  'unsafe root %s fails before content reads',
  async (path) => {
    const root = await fixture();
    const open = vi.spyOn(fs, 'open');
    const result = await validateSourceContextInput(input(root, { sourceRoots: [path] }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(path);
    expect(open).not.toHaveBeenCalled();
  },
);

test.each(['root', 'parent', 'file', 'dangling', 'escaping'])(
  'rejects %s source symlinks, even while disabled',
  async (kind) => {
    const root = await fixture();
    const other = await fixture();
    let context: object;
    if (kind === 'root') {
      await fs.symlink(join(root, 'src'), join(root, 'alias'));
      context = { sourceRoots: ['alias'] };
    } else if (kind === 'parent') {
      await fs.symlink(join(root, 'src'), join(root, 'alias'));
      context = { excerptFiles: ['alias/a.ts'] };
    } else {
      const target =
        kind === 'dangling'
          ? join(root, 'absent')
          : join(kind === 'escaping' ? other : root, 'src/a.ts');
      await fs.symlink(target, join(root, 'src/link.ts'));
      context = { excerptFiles: ['src/link.ts'] };
    }
    const result = await validateSourceContextInput(input(root, context));
    expect(result).toMatchObject({ ok: false, error: { category: 'path' } });
    expect(result).not.toHaveProperty('files');
  },
);

test('missing ordinary paths remain availability limits and empty roots do not default', async () => {
  const root = await fixture();
  const result = await validateSourceContextInput(
    input(root, {
      sourceRoots: ['missing'],
      sendSourceExcerptsToModel: true,
      excerptFiles: ['src/absent.ts'],
    }),
  );
  expect(result).toMatchObject({
    ok: true,
    state: 'unavailable',
    roots: [],
    files: [],
    reasons: ['missing-source'],
  });
  expect(
    await validateSourceContextInput(
      input(root, {
        sourceRoots: [],
        sendSourceExcerptsToModel: true,
        excerptFiles: ['src/a.ts'],
      }),
    ),
  ).toMatchObject({ ok: true, state: 'unavailable', roots: [] });
});

test('nonregular roots and excerpt targets are refused', async () => {
  const root = await fixture();
  expect(
    await validateSourceContextInput(input(root, { sourceRoots: ['src/a.ts'] })),
  ).toMatchObject({ ok: false, error: { category: 'path' } });
  expect(await validateSourceContextInput(input(root, { excerptFiles: ['src'] }))).toMatchObject({
    ok: false,
    error: { category: 'path' },
  });
});

test('metadata errors expose only fixed diagnostics', async () => {
  const root = await fixture();
  vi.spyOn(fs, 'lstat').mockRejectedValue(new Error('synthetic-private-value'));
  const result = await validateSourceContextInput(input(root));
  expect(result).toEqual({
    ok: false,
    error: {
      file: '.github/dependabot-review.json',
      category: 'read',
      field: 'context.sourceRoots',
    },
  });
  expect(JSON.stringify(result)).not.toContain(root);
});

test('dependency identities are bounded and cannot share IDs', async () => {
  const root = await fixture();
  for (const dependencies of [
    [{ id: '', name: 'example-package' }],
    [{ id: 'a', name: 'x'.repeat(257) }],
    [{ id: 'a', name: 'x\ny' }],
    [
      { id: 'a', name: 'x' },
      { id: 'a', name: 'y' },
    ],
    Array.from({ length: 129 }, (_, i) => ({ id: String(i), name: 'example-package' })),
  ]) {
    expect(await validateSourceContextInput({ ...input(root), dependencies })).toMatchObject({
      ok: false,
      error: { category: 'input' },
    });
  }
});
