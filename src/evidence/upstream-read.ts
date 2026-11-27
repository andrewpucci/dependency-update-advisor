import { createNpmRegistryReader } from './npm-registry.js';
import { copyAdvisoryData, AdvisoryFailure, type AdvisoryLimits } from './advisory-read.js';
import { freeze, isPlainObject, isEvidencePath } from './common.js';
import type { EvidenceReason, PackageSource } from '../schema.js';
import { BoundedClock, boundedGet } from './bounded-request.js';
import {
  GITHUB_API_ORIGIN,
  isGithubApi,
  waitForRetry,
  type GithubQuotaGuard,
} from './github-quota.js';
import type { ResearchCache } from './research-cache.js';
import { limit } from '../limits.js';
import { HTTP_STATUS } from '../format.js';
import { tagQueryBatches } from './batches.js';

/** Each halving of the register's release page size down to 1, for the page-size retry ladder. */
function halvingFrom(start: number): number[] {
  const sizes: number[] = [];
  for (let size = start; size >= 1; size = Math.floor(size / 2)) sizes.push(size);
  return sizes;
}
export const RELEASE_PAGE_SIZES: readonly number[] = Object.freeze(
  halvingFrom(limit('upstream.releasePageSize')),
);

export type UpstreamLimits = Readonly<{
  maxRequests: number;
  maxPages: number;
  maxTagCandidates: number;
  maxTagDepth: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxJsonEntries: number;
  maxJsonDepth: number;
  maxWork: number;
  maxRetainedBytes: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}>;
export type MetadataTarget = Readonly<{
  kind: 'npm' | 'pypi';
  name: string;
  version: string;
  source: PackageSource;
  integrity?: string;
}>;
export type GithubUpstreamTarget = Readonly<{
  kind: 'github';
  repository: string;
  resource:
    | 'repository'
    | 'ref'
    | 'tag'
    | 'commit'
    | 'release'
    | 'contents'
    | 'compare'
    | 'releases';
  ref?: string;
  sha?: string;
  path?: string;
  base?: string;
  head?: string;
  page?: number;
  perPage?: number;
}>;
export type UpstreamTarget = MetadataTarget | GithubUpstreamTarget;
export type UpstreamLookup = Readonly<{
  status: 'available' | 'unavailable';
  fetched: boolean;
  url: string | null;
  data: Readonly<Record<string, unknown>> | null;
  reasons: readonly EvidenceReason[];
  nextPage?: boolean;
}>;
/** One exact tag candidate for the batched existence query (S2 Batched Tag Existence Amendment). */
export type TagCandidate = Readonly<{ repository: string; tag: string }>;
/**
 * GraphQL's answer for one candidate. Only `absent` settles a candidate (as `missing`); `present`
 * and `unknown` both leave it to the REST probe, which alone proves a tag.
 */
export type TagExistence = 'absent' | 'present' | 'unknown';
/**
 * One candidate's answer, carried with the candidate it answers, so a caller pairs answers by
 * candidate and never by position.
 */
export type TagAnswer = Readonly<{ candidate: TagCandidate; answer: TagExistence }>;
/**
 * One research run's existence answers, keyed by repository and exact tag (amendment item 7). The
 * run creates it, its upstream readers share it, and it is discarded when the run ends.
 */
