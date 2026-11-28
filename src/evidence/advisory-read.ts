import { types } from 'node:util';
import { PACKET_LIMITS, type EvidenceReason, type EvidenceStatus } from '../schema.js';
import { divisorChain, freeze, isPlainObject } from './common.js';
import { BoundedClock, boundedGet } from './bounded-request.js';
import { waitForRetry, type GithubQuotaGuard } from './github-quota.js';
import type { ResearchCache } from './research-cache.js';
import { HTTP_STATUS } from '../format.js';
import { limit } from '../limits.js';
import {
  advisoryBatches,
  batchUrl,
  splitBatches,
  BATCH_MAX_TARGETS,
  BATCH_PAGE_SIZES,
  BATCH_URL_BYTES,
} from './batches.js';

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
  /**
   * Settled from a complete batch rather than its own query: the lookup equals the complete
   * result of the query `url` names, which was not itself fetched.
   */
  batched?: true;
}>;
export type AdvisoryReader = Readonly<{
  read: (target: unknown) => Promise<AdvisoryLookup>;
  /**
   * Settles what complete batches can for these targets, before they are read: npm versioned
   * batches, and discovery batches for Actions reviewed and `pip` malware targets. A target a
   * batch cannot settle is left to `read`, which then queries it alone. Resolves to the number
   * of targets it decided, complete or not, so `read` sends nothing for them; or null when the
   * reader was busy and decided nothing.
   */
  settle?: (targets: readonly unknown[]) => Promise<number | null>;
  /** Whether `read` answers this target from a lookup `settle` decided, sending nothing. */
  isSettled?: (target: unknown) => boolean;
  close: () => void;
  /** The reason this reader refuses all further reads, or null while it can still read. */
  stopped?: () => EvidenceReason | null;
}>;
type Dependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
  cache?: ResearchCache;
  /** The run's research GitHub quota guard; absent outside research. */
  quota?: GithubQuotaGuard;
  /**
   * Drops or reorders the planned requests of a discovery batch; a URL it was not given makes
   * the batch incomplete. Only tests pass it, to show that a batch whose requests miss a
   * spelling settles nothing.
   */
  discoveryPlan?: (urls: string[]) => string[];
};
export class AdvisoryFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
/**
 * A 200 response larger than the per-response byte cap, while the reader's byte share still had
 * room: the page, not the share, is too large, so a page-size ladder may retry it smaller.
 */
