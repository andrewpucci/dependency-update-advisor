/**
 * The runtime baseline probe, for `limit:runner.baselineBytes` and `limit:job.preStartupAllowance`.
 * Usage, after `npm run build`:
 *
 *   npm run probe:runtime-baseline
 *
 * It runs the built action (.github/actions/dependabot-review/dist/index.js) with no workflow
 * environment, so it relaunches itself, runs its startup self-check, and stops at the missing
 * runtime inputs. preload.mjs, passed to the child through the relaunch's execArgv, loads the
 * fetch machinery and reports each process's peak resident set. The baseline is the largest
 * parent plus child footprint over the runs. It counts each process's whole resident set,
 * including the small heap the self-check uses, so it overstates what is outside the heap. Run
 * it on Linux and Node 24, the action's platform. It makes no network request.
 *
 * It also reports `startupMs`, the slowest in-step startup over the runs: from the parent's
 * process start to the child's exit, which follows right after runStartup takes the job start,
 * so it covers Node load, the relaunch and the self-check (L11, item 10). For the allowance it
 * must run inside a workflow step on the smallest supported hosted runner; the runner's own
 * launch of the step's process is outside it.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const core = (await import(
  pathToFileURL(join(ROOT, 'scripts/probe-runtime-baseline/core.ts')).href
)) as typeof Core;

const RUNS = Number(process.env.RUNS ?? '5');
const preload = pathToFileURL(join(ROOT, 'scripts/probe-runtime-baseline/preload.mjs')).href;
const bundle = join(ROOT, '.github/actions/dependabot-review/dist/index.js');
const runs = Array.from({ length: RUNS }, () => {
  const result = spawnSync(process.execPath, ['--import', preload, bundle], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  });
  return { status: result.status, reports: core.reports(result.stderr) };
});
const baseline = core.baseline(runs.map((run) => run.reports));
const startupMs = core.slowestStartup(runs.map((run) => run.reports));
if (baseline === null || startupMs === null)
  throw new Error('a run did not report both its parent and its child');
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      runs: runs.map((run) => ({ status: run.status, reports: run.reports })),
      baselineBytes: baseline,
      startupMs,
    },
    null,
    2,
  ),
);