export type TagExistenceMap = Map<string, TagExistence>;
export type UpstreamReader = Readonly<{
  limits: UpstreamLimits;
  read: (target: unknown) => Promise<UpstreamLookup>;
  /**
   * Asks GitHub's GraphQL API whether each candidate's exact tag exists, in queries of at most the
   * approved size. Each answer names the candidate it answers; their order is not meaningful, and a
   * candidate with no answer is `unknown`. Sequential with `read`: a call while a read is in flight
   * answers every candidate `unknown`.
   */
  tagExistence?: (candidates: readonly TagCandidate[]) => Promise<readonly TagAnswer[]>;
  /** The run's existence map, when research gave this reader one. */
  existence?: TagExistenceMap;
  close: () => void;
  spend: (amount: number) => void;
  /** The reason this reader refuses all further reads, or null while it can still read. */
  stopped?: () => EvidenceReason | null;
  /**
   * Diagnostics: the cumulative limit whose exhaustion set a `budget` stop, such as `maxWork` or
   * `npm.maxRetainedBytes` for the nested registry reader, or null.
   */
  stopLimit?: () => string | null;
}>;
export type UpstreamDependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
  cache?: ResearchCache;
  /** The run's research GitHub quota guard; absent outside research. */
  quota?: GithubQuotaGuard;
  /**
   * Whether `fetch` adds the research token to GitHub API requests. GraphQL requires one, so
   * without it every tag existence answer is `unknown` and nothing is sent.
   */
  githubToken?: boolean;
  /** The run's existence map, exposed on the reader for the pre-pass and the ref probe. */
  existence?: TagExistenceMap;
};
export class UpstreamFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
export function upstreamFailureReason(error: unknown): EvidenceReason {
  return error instanceof UpstreamFailure || error instanceof AdvisoryFailure
    ? error.reason
    : 'malformed';
}
export function requireUpstream(
  value: unknown,
  reason: EvidenceReason = 'malformed',
): asserts value {
  if (!value) throw new UpstreamFailure(reason);
}
export function upstreamText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= limit('packet.identityBytes') &&
    !/[\p{Cc}\p{Cs}]/u.test(value)
  );
}
export function upstreamLimits(value: unknown): UpstreamLimits {
  requireUpstream(isPlainObject(value));
  const keys = [
    'maxRequests',
    'maxPages',
    'maxTagCandidates',
    'maxTagDepth',
    'maxResponseBytes',
    'maxTotalBytes',
    'maxJsonEntries',
    'maxJsonDepth',
    'maxWork',
    'maxRetainedBytes',
    'maxAttempts',
    'requestTimeoutMs',
    'totalTimeoutMs',
  ] as const;
  requireUpstream(keys.every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) > 0));
  requireUpstream(Number(value.maxResponseBytes) <= Number(value.maxTotalBytes));
  requireUpstream(Number(value.requestTimeoutMs) <= Number(value.totalTimeoutMs));
  return freeze(Object.fromEntries(keys.map((k) => [k, value[k]])) as UpstreamLimits);
}
export function upstreamCopy<T>(value: T, limits: UpstreamLimits, work = { entries: 0 }): T {
  return copyAdvisoryData(value, { ...limits, maxFindings: 1 } as AdvisoryLimits, work);
}
/** Whether a value copies once the entry cap is lifted, so the entry cap alone refused it. */
function entriesRefused(value: unknown, limits: UpstreamLimits): boolean {
  try {
    upstreamCopy(value, { ...limits, maxJsonEntries: Number.MAX_SAFE_INTEGER });
    return true;
  } catch {
    return false;
  }
}
function httpReason(response: Response, bytes: Buffer): EvidenceReason {
  let message = '';
  try {
    message = JSON.parse(bytes.toString('utf8')).message ?? '';
  } catch {
    /* Status still supplies a bounded failure. */
  }
  if (
    response.status === HTTP_STATUS.tooManyRequests ||
    (response.status === HTTP_STATUS.forbidden &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after') ||
        /secondary rate limit/iu.test(message)))
  )
    return 'rate_limit';
  if (
    response.status === HTTP_STATUS.unauthorized ||
    (response.status === HTTP_STATUS.forbidden &&
      /Resource not accessible by (?:integration|personal access token)/u.test(message))
  )
    return 'permission';
  if (response.status >= HTTP_STATUS.redirectMin && response.status < HTTP_STATUS.clientErrorMin)
    return 'unsupported';
  return response.status === HTTP_STATUS.notFound ? 'missing' : 'unknown';
}
function metadataTarget(value: unknown): MetadataTarget {
  requireUpstream(
    isPlainObject(value) && ['npm', 'pypi'].includes(String(value.kind)),
    'unsupported',
  );
  requireUpstream(upstreamText(value.name) && upstreamText(value.version), 'unsupported');
  requireUpstream(isPlainObject(value.source) && value.source.kind === 'registry', 'unsupported');
  requireUpstream(upstreamText(value.source.identity), 'unsupported');
  const url = new URL(value.source.identity);
  requireUpstream(
    url.origin === (value.kind === 'npm' ? 'https://registry.npmjs.org' : 'https://pypi.org') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'unsupported',
  );
  if (value.kind === 'npm') requireUpstream(upstreamText(value.integrity), 'missing');
  else {
    requireUpstream(['/simple', '/simple/'].includes(url.pathname), 'unsupported');
    requireUpstream(
      /^[a-z\d]+(?:-[a-z\d]+)*$/u.test(value.name) && !/[\s<>=~^*|/@]/u.test(value.version),
      'unsupported',
    );
  }
  return value as unknown as MetadataTarget;
}
function githubTarget(value: unknown): GithubUpstreamTarget {
  requireUpstream(isPlainObject(value) && value.kind === 'github', 'unsupported');
  requireUpstream(
    upstreamText(value.repository) && /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/iu.test(value.repository),
    'unsupported',
  );
  requireUpstream(!['.', '..'].includes(value.repository.split('/')[1]), 'unsupported');
  requireUpstream(
    ['repository', 'ref', 'tag', 'commit', 'release', 'contents', 'compare', 'releases'].includes(
      String(value.resource),
    ),
    'unsupported',
  );
  if (['ref', 'release'].includes(String(value.resource)))
    requireUpstream(upstreamText(value.ref) && isEvidencePath(value.ref), 'unsupported');
  if (value.resource === 'ref')
    requireUpstream(/^(?:tags|heads)\/.+/u.test(String(value.ref)), 'unsupported');
  if (['tag', 'commit', 'contents'].includes(String(value.resource)))
    requireUpstream(
      typeof value.sha === 'string' && /^[a-f\d]{40}$/u.test(value.sha),
      'unsupported',
    );
  if (value.resource === 'contents') requireUpstream(isEvidencePath(value.path), 'unsupported');
  if (value.resource === 'compare')
    requireUpstream(
      [value.base, value.head].every(
        (sha) => typeof sha === 'string' && /^[a-f\d]{40}$/u.test(sha),
      ),
      'unsupported',
    );
  if (['compare', 'releases'].includes(String(value.resource)))
    requireUpstream(Number.isSafeInteger(value.page) && Number(value.page) > 0, 'unsupported');
  if (value.resource === 'releases')
    requireUpstream(
      (RELEASE_PAGE_SIZES as readonly unknown[]).includes(value.perPage),
      'unsupported',
    );
  return value as unknown as GithubUpstreamTarget;
}
function githubNext(link: string | null, original: string) {
  if (!link || !/rel="next"/u.test(link)) return false;
  const matches = [...link.matchAll(/<([^>]+)>;\s*rel="next"/gu)];
  requireUpstream(matches.length === 1, 'conflict');
  const next = new URL(matches[0][1]),
    expected = new URL(original);
  expected.searchParams.set('page', String(Number(expected.searchParams.get('page')) + 1));
  next.searchParams.sort();
  expected.searchParams.sort();
  requireUpstream(next.href === expected.href, 'conflict');
  return true;
}
export function upstreamGithubUrl(t: GithubUpstreamTarget) {
  const base = GITHUB_API_ORIGIN + '/repos/' + t.repository;
  switch (t.resource) {
    case 'repository':
      return base;
    case 'ref':
      return base + '/git/ref/' + t.ref!.split('/').map(encodeURIComponent).join('/');
    case 'tag':
      return base + '/git/tags/' + t.sha;
    case 'commit':
      return base + '/commits/' + t.sha;
    case 'release':
      return base + '/releases/tags/' + encodeURIComponent(t.ref!);
    case 'contents':
      return (
        base + '/contents/' + t.path!.split('/').map(encodeURIComponent).join('/') + '?ref=' + t.sha
      );
    case 'compare':
      return base + '/compare/' + t.base + '...' + t.head + '?per_page=100&page=' + t.page;
    case 'releases':
      return base + '/releases?per_page=' + t.perPage + '&page=' + t.page;
  }
}
/** The one GraphQL route: tag existence queries only (amendment item 8). */
export const GITHUB_GRAPHQL_URL = GITHUB_API_ORIGIN + '/graphql';
/**
 * The fixed existence query for `count` candidates. Its text depends on the count alone: every
 * owner, name, and tag is a variable (amendment item 1), so no candidate value enters the text.
 */
