import { describe, expect, test, vi } from 'vite-plus/test';
import type { EvidenceReason } from '../schema.js';
import {
  createUpstreamReader,
  upstreamGithubUrl,
  UpstreamFailure,
  type UpstreamLimits,
  type UpstreamLookup,
  type UpstreamReader,
} from './upstream-read.js';
import { forEachRelease } from './upstream-releases.js';

const limits: UpstreamLimits = {
  maxRequests: 500,
  maxPages: 100,
  maxTagCandidates: 5000,
  maxTagDepth: 5,
  maxResponseBytes: 50_000,
  maxTotalBytes: 5_000_000,
  maxJsonEntries: 50_000,
  maxJsonDepth: 32,
  maxWork: 1_000_000,
  maxRetainedBytes: 5_000_000,
  maxAttempts: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};

type FakeOptions = {
  total: number;
  /** Largest number of items one response may carry before it is reported as too large. */
  fits: number | ((start: number) => number);
  maxPages?: number;
  stopped?: EvidenceReason | null;
  /** Serves one item fewer than asked for, while still claiming another page. */
  short?: boolean;
};

function fakeReader({ total, fits, maxPages = 100, stopped = null, short = false }: FakeOptions) {
  const sizes: number[] = [];
  const reader: UpstreamReader = {
    limits: { ...limits, maxPages },
    read: async (target: unknown): Promise<UpstreamLookup> => {
      const { perPage, page } = target as { perPage: number; page: number };
      sizes.push(perPage);
      const start = (page - 1) * perPage;
      const count = Math.max(0, Math.min(perPage, total - start));
      const cap = typeof fits === 'number' ? fits : fits(start);
      if (count > cap)
        return { status: 'unavailable', fetched: true, url: null, data: null, reasons: ['budget'] };
      const served = short ? count - 1 : count;
      const items = Array.from({ length: served }, (_, i) => ({ id: start + i }));
      return {
        status: 'available',
        fetched: true,
        url: null,
        data: { items },
        reasons: [],
        nextPage: start + count < total,
      };
    },
    close: () => {},
    spend: () => {},
    stopped: () => stopped,
  };
  return { reader, sizes };
}

async function visitAll(reader: UpstreamReader) {
  const seen: { id: number }[] = [];
  await forEachRelease(reader, 'fixture/action', async (item) => {
    seen.push(item as { id: number });
  });
  return seen;
}

async function rejectionReason(promise: Promise<unknown>): Promise<EvidenceReason> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamFailure);
    return (error as UpstreamFailure).reason;
  }
  throw new Error('expected a rejection');
}

describe('forEachRelease', () => {
  test('reads every release in order when the first page fits', async () => {
    const { reader, sizes } = fakeReader({ total: 150, fits: 64 });
    const seen = await visitAll(reader);
    expect(seen.map((item) => item.id)).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(new Set(sizes)).toEqual(new Set([64]));
  });

  test('halves the page until it fits and keeps reading from the same release', async () => {
    const { reader, sizes } = fakeReader({ total: 150, fits: 20 });
    const seen = await visitAll(reader);
    const ids = seen.map((item) => item.id);
    expect(ids).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(new Set(ids).size).toBe(ids.length);
    expect(sizes.slice(0, 3)).toEqual([64, 32, 16]);
    expect(sizes.slice(2).every((size) => size === 16)).toBe(true);
  });

  test('halves mid-stream and keeps reading from the offset already reached', async () => {
    const { reader, sizes } = fakeReader({ total: 150, fits: (start) => (start < 64 ? 64 : 20) });
    const ids = (await visitAll(reader)).map((item) => item.id);
    expect(ids).toEqual(Array.from({ length: 150 }, (_, i) => i));
    expect(sizes.slice(0, 4)).toEqual([64, 64, 32, 16]);
  });

  test('a single release over the cap fails with budget', async () => {
    const { reader, sizes } = fakeReader({ total: 5, fits: 0 });
    expect(await rejectionReason(visitAll(reader))).toBe('budget');
    expect(sizes.at(-1)).toBe(1);
  });

  test('a stopped reader is not retried at a smaller size', async () => {
    const { reader, sizes } = fakeReader({ total: 150, fits: 0, stopped: 'budget' });
    expect(await rejectionReason(visitAll(reader))).toBe('budget');
    expect(sizes).toEqual([64]);
  });

  test('stops at the page limit', async () => {
    const { reader, sizes } = fakeReader({ total: 1000, fits: 64, maxPages: 3 });
    expect(await rejectionReason(visitAll(reader))).toBe('budget');
    expect(sizes).toEqual([64, 64, 64]);
  });

  test('a short page that claims more is a conflict', async () => {
    const { reader } = fakeReader({ total: 150, fits: 64, short: true });
    expect(await rejectionReason(visitAll(reader))).toBe('conflict');
  });
});

describe('releases request shape', () => {
  test('releases URLs carry the requested page size and page', () => {
    expect(
      upstreamGithubUrl({
        kind: 'github',
        repository: 'fixture/action',
        resource: 'releases',
        perPage: 16,
        page: 3,
      }),
    ).toMatch(/\/releases\?per_page=16&page=3$/u);
  });

  test('releases reads without a supported page size are unsupported and not sent', async () => {
    const fetch = vi.fn(async () => Response.json([]));
    const opened = createUpstreamReader(limits, { fetch, now: () => 0 });
    if (opened.kind !== 'ready') throw new Error('reader');
    const target = { kind: 'github', repository: 'fixture/action', resource: 'releases', page: 1 };
    for (const perPage of [100, 50, 25, 12]) {
      const result = await opened.reader.read({ ...target, perPage });
      expect(result).toMatchObject({ status: 'unavailable', reasons: ['unsupported'] });
    }
    expect(await opened.reader.read(target)).toMatchObject({
      status: 'unavailable',
      reasons: ['unsupported'],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
