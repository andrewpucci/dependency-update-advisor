import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type * as Limits from '../../src/limits.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import: tsc rejects a literal `.ts` specifier, and Node runs
// the register source directly, as scripts/complexity/report.mjs does.
const { PENDING_AUDIT, REGISTER, limit } = (await import(
  pathToFileURL(join(ROOT, 'src/limits.ts')).href
)) as typeof Limits;
type Limit = Limits.Limit;

export type SourceFile = { file: string; text: string };
export type AllowedSpecLine = { file: string; line: string; values: number[]; reason: string };

/** Set to false when migration closes (L11); then every unjustified entry is a problem. */
export const MIGRATION_OPEN = true;

const WORKFLOW_PREFIX = 'workflow.';
const TEST_SEPARATOR = ' > ';
const NUMBER_RUN = /[\w.,]+/g;
const WHOLE_NUMBER = /^(?:\d+|\d{1,3}(?:[,_]\d{3})+)$/;
const CITATION = /`limit:([^`\s]+)`/g;
/** Issue and PR references (`#350`) and URLs name things, never limits. */
const NOT_A_VALUE = /https?:\/\/\S+|#\d+/g;
/** Allowlist reasons that only hold during migration. */
export const PENDING_AMENDMENT = 'pending amendment';

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

function camelCase(stem: string): string {
  return stem.replace(/-([a-z0-9])/g, (_, next: string) => next.toUpperCase());
}

function timeoutId(file: string, jobId: string, step?: number): string {
  const stem = basename(file).replace(/\.ya?ml$/, '');
  const where = step === undefined ? jobId : `${jobId}.steps.${step}`;
  return `${WORKFLOW_PREFIX}${camelCase(stem)}.${where}.timeoutMinutes`;
}

type Timeout = { id: string; node: unknown; label: string };

/** Every `timeout-minutes` in a job: the job's own, then each step's (by position). */
function jobTimeouts(file: string, jobId: string, job: unknown): Timeout[] {
  if (!isMap(job)) return [];
  const timeouts: Timeout[] = [];
  const own = job.get('timeout-minutes', true);
  if (own !== undefined)
    timeouts.push({ id: timeoutId(file, jobId), node: own, label: `job ${jobId}` });
  const steps = job.get('steps', true);
  if (isSeq(steps))
    steps.items.forEach((step, index) => {
      const value = isMap(step) ? step.get('timeout-minutes', true) : undefined;
      if (value !== undefined)
        timeouts.push({
          id: timeoutId(file, jobId, index),
          node: value,
          label: `job ${jobId} step ${index}`,
        });
    });
  return timeouts;
}

/** Every `timeout-minutes` in one workflow file, with the file and line it is on. */
function workflowTimeouts({ file, text }: SourceFile): { where: string; timeout: Timeout }[] {
  const jobs = parseDocument(text).get('jobs', true);
  if (!isMap(jobs)) return [];
  return jobs.items.flatMap((pair) => {
    const jobId = String(isScalar(pair.key) ? pair.key.value : pair.key);
    return jobTimeouts(file, jobId, pair.value).map((timeout) => {
      const range = (timeout.node as { range?: [number] }).range;
      return { where: `${file}:${lineOf(text, range?.[0] ?? 0)}`, timeout };
    });
  });
}

/** The problem with one `timeout-minutes`, if any: it must be a literal matching its entry. */
function timeoutProblem(
  register: ReadonlyMap<string, Limit>,
  where: string,
  { id, node, label }: Timeout,
): string | undefined {
  // An alias or expression hides the number from this check, so the value must be literal.
  if (isAlias(node) || !isScalar(node) || typeof node.value !== 'number')
    return `${where}: ${label} timeout-minutes must be a literal number`;
  const entry = register.get(id);
  if (entry === undefined)
    return `${where}: ${label} has timeout-minutes but no register entry ${id}`;
  if (entry.value !== node.value)
    return `${where}: ${label} timeout-minutes ${String(node.value)} differs from ${id} (${entry.value})`;
  return undefined;
}

/** Each job's `timeout-minutes` must match its register entry, and each entry must have a job. */
export function workflowProblems(
  register: ReadonlyMap<string, Limit>,
  workflows: readonly SourceFile[],
): string[] {
  const timeouts = workflows.flatMap(workflowTimeouts);
  const found = new Set(timeouts.map(({ timeout }) => timeout.id));
  const problems = timeouts.flatMap(({ where, timeout }) => {
    const problem = timeoutProblem(register, where, timeout);
    return problem ? [problem] : [];
  });
  for (const id of register.keys()) {
    if (id.startsWith(WORKFLOW_PREFIX) && !found.has(id)) {
      problems.push(`${id}: no job with timeout-minutes in the workflow files`);
    }
  }
  return problems;
}

/** The register values a line states as a whole number: plain, comma-, or underscore-grouped. */
export function statedValues(line: string, values: readonly number[]): number[] {
  const stated = new Set<number>();
  for (const [run] of line.replace(NOT_A_VALUE, ' ').matchAll(NUMBER_RUN)) {
    const token = run.replace(/[.,]+$/, '');
    if (!WHOLE_NUMBER.test(token)) continue;
    const value = Number(token.replace(/[,_]/g, ''));
    if (values.includes(value)) stated.add(value);
  }
  return [...stated];
}

const specKey = (file: string, line: string): string => `${file}\n${line}`;

/**
 * A spec line stating a register value above the floor must be allowlisted by its trimmed text.
 * An allowlist entry is stale when no spec line with a stated value has that text.
 */
