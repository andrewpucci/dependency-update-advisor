import { createNpmRegistryReader } from './npm-registry.js';
import { copyAdvisoryData, AdvisoryFailure, type AdvisoryLimits } from './advisory-read.js';
import { freeze, isPlainObject, isEvidencePath } from './common.js';
import type { EvidenceReason, PackageSource } from '../schema.js';
import { BoundedClock, boundedGet } from './bounded-request.js';

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
export type UpstreamReader = Readonly<{
  limits: UpstreamLimits;
  read: (target: unknown) => Promise<UpstreamLookup>;
  close: () => void;
  spend: (amount: number) => void;
}>;
export type UpstreamDependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
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
    Buffer.byteLength(value) <= 1024 &&
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
function httpReason(response: Response, bytes: Buffer): EvidenceReason {
  let message = '';
  try {
    message = JSON.parse(bytes.toString('utf8')).message ?? '';
  } catch {
    /* Status still supplies a bounded failure. */
  }
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after') ||
        /secondary rate limit/iu.test(message)))
  )
    return 'rate_limit';
  if (
    response.status === 401 ||
    (response.status === 403 &&
      /Resource not accessible by (?:integration|personal access token)/u.test(message))
  )
    return 'permission';
  if (response.status >= 300 && response.status < 400) return 'unsupported';
  return response.status === 404 ? 'missing' : 'unknown';
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
  const base = 'https://api.github.com/repos/' + t.repository;
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
      return base + '/releases?per_page=100&page=' + t.page;
  }
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
  private networkReason: EvidenceReason | null = null;
  private readonly controller = new AbortController();
  private active: (() => void) | null = null;
  private readonly blocked = new Set<string>();
  private readonly cache = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly cacheSizes = new Map<string, number>();
  private readonly failures = new Map<string, EvidenceReason>();
  private readonly npmRetained = new Set<string>();
  private retained = 0;
  private effort = 0;
  private readonly nextPages = new Map<string, boolean>();
  private pages = 0;
  private readonly npm: ReturnType<typeof createNpmRegistryReader>;
  constructor(
    readonly limits: UpstreamLimits,
    private readonly deps: UpstreamDependencies,
  ) {
    this.clock = new BoundedClock(limits.totalTimeoutMs, deps);
    this.npm = createNpmRegistryReader(limits, {
      now: deps.now,
      signal: this.controller.signal,
      fetch: (url, init) => this.fetchBounded(url, init),
    });
    requireUpstream(this.npm.kind === 'ready');
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
    if (amount > this.limits.maxWork - this.effort) this.stopped = 'budget';
    requireUpstream(!this.stopped, this.stopped ?? 'budget');
    this.effort += amount;
  }
  private copy<T>(value: T): T {
    const before = this.work.entries;
    try {
      return upstreamCopy(value, this.limits, this.work);
    } finally {
      this.spend(this.work.entries - before);
    }
  }
  private reserve(bytes: number) {
    if (bytes > this.limits.maxRetainedBytes - this.retained) this.stopped = 'budget';
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
    if (this.requests >= this.limits.maxRequests) this.stopped = 'budget';
    requireUpstream(!this.stopped, this.stopped ?? 'budget');
    this.requests++;
  }
  private async body(response: Response, aborted: Promise<never>) {
    requireUpstream(response.body);
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) return Buffer.concat(chunks, size);
        size += chunk.value.byteLength;
        this.bytes += chunk.value.byteLength;
        if (this.bytes > this.limits.maxTotalBytes) this.stopped = 'budget';
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
  private async fetchBounded(url: string, _init: RequestInit): Promise<Response> {
    this.dispatch(url);
    try {
      return await boundedGet(
        this.deps,
        {
          url,
          accept: 'application/json',
          timeoutMs: Math.min(this.remaining(), this.limits.requestTimeoutMs),
        },
        (cancel) => {
          this.active = cancel;
        },
        async (response, aborted) => {
          requireUpstream(
            !response.redirected && (!response.url || response.url === url),
            'unsupported',
          );
          const immediate = httpReason(response, Buffer.alloc(0));
          if (response.status !== 200 && immediate !== 'unknown') {
            if (immediate === 'rate_limit') this.blocked.add(new URL(url).origin);
            throw new UpstreamFailure(immediate);
          }
          const bytes = response.body ? await this.body(response, aborted) : Buffer.alloc(0);
          if (response.status !== 200) {
            const reason = httpReason(response, bytes);
            if (reason === 'rate_limit') this.blocked.add(new URL(url).origin);
            throw new UpstreamFailure(reason);
          }
          requireUpstream(
            /^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/iu.test(
              response.headers.get('content-type') ?? '',
            ),
            'unsupported',
          );
          this.remaining();
          return new Response(bytes, { status: 200, headers: response.headers });
        },
      );
    } catch (error) {
      this.networkReason = upstreamFailureReason(error);
      throw error;
    }
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
    if (key && !this.failures.has(key) && this.requests > before) {
      try {
        this.reserve(Buffer.byteLength(key) + Buffer.byteLength(reason));
        this.failures.set(key, reason);
      } catch {
        reason = 'budget';
      }
    }
    return freeze({
      status: 'unavailable',
      fetched: this.requests > before,
      url,
      data: null,
      reasons: [reason],
    });
  }
  async read(value: unknown): Promise<UpstreamLookup> {
    const before = this.requests;
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
        fetched: this.requests > before,
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
        close: () => reader.close(),
        spend: (amount: number) => reader.spend(amount),
      }),
    };
  } catch {
    return { kind: 'invalid' };
  }
}
