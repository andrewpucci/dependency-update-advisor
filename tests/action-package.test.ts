import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';

const actionDir = new URL('../.github/actions/dependabot-review/', import.meta.url);
const distDir = new URL('dist/', actionDir);
const bundlePath = new URL('index.js', distDir);
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : '';

test('declares a node24 action that runs the committed bundle', () => {
  const action = readFileSync(new URL('action.yml', actionDir), 'utf8');
  expect(action).toMatch(/^name: .+$/m);
  expect(action).toMatch(/^description: .+$/m);
  expect(action).toMatch(/^runs:\n {2}using: node24\n {2}main: dist\/index\.js$/m);
  expect(action).not.toMatch(/^inputs:/m);
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