export function tagExistenceQuery(count: number): string {
  const params: string[] = [];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    params.push(`$o${i}: String!, $n${i}: String!, $q${i}: String!`);
    fields.push(
      `c${i}: repository(owner: $o${i}, name: $n${i}) ` +
        `{ nameWithOwner ref(qualifiedName: $q${i}) { target { oid } } }`,
    );
  }
  return `query(${params.join(', ')}) { ${fields.join(' ')} rateLimit { cost } }`;
}
/** The variables for one query's candidates, in alias order. */
export function tagExistenceVariables(batch: readonly TagCandidate[]): Record<string, string> {
  const variables: Record<string, string> = {};
  batch.forEach((c, i) => {
    const [owner, name] = c.repository.split('/');
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    variables[`q${i}`] = 'refs/tags/' + c.tag;
  });
  return variables;
}
/** A candidate the REST ref probe could also ask about; anything else is never sent. */
function tagCandidate(value: unknown): value is TagCandidate {
  if (!isPlainObject(value)) return false;
  try {
    githubTarget({
      kind: 'github',
      repository: value.repository,
      resource: 'ref',
      ref: 'tags/' + String(value.tag),
    });
    return isEvidencePath(value.tag);
  } catch {
    return false;
  }
}
/** One alias's answer: absent only for a resolved, same-named repository with a null ref (item 2). */
function aliasExistence(value: unknown, repository: string): TagExistence {
  if (!isPlainObject(value) || typeof value.nameWithOwner !== 'string') return 'unknown';
  // A name that differs beyond case is a rename, which REST would redirect (item 4).
  if (value.nameWithOwner.toLowerCase() !== repository.toLowerCase()) return 'unknown';
  if (value.ref === null) return 'absent';
  return isPlainObject(value.ref) ? 'present' : 'unknown';
}
/**
 * Each candidate's answer in one GraphQL response, in alias order. An error naming an alias makes
 * that alias `unknown`; an error without a path, or no `data` object, makes every alias `unknown`
 * (item 4).
 */
