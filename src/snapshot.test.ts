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
import { limit, SNAPSHOT_FIXED_READS } from './limits.js';

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

test('follows a .github link to the repository root before reading the config', async () => {
  const rootLink = '1'.repeat(40);
  const reader = reads(
    [entry('.github', '120000', rootLink), entry('dependabot-review.json', '100644', configBlob)],
    { [rootLink]: '.', [configBlob]: '{"version":2}' },
  );

  await expect(
    withTrustedSnapshot(
      { repository, reads: reader, temporaryRoot: tempRoot() },
      async () => 'unreachable',
    ),
  ).resolves.toMatchObject({ kind: 'invalid-config', config: { ok: false } });
  expect(reader.calls).toContain(`blob:${configBlob}`);
});

test('does not fetch a configured source file C2 excludes before reading it', async () => {
  const reader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      entry('src/secrets.ts', '100644', sourceBlob),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: {
          sendSourceExcerptsToModel: true,
          sourceRoots: ['src'],
          excerptFiles: ['src/secrets.ts'],
        },
      }),
      [sourceBlob]: 'import examplePackage from "example-package";',
    },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({
    kind: 'ready',
    value: { ok: true, reasons: expect.arrayContaining(['excluded-source']) },
  });
  expect(reader.calls).not.toContain(`blob:${sourceBlob}`);
});

test('stops source payload reads at C2’s aggregate one MiB limit', async () => {
  const sources = Array.from({ length: 17 }, (_, index) => `src/file-${index}.ts`);
  const reader = reads(
    [
      entry('.github', '040000', 'e'.repeat(40), 'tree'),
      entry('.github/dependabot-review.json', '100644', configBlob),
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      ...sources.map((path) => ({ ...entry(path, '100644', sourceBlob), size: 65_536 })),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: {
          sendSourceExcerptsToModel: true,
          sourceRoots: ['src'],
          excerptFiles: sources,
        },
      }),
      [sourceBlob]: 'x'.repeat(65_536),
    },
  );

  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    (snapshot) => snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]),
  );

  expect(result).toMatchObject({
    kind: 'ready',
    value: { ok: true, reasons: expect.arrayContaining(['total-read-limit']) },
  });
  expect(reader.calls.filter((call) => call === `blob:${sourceBlob}`)).toHaveLength(16);
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
  const reader = reads(
    [configTree[0], { ...configTree[1], size: limit('config.maxBytes') + 1 }],
    {},
  );

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
    reason: 'truncated',
  });
});

const dependabotBlob = '4'.repeat(40);
const dependabotFile = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: npm',
  '    directory: "/web"',
  '  - package-ecosystem: uv',
  '    directories: ["/py", "/"]',
  '',
].join('\n');
const githubTree = entry('.github', '040000', 'e'.repeat(40), 'tree');

function dependabotReader(
  files: readonly SnapshotTreeEntry[],
  blobs: Readonly<Record<string, string>> = {},
) {
  return reads([githubTree, ...files], {
    [dependabotBlob]: dependabotFile,
    [configBlob]: '{"version":1}',
    ...blobs,
  });
}

const roots = (reader: SnapshotReads, options: { isCurrent?: () => boolean } = {}) =>
  withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot(), ...options },
    (snapshot) => snapshot.dependabotRoots(),
  );

test.each(['dependabot.yml', 'dependabot.yaml'])(
  'reads exact roots from .github/%s at the pinned revision',
  async (name) => {
    const reader = dependabotReader([entry(`.github/${name}`, '100644', dependabotBlob)]);
    const result = await withTrustedSnapshot(
      { repository, reads: reader, temporaryRoot: tempRoot() },
      async (snapshot) => ({
        revision: snapshot.contextRevision,
        roots: await snapshot.dependabotRoots(),
      }),
    );
    expect(result).toEqual({
      kind: 'ready',
      value: {
        revision: { repository, sha: revision },
        roots: {
          kind: 'roots',
          revision: { repository, sha: revision },
          npm: { kind: 'roots', roots: ['web'] },
          uv: { kind: 'roots', roots: ['.', 'py'] },
        },
      },
    });
    expect(reader.calls).toEqual([
      'repository:101',
      'commit:main',
      `tree:${treeRevision}`,
      `tree:${'e'.repeat(40)}`,
      `blob:${dependabotBlob}`,
    ]);
  },
);

