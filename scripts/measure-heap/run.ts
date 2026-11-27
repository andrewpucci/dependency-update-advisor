/**
 * The heap probe's runner. It measures the inputs `limit:packet.bytes` is derived from:
 *
 *   npm run measure:heap
 *
 * Each figure is the smallest --max-old-space-size (MiB) at which one run of measure.ts
 * completes: one invented packet through validation, revalidation, analysis and render, in its
 * own Node process with a 1 MiB semi space. A run that needs more old-generation heap aborts, so
 * this is the heap the path needs, not a sampled peak, which moves with garbage-collection timing.
 *
 * - `limit:runner.heapBytesPerPacketByte`: the growth of that heap per serialized packet byte, from the
 *   large-inventory packet (93 npm members plus two same-named copies) to the same packet with
 *   its member records repeated four times. The count caps are raised for the repeated packet
 *   only, through HEAP_LIMIT_OVERRIDES (see hooks.mjs).
 * - `limit:runner.heapBytesPerReplyByte`: the heap of a packet with exactly
 *   `limit:analysis.maxConcurrentCalls` batches when every model reply is a crafted body of
 *   exactly `limit:analysis.responseBytes`, less that packet's own share at the rate above, per
 *   reply byte in flight. The largest of three JSON shapes (flat arrays, empty objects, nested
 *   arrays) is kept. The remainder includes the process baseline, so the formula needs no
 *   separate term for it.
 *
 * The shapes run in parallel, one process each; the whole probe takes several minutes. Run it on
 * Node 24, the action's runtime.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Format from '../../src/format.js';
import type * as Limits from '../../src/limits.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(ROOT, file)).href)) as T;
const { BINARY_BYTES } = await load<typeof Format>('src/format.ts');
const { limit } = await load<typeof Limits>('src/limits.ts');

const HERE = join(ROOT, 'scripts/measure-heap');
const FLAGS = [
  '--max-semi-space-size=1',
  '--expose-gc',
  '--experimental-transform-types',
  '--no-warnings',
  '--import',
  pathToFileURL(join(HERE, 'register.mjs')).href,
];
const SHAPES = ['flat', 'objects', 'nested'] as const;
const LARGE_MEMBERS = '93';
const REPEATS = '4';
/** Twelve members give 16 units, two batches of `limit:analysis.maxUnits`; checked below. */
const TWO_BATCH_MEMBERS = '12';
/** Room for the repeated packet's records; only written register values can be overridden. */
const REPEATED_OVERRIDES = [
  'packet.changes',
  'packet.sources',
  'packet.findings',
  'analysis.maxCalls',
  'analysis.projectionBytes',
  'analysis.projectionEntries',
]
  .map((id) => `${id}=${limit(id as Parameters<typeof limit>[0]) * Number(REPEATS) * 2}`)
  .join(',');

const node = (args: string[]) =>
  execFileSync(process.execPath, [...FLAGS, ...args], { cwd: ROOT, encoding: 'utf8' });

type Run = { packetBytes: number; kind: string; calls: number | null; respBytes: number | null };
const describe = (file: string, env: NodeJS.ProcessEnv = {}): Run =>
  JSON.parse(
    execFileSync(process.execPath, [...FLAGS, join(HERE, 'measure.ts'), file], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    }),
  ) as Run;

function completes(file: string, env: NodeJS.ProcessEnv, mib: number): Promise<boolean> {
  return new Promise((done) => {
    spawn(
      process.execPath,
      [`--max-old-space-size=${mib}`, ...FLAGS, join(HERE, 'measure.ts'), file],
      {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: 'ignore',
      },
    ).on('exit', (code) => done(code === 0));
  });
}

/** The smallest --max-old-space-size, in MiB, at which the run completes. */
async function minimumOldSpace(file: string, env: NodeJS.ProcessEnv = {}): Promise<number> {
  let low = 0;
  let high = limit('runner.oldGenerationBytes') / BINARY_BYTES.MiB;
  if (!(await completes(file, env, high))) throw new Error(`${file} fails at the heap limit`);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await completes(file, env, middle)) high = middle;
    else low = middle;
  }
  return high;
}

const dir = mkdtempSync(join(tmpdir(), 'measure-heap-'));
try {
  const large = join(dir, 'large.json');
  const repeated = join(dir, 'repeated.json');
  const twoBatch = join(dir, 'two-batch.json');
  node([join(HERE, 'packet.ts'), large, LARGE_MEMBERS]);
  node([join(HERE, 'packet.ts'), repeated, LARGE_MEMBERS, REPEATS]);
  node([join(HERE, 'packet.ts'), twoBatch, TWO_BATCH_MEMBERS]);
  const overrides = { HEAP_LIMIT_OVERRIDES: REPEATED_OVERRIDES };
  const runs = {
    large: describe(large),
    repeated: describe(repeated, overrides),
    twoBatch: describe(twoBatch),
  };
  if (runs.twoBatch.calls !== limit('analysis.maxConcurrentCalls'))
    throw new Error(`the two-batch packet made ${runs.twoBatch.calls} calls`);
  const replies = await Promise.all(
    SHAPES.map(async (shape) => ({
      shape,
      respBytes: describe(twoBatch, { RESP: shape }).respBytes ?? 0,
      mib: await minimumOldSpace(twoBatch, { RESP: shape }),
    })),
  );
  const mib = {
    large: await minimumOldSpace(large),
    repeated: await minimumOldSpace(repeated, overrides),
    twoBatch: await minimumOldSpace(twoBatch),
  };
  const perPacketByte =
    ((mib.repeated - mib.large) * BINARY_BYTES.MiB) /
    (runs.repeated.packetBytes - runs.large.packetBytes);
  const worst = replies.reduce((a, b) => (b.mib > a.mib ? b : a));
  const replyHeap = worst.mib * BINARY_BYTES.MiB - perPacketByte * runs.twoBatch.packetBytes;
  const inFlight = worst.respBytes * limit('analysis.maxConcurrentCalls');
  console.log(
    JSON.stringify(
      {
        node: process.version,
        responseBytes: limit('analysis.responseBytes'),
        maxConcurrentCalls: limit('analysis.maxConcurrentCalls'),
        minimumOldSpaceMiB: { ...mib, ...Object.fromEntries(replies.map((r) => [r.shape, r.mib])) },
        packetBytes: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, r.packetBytes])),
        heapBytesPerPacketByte: perPacketByte,
        worstShape: worst.shape,
        replyHeapBytes: replyHeap,
        replyHeapBytesPerByte: replyHeap / inFlight,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
