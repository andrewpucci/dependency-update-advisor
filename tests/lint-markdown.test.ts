import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '..');
const lintCommand: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts[
  'lint:md'
];
let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'markdown-lint-'));
  writeFileSync(
    join(fixture, '.markdownlint.json'),
    readFileSync(join(root, '.markdownlint.json'), 'utf8'),
  );
  for (const directory of ['.hidden', 'nested', '.context', 'node_modules']) {
    mkdirSync(join(fixture, directory));
  }
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function lint() {
  return spawnSync(lintCommand, {
    shell: true,
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${join(root, 'node_modules/.bin')}${delimiter}${process.env.PATH}`,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('reports hidden and nested Markdown errors without modifying the files', () => {
  const invalid = 'Missing heading\n';
  for (const file of ['.hidden/invalid.md', 'nested/invalid.md']) {
    writeFileSync(join(fixture, file), invalid);
  }

  const result = lint();

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  for (const file of ['.hidden/invalid.md', 'nested/invalid.md']) {
    expect(result.stderr + result.stdout).toContain(file);
    expect(readFileSync(join(fixture, file), 'utf8')).toBe(invalid);
  }
});

test('retains disabled rules and excludes workspace notes and installed dependencies', () => {
  const valid = '# Fixture\n\n```text\n' + 'x'.repeat(100) + '\n```\n\nTrailing spaces.  \n';
  writeFileSync(join(fixture, 'README.md'), valid);
  for (const directory of ['.context', 'node_modules']) {
    writeFileSync(join(fixture, directory, 'ignored.md'), 'Missing heading\n');
  }

  const result = lint();

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(readFileSync(join(fixture, 'README.md'), 'utf8')).toBe(valid);
});

test('fails for malformed configuration', () => {
  writeFileSync(join(fixture, '.markdownlint.json'), '{ malformed');
  writeFileSync(join(fixture, 'README.md'), '# Fixture\n');

  const result = lint();

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(fixture, '.markdownlint.json'), 'utf8')).toBe('{ malformed');
});