test('returns a frozen outcome for every kind', async () => {
  const outcomes = await Promise.all([
    roots(dependabotReader([entry('.github/dependabot.yml', '100644', dependabotBlob)])),
    roots(reads([], {})),
    roots(
      dependabotReader([
        {
          ...entry('.github/dependabot.yml', '100644', dependabotBlob),
          size: limit('dependabot.maxFileBytes') + 1,
        },
      ]),
    ),
  ]);
  for (const outcome of outcomes) {
    if (outcome.kind !== 'ready') throw new Error('fixture must be ready');
    expect(Object.isFrozen(outcome.value)).toBe(true);
  }
});

test.each([
  ['no Dependabot file', [entry('.github/other.yml', '100644', configBlob)]],
  ['no .github directory', []],
])('reports confirmed absence for %s without reading a blob', async (_label, files) => {
  const reader = files.length ? dependabotReader(files) : reads([], {});
  const result = await roots(reader);
  expect(result).toEqual({
    kind: 'ready',
    value: { kind: 'absent', revision: { repository, sha: revision } },
  });
  expect(reader.calls.filter((call) => call.startsWith('blob:'))).toEqual([]);
});

test.each([
  [
    'both names',
    [
      entry('.github/dependabot.yml', '100644', dependabotBlob),
      entry('.github/dependabot.yaml', '100644', dependabotBlob),
    ],
  ],
  ['a symlink', [entry('.github/dependabot.yml', '120000', dependabotBlob)]],
  ['a directory', [entry('.github/dependabot.yml', '040000', '5'.repeat(40), 'tree')]],
  ['a submodule', [entry('.github/dependabot.yml', '160000', '5'.repeat(40), 'commit')]],
])('reports %s as unsupported without reading a blob', async (_label, files) => {
  const reader = dependabotReader(files);
  await expect(roots(reader)).resolves.toEqual({
    kind: 'ready',
    value: { kind: 'unavailable', reason: 'unsupported' },
  });
  expect(reader.calls.filter((call) => call.startsWith('blob:'))).toEqual([]);
});

test('reports a .github submodule as unsupported, never absent', async () => {
  const reader = reads([entry('.github', '160000', 'e'.repeat(40), 'commit')], {});
  await expect(roots(reader)).resolves.toEqual({
    kind: 'ready',
    value: { kind: 'unavailable', reason: 'unsupported' },
  });
});

test('rejects an oversized file from its tree size without fetching it', async () => {
  const reader = dependabotReader([
    {
      ...entry('.github/dependabot.yml', '100644', dependabotBlob),
      size: limit('dependabot.maxFileBytes') + 1,
    },
  ]);
  await expect(roots(reader)).resolves.toEqual({
    kind: 'ready',
    value: { kind: 'unavailable', reason: 'budget' },
  });
  expect(reader.calls).not.toContain(`blob:${dependabotBlob}`);
});

test('keeps a failed read distinct from absence and from an empty root list', async () => {
  const reader = dependabotReader([entry('.github/dependabot.yml', '100644', dependabotBlob)]);
  const base = reader.readBlob;
  reader.readBlob = async (repo, sha, signal) =>
    sha === dependabotBlob
      ? { kind: 'unavailable', reason: 'rate_limit' }
      : base(repo, sha, signal);
  await expect(roots(reader)).resolves.toEqual({
    kind: 'ready',
    value: { kind: 'unavailable', reason: 'rate_limit' },
  });
});

test('carries the transport reason of a failed blob read', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/commits/main'))
      return new Response(
        JSON.stringify({ sha: revision, commit: { tree: { sha: treeRevision } } }),
      );
    if (url.endsWith(`/git/trees/${treeRevision}`))
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [{ path: '.github', mode: '040000', type: 'tree', sha: 'e'.repeat(40) }],
        }),
      );
    if (url.endsWith(`/git/trees/${'e'.repeat(40)}`))
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [
            {
              path: 'dependabot.yml',
              mode: '100644',
              type: 'blob',
              sha: dependabotBlob,
              size: 10,
            },
          ],
        }),
      );
    if (url.includes('/git/blobs/'))
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
      });
    return new Response(JSON.stringify({ private: false, default_branch: 'main' }));
  });
  const reader = createGithubSnapshotReads(
    createGithubTransport({ token: 'read-token', now: () => 0, fetch }),
  );
  await expect(roots(reader)).resolves.toEqual({
    kind: 'ready',
    value: { kind: 'unavailable', reason: 'permission' },
  });
});