export function specProblems(
  register: ReadonlyMap<string, Limit>,
  floor: number,
  specs: readonly SourceFile[],
  allowlist: readonly AllowedSpecLine[],
): string[] {
  const values = [...register.values()].map((entry) => entry.value).filter((v) => v > floor);
  const allowed = new Set(allowlist.map((entry) => specKey(entry.file, entry.line)));
  const stating = new Set<string>();
  const problems: string[] = [];
  for (const { file, text } of specs) {
    text.split('\n').forEach((raw, index) => {
      const line = raw.trim();
      const stated = statedValues(line, values);
      if (stated.length === 0) return;
      stating.add(specKey(file, line));
      if (!allowed.has(specKey(file, line))) {
        problems.push(
          `${file}:${index + 1}: states register value ${stated.join(', ')} and is not allowlisted`,
        );
      }
    });
  }
  for (const entry of allowlist) {
    if (!stating.has(specKey(entry.file, entry.line))) {
      problems.push(`${entry.file}: allowlist entry matches no spec line: "${entry.line}"`);
    }
  }
  return problems;
}

/** Every `limit:<id>` citation in the docs must name an id in the register. */
export function citationProblems(
  register: ReadonlyMap<string, Limit>,
  docs: readonly SourceFile[],
): string[] {
  return docs.flatMap(({ file, text }) =>
    [...text.matchAll(CITATION)].flatMap((match) => {
      const id = match[1] ?? '';
      if (register.has(id)) return [];
      return [`${file}:${lineOf(text, match.index ?? 0)}: limit:${id} is not in the register`];
    }),
  );
}

function testReferences(entry: Limit): string[] {
  const structural = entry.basis.kind === 'derived' ? entry.basis.structuralTest : undefined;
  return [entry.test, structural].filter(
    (reference): reference is string =>
      reference !== undefined && reference !== PENDING_AUDIT && !reference.startsWith('none:'),
  );
}

function referenceProblems(
  id: string,
  reference: string,
  readFile: (path: string) => string | null,
): string[] {
  const at = reference.indexOf(TEST_SEPARATOR);
  if (at < 0) return [`${id}: test reference "${reference}" is not "<file> > <title>"`];
  const file = reference.slice(0, at);
  const title = reference.slice(at + TEST_SEPARATOR.length);
  const source = readFile(file);
  if (source === null) return [`${id}: test file ${file} does not exist`];
  // A live call at the start of a line: a title that only appears in a comment does not count.
  const live = source.split('\n').some((line) => line.trimStart().startsWith(`test('${title}'`));
  return live ? [] : [`${id}: no test('${title}' in ${file}`];
}

/** Each test reference must name an existing file and a test title in it. */
export function testProblems(
  register: ReadonlyMap<string, Limit>,
  readFile: (path: string) => string | null,
): string[] {
  return [...register.values()].flatMap((entry) =>
    testReferences(entry).flatMap((reference) => referenceProblems(entry.id, reference, readFile)),
  );
}

function pendingFields(entry: Limit): string[] {
  const structural = entry.basis.kind === 'derived' ? entry.basis.structuralTest : undefined;
  const fields: [string, string | undefined][] = [
    ['protects', entry.protects],
    ['effect', entry.effect],
    ['test', entry.test],
    ['structuralTest', structural],
  ];
  return fields.filter(([, value]) => value === PENDING_AUDIT).map(([name]) => name);
}

/**
 * Once migration closes, nothing may still wait on it: no unjustified entry, no field left at
 * PENDING_AUDIT, and no allowlisted spec line kept only as a pending amendment.
 */
export function migrationProblems(
  register: ReadonlyMap<string, Limit>,
  migrationOpen: boolean,
  allowlist: readonly AllowedSpecLine[] = [],
): string[] {
  if (migrationOpen) return [];
  const entries = [...register.values()].flatMap((entry) => [
    ...(entry.basis.kind === 'unjustified'
      ? [`${entry.id}: unjustified entry while migration is closed`]
      : []),
    ...pendingFields(entry).map(
      (field) => `${entry.id}: ${field} is still ${PENDING_AUDIT} while migration is closed`,
    ),
  ]);
  const lines = allowlist
    .filter((entry) => entry.reason.startsWith(PENDING_AMENDMENT))
    .map((entry) => `${entry.file}: pending amendment still allowlisted: "${entry.line}"`);
  return [...entries, ...lines];
}

function repoFile(path: string): SourceFile {
  return { file: path, text: readFileSync(join(ROOT, path), 'utf8') };
}

function readRepoFile(path: string): string | null {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return null;
  }
}

function main(): void {
  const floor = limit('checkLimits.specValueFloor');
  const specs = readdirSync(join(ROOT, 'docs/specs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => repoFile(`docs/specs/${name}`));
  const docs = readdirSync(join(ROOT, 'docs'), { encoding: 'utf8', recursive: true })
    .filter((name) => name.endsWith('.md'))
    .map((name) => repoFile(`docs/${name}`));
  const workflows = readdirSync(join(ROOT, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => repoFile(`.github/workflows/${name}`));
  const allowlist = JSON.parse(
    readFileSync(join(ROOT, 'scripts/limits/spec-allowlist.json'), 'utf8'),
  ) as AllowedSpecLine[];
  const problems = [
    ...workflowProblems(REGISTER, workflows),
    ...specProblems(REGISTER, floor, specs, allowlist),
    ...citationProblems(REGISTER, docs),
    ...testProblems(REGISTER, readRepoFile),
    ...migrationProblems(REGISTER, MIGRATION_OPEN, allowlist),
  ];
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`check:limits failed: ${problems.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `check:limits passed: ${REGISTER.size} limits, ${specs.length} spec files, ${docs.length} docs, ${workflows.length} workflows, ${allowlist.length} allowlisted spec lines`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
