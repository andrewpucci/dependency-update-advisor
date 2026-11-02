import { expect, test } from 'vite-plus/test';
import { readToml, type UvParseLimits } from './uv-toml.js';

export const limits: UvParseLimits = {
  maxFileBytes: 100_000,
  maxTomlDepth: 32,
  maxTomlEntries: 10_000,
  maxPackages: 1000,
  maxDeclarations: 1000,
  maxEdges: 1000,
  maxStringBytes: 4096,
  maxRequirementTokens: 200,
  maxMarkerDepth: 16,
};
const bytes = (text: string) => new TextEncoder().encode(text);
test('reads real TOML quoted/dotted keys, tables, arrays and multiline strings', () => {
  const r = readToml(bytes('"a.b" = [1, 2]\n[a.c]\ntext = """hello\nworld"""'), limits);
  expect(r).toEqual({
    kind: 'parsed',
    value: { 'a.b': [1, 2], a: { c: { text: 'hello\nworld' } } },
  });
  if (r.kind === 'parsed') expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
});
test.each([
  'a=1\na=2',
  '[a]\nx=1\n[a]\ny=2',
  'a=[',
  '__proto__=1',
  'constructor=1',
  'a.prototype=1',
])('rejects syntax/unsafe keys without raw diagnostics: %s', (s) => {
  expect(readToml(bytes(s), limits)).toEqual({ kind: 'unavailable', reason: 'malformed' });
});
test('enforces bytes before decoding, strict UTF-8, and long comments', () => {
  expect(readToml(new Uint8Array([0xff]), limits)).toEqual({
    kind: 'unavailable',
    reason: 'malformed',
  });
  const s = '#'.repeat(200);
  expect(readToml(bytes(s), { ...limits, maxFileBytes: 200 })).toEqual({
    kind: 'parsed',
    value: {},
  });
  expect(readToml(bytes(s), { ...limits, maxFileBytes: 199 })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});
test('bounds recursive inline parsing and iterative dotted-key/table structure', () => {
  for (const s of ['a=[[[0]]]', 'a={b={c=1}}', 'a.b.c=1', '[a.b]\nc=1']) {
    expect(readToml(bytes(s), { ...limits, maxTomlDepth: 4 }).kind).toBe('parsed');
    expect(readToml(bytes(s), { ...limits, maxTomlDepth: 2 })).toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
  }
  expect(readToml(bytes(`a=${'['.repeat(10000)}0${']'.repeat(10000)}`), limits)).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});
test('counts structural entries cumulatively, including ignored values and keys', () => {
  const budget = { entries: 0, packages: 0, declarations: 0, edges: 0 };
  expect(readToml(bytes('a=[1,2]'), { ...limits, maxTomlEntries: 3 }, budget).kind).toBe('parsed');
  expect(budget.entries).toBe(3);
  expect(readToml(bytes('b=1'), { ...limits, maxTomlEntries: 3 }, budget)).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(readToml(bytes('a="1234"'), { ...limits, maxStringBytes: 4 }).kind).toBe('parsed');
  expect(readToml(bytes('a="12345"'), { ...limits, maxStringBytes: 4 })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(readToml(bytes('"ééé"=1'), { ...limits, maxStringBytes: 4 })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});