export function tagExistenceAnswers(
  response: unknown,
  batch: readonly TagCandidate[],
): TagExistence[] {
  const unknown = batch.map((): TagExistence => 'unknown');
  if (!isPlainObject(response) || !isPlainObject(response.data)) return unknown;
  // Only an absent `errors` means no errors; `null` or any non-array is not an answer.
  const errors = response.errors === undefined ? [] : response.errors;
  if (!Array.isArray(errors)) return unknown;
  const named = new Set<string>();
  for (const error of errors) {
    const path: unknown[] = isPlainObject(error) && Array.isArray(error.path) ? error.path : [];
    if (typeof path[0] !== 'string') return unknown;
    named.add(path[0]);
  }
  const data = response.data;
  return batch.map((c, i) => {
    const alias = 'c' + i;
    return named.has(alias) || !Object.hasOwn(data, alias)
      ? 'unknown'
      : aliasExistence(data[alias], c.repository);
  });
}
/** Whether a 200 GraphQL response reports its own primary limit spent. */
function graphqlPrimaryError(response: unknown): boolean {
  return (
    isPlainObject(response) &&
    Array.isArray(response.errors) &&
    response.errors.some((e) => isPlainObject(e) && e.type === 'RATE_LIMITED')
  );
}
/**
 * Whether a rate-limited GraphQL refusal is GraphQL's own primary limit: its spent `graphql`
 * counter, with no retry time or secondary-limit message. Anything else is a secondary limit,
 * shared with REST (item 5).
 */
