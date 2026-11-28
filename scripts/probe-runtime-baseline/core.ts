/** Reductions for the runtime baseline probe (see run.ts); no I/O. */
export type Report = Readonly<{ relaunched: boolean; maxRSS: number }>;
const PREFIX = 'RUNTIME_BASELINE ';

/** The reports one run printed: one from the relaunching parent and one from its child. */
export function reports(stderr: string): Report[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => JSON.parse(line.slice(PREFIX.length)) as Report);
}

/** One run's footprint: the parent's peak plus the child's, or null if either is missing. */
export function footprint(run: readonly Report[]): number | null {
  const parent = run.filter((report) => !report.relaunched);
  const child = run.filter((report) => report.relaunched);
  if (parent.length !== 1 || child.length !== 1) return null;
  return (parent[0] as Report).maxRSS + (child[0] as Report).maxRSS;
}

/** The baseline: the largest footprint over every run; null if any run was incomplete. */
export function baseline(runs: readonly (readonly Report[])[]): number | null {
  const footprints = runs.map(footprint);
  if (!footprints.length || footprints.some((value) => value === null)) return null;
  return Math.max(...(footprints as number[]));
}
