import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { parseReviewConfig } from './config.js';
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
