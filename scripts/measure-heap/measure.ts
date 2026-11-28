/**
 * One heap measurement for the heap probe (run.ts starts it with the flags it needs): the peak
 * heap of one packet through T4 validation, revalidation, analysis with a stub model, and render.
 * Usage: measure.ts <packet.json>, with --expose-gc and the hooks in register.mjs. With
 * PHASE=evidence it stops after revalidation, the packet's evidence-phase path: assembly's
 * serialization, T4 validation and research's revalidation, with no analysis. With
 * RESP=flat|objects|nested, every model reply is a body of exactly `limit:analysis.responseBytes`
 * in that JSON shape instead of a valid document, which bounds what one reply can hold.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Schema from '../../src/schema.js';
import type * as Revalidation from '../../src/revalidation.js';
import type * as Assessment from '../../src/assessment.js';
import type * as Config from '../../src/config.js';
import type * as Mistral from '../../src/analysis/mistral.js';
import type * as Contract from '../../src/analysis/contract.js';
import type * as Limits from '../../src/limits.js';
import type * as Analysis from '../../tests/parity/analysis.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(ROOT, file)).href)) as T;
const { validateReviewPacket } = await load<typeof Schema>('src/schema.ts');
const { reconcilePacket } = await load<typeof Revalidation>('src/revalidation.ts');
const { reviewPacket } = await load<typeof Assessment>('src/assessment.ts');
const { parseReviewConfig } = await load<typeof Config>('src/config.ts');
const { analyzeMistralBatch } = await load<typeof Mistral>('src/analysis/mistral.ts');
const { analysisDocument } = await load<typeof Analysis>('tests/parity/analysis.ts');
const { limit } = await load<typeof Limits>('src/limits.ts');

type Reconcile = Parameters<typeof reconcilePacket>[0];
type Dump = {
  packet: unknown;
  expected: Reconcile['trusted'];
  configText: string;
  evaluatedAt: number;
  signalAttempts: Assessment.ReviewInput['signalAttempts'];
};
type Batch = Contract.PreparedAnalysisBatch;
type Call = Parameters<typeof analyzeMistralBatch>[1];

const gc = globalThis.gc;
if (!gc) throw new Error('run with --expose-gc (npm run measure:heap does)');
const used = () => process.memoryUsage().heapUsed;
/** Collects until nothing more is freed, so the baseline holds only live data. */
const settle = () => {
  let before = Number.POSITIVE_INFINITY;
  while (used() < before) {
    before = used();
    gc();
  }
  return used();
};
let peak = 0;
const sample = () => {
  peak = Math.max(peak, used());
};
const stages: Record<string, number> = {};
const stage = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
  const start = performance.now();
  const value = await run();
  stages[name] = performance.now() - start;
  sample();
  return value;
};
const NEVER = Number.MAX_SAFE_INTEGER;
const now = () => 0;

const reply = (batch: Batch) =>
  Response.json({
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
      },
    ],
  });
const stubModel = (batch: Batch, call: Call) =>
  analyzeMistralBatch(batch, call, { now, fetch: async () => reply(batch) });

function review(dump: Dump, analyze: typeof stubModel) {
  const config = parseReviewConfig(dump.configText);
  if (!config.ok) throw new Error('config');
  const validated = validateReviewPacket(dump.packet, dump.expected);
  if (!validated.ok) throw new Error(`validate ${JSON.stringify(validated.error)}`);
  return { config, validated: validated.packet, analyze };
}

const reconcile = (collected: Reconcile['collected'], expected: Dump['expected']) =>
  reconcilePacket({
    collected,
    enriched: {
      changes: collected.changes,
      sources: collected.sources,
      findings: collected.findings,
      retryAfter: null,
    },
    trusted: expected,
    priority: collected.changes.map((change) => change.id),
  });

const assess = (
  packet: Assessment.ReviewInput['packet'],
  config: Extract<Config.ConfigResult, { ok: true }>,
  dump: Pick<Dump, 'evaluatedAt' | 'signalAttempts'>,
  analyze: typeof stubModel,
) =>
  reviewPacket({
    packet,
    config,
    apiKey: 'stub',
    evaluatedAt: dump.evaluatedAt,
    deadlineMs: NEVER,
    signalAttempts: dump.signalAttempts,
    model: { now, analyze },
  });

/** A body of at most responseBytes whose `assessments` holds `unit` repeated, in that shape. */
function crafted(shape: string): Buffer {
  const responseBytes = limit('analysis.responseBytes');
  const head =
    '{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"{\\"assessments\\":[';
  const tail = '0]}"}}]}';
  const depth = limit('analysis.maxProjectionDepth');
  const units: Record<string, string> = {
    flat: '[],',
    objects: '{},',
    // Arrays nested below the projection depth cap, so the snapshot copy still succeeds.
    nested: '['.repeat(depth / 2) + ']'.repeat(depth / 2) + ',',
  };
  const unit = units[shape];
  if (unit === undefined) throw new Error(`RESP must be one of ${Object.keys(units).join(', ')}`);
  const count = Math.floor((responseBytes - head.length - tail.length) / unit.length);
  const body = Buffer.from(head + unit.repeat(count) + tail);
  if (body.byteLength > responseBytes) throw new Error('crafted body over responseBytes');
  return body;
}

const file = process.argv[2];
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Dump;

// Warm-up: the same path once on a separate copy, so compiled code and lazily created module
// state are in the baseline, not in the per-packet figure.
{
  const warm = read(file);
  const { config, validated } = review(warm, stubModel);
  await assess(reconcile(validated, warm.expected).packet, config, warm, stubModel);
}

// Off-heap, like a body arriving from the network; each call gets its own copy.
const body = process.env.RESP ? crafted(process.env.RESP) : null;
const craftedModel = (batch: Batch, call: Call) =>
  analyzeMistralBatch(batch, call, {
    now,
    fetch: async () =>
      new Response(new Uint8Array(body ?? []), {
        headers: { 'content-type': 'application/json' },
      }),
  });

const timer = setInterval(sample, 1);
const base = settle();
let dump: Dump | null = read(file);
const packetBytes = Buffer.byteLength(JSON.stringify(dump.packet));
const { evaluatedAt, signalAttempts, expected } = dump;
// The file text and parse garbage are freed first: only the candidate packet is held.
settle();
peak = used();
// packet.ts serializes the whole packet once for the optional-evidence budget.
await stage('assemblyStringify', () => Buffer.byteLength(JSON.stringify(dump?.packet)));
const { config, validated } = await stage('validate', () =>
  review(dump as Dump, body ? craftedModel : stubModel),
);
dump = null;
const researched = await stage('revalidate', () => reconcile(validated, expected));
// PHASE=evidence stops where analysis would start: the evidence phase ends with revalidation.
const reviewed =
  process.env.PHASE === 'evidence'
    ? { kind: researched.packet === null ? 'none' : 'revalidated', analysisTiming: null }
    : await stage('assessAndRender', () =>
        assess(
          researched.packet,
          config,
          { evaluatedAt, signalAttempts },
          body ? craftedModel : stubModel,
        ),
      );
clearInterval(timer);
const peakDelta = peak - base;
console.log(
  JSON.stringify({
    node: process.version,
    packetBytes,
    kind: reviewed.kind,
    resp: process.env.RESP ?? null,
    respBytes: body?.byteLength ?? null,
    calls: reviewed.analysisTiming?.callsDispatched ?? null,
    baseHeap: base,
    peakHeapUsed: peak,
    peakDelta,
    perPacketByte: peakDelta / packetBytes,
    ms: stages,
  }),
);
