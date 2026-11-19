import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vite-plus/test';

// The spec's planted mutations (SPEC-limit-register.md, Verification) must fail `vp lint`.
const dir = join(process.cwd(), 'lint-planted');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function lint(source: string): string[] {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `planted-${process.pid}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      ['node_modules/vite-plus/bin/vp', 'lint', '--format', 'json', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (error) {
    output = String((error as { stdout?: string }).stdout ?? '');
  }
  const json = output.slice(output.indexOf('{'));
  return (JSON.parse(json) as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code);
}

test('a comparison against a bare limit fails lint', () => {
  expect(
    lint('export function fits(body: string) {\n  return body.length <= 50_000;\n}\n'),
  ).toContain('eslint(no-magic-numbers)');
});

test('a named constant holding a limit outside the register fails lint', () => {
  expect(lint('export const MAX_BODY = 50_000;\n')).toContain('limits(no-literal-limit)');
});

test.each([
  ['let', 'export let bodyCap = 50_000;\n'],
  ['var', 'export var bodyCap = 50_000;\n'],
  ['a BigInt', 'export const bodyCap = 50_000n;\n'],
  ['a unary plus', 'export const bodyCap = +50_000;\n'],
  ['a negative number', 'export const offset = -500;\n'],
  // The rule keys on the literal, not on the name looking like a limit.
  ['a name that does not say limit', 'export const pageSize = 300;\n'],
  ['an object field', 'export const limits = { pageSize: 300 };\n'],
])('a limit written with %s fails lint', (_label, source) => {
  expect(lint(source)).not.toEqual([]);
});

test('counters, steps, and pairs pass', () => {
  expect(
    lint(
      'export const start = { count: 0, step: 1, sides: 2 };\nexport const half = (n: number) => n / 2;\n',
    ),
  ).toEqual([]);
});
