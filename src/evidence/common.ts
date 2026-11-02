import { types } from 'node:util';

/** Plain data only: no proxy, foreign prototype, accessor, symbol, or prototype-shaped key. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(
    (k) =>
      typeof k === 'string' &&
      !['__proto__', 'constructor', 'prototype'].includes(k) &&
      'value' in descriptors[k],
  );
}
/** Stricter than D1's transport check: collectors reject every colon, not only a scheme prefix. */
export function isEvidencePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 1024 &&
    !/[\\:\p{Cc}\p{Cs}]/u.test(value) &&
    value.split('/').every((p) => p && p !== '.' && p !== '..')
  );
}
export function byCodeUnit(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Retained size never grows as changes are dropped, so search for the longest fitting prefix. */
export function longestFittingPrefix<T>(
  length: number,
  prefix: (count: number) => T,
  fits: (value: T) => boolean,
): T | null {
  if (!fits(prefix(0))) return null;
  let low = 0,
    high = length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(prefix(mid))) low = mid;
    else high = mid - 1;
  }
  return prefix(low);
}
