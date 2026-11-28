/**
 * The parse-cost probe's runner, which measures the harm points of the parse-count and work caps
 * (L11 Q8(a), #383) and the largest legitimate use of them in a recorded corpus:
 *
 *   npm run probe:parse-cost -- harm [counter ...]
 *   npm run probe:parse-cost -- use <corpus directory>
 *   npm run probe:parse-cost -- heap
 *   npm run probe:parse-cost -- event
 *
 * `harm` runs each counter (all by default) in HARM_INVOCATIONS (default and least 3) separate
 * Node processes, measure.ts with the flags it needs: the reader on an input that fills the
 * reader's byte cap with the densest form of the counted unit, its count caps lifted, timing RUNS
 * (default 5) runs after a warm-up. Per size it prints the units counted and the slowest run of any
 * invocation, with the spread between invocations; per shape, the harm fit (harmFit in core.ts) at
 * the register's evidence deadline; and per counter, the shape whose harm point comes first. The Dependabot caps are lifted through
 * HEAP_LIMIT_OVERRIDES (scripts/measure-heap/hooks.mjs), the only reader whose caps are read from
 * the register rather than passed in. `use` prints, per top-level subdirectory of a corpus of
 * legitimate files the caller downloaded (numbered, never named), the file count, the largest and
 * total value of each count the readers charge, and the files a reader refused, by reason (see
 * measure.ts). Both print aggregates only, never a file name, package name or URL, and the corpus is
 * never committed. The timings depend on the machine, so the probe is not
 * part of the test suite; run it on Node 24, the action's runtime.
 *
 * `heap` (L11, item 12) runs the Dependabot roots reader with the register's own caps on each
 * crafted shape at limit:dependabot.maxFileBytes and prints, per shape, its outcome, the heap the
 * parse allocates (an upper bound on its peak: the young generation is sized so no collection runs
 * during one parse) and the heap still held after a full collection with the result kept, which
 * shows whether the parse is transient.
 *
 * `event` (L11, item 11 review follow-up) parses a webhook-shaped event of exactly
 * limit:startup.maxEventBytes in each dense shape and prints, per shape, the heap its decoded text
 * takes, the heap JSON.parse allocates on top of it (sized as for `heap`), their sum, the heap still
 * held after a full collection with the result kept, and the parse time.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';
import type * as Limits from '../../src/limits.js';

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
const core = (await import(
  pathToFileURL(join(ROOT, 'scripts/probe-parse-cost/core.ts')).href
)) as typeof Core;
const { COUNTERS } = core;
const counters: readonly string[] = COUNTERS;
const { limit } = (await import(pathToFileURL(join(ROOT, 'src/limits.ts')).href)) as typeof Limits;
/** The register-read caps the Dependabot counters and corpus need lifted. */
const LIFTED_DEPENDABOT = ['maxFileBytes', 'maxYamlNodes', 'maxUpdates', 'maxRoots']
  .map((key) => `dependabot.${key}=${Number.MAX_SAFE_INTEGER}`)
  .join(',');

const USAGE =
  'usage: npm run probe:parse-cost -- harm [counter ...]\n       npm run probe:parse-cost -- use <corpus directory>\n       npm run probe:parse-cost -- heap\n       npm run probe:parse-cost -- event';
/** A young generation no single parse fills, so the heap after it counts all it allocated. */
const HEAP_FLAGS = ['--min-semi-space-size=1024', '--max-semi-space-size=1024'];

/** Separate processes per harm counter, so one process's luck does not set the figure. */
// oxlint-disable-next-line no-magic-numbers, limits/no-literal-limit -- probe policy, not a limit (approved 2026-11-28, #383)
const LEAST_INVOCATIONS = 3;
const INVOCATIONS = Number(process.env.HARM_INVOCATIONS ?? String(LEAST_INVOCATIONS));
if (!Number.isSafeInteger(INVOCATIONS) || INVOCATIONS < LEAST_INVOCATIONS)
  throw new Error('HARM_INVOCATIONS must be an integer of at least 3');

function measure(args: string[], lifted = true): void {
  process.stdout.write(output(args, lifted));
}

/** One counter, timed in INVOCATIONS processes and combined (see core.combineInvocations). */
function harm(counter: string): void {
  const invocations = Array.from({ length: INVOCATIONS }, () =>
    output([counter])
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Partial<Core.TimedPoint>)
      .filter((line): line is Core.TimedPoint => typeof line.slowestMs === 'number'),
  );
  const combined = core.combineInvocations(invocations);
  const deadlineMs = limit('evidence.envelope.totalTimeoutMs');
  const fits: { shape: string; harm: number }[] = [];
  for (const shape of new Set(combined.map((point) => point.shape))) {
    const points = combined.filter((point) => point.shape === shape);
    for (const point of points) console.log(JSON.stringify({ node: process.version, ...point }));
    const units = points.map((point) => point.units);
    const slowest = points.map((point) => point.slowestMs);
    const fit = core.harmFit(units, slowest, deadlineMs);
    const each = invocations.map(
      (points) =>
        core.harmFit(
          units,
          points.filter((point) => point.shape === shape).map((point) => point.slowestMs),
          deadlineMs,
        ).harm,
    );
    fits.push({ shape, harm: fit.harm });
    console.log(
      JSON.stringify({
        counter,
        shape,
        invocations: INVOCATIONS,
        deadlineMs,
        units,
        slowestMs: slowest,
        spread: Math.max(...points.map((point) => point.spread)),
        ...fit,
        harmPerInvocation: { least: Math.min(...each), most: Math.max(...each) },
      }),
    );
  }
  const first = fits.reduce((a, b) => (b.harm < a.harm ? b : a));
  console.log(JSON.stringify({ counter, harmShape: first.shape, harm: first.harm }));
}

function output(args: string[], lifted = true): string {
  const flags = lifted ? FLAGS : [...FLAGS, ...HEAP_FLAGS];
  return execFileSync(process.execPath, [...flags, MEASURE, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HEAP_LIMIT_OVERRIDES: lifted ? LIFTED_DEPENDABOT : '',
      // The register's own byte cap, which the overrides hide from the child.
      DEPENDABOT_MAX_FILE_BYTES: String(limit('dependabot.maxFileBytes')),
    },
    encoding: 'utf8',
  });
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'harm') {
  const unknown = rest.filter((counter) => !counters.includes(counter));
  if (unknown.length > 0) {
    console.error(`unknown counter ${unknown.join(', ')}; one of ${COUNTERS.join(', ')}`);
    process.exit(1);
  }
  for (const counter of rest.length > 0 ? rest : COUNTERS) harm(counter);
} else if (mode === 'use' && rest.length === 1) {
  measure(['use', rest[0] as string]);
} else if (mode === 'heap' && rest.length === 0) {
  measure(['heap'], false);
} else if (mode === 'event' && rest.length === 0) {
  // One process per shape, so no shape's garbage is counted in the next.
  for (const shape of ['numbers', 'objects', 'arrays', 'strings', 'keyed'])
    measure(['event', shape], false);
} else {
  console.error(USAGE);
  process.exit(1);
}
