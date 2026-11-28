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
 * - The value-dense shape (every 64-hex id shortened) of the same two packets gives the dense rate;
 *   `limit:runner.heapBytesPerPacketByte` keeps the larger of the two.
 * - `limit:runner.unitExpansionHeapBytes`: the largest-expansion packet (124 members in the
 *   expansion shape, tests/parity/heap-shapes.ts) less the large packet and its own bytes at the
 *   plain rate, plus 1 MiB of resolution, within the derived projection caps.
 * - `limit:runner.evidenceHeapBytesPerPacketByte`: the same growth with PHASE=evidence, which stops
 *   after revalidation, from the large packet to it repeated 16 times, plus 1 MiB of resolution.
 * - `limit:runner.heapBytesPerEvidenceByte`: one response body of exactly
 *   `limit:evidence.envelope.maxResponseBytes` through each reader's parse path (evidence.ts), the
 *   worst of three shapes less a two-element body, plus 1 MiB of resolution, per body byte; the
 *   largest reader is kept.
 * - `limit:runner.heapBytesPerRetainedByte`: what a reader keeps after a parse (retained.ts), as
 *   the growth from one value of 1 MiB retained JSON bytes to 16 held at once, plus 1 MiB of
 *   resolution, per retained byte, for the same three shapes; the largest shape is kept. The
 *   difference leaves out the transient parse peak, which the response rate above covers.
 *
 * The shapes run in parallel, one process each; the whole probe takes several minutes. Run it on
 * Node 24, the action's runtime.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
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
/** The evidence-phase packet is repeated more, so one MiB of bisection is a smaller share. */
const EVIDENCE_REPEATS = '16';
const READERS = ['transport', 'session', 'advisory', 'osv', 'pypi', 'npm'] as const;
const READER_SHAPES = ['flat', 'objects', 'nested'] as const;
/** Retained values held at once in the larger retained run; each is 1 MiB (retained.ts). */
const RETAINED_COUNT = '16';
/** At most this many bisections run at once, one Node process each. */
const PARALLEL = availableParallelism();
/** Twelve members give 16 units, two batches of `limit:analysis.maxUnits`; checked below. */
const TWO_BATCH_MEMBERS = '12';
/** 124 npm members give limit:packet.changes changes with the scenario's fixed four; checked below. */
const EXPANSION_MEMBERS = '124';
/**
 * Room for the repeated packet's records; only written register values can be overridden. The
 * projection caps are derived from the packet counts (limit:analysis.projectionBytes), so they
 * follow these.
 */
const overridesFor = (repeats: string) =>
  ['packet.changes', 'packet.sources', 'packet.findings', 'analysis.maxCalls']
    .map((id) => `${id}=${limit(id as Parameters<typeof limit>[0]) * Number(repeats) * 2}`)
    .join(',');
const REPEATED_OVERRIDES = overridesFor(REPEATS);

