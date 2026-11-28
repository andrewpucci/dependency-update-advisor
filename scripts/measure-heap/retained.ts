/**
 * One retained-evidence heap measurement for the heap probe (run.ts starts it with the flags it
 * needs): `count` values of exactly `RETAINED_BYTES` retained bytes each, held at once, the way a
 * reader holds what it keeps after a parse. Usage: retained.ts <shape> <count>.
 *
 * Readers charge what they keep against their retained caps as the UTF-8 length of its JSON
 * (`Buffer.byteLength(JSON.stringify(value))`, for example src/evidence/npm.ts and
 * src/evidence/policy-signals-read.ts), and keep a frozen structured clone of the parsed value
 * (src/evidence/npm-graph.ts). Each value here is parsed from its own text, cloned and deeply
 * frozen; the text and the parsed original are dropped, so only the clones stay reachable. The
 * probe's difference between two counts is then the heap the retained values hold, without the
 * transient parse peak of the last one.
 *
 * Shapes are those of the response probe (evidence.ts): `flat` (empty arrays), `objects` (empty
 * objects) and `nested` (arrays nested to `limit:research.maxJsonDepth`).
 */
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

const gc = globalThis.gc;
if (!gc) throw new Error('run with --expose-gc (npm run measure:heap does)');

/** Each value's retained size; 1 MiB keeps one value's parse peak small beside many held. */
const RETAINED_BYTES = BINARY_BYTES.MiB;
const DEPTH = limit('research.maxJsonDepth');

/** Compact JSON of exactly `bytes`: `unit` repeated inside one array, padded with numbers. */
function text(shape: string, bytes: number): string {
  const units: Record<string, string> = {
    flat: '[]',
    objects: '{}',
    nested: '['.repeat(DEPTH - 1) + ']'.repeat(DEPTH - 1),
  };
  const unit = units[shape];
  if (unit === undefined) throw new Error(`shape must be one of ${Object.keys(units).join(', ')}`);
  // One unit fewer than fits leaves room for the padding: `,10` if an odd byte count is left,
  // then `,0` elements to the exact size.
  const count = Math.floor((bytes - 2) / (unit.length + 1)) - 1;
  let body = '[' + Array.from({ length: count }, () => unit).join(',');
  if ((bytes - body.length - 1) % 2 === 1) body += ',10';
  body += ',0'.repeat((bytes - body.length - 1) / 2);
  return body + ']';
}

const deepFreeze = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const [shape, countText] = process.argv.slice(2);
const count = Number(countText);
if (!shape || !Number.isSafeInteger(count) || count < 1)
  throw new Error('usage: retained.ts <shape> <count>');

const held: unknown[] = [];
for (let i = 0; i < count; i++) {
  const value = deepFreeze(structuredClone(JSON.parse(text(shape, RETAINED_BYTES))));
  const retained = Buffer.byteLength(JSON.stringify(value));
  if (retained !== RETAINED_BYTES)
    throw new Error(`${shape}: a value retains ${retained} bytes, not ${RETAINED_BYTES}`);
  held.push(value);
  gc();
}
console.log(
  JSON.stringify({
    node: process.version,
    shape,
    count: held.length,
    retainedBytes: RETAINED_BYTES,
  }),
);
