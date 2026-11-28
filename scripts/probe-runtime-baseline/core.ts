/** Reductions for the runtime baseline probe (see run.ts); no I/O. */
export type Report = Readonly<{
  relaunched: boolean;
  maxRSS: number;
  /** Wall-clock milliseconds at the process start and at its exit, when the run reported them. */
  startedAt?: number;
  exitedAt?: number;
}>;
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

/**
 * One run's in-step startup time: from the parent's process start to the relaunched child's exit,
 * which comes right after runStartup takes the job start (src/startup.ts), since the probe gives it
 * no runtime inputs. It covers Node load, the relaunch and the self-check; null if either is missing.
 */
export function startupMs(run: readonly Report[]): number | null {
  const parent = run.filter((report) => !report.relaunched);
  const child = run.filter((report) => report.relaunched);
  if (parent.length !== 1 || child.length !== 1) return null;
  const { startedAt } = parent[0] as Report;
  const { exitedAt } = child[0] as Report;
  if (startedAt === undefined || exitedAt === undefined) return null;
  return exitedAt - startedAt;
}

/** The slowest in-step startup over every run; null if any run was incomplete. */
export function slowestStartup(runs: readonly (readonly Report[])[]): number | null {
  const times = runs.map(startupMs);
  if (!times.length || times.some((value) => value === null)) return null;
  return Math.max(...(times as number[]));
}
