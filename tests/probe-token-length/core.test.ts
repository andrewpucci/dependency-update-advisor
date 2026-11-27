import { expect, test } from 'vite-plus/test';
import { summarize, tokenLengths } from '../../scripts/probe-token-length/core.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

test('a token is measured in raw bytes, decoded code units and both escaped forms', () => {
  expect(tokenLengths(7, Buffer.from(' '.repeat(1_024)))).toEqual({
    rank: 7,
    bytes: 1_024,
    codeUnits: 1_024,
    escapedBytes: 1_024,
    asciiEscapedBytes: 1_024,
  });
  // 'é' is two bytes and one code unit: raw UTF-8 when escaped by JSON.stringify, six bytes as é.
  expect(tokenLengths(0, Buffer.from('aé"'))).toMatchObject({
    bytes: 4,
    codeUnits: 3,
    escapedBytes: 5,
    asciiEscapedBytes: 9,
  });
  // An astral character is four bytes and two code units, so two six-byte escapes.
  expect(tokenLengths(0, Buffer.from('\u{1F600}'))).toMatchObject({
    bytes: 4,
    codeUnits: 2,
    escapedBytes: 4,
    asciiEscapedBytes: 12,
  });
  // A control byte escapes to \u0000; a partial UTF-8 byte decodes to one replacement character.
  expect(tokenLengths(0, Uint8Array.of(0))).toMatchObject({ escapedBytes: 6 });
  expect(tokenLengths(0, Uint8Array.of(0xe2))).toMatchObject({
    bytes: 1,
    codeUnits: 1,
    escapedBytes: 3,
    asciiEscapedBytes: 6,
  });
});

test('the summary keeps the longest vocab and special token for each unit, with its rank', () => {
  const summary = summarize({
    config: { version: 'v15' },
    vocab: [
      { rank: 0, token_bytes: b64('ab'), token_str: 'ab' },
      { rank: 1, token_bytes: b64('é'.repeat(3)), token_str: 'ééé' },
      { rank: 2, token_bytes: b64('-'.repeat(5)), token_str: '-----' },
    ],
    special_tokens: [{ rank: 0, token_str: '[/AVAILABLE_TOOLS]', is_control: true }],
  });
  expect(summary).toEqual({
    version: 'v15',
    vocabEntries: 3,
    specialTokens: 1,
    vocab: {
      bytes: { value: 6, rank: 1 },
      codeUnits: { value: 5, rank: 2 },
      escapedBytes: { value: 6, rank: 1 },
      asciiEscapedBytes: { value: 18, rank: 1 },
    },
    special: {
      bytes: { value: 18, rank: 0 },
      codeUnits: { value: 18, rank: 0 },
      escapedBytes: { value: 18, rank: 0 },
      asciiEscapedBytes: { value: 18, rank: 0 },
    },
  });
});

test('a file without a vocab list of token_bytes is refused', () => {
  expect(() => summarize([])).toThrow(/not a JSON object/);
  expect(() => summarize({ vocab: [] })).toThrow(/no vocab/);
  expect(() => summarize({ vocab: [{ rank: 0 }] })).toThrow(/token_bytes/);
  expect(() => summarize({ vocab: 'x' })).toThrow(/list of token records/);
});
