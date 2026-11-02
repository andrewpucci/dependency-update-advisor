import { parse, TomlError } from 'smol-toml';
import type { EvidenceReason } from '../schema.js';
import { isPlainObject } from './common.js';

export type UvParseLimits = {
  maxFileBytes: number;
  maxTomlDepth: number;
  maxTomlEntries: number;
  maxPackages: number;
  maxDeclarations: number;
  maxEdges: number;
  maxStringBytes: number;
  maxRequirementTokens: number;
  maxMarkerDepth: number;
};
export type UvBudget = { entries: number; packages: number; declarations: number; edges: number };
export type UvEntryGap = { entry: string | null; reason: EvidenceReason };
export type UvRead<T> =
  | { kind: 'unavailable'; reason: EvidenceReason }
  | { kind: 'parsed'; value: T; gaps: UvEntryGap[] };
export class UvFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
export function need(value: unknown, reason: EvidenceReason = 'malformed'): asserts value {
  if (!value) throw new UvFailure(reason);
}
export function reason(error: unknown): EvidenceReason {
  return error instanceof UvFailure ? error.reason : 'malformed';
}
export function table(value: unknown): Record<string, unknown> {
  need(isPlainObject(value));
  return value;
}
export function safeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !/[\p{Cc}\p{Cs}]/u.test(value) &&
    !/\/\/[^/\s]*@|[?&](?:token|key|password|secret|auth)=/iu.test(value)
  );
}
export function text(value: unknown): string {
  need(safeText(value) && value.length > 0);
  return value;
}
export function debit(budget: UvBudget, key: keyof UvBudget, limit: number) {
  need(budget[key] < limit, 'budget');
  budget[key]++;
}
export function newBudget(): UvBudget {
  return { entries: 0, packages: 0, declarations: 0, edges: 0 };
}

// Only library-owned tables pass here; external input still uses the shared plain-data guard.
function copyDocument(raw: Record<string, unknown>, limits: UvParseLimits, budget: UvBudget) {
  const value: Record<string, unknown> = {};
  const stack: { from: object; to: Record<string, unknown> | unknown[]; depth: number }[] = [
    { from: raw, to: value, depth: 1 },
  ];
  while (stack.length) {
    const { from, to, depth } = stack.pop()!;
    need(depth <= limits.maxTomlDepth, 'budget');
    for (const [key, child] of Object.entries(from)) {
      debit(budget, 'entries', limits.maxTomlEntries);
      need(!['__proto__', 'constructor', 'prototype'].includes(key));
      need(Buffer.byteLength(key) <= limits.maxStringBytes, 'budget');
      if (typeof child === 'string')
        need(Buffer.byteLength(child) <= limits.maxStringBytes, 'budget');
      let copied = child;
      if (child && typeof child === 'object' && !(child instanceof Date)) {
        copied = Array.isArray(child) ? [] : {};
        stack.push({ from: child, to: copied as Record<string, unknown>, depth: depth + 1 });
      }
      Object.defineProperty(to, key, {
        value: copied,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return value;
}

/** Bytes bound parser work/allocation first; the iterative entry pass is not a parser hook. */
export function readToml(
  bytes: Uint8Array,
  limits: UvParseLimits,
  budget = newBudget(),
):
  | { kind: 'parsed'; value: Record<string, unknown> }
  | { kind: 'unavailable'; reason: EvidenceReason } {
  try {
    need(bytes.byteLength <= limits.maxFileBytes, 'budget');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const raw = parse(source, { maxDepth: limits.maxTomlDepth, unsafeKeyBehaviour: 'throw' });
    return { kind: 'parsed', value: copyDocument(raw, limits, budget) };
  } catch (error) {
    // The pinned reader exposes depth exhaustion only through this fixed message prefix.
    const depth =
      error instanceof TomlError &&
      error.message.startsWith(
        'Invalid TOML document: document contains excessively nested structures. aborting.\n',
      );
    return {
      kind: 'unavailable',
      reason: depth || error instanceof RangeError ? 'budget' : reason(error),
    };
  }
}