test('reports bytes that disagree with the listed size as unavailable', async () => {
  const reader = dependabotReader([
    { ...entry('.github/dependabot.yml', '100644', dependabotBlob), size: 5 },
  ]);
  await expect(roots(reader)).resolves.toEqual({
    kind: 'ready',
    value: { kind: 'unavailable', reason: 'malformed' },
  });
});

test('reports unparseable configuration as unavailable, never as empty roots', async () => {
  const reader = dependabotReader([entry('.github/dependabot.yml', '100644', dependabotBlob)], {
    [dependabotBlob]: 'version: 1\nupdates: []\n',
  });
  await expect(roots(reader)).resolves.toEqual({
    kind: 'ready',
    value: { kind: 'unavailable', reason: 'malformed' },
  });
});

test('ends the snapshot as unavailable when the owner goes stale during the read', async () => {
  const reader = dependabotReader([entry('.github/dependabot.yml', '100644', dependabotBlob)]);
  let current = true;
  const base = reader.readBlob;
  reader.readBlob = async (repo, sha, signal) => {
    const result = await base(repo, sha, signal);
    if (sha === dependabotBlob) current = false;
    return result;
  };
  let continued = false;
  await expect(
    withTrustedSnapshot(
      { repository, reads: reader, temporaryRoot: tempRoot(), isCurrent: () => current },
      async (snapshot) => {
        await snapshot.dependabotRoots();
        continued = true;
      },
    ),
  ).resolves.toEqual({ kind: 'unavailable' });
  expect(continued).toBe(false);
});

test('reads Dependabot roots only from the pinned default-branch tree', async () => {
  const reader = dependabotReader([entry('.github/dependabot.yml', '100644', dependabotBlob)]);
  await roots(reader);
  expect(reader.calls.filter((call) => call.startsWith('tree:'))).toEqual([
    `tree:${treeRevision}`,
    `tree:${'e'.repeat(40)}`,
  ]);
  expect(reader.calls).toContain('commit:main');
});

