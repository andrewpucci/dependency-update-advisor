import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import {
  createGithubSnapshotReads,
  withTrustedSnapshot,
  type SnapshotReads,
  type SnapshotTreeEntry,
} from './snapshot.js';
import { createGithubTransport } from './runtime.js';

const repository = { id: 101, owner: 'example', name: 'consumer' };
const revision = 'a'.repeat(40);
const treeRevision = '9'.repeat(40);
const configBlob = 'b'.repeat(40);
const sourceBlob = 'c'.repeat(40);
const linkBlob = 'd'.repeat(40);
const temporaryRoots: string[] = [];

function entry(path: string, mode: string, sha: string, type = 'blob'): SnapshotTreeEntry {
  return { path, mode, sha, type };
}

/** Serves each directory's direct children the way GitHub's non-recursive tree endpoint does. */
function reads(
  tree: readonly SnapshotTreeEntry[],
  blobs: Readonly<Record<string, string>>,
): SnapshotReads & { calls: string[] } {
  const calls: string[] = [];
  const directories = new Map<string, string>([[treeRevision, '']]);
  for (const item of tree) if (item.type === 'tree') directories.set(item.sha, item.path);
  return {
    calls,
    readRepository: async (actual) => {
      calls.push(`repository:${actual.id}`);
      return { kind: 'available', value: { visibility: 'public', defaultBranch: 'main' } };
    },
    readCommit: async (_repository, ref) => {
      calls.push(`commit:${ref}`);
      return { kind: 'available', value: { sha: revision, treeSha: treeRevision } };
    },
    readTree: async (_repository, sha) => {
      calls.push(`tree:${sha}`);
      const directory = directories.get(sha);
      if (directory === undefined) return { kind: 'unavailable' };
      const prefix = directory ? `${directory}/` : '';
      return {
        kind: 'available',
        value: tree
          .filter(
            (item) => item.path.startsWith(prefix) && !item.path.slice(prefix.length).includes('/'),
          )
          .map((item) => ({
            ...item,
            path: item.path.slice(prefix.length),
            ...(item.type === 'blob' && !('size' in item)
              ? { size: Buffer.byteLength(blobs[item.sha] ?? '') }
              : {}),
          })),
      };
    },
    readBlob: async (_repository, sha) => {
      calls.push(`blob:${sha}`);
      const value = blobs[sha];
      return value === undefined
        ? { kind: 'unavailable' as const }
        : { kind: 'available' as const, value: new TextEncoder().encode(value) };
    },
  };
}

function tempRoot() {
  return async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'review-snapshot-test-'));
    temporaryRoots.push(root);
    return root;
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test('converts fixed-origin GitHub reads into the trusted snapshot capability', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/commits/main'))
      return new Response(
        JSON.stringify({ sha: revision, commit: { tree: { sha: treeRevision } } }),
      );
    if (url.includes('/git/trees/'))
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [{ path: 'a.ts', mode: '100644', type: 'blob', sha: sourceBlob, size: 1 }],
        }),
      );
    if (url.endsWith(`/git/blobs/${sourceBlob}`))
      return new Response(JSON.stringify({ encoding: 'base64', content: 'YQ==' }));
    return new Response(JSON.stringify({ private: false, default_branch: 'main' }));
  });
  const reader = createGithubSnapshotReads(
    createGithubTransport({ token: 'read-token', now: () => 0, fetch }),
  );

  await expect(reader.readRepository(repository)).resolves.toEqual({
    kind: 'available',
    value: { visibility: 'public', defaultBranch: 'main' },
  });
  await expect(reader.readCommit(repository, 'main')).resolves.toEqual({
    kind: 'available',
    value: { sha: revision, treeSha: treeRevision },
  });
  await expect(reader.readTree(repository, treeRevision)).resolves.toEqual({
    kind: 'available',
    value: [{ path: 'a.ts', mode: '100644', type: 'blob', sha: sourceBlob, size: 1 }],
  });
  expect(fetch).toHaveBeenCalledWith(
    `https://api.github.com/repos/example/consumer/git/trees/${treeRevision}`,
    expect.anything(),
  );
  await expect(reader.readBlob(repository, sourceBlob)).resolves.toEqual({
    kind: 'available',
    value: new Uint8Array([97]),
  });
});

