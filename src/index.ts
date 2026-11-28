import { exitAs, relaunch, runnerMemory, type Relaunch } from './relaunch.js';
import { runStartup } from './startup.js';

// The action re-runs itself once with an old-generation heap sized to the runner's memory
// (limit:runner.heapBytes); the relaunched process runs the action once its heap limit is
// checked. Any failure stops the action with a clear error, never running at V8's default.
const launched = await relaunch({
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  env: process.env,
  memory: runnerMemory(),
  ...(process.channel && process.send
    ? { ipc: process as Required<Pick<NodeJS.Process, 'send' | 'on' | 'off'>> }
    : {}),
}).catch((): Relaunch => ({
  kind: 'failed',
  message: 'dependabot-review: Node could not be relaunched with the runner heap; no review ran.',
}));
if (launched.kind === 'run')
  process.exitCode = await runStartup((line) => process.stderr.write(`${line}\n`));
else exitAs(launched);
