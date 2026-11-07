import { PACKET_LIMITS, type EvidenceReason } from '../schema.js';
import { advisoryCheck, AdvisoryFailure, copyAdvisoryData, advisoryText } from './advisory-read.js';
import { isPlainObject, freeze } from './common.js';
import type { PublishTimeLimits } from './npm-publish-times.js';

export type MetadataQuery = {
  kind: 'pypi' | 'pypi-provenance';
  name: string;
  version: string;
  source: { kind: 'registry'; identity: string };
  filename?: string;
};
export type MetadataRead =
  | { kind: 'data'; url: string; data: Readonly<Record<string, unknown>> }
  | { kind: 'absent'; url: string }
  | { kind: 'unavailable'; reason: EvidenceReason };
export type PolicyMetadataReader = {
  limits: PublishTimeLimits;
  read: (value: unknown) => Promise<MetadataRead>;
  spend: (amount: number) => void;
  close: () => void;
};
type Dependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
};
export function metadataUrl(value: unknown): { query: MetadataQuery; url: string } {
  advisoryCheck(isPlainObject(value) && isPlainObject(value.source), 'unsupported');
  advisoryCheck(
    ['pypi', 'pypi-provenance'].includes(String(value.kind)) &&
      advisoryText(value.name) &&
      /^[a-z\d]+(?:-[a-z\d]+)*$/u.test(value.name) &&
      advisoryText(value.version) &&
      value.version !== '.' &&
      value.version !== '..' &&
      !/[\s/@,<>=~^*|]/u.test(value.version),
    'unsupported',
  );
  advisoryCheck(
    value.source.kind === 'registry' && typeof value.source.identity === 'string',
    'unsupported',
  );
  const origin = new URL(value.source.identity);
  advisoryCheck(
    origin.origin === 'https://pypi.org' &&
      ['/simple', '/simple/'].includes(origin.pathname) &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
    'unsupported',
  );
  const name = encodeURIComponent(value.name),
    version = encodeURIComponent(value.version);
  if (value.kind === 'pypi-provenance')
    advisoryCheck(
      advisoryText(value.filename) &&
        value.filename !== '.' &&
        value.filename !== '..' &&
        !/[/\\?#\s]/u.test(value.filename),
      'unsupported',
    );
  const query = {
    kind: value.kind,
    name: value.name,
    version: value.version,
    source: { kind: 'registry', identity: value.source.identity },
    ...(value.kind === 'pypi-provenance' ? { filename: value.filename } : {}),
  } as MetadataQuery;
  return {
    query,
    url:
      query.kind === 'pypi'
        ? `https://pypi.org/pypi/${name}/${version}/json`
        : `https://pypi.org/integrity/${name}/${version}/${encodeURIComponent(query.filename!)}/provenance`,
  };
}
function httpReason(response: Response): EvidenceReason {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has('retry-after') ||
        response.headers.get('x-ratelimit-remaining') === '0'))
  )
    return 'rate_limit';
  if ([401, 403].includes(response.status)) return 'permission';
  if (response.status === 404) return 'missing';
  return response.status >= 300 && response.status < 400 ? 'unsupported' : 'unknown';
}
class MetadataReader {
  private requests = 0;
  private bytes = 0;
  private work = { entries: 0 };
  private operations = 0;
  private retained = 0;
  private started: number;
  private last: number;
  private active: (() => void) | null = null;
  private stopped: EvidenceReason | null = null;
  private busy = false;
  private cache = new Map<string, MetadataRead>();
  constructor(
    readonly limits: PublishTimeLimits,
    private deps: Dependencies,
  ) {
    this.started = this.last = deps.now();
    advisoryCheck(Number.isFinite(this.started));
  }
  close() {
    this.stopped = 'unknown';
    this.active?.();
  }
  private remaining() {
    advisoryCheck(!this.stopped && !this.deps.signal?.aborted, this.stopped ?? 'unknown');
    const now = this.deps.now();
    advisoryCheck(Number.isFinite(now) && now >= this.last, 'unknown');
    this.last = now;
    const left = this.limits.totalTimeoutMs - (now - this.started);
    advisoryCheck(left > 0, 'timeout');
    return left;
  }
  spend(amount: number) {
    advisoryCheck(Number.isSafeInteger(amount) && amount >= 0);
    this.operations += amount;
    advisoryCheck(this.operations <= this.limits.maxWork, 'budget');
    this.remaining();
  }
  private async body(response: Response, aborted: Promise<never>) {
    advisoryCheck(response.body);
    const stream = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await Promise.race([stream.read(), aborted]);
        if (part.done) break;
        size += part.value.byteLength;
        this.bytes += part.value.byteLength;
        advisoryCheck(
          size <= this.limits.maxResponseBytes && this.bytes <= this.limits.maxTotalBytes,
          'budget',
        );
        this.spend(1);
        chunks.push(part.value);
      }
      return Buffer.concat(chunks, size);
    } finally {
      void stream.cancel().catch(() => {});
      stream.releaseLock();
    }
  }
  private async fetch(query: MetadataQuery, url: string): Promise<MetadataRead> {
    advisoryCheck(++this.requests <= this.limits.maxRequests, 'budget');
    const controller = new AbortController();
    let reject: (error: AdvisoryFailure) => void = () => {};
    const aborted = new Promise<never>((_, r) => {
      reject = r;
    });
    const stop = (reason: EvidenceReason) => {
      controller.abort();
      reject(new AdvisoryFailure(reason));
    };
    const cancel = () => stop('unknown');
    const duration = Math.min(this.remaining(), this.limits.requestTimeoutMs);
    this.active = cancel;
    this.deps.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('timeout'), duration);
    let response: Response | undefined;
    try {
      response = await Promise.race([
        this.deps.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: {
            accept:
              query.kind === 'pypi' ? 'application/json' : 'application/vnd.pypi.integrity.v1+json',
          },
          signal: controller.signal,
        }),
        aborted,
      ]);
      advisoryCheck(!response.redirected && (!response.url || response.url === url), 'unsupported');
      if (response.status === 404 && query.kind === 'pypi-provenance')
        return { kind: 'absent', url };
      if (response.status !== 200) {
        const reason = httpReason(response);
        if (reason === 'rate_limit') this.stopped = reason;
        throw new AdvisoryFailure(reason);
      }
      advisoryCheck(
        /^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/iu.test(
          response.headers.get('content-type') ?? '',
        ),
        'unsupported',
      );
      const bytes = await this.body(response, aborted);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new AdvisoryFailure('malformed');
      }
      const previousEntries = this.work.entries;
      const data = copyAdvisoryData(
        parsed,
        { ...this.limits, maxPages: this.limits.maxRequests, maxFindings: PACKET_LIMITS.findings },
        this.work,
      );
      this.spend(this.work.entries - previousEntries);
      advisoryCheck(isPlainObject(data));
      if (query.kind === 'pypi')
        advisoryCheck(
          isPlainObject(data.info) &&
            typeof data.info.name === 'string' &&
            data.info.name.toLowerCase().replace(/[-_.]+/gu, '-') === query.name &&
            data.info.version === query.version,
          'conflict',
        );
      return freeze({ kind: 'data', url, data });
    } finally {
      clearTimeout(timer);
      this.deps.signal?.removeEventListener('abort', cancel);
      this.active = null;
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  async read(value: unknown): Promise<MetadataRead> {
    if (this.busy) return { kind: 'unavailable', reason: 'conflict' };
    this.busy = true;
    try {
      this.remaining();
      const { query, url } = metadataUrl(value);
      const old = this.cache.get(url);
      if (old) return old;
      let result: MetadataRead;
      try {
        result = await this.fetch(query, url);
      } catch (error) {
        result = {
          kind: 'unavailable',
          reason: error instanceof AdvisoryFailure ? error.reason : 'unknown',
        };
      }
      const size = Buffer.byteLength(url) + Buffer.byteLength(JSON.stringify(result));
      advisoryCheck(this.retained + size <= this.limits.maxRetainedBytes, 'budget');
      this.retained += size;
      this.cache.set(url, result);
      return result;
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: error instanceof AdvisoryFailure ? error.reason : 'unsupported',
      };
    } finally {
      this.busy = false;
    }
  }
}
export function createPolicySignalReader(
  value: unknown,
  dependencies: Dependencies,
): ({ kind: 'ready' } & PolicyMetadataReader) | { kind: 'invalid' } {
  try {
    advisoryCheck(isPlainObject(value));
    const keys = [
      'maxRequests',
      'maxResponseBytes',
      'maxTotalBytes',
      'maxJsonEntries',
      'maxJsonDepth',
      'maxWork',
      'maxRetainedBytes',
      'requestTimeoutMs',
      'totalTimeoutMs',
    ] as const;
    advisoryCheck(keys.every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) > 0));
    advisoryCheck(
      Number(value.maxResponseBytes) <= Number(value.maxTotalBytes) &&
        Number(value.requestTimeoutMs) <= Number(value.totalTimeoutMs) &&
        Number(value.requestTimeoutMs) <= 2 ** 31 - 1,
    );
    const limits = Object.fromEntries(keys.map((k) => [k, value[k]])) as PublishTimeLimits,
      reader = new MetadataReader(limits, dependencies);
    return Object.freeze({
      kind: 'ready',
      limits: freeze(limits),
      read: (v: unknown) => reader.read(v),
      spend: (n: number) => reader.spend(n),
      close: () => reader.close(),
    });
  } catch {
    return { kind: 'invalid' };
  }
}