class ResponseTooLarge extends AdvisoryFailure {
  constructor() {
    super('budget');
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
export type QueryKind = 'reviewed' | 'malware';
type Provider = 'github' | 'osv';
const GHSA_ID = /^GHSA-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}$/u;
/** The OSV endpoint; a complete empty PyPI reviewed lookup cites it. */
export const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
/** Approved register values for stored-name discovery (S1 Package Name Form Amendment). */
const DISCOVERY_PAGE_SIZE = String(limit('advisory.discovery.pageSize'));
const DISCOVERY_URL_CAP = limit('advisory.discovery.urlBytes');
const DISCOVERY_CURSOR_HEADROOM = limit('advisory.discovery.cursorHeadroomBytes');
const SPELLING_CEILING = limit('advisory.discovery.spellingCeiling');
/**
 * The page sizes a discovery read retries at when a page does not fit the per-response cap: a
 * divisor chain from the register page size down to 1, as the compare and release ladders use.
 * Discovery and batches page by cursor, so a smaller page at the same cursor resumes exactly
 * where the refused one would have started.
 */
export const DISCOVERY_PAGE_SIZES: readonly number[] = Object.freeze(
  divisorChain(limit('advisory.discovery.pageSize')),
);
/** PEP 503 treats each of these as the same separator. */
const PIP_SEPARATORS = ['-', '_', '.'] as const;
/** One GitHub global advisory query URL, with the reader's fixed filters. */
export function githubUrl(
  ecosystem: AdvisoryTarget['ecosystem'],
  affects: readonly string[],
  kind: QueryKind,
  perPage = '100',
): string {
  const url = new URL('https://api.github.com/advisories');
  url.search = new URLSearchParams({
    ecosystem,
    affects: affects.join(','),
    type: kind,
    per_page: perPage,
  }).toString();
  return url.href;
}
/**
 * GitHub stores package names as each advisory spells them; compare them the way the ecosystem
 * does (S1 Package Name Form Amendment item 6).
 */
export function canonicalName(ecosystem: AdvisoryTarget['ecosystem'], name: string): string {
  if (ecosystem === 'pip') return name.toLowerCase().replace(/[-_.]+/gu, '-');
  return ecosystem === 'actions' ? name.toLowerCase() : name;
}
/**
 * Every spelling of a normalized PyPI name with each separator replaced by `-`, `_`, or `.`.
 * Throws an `unsupported` AdvisoryFailure past the spelling ceiling.
 */
export function pipSpellings(name: string): string[] {
  const parts = name.split('-');
  advisoryCheck(PIP_SEPARATORS.length ** (parts.length - 1) <= SPELLING_CEILING, 'unsupported');
  let spellings = [parts[0]];
  for (const part of parts.slice(1))
    spellings = spellings.flatMap((s) => PIP_SEPARATORS.map((sep) => s + sep + part));
  return spellings;
}
/** Every spelling discovery sends for a target name: all PyPI separator forms, or the name. */
export function discoverySpellings(ecosystem: AdvisoryTarget['ecosystem'], name: string): string[] {
  return ecosystem === 'pip' ? pipSpellings(name) : [name];
}
/**
 * Package-only discovery URLs over these spellings, each with room left under the cap for a
 * pagination cursor, and none for no spellings. Throws an `unsupported` AdvisoryFailure when one spelling alone cannot fit.
 */
export function discoveryUrls(
  ecosystem: AdvisoryTarget['ecosystem'],
  spellings: readonly string[],
  kind: QueryKind,
): string[] {
  // No spellings means no query: an empty `affects` would list every advisory.
  if (!spellings.length) return [];
  const limit = DISCOVERY_URL_CAP - DISCOVERY_CURSOR_HEADROOM;
  const urls: string[] = [];
  let chunk: string[] = [];
  for (const spelling of spellings) {
    if (githubUrl(ecosystem, [...chunk, spelling], kind, DISCOVERY_PAGE_SIZE).length <= limit) {
      chunk.push(spelling);
      continue;
    }
    advisoryCheck(chunk.length > 0, 'unsupported');
    urls.push(githubUrl(ecosystem, chunk, kind, DISCOVERY_PAGE_SIZE));
    chunk = [spelling];
  }
  urls.push(githubUrl(ecosystem, chunk, kind, DISCOVERY_PAGE_SIZE));
  return urls;
}
/** An advisory may list one package several times; GitHub does not say which range matched. */
function joinRanges(ranges: readonly string[]): string {
  const range = ranges.join(' || ');
  advisoryCheck(Buffer.byteLength(range) <= PACKET_LIMITS.identityBytes, 'budget');
  return range;
}
function severityOf(value: unknown): AdvisoryRecord['severity'] | undefined {
  const severity = value === 'medium' ? 'moderate' : value;
  advisoryCheck(
    severity === null ||
      severity === undefined ||
      ['unknown', 'critical', 'high', 'moderate', 'low'].includes(String(severity)),
  );
  return ['critical', 'high', 'moderate', 'low'].includes(String(severity))
    ? (severity as AdvisoryRecord['severity'])
    : undefined;
}
function packageEntries(value: unknown[], t: AdvisoryTarget) {
  const name = canonicalName(t.ecosystem, t.name);
  return value.filter(
    (v): v is Record<string, unknown> & { package: Record<string, unknown> } =>
      isPlainObject(v) &&
      isPlainObject(v.package) &&
      v.package.ecosystem === t.ecosystem &&
      typeof v.package.name === 'string' &&
      canonicalName(t.ecosystem, v.package.name) === name,
  );
}
function githubRecordBase(value: unknown, kind: QueryKind) {
  advisoryCheck(isPlainObject(value) && GHSA_ID.test(String(value.ghsa_id)));
  advisoryCheck(value.html_url === `https://github.com/advisories/${value.ghsa_id}`);
  advisoryCheck(value.type === kind, 'unsupported');
  advisoryCheck(Array.isArray(value.vulnerabilities));
  return value as Record<string, unknown> & { vulnerabilities: unknown[] };
}
/** A GitHub record's own fields, checked apart from its package entries. */
function githubRecord(value: unknown, kind: QueryKind) {
  const record = githubRecordBase(value, kind);
  advisoryCheck(advisoryText(record.summary));
  advisoryCheck(
    record.withdrawn_at === null ||
      (typeof record.withdrawn_at === 'string' && Number.isFinite(Date.parse(record.withdrawn_at))),
  );
  return { record, title: record.summary, severity: severityOf(record.severity) };
}
function normalize(value: unknown, t: AdvisoryTarget, kind: QueryKind): AdvisoryRecord {
  const { record, title, severity } = githubRecord(value, kind);
  const matches = packageEntries(record.vulnerabilities, t);
  advisoryCheck(matches.length > 0, 'conflict');
  const ranges = matches.map((m) => m.vulnerable_version_range);
  advisoryCheck(ranges.every(advisoryText), 'conflict');
  return {
    id: String(record.ghsa_id),
    url: String(record.html_url),
    title,
    range: joinRanges(ranges),
    withdrawn: record.withdrawn_at !== null,
    ...(severity ? { severity } : {}),
  };
}
/** Stored spellings a discovery record gives for the target; a record naming none is malformed. */
function storedForms(value: unknown, t: AdvisoryTarget, kind: QueryKind): string[] {
  const forms = packageEntries(githubRecordBase(value, kind).vulnerabilities, t).map(
    (v) => v.package.name as string,
  );
  advisoryCheck(forms.length > 0 && forms.every(advisoryText));
  return forms;
}
/**
 * The batched targets one batch record names, by key, each with the names its entries give it in
 * the batch's ecosystem, as returned. `key` maps a returned name to its target's key, or undefined
 * for none. Entries in every ecosystem are validated; only the batch's ecosystem names targets. A
 * malformed entry, or a record naming no batched target, makes the batch untrusted.
 */
function batchNames(
  value: unknown,
  ecosystem: AdvisoryTarget['ecosystem'],
  kind: QueryKind,
  key: (name: string) => string | undefined,
): Map<string, string[]> {
  const named = new Map<string, string[]>();
  for (const entry of githubRecordBase(value, kind).vulnerabilities) {
    advisoryCheck(isPlainObject(entry) && isPlainObject(entry.package));
    const { ecosystem: listed, name } = entry.package;
    advisoryCheck(typeof listed === 'string' && advisoryText(name));
    const k = listed === ecosystem ? key(name) : undefined;
    if (k !== undefined) named.set(k, [...(named.get(k) ?? []), name]);
  }
  advisoryCheck(named.size > 0);
  return named;
}
function osvRange(entry: Record<string, unknown>): string {
  advisoryCheck(Array.isArray(entry.ranges) && entry.ranges.length === 1, 'conflict');
  const range: unknown = entry.ranges[0];
  advisoryCheck(
    isPlainObject(range) && range.type === 'ECOSYSTEM' && Array.isArray(range.events),
    'conflict',
  );
  const events: Record<string, string> = {};
  for (const event of range.events as unknown[]) {
    advisoryCheck(isPlainObject(event) && Object.keys(event).length === 1, 'conflict');
    const [kind, version] = Object.entries(event)[0];
    advisoryCheck(
      ['introduced', 'fixed', 'last_affected'].includes(kind) &&
        !(kind in events) &&
        advisoryText(version),
      'conflict',
    );
    events[kind] = version;
  }
  advisoryCheck(
    'introduced' in events && !('fixed' in events && 'last_affected' in events),
    'conflict',
  );
  return [
    ...(events.introduced === '0' ? [] : [`>= ${events.introduced}`]),
    ...('fixed' in events ? [`< ${events.fixed}`] : []),
    ...('last_affected' in events ? [`<= ${events.last_affected}`] : []),
  ].join(', ');
}
/** Keeps only GitHub-reviewed GHSA records; other OSV records are outside S1's checked scope. */
function osvRecord(value: unknown, t: AdvisoryTarget): AdvisoryRecord | null {
  advisoryCheck(isPlainObject(value));
  const db = value.database_specific;
  if (typeof value.id !== 'string' || !GHSA_ID.test(value.id)) return null;
  if (!isPlainObject(db) || db.github_reviewed !== true) return null;
  advisoryCheck(advisoryText(value.summary));
  const withdrawn = value.withdrawn;
  advisoryCheck(
    withdrawn === undefined ||
      withdrawn === null ||
      (typeof withdrawn === 'string' && Number.isFinite(Date.parse(withdrawn))),
  );
  advisoryCheck(Array.isArray(value.affected));
  const entries = packageEntries(
    value.affected.map((a) =>
      isPlainObject(a) && isPlainObject(a.package) && a.package.ecosystem === 'PyPI'
        ? { ...a, package: { ...a.package, ecosystem: 'pip' } }
        : null,
    ),
    t,
  );
  advisoryCheck(entries.length > 0, 'conflict');
  const range = joinRanges(entries.map(osvRange));
  advisoryCheck(
    db.severity === undefined ||
      db.severity === null ||
      ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'].includes(String(db.severity)),
  );
  return {
    id: value.id,
    url: `https://github.com/advisories/${value.id}`,
    title: value.summary,
    range,
    withdrawn: withdrawn !== undefined && withdrawn !== null,
    ...(typeof db.severity === 'string'
      ? { severity: db.severity.toLowerCase() as AdvisoryRecord['severity'] }
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
    response.status === HTTP_STATUS.tooManyRequests ||
    (response.status === HTTP_STATUS.forbidden &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        (retry !== null && /^\d+$/u.test(retry)) ||
        /secondary rate limit/iu.test(message)))
  )
    return 'rate_limit';
  if (
    response.status === HTTP_STATUS.unauthorized ||
    (response.status === HTTP_STATUS.forbidden &&
      [
        'Resource not accessible by integration',
        'Resource not accessible by personal access token',
      ].includes(message))
  )
    return 'permission';
  return response.status === HTTP_STATUS.notFound ? 'missing' : 'unknown';
}
/** The URL with its `per_page` set to `size`, every other parameter kept in place. */
function withPerPage(url: string, size: number): string {
  const result = new URL(url);
  result.searchParams.set('per_page', String(size));
  return result.href;
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
type Discovery = { forms: readonly string[] } | { failure: EvidenceReason };
const targetKey = (t: AdvisoryTarget) => JSON.stringify([t.ecosystem, t.name, t.version]);
/** A target's versioned query URL for these stored forms, at the reader's default page size. */
const versionedUrl = (t: AdvisoryTarget, kind: QueryKind, forms: readonly string[] = [t.name]) =>
  githubUrl(
    t.ecosystem,
    forms.map((f) => `${f}@${t.version}`),
    kind,
  );
class Reader implements AdvisoryReader {
  private requests = 0;
  private bytes = 0;
  private work = { entries: 0 };
  private readonly clock: BoundedClock;
  private busy = false;
  private closed = false;
  /** A rate limit stops only the provider that returned it, for the rest of the session. */
  private readonly providerStop: Record<Provider, EvidenceReason | null> = {
    github: null,
    osv: null,
  };
  private active: (() => void) | null = null;
  private readonly closing = new AbortController();
  /** The last rate-limited GitHub response this reader received, for its retry time. */
  private rateLimited: Response | null = null;
  private waits = 0;
  /** Base and head of one package reuse its discovery reads, including a failed one. */
  private readonly discoveries = new Map<string, Discovery>();
  /** Lookups `settle` decided, by target; `read` returns them without a request. */
  private readonly settled = new Map<string, AdvisoryLookup>();
  constructor(
    private limits: AdvisoryLimits,
    private deps: Dependencies,
    private kind: QueryKind,
  ) {
    this.clock = new BoundedClock(limits.totalTimeoutMs, deps);
  }
  close() {
    this.closed = true;
    this.closing.abort();
    this.active?.();
  }
  /**
   * The reason this reader refuses every further read: closed, or both providers rate-limited.
   * A rate limit from one provider stops only that provider's targets, which then fail alone.
   */
  stopReason(): EvidenceReason | null {
    if (this.closed) return 'unknown';
    return this.providerStop.github && this.providerStop.osv ? 'rate_limit' : null;
  }
  private remaining(provider: Provider) {
    const stopped = this.closed ? 'unknown' : this.providerStop[provider];
    advisoryCheck(!this.deps.signal?.aborted && !stopped, stopped ?? 'unknown');
    return this.clock.remaining(stopped);
  }
  private async body(
    response: Response,
    aborted: Promise<never>,
    provider: Provider,
    cached: boolean,
  ) {
    const ok = response.status === HTTP_STATUS.ok;
    advisoryCheck(response.body);
    const stream = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([stream.read(), aborted]);
        if (chunk.done) return Buffer.concat(chunks, size);
        size += chunk.value.byteLength;
        if (!cached) this.bytes += chunk.value.byteLength;
        advisoryCheck(cached || this.bytes <= this.limits.maxTotalBytes, 'budget');
        // Only a 200 page may be resent smaller; an error body over the cap fails as budget. The
        // oversized body's bytes, up to the cap plus the chunk that crossed it, stay charged to
        // the byte share above, so each resend costs one more request and those bytes.
        if (size > this.limits.maxResponseBytes)
          throw ok ? new ResponseTooLarge() : new AdvisoryFailure('budget');
        this.remaining(provider);
        chunks.push(chunk.value);
      }
    } finally {
      void stream.cancel().catch(() => {});
      stream.releaseLock();
    }
  }
  private stop(provider: Provider, reason: EvidenceReason, response?: Response): never {
    if (reason === 'rate_limit') {
      this.providerStop[provider] = reason;
      if (response) this.rateLimited = response;
    }
    throw new AdvisoryFailure(reason);
  }
  private async page(
    provider: Provider,
    url: string,
    json?: unknown,
  ): Promise<{ data: unknown; link: string | null }> {
    for (;;) {
      try {
        return await this.pageOnce(provider, url, json);
      } catch (error) {
        if (!(await this.waitedForRetry(provider, error))) throw error;
      }
    }
  }
  /**
   * After a GitHub rate limit this reader received, waits once for its retry time when that fits
   * and lifts the GitHub stop for the resend. Otherwise records the stop's retry time. An OSV rate
   * limit never waits.
   */
  private async waitedForRetry(provider: Provider, error: unknown): Promise<boolean> {
    const quota = this.deps.quota;
    const response = this.rateLimited;
    if (provider !== 'github' || !quota || !response) return false;
    if (!(error instanceof AdvisoryFailure) || error.reason !== 'rate_limit') return false;
    const retryAt = quota.retryAt(response);
    // No time left means the wait cannot fit: the stop stays a rate limit with its retry time.
    let left = 0;
    try {
      left = this.clock.remaining(this.closed ? 'unknown' : null);
    } catch {
      left = 0;
    }
    let fits = false;
    try {
      fits =
        this.waits < limit('research.githubQuota.waitsPerReader') &&
        (await waitForRetry(quota, retryAt, {
          remainingMs: left,
          requestTimeoutMs: this.limits.requestTimeoutMs,
          signal: AbortSignal.any(
            [this.closing.signal, this.deps.signal].filter((s): s is AbortSignal => !!s),
          ),
        }));
    } catch {
      this.providerStop.github = 'rate_limit';
      throw new AdvisoryFailure('unknown');
    }
    if (!fits) {
      quota.recordStop(retryAt);
      return false;
    }
    this.waits += 1;
    this.providerStop.github = null;
    return true;
  }
  private async pageOnce(
    provider: Provider,
    url: string,
    json?: unknown,
  ): Promise<{ data: unknown; link: string | null }> {
    if (provider === 'github') this.rateLimited = null;
    this.remaining(provider);
    return boundedGet(
      this.deps,
      {
        url,
        headers:
          provider === 'osv'
            ? { accept: 'application/json' }
            : { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
        timeoutMs: Math.min(this.remaining(provider), this.limits.requestTimeoutMs),
        json,
        charge: () =>
          advisoryCheck(
            ++this.requests <= Math.min(this.limits.maxRequests, this.limits.maxPages),
            'budget',
          ),
      },
      (cancel) => {
        this.active = cancel;
      },
      async (response, aborted, cached) => {
        this.remaining(provider);
        advisoryCheck(
          !response.redirected && (!response.url || response.url === url),
          'unsupported',
        );
        advisoryCheck(
          response.status < HTTP_STATUS.redirectMin ||
            response.status >= HTTP_STATUS.clientErrorMin,
          'unsupported',
        );
        if (httpReason(response, null) === 'rate_limit')
          this.stop(provider, 'rate_limit', response);
        const bytes = await this.body(response, aborted, provider, cached);
        let data: unknown;
        try {
          data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          throw new AdvisoryFailure(
            response.status === HTTP_STATUS.ok ? 'malformed' : httpReason(response, null),
          );
        }
        if (response.status !== HTTP_STATUS.ok)
          this.stop(provider, httpReason(response, data), response);
        advisoryCheck(
          /^application\/(?:json|vnd.github\+json)(?:\s*;|$)/iu.test(
            response.headers.get('content-type') ?? '',
          ),
          'unsupported',
        );
        data = copyAdvisoryData(data, this.limits, this.work);
        this.remaining(provider);
        return { data, link: response.headers.get('link') };
      },
    );
  }
  private retain(records: AdvisoryRecord[], record: AdvisoryRecord) {
    advisoryCheck(records.length < this.limits.maxFindings, 'budget');
    advisoryCheck(
      Buffer.byteLength(JSON.stringify([...records, record])) <= this.limits.maxRetainedBytes,
      'budget',
    );
    records.push(record);
  }
  /** One exact OSV query; its `{}` answer is a complete page with no records. */
  private async osv(t: AdvisoryTarget, records: AdvisoryRecord[]) {
    const query = { package: { ecosystem: 'PyPI', name: t.name }, version: t.version };
    const tokens = new Set<string>();
    let token: string | undefined;
    for (;;) {
      const { data } = await this.page(
        'osv',
        OSV_QUERY_URL,
        token === undefined ? query : { ...query, page_token: token },
      );
      advisoryCheck(
        isPlainObject(data) &&
          Object.keys(data).every((k) => k === 'vulns' || k === 'next_page_token') &&
          (data.vulns === undefined || Array.isArray(data.vulns)) &&
          (data.next_page_token === undefined || advisoryText(data.next_page_token)),
      );
      for (const value of (data.vulns as unknown[] | undefined) ?? []) {
        const record = osvRecord(value, t);
        if (record) this.retain(records, record);
      }
      if (data.next_page_token === undefined) return;
      token = data.next_page_token as string;
      advisoryCheck(!tokens.has(token), 'conflict');
      tokens.add(token);
    }
  }
  /**
   * Every page of one GitHub query, from the original URL through validated cursors. With
   * `sizes`, a page-size ladder whose first size is the URL's `per_page`: a page over the
   * per-response cap is retried at the same cursor at the next smaller size, and the rest of the
   * query keeps that size. Only a 200 page is resent. Every retry is an ordinary charged request,
   * and the oversized body it replaces stays charged to the byte share, up to the per-response
   * cap plus the chunk that crossed it.
   */
  private async github(
    url: string,
    each: (value: unknown) => void,
    cap?: number,
    sizes: readonly number[] = [],
  ) {
    let query = url;
    let next: string | null = url;
    const seen = new Set<string>();
    while (next) {
      advisoryCheck(cap === undefined || next.length <= cap, 'budget');
      seen.add(next);
      let page: Awaited<ReturnType<Reader['page']>>;
      try {
        page = await this.page('github', next);
      } catch (error) {
        const perPage = Number(new URL(next).searchParams.get('per_page'));
        const smaller = sizes.find((size) => size < perPage);
        if (!(error instanceof ResponseTooLarge) || smaller === undefined) throw error;
        query = withPerPage(query, smaller);
        next = withPerPage(next, smaller);
        continue;
      }
      advisoryCheck(Array.isArray(page.data));
      for (const value of page.data) each(value);
      next = continuation(page.link, query, seen);
    }
  }
  /** The stored spellings of the target's package, from package-only queries. */
  private async discover(t: AdvisoryTarget): Promise<string[]> {
    const forms = new Set<string>();
    for (const url of discoveryUrls(
      t.ecosystem,
      discoverySpellings(t.ecosystem, t.name),
      this.kind,
    )) {
      let found = this.discoveries.get(url);
      if (!found) {
        const names: string[] = [];
        try {
          await this.github(
            url,
            (value) => names.push(...storedForms(value, t, this.kind)),
            DISCOVERY_URL_CAP,
            DISCOVERY_PAGE_SIZES,
          );
          found = { forms: names };
        } catch (error) {
          found = { failure: error instanceof AdvisoryFailure ? error.reason : 'unknown' };
        }
        this.discoveries.set(url, found);
      }
      if ('failure' in found) throw new AdvisoryFailure(found.failure);
      for (const form of found.forms) forms.add(form);
    }
    return [...forms].sort();
  }
  async read(value: unknown): Promise<AdvisoryLookup> {
    if (this.busy)
      return {
        target: { ecosystem: 'npm', name: '', version: '' },
        url: '',
        status: 'unavailable',
        complete: false,
        records: [],
        reasons: ['conflict'],
      };
    this.busy = true;
    try {
      let t: AdvisoryTarget;
      try {
        t = target(value);
      } catch (error) {
        return await this.lookup({ ecosystem: 'npm', name: '', version: '' }, () => {
          throw error;
        });
      }
      return this.settled.get(targetKey(t)) ?? (await this.query(t));
    } finally {
      this.busy = false;
    }
  }
  /** One target's own lookup: OSV for `pip` reviewed, else its GitHub versioned query. */
  private query(t: AdvisoryTarget): Promise<AdvisoryLookup> {
    return this.lookup(t, async (records, cite) => {
      if (t.ecosystem === 'pip' && this.kind === 'reviewed') {
        cite(OSV_QUERY_URL);
        await this.osv(t, records);
        return;
      }
      const forms = t.ecosystem === 'npm' ? [t.name] : await this.discover(t);
      await this.versioned(t, forms, records, cite);
    });
  }
  /** The versioned query for these stored forms, or for the target's own name when none. */
  private async versioned(
    t: AdvisoryTarget,
    forms: readonly string[],
    records: AdvisoryRecord[],
    cite: (url: string) => void,
  ) {
    const url = versionedUrl(t, this.kind, forms.length ? forms : [t.name]);
    advisoryCheck(url.length <= PACKET_LIMITS.identityBytes, 'unsupported');
    cite(url);
    await this.github(url, (value) => this.retain(records, normalize(value, t, this.kind)));
  }
  /** The lookup `work` ends in: complete when it returns, else incomplete with its reason. */
  private async lookup(
    t: AdvisoryTarget,
    work: (records: AdvisoryRecord[], cite: (url: string) => void) => Promise<void> | void,
  ): Promise<AdvisoryLookup> {
    let url = '';
    const records: AdvisoryRecord[] = [];
    try {
      await work(records, (cited) => {
        url = cited;
      });
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
    }
  }
  /**
   * Keeps a complete lookup for `t` from a complete batch: `found` are the records the batch
   * attributes to it, and `url` the unfetched query whose complete result this equals.
   */
  private async fromBatch(t: AdvisoryTarget, url: string, found: readonly AdvisoryRecord[] = []) {
    const lookup = await this.lookup(t, (records, cite) => {
      cite(url);
      for (const record of found) this.retain(records, record);
    });
    if (lookup.complete) this.settled.set(targetKey(t), freeze({ ...lookup, batched: true }));
  }
  isSettled(value: unknown): boolean {
    try {
      return this.settled.has(targetKey(target(value)));
    } catch {
      return false;
    }
  }
  async settle(values: readonly unknown[]): Promise<number | null> {
    if (this.busy) return null;
    this.busy = true;
    const before = this.settled.size;
    try {
      const pending = new Map<string, AdvisoryTarget>();
      for (const value of values) {
        let t: AdvisoryTarget;
        try {
          t = target(value);
        } catch {
          continue;
        }
        const key = targetKey(t);
        // A target whose own URL is over the citation bound is left to `read`, which refuses it.
        const long = versionedUrl(t, this.kind).length > PACKET_LIMITS.identityBytes;
        if (!this.settled.has(key) && !long) pending.set(key, t);
      }
      const targets = [...pending.values()];
      await this.settleNpm(targets.filter((t) => t.ecosystem === 'npm'));
      // D1: `pip` reviewed lookups go to OSV unbatched. Actions malware keeps per-target lookups
      // (Approved Batch Values in the policy signals spec).
      const discovered = this.kind === 'reviewed' ? 'actions' : 'pip';
      await this.settleDiscovery(targets.filter((t) => t.ecosystem === discovered));
      return this.settled.size - before;
    } finally {
      this.busy = false;
    }
  }
  /**
   * npm versioned batches. Targets are layered so that no batch lists two versions of one
   * package, since a record naming that package could not say which version it affects.
   */
  private async settleNpm(targets: readonly AdvisoryTarget[]) {
    const layers: AdvisoryTarget[][] = [];
    for (const t of targets) {
      const layer = layers.find((l) => l.every((o) => o.name !== t.name));
      if (layer) layer.push(t);
      else layers.push([t]);
    }
    for (const layer of layers) {
      const byAffects = new Map(layer.map((t) => [`${t.name}@${t.version}`, t]));
      const { batches } = advisoryBatches('npm', [...byAffects.keys()], this.kind);
      for (const batch of batches) await this.npmBatch(batch.map((a) => byAffects.get(a)!));
    }
  }
  /**
   * One complete npm batch clears the targets no record names and attributes each record that
   * names exactly one batched package to it; targets named by a record naming several get their
   * singleton queries at once (S1 Batched Lookup items 3 to 6, as D2 amends them). An incomplete
   * or untrusted batch settles nothing.
   */
  private async npmBatch(batch: readonly AdvisoryTarget[]) {
    const byName = new Map(batch.map((t) => [t.name, t]));
    const attributed = new Map<string, AdvisoryRecord[]>();
    const shared = new Set<string>();
    try {
      const values: unknown[] = [];
      const affects = batch.map((t) => `${t.name}@${t.version}`);
      const url = batchUrl('npm', affects, this.kind);
      await this.github(url, (value) => values.push(value), BATCH_URL_BYTES, BATCH_PAGE_SIZES);
      for (const value of values) {
        // npm names are compared exactly as the query sent them.
        const named = [
          ...batchNames(value, 'npm', this.kind, (n) => (byName.has(n) ? n : undefined)).keys(),
        ];
        // Every record validates as each named target's singleton would, attributed or not.
        const records = named.map((name) => normalize(value, byName.get(name)!, this.kind));
        if (named.length > 1) for (const name of named) shared.add(name);
        else attributed.set(named[0], [...(attributed.get(named[0]) ?? []), records[0]]);
      }
    } catch {
      return;
    }
    for (const t of batch)
      if (!shared.has(t.name))
        await this.fromBatch(t, versionedUrl(t, this.kind), attributed.get(t.name));
    // A singleton's result decides even when it fails: it is kept, so `read` does not resend it.
    for (const t of batch)
      if (shared.has(t.name)) this.settled.set(targetKey(t), await this.query(t));
  }
  /**
   * Discovery batches over every spelling of these targets (S1 Batching Reconciliation D3).
   * Packages share a batch while all their spellings fit one discovery request; a package whose
   * spellings need several requests is a batch of its own. So one failed or oversized page drops
   * only its own batch back to per-target discovery.
   */
  private async settleDiscovery(targets: readonly AdvisoryTarget[]) {
    const packages = discoveryPackages(targets, this.kind);
    if (!packages.size) return;
    const ecosystem = targets[0].ecosystem;
    const { batches, unbatched } = splitBatches([...packages], BATCH_MAX_TARGETS, (batch) => {
      const spellings = batch.flatMap(([, p]) => p.spellings);
      return (
        spellings.length <= BATCH_MAX_TARGETS &&
        discoveryUrls(ecosystem, spellings, this.kind).length === 1
      );
    });
    for (const batch of [...batches, ...unbatched.map((p) => [p])])
      await this.discoveryBatch(ecosystem, new Map(batch));
  }
  /**
   * One discovery batch. A complete batch clears each target no record names, citing its
   * unfetched versioned URL, and sends each named target its versioned query for the batch's
   * stored forms; discovery never attributes a record. An incomplete batch settles nothing: a
   * page failed or did not validate, a record named no batched package, or a spelling of a
   * batched target was not in a fetched URL.
   */
  private async discoveryBatch(
    ecosystem: AdvisoryTarget['ecosystem'],
    packages: ReadonlyMap<string, DiscoveryPackage>,
  ) {
    const all = [...packages.values()];
    const forms = new Map<string, Set<string>>();
    const nameKey = (name: string) => {
      const key = canonicalName(ecosystem, name);
      return packages.has(key) ? key : undefined;
    };
    try {
      const fetched = new Set<string>();
      const planned = discoveryUrls(
        ecosystem,
        all.flatMap((p) => p.spellings),
        this.kind,
      );
      for (const url of this.deps.discoveryPlan?.(planned) ?? planned) {
        advisoryCheck(planned.includes(url));
        const values: unknown[] = [];
        await this.github(
          url,
          (value) => values.push(value),
          DISCOVERY_URL_CAP,
          DISCOVERY_PAGE_SIZES,
        );
        for (const value of values)
          for (const [key, names] of batchNames(value, ecosystem, this.kind, nameKey))
            forms.set(key, new Set([...(forms.get(key) ?? []), ...names]));
        for (const s of new URL(url).searchParams.get('affects')!.split(',')) fetched.add(s);
      }
      // Complete only when every spelling of every batched target was fetched.
      advisoryCheck(all.every((p) => p.spellings.every((s) => fetched.has(s))));
    } catch {
      return;
    }
    await this.settleFound(packages, forms);
  }
  /** Settles a complete discovery batch's targets from the stored forms it found. */
  private async settleFound(
    packages: ReadonlyMap<string, DiscoveryPackage>,
    forms: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    for (const [key, { targets: named }] of packages) {
      const stored = [...(forms.get(key) ?? [])].sort();
      // A hit's versioned query decides even when it fails, as per-target discovery's would.
      for (const t of named)
        if (!stored.length) await this.fromBatch(t, versionedUrl(t, this.kind));
        else
          this.settled.set(
            targetKey(t),
            await this.lookup(t, (records, cite) => this.versioned(t, stored, records, cite)),
          );
    }
  }
}
type DiscoveryPackage = { spellings: string[]; targets: AdvisoryTarget[] };
/**
 * Discovery targets by canonical package name, each package with every spelling its targets
 * send. A target per-target discovery would refuse, over the spelling ceiling or the URL cap, is
 * left out for `read` to refuse.
 */
function discoveryPackages(targets: readonly AdvisoryTarget[], kind: QueryKind) {
  const packages = new Map<string, DiscoveryPackage>();
  for (const t of targets) {
    let spellings: string[];
    try {
      spellings = discoverySpellings(t.ecosystem, t.name);
      discoveryUrls(t.ecosystem, spellings, kind);
    } catch {
      continue;
    }
    const key = canonicalName(t.ecosystem, t.name);
    const entry = packages.get(key) ?? { spellings: [], targets: [] };
    entry.spellings.push(...spellings.filter((s) => !entry.spellings.includes(s)));
    entry.targets.push(t);
    packages.set(key, entry);
  }
  return packages;
}
function createReader(
  limits: unknown,
  dependencies: Dependencies,
  kind: QueryKind,
): ({ kind: 'ready' } & AdvisoryReader) | { kind: 'invalid' } {
  try {
    const reader = new Reader(advisoryLimits(limits), dependencies, kind);
    return Object.freeze({
      kind: 'ready',
      read: (value: unknown) => reader.read(value),
      settle: (targets: readonly unknown[]) => reader.settle(targets),
      isSettled: (target: unknown) => reader.isSettled(target),
      close: () => reader.close(),
      stopped: () => reader.stopReason(),
    });
  } catch {
    return { kind: 'invalid' };
  }
}
export function createAdvisoryReader(limits: unknown, dependencies: Dependencies) {
  return createReader(limits, dependencies, 'reviewed');
}
export function createMalwareReader(limits: unknown, dependencies: Dependencies) {
  return createReader(limits, dependencies, 'malware');
}