test('the smallest tree entry the snapshot accepts serializes to snapshot.minTreeEntryBytes', async () => {
  const smallest = { path: 'a', mode: '040000', type: 'tree', sha: 'f'.repeat(40) };
  const reader = reads([], {});
  reader.readTree = async (_repository, sha) =>
    sha === treeRevision
      ? { kind: 'available', value: [smallest, { ...smallest, path: 'b' }] }
      : { kind: 'available', value: [] };
  await expect(
    withTrustedSnapshot({ repository, reads: reader, temporaryRoot: tempRoot() }, async () => 'ok'),
  ).resolves.toEqual({ kind: 'ready', value: 'ok' });
  // Each entry after the first costs its JSON and one comma in the response.
  expect(JSON.stringify([smallest, smallest]).length - JSON.stringify([smallest]).length).toBe(
    limit('snapshot.minTreeEntryBytes'),
  );
  // Every field is at its shortest: a shorter path, mode, type or sha is refused.
  for (const shorter of [{ path: '' }, { mode: '40000' }, { sha: 'f'.repeat(39) }]) {
    reader.readTree = async (_repository, sha) =>
      sha === treeRevision
        ? { kind: 'available', value: [{ ...smallest, ...shorter }] }
        : { kind: 'available', value: [] };
    await expect(
      withTrustedSnapshot(
        { repository, reads: reader, temporaryRoot: tempRoot() },
        async () => 'ok',
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
  }
});

test('a listing at snapshot.maxTreeEntries is read and one more entry is refused', async () => {
  const maxTreeEntries = limit('snapshot.maxTreeEntries');
  const rootListing = (count: number) => {
    const reader = reads([], {});
    const value = Array.from({ length: count }, (_, index) => ({
      path: `file-${index}.txt`,
      mode: '100644',
      type: 'blob',
      sha: sourceBlob,
      size: 0,
    }));
    reader.readTree = async (_repository, sha) =>
      sha === treeRevision ? { kind: 'available', value } : { kind: 'unavailable' };
    return reader;
  };
  const withRoot = (reader: SnapshotReads) =>
    withTrustedSnapshot({ repository, reads: reader, temporaryRoot: tempRoot() }, async () => 'ok');

  await expect(withRoot(rootListing(maxTreeEntries))).resolves.toEqual({
    kind: 'ready',
    value: 'ok',
  });
  await expect(withRoot(rootListing(maxTreeEntries + 1))).resolves.toEqual({
    kind: 'unavailable',
  });
});

test('a link target at snapshot.maxBlobBytes is read and one byte more is refused unfetched', async () => {
  const maxBlobBytes = limit('snapshot.maxBlobBytes');
  const linked = (size: number, content: string) => {
    const reader = reads(
      [
        entry('.github', '040000', 'f'.repeat(40), 'tree'),
        { ...entry('.github/dependabot-review.json', '120000', linkBlob), size },
      ],
      { [linkBlob]: content },
    );
    return reader;
  };
  const atLimit = linked(maxBlobBytes, ' '.repeat(maxBlobBytes));
  const atResult = await withTrustedSnapshot(
    { repository, reads: atLimit, temporaryRoot: tempRoot() },
    async () => 'ok',
  );
  // Whatever the blank target resolves to, the at-limit read is fetched, not refused for budget.
  expect(atLimit.calls).toContain(`blob:${linkBlob}`);
  expect(atResult.kind).toBe('unavailable');

  const pastLimit = linked(maxBlobBytes + 1, ' '.repeat(maxBlobBytes + 1));
  const pastResult = await withTrustedSnapshot(
    { repository, reads: pastLimit, temporaryRoot: tempRoot() },
    async () => 'ok',
  );
  expect(pastLimit.calls).not.toContain(`blob:${linkBlob}`);
  expect(pastResult).toEqual({ kind: 'unavailable' });
});

test('a released snapshot drops its tree, and a later tree read is unavailable', async () => {
  const reader = dependabotReader([entry('.github/dependabot.yml', '100644', dependabotBlob)]);
  const result = await withTrustedSnapshot(
    { repository, reads: reader, temporaryRoot: tempRoot() },
    async (snapshot) => {
      const before = await snapshot.dependabotRoots();
      snapshot.release();
      const after = await snapshot.dependabotRoots().then(
        (outcome) => outcome,
        (error: unknown) => ({ thrown: (error as Error).constructor.name }),
      );
      return { before, after };
    },
  );
  if (result.kind !== 'ready') throw new Error(result.kind);
  expect(result.value.before).toMatchObject({ kind: 'roots' });
  expect(result.value.after).not.toMatchObject({ kind: 'roots' });
});

/** The snapshot reads of `reader`, refused with budget past `share` requests as the transport does. */
function withShare(reader: ReturnType<typeof reads>, share: number): SnapshotReads {
  let spent = 0;
  const charged =
    <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
    async (...args: A) =>
      ++spent > share ? ({ kind: 'unavailable', reason: 'budget' } as const) : read(...args);
  return {
    readRepository: charged(reader.readRepository),
    readCommit: charged(reader.readCommit),
    readTree: charged(reader.readTree),
    readBlob: charged(reader.readBlob),
  };
}

/**
 * A repository whose excerpt files each use one package: the first `deep` in a directory of their
 * own under `src`, which costs one tree read each, and the rest in `src` itself.
 */
function excerptLayout(count: number, deep: number) {
  const files = Array.from({ length: count }, (_, i) => ({
    path: i < deep ? `src/d${i}/f.ts` : `src/f${i}.ts`,
    sha: (i + 1).toString(16).padStart(40, '0'),
  }));
  const directories = Array.from({ length: deep }, (_, i) =>
    entry(`src/d${i}`, '040000', (i + 1).toString(16).padStart(40, '7'), 'tree'),
  );
  const reader = reads(
    [
      ...configTree,
      entry('.github/dependabot.yml', '100644', dependabotBlob),
      entry('src', '040000', 'f'.repeat(40), 'tree'),
      ...directories,
      ...files.map((file) => entry(file.path, '100644', file.sha)),
    ],
    {
      [configBlob]: JSON.stringify({
        version: 1,
        context: { sendSourceExcerptsToModel: true, excerptFiles: files.map((f) => f.path) },
      }),
      [dependabotBlob]: dependabotFile,
      ...Object.fromEntries(files.map((file) => [file.sha, 'import x from "example-package";'])),
    },
  );
  return reader;
}

test('a single-directory layout reads exactly the snapshot share for the excerpt file cap', async () => {
  const share = limit('evidence.allocation.transport.snapshot.maxRequests');
  const cap = limit('context.maxSourceCandidates');
  const reader = excerptLayout(cap, 0);
  const result = await withTrustedSnapshot(
    { repository, reads: withShare(reader, share), temporaryRoot: tempRoot() },
    async (snapshot) => {
      await snapshot.dependabotRoots();
      return snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]);
    },
  );
  // One package per file meets the per-dependency fact cap, the only limit reached.
  expect(result).toMatchObject({ kind: 'ready', value: { ok: true, reasons: ['fact-limit'] } });
  // Every read fits the share, and the fixed reads are the share less one blob per file.
  expect(reader.calls).toHaveLength(share);
  expect(reader.calls.filter((call) => call.startsWith('blob:0'))).toHaveLength(cap);
  expect(reader.calls.length - cap).toBe(SNAPSHOT_FIXED_READS);
});

