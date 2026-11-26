import { limit } from '../limits.js';
import { githubUrl, type AdvisoryTarget, type QueryKind } from './advisory-read.js';

/**
 * Approved batch values (C3, 2026-11-26): S1's Batched Lookup Amendment item 2 and the Batching
 * Reconciliation Amendment D2, and S2's tag existence query size.
 */
export const BATCH_MAX_TARGETS = limit('advisory.batch.maxTargets');
export const BATCH_PAGE_SIZE = String(limit('advisory.batch.pageSize'));
/** A batch's continuation URL over this cap is `budget`. */
export const BATCH_URL_BYTES = limit('advisory.batch.urlBytes');
/** A batch's first URL leaves room under the URL cap for GitHub's `after` cursor. */
export const BATCH_FIRST_URL_BYTES = BATCH_URL_BYTES - limit('advisory.batch.cursorHeadroomBytes');
export const TAG_QUERY_MAX_CANDIDATES = limit('upstream.tagExistence.maxCandidatesPerQuery');

/**
 * Items split in order into as few consecutive batches as `fits` allows, each of at most `max`.
 * An item `fits` rejects on its own can be in no batch, so it is returned as `unbatched`.
 */
export function splitBatches<T>(
  items: readonly T[],
  max: number,
  fits: (batch: readonly T[]) => boolean,
): { batches: T[][]; unbatched: T[] } {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('batch maximum must be positive');
  const batches: T[][] = [];
  const unbatched: T[] = [];
  let batch: T[] = [];
  for (const item of items) {
    if (!fits([item])) {
      unbatched.push(item);
      continue;
    }
    if (batch.length < max && fits([...batch, item])) {
      batch.push(item);
      continue;
    }
    batches.push(batch);
    batch = [item];
  }
  if (batch.length) batches.push(batch);
  return { batches, unbatched };
}

/** The first URL of one versioned advisory batch, at the approved batch page size. */
export function batchUrl(
  ecosystem: AdvisoryTarget['ecosystem'],
  affects: readonly string[],
  kind: QueryKind,
): string {
  return githubUrl(ecosystem, affects, kind, BATCH_PAGE_SIZE);
}

/**
 * Versioned `affects` values (`name@version`) split into advisory batches: each holds at most the
 * approved target count and has a first URL within the URL cap less the cursor headroom. A value
 * too long to fit alone is `unbatched`, left to its singleton query. `fits` replaces the URL check
 * only in tests, since on real targets the URL cap binds long before the target count.
 */
export function advisoryBatches(
  ecosystem: AdvisoryTarget['ecosystem'],
  affects: readonly string[],
  kind: QueryKind,
  fits: (batch: readonly string[]) => boolean = (batch) =>
    batchUrl(ecosystem, batch, kind).length <= BATCH_FIRST_URL_BYTES,
): { batches: string[][]; unbatched: string[] } {
  return splitBatches(affects, BATCH_MAX_TARGETS, fits);
}

/** Tag existence candidates split into GraphQL queries of at most the approved size. */
export function tagQueryBatches<T>(candidates: readonly T[]): T[][] {
  return splitBatches(candidates, TAG_QUERY_MAX_CANDIDATES, () => true).batches;
}
