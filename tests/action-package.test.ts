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

test('commits only the bundle file in the action dist directory', () => {
  expect(readdirSync(distDir)).toEqual(['index.js']);
});

test('inlines every dependency so the runner needs no node_modules', () => {
  const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const specifiers = [
    ...bundle.matchAll(/^(?:import|export)\s[^'"\n]*?from\s+["']([^"']+)["']/gm),
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
