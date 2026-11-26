import { types } from 'node:util';
import { limit } from '../limits.js';
import { PACKET_LIMITS } from '../schema.js';

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
    Buffer.byteLength(value) <= limit('packet.identityBytes') &&
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
const PACKET_FIELDS = new Set(['changes', 'sources', 'findings']);
/**
 * Serialized sizes of a stage's output, each part serialized once: `packet` is what it adds to the
 * review packet (changes, sources, findings), and `retained` is the whole output. Everything else
 * (attempts, lookups, identities, binding) is a diagnostic outside the packet, so it counts only
 * toward retained bytes. Both equal `Buffer.byteLength(JSON.stringify(...))` of the corresponding
 * object.
 */
export function enrichmentBytes(output: object): { packet: number; retained: number } {
  const object = (sizes: number[]) =>
    2 + sizes.reduce((total, size) => total + size, 0) + Math.max(sizes.length - 1, 0);
  const members = Object.entries(output).flatMap(([key, value]) => {
    const json = JSON.stringify(value);
    return json === undefined
      ? []
      : [{ key, size: Buffer.byteLength(JSON.stringify(key)) + 1 + Buffer.byteLength(json) }];
  });
  return {
    packet: object(members.filter((m) => PACKET_FIELDS.has(m.key)).map((m) => m.size)),
    retained: object(members.map((m) => m.size)),
  };
}
/**
 * Whether a stage input's research byte bound is valid: absent, or a positive whole number of
 * bytes no larger than the packet limit.
 */
export function validPacketBytes(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= PACKET_LIMITS.bytes)
  );
}
/**
 * The bytes a stage's changes, sources, and findings may take: the input's research byte bound,
 * or the whole packet limit for a caller whose packet holds nothing else.
 */
export function packetBytesOf(input: { packetBytes?: number }): number {
  return input.packetBytes ?? PACKET_LIMITS.bytes;
}
