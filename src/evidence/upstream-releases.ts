import { RELEASE_PAGE_SIZES, requireUpstream, type UpstreamReader } from './upstream-read.js';

/**
 * Visits a repository's releases in order, in pages that fit the per-response cap (coverage §1.6).
 * Sizes are powers of two, so a smaller page always starts on a boundary already read.
 */
export async function forEachRelease(
  reader: UpstreamReader,
  repository: string,
  visit: (item: unknown) => Promise<void>,
): Promise<void> {
  let perPage: number = RELEASE_PAGE_SIZES[0];
  let offset = 0;
  let requests = 0;
  for (;;) {
    requireUpstream(++requests <= reader.limits.maxPages, 'budget');
    const lookup = await reader.read({
      kind: 'github',
      repository,
      resource: 'releases',
      page: offset / perPage + 1,
      perPage,
    });
    const tooLarge = lookup.status === 'unavailable' && lookup.reasons[0] === 'budget';
    if (tooLarge && perPage > 1 && (reader.stopped?.() ?? null) === null) {
      perPage /= 2;
      continue;
    }
    requireUpstream(lookup.status === 'available' && lookup.data, lookup.reasons[0] ?? 'unknown');
    requireUpstream(Array.isArray(lookup.data.items));
    for (const item of lookup.data.items) await visit(item);
    offset += lookup.data.items.length;
    if (!lookup.nextPage) return;
    requireUpstream(lookup.data.items.length === perPage, 'conflict');
  }
}
