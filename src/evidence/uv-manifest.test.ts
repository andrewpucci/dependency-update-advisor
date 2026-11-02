import { expect, test } from 'vite-plus/test';
import { readManifest, parseRequirement } from './uv-manifest.js';
import type { UvParseLimits } from './uv-toml.js';
const limits: UvParseLimits = {
  maxFileBytes: 100_000,
  maxTomlDepth: 32,
  maxTomlEntries: 10000,
  maxPackages: 1000,
  maxDeclarations: 1000,
  maxEdges: 1000,
  maxStringBytes: 4096,
  maxRequirementTokens: 200,
  maxMarkerDepth: 16,
};
const read = (s: string, l = limits) => readManifest(new TextEncoder().encode(s), l);
function parsed(s: string, l = limits) {
  const r = read(s, l);
  expect(r.kind).toBe('parsed');
  if (r.kind !== 'parsed') throw new Error('expected parsed');
  return r;
}
test('retains four normalized extras, empty lists, positions and marker-split pins', () => {
  const r = parsed(`[project]
name = "Example_App"
requires-python = ">=3.11"
dependencies = ["Orbit.Core[Fast_IO]>=1.0,<2; python_version < '3.13'", "orbit-core==2; python_version >= '3.13'"]
[project.optional-dependencies]
Web_UI = ["nova>=1"]
cli = ["comet==1.2"]
docs = ["quasar~=2.1"]
empty = []
[tool.unrelated]
anything = "ignored"
`);
  expect(r.gaps).toEqual([]);
  expect(r.value.name).toBe('example-app');
  expect(r.value.dependencies.map((d) => [d.name, d.position, d.marker])).toEqual([
    ['orbit-core', 0, "python_version < '3.13'"],
    ['orbit-core', 1, "python_version >= '3.13'"],
  ]);
  expect(r.value.dependencies[0]).toMatchObject({
    extras: ['fast-io'],
    specifier: '>=1.0,<2',
    text: "Orbit.Core[Fast_IO]>=1.0,<2; python_version < '3.13'",
  });
  expect(r.value.optionalDependencies.map((x) => x.extra)).toEqual([
    'cli',
    'docs',
    'empty',
    'web-ui',
  ]);
  expect(r.value.optionalDependencies[2].declarations).toEqual([]);
});
test('retains exact comparator and marker text without evaluation', () => {
  const raw =
    'Pkg[x,y] (>=1.0, !=1.5) ; (python_version >= "3.11" and os_name != "nt") or extra in "web,cli"';
  expect(parseRequirement(raw, limits)).toEqual({
    text: raw,
    name: 'pkg',
    extras: ['x', 'y'],
    specifier: '(>=1.0, !=1.5)',
    marker: '(python_version >= "3.11" and os_name != "nt") or extra in "web,cli"',
  });
});
test('distinguishes absent, explicit empty, dynamic and invalid declarations', () => {
  expect(parsed('[project]\nname="p"').value.fields).toEqual({
    dependencies: 'absent',
    optionalDependencies: 'absent',
  });
  expect(
    parsed('[project]\nname="p"\ndependencies=[]\noptional-dependencies={}').value.fields,
  ).toEqual({ dependencies: 'present', optionalDependencies: 'present' });
  const r = parsed(
    '[project]\nname="p"\ndynamic=["dependencies"]\noptional-dependencies={ok=["a"]}',
  );
  expect(r.value.fields.dependencies).toBe('dynamic');
  expect(r.value.optionalDependencies).toHaveLength(1);
  expect(r.gaps).toContainEqual({ entry: 'dependencies', reason: 'unsupported' });
  expect(parsed('[project]\nname="p"\ndependencies=1').gaps).toContainEqual({
    entry: 'dependencies',
    reason: 'malformed',
  });
});
test('keeps independent declarations beside malformed and unsupported items without secret text', () => {
  const r = parsed(
    '[project]\nname="p"\ndependencies=["ok>=1", "bad>=", "remote @ https://user:secret@example.test/p", "other @ https://example.test/p", "good"]',
  );
  expect(r.value.dependencies.map((x) => x.name)).toEqual(['ok', 'good']);
  expect(r.gaps).toEqual([
    { entry: 'dependencies:1', reason: 'malformed' },
    { entry: 'dependencies:2', reason: 'malformed' },
    { entry: 'dependencies:3', reason: 'unsupported' },
  ]);
  expect(JSON.stringify(r)).not.toContain('secret');
});
test('normalization collisions never overwrite extra declarations', () => {
  const r = parsed(
    '[project]\nname="p"\n[project.optional-dependencies]\nA_B=["one"]\na-b=["two"]\nother=["three"]',
  );
  expect(r.gaps).toContainEqual({ entry: 'optional:a-b', reason: 'conflict' });
  expect(r.value.optionalDependencies.map((x) => x.extra)).toEqual(['other']);
});
test.each([
  'pkg>=',
  'pkg[',
  'pkg[x,]',
  'pkg; python_version',
  'pkg; unknown == "x"',
  'pkg; (extra == "x"',
  'pkg; extra == "x" trailing',
  'pkg; extra ==',
  'pkg>=1 junk',
])('rejects malformed tested syntax: %s', (s) => {
  expect(() => parseRequirement(s, limits)).toThrow('malformed');
});
test.each(['pkg @ https://example.test/p', 'pkg===opaque', 'pkg; extras == "x"'])(
  'does not guess unsupported syntax: %s',
  (s) => {
    expect(() => parseRequirement(s, limits)).toThrow('unsupported');
  },
);
test('enforces declaration, token and marker nesting budgets and preserves a prefix', () => {
  const r = parsed('[project]\nname="p"\ndependencies=["one", "two"]', {
    ...limits,
    maxDeclarations: 1,
  });
  expect(r.value.dependencies.map((x) => x.name)).toEqual(['one']);
  expect(r.gaps).toContainEqual({ entry: 'dependencies:1', reason: 'budget' });
  expect(parseRequirement('p>=1', { ...limits, maxRequirementTokens: 3 }).name).toBe('p');
  expect(() => parseRequirement('p>=1', { ...limits, maxRequirementTokens: 2 })).toThrow('budget');
  expect(parseRequirement('p; (extra == "x")', { ...limits, maxMarkerDepth: 1 }).name).toBe('p');
  expect(() => parseRequirement('p; ((extra == "x"))', { ...limits, maxMarkerDepth: 1 })).toThrow(
    'budget',
  );
});
test('missing project and unsafe identities are fixed failures', () => {
  for (const s of ['', '[project]\nname=1', '[project]\nname="invalid!"'])
    expect(read(s)).toEqual({ kind: 'unavailable', reason: 'malformed' });
});
test.each([
  'dependency-groups={}',
  'tool.uv.dev-dependencies=[]',
  'tool.uv.sources={}',
  'tool.uv.index=[]',
  'tool.uv.workspace={}',
  'tool.uv.constraint-dependencies=[]',
  'tool.uv.override-dependencies=[]',
  'tool.uv.exclude-dependencies=[]',
  'tool.uv.conflicts=[]',
  'tool.uv.environments=[]',
  'tool.uv.required-environments=[]',
  'tool.uv.future-resolution={}',
])('resolution metadata remains unsupported even empty: %s', (s) => {
  const r = parsed(s + '\n[project]\nname="p"\ndependencies=["ok"]');
  expect(r.value.dependencies[0].name).toBe('ok');
  expect(r.gaps.some((g) => g.reason === 'unsupported')).toBe(true);
});
test('ignores only descriptive/project/build and non-uv tool data after structural checks', () => {
  const r = parsed(
    '[project]\nname="p"\ndescription="text"\nversion="1"\nauthors=[]\nscripts={}\nlicense="MIT"\nreadme="README.md"\n[build-system]\nrequires=["build>=1"]\n[tool.other]\nflag=true',
  );
  expect(r.gaps).toEqual([]);
  expect(parsed('[project]\nname="p"\nfuture-resolution={}').gaps).toContainEqual({
    entry: 'project',
    reason: 'unsupported',
  });
});
test('malformed dynamic metadata does not erase readable static declarations or certify absent fields', () => {
  const r = parsed('[project]\nname="p"\ndynamic=1\ndependencies=["ok"]');
  expect(r.value.dependencies[0].name).toBe('ok');
  expect(r.value.fields.optionalDependencies).toBe('invalid');
  expect(r.gaps).toContainEqual({ entry: 'dynamic', reason: 'malformed' });
});
test.each(['p[]', 'p>=1,', 'p(>=1,)'])(
  'valid syntax outside the documented subset is unsupported: %s',
  (raw) => {
    expect(() => parseRequirement(raw, limits)).toThrow('unsupported');
  },
);
test.each(['p; extra in"x"', 'p; "x"in extra', 'p; extra == "a\\b"'])(
  'does not accept malformed marker lexical syntax: %s',
  (raw) => {
    expect(() => parseRequirement(raw, limits)).toThrow('malformed');
  },
);
test('unrepresentable package names are gaps rather than retained packet-incompatible identities', () => {
  const name = 'a'.repeat(1025),
    r = parsed(`[project]\nname="p"\ndependencies=["${name}","ok"]`);
  expect(r.value.dependencies.map((x) => x.name)).toEqual(['ok']);
  expect(r.gaps).toContainEqual({ entry: 'dependencies:0', reason: 'unsupported' });
  expect(JSON.stringify(r)).not.toContain(name);
});
