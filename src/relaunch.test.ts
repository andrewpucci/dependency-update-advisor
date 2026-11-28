import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vite-plus/test';
import { BINARY_BYTES } from './format.js';
import { heapBytesFor, limit } from './limits.js';
import {
  exitAs,
  HEAP_EXIT_CODE,
  oldSpaceMiB,
  relaunch,
  RELAUNCHED_ENV,
  runnerMemory,
} from './relaunch.js';

/** The runner memory whose derived heap is exactly `mib` MiB. */
const memoryFor = (mib: number) =>
  mib * BINARY_BYTES.MiB +
  limit('runner.youngGenerationBytes') +
  limit('runner.offHeapBytes') +
  limit('runner.baselineBytes') +
  limit('runner.systemReservedBytes');

test('sizes the heap with the register formula and the runner memory', () => {
  expect(oldSpaceMiB(memoryFor(300))).toBe(300);
  expect(oldSpaceMiB(memoryFor(300) + BINARY_BYTES.MiB - 1)).toBe(300);
  // On the smallest runner it is the register's heap.
  expect(oldSpaceMiB(limit('runner.memoryBytes'))).toBe(
    Math.floor(limit('runner.heapBytes') / BINARY_BYTES.MiB),
  );
  expect(
    heapBytesFor(
      limit('runner.memoryBytes'),
      limit('runner.youngGenerationBytes'),
      limit('runner.offHeapBytes'),
      limit('runner.baselineBytes'),
      limit('runner.systemReservedBytes'),
    ),
  ).toBe(limit('runner.heapBytes'));
  // A runner with no memory left for a heap has nothing to size; the relaunch then fails closed.
  expect(oldSpaceMiB(memoryFor(0))).toBeNull();
});

test('reads the cgroup limit when it is below physical memory, as Node does', () => {
  expect(runnerMemory(8_000, 6_000)).toBe(6_000);
  expect(runnerMemory(8_000, 0)).toBe(8_000);
  expect(runnerMemory(8_000, Number.MAX_SAFE_INTEGER)).toBe(8_000);
});

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  return child;
}

test('passes argv, env and streams through, and resolves with the child exit', async () => {
  const child = fakeChild();
  const spawn = vi.fn(() => child);
  const signals = new EventEmitter();
  const running = relaunch({
    execPath: '/node',
    execArgv: ['--enable-source-maps'],
    argv: ['/node', '/action/index.js', 'one', 'two'],
    env: { KEEP: 'yes' },
    memory: memoryFor(300),
    spawn,
    signals: signals as never,
  });
  expect(spawn).toHaveBeenCalledWith(
    '/node',
    ['--max-old-space-size=300', '--enable-source-maps', '/action/index.js', 'one', 'two'],
    { stdio: 'inherit', env: { KEEP: 'yes', [RELAUNCHED_ENV]: '300' } },
  );
  // A cancellation reaching the parent is forwarded to the child.
  signals.emit('SIGTERM', 'SIGTERM');
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  child.emit('exit', 7, null);
  expect(await running).toEqual({ kind: 'exited', code: 7, signal: null });
  expect(signals.listenerCount('SIGTERM')).toBe(0);
});

test('never relaunches a relaunched process or one with an old-generation size', async () => {
  const spawn = vi.fn();
  const base = {
    execPath: '/node',
    argv: ['/node', '/a.js'],
    memory: memoryFor(300),
    spawn,
    requiredHeapBytes: 100,
    heapLimit: () => 100 + limit('runner.youngGenerationBytes'),
  };
  expect(await relaunch({ ...base, execArgv: [], env: { [RELAUNCHED_ENV]: '300' } })).toEqual({
    kind: 'run',
  });
  expect(await relaunch({ ...base, execArgv: ['--max-old-space-size=100'], env: {} })).toEqual({
    kind: 'run',
  });
  // V8 reads `_` and `-` alike in flag names.
  for (const flag of ['--max_old_space_size=100', '--max_old-space_size', '--max-old-space-size'])
    expect(await relaunch({ ...base, execArgv: [flag], env: {} }), flag).toEqual({ kind: 'run' });
  // A runner that leaves no heap stops the action rather than run it at V8's default.
  expect(await relaunch({ ...base, execArgv: [], env: {}, memory: memoryFor(0) })).toMatchObject({
    kind: 'failed',
  });
  expect(spawn).not.toHaveBeenCalled();
});

test('fails closed when the child cannot be spawned', async () => {
  const base = {
    execPath: '/node',
    execArgv: [],
    argv: ['/node', '/a.js'],
    env: {},
    memory: memoryFor(300),
    signals: new EventEmitter() as never,
  };
  const thrown = await relaunch({
    ...base,
    spawn: () => {
      throw new Error('EAGAIN');
    },
  });
  const child = fakeChild();
  const emitting = relaunch({ ...base, spawn: () => child });
  child.emit('error', new Error('ENOENT'));
  for (const result of [thrown, await emitting]) {
    expect(result).toEqual({
      kind: 'failed',
      message:
        'dependabot-review: Node could not be relaunched with the runner heap; no review ran.',
    });
    // The action stops with a clear error and its own exit code; no error text is echoed.
    const lines: string[] = [];
    const before = process.exitCode;
    exitAs(result as Extract<typeof result, { kind: 'failed' }>, (line) => lines.push(line));
    expect(process.exitCode).toBe(HEAP_EXIT_CODE);
    process.exitCode = before;
    expect(lines).toEqual([
      'dependabot-review: Node could not be relaunched with the runner heap; no review ran.',
    ]);
  }
});

