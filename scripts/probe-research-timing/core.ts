/**
 * The research timing probes' logic (L11, Q2, #383: a probed platform figure is an `external` entry).
 * They reproduce the two platform figures the research ceilings derive from: the slowest OSV
 * `v1/query` response (`limit:osv.slowestResponseMs`) and the upstream read throughput
 * (`limit:upstream.throughputBytesPerSecond`). run.ts does the I/O; this file only parses the
 * targets and reduces the timed reads, so it is tested without the network.
 */

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Format from '../../src/format.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { DURATION_MS, HTTP_STATUS } = (await import(
  pathToFileURL(join(ROOT, 'src/format.ts')).href
)) as typeof Format;

/** One read the probe made: its HTTP status, the body bytes it read, and its wall time. */
export type TimedRead = Readonly<{ status: number; bytes: number; elapsedMs: number }>;

export type OsvTarget = Readonly<{ kind: 'osv'; ecosystem: string; name: string; version: string }>;
export type UpstreamTarget =
  | Readonly<{ kind: 'github'; owner: string; repo: string }>
  | Readonly<{ kind: 'pypi'; name: string }>;

const OSV_TARGET = /^([A-Za-z][\w.-]*):((?:@[\w.-]+\/)?[\w.-]+)@([\w.!+-]+)$/u;
const GITHUB_TARGET = /^github:([\w.-]+)\/([\w.-]+)$/u;
const PYPI_TARGET = /^pypi:([A-Za-z0-9][\w.-]*)$/u;

/** `<ecosystem>:<name>@<version>` per argument, such as `PyPI:requests@2.0.0`. */
export function parseOsvTargets(argv: readonly string[]): OsvTarget[] | { error: string } {
  const targets: OsvTarget[] = [];
  for (const arg of argv) {
    const match = OSV_TARGET.exec(arg);
    if (!match) return { error: `not <ecosystem>:<name>@<version>: ${arg}` };
    targets.push({ kind: 'osv', ecosystem: match[1], name: match[2], version: match[3] });
  }
  return targets.length > 0 ? targets : { error: 'needs at least one target' };
}

/** `github:<owner>/<repo>` (its first releases page) or `pypi:<name>` (its JSON) per argument. */
export function parseUpstreamTargets(
  argv: readonly string[],
): UpstreamTarget[] | { error: string } {
  const targets: UpstreamTarget[] = [];
  for (const arg of argv) {
    const github = GITHUB_TARGET.exec(arg);
    const pypi = PYPI_TARGET.exec(arg);
    if (github) targets.push({ kind: 'github', owner: github[1], repo: github[2] });
    else if (pypi) targets.push({ kind: 'pypi', name: pypi[1] });
    else return { error: `not github:<owner>/<repo> or pypi:<name>: ${arg}` };
  }
  return targets.length > 0 ? targets : { error: 'needs at least one target' };
}

/** A 2xx response; a failed or cut-off read is recorded with status 0. */
export const succeeded = (read: TimedRead): boolean =>
  read.status >= HTTP_STATUS.successMin && read.status <= HTTP_STATUS.successMax;

/** The slowest successful response, in whole milliseconds rounded up; null with none. */
export function slowestResponseMs(reads: readonly TimedRead[]): number | null {
  const times = reads.filter(succeeded).map((read) => read.elapsedMs);
  return times.length > 0 ? Math.ceil(Math.max(...times)) : null;
}

/**
 * Bytes per second over the successful reads made one after another, as research makes them:
 * their total body bytes over their total wall time, rounded down; null with none.
 */
export function throughputBytesPerSecond(reads: readonly TimedRead[]): number | null {
  const done = reads.filter(succeeded);
  const elapsed = done.reduce((total, read) => total + read.elapsedMs, 0);
  if (done.length === 0 || elapsed <= 0) return null;
  const bytes = done.reduce((total, read) => total + read.bytes, 0);
  return Math.floor((bytes * DURATION_MS.second) / elapsed);
}