test('a layout deeper than the snapshot share keeps the context it read and reports budget', async () => {
  const share = limit('evidence.allocation.transport.snapshot.maxRequests');
  const cap = limit('context.maxSourceCandidates');
  // 100 extra directories: the prefixes fit the share, and it runs out among the blob reads.
  const deep = 100;
  const reader = excerptLayout(cap, deep);
  const result = await withTrustedSnapshot(
    { repository, reads: withShare(reader, share), temporaryRoot: tempRoot() },
    async (snapshot) => {
      await snapshot.dependabotRoots();
      return snapshot.collectContext([{ id: 'unit-1', name: 'example-package' }]);
    },
  );
  // Before L11 item 8 the share ran out inside collectContext and the snapshot was unavailable.
  expect(result).toMatchObject({ kind: 'ready', value: { ok: true, status: 'partial' } });
  if (result.kind !== 'ready' || !result.value.ok) throw new Error('context');
  expect(result.value.reasons).toContain('budget');
  expect(result.value.reasons).not.toContain('missing-source');
  const [dependency] = result.value.dependencies;
  expect(dependency.reasons).toContain('budget');
  // The files read before the share ran out contribute their facts.
  expect(dependency.facts.length).toBeGreaterThan(0);
  const blobs = reader.calls.filter((call) => call.startsWith('blob:0'));
  expect(blobs).toHaveLength(share - SNAPSHOT_FIXED_READS - deep);
  expect(reader.calls).toHaveLength(share);
});

/** GitHub's Get a blob body for `bytes`: base64 wrapped at 60 characters, its envelope padded by
 * the node id to exactly github.blobEnvelopeBytes. */
function blobResponse(sha: string, bytes: Uint8Array): string {
  const content = (Buffer.from(bytes).toString('base64').match(/.{1,60}/gu) ?? [])
    .map((line) => `${line}\n`)
    .join('');
  const body = (nodeId: string) =>
    JSON.stringify({
      sha,
      node_id: nodeId,
      size: bytes.byteLength,
      url: `https://api.github.com/repos/example/consumer/git/blobs/${sha}`,
      content,
      encoding: 'base64',
    });
  const envelope = Buffer.byteLength(body('')) - Buffer.byteLength(JSON.stringify(content)) + 2;
  return body('B'.repeat(limit('github.blobEnvelopeBytes') - envelope));
}

/** A GitHub API stub over `tree` and `blobs`, for the real transport and snapshot reads. */
function githubApi(tree: readonly SnapshotTreeEntry[], blobs: Readonly<Record<string, Uint8Array>>) {
  const calls: string[] = [];
  const directories = new Map<string, string>([[treeRevision, '']]);
  for (const item of tree) if (item.type === 'tree') directories.set(item.sha, item.path);
  const fetch = async (url: string) => {
    const path = new URL(url).pathname.replace('/repos/example/consumer', '');
    calls.push(path);
    if (path === '/commits/main')
      return Response.json({ sha: revision, commit: { tree: { sha: treeRevision } } });
    if (path.startsWith('/git/trees/')) {
      const directory = directories.get(path.slice('/git/trees/'.length)) ?? '';
      const prefix = directory ? `${directory}/` : '';
      const children = tree
        .filter(
          (item) => item.path.startsWith(prefix) && !item.path.slice(prefix.length).includes('/'),
        )
        .map((item) => ({
          ...item,
          path: item.path.slice(prefix.length),
          ...(item.type === 'blob' && !('size' in item)
            ? { size: blobs[item.sha]?.byteLength ?? 0 }
            : {}),
        }));
      return Response.json({ truncated: false, tree: children });
    }
    if (path.startsWith('/git/blobs/')) {
      const sha = path.slice('/git/blobs/'.length);
      const bytes = blobs[sha];
      return bytes ? new Response(blobResponse(sha, bytes)) : Response.json({}, { status: 404 });
    }
    return Response.json({ private: false, default_branch: 'main' });
  };
  const reader = createGithubSnapshotReads(
    createGithubTransport({ token: 'read-token', now: () => 0, fetch }),
  );
  return { reader, calls };
}