test('fails closed when the heap limit is below runner.heapBytes', async () => {
  const base = { execPath: '/node', argv: ['/node', '/a.js'], memory: memoryFor(300) };
  // V8's heap limit counts the young generation as well as the old generation the caps assume.
  const required = limit('runner.heapBytes') + limit('runner.youngGenerationBytes');
  // The relaunched child, or a process given its own old-generation size, checks its limit.
  for (const run of [
    { execArgv: [], env: { [RELAUNCHED_ENV]: '300' } },
    { execArgv: ['--max-old-space-size=100'], env: {} },
  ]) {
    expect(await relaunch({ ...base, ...run, heapLimit: () => required - 1 })).toEqual({
      kind: 'failed',
      message: `dependabot-review: the Node heap limit is ${required - 1} bytes, below the ${required} bytes the review's limits assume (limit:runner.heapBytes plus limit:runner.youngGenerationBytes); no review ran.`,
    });
    expect(await relaunch({ ...base, ...run, heapLimit: () => required })).toEqual({
      kind: 'run',
    });
  }
});

test('relaunches once with the derived old-generation size and passes the exit code through', () => {
  const child = fileURLToPath(new URL('../tests/relaunch/child.ts', import.meta.url));
  const hooks = pathToFileURL(
    fileURLToPath(new URL('../scripts/measure-heap/register.mjs', import.meta.url)),
  ).href;
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', '--import', hooks, child, 'arg'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FIXTURE_MEMORY: String(memoryFor(300)),
        FIXTURE_REQUIRED: String(300 * BINARY_BYTES.MiB),
        FIXTURE_EXIT: '7',
      },
    },
  );
  expect(result.status).toBe(7);
  // Exactly one process ran the action: the relaunched child, so the relaunch did not loop.
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  const ran = JSON.parse(lines[0] as string) as {
    relaunched: string;
    heapLimit: number;
    argv: string[];
    execArgv: string[];
  };
  expect(ran.relaunched).toBe('300');
  expect(ran.argv).toEqual(['arg']);
  expect(ran.execArgv[0]).toBe('--max-old-space-size=300');
  // V8's heap limit is the old generation plus the young generation.
  expect(ran.heapLimit).toBeGreaterThanOrEqual(300 * BINARY_BYTES.MiB);
  expect(ran.heapLimit).toBeLessThanOrEqual(
    300 * BINARY_BYTES.MiB + limit('runner.youngGenerationBytes'),
  );
}, 60_000);

test('a relaunched child whose heap limit is below the required heap stops with a clear error', () => {
  const child = fileURLToPath(new URL('../tests/relaunch/child.ts', import.meta.url));
  const hooks = pathToFileURL(
    fileURLToPath(new URL('../scripts/measure-heap/register.mjs', import.meta.url)),
  ).href;
  // The child gets 300 MiB of old generation; one byte more is required.
  const required = 300 * BINARY_BYTES.MiB + 1;
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', '--import', hooks, child],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FIXTURE_MEMORY: String(memoryFor(300)),
        FIXTURE_REQUIRED: String(required),
        FIXTURE_EXIT: '0',
      },
    },
  );
  // The child stopped before running anything, and the parent passed its exit through.
  expect(result.stdout).toBe('');
  expect(result.status).toBe(HEAP_EXIT_CODE);
  expect(result.stderr).toMatch(
    new RegExp(
      `the Node heap limit is \\d+ bytes, below the ${required + limit('runner.youngGenerationBytes')} bytes`,
    ),
  );
}, 60_000);

test('ignores a later child error, never leaves one unhandled, and drops its listeners', async () => {
  const child = fakeChild();
  Object.defineProperty(child, 'pid', { value: 4242 });
  child.send = vi.fn(() => true);
  Object.defineProperty(child, 'connected', { value: true });
  const parent = new EventEmitter();
  const ipc = {
    send: vi.fn(),
    on: (event: 'message', listener: (message: unknown) => void) => parent.on(event, listener),
    off: (event: 'message', listener: (message: unknown) => void) => parent.off(event, listener),
  };
  const running = relaunch({
    execPath: '/node',
    execArgv: [],
    argv: ['/node', '/a.js'],
    env: {},
    memory: memoryFor(300),
    spawn: () => child,
    signals: new EventEmitter() as never,
    ipc,
  });
  // A running child's errors, such as a failed signal, are not a failed start, and a second one
  // is handled too.
  child.emit('error', new Error('EPERM'));
  child.emit('error', new Error('EPERM'));
  child.emit('message', 'up');
  expect(ipc.send).toHaveBeenCalledWith('up');
  child.emit('exit', 0, null);
  expect(await running).toEqual({ kind: 'exited', code: 0, signal: null });
  expect(child.listenerCount('message')).toBe(0);
  expect(parent.listenerCount('message')).toBe(0);
  expect(() => child.emit('error', new Error('late'))).not.toThrow();
});
