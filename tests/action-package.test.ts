import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import { parseDocument } from 'yaml';

const actionDir = new URL('../.github/actions/dependabot-review/', import.meta.url);
const distDir = new URL('dist/', actionDir);
const bundlePath = new URL('index.js', distDir);
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : '';

test('declares the complete reviewer action interface and committed node24 bundle', () => {
  const document = parseDocument(readFileSync(new URL('action.yml', actionDir), 'utf8'), {
    uniqueKeys: true,
  });
  expect(document.errors).toEqual([]);
  expect(document.toJS()).toEqual({
    name: 'Dependabot review',
    description: 'Advisory dependency update review for Dependabot pull requests.',
    inputs: {
      'github-token': {
        description: 'Read-only GitHub token for repository and workflow reads.',
        required: true,
      },
      'app-token': {
        description: 'GitHub App token for managed comments and commit statuses.',
        required: true,
      },
      'llm-api-key': {
        description: 'API key for the configured language-model provider.',
        required: true,
      },
      'ci-workflow': {
        description: 'Repository-relative file path of the intended CI workflow.',
        required: true,
      },
    },
    runs: {
      using: 'node24',
      main: 'dist/index.js',
    },
  });
});

test('commits only the bundle and its license notices in the action dist directory', () => {
  expect(readdirSync(distDir).sort()).toEqual(['THIRD_PARTY_LICENSES.txt', 'index.js']);
});

test('inlines every dependency so the runner needs no node_modules', () => {
  const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const specifiers = [
    // Covers side-effect imports and import lists that span several lines.
    ...bundle.matchAll(/^(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+)["']/gm),
    ...bundle.matchAll(/(?<![\w.])(?:__require|require|import)\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
  expect(specifiers.length).toBeGreaterThan(0);
  expect(specifiers.filter((specifier) => !builtins.has(specifier))).toEqual([]);
  expect(bundle).not.toMatch(/\bcreateRequire\((?!import\.meta\.url\))/);
});

test('contains code from every production dependency', () => {
  // The unminified bundle keeps a region comment for each module it includes.
  for (const name of Object.keys(packageJson.dependencies)) {
    expect(bundle, name).toContain(`node_modules/${name}/`);
  }
});

test('notices carry the license text of every inlined package', () => {
  const notices = readFileSync(new URL('THIRD_PARTY_LICENSES.txt', distDir), 'utf8');
  const roots = new Set(
    [...bundle.matchAll(/^\/\/ (\S*node_modules\/(?:@[^/\s]+\/)?[^/\s]+)\//gm)].map((m) => m[1]!),
  );
  expect(roots.size).toBeGreaterThanOrEqual(Object.keys(packageJson.dependencies).length);
  for (const root of roots) {
    const dir = new URL(`../${root.replace(/^(\.\.\/)+/, '')}/`, import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
    const files = readdirSync(dir).filter((name) => /^(?:licen[cs]e|notice|authors)/i.test(name));
    expect(notices, pkg.name).toContain(`## ${pkg.name}@${pkg.version}\nLicense: ${pkg.license}`);
    if (files.length === 0)
      expect(notices, `${pkg.name} declaration`).toContain(
        `No license file ships with this package. Declared license: ${pkg.license}.`,
      );
    for (const file of files)
      expect(notices, `${pkg.name} ${file}`).toContain(
        readFileSync(new URL(file, dir), 'utf8').trim(),
      );
  }
});
