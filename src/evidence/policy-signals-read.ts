import { PACKET_LIMITS, type EvidenceReason } from '../schema.js';
import { advisoryCheck, AdvisoryFailure, copyAdvisoryData, advisoryText } from './advisory-read.js';
import { isPlainObject, freeze } from './common.js';
import type { PublishTimeLimits } from './npm-publish-times.js';
import {
  boundedGet,
  boundedLimits,
  BoundedClock,
  type BoundedDependencies,
} from './bounded-request.js';

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
  private readonly clock: BoundedClock;
  private active: (() => void) | null = null;
  private stopped: EvidenceReason | null = null;
  private busy = false;
  private cache = new Map<string, MetadataRead>();
  private pending = new Map<string, Promise<MetadataRead>>();
  constructor(
    readonly limits: PublishTimeLimits,
    private deps: BoundedDependencies,
  ) {
    this.clock = new BoundedClock(limits.totalTimeoutMs, deps);
  }
  close() {
    this.stopped = 'unknown';
    this.active?.();
    this.cache.clear();
    this.pending.clear();
    this.retained = 0;
  }
  private remaining() {
    return this.clock.remaining(this.stopped);
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
    const request = {
      url,
      accept: query.kind === 'pypi' ? 'application/json' : 'application/vnd.pypi.integrity.v1+json',
      timeoutMs: Math.min(this.remaining(), this.limits.requestTimeoutMs),
    };
    return boundedGet(
      this.deps,
      request,
      (cancel) => {
        this.active = cancel;
      },
      async (response, aborted) => {
        advisoryCheck(
          !response.redirected && (!response.url || response.url === url),
          'unsupported',
        );
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
          {
            ...this.limits,
            maxPages: this.limits.maxRequests,
            maxFindings: PACKET_LIMITS.findings,
          },
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
      },
    );
  }
  async read(value: unknown): Promise<MetadataRead> {
    try {
      this.remaining();
      const { query, url } = metadataUrl(value);
      const old = this.cache.get(url);
      if (old) return old;
      const inFlight = this.pending.get(url);
      if (inFlight) return inFlight;
      if (this.busy) return { kind: 'unavailable', reason: 'conflict' };
      this.busy = true;
      const pending = this.readFresh(query, url);
      this.pending.set(url, pending);
      try {
        return await pending;
      } finally {
        this.pending.delete(url);
        this.busy = false;
      }
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: error instanceof AdvisoryFailure ? error.reason : 'unsupported',
      };
    }
  }
  private async readFresh(query: MetadataQuery, url: string): Promise<MetadataRead> {
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
  }
}
export function createPolicySignalReader(
  value: unknown,
  dependencies: BoundedDependencies,
): ({ kind: 'ready' } & PolicyMetadataReader) | { kind: 'invalid' } {
  try {
    const limits = boundedLimits(value),
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
