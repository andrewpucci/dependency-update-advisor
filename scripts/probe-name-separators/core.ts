/**
 * The pure part of the name separator probe, the largest-legitimate-use check for
 * `limit:advisory.discovery.spellingCeiling`: how many PEP 503 separators the project names of a
 * package index hold. Discovery sends every spelling of a normalized `pip` name with each
 * separator replaced by `-`, `_` or `.` (src/evidence/advisory-read.ts), so a name with n
 * separators has 3ⁿ spellings. The runner in run.ts reads the index; everything here takes names.
 */

/** Separators in a project name as PEP 503 normalizes it: each run of `-`, `_` and `.` is one. */
export function separators(name: string): number {
  return name.toLowerCase().match(/[-_.]+/gu)?.length ?? 0;
}

export type SeparatorSummary = {
  names: number;
  /** Names by separator count, ascending; a count no name has is left out. */
  bySeparators: Record<string, number>;
  most: number;
};

/** Counts only: the summary never holds a name. */
export function summarizeSeparators(names: readonly string[]): SeparatorSummary {
  const counts = new Map<number, number>();
  for (const name of names) {
    const n = separators(name);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const ascending = [...counts].sort(([a], [b]) => a - b);
  return {
    names: names.length,
    bySeparators: Object.fromEntries(ascending.map(([n, count]) => [String(n), count])),
    most: ascending.at(-1)?.[0] ?? 0,
  };
}

/** The project names of a PEP 691 JSON simple index (`{"projects": [{"name": ...}]}`). */
export function indexNames(index: unknown): string[] {
  const projects = (index as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) throw new Error('not a PEP 691 JSON simple index');
  return projects.map((project: unknown) => {
    const name = (project as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') throw new Error('a project without a name');
    return name;
  });
}
