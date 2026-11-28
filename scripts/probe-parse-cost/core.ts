/**
 * The pure part of the parse-cost probe, which measures the harm points of the parse-count and
 * work caps (L11 Q8(a), #383): the documents it times, each built to fill a byte budget with the
 * densest form of one counted unit, the count of entries in a parsed value as the readers count
 * it, and the summaries it prints. The runner in run.ts and the timed child in measure.ts do the
 * I/O; everything here takes values.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Format from '../../src/format.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { ALIAS_RADIX, FORMAT_VERSION } = (await import(
  pathToFileURL(join(ROOT, 'src/format.ts')).href
)) as typeof Format;

/**
 * The counters `npm run probe:parse-cost -- harm` runs, in order; a register entry may cite only
 * these (src/limits.test.ts checks it).
 */
export const COUNTERS = Object.freeze([
  'session',
  'registry',
  'npm',
  'research',
  'toml',
  'workflow-nodes',
  'workflow-aliases',
  'workflow-occurrences',
  'dependabot-nodes',
  'dependabot-updates',
  'dependabot-roots',
  'graph-npm',
  'graph-uv',
  'claims',
] as const);
export type Counter = (typeof COUNTERS)[number];

/**
 * The byte sizes a counter measures at: `cap` halved `below` times, then doubled up to `cap`
 * doubled `above` times, so successive sizes double and the timings show how the cost grows.
 */
export function doublingSizes(cap: number, below: number, above: number): number[] {
  return Array.from({ length: below + above + 1 }, (_, index) =>
    Math.floor(cap * 2 ** (index - below)),
  );
}

/**
 * The id the npm graph stage gives the finding that records a member's search running out of work
 * (`note` in src/evidence/npm-graph.ts), the one place that stage reports it without a reason field.
 */
export function npmBudgetFindingId(memberId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([memberId, 'budget']))
    .digest('hex');
  return `npm:relationship:${digest}`;
}

/**
 * Whether a graph stage result reports running out of work: an unavailable result with reason
 * `budget`, or an inventory any of whose gaps, observations, verdicts or coverage gives `budget`
 * as a reason, or which holds an npm budget finding. Any other result kind is not a completed
 * stage either, so it throws.
 */
export function reportsBudget(result: unknown): boolean {
  const record = result as { kind?: unknown; reason?: unknown };
  if (record.kind === 'unavailable') {
    if (record.reason === 'budget') return true;
    throw new Error(`graph result unavailable: ${String(record.reason)}`);
  }
  if (record.kind !== 'inventory') throw new Error(`graph result ${String(record.kind)}`);
  const pending: unknown[] = [result];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item !== 'object' || item === null) continue;
    const fields = item as {
      reason?: unknown;
      reasons?: unknown;
      id?: unknown;
      memberId?: unknown;
    };
    if (fields.reason === 'budget') return true;
    if (typeof fields.memberId === 'string' && fields.id === npmBudgetFindingId(fields.memberId))
      return true;
    if (Array.isArray(fields.reasons) && fields.reasons.includes('budget')) return true;
    for (const child of Object.values(item)) pending.push(child);
  }
  return false;
}

/** Entries as the JSON readers count them: the properties or elements of each object or array. */
export function entryCount(value: unknown): number {
  let entries = 0;
  const pending = [value];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item !== 'object' || item === null) continue;
    const children: unknown[] = Object.values(item);
    entries += children.length;
    for (const child of children) pending.push(child);
  }
  return entries;
}

/** `head`, then `unit` as many times as fits in `bytes` with `tail`, then `tail`; ASCII only. */
export function filled(head: string, unit: string, tail: string, bytes: number): string {
  const count = Math.floor((bytes - head.length - tail.length) / unit.length);
  if (count < 1) throw new Error('the byte budget holds no unit');
  return head + unit.repeat(count) + tail;
}

/**
 * JSON shapes: elements that are numbers (`0,`, the most entries a byte can hold), empty arrays or
 * empty objects. A container costs the walk more per entry than a number, so the containers give
 * fewer entries but cost more each; the harm point takes whichever shape costs most per entry,
 * since a form that costs less per entry would understate the harm.
 */
export const JSON_UNITS = Object.freeze({ numbers: '0,', flat: '[],', objects: '{},' });
export type JsonShape = keyof typeof JSON_UNITS;

/** A JSON array of one shape filling `bytes`; the last unit's comma is closed by a final `0`. */
export function jsonDocument(shape: JsonShape, bytes: number): string {
  return filled('[', JSON_UNITS[shape], '0]', bytes);
}

