import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { totalmem } from 'node:os';
import { BINARY_BYTES } from './format.js';
import { heapBytesFor, limit } from './limits.js';

/**
 * Set in the relaunched process. A process that sees it, or already has an old-generation flag,
 * runs the action itself and never relaunches, so the relaunch cannot loop.
 */
export const RELAUNCHED_ENV = 'DEPENDENCY_REVIEW_RELAUNCHED';
const OLD_SPACE_FLAG = '--max-old-space-size';
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

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
 * runner's. Null when nothing is left for the heap, so the process keeps V8's default.
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
  | Readonly<{ kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }>;

/**
 * Re-runs this script in a child Node with the derived old-generation size, passing through its
 * arguments, environment and standard streams, and resolves with the child's exit. Resolves
 * `run` when this process should run the action itself: it is the relaunched child, an
 * old-generation size was already given, or the runner leaves no heap to size.
 */
export async function relaunch(current: RelaunchProcess): Promise<Relaunch> {
  if (current.env[RELAUNCHED_ENV] !== undefined) return { kind: 'run' };
  if (
    current.execArgv.some((arg) => arg === OLD_SPACE_FLAG || arg.startsWith(`${OLD_SPACE_FLAG}=`))
  )
    return { kind: 'run' };
  const mib = oldSpaceMiB(current.memory);
  if (mib === null) return { kind: 'run' };
  const spawn = current.spawn ?? spawnProcess;
  const signals = current.signals ?? process;
  const child = spawn(
    current.execPath,
    [`${OLD_SPACE_FLAG}=${mib}`, ...current.execArgv, ...current.argv.slice(1)],
    {
      stdio: current.ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      env: { ...current.env, [RELAUNCHED_ENV]: String(mib) },
    },
  );
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
    return await new Promise<Relaunch>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ kind: 'exited', code, signal }));
    });
  } finally {
    for (const signal of FORWARDED_SIGNALS) signals.off(signal, forward);
    ipc?.off('message', down);
  }
}

/** Ends this process as the child ended: the same exit code, or the same signal. */
export function exitAs(exit: Extract<Relaunch, { kind: 'exited' }>): void {
  if (exit.signal) process.kill(process.pid, exit.signal);
  else process.exitCode = exit.code ?? 1;
}
