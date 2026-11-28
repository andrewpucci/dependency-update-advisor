/**
 * The JSON depth probe's runner, which grounds `limit:research.maxJsonDepth`:
 *
 *   npm run probe:json-depth -- overflow
 *   npm run probe:json-depth -- nesting <corpus directory>
 *
 * `overflow` prints the Node version and the nesting at which structuredClone (which the research
 * readers use to keep a parsed value) and JSON.stringify overflow the stack. `nesting` reads every
 * `.json` file under the directory, a corpus of legitimate responses the caller downloaded, and
 * prints, per top-level subdirectory, the document count and the deepest nesting. It prints aggregates only, never a file name, package name or URL, and the corpus is
 * never committed. All logic is in core.ts; this file only reads the files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { jsonDepth, overflowDepth, summarizeDepths } = (await import(
  pathToFileURL(join(ROOT, 'scripts/probe-json-depth/core.ts')).href
)) as typeof Core;

const USAGE =
  'usage: npm run probe:json-depth -- overflow\n       npm run probe:json-depth -- nesting <corpus directory>';

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const [mode, corpus] = process.argv.slice(2);
if (mode === 'overflow') {
  console.log(
    JSON.stringify({
      node: process.version,
      structuredClone: overflowDepth((value) => structuredClone(value)),
      jsonStringify: overflowDepth((value) => JSON.stringify(value)),
    }),
  );
} else if (mode === 'nesting' && corpus !== undefined) {
  const groups = new Map<string, number[]>();
  for (const file of jsonFiles(corpus)) {
    const path = relative(corpus, file);
    const group = path.includes(sep) ? path.slice(0, path.indexOf(sep)) : '.';
    const depth = jsonDepth(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    groups.set(group, [...(groups.get(group) ?? []), depth]);
  }
  for (const [group, depths] of [...groups].sort(([a], [b]) => a.localeCompare(b)))
    console.log(JSON.stringify({ group, ...summarizeDepths(depths) }));
} else {
  console.error(USAGE);
  process.exit(1);
}
