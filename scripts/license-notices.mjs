import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Writes the license text of every package inlined into the action bundle.
// Rolldown leaves a `// <path>/node_modules/<package>/...` region comment per included module.
const distDir = process.argv[2];
if (!distDir) throw new Error('usage: license-notices.mjs <action-dist-dir>');
const bundle = readFileSync(join(distDir, 'index.js'), 'utf8');
const roots = [
  ...new Set(
    [...bundle.matchAll(/^\/\/ (\S*node_modules\/(?:@[^/\s]+\/)?[^/\s]+)\//gm)].map((m) => m[1]),
  ),
];
if (roots.length === 0) throw new Error('no bundled packages found in index.js');

const entries = roots.map((root) => {
  const dir = root.replace(/^(\.\.\/)+/, '');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (typeof pkg.license !== 'string')
    throw new Error(`${pkg.name}@${pkg.version} declares no license`);
  const files = readdirSync(dir)
    .filter((name) => /^licen[cs]e/i.test(name))
    .sort();
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  // Some packages ship data under a declared license without a license file; record the
  // declaration and source instead of failing the build.
  const text = files.length
    ? files.map((file) => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n')
    : `No license file ships with this package. Declared license: ${pkg.license}.` +
      (repository ? ` Source: ${repository}` : '');
  return { id: `${pkg.name}@${pkg.version}`, license: pkg.license, text };
});
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const body = entries
  .map(({ id, license, text }) => `## ${id}\nLicense: ${license}\n\n${text}\n`)
  .join('\n');
writeFileSync(
  join(distDir, 'THIRD_PARTY_LICENSES.txt'),
  `Third-party software inlined into dist/index.js.\n\n${body}`,
);
