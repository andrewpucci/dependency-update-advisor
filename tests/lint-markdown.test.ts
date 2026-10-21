import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

// Keep the child bound below the per-test timeout so a hang fails as a lint error.
const childTimeout = 10_000;
const testTimeout = childTimeout + 5_000;

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
  // markdownlint-cli also merges markdownlint_* variables and home rc files into
  // the repository config; isolate the child so only the fixture config applies.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^markdownlint_/i.test(name)),
  );
  return spawnSync(lintCommand, {
    shell: true,
    cwd: fixture,
    env: {
      ...env,
      HOME: fixture,
      USERPROFILE: fixture,
      PATH: `${join(root, 'node_modules/.bin')}${delimiter}${process.env.PATH}`,
    },
    encoding: 'utf8',
    timeout: childTimeout,
  });
}

test(
  'reports hidden and nested Markdown errors without modifying the files',
  () => {
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
  },
  testTimeout,
);

test(
  'retains disabled rules and excludes workspace notes and installed dependencies',
  () => {
    const long = 'x'.repeat(100);
    const valid = `# Fixture\n\n\`\`\`text\n${long}\n\`\`\`\n\n| Column |\n| ------ |\n| ${long} |\n\nTrailing spaces.  \n`;
    writeFileSync(join(fixture, 'README.md'), valid);
    for (const directory of ['.context', 'node_modules']) {
      writeFileSync(join(fixture, directory, 'ignored.md'), 'Missing heading\n');
    }

    const result = lint();

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(join(fixture, 'README.md'), 'utf8')).toBe(valid);
  },
  testTimeout,
);

test(
  'fails for malformed configuration',
  () => {
    writeFileSync(join(fixture, '.markdownlint.json'), '{ malformed');
    writeFileSync(join(fixture, 'README.md'), '# Fixture\n');

    const result = lint();

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(fixture, '.markdownlint.json'), 'utf8')).toBe('{ malformed');
  },
  testTimeout,
);