test('a blob at snapshot.maxReadableBlobBytes fits one GitHub blob response and one byte more does not', async () => {
  const cap = limit('snapshot.maxReadableBlobBytes');
  // The response cap binds before the blob size check: about (1 MiB − 512) × 45 ÷ 62.
  expect(cap).toBe(760_689);
  expect(cap).toBeLessThan(limit('snapshot.maxBlobBytes'));
  const sha = 'a1'.repeat(20);
  const bytesOf = (size: number) => new Uint8Array(size).fill(120);
  expect(Buffer.byteLength(blobResponse(sha, bytesOf(cap)))).toBeLessThanOrEqual(
    limit('github.maxResponseBytes'),
  );
  expect(Buffer.byteLength(blobResponse(sha, bytesOf(cap + 1)))).toBeGreaterThan(
    limit('github.maxResponseBytes'),
  );
  // Through the real transport: the read at the cap decodes whole, one byte more is refused.
  const at = githubApi([], { [sha]: bytesOf(cap) });
  const read = await at.reader.readBlob(repository, sha);
  expect(read.kind === 'available' && read.value.byteLength).toBe(cap);
  const past = githubApi([], { [sha]: bytesOf(cap + 1) });
  await expect(past.reader.readBlob(repository, sha)).resolves.toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});

test('a config or Dependabot file one byte past one blob response gets its own size failure unfetched', async () => {
  const cap = limit('snapshot.maxReadableBlobBytes');
  expect(limit('config.maxBytes')).toBe(cap);
  expect(limit('dependabot.maxFileBytes')).toBe(cap);
  const github = entry('.github', '040000', 'e'.repeat(40), 'tree');
  const config = entry('.github/dependabot-review.json', '100644', configBlob);
  const dependabot = entry('.github/dependabot.yml', '100644', dependabotBlob);
  const atCap = new TextEncoder().encode('{"version":1}'.padEnd(cap));
  const dependabotBytes = new TextEncoder().encode(dependabotFile);

  // A config at the cap is read whole through the real transport.
  const read = githubApi([github, config, dependabot], {
    [configBlob]: atCap,
    [dependabotBlob]: dependabotBytes,
  });
  const ready = await withTrustedSnapshot(
    { repository, reads: read.reader, temporaryRoot: tempRoot() },
    (snapshot) => snapshot.dependabotRoots(),
  );
  expect(ready).toMatchObject({ kind: 'ready', value: { kind: 'roots' } });
  expect(read.calls).toContain(`/git/blobs/${configBlob}`);

  // One byte more is the parser's size failure, and the blob is never fetched.
  const oversized = githubApi([github, { ...config, size: cap + 1 }, dependabot], {
    [configBlob]: new Uint8Array(cap + 1),
    [dependabotBlob]: dependabotBytes,
  });
  await expect(
    withTrustedSnapshot(
      { repository, reads: oversized.reader, temporaryRoot: tempRoot() },
      async () => 'unreachable',
    ),
  ).resolves.toMatchObject({ kind: 'invalid-config', config: { ok: false, error: { category: 'size' } } });
  expect(oversized.calls).not.toContain(`/git/blobs/${configBlob}`);

  // A Dependabot file one byte past it is unavailable for budget, unfetched, and the snapshot it
  // sits in stays ready.
  const large = githubApi([github, config, { ...dependabot, size: cap + 1 }], {
    [configBlob]: new TextEncoder().encode('{"version":1}'),
    [dependabotBlob]: new Uint8Array(cap + 1),
  });
  await expect(
    withTrustedSnapshot(
      { repository, reads: large.reader, temporaryRoot: tempRoot() },
      (snapshot) => snapshot.dependabotRoots(),
    ),
  ).resolves.toEqual({ kind: 'ready', value: { kind: 'unavailable', reason: 'budget' } });
  expect(large.calls).not.toContain(`/git/blobs/${dependabotBlob}`);
});