/** TOML shapes: array elements that are integers, or empty inline tables. */
export const TOML_UNITS = Object.freeze({ integers: '1,', tables: '{},' });
export type TomlShape = keyof typeof TOML_UNITS;

export function tomlDocument(shape: TomlShape, bytes: number): string {
  return filled('a=[', TOML_UNITS[shape], ']\n', bytes);
}

/**
 * Workflow documents for the actions reader, each with the `jobs` map it requires:
 * `nodes` is a flow sequence of one-character scalars, `aliases` a flow sequence of aliases to one
 * anchored scalar, and `occurrences` one job whose steps are each a `uses:` reference.
 */
export const WORKFLOW_SHAPES = Object.freeze({
  nodes: { head: 'jobs: {}\nx: [', unit: 'a,', tail: 'a]\n' },
  aliases: { head: 'jobs: {}\nx: &a a\ny: [', unit: '*a,', tail: '*a]\n' },
  occurrences: { head: 'jobs: {j: {steps: [', unit: '{uses: a/b@c},', tail: '{uses: a/b@c}]}}\n' },
});
export type WorkflowShape = keyof typeof WORKFLOW_SHAPES;

export function workflowDocument(shape: WorkflowShape, bytes: number): string {
  const { head, unit, tail } = WORKFLOW_SHAPES[shape];
  return filled(head, unit, tail, bytes);
}

/**
 * Dependabot documents for the roots reader: `nodes` is a flow sequence of scalars under a key the
 * reader ignores, `updates` repeats one npm entry, and `roots` lists distinct npm directories.
 */
export const DEPENDABOT_SHAPES = ['nodes', 'updates', 'roots'] as const;
export type DependabotShape = (typeof DEPENDABOT_SHAPES)[number];

const DEPENDABOT_HEAD = `version: ${FORMAT_VERSION.dependabotConfig}\n`;
const NPM_ENTRY = '{package-ecosystem: npm, directory: /},';

export function dependabotDocument(shape: DependabotShape, bytes: number): string {
  if (shape === 'nodes') return filled(`${DEPENDABOT_HEAD}updates: []\nx: [`, 'a,', 'a]\n', bytes);
  if (shape === 'updates') return filled(`${DEPENDABOT_HEAD}updates: [`, NPM_ENTRY, ']\n', bytes);
  const head = `${DEPENDABOT_HEAD}updates: [{package-ecosystem: npm, directories: [`;
  const tail = ']}]\n';
  // Base-36 names keep each directory short and distinct.
  const names: string[] = [];
  let size = head.length + tail.length;
  for (let index = 0; ; index++) {
    const name = `/${index.toString(ALIAS_RADIX)},`;
    if (size + name.length > bytes) break;
    names.push(name);
    size += name.length;
  }
  return head + names.join('') + tail;
}

/** uv graph shapes: each package depends on the next (`chain`), or the project on all (`star`). */
export const GRAPH_SHAPES = ['chain', 'star'] as const;
export type GraphShape = (typeof GRAPH_SHAPES)[number];

const UV_HEAD = `version=1\nrevision=${FORMAT_VERSION.uvLockRevisions[0]}\nrequires-python=">=3.11"\n`;
const uvName = (index: number) => `p${index.toString(ALIAS_RADIX)}`;
const uvDependency = (index: number) => `{name="${uvName(index)}"}`;

/**
 * A uv project manifest and lock whose packages fill `bytes`, in one graph shape. The last
 * package's version is `lastVersion`, so a base and a head differ in exactly one member.
 */
export function uvProject(shape: GraphShape, bytes: number, lastVersion: string) {
  const entry = (index: number, next: boolean, version: string) =>
    `[[package]]\nname="${uvName(index)}"\nversion="${version}"\nsource={registry="https://pypi.org/simple"}\n` +
    (next ? `dependencies=[${uvDependency(index + 1)}]\n` : '');
  // Sized with the longest form of each entry, so the lock never passes `bytes`.
  let count = 0;
  let size = UV_HEAD.length;
  for (;;) {
    const packageSize = entry(count, true, lastVersion).length;
    const rootSize = (uvDependency(count).length + 1) * (shape === 'star' ? 2 : 0);
    if (size + packageSize + rootSize + entry(0, true, lastVersion).length * 2 > bytes) break;
    size += packageSize + rootSize;
    count++;
  }
  const direct = shape === 'star' ? Array.from({ length: count }, (_, i) => i) : [0];
  const root =
    `[[package]]\nname="project"\nsource={editable="."}\ndependencies=[${direct.map(uvDependency).join(',')}]\n` +
    `[package.metadata]\nrequires-dist=[${direct.map((i) => `{name="${uvName(i)}",specifier=">=1"}`).join(',')}]\n`;
  const packages = Array.from({ length: count }, (_, i) =>
    entry(i, shape === 'chain' && i < count - 1, i === count - 1 ? lastVersion : '1'),
  );
  const manifest = `[project]\nname="project"\nrequires-python=">=3.11"\ndependencies=[${direct.map((i) => `"${uvName(i)}>=1"`).join(',')}]\n`;
  return { manifest, lock: UV_HEAD + root + packages.join(''), packages: count };
}