test('pins config, inventory, and source facts to one default-branch revision', async () => {
  const source = 'import packageName from "example-package";';
  const reader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      entry('src/a.ts', '100644', sourceBlob),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: { sendSourceExcerptsToModel: true, excerptFiles: ['src/a.ts'] },
      }),
      [sourceBlob]: source,
    },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    async (snapshot) => ({
      revision: snapshot.contextRevision,
      context: await snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
    }),
  );

  expect(result).toMatchObject({
    kind: 'ready',
    value: {
      revision: { repository, sha: revision },
      context: {
        ok: true,
        status: 'available',
        dependencies: [{ facts: [{ path: 'src/a.ts', excerpt: source }] }],
      },
    },
  });
  expect(reader.calls).toEqual([
    'repository:101',
    'commit:main',
    `tree:${treeRevision}`,
    `tree:${'e'.repeat(40)}`,
    `blob:${configBlob}`,
    `tree:${'f'.repeat(40)}`,
    `blob:${sourceBlob}`,
  ]);
});

test('uses confirmed missing-config defaults without reading source bytes', async () => {
  const reader = reads(
    [entry('src', '040000', 'e'.repeat(40), 'tree'), entry('src/a.ts', '100644', sourceBlob)],
    { [sourceBlob]: 'import packageName from "example-package";' },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    async (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({ kind: 'ready', value: { ok: true, status: 'disabled' } });
  expect(reader.calls).not.toContain(`blob:${sourceBlob}`);
});

test('loads a config through an in-repository link without changing its C1 path semantics', async () => {
  const linkedConfig = 'e'.repeat(40);
  const reader = reads(
    [
      entry('.github', '040000', 'f'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '120000', linkBlob),
      entry('config', '040000', '1'.repeat(40), 'tree'),
      entry('config/review.json', '100644', linkedConfig),
    ],
    { [linkBlob]: '../config/review.json', [linkedConfig]: '{"version":1}' },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    async (snapshot) => snapshot.config,
  );

  expect(result).toMatchObject({ kind: 'ready', value: { ok: true, origin: 'file' } });
  expect(reader.calls).toContain(`blob:${linkBlob}`);
  expect(reader.calls).toContain(`blob:${linkedConfig}`);
});

test('rejects a private opt-in without exact files before reading source bytes', async () => {
  const reader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      entry('src/a.ts', '100644', sourceBlob),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: { sendSourceExcerptsToModel: true, sourceRoots: ['src'], excerptFiles: [] },
      }),
      [sourceBlob]: 'import packageName from "example-package";',
    },
  );
  reader.readRepository = async () => ({
    kind: 'available',
    value: { visibility: 'private', defaultBranch: 'main' },
  });

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    async (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({
    kind: 'ready',
    value: { ok: false, error: { category: 'config', field: 'context.excerptFiles' } },
  });
  expect(reader.calls).not.toContain(`blob:${sourceBlob}`);
});

test('keeps a source symlink ineligible instead of flattening it into source text', async () => {
  const reader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      entry('src/link.ts', '120000', linkBlob),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: { sendSourceExcerptsToModel: true, excerptFiles: ['src/link.ts'] },
      }),
      [linkBlob]: 'a.ts',
    },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    async (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({
    kind: 'ready',
    value: { ok: false, error: { category: 'path', field: 'context.excerptFiles' } },
  });
  expect(reader.calls).not.toContain(`blob:${linkBlob}`);
});

