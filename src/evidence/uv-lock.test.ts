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
        `[[package]]\nname="project"\nsource={editable="."}\n`,
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
