/**
 * The parse-cost probe's runner, which measures the harm points of the parse-count and work caps
 * (L11 Q8(a), #383) and the largest legitimate use of them in a recorded corpus:
 *
 *   npm run probe:parse-cost -- harm [counter ...]
 *   npm run probe:parse-cost -- use <corpus directory>
 *
 * `harm` runs each counter (all by default) in its own Node process, measure.ts with the flags it
 * needs: the reader on an input that fills the reader's byte cap with the densest form of the
 * counted unit, its count caps lifted, and prints the units counted and the slowest and median of
 * RUNS (default 5) timed runs after a warm-up. The Dependabot caps are lifted through
 * HEAP_LIMIT_OVERRIDES (scripts/measure-heap/hooks.mjs), the only reader whose caps are read from
 * the register rather than passed in. `use` prints, per top-level subdirectory of a corpus of
 * legitimate files the caller downloaded, the file count and the largest and total value of each count
 * the readers charge (see measure.ts). Both print aggregates only, never a file name, package name or
 * URL, and the corpus is never committed. The timings depend on the machine, so the probe is not
 * part of the test suite; run it on Node 24, the action's runtime.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FLAGS = [
  '--expose-gc',
  '--experimental-transform-types',
  '--no-warnings',
  '--import',
  pathToFileURL(join(ROOT, 'scripts/measure-heap/register.mjs')).href,
];
const MEASURE = join(ROOT, 'scripts/probe-parse-cost/measure.ts');
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { COUNTERS } = (await import(
  pathToFileURL(join(ROOT, 'scripts/probe-parse-cost/core.ts')).href
)) as typeof Core;
const counters: readonly string[] = COUNTERS;
/** The register-read caps the Dependabot counters and corpus need lifted. */
const LIFTED_DEPENDABOT = ['maxFileBytes', 'maxYamlNodes', 'maxUpdates', 'maxRoots']
  .map((key) => `dependabot.${key}=${Number.MAX_SAFE_INTEGER}`)
  .join(',');

const USAGE =
  'usage: npm run probe:parse-cost -- harm [counter ...]\n       npm run probe:parse-cost -- use <corpus directory>';

function measure(args: string[]): void {
  process.stdout.write(
    execFileSync(process.execPath, [...FLAGS, MEASURE, ...args], {
      cwd: ROOT,
      env: { ...process.env, HEAP_LIMIT_OVERRIDES: LIFTED_DEPENDABOT },
      encoding: 'utf8',
    }),
  );
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'harm') {
  const unknown = rest.filter((counter) => !counters.includes(counter));
  if (unknown.length > 0) {
    console.error(`unknown counter ${unknown.join(', ')}; one of ${COUNTERS.join(', ')}`);
    process.exit(1);
  }
  for (const counter of rest.length > 0 ? rest : COUNTERS) measure([counter]);
} else if (mode === 'use' && rest.length === 1) {
  measure(['use', rest[0] as string]);
} else {
  console.error(USAGE);
  process.exit(1);
}