/**
 * An npm manifest and lockfile (version 3) whose packages fill `bytes`, in one graph shape; as in
 * `uvProject`, the last package's version is `lastVersion`. `integrity` is the SRI string each
 * package carries.
 */
export function npmProject(
  shape: GraphShape,
  bytes: number,
  lastVersion: string,
  integrity: string,
) {
  const entry = (index: number, next: boolean, version: string) => ({
    version,
    integrity,
    resolved: `https://registry.npmjs.org/${uvName(index)}/-/${uvName(index)}-${version}.tgz`,
    ...(next ? { dependencies: { [uvName(index + 1)]: '^1' } } : {}),
  });
  const sized = (count: number) => {
    const direct = shape === 'star' ? Array.from({ length: count }, (_, i) => i) : [0];
    const manifest = { dependencies: Object.fromEntries(direct.map((i) => [uvName(i), '^1'])) };
    const packages: Record<string, unknown> = { '': manifest };
    for (let i = 0; i < count; i++)
      packages[`node_modules/${uvName(i)}`] = entry(
        i,
        shape === 'chain' && i < count - 1,
        i === count - 1 ? lastVersion : '1.0.0',
      );
    return {
      manifest: JSON.stringify(manifest),
      lock: JSON.stringify({ lockfileVersion: FORMAT_VERSION.npmLockfile, packages }),
    };
  };
  // The largest count that fits, by bisection on the serialized size.
  let low = 1;
  let high = 1;
  while (sized(high).lock.length <= bytes) high *= 2;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (sized(middle).lock.length <= bytes) low = middle;
    else high = middle;
  }
  return { ...sized(low), packages: low };
}

/**
 * The smallest value at which `passes` holds, by doubling from 1 and then bisecting; `passes`
 * must be monotone. Null when it fails at `limit`.
 */
export async function smallestPassing(
  passes: (value: number) => boolean | Promise<boolean>,
  limit: number,
): Promise<number | null> {
  if (!(await passes(limit))) return null;
  let high = 1;
  while (high < limit && !(await passes(high))) high = Math.min(limit, high * 2);
  let low = Math.floor(high / 2);
  if (high === 1) return 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await passes(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * Lines for the corroboration claim regexes, each exactly `length` code units, that make a
 * backtracking matcher do the most work: `link` opens a Markdown link whose URL never closes,
 * repeated, so each opening restarts a scan of up to 1,024 URL characters; `bumps` is a claim
 * whose last version runs to the end of the line; `plain` is text no regex matches.
 */
export const CLAIM_SHAPES = ['link', 'bumps', 'plain'] as const;
export type ClaimShape = (typeof CLAIM_SHAPES)[number];

export function claimLine(shape: ClaimShape, length: number): string {
  const unit = { link: '[a](https://', bumps: '', plain: 'a' }[shape];
  const text = shape === 'bumps' ? `Bumps a from 1 to 1${'1'.repeat(length)}` : unit.repeat(length);
  return text.slice(0, length);
}

/** The ratios of successive timings, which stay near 2 per doubling when the cost is linear. */
export function doublingRatios(timings: readonly number[]): number[] {
  return timings.slice(1).map((ms, index) => ms / (timings[index] as number));
}

/** Aggregate figures only: a summary never names a document. */
export type CountSummary = { documents: number; largest: number };

export function summarizeCounts(counts: readonly number[]): CountSummary {
  return { documents: counts.length, largest: Math.max(0, ...counts) };
}

/** The slowest and the median of a set of timings, in milliseconds. */
export function timingSummary(timings: readonly number[]): { slowestMs: number; medianMs: number } {
  const sorted = [...timings].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('no timings');
  return {
    slowestMs: sorted[sorted.length - 1] as number,
    medianMs: sorted[Math.floor(sorted.length / 2)] as number,
  };
}
