// A stand-in for the action entry (src/index.ts) for src/relaunch.test.ts: it relaunches with the
// memory FIXTURE_MEMORY gives, then the process that runs reports what it ran with and exits
// with FIXTURE_EXIT.
import { getHeapStatistics } from 'node:v8';
import { exitAs, relaunch } from '../../src/relaunch.js';

const launched = await relaunch({
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  env: process.env,
  memory: Number(process.env.FIXTURE_MEMORY),
});
if (launched.kind === 'run') {
  process.stdout.write(
    `${JSON.stringify({
      relaunched: process.env.DEPENDENCY_REVIEW_RELAUNCHED ?? null,
      heapLimit: getHeapStatistics().heap_size_limit,
      argv: process.argv.slice(2),
      execArgv: process.execArgv,
    })}\n`,
  );
  process.exitCode = Number(process.env.FIXTURE_EXIT);
} else exitAs(launched);
