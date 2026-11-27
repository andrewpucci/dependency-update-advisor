import {
  RELEASE_PAGE_SIZES,
  requireUpstream,
  type GithubUpstreamTarget,
  type UpstreamReader,
} from './upstream-read.js';

/** One page a page-size ladder read: its parsed body and the offset of its first item. */
export type LadderPage = Readonly<{ data: Readonly<Record<string, unknown>>; offset: number }>;

/**
 * Reads a paged GitHub resource in order, in pages that fit the per-response cap (coverage §1.6).
 * A page refused with `budget` while the reader can still read is too large for the cap, so it is
 * retried at the next smaller size in `sizes` whose page boundary falls on the offset already
 * reached; `sizes` ends at 1, which always does. Every read, retries included, counts against
 * `maxPages` and is charged by the reader as an ordinary request. `visit` checks one page and
 * returns how many items it held; a page that claims a next page must hold exactly `perPage`.
 */
export async function forEachLadderPage(
  reader: UpstreamReader,
  sizes: readonly number[],
  target: (page: number, perPage: number) => GithubUpstreamTarget,
  visit: (page: LadderPage) => Promise<number>,
): Promise<void> {
  let perPage = sizes[0];
  let offset = 0;
  let requests = 0;
  for (;;) {
    requireUpstream(++requests <= reader.limits.maxPages, 'budget');
    const lookup = await reader.read(target(offset / perPage + 1, perPage));
    const tooLarge = lookup.status === 'unavailable' && lookup.reasons[0] === 'budget';
    const smaller = sizes.find((size) => size < perPage && offset % size === 0);
    if (tooLarge && smaller !== undefined && (reader.stopped?.() ?? null) === null) {
      perPage = smaller;
      continue;
    }
    requireUpstream(lookup.status === 'available' && lookup.data, lookup.reasons[0] ?? 'unknown');
    const count = await visit({ data: lookup.data, offset });
    offset += count;
    if (!lookup.nextPage) return;
    requireUpstream(count === perPage, 'conflict');
  }
}

/**
 * Visits a repository's releases in order. Release sizes are powers of two, so each halving
 * starts on a boundary already read.
 */
export async function forEachRelease(
  reader: UpstreamReader,
  repository: string,
  visit: (item: unknown) => Promise<void>,
): Promise<void> {
  await forEachLadderPage(
    reader,
    RELEASE_PAGE_SIZES,
    (page, perPage) => ({ kind: 'github', repository, resource: 'releases', page, perPage }),
    async ({ data }) => {
      requireUpstream(Array.isArray(data.items));
      for (const item of data.items) await visit(item);
      return data.items.length;
    },
  );
}