/** Runs the tasks with at most PARALLEL in flight, keeping their order. */
async function pool<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await (tasks[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return results;
}

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

function completes(
  file: string,
  env: NodeJS.ProcessEnv,
  mib: number,
  script = 'measure.ts',
): Promise<boolean> {
  return new Promise((done) => {
    spawn(
      process.execPath,
      [`--max-old-space-size=${mib}`, ...FLAGS, join(HERE, script), ...file.split(' ')],
      {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: 'ignore',
      },
    ).on('exit', (code) => done(code === 0));
  });
}

/** The smallest --max-old-space-size, in MiB, at which the run completes. */
async function minimumOldSpace(
  file: string,
  env: NodeJS.ProcessEnv = {},
  script = 'measure.ts',
): Promise<number> {
  let low = 0;
  let high = Math.floor(limit('runner.heapBytes') / BINARY_BYTES.MiB);
  if (!(await completes(file, env, high, script)))
    throw new Error(`${file} fails at the heap limit`);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await completes(file, env, middle, script)) high = middle;
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

  // The densest valid shape: the same packets with every 64-hex id shortened.
  const denseLarge = join(dir, 'dense-large.json');
  const denseRepeated = join(dir, 'dense-repeated.json');
  node([join(HERE, 'packet.ts'), denseLarge, LARGE_MEMBERS, '1', 'dense']);
  node([join(HERE, 'packet.ts'), denseRepeated, LARGE_MEMBERS, REPEATS, 'dense']);
  // The largest decision-unit expansion, at limit:packet.changes changes. The projection caps
  // are derived from its structural bound (limit:analysis.projectionBytes), so it passes them.
  const expansion = join(dir, 'expansion.json');
  const built = JSON.parse(
    node([join(HERE, 'packet.ts'), expansion, EXPANSION_MEMBERS, '1', 'expansion']),
  ) as { changes: number };
  if (built.changes !== limit('packet.changes'))
    throw new Error(`the expansion packet has ${built.changes} changes`);
  const expansionOverrides = {};
  const shapeRuns = {
    denseLarge: describe(denseLarge),
    denseRepeated: describe(denseRepeated, overrides),
    expansion: describe(expansion, expansionOverrides),
  };
  if (shapeRuns.expansion.calls === null)
    throw new Error(`the expansion packet stopped before analysis: ${shapeRuns.expansion.kind}`);
  const [denseLargeMib = 0, denseRepeatedMib = 0, expansionMib = 0] = await pool([
    () => minimumOldSpace(denseLarge),
    () => minimumOldSpace(denseRepeated, overrides),
    () => minimumOldSpace(expansion, expansionOverrides),
  ]);
  const densePerPacketByte =
    ((denseRepeatedMib - denseLargeMib) * BINARY_BYTES.MiB) /
    (shapeRuns.denseRepeated.packetBytes - shapeRuns.denseLarge.packetBytes);
  // What the expansion packet needs beyond the large packet and its own bytes at the plain rate,
  // plus 1 MiB of bisection resolution: the decision-unit expansion.
  const expansionHeap =
    (expansionMib - mib.large) * BINARY_BYTES.MiB +
    BINARY_BYTES.MiB -
    perPacketByte * (shapeRuns.expansion.packetBytes - runs.large.packetBytes);

  // The evidence phase: the packet through assembly's serialization, validation and
  // revalidation only, and one response body at the cap through each reader's parse path.
  const evidenceRepeated = join(dir, 'evidence-repeated.json');
  node([join(HERE, 'packet.ts'), evidenceRepeated, LARGE_MEMBERS, EVIDENCE_REPEATS]);
  const evidenceOverrides = {
    PHASE: 'evidence',
    HEAP_LIMIT_OVERRIDES: overridesFor(EVIDENCE_REPEATS),
  };
  const evidenceRepeatedBytes = describe(evidenceRepeated, evidenceOverrides).packetBytes;
  const [evidenceLarge = 0, evidenceRepeatedMib = 0, ...measuredMib] = await pool([
    () => minimumOldSpace(large, { PHASE: 'evidence' }),
    () => minimumOldSpace(evidenceRepeated, evidenceOverrides),
    ...READER_SHAPES.flatMap((shape) =>
      ['1', RETAINED_COUNT].map(
        (count) => () => minimumOldSpace(`${shape} ${count}`, {}, 'retained.ts'),
      ),
    ),
    ...READERS.flatMap((reader) =>
      ['empty', ...READER_SHAPES].map(
        (shape) => () => minimumOldSpace(`${reader} ${shape}`, {}, 'evidence.ts'),
      ),
    ),
  ]);
  // Bisection finds each minimum to within 1 MiB, so a difference of two is low by under 1 MiB;
  // both evidence-phase figures add that 1 MiB, an upper bound rather than a midpoint.
  const resolution = BINARY_BYTES.MiB;
  const evidencePerPacketByte =
    ((evidenceRepeatedMib - evidenceLarge) * BINARY_BYTES.MiB + resolution) /
    (evidenceRepeatedBytes - runs.large.packetBytes);
  const retainedMib = measuredMib.slice(0, READER_SHAPES.length * 2);
  const readerMib = measuredMib.slice(READER_SHAPES.length * 2);
  const retained = READER_SHAPES.map((shape, i) => {
    const one = retainedMib[2 * i] ?? 0;
    const many = retainedMib[2 * i + 1] ?? 0;
    return {
      shape,
      minimumOldSpaceMiB: { 1: one, [RETAINED_COUNT]: many },
      perRetainedByte:
        ((many - one) * BINARY_BYTES.MiB + resolution) /
        ((Number(RETAINED_COUNT) - 1) * BINARY_BYTES.MiB),
    };
  });
  const worstRetained = retained.reduce((a, b) => (b.perRetainedByte > a.perRetainedByte ? b : a));
  const responseBytes = limit('evidence.envelope.maxResponseBytes');
  const perReader = READERS.map((reader, r) => {
    const row = readerMib.slice(
      r * (READER_SHAPES.length + 1),
      (r + 1) * (READER_SHAPES.length + 1),
    );
    const [empty = 0, ...shapes] = row;
    const mibByShape = Object.fromEntries(READER_SHAPES.map((shape, i) => [shape, shapes[i] ?? 0]));
    const worstMib = Math.max(...Object.values(mibByShape));
    // A shape no heavier than the two-element body never reached the parse.
    if (worstMib <= empty) throw new Error(`${reader}: the body at the cap was not parsed`);
    return {
      reader,
      minimumOldSpaceMiB: { empty, ...mibByShape },
      perResponseByte: ((worstMib - empty) * BINARY_BYTES.MiB + resolution) / responseBytes,
    };
  });
  const worstReader = perReader.reduce((a, b) => (b.perResponseByte > a.perResponseByte ? b : a));
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
        dense: {
          minimumOldSpaceMiB: { large: denseLargeMib, repeated: denseRepeatedMib },
          packetBytes: {
            large: shapeRuns.denseLarge.packetBytes,
            repeated: shapeRuns.denseRepeated.packetBytes,
          },
          heapBytesPerPacketByte: densePerPacketByte,
        },
        expansion: {
          minimumOldSpaceMiB: expansionMib,
          packetBytes: shapeRuns.expansion.packetBytes,
          calls: shapeRuns.expansion.calls,
          heapBytes: expansionHeap,
        },
        worstShape: worst.shape,
        replyHeapBytes: replyHeap,
        replyHeapBytesPerByte: replyHeap / inFlight,
        evidence: {
          minimumOldSpaceMiB: { large: evidenceLarge, repeated: evidenceRepeatedMib },
          packetBytes: { large: runs.large.packetBytes, repeated: evidenceRepeatedBytes },
          heapBytesPerPacketByte: evidencePerPacketByte,
          responseBytes,
          readers: perReader,
          worstReader: worstReader.reader,
          heapBytesPerResponseByte: worstReader.perResponseByte,
          retained,
          worstRetainedShape: worstRetained.shape,
          heapBytesPerRetainedByte: worstRetained.perRetainedByte,
        },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
