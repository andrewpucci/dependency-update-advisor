/**
 * The name separator probe's runner, the largest-legitimate-use check for
 * `limit:advisory.discovery.spellingCeiling`:
 *
 *   npm run probe:name-separators -- <index.json>
 *
 * The argument is a PEP 691 JSON simple index the caller downloaded, such as PyPI's
 * (`curl -H 'Accept: application/vnd.pypi.simple.v1+json' https://pypi.org/simple/`). It prints
 * the name count, the names by separator count and the most separators any name has. It prints
 * counts only, never a name, and the index is never committed. All logic is in core.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { indexNames, summarizeSeparators } = (await import(
  pathToFileURL(join(ROOT, 'scripts/probe-name-separators/core.ts')).href
)) as typeof Core;

const [index] = process.argv.slice(2);
if (index === undefined) {
  console.error('usage: npm run probe:name-separators -- <index.json>');
  process.exit(1);
}
const names = indexNames(JSON.parse(readFileSync(index, 'utf8')) as unknown);
console.log(JSON.stringify(summarizeSeparators(names)));
