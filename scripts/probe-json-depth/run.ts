/**
 * The JSON depth probe's runner, which grounds `limit:research.maxJsonDepth`:
 *
 *   npm run probe:json-depth -- overflow
 *   npm run probe:json-depth -- nesting <corpus directory>
 *
 * `overflow` prints the Node version and the nesting at which structuredClone (which the research
 * readers use to keep a parsed value) and JSON.stringify overflow the stack, and the nesting of flow
 * sequences at which the yaml library's parse and compose, with the options the Dependabot and
 * workflow readers give it, overflow it (`limit:dependabot.maxYamlDepth`). `nesting` reads every
 * `.json` file under the directory, a corpus of legitimate responses the caller downloaded, and
 * prints, per top-level subdirectory, the document count and the deepest nesting. It prints aggregates only, never a file name, package name or URL, and the corpus is
 * never committed. All logic is in core.ts; this file only reads the files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Composer, Parser } from 'yaml';
import type * as Core from './core.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { BISECTION_LIMIT, jsonDepth, nestedFlowSequences, overflowDepth, summarizeDepths } =
  (await import(pathToFileURL(join(ROOT, 'scripts/probe-json-depth/core.ts')).href)) as typeof Core;

const USAGE =
  'usage: npm run probe:json-depth -- overflow\n       npm run probe:json-depth -- nesting <corpus directory>';

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The readers' composer options (src/dependabot-roots.ts, src/evidence/actions-yaml.ts). */
const COMPOSER_OPTIONS = {
  version: '1.2',
  schema: 'core',
  strict: true,
  stringKeys: true,
  uniqueKeys: true,
  merge: false,
  resolveKnownTags: false,
  prettyErrors: false,
  logLevel: 'silent',
} as const;

/** Parses and composes YAML; the library reports a stack overflow as a document error. */
function composeYaml(text: string): void {
  const documents = [...new Composer(COMPOSER_OPTIONS).compose([...new Parser().parse(text)])];
  if (
    documents.some((document) => document.errors.some((error) => /call stack/i.test(error.message)))
  )
    throw new RangeError('Maximum call stack size exceeded');
}

/**
 * The smallest nesting at which `composeYaml` overflows in a fresh process, by bisection. Each
 * depth runs in its own child (`yaml-compose <depth>`), because a warmed process, whose compiled
 * frames are smaller, reaches about twice as deep, and the cold run is the one a review makes.
 */
function yamlOverflowDepth(): number {
  const completes = (depth: number) =>
    spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'yaml-compose', String(depth)])
      .status === 0;
  let low = 0;
  let high = BISECTION_LIMIT;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (completes(middle)) low = middle;
    else high = middle;
  }
  return high;
}

const [mode, corpus] = process.argv.slice(2);
if (mode === 'overflow') {
  console.log(
    JSON.stringify({
      node: process.version,
      structuredClone: overflowDepth((value) => structuredClone(value)),
      jsonStringify: overflowDepth((value) => JSON.stringify(value)),
      yamlCompose: yamlOverflowDepth(),
    }),
  );
} else if (mode === 'yaml-compose' && corpus !== undefined) {
  try {
    composeYaml(nestedFlowSequences(Number(corpus)));
  } catch {
    process.exit(1);
  }
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
