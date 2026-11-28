/**
 * The research timing probes' runner. Usage:
 *
 *   npm run probe:osv-latency -- PyPI:requests@2.0.0 npm:lodash@4.17.20 ...
 *   GITHUB_TOKEN=... npm run probe:upstream-throughput -- github:<owner>/<repo> pypi:<name> ...
 *
 * Each target is read once, one after another, as research reads them, and each read's body is
 * read to its end or to `limit:evidence.envelope.maxResponseBytes`. It prints one JSON result of
 * counts and the figure, with no target name, URL or token. All reductions are in core.ts.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';
import type * as Format from '../../src/format.js';
import type * as Limits from '../../src/limits.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(ROOT, file)).href)) as T;
const core = await load<typeof Core>('scripts/probe-research-timing/core.ts');
const { ISO_DATE_TIME } = await load<typeof Format>('src/format.ts');
const { limit } = await load<typeof Limits>('src/limits.ts');

type Request = { url: string; init: RequestInit };

/** Reads one response body to its end or the response cap, and times the whole request. */
async function timed(request: Request): Promise<Core.TimedRead> {
  const started = performance.now();
  // A hung read ends at the evidence deadline, the longest any research read may take.
  const signal = AbortSignal.timeout(limit('evidence.envelope.totalTimeoutMs'));
  try {
    const response = await fetch(request.url, { ...request.init, signal });
    let bytes = 0;
    const reader = response.body?.getReader();
    for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > limit('evidence.envelope.maxResponseBytes')) {
        await reader?.cancel();
        return { status: 0, bytes, elapsedMs: performance.now() - started };
      }
    }
    return { status: response.status, bytes, elapsedMs: performance.now() - started };
  } catch {
    return { status: 0, bytes: 0, elapsedMs: performance.now() - started };
  }
}

function osvRequest(target: Core.OsvTarget): Request {
  return {
    url: 'https://api.osv.dev/v1/query',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: { ecosystem: target.ecosystem, name: target.name },
        version: target.version,
      }),
    },
  };
}

function upstreamRequest(target: Core.UpstreamTarget, token: string | undefined): Request {
  if (target.kind === 'pypi')
    return { url: `https://pypi.org/pypi/${encodeURIComponent(target.name)}/json`, init: {} };
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  return {
    url: `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${limit('github.pageSize')}`,
    init: {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    },
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv;
  const targets =
    mode === 'osv'
      ? core.parseOsvTargets(rest)
      : mode === 'upstream'
        ? core.parseUpstreamTargets(rest)
        : { error: 'mode must be osv or upstream' };
  if ('error' in targets) {
    console.error(`probe-research-timing: ${targets.error}`);
    return 1;
  }
  const token = process.env.GITHUB_TOKEN || undefined;
  const reads: Core.TimedRead[] = [];
  for (const target of targets)
    reads.push(
      await timed(target.kind === 'osv' ? osvRequest(target) : upstreamRequest(target, token)),
    );
  const failed = reads.filter((read) => !core.succeeded(read)).length;
  const value =
    mode === 'osv' ? core.slowestResponseMs(reads) : core.throughputBytesPerSecond(reads);
  const figure = mode === 'osv' ? 'slowestResponseMs' : 'throughputBytesPerSecond';
  console.log(
    JSON.stringify({
      mode,
      checked: new Date().toISOString().slice(0, ISO_DATE_TIME.day[1]),
      reads: reads.length,
      failed,
      bytes: reads.reduce((total, read) => total + read.bytes, 0),
      elapsedMs: Math.round(reads.reduce((total, read) => total + read.elapsedMs, 0)),
      [figure]: value,
    }),
  );
  return value === null ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