function graphqlPrimaryRefusal(response: Response, bytes: Buffer): boolean {
  return (
    response.headers.get('x-ratelimit-resource') === 'graphql' &&
    response.headers.get('x-ratelimit-remaining') === '0' &&
    !response.headers.has('retry-after') &&
    !/secondary rate limit/iu.test(bytes.toString('utf8'))
  );
}
function targetUrl(t: UpstreamTarget) {
  if (t.kind === 'github') return upstreamGithubUrl(t);
  const identity = encodeURIComponent(t.name) + '/' + encodeURIComponent(t.version);
  return t.kind === 'npm'
    ? 'https://registry.npmjs.org/' + identity
    : 'https://pypi.org/pypi/' + identity + '/json';
}
class Reader {
  private requests = 0;
  private bytes = 0;
  private work = { entries: 0 };
  private readonly clock: BoundedClock;
  private closed = false;
  private busy = false;
  private stopped: EvidenceReason | null = null;
  private stoppedBy: string | null = null;
  private networkReason: EvidenceReason | null = null;
  private readonly controller = new AbortController();
  private active: (() => void) | null = null;
  private readonly blocked = new Set<string>();
  /** The last rate-limited response this attempt received, for its retry time; never a block. */
  private rateLimited: Response | null = null;
  private waits = 0;
  private readonly cache = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly cacheSizes = new Map<string, number>();
  private readonly failures = new Map<string, EvidenceReason>();
  private readonly npmRetained = new Set<string>();
  private retained = 0;
  private effort = 0;
  private readonly nextPages = new Map<string, boolean>();
  private pages = 0;
  /** GraphQL's own primary limit is spent: later existence queries answer `unknown` unsent. */
  private graphqlSpent = false;
  private readonly npm: ReturnType<typeof createNpmRegistryReader>;
  /** Responses served from the run cache; a hit is a read for attempt outcomes, not a charge. */
  private hits = 0;
  private readonly deps: UpstreamDependencies;
  constructor(
    readonly limits: UpstreamLimits,
    deps: UpstreamDependencies,
  ) {
    const cache = deps.cache && this.countingHits(deps.cache);
    this.deps = { ...deps, cache };
    this.clock = new BoundedClock(limits.totalTimeoutMs, deps);
    // The nested registry reader shares the cache so an npm hit reaches neither reader's charge.
    this.npm = createNpmRegistryReader(limits, {
      now: deps.now,
      signal: this.controller.signal,
      fetch: (url, init) => this.fetchBounded(url, init),
      cache,
    });
    requireUpstream(this.npm.kind === 'ready');
  }
  private countingHits(cache: ResearchCache): ResearchCache {
    return {
      key: (method, url, headers) => cache.key(method, url, headers),
      lookup: (key) => {
        const hit = cache.lookup(key);
        if (hit) this.hits++;
        return hit;
      },
      store: (key, response) => cache.store(key, response),
    };
  }
  /** Live requests plus cache hits: whether a lookup read anything. */
  private get reads() {
    return this.requests + this.hits;
  }
  /** Upstream's own stop, or its nested registry reader's, which shares upstream's limits. */
  stopReason() {
    return this.stopped ?? (this.npm.kind === 'ready' ? this.npm.stopped() : null);
  }
  stopLimit(): string | null {
    if (this.stopped) return this.stopped === 'budget' ? this.stoppedBy : null;
    return this.npm.kind === 'ready' && this.npm.stopped() === 'budget'
      ? 'npm.' + this.npm.stopLimit()
      : null;
  }
  /** A cumulative limit ran out: every later read is refused with `budget`. */
  private exhaust(limit: keyof UpstreamLimits) {
    this.stopped = 'budget';
    this.stoppedBy = limit;
  }
  close() {
    this.closed = true;
    this.active?.();
    this.controller.abort();
    this.cache.clear();
    this.cacheSizes.clear();
    this.failures.clear();
    this.npmRetained.clear();
    this.nextPages.clear();
  }
  spend(amount: number) {
    requireUpstream(Number.isSafeInteger(amount) && amount >= 0);
    if (amount > this.limits.maxWork - this.effort) this.exhaust('maxWork');
    requireUpstream(!this.stopped, this.stopped ?? 'budget');
    this.effort += amount;
  }
  private copy<T>(value: T): T {
    const before = this.work.entries;
    try {
      return upstreamCopy(value, this.limits, this.work);
    } catch (error) {
      // The entry count is cumulative across this reader's reads, and a refused copy has already
      // counted its entries, so once the entry cap refuses a value (too many entries alone, or the
      // cap used up by earlier reads) every later copy fails too. That is a stop, as the
      // register's effect says, named on the read that ran out. Depth and string-size failures
      // fail only their own read.
      if (upstreamFailureReason(error) === 'budget' && entriesRefused(value, this.limits))
        this.exhaust('maxJsonEntries');
      throw error;
    } finally {
      this.spend(this.work.entries - before);
    }
  }
  private reserve(bytes: number) {
    if (bytes > this.limits.maxRetainedBytes - this.retained) this.exhaust('maxRetainedBytes');
    requireUpstream(!this.stopped, this.stopped ?? 'budget');
    this.retained += bytes;
  }
  private cached(url: string) {
    const cached = this.cache.get(url);
    if (cached) this.spend(this.cacheSizes.get(url)!);
    return cached;
  }
  private remember(url: string, data: Readonly<Record<string, unknown>>) {
    const size = Buffer.byteLength(url) + Buffer.byteLength(JSON.stringify(data));
    this.reserve(size);
    this.cacheSizes.set(url, size);
    this.cache.set(url, freeze(data));
  }
  private remaining() {
    requireUpstream(!this.closed && !this.deps.signal?.aborted, 'unknown');
    requireUpstream(!this.stopped, this.stopped ?? 'unknown');
    try {
      return this.clock.remaining(this.stopped);
    } catch (error) {
      const reason = upstreamFailureReason(error);
      if (reason === 'timeout') this.stopped = reason;
      throw new UpstreamFailure(reason);
    }
  }
  private dispatch(url: string) {
    this.remaining();
    requireUpstream(!this.blocked.has(new URL(url).origin), 'rate_limit');
    requireUpstream(!this.stopped, this.stopped ?? 'budget');
  }
  private charge() {
    if (this.requests >= this.limits.maxRequests) this.exhaust('maxRequests');
    requireUpstream(!this.stopped, this.stopped ?? 'budget');
    this.requests++;
  }
  private async body(response: Response, aborted: Promise<never>, cached: boolean) {
    requireUpstream(response.body);
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) return Buffer.concat(chunks, size);
        size += chunk.value.byteLength;
        // A cached response was charged to the reader that fetched it.
        if (!cached) this.bytes += chunk.value.byteLength;
        if (this.bytes > this.limits.maxTotalBytes) this.exhaust('maxTotalBytes');
        requireUpstream(!this.stopped && size <= this.limits.maxResponseBytes, 'budget');
        this.remaining();
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof UpstreamFailure || error instanceof AdvisoryFailure) throw error;
      throw new UpstreamFailure(size ? 'truncated' : 'unknown');
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async fetchBounded(url: string, init: RequestInit): Promise<Response> {
    for (;;) {
      try {
        return await this.fetchOnce(url, init);
      } catch (error) {
        if (!(await this.waitedForRetry(url, error))) {
          this.networkReason = upstreamFailureReason(error);
          throw error;
        }
      }
    }
  }
  /**
   * After a rate-limited GitHub response, waits once for its retry time when that fits and unblocks
   * GitHub for the resend. Otherwise records the retry time of the stop and reports no wait.
   */
  private async waitedForRetry(url: string, error: unknown): Promise<boolean> {
    const quota = this.deps.quota;
    const response = this.rateLimited;
    const origin = new URL(url).origin;
    if (!quota || !response || upstreamFailureReason(error) !== 'rate_limit') return false;
    if (!isGithubApi(url)) return false;
    const retryAt = quota.retryAt(response);
    const fits =
      this.waits < limit('research.githubQuota.waitsPerReader') &&
      (await waitForRetry(quota, retryAt, {
        remainingMs: this.timeLeft(),
        requestTimeoutMs: this.limits.requestTimeoutMs,
        signal: AbortSignal.any(
          [this.controller.signal, this.deps.signal].filter((s): s is AbortSignal => !!s),
        ),
      }).catch(() => {
        throw new UpstreamFailure('unknown');
      }));
    if (!fits) {
      quota.recordStop(retryAt);
      return false;
    }
    this.waits += 1;
    this.blocked.delete(origin);
    return true;
  }
  /** The reader's time left, or 0 once it has run out; never stops the reader by itself. */
  private timeLeft(): number {
    try {
      return this.clock.remaining(null);
    } catch {
      return 0;
    }
  }
  private limitedBy(url: string, response: Response) {
    this.blocked.add(new URL(url).origin);
    this.rateLimited = response;
  }
  private async fetchOnce(url: string, init: RequestInit): Promise<Response> {
    this.rateLimited = null;
    this.dispatch(url);
    return await boundedGet(
      this.deps,
      {
        url,
        accept: 'application/json',
        timeoutMs: Math.min(this.remaining(), this.limits.requestTimeoutMs),
        signal: init.signal ?? undefined,
        charge: () => this.charge(),
      },
      (cancel) => {
        this.active = cancel;
      },
      async (response, aborted, cached) => {
        requireUpstream(
          !response.redirected && (!response.url || response.url === url),
          'unsupported',
        );
        const immediate = httpReason(response, Buffer.alloc(0));
        if (response.status !== HTTP_STATUS.ok && immediate !== 'unknown') {
          if (immediate === 'rate_limit') this.limitedBy(url, response);
          throw new UpstreamFailure(immediate);
        }
        const bytes = response.body ? await this.body(response, aborted, cached) : Buffer.alloc(0);
        if (response.status !== HTTP_STATUS.ok) {
          const reason = httpReason(response, bytes);
          if (reason === 'rate_limit') this.limitedBy(url, response);
          throw new UpstreamFailure(reason);
        }
        requireUpstream(
          /^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/iu.test(
            response.headers.get('content-type') ?? '',
          ),
          'unsupported',
        );
        this.remaining();
        return new Response(bytes, { status: HTTP_STATUS.ok, headers: response.headers });
      },
    );
  }
  private async pypi(t: MetadataTarget, url: string) {
    const cached = this.cached(url);
    if (cached) return cached;
    const response = await this.fetchBounded(url, {});
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()),
    );
    const data = this.copy(parsed);
    requireUpstream(isPlainObject(data) && isPlainObject(data.info));
    const info = data.info;
    requireUpstream(
      typeof info.name === 'string' &&
        info.name.toLowerCase().replace(/[-_.]+/gu, '-') === t.name &&
        info.version === t.version,
      'conflict',
    );
    this.remember(url, info);
    return info;
  }
  private async npmData(t: MetadataTarget, url: string) {
    requireUpstream(this.npm.kind === 'ready');
    const result = await this.npm.read(t);
    if (result.kind === 'unavailable')
      throw new UpstreamFailure(this.networkReason ?? result.reason);
    const data = this.copy(result.document.data);
    if (!this.npmRetained.has(url)) {
      this.reserve(Buffer.byteLength(url) + Buffer.byteLength(JSON.stringify(data)));
      this.npmRetained.add(url);
    }
    return data;
  }
  private async githubData(t: GithubUpstreamTarget, url: string) {
    const cached = t.resource === 'ref' ? null : this.cached(url);
    if (cached) return cached;
    if (t.page !== undefined) requireUpstream(++this.pages <= this.limits.maxPages, 'budget');
    const response = await this.fetchBounded(url, {});
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()),
    );
    const data = this.copy(Array.isArray(parsed) ? { items: parsed } : parsed);
    requireUpstream(isPlainObject(data));
    this.nextPages.set(url, githubNext(response.headers.get('link'), url));
    if (t.resource !== 'ref') this.remember(url, data);
    return data;
  }
  private async targetData(t: UpstreamTarget, url: string) {
    if (t.kind === 'github') return this.githubData(t, url);
    return t.kind === 'npm' ? this.npmData(t, url) : this.pypi(t, url);
  }
  private failedLookup(
    error: unknown,
    before: number,
    url: string | null,
    key: string | null,
  ): UpstreamLookup {
    let reason = upstreamFailureReason(error);
    if (key && !this.failures.has(key) && this.reads > before) {
      try {
        this.reserve(Buffer.byteLength(key) + Buffer.byteLength(reason));
        this.failures.set(key, reason);
      } catch {
        reason = 'budget';
      }
    }
    return freeze({
      status: 'unavailable',
      fetched: this.reads > before,
      url,
      data: null,
      reasons: [reason],
    });
  }
  /**
   * One existence query, sent with neither the research cache nor the quota guard: GraphQL
   * answers never go through the shared cache (item 7), and GraphQL draws on its own budget, not
   * the REST quota the guard keeps. It counts one request and its bytes against this reader's
   * share. A secondary limit gets REST's single wait and resend. Any failure answers every
   * candidate `unknown`.
   */
  private async tagQuery(batch: readonly TagCandidate[]): Promise<TagExistence[]> {
    const unknown = batch.map((): TagExistence => 'unknown');
    if (this.graphqlSpent) return unknown;
    try {
      for (;;) {
        try {
          const parsed = await this.graphqlSend(batch);
          if (graphqlPrimaryError(parsed)) this.graphqlSpent = true;
          return tagExistenceAnswers(parsed, batch);
        } catch (error) {
          if (!(await this.waitedForRetry(GITHUB_GRAPHQL_URL, error))) throw error;
        }
      }
    } catch {
      return unknown;
    }
  }
  private async graphqlSend(batch: readonly TagCandidate[]): Promise<unknown> {
    this.rateLimited = null;
    this.dispatch(GITHUB_GRAPHQL_URL);
    const { fetch, now, signal } = this.deps;
    return await boundedGet(
      { fetch, now, ...(signal ? { signal } : {}) },
      {
        url: GITHUB_GRAPHQL_URL,
        accept: 'application/json',
        json: {
          query: tagExistenceQuery(batch.length),
          variables: tagExistenceVariables(batch),
        },
        timeoutMs: Math.min(this.remaining(), this.limits.requestTimeoutMs),
        charge: () => this.charge(),
      },
      (cancel) => {
        this.active = cancel;
      },
      (response, aborted) => this.graphqlResponse(response, aborted),
    );
  }
  private async graphqlResponse(response: Response, aborted: Promise<never>): Promise<unknown> {
    requireUpstream(
      !response.redirected && (!response.url || response.url === GITHUB_GRAPHQL_URL),
      'unsupported',
    );
    if (response.status !== HTTP_STATUS.ok) {
      let bytes = Buffer.alloc(0);
      try {
        if (response.body) bytes = await this.body(response, aborted, false);
      } catch {
        /* The status and headers still classify a refusal. */
      }
      throw new UpstreamFailure(this.graphqlRefused(response, bytes));
    }
    requireUpstream(
      /^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/iu.test(
        response.headers.get('content-type') ?? '',
      ),
      'unsupported',
    );
    const bytes = response.body ? await this.body(response, aborted, false) : Buffer.alloc(0);
    this.remaining();
    return this.copy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }
  /**
   * A rate-limited refusal: GraphQL's primary limit stops only later existence queries; a
   * secondary limit blocks the origin as a REST rate limit does and is `rate_limit`, which the
   * caller's wait may lift. Every other refusal is `unknown`.
   */
  private graphqlRefused(response: Response, bytes: Buffer): EvidenceReason {
    if (httpReason(response, bytes) !== 'rate_limit') return 'unknown';
    if (graphqlPrimaryRefusal(response, bytes)) {
      this.graphqlSpent = true;
      return 'unknown';
    }
    this.limitedBy(GITHUB_GRAPHQL_URL, response);
    return 'rate_limit';
  }
  async tagExistence(value: unknown): Promise<readonly TagAnswer[]> {
    const candidates: unknown[] = Array.isArray(value) ? value : [];
    // Each distinct candidate is asked once and answered once; duplicates share its answer.
    const unique = new Map<string, { candidate: TagCandidate; answer: TagExistence }>();
    for (const c of candidates) {
      if (!tagCandidate(c)) continue;
      const key = JSON.stringify([c.repository, c.tag]);
      if (!unique.has(key))
        unique.set(key, { candidate: { repository: c.repository, tag: c.tag }, answer: 'unknown' });
    }
    const answers = (): readonly TagAnswer[] =>
      freeze([...unique.values()].map((entry) => ({ ...entry })));
    if (!this.deps.githubToken || this.busy) return answers();
    this.busy = true;
    try {
      for (const batch of tagQueryBatches([...unique.values()])) {
        const result = await this.tagQuery(batch.map((entry) => entry.candidate));
        batch.forEach((entry, j) => {
          entry.answer = result[j] ?? 'unknown';
        });
      }
    } finally {
      this.busy = false;
    }
    return answers();
  }
  async read(value: unknown): Promise<UpstreamLookup> {
    const before = this.reads;
    let url: string | null = null;
    let key: string | null = null;
    if (this.busy)
      return { status: 'unavailable', fetched: false, url, data: null, reasons: ['conflict'] };
    this.busy = true;
    this.networkReason = null;
    try {
      this.remaining();
      const copied = this.copy(value);
      const t =
        isPlainObject(copied) && copied.kind === 'github'
          ? githubTarget(copied)
          : metadataTarget(copied);
      url = targetUrl(t);
      requireUpstream(!this.blocked.has(new URL(url).origin), 'rate_limit');
      if (t.kind !== 'github' || t.resource !== 'ref')
        key = JSON.stringify([url, t.kind === 'npm' ? t.integrity : null]);
      if (key && this.failures.has(key)) throw new UpstreamFailure(this.failures.get(key)!);
      const data = await this.targetData(t, url);
      return freeze({
        status: 'available',
        fetched: this.reads > before,
        url,
        data,
        reasons: [],
        nextPage: this.nextPages.get(url) ?? false,
      });
    } catch (error) {
      return this.failedLookup(error, before, url, key);
    } finally {
      this.busy = false;
    }
  }
}
/** One attempt owns all nested registry requests and streamed bytes; no credentials enter this reader. */
export function createUpstreamReader(
  value: unknown,
  deps: UpstreamDependencies,
): { kind: 'invalid' } | { kind: 'ready'; reader: UpstreamReader } {
  try {
    const limits = upstreamLimits(value),
      reader = new Reader(limits, deps);
    return {
      kind: 'ready',
      reader: Object.freeze({
        limits,
        read: (t: unknown) => reader.read(t),
        tagExistence: (candidates: readonly TagCandidate[]) => reader.tagExistence(candidates),
        close: () => reader.close(),
        spend: (amount: number) => reader.spend(amount),
        stopped: () => reader.stopReason(),
        stopLimit: () => reader.stopLimit(),
        ...(deps.existence ? { existence: deps.existence } : {}),
      }),
    };
  } catch {
    return { kind: 'invalid' };
  }
}
