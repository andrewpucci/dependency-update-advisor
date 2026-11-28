import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { BINARY_BYTES, EXIT_CODE } from './format.js';
import { heapBytesFor, limit } from './limits.js';

/**
 * Set in the relaunched process. A process that sees it, or already has an old-generation flag,
 * runs the action itself and never relaunches, so the relaunch cannot loop.
 */
export const RELAUNCHED_ENV = 'DEPENDENCY_REVIEW_RELAUNCHED';
const OLD_SPACE_FLAG = '--max-old-space-size';
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** The exit code of an action that stops because it cannot have the heap its caps assume. */
export const HEAP_EXIT_CODE = EXIT_CODE.heap;

/**
 * The memory this process may use, as Node itself sizes the heap: the cgroup limit when one is
 * set below physical memory, otherwise physical memory (`uv_get_constrained_memory`).
 */
export function runnerMemory(
  total: number = totalmem(),
  constrained: number = process.constrainedMemory(),
): number {
  return constrained > 0 && constrained < total ? constrained : total;
}

/**
 * The old-generation size, in whole MiB, for a runner with this much memory: the register's
 * heap formula (limit:runner.heapBytes) with the runner's own memory in place of the smallest
 * runner's. Null when nothing is left for the heap; the relaunch then fails closed.
 */
export function oldSpaceMiB(memory: number): number | null {
  const bytes = heapBytesFor(
    memory,
    limit('runner.youngGenerationBytes'),
    limit('runner.offHeapBytes'),
    limit('runner.baselineBytes'),
    limit('runner.systemReservedBytes'),
  );
  const mib = Math.floor(bytes / BINARY_BYTES.MiB);
  return mib >= 1 ? mib : null;
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type RelaunchProcess = Readonly<{
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  memory: number;
  spawn?: Spawn;
  /** The heap the caps are sized for; defaults to limit:runner.heapBytes. */
  requiredHeapBytes?: number;
  /** This process's V8 heap limit; defaults to v8.getHeapStatistics().heap_size_limit. */
  heapLimit?: () => number;
  /** Receives forwarded signals; defaults to this process. */
  signals?: Pick<NodeJS.Process, 'on' | 'off'>;
  /**
   * This process's IPC channel, when its parent forked it: the child gets one too, and messages
   * are relayed both ways, so the relaunch is invisible to the parent.
   */
  ipc?: Readonly<{
    send: (message: unknown) => unknown;
    on: (event: 'message', listener: (message: unknown) => void) => unknown;
    off: (event: 'message', listener: (message: unknown) => void) => unknown;
  }>;
}>;
export type Relaunch =
  | Readonly<{ kind: 'run' }>
  | Readonly<{ kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }>
  | Readonly<{ kind: 'failed'; message: string }>;

/**
 * A fixed message naming why the action cannot run with the heap its caps assume. No error text
 * is echoed, as in src/startup.ts.
 */
const failed = (why: string): Relaunch => ({
  kind: 'failed',
  message: `dependabot-review: ${why}; no review ran.`,
});

/**
 * Re-runs this script in a child Node with the derived old-generation size, passing through its
 * arguments, environment and standard streams, and resolves with the child's exit. Resolves
 * `run` when this process should run the action itself: it is the relaunched child, or an
 * old-generation size was already given, and either way its V8 heap limit is at least the heap
 * the caps are sized for (limit:runner.heapBytes). It fails closed, never running at V8's
 * default, when the runner leaves no heap to size, the child cannot be started, or the heap
 * limit is below that heap.
 */
export async function relaunch(current: RelaunchProcess): Promise<Relaunch> {
  const required = current.requiredHeapBytes ?? limit('runner.heapBytes');
  const heapLimit = current.heapLimit ?? (() => getHeapStatistics().heap_size_limit);
  const verified = (): Relaunch => {
    const actual = heapLimit();
    return actual >= required
      ? { kind: 'run' }
      : failed(
          `the Node heap limit is ${actual} bytes, below the ${required} bytes the review's limits assume (limit:runner.heapBytes)`,
        );
  };
  if (current.env[RELAUNCHED_ENV] !== undefined) return verified();
  if (
    current.execArgv.some((arg) => arg === OLD_SPACE_FLAG || arg.startsWith(`${OLD_SPACE_FLAG}=`))
  )
    return verified();
  const mib = oldSpaceMiB(current.memory);
  if (mib === null)
    return failed(`the runner's ${current.memory} bytes of memory leave no heap for the review`);
  const spawn = current.spawn ?? spawnProcess;
  const signals = current.signals ?? process;
  let child: ChildProcess;
  try {
    child = spawn(
      current.execPath,
      [`${OLD_SPACE_FLAG}=${mib}`, ...current.execArgv, ...current.argv.slice(1)],
      {
        stdio: current.ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
        env: { ...current.env, [RELAUNCHED_ENV]: String(mib) },
      },
    );
  } catch {
    return failed('Node could not be relaunched with the runner heap');
  }
  // A cancelled job signals this process; the child must stop with it.
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of FORWARDED_SIGNALS) signals.on(signal, forward);
  const ipc = current.ipc;
  const down = (message: unknown) => {
    if (child.connected) child.send(message as never);
  };
  const up = (message: unknown) => ipc?.send(message);
  if (ipc) {
    ipc.on('message', down);
    child.on('message', up);
  }
  try {
    return await new Promise<Relaunch>((resolve) => {
      // An error before the child exits means it could not be started.
      child.once('error', () =>
        resolve(failed('Node could not be relaunched with the runner heap')),
      );
      child.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
    });
  } finally {
    for (const signal of FORWARDED_SIGNALS) signals.off(signal, forward);
    ipc?.off('message', down);
  }
}

/**
 * Ends this process as the child ended: the same exit code, or the same signal. A relaunch that
 * failed writes its message and exits with HEAP_EXIT_CODE.
 */
export function exitAs(
  exit: Exclude<Relaunch, { kind: 'run' }>,
  writeError: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  if (exit.kind === 'failed') {
    writeError(exit.message);
    process.exitCode = HEAP_EXIT_CODE;
  } else if (exit.signal) process.kill(process.pid, exit.signal);
  else process.exitCode = exit.code ?? 1;
}
