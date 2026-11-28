/**
 * The pure part of the JSON depth probe, which grounds `limit:research.maxJsonDepth`: the deepest
 * nesting of a set of legitimate documents, counted as the research readers count it (the root is
 * depth 0, and each array element or object value is one level deeper, as `copyAdvisoryData` in
 * src/evidence/advisory-read.ts does), and the nesting at which the calls that keep a parsed value
 * overflow the call stack. The runner in run.ts reads the files; everything here takes values.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Format from '../../src/format.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { BINARY_BYTES } = (await import(
  pathToFileURL(join(ROOT, 'src/format.ts')).href
)) as typeof Format;

/** The deepest nesting of a parsed JSON value; a scalar root is depth 0. Walks with a stack. */
export function jsonDepth(value: unknown): number {
  let deepest = 0;
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    deepest = Math.max(deepest, item.depth);
    if (typeof item.value !== 'object' || item.value === null) continue;
    const children: unknown[] = Array.isArray(item.value) ? item.value : Object.values(item.value);
    for (const child of children) pending.push({ value: child, depth: item.depth + 1 });
  }
  return deepest;
}

/** Aggregate figures only: a summary never names a document. */
export type DepthSummary = { documents: number; deepest: number };

export function summarizeDepths(depths: readonly number[]): DepthSummary {
  return { documents: depths.length, deepest: Math.max(0, ...depths) };
}

/** An array nested `depth` levels deep: `[]` is depth 0, `[[]]` depth 1. */
export function nestedArrays(depth: number): unknown[] {
  let value: unknown[] = [];
  for (let level = 0; level < depth; level++) value = [value];
  return value;
}

/** Whether `call` completes on `value`; a stack overflow (RangeError) is false, anything else throws. */
function completes(call: (value: unknown) => unknown, value: unknown): boolean {
  try {
    call(value);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * The smallest nesting of arrays at which `call` overflows the stack, found by bisection between
 * a depth that completes and `limit` (by default a nesting of 1 Mi levels, far past where any call
 * overflows); `null` when it completes at `limit`.
 */
export function overflowDepth(
  call: (value: unknown) => unknown,
  limit = BINARY_BYTES.MiB,
): number | null {
  if (completes(call, nestedArrays(limit))) return null;
  let low = 0;
  let high = limit;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (completes(call, nestedArrays(middle))) low = middle;
    else high = middle;
  }
  return high;
}
