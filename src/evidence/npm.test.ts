import { expect, test } from 'vite-plus/test';
import { collectNpmInventory } from './npm.js';
import type { GithubReadSession, GithubDiscovery } from '../github-read.js';
import type { ReviewBinding } from '../event.js';
import { validateReviewPacket } from '../schema.js';

const repository = { id: 101, owner: 'example', name: 'consumer' };
const BASE = 'b'.repeat(40),
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
function pkg(version: string, name = 'widget') {
  return { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` };
}
function fixture() {
  const input = {
    binding: structuredClone(binding),
    roots: ['.'],
    configRevision: { repository, sha: 'c'.repeat(40) },
    limits: {
      maxFileBytes: 100_000,
      maxJsonEntries: 10_000,
      maxJsonDepth: 32,
      maxRoots: 10,
      maxRetainedBytes: 1_000_000,
    },
  };
  const manifest = { dependencies: { widget: '^1' } };
  const files: Record<string, unknown> = {};
  for (const side of ['base', 'head']) {
    files[`${side}:package.json`] = structuredClone(manifest);
    files[`${side}:package-lock.json`] = {
      lockfileVersion: 3,
      packages: {
        '': structuredClone(manifest),
        'node_modules/widget': pkg(side === 'base' ? '1.0.0' : '1.5.0'),
      },
    };
  }
  const discovery: { -readonly [K in keyof GithubDiscovery]: GithubDiscovery[K] } = {
    kind: 'available',
    binding,
    complete: true,
    reasons: [],
    files: [{ path: 'package-lock.json', previousPath: null, status: 'modified', blobSha: null }],
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
      const provenance = { side, repository, commitSha: side === 'base' ? BASE : HEAD, path };
      const value = files[`${side}:${path}`];
      if (value === undefined) return { ...provenance, kind: 'absent', treeSha: 'd'.repeat(40) };
      if (value instanceof Uint8Array)
        return { ...provenance, kind: 'available', blobSha: 'e'.repeat(40), bytes: value };
      return {
        ...provenance,
        kind: 'available',
        blobSha: 'e'.repeat(40),
        bytes: new TextEncoder().encode(JSON.stringify(value)),
      };
    },
    readComparison: async () => {
      calls.push('comparison');
      return {
        kind: 'available',
        repository,
        baseSha: BASE,
        headRepository: repository,
        headSha: HEAD,
        mergeBaseSha: BASE,
        records: [],
        reasons: [],
      };
    },
    close: () => {},
  };
  return { input, session, files, discovery, calls };
}
type Inventory = Extract<Awaited<ReturnType<typeof collectNpmInventory>>, { kind: 'inventory' }>;
function inventory(result: Awaited<ReturnType<typeof collectNpmInventory>>): Inventory {
  expect(result.kind).toBe('inventory');
  if (result.kind !== 'inventory') throw new Error('expected inventory');
  return result;
}
function accepted(result: Inventory) {
  const context = { ok: true, status: 'disabled', dependencies: [], reasons: [] };
  const expected = {
    binding,
    baseSha: BASE,
    contextRevision: { repository, sha: 'c'.repeat(40) },
    context,
  };
  const absent = {
    id: 'other',
    kind: 'file-list',
    ecosystems: ['actions', 'uv'],
    memberIds: [],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'inventory',
      repository,
      baseSha: BASE,
      headSha: HEAD,
      absentEcosystems: ['actions', 'uv'],
    },
  };
  const candidate = {
    version: 1,
    ...expected,
    changes: result.changes,
    sources: [...result.sources, absent],
    coverage: {
      npm: result.coverage,
      actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
      uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
    },
    findings: [],
    relationships: [],
    reachability: [],
  };
  const validated = validateReviewPacket(candidate, expected);
  expect(validated.ok, JSON.stringify(validated)).toBe(true);
  return validated;
}

test('inventories one immutable v3 root and produces a valid npm packet contribution', async () => {
  const f = fixture();
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({
    kind: 'update',
    role: 'direct',
    directRoles: ['production'],
    from: { version: '1.0.0', lockPath: 'node_modules/widget' },
    to: { version: '1.5.0' },
  });
  accepted(result);
  expect(Object.isFrozen(result.changes[0].to)).toBe(true);
});

test('retains known data with explicit unsupported or malformed root gaps', async () => {
  for (const value of [{ lockfileVersion: 2, packages: {} }, new TextEncoder().encode('{')]) {
    const f = fixture();
    f.files['head:package-lock.json'] = value;
    const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
    expect(result.coverage.status).not.toBe('complete');
    expect(result.changes).toEqual([]);
    expect(result.gaps.length).toBeGreaterThan(0);
    accepted(result);
  }
});

test('invalid bounds and bindings dispatch no reads', async () => {
  const f = fixture();
  f.input.limits.maxRoots = 0;
  expect(await collectNpmInventory(f.input, { session: f.session })).toEqual({ kind: 'invalid' });
  expect(f.calls).toEqual([]);
});

function lock(f: ReturnType<typeof fixture>, side: 'base' | 'head') {
  return f.files[`${side}:package-lock.json`] as {
    lockfileVersion: number;
    packages: Record<string, unknown>;
  };
}
test('retains additions and removals without pairing names or inventing failed sides', async () => {
  const f = fixture();
  lock(f, 'base').packages['node_modules/old'] = pkg('1.0.0', 'old');
  lock(f, 'head').packages['node_modules/child'] = pkg('1.0.0', 'child');
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes.map((c) => c.kind).sort()).toEqual(['addition', 'removal', 'update']);
  expect(result.changes.find((c) => c.kind === 'addition')?.from).toBeNull();
  accepted(result);
  const g = fixture();
  lock(g, 'base').packages['node_modules/widget'] = { version: 123 };
  const partial = inventory(await collectNpmInventory(g.input, { session: g.session }));
  expect(partial.changes).toEqual([]);
  expect(partial.coverage.status).toBe('partial');
});

test.each(['maxFileBytes', 'maxJsonEntries', 'maxJsonDepth'] as const)(
  'enforces %s before claiming inventory completeness',
  async (field) => {
    const f = fixture();
    // Each limit admits the input envelope but not the parsed files.
    f.input.limits[field] = { maxFileBytes: 10, maxJsonEntries: 50, maxJsonDepth: 3 }[field];
    for (let i = 0; i < 30; i++) lock(f, 'head').packages[`node_modules/p${i}`] = pkg('1.0.0');
    const result = await collectNpmInventory(f.input, { session: f.session });
    expect(result).not.toMatchObject({ kind: 'invalid' });
    expect(result).not.toMatchObject({ coverage: { status: 'complete' } });
    expect(result).toMatchObject({ coverage: { reasons: expect.arrayContaining(['budget']) } });
  },
);

test('does not execute getters in the unknown binding', async () => {
  const f = fixture();
  let invoked = false;
  Object.defineProperty(f.input.binding, 'repository', {
    get() {
      invoked = true;
      throw new Error('sensitive');
    },
  });
  expect(await collectNpmInventory(f.input, { session: f.session })).toEqual({ kind: 'invalid' });
  expect(invoked).toBe(false);
});

test.each(['^1.2.0', ''])(
  'retains a declaration-only edit %j with complete inventory',
  async (specifier) => {
    const f = fixture();
    lock(f, 'head').packages['node_modules/widget'] = pkg('1.0.0');
    const manifest = { dependencies: { widget: specifier } };
    f.files['head:package.json'] = manifest;
    lock(f, 'head').packages[''] = manifest;
    const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
    expect(result.coverage.status).toBe('complete');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      basis: 'declaration',
      evidence: {},
      from: { specifiers: { dependencies: '^1' } },
      to: { specifiers: { dependencies: specifier } },
    });
    accepted(result);
  },
);

test('preserves role changes independently from a resolved version update', async () => {
  const f = fixture();
  const manifest = { devDependencies: { widget: '^1.2' } };
  f.files['head:package.json'] = manifest;
  lock(f, 'head').packages[''] = manifest;
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes).toHaveLength(2);
  expect(result.changes.find((c) => !('basis' in c))).toMatchObject({
    role: 'direct',
    directRoles: ['development'],
  });
  expect(result.changes.find((c) => 'basis' in c)).toMatchObject({
    from: { specifiers: { dependencies: '^1' } },
    to: { specifiers: { devDependencies: '^1.2' } },
  });
  expect(
    result.sources
      .filter(
        (s) =>
          s.kind === 'file' && s.provenance.kind === 'file' && s.provenance.path === 'package.json',
      )
      .every((s) => s.memberIds.length === 2),
  ).toBe(true);
  accepted(result);
});

test('retains declaration additions despite an unavailable lock and flags stale lock declarations', async () => {
  const f = fixture();
  f.files['head:package.json'] = { dependencies: { widget: '^2', added: '^1' } };
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['conflict'] });
  expect(result.changes.filter((c) => 'basis' in c)).toHaveLength(2);
  accepted(result);
});

test('keeps equal names in independent nested roots distinct and deterministic', async () => {
  const f = fixture();
  f.input.roots = ['.', 'packages/api'];
  for (const [key, value] of Object.entries({ ...f.files })) {
    const [side, file] = key.split(':');
    f.files[`${side}:packages/api/${file}`] = structuredClone(value);
  }
  f.discovery.files = [
    ...f.discovery.files,
    {
      path: 'packages/api/package-lock.json',
      previousPath: null,
      status: 'modified',
      blobSha: null,
    },
  ];
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.changes).toHaveLength(2);
  expect(result.changes.map((c) => (c.to && 'root' in c.to ? c.to.root : null)).sort()).toEqual([
    '.',
    'packages/api',
  ]);
  accepted(result);
  f.discovery.files = [...f.discovery.files].reverse();
  f.input.roots.reverse();
  expect(await collectNpmInventory(f.input, { session: f.session })).toEqual(result);
});

test('directory moves remain proven removals and additions at distinct roots', async () => {
  const f = fixture();
  f.input.roots = ['old', 'new'];
  for (const [key, value] of Object.entries({ ...f.files })) {
    const [side, file] = key.split(':');
    delete f.files[key];
    f.files[`${side}:${side === 'base' ? 'old' : 'new'}/${file}`] = value;
  }
  f.discovery.files = [
    {
      path: 'new/package-lock.json',
      previousPath: 'old/package-lock.json',
      status: 'renamed',
      blobSha: null,
    },
  ];
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(
    result.changes
      .filter((c) => !('basis' in c))
      .map((c) => c.kind)
      .sort(),
  ).toEqual(['addition', 'removal']);
  expect(result.changes.filter((c) => 'basis' in c)).toHaveLength(2);
  accepted(result);
});

test('configuration cannot hide a changed root and partial discovery cannot prove npm absent', async () => {
  const f = fixture();
  f.input.roots = [];
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes).toHaveLength(1);
  expect(result.coverage.reasons).toContain('conflict');
  accepted(result);
  const g = fixture();
  g.discovery.files = [];
  expect(
    inventory(await collectNpmInventory(g.input, { session: g.session })).coverage.status,
  ).toBe('not_applicable');
  Object.assign(g.discovery, { complete: false, kind: 'partial', reasons: ['budget'] });
  expect(
    inventory(await collectNpmInventory(g.input, { session: g.session })).coverage,
  ).toMatchObject({ status: 'partial', reasons: ['budget'] });
});

test('uses installed alias slots for direct attribution without collapsing actual package identities', async () => {
  const f = fixture();
  for (const side of ['base', 'head'] as const) {
    const manifest = { dependencies: { alias: 'npm:actual@^1' } };
    f.files[`${side}:package.json`] = manifest;
    lock(f, side).packages = {
      '': manifest,
      'node_modules/alias': {
        ...pkg(side === 'base' ? '1.0.0' : '1.5.0', 'actual'),
        name: 'actual',
      },
    };
  }
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.changes[0]).toMatchObject({
    role: 'direct',
    directRoles: ['production'],
    to: { name: 'actual', lockPath: 'node_modules/alias' },
  });
  accepted(result);
});

test('different packages occupying a slot are removal/addition records', async () => {
  const f = fixture();
  Object.assign(lock(f, 'head').packages['node_modules/widget'] as object, { name: 'replacement' });
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes.map((c) => c.kind).sort()).toEqual(['addition', 'removal']);
  expect(result.coverage.reasons).toContain('conflict');
  accepted(result);
});

test.each([
  ['git+https://example.test/repo.git#' + 'd'.repeat(40), 'git'],
  ['file:packages/local', 'path'],
  ['https://example.test/archive.tgz', 'url'],
])('preserves package source %s', async (resolved, kind) => {
  const f = fixture();
  Object.assign(lock(f, 'head').packages['node_modules/widget'] as object, { resolved });
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes[0].to).toMatchObject({ source: { kind } });
  accepted(result);
});

test('retains N2 metadata and reports unsupported same-version metadata changes', async () => {
  const f = fixture();
  lock(f, 'head').packages['node_modules/widget'] = {
    ...pkg('1.0.0'),
    integrity: 'sha512-new',
    hasInstallScript: true,
    optionalDependencies: { extra: '^1' },
  };
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes).toEqual([]);
  expect(result.coverage.reasons).toContain('unsupported');
  expect(result.roots[0].head.packages['node_modules/widget']).toMatchObject({
    integrity: 'sha512-new',
    hasInstallScript: true,
    optionalDependencies: { extra: '^1' },
  });
  accepted(result);
});

test('retention overflow preserves a bounded known prefix with explicit budget coverage', async () => {
  const f = fixture();
  for (let i = 0; i < 25; i++)
    lock(f, 'head').packages[`node_modules/child-${i}`] = pkg('1.0.0', `child-${i}`);
  f.input.limits.maxRetainedBytes = 12_000;
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes.length).toBeGreaterThan(0);
  expect(result.changes.length).toBeLessThan(26);
  expect(result.coverage.reasons).toContain('budget');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12_000);
  accepted(result);
});

test('unsupported workspace links and ranged locked versions stay explicit without inventing instances', async () => {
  const f = fixture();
  lock(f, 'head').packages['node_modules/widget'] = { link: true, resolved: 'packages/widget' };
  lock(f, 'head').packages['node_modules/ranged'] = { ...pkg('^1.0.0', 'ranged') };
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes).toEqual([]);
  expect(result.coverage.reasons).toContain('unsupported');
  expect(result.roots[0].head.packages['node_modules/widget']).toMatchObject({
    instance: null,
    link: 'packages/widget',
  });
  accepted(result);
});

test.each(['permission', 'rate_limit', 'unknown', 'timeout', 'budget'] as const)(
  'comparison failure %s preserves complete file inventory',
  async (why) => {
    const f = fixture();
    const read = f.session.readComparison;
    Object.assign(f.session, {
      readComparison: async () => ({ ...(await read()), kind: 'unavailable', reasons: [why] }),
    });
    const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
    expect(result.coverage.status).toBe('complete');
    expect(result.changes).toHaveLength(1);
    expect(result).toMatchObject({ comparison: { status: 'unavailable', reasons: [why] } });
    expect(
      result.sources.some(
        (s) => s.kind === 'comparison' && s.status === 'unavailable' && s.reasons.includes(why),
      ),
    ).toBe(true);
    expect(f.calls.at(-1)).toBe('comparison');
    accepted(result);
  },
);

test('a comparison discrepancy stays a gap without fabricating an unbacked version', async () => {
  const f = fixture();
  const read = f.session.readComparison;
  Object.assign(f.session, {
    readComparison: async () => ({
      ...(await read()),
      records: [
        {
          change_type: 'added',
          manifest: 'package-lock.json',
          ecosystem: 'npm',
          name: 'omitted',
          version: '2.0.0',
          package_url: 'pkg:npm/omitted@2.0.0',
        },
      ],
    }),
  });
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes).toHaveLength(1);
  expect(result.coverage.reasons).toContain('conflict');
  expect(result).toMatchObject({ comparison: { status: 'partial', reasons: ['conflict'] } });
  accepted(result);
});

test('known empty and exactly attributable comparison records are independent corroboration', async () => {
  const f = fixture();
  const read = f.session.readComparison;
  Object.assign(f.session, {
    readComparison: async () => ({
      ...(await read()),
      records: [
        {
          change_type: 'added',
          manifest: 'package-lock.json',
          ecosystem: 'npm',
          name: 'widget',
          version: '1.5.0',
          package_url: 'pkg:npm/widget@1.5.0',
        },
      ],
    }),
  });
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result).toMatchObject({ comparison: { status: 'available', recordCount: 1 } });
  expect(result.changes).toHaveLength(1);
  accepted(result);
});

test('rejects sparse arrays with overridden methods without executing them', async () => {
  const f = fixture();
  let invoked = false;
  const roots: string[] = [];
  roots.length = 1;
  Object.defineProperty(roots, 'map', {
    value: () => {
      invoked = true;
      return [];
    },
  });
  f.input.roots = roots;
  expect(await collectNpmInventory(f.input, { session: f.session })).toEqual({ kind: 'invalid' });
  expect(invoked).toBe(false);
  expect(f.calls).toEqual([]);
});

test('does not retain invalid lockfile keys as diagnostic values', async () => {
  const f = fixture();
  lock(f, 'head').packages['https://user:should-not-escape@example.test/path'] = pkg('1.0.0');
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('partial');
  expect(JSON.stringify(result)).not.toContain('should-not-escape');
  accepted(result);
});

test('manifest and lock-root project identity mismatches retain readable changes with a conflict', async () => {
  const f = fixture();
  f.files['head:package.json'] = { name: 'expected', dependencies: { widget: '^1' } };
  lock(f, 'head').packages[''] = { name: 'other', dependencies: { widget: '^1' } };
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes).toHaveLength(1);
  expect(result.coverage.reasons).toContain('conflict');
  accepted(result);
});

test('inherited object member names are ordinary declarations and installed slots', async () => {
  const f = fixture();
  const base = { dependencies: { widget: '^1', valueOf: '1.0.0' } };
  const head = { dependencies: { widget: '^1', valueOf: '2.0.0', toString: '1.0.0' } };
  f.files['base:package.json'] = base;
  f.files['head:package.json'] = head;
  lock(f, 'base').packages[''] = structuredClone(base);
  lock(f, 'head').packages[''] = structuredClone(head);
  lock(f, 'head').packages['node_modules/hasOwnProperty'] = pkg('1.0.0', 'hasOwnProperty');
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  const declarations = result.changes.filter((c) => 'basis' in c);
  expect(declarations.map((c) => [c.kind, c.to && 'name' in c.to ? c.to.name : null])).toEqual(
    expect.arrayContaining([
      ['addition', 'toString'],
      ['update', 'valueOf'],
    ]),
  );
  expect(declarations).toHaveLength(2);
  expect(declarations.find((c) => c.kind === 'addition')?.from).toBeNull();
  expect(
    result.changes.find((c) => c.to && 'lockPath' in c.to && c.to.name === 'hasOwnProperty'),
  ).toMatchObject({ role: 'transitive' });
  for (const member of [Object.prototype.toString, Object.prototype.valueOf])
    expect(Object.hasOwn(member, 'dependencies')).toBe(false);
  accepted(result);
});

test('reordered comparison records keep sources and gaps identical', async () => {
  const records = [
    ['added', 'alpha', '1.0.0'],
    ['added', 'beta', '1.0.0'],
    ['added', 'omitted', '1.0.0'],
  ].map(([change_type, name, version]) => ({
    change_type,
    manifest: 'package-lock.json',
    ecosystem: 'npm',
    name,
    version,
  }));
  const results = [];
  for (const rows of [records, [...records].reverse()]) {
    const f = fixture();
    lock(f, 'head').packages['node_modules/alpha'] = pkg('1.0.0', 'alpha');
    lock(f, 'head').packages['node_modules/beta'] = pkg('1.0.0', 'beta');
    const read = f.session.readComparison;
    Object.assign(f.session, {
      readComparison: async () => ({ ...(await read()), records: rows }),
    });
    results.push(inventory(await collectNpmInventory(f.input, { session: f.session })));
  }
  expect(results[0].comparison.sourceIds).toHaveLength(2);
  expect(results[1]).toEqual(results[0]);
});

test('comparison discrepancies are scoped to their manifest root', async () => {
  const f = fixture();
  const read = f.session.readComparison;
  Object.assign(f.session, {
    readComparison: async () => ({
      ...(await read()),
      records: [
        {
          change_type: 'added',
          manifest: 'packages/api/package-lock.json',
          ecosystem: 'npm',
          name: 'omitted',
          version: '2.0.0',
        },
      ],
    }),
  });
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.gaps).toEqual([
    { root: 'packages/api', side: null, path: null, reason: 'conflict' },
  ]);
});

test('look-alike npm file names do not create candidate roots', async () => {
  const f = fixture();
  f.discovery.files = [
    ...f.discovery.files,
    { path: 'docs/package_json', previousPath: null, status: 'added', blobSha: null },
    { path: 'tools/package-lockXjson', previousPath: null, status: 'added', blobSha: null },
  ];
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.roots.map((r) => r.root)).toEqual(['.']);
  expect(result.coverage.status).toBe('complete');
});

test.each([
  ['git+ssh://git@github.com/org/other.git', 'direct'],
  ['git+ssh://git@github.com:org/other.git#v1', 'direct'],
  ['git+https://synthetic-token@example.test/other.git', 'unknown'],
  ['git+ssh://git@x:synthetic@example.test/other.git', 'unknown'],
])('manifest specifier %s leaves the widget role %s', async (other, role) => {
  const f = fixture();
  const manifest = { dependencies: { widget: '^1', other } };
  for (const side of ['base', 'head'] as const) {
    f.files[`${side}:package.json`] = structuredClone(manifest);
    lock(f, side).packages[''] = structuredClone(manifest);
  }
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.changes.find((c) => !('basis' in c))).toMatchObject({ role });
  expect(JSON.stringify(result)).not.toContain('synthetic');
  if (role === 'direct') expect(result.coverage.status).toBe('complete');
  else expect(result.gaps.map((g) => g.reason)).toContain('malformed');
  accepted(result);
});

test('counts the input envelope as depth 1 like parsed files', async () => {
  const f = fixture();
  f.input.limits.maxJsonDepth = 2;
  expect(await collectNpmInventory(f.input, { session: f.session })).toEqual({ kind: 'invalid' });
  expect(f.calls).toEqual([]);
  const g = fixture();
  g.input.limits.maxJsonDepth = 3;
  expect(await collectNpmInventory(g.input, { session: g.session })).not.toEqual({
    kind: 'invalid',
  });
});

test('ambiguous comparison rows stay unattributed without an inventory gap', async () => {
  const f = fixture();
  for (const parent of ['a', 'b'])
    lock(f, 'head').packages[`node_modules/${parent}/node_modules/x`] = pkg('1.0.0', 'x');
  const read = f.session.readComparison;
  Object.assign(f.session, {
    readComparison: async () => ({
      ...(await read()),
      records: [
        {
          change_type: 'added',
          manifest: 'package-lock.json',
          ecosystem: 'npm',
          name: 'x',
          version: '1.0.0',
        },
      ],
    }),
  });
  const result = inventory(await collectNpmInventory(f.input, { session: f.session }));
  expect(result.coverage.status).toBe('complete');
  expect(result.gaps).toEqual([]);
  expect(result.comparison).toMatchObject({
    status: 'partial',
    reasons: ['conflict'],
    sourceIds: [],
  });
  expect(result.sources.filter((s) => s.kind === 'comparison')).toEqual([]);
  accepted(result);
});
