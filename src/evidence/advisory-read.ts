import { types } from 'node:util';
import { PACKET_LIMITS, type EvidenceReason, type EvidenceStatus } from '../schema.js';
import { freeze, isPlainObject } from './common.js';
import { BoundedClock, boundedGet } from './bounded-request.js';
import type { ResearchCache } from './research-cache.js';
import { HTTP_STATUS } from '../format.js';

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
  /** The reason this reader refuses all further reads, or null while it can still read. */
  stopped?: () => EvidenceReason | null;
}>;
type Dependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
  cache?: ResearchCache;
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
type QueryKind = 'reviewed' | 'malware';
type Provider = 'github' | 'osv';
const GHSA_ID = /^GHSA-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}$/u;
/** The OSV endpoint; a complete empty PyPI reviewed lookup cites it. */
export const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';
/** Approved register values for stored-name discovery (S1 Package Name Form Amendment). */
const DISCOVERY_PAGE_SIZE = '50';
const DISCOVERY_URL_CAP = 4096;
const DISCOVERY_CURSOR_HEADROOM = 256;
const SPELLING_CEILING = 243;
function githubUrl(
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
/** GitHub stores package names as each advisory spells them; compare them the way the ecosystem does. */
function canonical(ecosystem: AdvisoryTarget['ecosystem'], name: string): string {
  if (ecosystem === 'pip') return name.toLowerCase().replace(/[-_.]+/gu, '-');
  return ecosystem === 'actions' ? name.toLowerCase() : name;
}
/** Every spelling of a normalized PyPI name with each separator replaced by `-`, `_`, or `.`. */
function pipSpellings(name: string): string[] {
  const parts = name.split('-');
  advisoryCheck(3 ** (parts.length - 1) <= SPELLING_CEILING, 'unsupported');
  let spellings = [parts[0]];
  for (const part of parts.slice(1))
    spellings = spellings.flatMap((s) => ['-', '_', '.'].map((sep) => s + sep + part));
  return spellings;
}
/** Package-only discovery URLs, each with room left under the cap for a pagination cursor. */
function discoveryUrls(t: AdvisoryTarget, kind: QueryKind): string[] {
  const spellings = t.ecosystem === 'pip' ? pipSpellings(t.name) : [t.name];
  const limit = DISCOVERY_URL_CAP - DISCOVERY_CURSOR_HEADROOM;
  const urls: string[] = [];
  let chunk: string[] = [];
  for (const spelling of spellings) {
    if (githubUrl(t.ecosystem, [...chunk, spelling], kind, DISCOVERY_PAGE_SIZE).length <= limit) {
      chunk.push(spelling);
      continue;
    }
    advisoryCheck(chunk.length > 0, 'unsupported');
    urls.push(githubUrl(t.ecosystem, chunk, kind, DISCOVERY_PAGE_SIZE));
    chunk = [spelling];
  }
  urls.push(githubUrl(t.ecosystem, chunk, kind, DISCOVERY_PAGE_SIZE));
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
  const name = canonical(t.ecosystem, t.name);
  return value.filter(
    (v): v is Record<string, unknown> & { package: Record<string, unknown> } =>
      isPlainObject(v) &&
      isPlainObject(v.package) &&
      v.package.ecosystem === t.ecosystem &&
      typeof v.package.name === 'string' &&
      canonical(t.ecosystem, v.package.name) === name,
  );
}
function githubRecordBase(value: unknown, kind: QueryKind) {
  advisoryCheck(isPlainObject(value) && GHSA_ID.test(String(value.ghsa_id)));
  advisoryCheck(value.html_url === `https://github.com/advisories/${value.ghsa_id}`);
  advisoryCheck(value.type === kind, 'unsupported');
  advisoryCheck(Array.isArray(value.vulnerabilities));
  return value as Record<string, unknown> & { vulnerabilities: unknown[] };
}
function normalize(value: unknown, t: AdvisoryTarget, kind: QueryKind): AdvisoryRecord {
  const record = githubRecordBase(value, kind);
  advisoryCheck(advisoryText(record.summary));
  advisoryCheck(
    record.withdrawn_at === null ||
      (typeof record.withdrawn_at === 'string' && Number.isFinite(Date.parse(record.withdrawn_at))),
  );
  const matches = packageEntries(record.vulnerabilities, t);
  advisoryCheck(matches.length > 0, 'conflict');
  const ranges = matches.map((m) => m.vulnerable_version_range);
  advisoryCheck(ranges.every(advisoryText), 'conflict');
  const severity = severityOf(record.severity);
  return {
    id: String(record.ghsa_id),
    url: String(record.html_url),
    title: record.summary,
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
  /** Base and head of one package reuse its discovery reads, including a failed one. */
  private readonly discoveries = new Map<string, Discovery>();
  constructor(
    private limits: AdvisoryLimits,
    private deps: Dependencies,
    private kind: QueryKind,
  ) {
    this.clock = new BoundedClock(limits.totalTimeoutMs, deps);
  }
  close() {
    this.closed = true;
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
        advisoryCheck(
          size <= this.limits.maxResponseBytes &&
            (cached || this.bytes <= this.limits.maxTotalBytes),
          'budget',
        );
        this.remaining(provider);
        chunks.push(chunk.value);
      }
    } finally {
      void stream.cancel().catch(() => {});
      stream.releaseLock();
    }
  }
  private stop(provider: Provider, reason: EvidenceReason): never {
    if (reason === 'rate_limit') this.providerStop[provider] = reason;
    throw new AdvisoryFailure(reason);
  }
  private async page(
    provider: Provider,
    url: string,
    json?: unknown,
  ): Promise<{ data: unknown; link: string | null }> {
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
        if (httpReason(response, null) === 'rate_limit') this.stop(provider, 'rate_limit');
        const bytes = await this.body(response, aborted, provider, cached);
        let data: unknown;
        try {
          data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          throw new AdvisoryFailure(
            response.status === HTTP_STATUS.ok ? 'malformed' : httpReason(response, null),
          );
        }
        if (response.status !== HTTP_STATUS.ok) this.stop(provider, httpReason(response, data));
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
  /** Every page of one GitHub query, from the original URL through validated cursors. */
  private async github(url: string, each: (value: unknown) => void, cap?: number) {
    let next: string | null = url;
    const seen = new Set<string>();
    while (next) {
      advisoryCheck(cap === undefined || next.length <= cap, 'budget');
      seen.add(next);
      const page = await this.page('github', next);
      advisoryCheck(Array.isArray(page.data));
      for (const value of page.data) each(value);
      next = continuation(page.link, url, seen);
    }
  }
  /** The stored spellings of the target's package, from package-only queries. */
  private async discover(t: AdvisoryTarget): Promise<string[]> {
    const forms = new Set<string>();
    for (const url of discoveryUrls(t, this.kind)) {
      let found = this.discoveries.get(url);
      if (!found) {
        const names: string[] = [];
        try {
          await this.github(
            url,
            (value) => names.push(...storedForms(value, t, this.kind)),
            DISCOVERY_URL_CAP,
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
      if (t.ecosystem === 'pip' && this.kind === 'reviewed') {
        url = OSV_QUERY_URL;
        await this.osv(t, records);
      } else {
        const forms = t.ecosystem === 'npm' ? [t.name] : await this.discover(t);
        const affects = (forms.length ? forms : [t.name]).map((f) => `${f}@${t.version}`);
        const versioned = githubUrl(t.ecosystem, affects, this.kind);
        advisoryCheck(versioned.length <= PACKET_LIMITS.identityBytes, 'unsupported');
        url = versioned;
        await this.github(url, (value) => this.retain(records, normalize(value, t, this.kind)));
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
