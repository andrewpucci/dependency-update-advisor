import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, vi } from 'vite-plus/test';
import { BINARY_BYTES } from './format.js';
import { heapBytesFor, limit } from './limits.js';
import { oldSpaceMiB, relaunch, RELAUNCHED_ENV, runnerMemory } from './relaunch.js';

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
  // A runner with no memory left for a heap keeps V8's default.
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
  const base = { execPath: '/node', argv: ['/node', '/a.js'], memory: memoryFor(300), spawn };
  expect(await relaunch({ ...base, execArgv: [], env: { [RELAUNCHED_ENV]: '300' } })).toEqual({
    kind: 'run',
  });
  expect(await relaunch({ ...base, execArgv: ['--max-old-space-size=100'], env: {} })).toEqual({
    kind: 'run',
  });
  expect(await relaunch({ ...base, execArgv: [], env: {}, memory: memoryFor(0) })).toEqual({
    kind: 'run',
  });
  expect(spawn).not.toHaveBeenCalled();
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
      env: { ...process.env, FIXTURE_MEMORY: String(memoryFor(300)), FIXTURE_EXIT: '7' },
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
