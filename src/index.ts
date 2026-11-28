import { exitAs, relaunch, runnerMemory } from './relaunch.js';
import { runStartup } from './startup.js';

// The action re-runs itself once with an old-generation heap sized to the runner's memory
// (limit:runner.heapBytes); the relaunched process, or one that cannot relaunch, runs the action.
const launched = await relaunch({
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  env: process.env,
  memory: runnerMemory(),
  ...(process.channel && process.send
    ? { ipc: process as Required<Pick<NodeJS.Process, 'send' | 'on' | 'off'>> }
    : {}),
}).catch(() => ({ kind: 'run' }) as const);
if (launched.kind === 'run')
  process.exitCode = await runStartup((line) => process.stderr.write(`${line}\n`));
else exitAs(launched);
