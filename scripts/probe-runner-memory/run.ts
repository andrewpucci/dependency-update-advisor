/**
 * The runner memory probe, for `limit:runner.systemReservedBytes`. Run it as a step of a job on
 * the smallest supported runner, a GitHub-hosted ubuntu-latest runner in a private repository:
 *
 *   npm run probe:runner-memory
 *
 * It prints the runner's memory as the action sees it at job start: physical memory, the cgroup
 * limit Node reports, MemTotal and MemAvailable from /proc/meminfo, and the resident set of every
 * process whose name starts with `Runner.` (the runner listener and worker). What the runner OS
 * and agent keep is MemTotal − MemAvailable. It only runs on Linux, and a run anywhere other than
 * a GitHub-hosted runner measures a different machine.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Format from '../../src/format.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { BINARY_BYTES } = (await import(
  pathToFileURL(join(ROOT, 'src/format.ts')).href
)) as typeof Format;

if (process.platform !== 'linux') throw new Error('run it on a Linux GitHub-hosted runner');
const KIB = BINARY_BYTES.KiB;
const meminfo = Object.fromEntries(
  readFileSync('/proc/meminfo', 'utf8')
    .split('\n')
    .map((line) => /^(\w+):\s+(\d+) kB$/u.exec(line))
    .filter((match) => match !== null)
    .map((match) => [match[1], Number(match[2]) * KIB]),
) as Record<string, number>;
const runner = readdirSync('/proc')
  .filter((name) => /^\d+$/u.test(name))
  .flatMap((pid) => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const name = /^Name:\s+(.+)$/mu.exec(status)?.[1] ?? '';
      const rss = Number(/^VmRSS:\s+(\d+) kB$/mu.exec(status)?.[1] ?? 0) * KIB;
      return name.startsWith('Runner.') ? [{ name, rss }] : [];
    } catch {
      return [];
    }
  });
const total = meminfo.MemTotal ?? 0;
const available = meminfo.MemAvailable ?? 0;
console.log(
  JSON.stringify(
    {
      node: process.version,
      runnerOs: process.env.RUNNER_OS ?? null,
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      totalmem: totalmem(),
      constrainedMemory: process.constrainedMemory(),
      memTotal: total,
      memAvailable: available,
      reservedBytes: total - available,
      runnerProcesses: runner,
    },
    null,
    2,
  ),
);