test('removes its temporary directory after a stale owner abandons a partial snapshot', async () => {
  const reader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
    ],
    { [configBlob]: '{"version":1}' },
  );
  let current = true;
  reader.readBlob = async (_repository, sha) => {
    reader.calls.push(`blob:${sha}`);
    current = false;
    return { kind: 'available', value: new TextEncoder().encode('{"version":1}') };
  };
  const root = await tempRoot()();

  const result = await withTrustedSnapshot(
    { repository, reads: reader, isCurrent: () => current, temporaryRoot: async () => root },
    async () => 'unreachable',
  );

  expect(result).toEqual({ kind: 'unavailable' });
  await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('removes its temporary directory after success, invalid config, and cancellation', async () => {
  const successRoot = await tempRoot()();
  const successReader = reads([], {});
  await expect(
    withTrustedSnapshot(
      { repository, reads: successReader, temporaryRoot: async () => successRoot },
      async () => 'complete',
    ),
  ).resolves.toEqual({ kind: 'ready', value: 'complete' });
  await expect(fs.stat(successRoot)).rejects.toMatchObject({ code: 'ENOENT' });

  const invalidRoot = await tempRoot()();
  const invalidReader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
    ],
    { [configBlob]: '{"version":2}' },
  );
  await expect(
    withTrustedSnapshot(
      { repository, reads: invalidReader, temporaryRoot: async () => invalidRoot },
      async () => 'unreachable',
    ),
  ).resolves.toMatchObject({ kind: 'invalid-config' });
  await expect(fs.stat(invalidRoot)).rejects.toMatchObject({ code: 'ENOENT' });

  const cancelledRoot = await tempRoot()();
  const controller = new AbortController();
  const cancelledReader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
    ],
    { [configBlob]: '{"version":1}' },
  );
  cancelledReader.readBlob = async (_repository, sha) => {
    cancelledReader.calls.push(`blob:${sha}`);
    controller.abort();
    return { kind: 'available', value: new TextEncoder().encode('{"version":1}') };
  };
  await expect(
    withTrustedSnapshot(
      {
        repository,
        reads: cancelledReader,
        signal: controller.signal,
        temporaryRoot: async () => cancelledRoot,
      },
      async () => 'unreachable',
    ),
  ).resolves.toEqual({ kind: 'unavailable' });
  await expect(fs.stat(cancelledRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('materializes a submodule gitlink as the empty directory a checkout leaves', async () => {
  const gitlink = '3'.repeat(40);
  const reader = reads(
    [
      ...configTree,
      entry('lib', '160000', gitlink, 'commit'),
      entry('vendor', '040000', '1'.repeat(40), 'tree'),
      entry('vendor/lib', '160000', gitlink, 'commit'),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: {
          sendSourceExcerptsToModel: true,
          sourceRoots: ['vendor'],
          excerptFiles: ['vendor/lib/a.ts'],
        },
      }),
    },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({
    kind: 'ready',
    value: { ok: true, reasons: expect.arrayContaining(['missing-source']) },
  });
  expect(reader.calls).not.toContain(`tree:${gitlink}`);
});

test.each([
  ['a link', entry('lib', '120000', linkBlob)],
  ['a file', entry('lib', '100644', linkBlob)],
])('rejects configured source paths beneath %s the way a checkout does', async (_label, parent) => {
  for (const context of [
    { sendSourceExcerptsToModel: true, excerptFiles: ['lib/a.ts'] },
    { sendSourceExcerptsToModel: true, sourceRoots: ['lib/pkg'], excerptFiles: ['src/a.ts'] },
  ]) {
    const reader = reads(
      [
        entry('.github', '040000', 'e'.repeat(40), 'tree'),
        entry('.github/dependabot-review.json', '100644', configBlob),
        parent,
        entry('src', '040000', 'f'.repeat(40), 'tree'),
        entry('src/a.ts', '100644', sourceBlob),
      ],
      {
        [configBlob]: JSON.stringify({ version: 1, context }),
        [linkBlob]: 'src',
        [sourceBlob]: 'import packageName from "example-package";',
      },
    );

    await expect(
      withTrustedSnapshot({ repository, reads: reader, temporaryRoot: tempRoot() }, (snapshot) =>
        snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
      ),
    ).resolves.toMatchObject({ kind: 'ready', value: { ok: false, error: { category: 'path' } } });
  }
});

test('surfaces a callback failure instead of reporting the snapshot unavailable', async () => {
  const root = await tempRoot()();
  const failure = new TypeError('callback defect');
  await expect(
    withTrustedSnapshot(
      { repository, reads: reads([], {}), temporaryRoot: async () => root },
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

const configTree = [
  entry('.github', '040000', 'e'.repeat(40), 'tree'),
  entry('.github/dependabot-review.json', '100644', configBlob),
];

test('lists only the directories on configured paths, so repository size cannot block review', async () => {
  const bigTree = '2'.repeat(40);
  const source = 'import packageName from "example-package";';
  const reader = reads(
    [
      ...configTree,
      entry('big', '040000', bigTree, 'tree'),
      ...Array.from({ length: 12_000 }, (_, index) =>
        entry(`big/file-${index}.ts`, '100644', sourceBlob),
      ),
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      entry('src/a.ts', '100644', sourceBlob),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: { sendSourceExcerptsToModel: true, excerptFiles: ['src/a.ts'] },
      }),
      [sourceBlob]: source,
    },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({ kind: 'ready', value: { ok: true, status: 'available' } });
  expect(reader.calls).not.toContain(`tree:${bigTree}`);
});

test("gives an oversized excerpt C2's per-file limit without fetching its bytes", async () => {
  const reader = reads(
    [
      ...configTree,
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      { ...entry('src/a.ts', '100644', sourceBlob), size: 65_537 },
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: { sendSourceExcerptsToModel: true, excerptFiles: ['src/a.ts'] },
      }),
    },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({
    kind: 'ready',
    value: { ok: true, reasons: expect.arrayContaining(['file-byte-limit']) },
  });
  expect(JSON.stringify(result)).not.toContain('excerpt"');
  expect(reader.calls).not.toContain(`blob:${sourceBlob}`);
});

test("gives an oversized config C1's size failure without fetching its bytes", async () => {
  const reader = reads([configTree[0], { ...configTree[1], size: 16_385 }], {});

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    async () => 'unreachable',
  );

  expect(result).toMatchObject({
    kind: 'invalid-config',
    config: { ok: false, error: { category: 'size' } },
  });
  expect(reader.calls).not.toContain(`blob:${configBlob}`);
});

test.each([
  ['a missing blob size', { size: undefined }],
  ['a negative blob size', { size: -1 }],
  ['a fractional blob size', { size: 1.5 }],
])(
  'treats %s as an unavailable snapshot, even for a blob never fetched',
  async (_label, override) => {
    const reader = reads(
      [...configTree, { ...entry('other.ts', '100644', sourceBlob), ...override }],
      {
        [configBlob]: '{"version":1}',
      },
    );
    await expect(
      withTrustedSnapshot(
        { repository, reads: reader, temporaryRoot: tempRoot() },
        async () => 'x',
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
  },
);

test.each([3, 20])(
  'treats a blob whose bytes disagree with its tree size %i as unavailable',
  async (size) => {
    const reader = reads([configTree[0], { ...configTree[1], size }], {
      [configBlob]: '{"version":1}',
    });
    await expect(
      withTrustedSnapshot(
        { repository, reads: reader, temporaryRoot: tempRoot() },
        async () => 'x',
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
  },
);

test.each([
  ['a nested name', entry('.github/x', '100644', configBlob)],
  ['a dot name', entry('..', '040000', 'e'.repeat(40), 'tree')],
])('rejects a directory listing with %s', async (_label, bad) => {
  const reader = reads([], {});
  reader.readTree = async () => ({ kind: 'available', value: [{ ...bad, size: 1 }] });
  await expect(
    withTrustedSnapshot({ repository, reads: reader, temporaryRoot: tempRoot() }, async () => 'x'),
  ).resolves.toEqual({ kind: 'unavailable' });
});

test('rejects a truncated directory listing from GitHub', async () => {
  const reader = createGithubSnapshotReads(
    createGithubTransport({
      token: 'read-token',
      now: () => 0,
      fetch: async () => new Response(JSON.stringify({ truncated: true, tree: [] })),
    }),
  );
  await expect(reader.readTree(repository, treeRevision)).resolves.toEqual({
    kind: 'unavailable',
  });
});
