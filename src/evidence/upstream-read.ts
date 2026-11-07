import { createNpmRegistryReader } from './npm-registry.js';
import { copyAdvisoryData, type AdvisoryLimits } from './advisory-read.js';
import { freeze, isPlainObject, isEvidencePath } from './common.js';
import type { EvidenceReason, PackageSource } from '../schema.js';

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
  resource: 'repository' | 'ref' | 'tag' | 'commit' | 'release' | 'contents';
  ref?: string;
  sha?: string;
  path?: string;
}>;
export type UpstreamTarget = MetadataTarget | GithubUpstreamTarget;
export type UpstreamLookup = Readonly<{
  status: 'available' | 'unavailable';
  fetched: boolean;
  url: string | null;
  data: Readonly<Record<string, unknown>> | null;
  reasons: readonly EvidenceReason[];
}>;
export type UpstreamReader = Readonly<{
  limits: UpstreamLimits;
  read: (target: unknown) => Promise<UpstreamLookup>;
  close: () => void;
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
function timer(ms: number, expire: () => void) {
  let remaining = ms,
    handle: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const part = Math.min(remaining, 2 ** 31 - 1);
    handle = setTimeout(() => {
      remaining -= part;
      if (remaining > 0) schedule();
      else expire();
    }, part);
  };
  schedule();
  return () => clearTimeout(handle);
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
    ['repository', 'ref', 'tag', 'commit', 'release', 'contents'].includes(String(value.resource)),
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
  return value as unknown as GithubUpstreamTarget;
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
  }
}
class Reader {
  private requests = 0;
  private bytes = 0;
  private work = { entries: 0 };
  private last: number;
  private readonly start: number;
  private closed = false;
  private busy = false;
  private stopped: EvidenceReason | null = null;
  private networkReason: EvidenceReason | null = null;
  private readonly controller = new AbortController();
  private readonly blocked = new Set<string>();
  private readonly cache = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly npm: ReturnType<typeof createNpmRegistryReader>;
  constructor(
    readonly limits: UpstreamLimits,
    private readonly deps: UpstreamDependencies,
  ) {
    this.start = this.last = deps.now();
    requireUpstream(Number.isFinite(this.start));
    this.npm = createNpmRegistryReader(limits, {
      now: deps.now,
      signal: this.controller.signal,
      fetch: (url, init) => this.fetchBounded(url, init),
    });
    requireUpstream(this.npm.kind === 'ready');
  }
  close() {
    this.closed = true;
    this.controller.abort();
  }
  private remaining() {
    requireUpstream(!this.closed && !this.deps.signal?.aborted, 'unknown');
    requireUpstream(!this.stopped, this.stopped ?? 'unknown');
    const now = this.deps.now();
    requireUpstream(Number.isFinite(now) && now >= this.last, 'unknown');
    this.last = now;
    const left = this.limits.totalTimeoutMs - (now - this.start);
    if (left <= 0) this.stopped = 'timeout';
    requireUpstream(left > 0, 'timeout');
    return left;
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
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async fetchBounded(url: string, _init: RequestInit): Promise<Response> {
    this.dispatch(url);
    const controller = new AbortController();
    let reject: (e: UpstreamFailure) => void = () => {};
    const aborted = new Promise<never>((_, no) => {
      reject = no;
    });
    const stop = (reason: EvidenceReason) => {
      reject(new UpstreamFailure(reason));
      controller.abort();
    };
    const cancel = () => stop('unknown');
    const signals = [this.controller.signal, this.deps.signal, _init.signal].filter(
      (s): s is AbortSignal => !!s,
    );
    for (const signal of signals) signal.addEventListener('abort', cancel, { once: true });
    const clear = timer(Math.min(this.remaining(), this.limits.requestTimeoutMs), () =>
      stop('timeout'),
    );
    let response: Response | undefined;
    try {
      response = await Promise.race([
        this.deps.fetch(url, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'manual',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        }),
        aborted,
      ]);
      requireUpstream(
        !response.redirected && (!response.url || response.url === url),
        'unsupported',
      );
      const bytes = await this.body(response, aborted);
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
    } catch (error) {
      this.networkReason = error instanceof UpstreamFailure ? error.reason : 'unknown';
      throw error;
    } finally {
      clear();
      controller.abort();
      for (const signal of signals) signal.removeEventListener('abort', cancel);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  private async pypi(t: MetadataTarget, url: string) {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const response = await this.fetchBounded(url, {});
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()),
    );
    const data = upstreamCopy(parsed, this.limits, this.work);
    requireUpstream(isPlainObject(data) && isPlainObject(data.info));
    const info = data.info;
    requireUpstream(
      typeof info.name === 'string' &&
        info.name.toLowerCase().replace(/[-_.]+/gu, '-') === t.name &&
        info.version === t.version,
      'conflict',
    );
    this.cache.set(url, freeze(info));
    return info;
  }
  private async npmData(t: MetadataTarget) {
    requireUpstream(this.npm.kind === 'ready');
    const result = await this.npm.read(t);
    if (result.kind === 'unavailable')
      throw new UpstreamFailure(this.networkReason ?? result.reason);
    return upstreamCopy(result.document.data, this.limits, this.work);
  }
  private async githubData(t: GithubUpstreamTarget, url: string) {
    const cached = t.resource === 'ref' ? null : this.cache.get(url);
    if (cached) return cached;
    const response = await this.fetchBounded(url, {});
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()),
    );
    const data = upstreamCopy(parsed, this.limits, this.work);
    requireUpstream(isPlainObject(data));
    if (t.resource !== 'ref') this.cache.set(url, freeze(data));
    return data;
  }
  private async targetData(t: UpstreamTarget, url: string) {
    if (t.kind === 'github') return this.githubData(t, url);
    return t.kind === 'npm' ? this.npmData(t) : this.pypi(t, url);
  }
  async read(value: unknown): Promise<UpstreamLookup> {
    const before = this.requests;
    let url: string | null = null;
    if (this.busy)
      return { status: 'unavailable', fetched: false, url, data: null, reasons: ['conflict'] };
    this.busy = true;
    this.networkReason = null;
    try {
      this.remaining();
      const copied = upstreamCopy(value, this.limits, this.work);
      const t =
        isPlainObject(copied) && copied.kind === 'github'
          ? githubTarget(copied)
          : metadataTarget(copied);
      url =
        t.kind === 'github'
          ? upstreamGithubUrl(t)
          : t.kind === 'npm'
            ? `https://registry.npmjs.org/${encodeURIComponent(t.name)}/${encodeURIComponent(t.version)}`
            : `https://pypi.org/pypi/${encodeURIComponent(t.name)}/${encodeURIComponent(t.version)}/json`;
      requireUpstream(!this.blocked.has(new URL(url).origin), 'rate_limit');
      const data = await this.targetData(t, url);
      requireUpstream(this.work.entries <= this.limits.maxWork, 'budget');
      return freeze({
        status: 'available',
        fetched: this.requests > before,
        url,
        data,
        reasons: [],
      });
    } catch (error) {
      return freeze({
        status: 'unavailable',
        fetched: this.requests > before,
        url,
        data: null,
        reasons: [error instanceof UpstreamFailure ? error.reason : 'unknown'],
      });
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
      }),
    };
  } catch {
    return { kind: 'invalid' };
  }
}
