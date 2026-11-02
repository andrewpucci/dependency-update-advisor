import { expect, test } from 'vite-plus/test';
import { readLock } from './uv-lock.js';
import type { UvParseLimits } from './uv-toml.js';
const limits: UvParseLimits = {
  maxFileBytes: 100000,
  maxTomlDepth: 32,
  maxTomlEntries: 10000,
  maxPackages: 1000,
  maxDeclarations: 1000,
  maxEdges: 1000,
  maxStringBytes: 4096,
  maxRequirementTokens: 200,
  maxMarkerDepth: 16,
};
const header = (revision = 3) => `version=1\nrevision=${revision}\nrequires-python=">=3.11"\n`;
const pkg = (name = 'Orbit_Core', version = '1.0', extra = '') =>
  `[[package]]\nname="${name}"\nversion="${version}"\nsource={registry="https://pypi.org/simple"}\n${extra}`;
const read = (s: string, l = limits) => readLock(new TextEncoder().encode(s), l);
function parsed(s: string, l = limits) {
  const r = read(s, l);
  expect(r.kind).toBe('parsed');
  if (r.kind !== 'parsed') throw new Error('expected parsed');
  return r;
}
test.each([3, 5])(
  'retains schema 1/%s variants, markers, conditional and qualified edges and empty extras',
  (revision) => {
    const r = parsed(
      header(revision) +
        `resolution-markers=["python_version < '3.13'", "python_version >= '3.13'"]\n` +
        pkg(
          'Orbit_Core',
          '1.0',
          `resolution-markers=["python_version < '3.13'"]\ndependencies=[{name="nova", version="2.0",source={registry="https://pypi.org/simple"},marker="sys_platform == 'linux'",extra=["Fast_IO"]},{name="nova"}]\n[package.optional-dependencies]\nempty=[]\nweb=[{name="nova"}]\n`,
        ) +
        pkg('orbit-core', '2.0') +
        `[[package]]\nname="project"\nsource={editable="."}\n[package.metadata]\nrequires-dist=[]\nprovides-extras=[]\n`,
    );
    expect(r.gaps).toEqual([]);
    expect(r.value.revision).toBe(revision);
    expect(r.value.packages).toHaveLength(3);
    const first = r.value.packages.find((p) => p.name === 'orbit-core' && p.version === '1.0')!;
    expect(first.dependencies?.[0]).toMatchObject({
      name: 'nova',
      version: '2.0',
      marker: "sys_platform == 'linux'",
      extra: ['fast-io'],
      source: { kind: 'registry', url: 'https://pypi.org/simple' },
    });
    expect(first.dependencies?.[1]).toMatchObject({ name: 'nova', version: null, source: null });
    expect(first.optionalDependencies?.[0]).toEqual({ extra: 'empty', declarations: [] });
    expect(r.value.packages.find((p) => p.name === 'project')).toMatchObject({
      version: null,
      external: false,
      source: { kind: 'editable', path: '.' },
    });
  },
);
test.each([
  'revision=3',
  'version="1"\nrevision=3',
  'version=1\nrevision="3"',
  'version=-1\nrevision=3',
  'version=1.5\nrevision=3',
  'version=1\nrevision=-1',
])('invalid schema shapes are malformed: %s', (s) =>
  expect(read(s)).toEqual({ kind: 'unavailable', reason: 'malformed' }),
);
test.each(['version=1', 'version=1\nrevision=4', 'version=2\nrevision=3', 'version=1\nrevision=0'])(
  'untested well-formed headers are unsupported: %s',
  (s) => expect(read(s)).toEqual({ kind: 'unavailable', reason: 'unsupported' }),
);
test('duplicate exact identities conflict independent of resolution markers; distinct versions survive', () => {
  const r = parsed(
    header() +
      pkg('A_B', '1', `resolution-markers=["extra == 'x'"]\n`) +
      pkg('a-b', '1') +
      pkg('a-b', '2'),
  );
  expect(r.value.packages.map((p) => p.version)).toEqual(['2']);
  expect(r.gaps.some((g) => g.reason === 'conflict')).toBe(true);
});
test('unsupported or credential-bearing sources cannot leak or erase independent entries', () => {
  for (const source of [
    '{git="https://example.test/repo"}',
    '{editable="../other"}',
    '{registry="https://user:secret@example.test/simple"}',
    '{registry="https://example.test/?token=secret"}',
    '{}',
  ]) {
    const r = parsed(
      header() + `[[package]]\nname="bad"\nversion="1"\nsource=${source}\n` + pkg('good', '1'),
    );
    expect(r.value.packages.map((p) => p.name)).toEqual(['good']);
    expect(r.gaps).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('secret');
  }
});
test('wrong consumed entry shapes leave partial evidence and exact edge positions', () => {
  const r = parsed(
    header() +
      pkg('good', '1', `dependencies=[{name="first"},{name=2},{name="last"}]\n`) +
      `[[package]]\nname=3\nsource={registry="https://pypi.org/simple"}\n`,
  );
  expect(r.value.packages).toHaveLength(1);
  expect(r.value.packages[0].dependencies?.map((e) => [e.name, e.position])).toEqual([
    ['first', 0],
    ['last', 2],
  ]);
  expect(r.gaps.map((g) => g.reason)).toEqual(['malformed', 'malformed']);
});
test('package and edge caps preserve explicit incomplete prefixes', () => {
  const s = header() + pkg('a', '1', `dependencies=[{name="x"},{name="y"}]\n`) + pkg('b', '1');
  const r = parsed(s, { ...limits, maxPackages: 1, maxEdges: 1 });
  expect(r.value.packages).toHaveLength(1);
  expect(r.value.packages[0].dependencies).toHaveLength(1);
  expect(r.gaps.filter((g) => g.reason === 'budget')).toHaveLength(2);
});
test.each([3, 5])(
  'retains root declarations and missing versus empty metadata on revision %s',
  (revision) => {
    const self = `[[package]]\nname="project"\nsource={editable="."}\n`;
    const missing = parsed(header(revision) + self + pkg('registry', '1'));
    expect(missing.value.packages.every((p) => p.metadata === null)).toBe(true);
    expect(missing.gaps.filter((g) => g.reason === 'unsupported')).toHaveLength(1);
    const r = parsed(
      header(revision) +
        self +
        `[package.metadata]\nrequires-dist=[{name="Orbit_Core",extras=["Fast_IO"],specifier=">=1,<2",marker="extra == 'web'"},{name="orbit-core",specifier="==2",marker="extra != 'web'"}]\nprovides-extras=["Web_UI","empty"]\n`,
    );
    expect(r.gaps).toEqual([]);
    expect(r.value.packages[0].metadata).toMatchObject({
      providesExtras: ['empty', 'web-ui'],
      requiresDist: [
        { name: 'orbit-core', extras: ['fast-io'], specifier: '>=1,<2', position: 0 },
        { name: 'orbit-core', position: 1 },
      ],
    });
    const empty = parsed(
      header(revision) + self + `[package.metadata]\nrequires-dist=[]\nprovides-extras=[]\n`,
    );
    expect(empty.value.packages[0].metadata).toEqual({ requiresDist: [], providesExtras: [] });
    expect(empty.gaps).toEqual([]);
  },
);
test.each([
  'manifest={}',
  'options={}',
  'conflicts=[]',
  'supported-markers=[]',
  'required-markers=[]',
  'default-groups=[]',
  'dependency-groups={}',
  'group-requires-python={}',
  'future-resolution={}',
])('unknown/unsupported lock-root field: %s', (field) => {
  expect(parsed(header() + field + '\n' + pkg()).gaps).toContainEqual({
    entry: null,
    reason: 'unsupported',
  });
});
test.each([
  'dev-dependencies={}',
  'dependency-groups={}',
  'default-groups=[]',
  'group-requires-python={}',
  'exclude-newer="2026-01-01"',
  'future-resolution={}',
])('unsupported package resolution field: %s', (field) => {
  const r = parsed(header(5) + pkg('good', '1', field + '\n'));
  expect(r.value.packages).toHaveLength(1);
  expect(r.gaps.some((g) => g.reason === 'unsupported')).toBe(true);
});
test.each(['requires-dev={}', 'dependency-groups={}', 'future-requirements=[]'])(
  'unsupported declaration metadata aliases: %s',
  (field) => {
    const r = parsed(
      header(5) +
        pkg('good', '1', `[package.metadata]\nrequires-dist=[]\nprovides-extras=[]\n${field}\n`),
    );
    expect(r.gaps.some((g) => g.reason === 'unsupported')).toBe(true);
  },
);
test('validates artifacts then discards their values instead of creating packages or retaining URLs', () => {
  const r = parsed(
    header() +
      pkg(
        'good',
        '1',
        `sdist={url="https://files.example.test/p.tar.gz",hash="sha256:${'a'.repeat(64)}",size=0,upload-time="2026-01-01T00:00:00Z"}\nwheels=[{url="https://files.example.test/p.whl",hash="sha256:${'b'.repeat(64)}",size=20}]\n`,
      ),
  );
  expect(r.gaps).toEqual([]);
  expect(r.value.packages).toHaveLength(1);
  expect(JSON.stringify(r)).not.toContain('files.example');
});
test.each([
  'sdist=1',
  'wheels={}',
  'sdist={url="https://user:secret@example.test/a"}',
  'sdist={url="https://example.test/a",size=-1}',
  'sdist={url="https://example.test/a",hash="nonsense"}',
  'sdist={url="https://example.test/a",upload-time=1}',
  'sdist={url="https://example.test/a",future=1}',
])('invalid/untested artifact metadata leaves fixed scoped gaps: %s', (artifact) => {
  const r = parsed(header() + pkg('good', '1', artifact + '\n'));
  expect(r.value.packages).toHaveLength(1);
  expect(r.gaps).toHaveLength(1);
  expect(JSON.stringify(r)).not.toContain('secret');
});
test('bad metadata items and missing root fields retain independently validated evidence', () => {
  const r = parsed(
    'version=1\nrevision=5\n' +
      pkg(
        'good',
        '1',
        `[package.metadata]\nrequires-dist=[{name="ok",specifier=">=1"},{name="bad",url="https://example.test/p"},{name="last"}]\nprovides-extras=["A_B","a-b"]\n`,
      ),
  );
  expect(r.value.requiresPython).toBeNull();
  expect(r.value.packages[0].metadata?.requiresDist?.map((x) => x.name)).toEqual(['ok', 'last']);
  expect(r.value.packages[0].metadata?.providesExtras).toBeNull();
  expect(r.gaps.map((g) => g.reason)).toContain('conflict');
});
test.each(['version=1.0\nrevision=3', 'version=1\nrevision=5e0'])(
  'integral TOML floats are malformed headers rather than integer schema tokens: %s',
  (header) => {
    expect(read(header)).toEqual({ kind: 'unavailable', reason: 'malformed' });
  },
);
test('numeric invalid entries cannot discard independent packages; artifact sizes are integer tokens', () => {
  const r = parsed(
    header() +
      pkg('good', '1', `sdist={url="https://example.test/p",size=1.0}\n`) +
      `[[package]]\nname="bad"\nversion=1\nsource={registry="https://pypi.org/simple"}\n`,
  );
  expect(r.value.packages.map((x) => x.name)).toEqual(['good']);
  expect(r.gaps.map((g) => g.reason)).toEqual(['malformed', 'malformed']);
});
test('unrepresentable source identities leave fixed gaps while bounded metadata survives', () => {
  const source = 'https://example.test/' + 'x'.repeat(1100);
  const r = parsed(
    header() + pkg('bad', '1', '').replace('https://pypi.org/simple', source) + pkg('good', '1'),
  );
  expect(r.value.packages.map((x) => x.name)).toEqual(['good']);
  expect(r.gaps).toContainEqual({ entry: null, reason: 'unsupported' });
  expect(JSON.stringify(r)).not.toContain(source);
});
test('resolution-marker collections sort without changing exact marker text', () => {
  const r = parsed(
    header() + `resolution-markers=["sys_platform == 'win32'", "os_name == 'posix'"]\n` + pkg(),
  );
  expect(r.value.resolutionMarkers).toEqual(["os_name == 'posix'", "sys_platform == 'win32'"]);
});
