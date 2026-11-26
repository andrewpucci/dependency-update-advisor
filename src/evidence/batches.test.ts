import { expect, test } from 'vite-plus/test';
import { limit } from '../limits.js';
import {
  BATCH_FIRST_URL_BYTES,
  advisoryBatches,
  batchUrl,
  splitBatches,
  tagQueryBatches,
} from './batches.js';

const names = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => `p${from + i}@1.0.0`);

/** An `affects` value padded so its batch URL alone is exactly `bytes` long. */
function exactly(bytes: number): string {
  const base = batchUrl('npm', ['x@1'], 'reviewed').length;
  return `${'x'.repeat(bytes - base + 1)}@1`;
}

test('a batch holds exactly the register maximum of targets, and one more starts another batch', () => {
  const max = limit('advisory.batch.maxTargets');
  const items = Array.from({ length: max + 1 }, (_, i) => i);
  const fitsAll = () => true;
  expect(splitBatches(items.slice(0, max), max, fitsAll).batches).toEqual([items.slice(0, max)]);
  expect(splitBatches(items, max, fitsAll).batches.map((batch) => batch.length)).toEqual([max, 1]);
});

test('a batch first URL of exactly the cap less the cursor headroom fits; one byte longer does not', () => {
  expect(BATCH_FIRST_URL_BYTES).toBe(
    limit('advisory.batch.urlBytes') - limit('advisory.batch.cursorHeadroomBytes'),
  );
  const fit = exactly(BATCH_FIRST_URL_BYTES);
  expect(batchUrl('npm', [fit], 'reviewed')).toHaveLength(BATCH_FIRST_URL_BYTES);
  expect(advisoryBatches('npm', [fit], 'reviewed')).toEqual({ batches: [[fit]], unbatched: [] });
  const over = exactly(BATCH_FIRST_URL_BYTES + 1);
  expect(advisoryBatches('npm', [over], 'reviewed')).toEqual({ batches: [], unbatched: [over] });
});

test('targets fill a batch up to the URL cap and the next target starts another', () => {
  const affects = names(400);
  const { batches, unbatched } = advisoryBatches('npm', affects, 'reviewed');
  expect(unbatched).toEqual([]);
  expect(batches.flat()).toEqual(affects);
  for (const [i, batch] of batches.entries()) {
    expect(batchUrl('npm', batch, 'reviewed').length).toBeLessThanOrEqual(BATCH_FIRST_URL_BYTES);
    const next = batches[i + 1]?.[0];
    if (next !== undefined)
      expect(batchUrl('npm', [...batch, next], 'reviewed').length).toBeGreaterThan(
        BATCH_FIRST_URL_BYTES,
      );
  }
  expect(batches.length).toBeGreaterThan(1);
});

test('a target too long to batch alone is left to its singleton and the others still batch', () => {
  const over = exactly(BATCH_FIRST_URL_BYTES + 1);
  const result = advisoryBatches('npm', ['a@1', over, 'b@2'], 'reviewed');
  expect(result).toEqual({ batches: [['a@1', 'b@2']], unbatched: [over] });
});

test('a batch URL asks for the register page size', () => {
  const url = new URL(batchUrl('npm', ['a@1'], 'reviewed'));
  expect(url.searchParams.get('per_page')).toBe(String(limit('advisory.batch.pageSize')));
});

test('a tag query holds exactly the register maximum of candidates, and one more starts another', () => {
  const max = limit('upstream.tagExistence.maxCandidatesPerQuery');
  const candidates = Array.from({ length: max + 1 }, (_, i) => ({ tag: `v${i}` }));
  expect(tagQueryBatches(candidates.slice(0, max))).toEqual([candidates.slice(0, max)]);
  expect(tagQueryBatches(candidates).map((query) => query.length)).toEqual([max, 1]);
  expect(tagQueryBatches([])).toEqual([]);
});
