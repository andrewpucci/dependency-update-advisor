import { types } from 'node:util';
import { PACKET_LIMITS, type EvidenceReason, type EvidenceStatus } from '../schema.js';
import { freeze, isPlainObject } from './common.js';

export type AdvisoryLimits = Readonly<{
  maxRequests: number;
  maxPages: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxJsonEntries: number;
  maxJsonDepth: number;
  maxRetainedBytes: number;
  maxFindings: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}>;
export type AdvisoryTarget = Readonly<{
  ecosystem: 'npm' | 'pip' | 'actions';
  name: string;
  version: string;
}>;
export type AdvisoryRecord = Readonly<{
  id: string;
  url: string;
  title: string;
  range?: string;
  withdrawn: boolean;
  severity?: 'critical' | 'high' | 'moderate' | 'low';
}>;
export type AdvisoryLookup = Readonly<{
  target: AdvisoryTarget;
  url: string;
  status: EvidenceStatus;
  complete: boolean;
  records: readonly AdvisoryRecord[];
  reasons: readonly EvidenceReason[];
}>;
export type AdvisoryReader = Readonly<{
  read: (target: unknown) => Promise<AdvisoryLookup>;
  close: () => void;
}>;
type Dependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
};
export class AdvisoryFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
export function advisoryCheck(value: unknown, reason: EvidenceReason = 'malformed'): asserts value {
  if (!value) throw new AdvisoryFailure(reason);
}
export function advisoryText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= PACKET_LIMITS.identityBytes &&
    !/[\p{Cc}\p{Cs}]/u.test(value)
  );
}
export function advisoryLimits(value: unknown): AdvisoryLimits {
  advisoryCheck(isPlainObject(value));
  const keys = [
    'maxRequests',
    'maxPages',
    'maxResponseBytes',
    'maxTotalBytes',
    'maxJsonEntries',
    'maxJsonDepth',
    'maxRetainedBytes',
    'maxFindings',
    'requestTimeoutMs',
    'totalTimeoutMs',
  ] as const;
  advisoryCheck(keys.every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) > 0));
  advisoryCheck(Number(value.maxResponseBytes) <= Number(value.maxTotalBytes));
  advisoryCheck(Number(value.requestTimeoutMs) <= Number(value.totalTimeoutMs));
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as AdvisoryLimits;
}
/** Inspect descriptors before cloning: callers cannot run getters during validation. */
export function copyAdvisoryData<T>(value: T, limits: AdvisoryLimits, work = { entries: 0 }): T {
  const pending = [{ value: value as unknown, depth: 0 }];
  let bytes = 0;
  while (pending.length) {
    advisoryCheck(++work.entries <= limits.maxJsonEntries, 'budget');
    const item = pending.pop()!;
    advisoryCheck(item.depth <= limits.maxJsonDepth, 'budget');
    const v = item.value;
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v);
      advisoryCheck(bytes <= limits.maxRetainedBytes, 'budget');
    }
    if (!v || typeof v !== 'object') {
      advisoryCheck(v === null || ['string', 'number', 'boolean'].includes(typeof v));
      advisoryCheck(typeof v !== 'number' || Number.isFinite(v));
      continue;
    }
    advisoryCheck(!types.isProxy(v));
    const array = Array.isArray(v);
    advisoryCheck(array ? Object.getPrototypeOf(v) === Array.prototype : isPlainObject(v));
    const keys = Reflect.ownKeys(v);
    advisoryCheck(keys.length <= limits.maxJsonEntries - work.entries + 1, 'budget');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      advisoryCheck(typeof key === 'string' && 'value' in d && d.enumerable);
      pending.push({ value: d.value, depth: item.depth + 1 });
    }
  }
  return structuredClone(value);
}
function target(value: unknown): AdvisoryTarget {
  advisoryCheck(isPlainObject(value));
  advisoryCheck(['npm', 'pip', 'actions'].includes(String(value.ecosystem)), 'unsupported');
  advisoryCheck(advisoryText(value.name) && advisoryText(value.version), 'unsupported');
  advisoryCheck(!/[\s,@]/u.test(value.version) && !/[,\s]/u.test(value.name), 'unsupported');
  const names = {
    npm: /^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu,
    pip: /^[a-z\d]+(?:-[a-z\d]+)*$/u,
    actions: /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/iu,
  };
  advisoryCheck(
    names[value.ecosystem as AdvisoryTarget['ecosystem']].test(value.name),
    'unsupported',
  );
  advisoryCheck(!/[<>=~^*|]/u.test(value.version), 'unsupported');
  return {
    ecosystem: value.ecosystem as AdvisoryTarget['ecosystem'],
    name: value.name,
    version: value.version,
  };
}
export function advisoryUrl(t: AdvisoryTarget): string {
  const url = new URL('https://api.github.com/advisories');
  url.search = new URLSearchParams({
    ecosystem: t.ecosystem,
    affects: `${t.name}@${t.version}`,
    type: 'reviewed',
    per_page: '100',
  }).toString();
  return url.href;
}
function normalize(value: unknown, t: AdvisoryTarget): AdvisoryRecord {
  advisoryCheck(
    isPlainObject(value) && /^GHSA-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}$/u.test(String(value.ghsa_id)),
  );
  advisoryCheck(value.html_url === `https://github.com/advisories/${value.ghsa_id}`);
  advisoryCheck(value.type === 'reviewed', 'unsupported');
  advisoryCheck(advisoryText(value.summary));
  advisoryCheck(
    value.withdrawn_at === null ||
      (typeof value.withdrawn_at === 'string' && Number.isFinite(Date.parse(value.withdrawn_at))),
  );
  advisoryCheck(Array.isArray(value.vulnerabilities));
  const matches = value.vulnerabilities.filter(
    (v) =>
      isPlainObject(v) &&
      isPlainObject(v.package) &&
      v.package.ecosystem === t.ecosystem &&
      v.package.name === t.name,
  );
  advisoryCheck(matches.length === 1, 'conflict');
  advisoryCheck(advisoryText(matches[0].vulnerable_version_range));
  const severity = value.severity === 'medium' ? 'moderate' : value.severity;
  advisoryCheck(
    severity === null ||
      severity === undefined ||
      ['unknown', 'critical', 'high', 'moderate', 'low'].includes(String(severity)),
  );
  return {
    id: String(value.ghsa_id),
    url: String(value.html_url),
    title: value.summary,
    range: matches[0].vulnerable_version_range,
    withdrawn: value.withdrawn_at !== null,
    ...(['critical', 'high', 'moderate', 'low'].includes(String(severity))
      ? { severity: severity as AdvisoryRecord['severity'] }
      : {}),
  };
}
export function comparisonAdvisory(value: unknown): AdvisoryRecord {
  advisoryCheck(isPlainObject(value));
  const identity = value.advisory_ghsa_id;
  advisoryCheck(
    typeof identity === 'string' && /^GHSA-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}$/u.test(identity),
  );
  advisoryCheck(
    value.advisory_url === `https://github.com/advisories/${identity}` &&
      advisoryText(value.advisory_summary),
  );
  const severity = value.severity === 'medium' ? 'moderate' : value.severity;
  advisoryCheck(
    severity === undefined ||
      severity === null ||
      ['unknown', 'critical', 'high', 'moderate', 'low'].includes(String(severity)),
  );
  return {
    id: identity,
    url: String(value.advisory_url),
    title: value.advisory_summary,
    withdrawn: false,
    ...(['critical', 'high', 'moderate', 'low'].includes(String(severity))
      ? { severity: severity as AdvisoryRecord['severity'] }
      : {}),
  };
}
function httpReason(response: Response, data: unknown): EvidenceReason {
  const message = isPlainObject(data) && typeof data.message === 'string' ? data.message : '';
  const retry = response.headers.get('retry-after');
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        (retry !== null && /^\d+$/u.test(retry)) ||
        /secondary rate limit/iu.test(message)))
  )
    return 'rate_limit';
  if (
    response.status === 401 ||
    (response.status === 403 &&
      [
        'Resource not accessible by integration',
        'Resource not accessible by personal access token',
      ].includes(message))
  )
    return 'permission';
  return response.status === 404 ? 'missing' : 'unknown';
}
function deadlineTimer(duration: number, expire: () => void) {
  let remaining = duration,
    handle: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const interval = Math.min(remaining, 2 ** 31 - 1);
    handle = setTimeout(() => {
      remaining -= interval;
      if (remaining > 0) schedule();
      else expire();
    }, interval);
  };
  schedule();
  return () => clearTimeout(handle);
}
function continuation(link: string | null, original: string, seen: Set<string>): string | null {
  if (!link) return null;
  let next: string | null = null;
  for (const part of link.split(/,\s*(?=<)/u)) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/u.exec(part);
    advisoryCheck(match);
    const supplied = new URL(match[1]),
      expected = new URL(original);
    advisoryCheck(
      supplied.origin === expected.origin &&
        supplied.pathname === expected.pathname &&
        !supplied.username &&
        !supplied.password &&
        !supplied.hash,
      'unsupported',
    );
    for (const [key, value] of expected.searchParams)
      advisoryCheck(
        supplied.searchParams.getAll(key).length === 1 && supplied.searchParams.get(key) === value,
        'conflict',
      );
    advisoryCheck(
      [...supplied.searchParams.keys()].every(
        (k) => expected.searchParams.has(k) || k === 'after' || k === 'before',
      ),
    );
    if (match[2] !== 'next') continue;
    advisoryCheck(
      next === null &&
        supplied.searchParams.getAll('after').length === 1 &&
        !supplied.searchParams.has('before'),
    );
    const cursor = supplied.searchParams.get('after');
    advisoryCheck(advisoryText(cursor));
    expected.searchParams.set('after', cursor);
    next = expected.href;
    advisoryCheck(!seen.has(next), 'conflict');
  }
  return next;
}
class Reader implements AdvisoryReader {
  private requests = 0;
  private bytes = 0;
  private work = { entries: 0 };
  private started: number;
  private last: number;
  private busy = false;
  private stopped: EvidenceReason | null = null;
  private active: (() => void) | null = null;
  constructor(
    private limits: AdvisoryLimits,
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
    advisoryCheck(!this.deps.signal?.aborted && !this.stopped, this.stopped ?? 'unknown');
    const time = this.deps.now();
    advisoryCheck(Number.isFinite(time) && time >= this.last, 'unknown');
    this.last = time;
    const left = this.limits.totalTimeoutMs - (time - this.started);
    advisoryCheck(left > 0, 'timeout');
    return left;
  }
  private async body(response: Response, aborted: Promise<never>) {
    advisoryCheck(response.body);
    const stream = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([stream.read(), aborted]);
        if (chunk.done) return Buffer.concat(chunks, size);
        size += chunk.value.byteLength;
        this.bytes += chunk.value.byteLength;
        advisoryCheck(
          size <= this.limits.maxResponseBytes && this.bytes <= this.limits.maxTotalBytes,
          'budget',
        );
        this.remaining();
        chunks.push(chunk.value);
      }
    } finally {
      void stream.cancel().catch(() => {});
      stream.releaseLock();
    }
  }
  private async page(url: string): Promise<{ data: unknown; link: string | null }> {
    this.remaining();
    advisoryCheck(
      ++this.requests <= Math.min(this.limits.maxRequests, this.limits.maxPages),
      'budget',
    );
    const duration = Math.min(this.remaining(), this.limits.requestTimeoutMs);
    const controller = new AbortController();
    let reject: (e: AdvisoryFailure) => void = () => {};
    const aborted = new Promise<never>((_, r) => {
      reject = r;
    });
    const stop = (reason: EvidenceReason) => {
      controller.abort();
      reject(new AdvisoryFailure(reason));
    };
    const cancel = () => stop('unknown');
    this.active = cancel;
    this.deps.signal?.addEventListener('abort', cancel, { once: true });
    const clear = deadlineTimer(duration, () => stop('timeout'));
    let response: Response | undefined;
    try {
      this.remaining();
      response = await Promise.race([
        this.deps.fetch(url, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'manual',
          headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
          signal: controller.signal,
        }),
        aborted,
      ]);
      advisoryCheck(!response.redirected && (!response.url || response.url === url), 'unsupported');
      advisoryCheck(response.status < 300 || response.status >= 400, 'unsupported');
      if (httpReason(response, null) === 'rate_limit') {
        this.stopped = 'rate_limit';
        throw new AdvisoryFailure('rate_limit');
      }
      const bytes = await this.body(response, aborted);
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new AdvisoryFailure(
          response.status === 200 ? 'malformed' : httpReason(response, null),
        );
      }
      if (response.status !== 200) {
        const reason = httpReason(response, data);
        if (reason === 'rate_limit') this.stopped = reason;
        throw new AdvisoryFailure(reason);
      }
      advisoryCheck(
        /^application\/(?:json|vnd.github\+json)(?:\s*;|$)/iu.test(
          response.headers.get('content-type') ?? '',
        ),
        'unsupported',
      );
      data = copyAdvisoryData(data, this.limits, this.work);
      this.remaining();
      return { data, link: response.headers.get('link') };
    } finally {
      clear();
      this.deps.signal?.removeEventListener('abort', cancel);
      this.active = null;
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  async read(value: unknown): Promise<AdvisoryLookup> {
    const invalid: AdvisoryTarget = { ecosystem: 'npm', name: '', version: '' };
    let t = invalid,
      url = '',
      records: AdvisoryRecord[] = [];
    if (this.busy)
      return {
        target: t,
        url,
        status: 'unavailable',
        complete: false,
        records,
        reasons: ['conflict'],
      };
    this.busy = true;
    try {
      t = target(value);
      url = advisoryUrl(t);
      let next: string | null = url;
      const seen = new Set<string>();
      while (next) {
        seen.add(next);
        const page = await this.page(next);
        advisoryCheck(Array.isArray(page.data));
        for (const value of page.data) {
          const record = normalize(value, t);
          advisoryCheck(records.length < this.limits.maxFindings, 'budget');
          advisoryCheck(
            Buffer.byteLength(JSON.stringify([...records, record])) <= this.limits.maxRetainedBytes,
            'budget',
          );
          records.push(record);
        }
        next = continuation(page.link, url, seen);
      }
      return freeze({
        target: t,
        url,
        records,
        complete: true,
        status: 'available',
        reasons: [],
      } as AdvisoryLookup);
    } catch (error) {
      return freeze({
        target: t,
        url,
        records,
        complete: false,
        status: records.length ? 'partial' : 'unavailable',
        reasons: [error instanceof AdvisoryFailure ? error.reason : 'unknown'],
      });
    } finally {
      this.busy = false;
    }
  }
}
export function createAdvisoryReader(
  limits: unknown,
  dependencies: Dependencies,
): ({ kind: 'ready' } & AdvisoryReader) | { kind: 'invalid' } {
  try {
    const reader = new Reader(advisoryLimits(limits), dependencies);
    return Object.freeze({
      kind: 'ready',
      read: (value: unknown) => reader.read(value),
      close: () => reader.close(),
    });
  } catch {
    return { kind: 'invalid' };
  }
}
