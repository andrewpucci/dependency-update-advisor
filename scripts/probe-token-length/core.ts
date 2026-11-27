/**
 * The pure part of the token-length probe, which grounds `limit:analysis.maxTokenEscapedBytes`:
 * the longest vocabulary token of a Mistral `tekken.json` tokenizer file, in each unit the reply
 * byte formula could need. The runner in run.ts reads the file; everything here takes parsed JSON.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Format from '../../src/format.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { JSON_ESCAPE_BYTES } = (await import(
  pathToFileURL(join(ROOT, 'src/format.ts')).href
)) as typeof Format;

/** One token's lengths. `rank` is its position in the vocabulary or special-token list. */
export type TokenLengths = {
  rank: number;
  /** Raw token bytes. */
  bytes: number;
  /** UTF-16 code units of the bytes decoded as UTF-8, with replacement characters. */
  codeUnits: number;
  /** UTF-8 bytes of the decoded text as `JSON.stringify` escapes it inside a JSON string. */
  escapedBytes: number;
  /** Bytes when every non-ASCII code unit is written as a six-byte `\uXXXX` escape instead. */
  asciiEscapedBytes: number;
};

export type Maximum = { value: number; rank: number };
export type Summary = {
  version: string | null;
  vocabEntries: number;
  specialTokens: number;
  vocab: Record<Exclude<keyof TokenLengths, 'rank'>, Maximum>;
  special: Record<Exclude<keyof TokenLengths, 'rank'>, Maximum>;
};

const NON_ASCII = /[^\0-\x7f]/gu;

/** The lengths of one token, given its raw bytes. */
export function tokenLengths(rank: number, raw: Uint8Array): TokenLengths {
  const decoded = Buffer.from(raw).toString('utf8');
  const escaped = JSON.stringify(decoded).slice(1, -1);
  // A non-ASCII code unit is one escape; a surrogate pair is two, as `\uXXXX\uXXXX`.
  const nonAscii = Array.from(escaped.matchAll(NON_ASCII), ([match]) => match.length).reduce(
    (sum, units) => sum + units,
    0,
  );
  const asciiBytes = escaped.length - nonAscii;
  return {
    rank,
    bytes: raw.byteLength,
    codeUnits: decoded.length,
    escapedBytes: Buffer.byteLength(escaped),
    asciiEscapedBytes: asciiBytes + nonAscii * JSON_ESCAPE_BYTES,
  };
}

const FIELDS = ['bytes', 'codeUnits', 'escapedBytes', 'asciiEscapedBytes'] as const;

function maxima(tokens: readonly TokenLengths[]): Summary['vocab'] {
  const none = (): Maximum => ({ value: 0, rank: -1 });
  const result = Object.fromEntries(FIELDS.map((field) => [field, none()])) as Summary['vocab'];
  for (const token of tokens)
    for (const field of FIELDS)
      if (token[field] > result[field].value)
        result[field] = { value: token[field], rank: token.rank };
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function entries(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new Error(`${field} is not a list of token records`);
  return value;
}

function rankOf(entry: Record<string, unknown>, index: number): number {
  return typeof entry.rank === 'number' ? entry.rank : index;
}

/**
 * Every vocabulary token is measured from its base64 `token_bytes`. Special tokens carry only
 * `token_str`, so they are measured from that text's UTF-8 bytes.
 */
export function summarize(tekken: unknown): Summary {
  if (!isRecord(tekken) || Array.isArray(tekken)) throw new Error('the tokenizer file is not a JSON object');
  const vocab = entries(tekken.vocab, 'vocab').map((entry, index) => {
    if (typeof entry.token_bytes !== 'string') throw new Error(`vocab ${index}: no token_bytes`);
    return tokenLengths(rankOf(entry, index), Buffer.from(entry.token_bytes, 'base64'));
  });
  if (vocab.length === 0) throw new Error('the tokenizer file has no vocab');
  const special = entries(tekken.special_tokens, 'special_tokens').map((entry, index) => {
    if (typeof entry.token_str !== 'string')
      throw new Error(`special_tokens ${index}: no token_str`);
    return tokenLengths(rankOf(entry, index), Buffer.from(entry.token_str, 'utf8'));
  });
  const config = isRecord(tekken.config) ? tekken.config : {};
  return {
    version: typeof config.version === 'string' ? config.version : null,
    vocabEntries: vocab.length,
    specialTokens: special.length,
    vocab: maxima(vocab),
    special: maxima(special),
  };
}
