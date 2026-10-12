import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { parseReviewConfig } from './config.js';
import { validateSourceContextInput, type SourceContextInput } from './context.js';

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
