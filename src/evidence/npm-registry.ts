import { types } from 'node:util';
import { createHash } from 'node:crypto';
import type { JsonValue } from '../github-read.js';
import {
  PACKET_LIMITS,
  type EvidenceReason,
  type PacketChange,
  type PacketSource,
  type NpmSide,
  type ChangeEvidence,
} from '../schema.js';
import type { NpmNode } from './npm.js';
import type { Finding } from '../policy.js';

export type NpmRegistryLimits = Readonly<{
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxJsonEntries: number;
  maxJsonDepth: number;
  maxRetainedBytes: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}>;
export type NpmRegistryDependencies = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
}>;
export type NpmMetadataDocument = Readonly<{
  name: string;
  version: string;
  url: string;
  data: Readonly<Record<string, JsonValue>>;
}>;
export type NpmMetadataResult =
  | { readonly kind: 'metadata'; readonly document: NpmMetadataDocument }
  | { readonly kind: 'unavailable'; readonly reason: EvidenceReason };
type Request = { name: string; version: string; integrity: string; source: string };
class RegistryFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
function requireMetadata(value: unknown, reason: EvidenceReason = 'malformed'): asserts value {
  if (!value) throw new RegistryFailure(reason);
}
function object(value: unknown): Record<string, unknown> {
  requireMetadata(value && typeof value === 'object' && !types.isProxy(value));
  requireMetadata(Object.getPrototypeOf(value) === Object.prototype);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireMetadata(typeof key === 'string' && 'value' in descriptor && descriptor.enumerable);
  }
  return value as Record<string, unknown>;
}
function parseLimits(value: unknown): NpmRegistryLimits {
  const r = object(value);
  const keys = [
    'maxRequests',
    'maxResponseBytes',
    'maxTotalBytes',
    'maxJsonEntries',
    'maxJsonDepth',
    'maxRetainedBytes',
    'requestTimeoutMs',
    'totalTimeoutMs',
  ] as const;
  requireMetadata(keys.every((k) => Number.isSafeInteger(r[k]) && (r[k] as number) > 0));
  requireMetadata((r.maxResponseBytes as number) <= (r.maxTotalBytes as number));
  requireMetadata((r.requestTimeoutMs as number) <= (r.totalTimeoutMs as number));
  return Object.fromEntries(keys.map((k) => [k, r[k]])) as NpmRegistryLimits;
}
function request(value: unknown): Request {
  const r = object(value),
    source = object(r.source);
  requireMetadata(
    typeof r.name === 'string' &&
      /^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu.test(r.name) &&
      r.name.length <= 256,
    'unsupported',
  );
  requireMetadata(
    typeof r.version === 'string' &&
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/iu.test(
        r.version,
      ) &&
      r.version.length <= 1024,
    'unsupported',
  );
  requireMetadata(source.kind === 'registry' && typeof source.identity === 'string', 'unsupported');
  let url: URL;
  try {
    url = new URL(source.identity);
  } catch {
    throw new RegistryFailure('unsupported');
  }
  requireMetadata(
    url.origin === 'https://registry.npmjs.org' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'unsupported',
  );
  requireMetadata(typeof r.integrity === 'string' && r.integrity.length > 0, 'missing');
  requireMetadata(r.integrity.length <= 1024 && hashes(r.integrity).length > 0, 'malformed');
  return { name: r.name, version: r.version, integrity: r.integrity, source: source.identity };
}
function hashes(value: string) {
  const lengths: Record<string, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  return value
    .trim()
    .split(/\s+/u)
    .flatMap((token) => {
      const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z\d+/]+={0,2})$/u.exec(token);
      if (!match) return [];
      const bytes = Buffer.from(match[2], 'base64');
      if (
        bytes.length !== lengths[match[1]] ||
        bytes.toString('base64').replace(/=+$/u, '') !== match[2].replace(/=+$/u, '')
      )
        return [];
      return [match[1] + ':' + bytes.toString('hex')];
    });
}
function bind(document: NpmMetadataDocument, r: Request): NpmMetadataResult {
  const dist = object(document.data.dist);
  const known = typeof dist.integrity === 'string' ? hashes(dist.integrity) : [];
  if (typeof dist.shasum === 'string' && /^[a-f\d]{40}$/iu.test(dist.shasum))
    known.push('sha1:' + dist.shasum.toLowerCase());
  requireMetadata(
    hashes(r.integrity).some((h) => known.includes(h)),
    'conflict',
  );
  return { kind: 'metadata', document };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Node clamps oversized delays; schedule long caller deadlines in platform-sized intervals. */
function timer(duration: number, expire: () => void) {
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
function statusReason(status: number): EvidenceReason {
  if (status >= 300 && status < 400) return 'unsupported';
  if (status === 401 || status === 403) return 'permission';
  if (status === 404) return 'missing';
  if (status === 429) return 'rate_limit';
  return 'unknown';
}
class RegistryReader {
  private readonly cache = new Map<string, NpmMetadataDocument>();
  private requests = 0;
  private bytes = 0;
  private entries = 0;
  private retained = 0;
  private busy = false;
  private stopped: EvidenceReason | null = null;
  private readonly started: number;
  private last: number;
  constructor(
    private readonly limits: NpmRegistryLimits,
    private readonly deps: NpmRegistryDependencies,
  ) {
    this.started = this.last = deps.now();
    requireMetadata(Number.isFinite(this.started), 'unknown');
  }
  private remaining() {
    if (this.deps.signal?.aborted) this.stopped ??= 'unknown';
    if (this.stopped) throw new RegistryFailure(this.stopped);
    const time = this.deps.now();
    requireMetadata(Number.isFinite(time) && time >= this.last, 'unknown');
    this.last = time;
    const remaining = this.limits.totalTimeoutMs - (time - this.started);
    if (remaining <= 0) {
      this.stopped = 'timeout';
      throw new RegistryFailure('timeout');
    }
    return remaining;
  }
  private consume(amount: number, field: 'bytes' | 'entries' | 'retained', maximum: number) {
    this[field] += amount;
    if (this[field] > maximum) {
      this.stopped = 'budget';
      throw new RegistryFailure('budget');
    }
  }
  private inspect(value: unknown) {
    const queue = [{ value, depth: 1 }];
    while (queue.length) {
      this.remaining();
      const item = queue.pop()!;
      requireMetadata(typeof item.value !== 'number' || Number.isFinite(item.value));
      if (!item.value || typeof item.value !== 'object') continue;
      requireMetadata(item.depth <= this.limits.maxJsonDepth, 'budget');
      const values = Object.values(item.value);
      this.consume(values.length, 'entries', this.limits.maxJsonEntries);
      for (const child of values) queue.push({ value: child, depth: item.depth + 1 });
    }
  }
  private parse(bytes: Buffer, r: Request, url: string): NpmMetadataDocument {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new RegistryFailure('malformed');
    }
    this.inspect(value);
    const data = object(value);
    requireMetadata(data.name === r.name && data.version === r.version, 'conflict');
    requireMetadata(data._id === r.name + '@' + r.version, 'unsupported');
    object(data.dist);
    if (data.scripts !== undefined) {
      const scripts = object(data.scripts);
      requireMetadata(Object.values(scripts).every((v) => typeof v === 'string'));
    }
    requireMetadata(data.gypfile === undefined || typeof data.gypfile === 'boolean');
    const doc = { name: r.name, version: r.version, url, data: data as Record<string, JsonValue> };
    this.consume(Buffer.byteLength(JSON.stringify(doc)), 'retained', this.limits.maxRetainedBytes);
    return freeze(doc);
  }
  private async body(response: Response, aborted: Promise<never>): Promise<Buffer> {
    requireMetadata(response.body, 'malformed');
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) return Buffer.concat(chunks, size);
        size += chunk.value.byteLength;
        this.consume(chunk.value.byteLength, 'bytes', this.limits.maxTotalBytes);
        if (size > this.limits.maxResponseBytes) {
          this.stopped = 'budget';
          throw new RegistryFailure('budget');
        }
        this.remaining();
        chunks.push(chunk.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async fetchDocument(r: Request): Promise<NpmMetadataDocument> {
    const duration = Math.min(this.limits.requestTimeoutMs, this.remaining());
    const controller = new AbortController();
    let rejectAbort: (error: RegistryFailure) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const stop = (reason: EvidenceReason) => {
      rejectAbort(new RegistryFailure(reason));
      controller.abort();
    };
    const cancel = () => {
      this.stopped = 'unknown';
      stop('unknown');
    };
    const clear = timer(duration, () => stop('timeout'));
    this.deps.signal?.addEventListener('abort', cancel, { once: true });
    const url = `https://registry.npmjs.org/${encodeURIComponent(r.name)}/${encodeURIComponent(r.version)}`;
    let response: Response | undefined;
    try {
      this.remaining();
      response = await Promise.race([
        this.deps.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        }),
        aborted,
      ]);
      requireMetadata(
        !response.redirected && (!response.url || response.url === url),
        'unsupported',
      );
      requireMetadata(response.status === 200, statusReason(response.status));
      requireMetadata(
        /^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? ''),
        'unsupported',
      );
      const bytes = await this.body(response, aborted);
      this.remaining();
      return this.parse(bytes, r, url);
    } finally {
      clear();
      this.deps.signal?.removeEventListener('abort', cancel);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  async read(value: unknown): Promise<NpmMetadataResult> {
    if (this.busy) return { kind: 'unavailable', reason: 'conflict' };
    this.busy = true;
    try {
      this.remaining();
      const r = request(value),
        key = JSON.stringify([r.name, r.version, r.source]);
      let document = this.cache.get(key);
      if (!document) {
        if (this.requests >= this.limits.maxRequests) {
          this.stopped = 'budget';
          throw new RegistryFailure('budget');
        }
        this.requests++;
        document = await this.fetchDocument(r);
        this.cache.set(key, document);
      }
      return freeze(bind(document, r));
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: error instanceof RegistryFailure ? error.reason : 'unknown',
      };
    } finally {
      this.busy = false;
    }
  }
}
/** Creates an attempt-local sequential reader. No I/O occurs until read(); limits are cumulative.
 * Only exact public package/version identity leaves the process; every cached use is integrity-bound.
 */
export function createNpmRegistryReader(
  limits: unknown,
  deps: NpmRegistryDependencies,
): { kind: 'invalid' } | { kind: 'ready'; read: (request: unknown) => Promise<NpmMetadataResult> } {
  try {
    const reader = new RegistryReader(parseLimits(limits), deps);
    return Object.freeze({ kind: 'ready', read: (value: unknown) => reader.read(value) });
  } catch {
    return { kind: 'invalid' };
  }
}

export type NpmLifecycleSide = Readonly<{ node: NpmNode; metadata: NpmMetadataResult }>;
export type NpmLifecycleResult = Readonly<{
  change: PacketChange;
  sources: readonly PacketSource[];
  findings: readonly Finding[];
}>;
type Commands = Partial<Record<'preinstall' | 'install' | 'postinstall', string>>;
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function commandText(value: string) {
  requireMetadata(Buffer.byteLength(value) <= PACKET_LIMITS.textBytes, 'budget');
  for (const char of value) {
    const code = char.codePointAt(0)!;
    requireMetadata(
      code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && (code < 127 || code > 159) && (code < 0xd800 || code > 0xdfff)),
    );
  }
}
function commands(data: NpmMetadataDocument['data']): Commands {
  const scripts = data.scripts === undefined ? {} : object(data.scripts);
  const result: Commands = {};
  for (const key of ['preinstall', 'install', 'postinstall'] as const) {
    const value = Object.hasOwn(scripts, key) ? scripts[key] : undefined;
    requireMetadata(value === undefined || typeof value === 'string');
    if (typeof value === 'string') {
      commandText(value);
      if (value) result[key] = value;
    }
  }
  return result;
}
function lifecycleSource(
  change: PacketChange,
  side: 'base' | 'head',
  instance: NpmSide,
  status: ChangeEvidence['status'],
  reason: EvidenceReason | null,
  excerpt: string,
  metadata = false,
): PacketSource {
  const id = 'npm:lifecycle:' + digest([change.id, side, metadata]);
  return {
    id,
    kind: metadata ? 'metadata' : 'install-script',
    ecosystems: ['npm'],
    memberIds: [change.id],
    status,
    reasons: reason ? [reason] : [],
    provenance:
      status === 'unavailable'
        ? { kind: 'unavailable' }
        : {
            kind: 'upstream',
            url: `https://registry.npmjs.org/${encodeURIComponent(instance.name)}/${encodeURIComponent(instance.version)}`,
            title: 'Exact-version npm install lifecycle metadata',
            excerpt,
            excerptTruncated: false,
            subjects: [{ memberId: change.id, side, value: instance.version }],
            range: null,
          },
  };
}
function inspectLifecycle(instance: NpmSide, side: NpmLifecycleSide | undefined) {
  requireMetadata(side && side.node.instance, 'missing');
  const result = side.metadata;
  if (result.kind === 'unavailable') throw new RegistryFailure(result.reason);
  const doc = result.document;
  requireMetadata(doc.name === instance.name && doc.version === instance.version, 'conflict');
  bind(
    doc,
    request({
      name: instance.name,
      version: instance.version,
      source: instance.source,
      integrity: side.node.integrity,
    }),
  );
  const explicit = commands(doc.data),
    hasCommands = Object.keys(explicit).length > 0;
  const signalled = side.node.hasInstallScript === true;
  requireMetadata(signalled ? hasCommands : !hasCommands && doc.data.gypfile !== true, 'conflict');
  return explicit;
}
function sideEvidence(
  change: PacketChange,
  side: 'base' | 'head',
  instance: NpmSide,
  input: NpmLifecycleSide | undefined,
) {
  try {
    const explicit = inspectLifecycle(instance, input);
    const excerpt = `Validated exact-version explicit lifecycle commands; canonical command-map SHA-256 ${digest(explicit)}. Implicit install behavior is outside this evidence.`;
    return {
      commands: explicit,
      source: lifecycleSource(change, side, instance, 'available', null, excerpt),
      side,
      instance,
    };
  } catch (error) {
    const reason = error instanceof RegistryFailure ? error.reason : 'unknown';
    const status =
      reason === 'conflict' && input?.metadata.kind === 'metadata' ? 'partial' : 'unavailable';
    return {
      commands: null,
      source: lifecycleSource(
        change,
        side,
        instance,
        status,
        reason,
        'Exact-version metadata could not reconcile the immutable install-lifecycle signal.',
      ),
      side,
      instance,
    };
  }
}
function lifecycleFinding(
  change: PacketChange,
  key: string,
  references: string[],
  detail: string,
  supplyChain = false,
): Finding {
  const common = {
    id: 'npm:lifecycle-finding:' + digest([change.id, key]),
    memberId: change.id,
    references,
    rationale:
      'Immutable lock signals and integrity-bound exact-version metadata determine explicit install-lifecycle evidence.',
    remediation: [
      'Review the exact-version install lifecycle and package source before accepting this change.',
    ],
    validation: [
      'Inspect the attributed base and proposed metadata without executing package scripts.',
    ],
  };
  return supplyChain
    ? { ...common, kind: 'supplyChainChange', change: 'install_script' }
    : { ...common, kind: 'informational', detail };
}
function lifecycleObservations(change: PacketChange, rows: ReturnType<typeof sideEvidence>[]) {
  const sources = rows.map((r) => r.source),
    findings: Finding[] = [];
  const references = [
    ...new Set(
      [change.from?.sourceId, change.to?.sourceId].filter((id): id is string => Boolean(id)),
    ),
  ];
  findings.push(
    lifecycleFinding(
      change,
      'scope',
      references,
      'Install lifecycle evidence covers explicit commands only; implicit installation behavior is outside this evidence.',
    ),
  );
  const head = rows.find((r) => r.side === 'head'),
    base = rows.find((r) => r.side === 'base');
  if (rows.some((r) => r.commands === null)) return { sources, findings };
  const added =
    head &&
    Object.entries(head.commands!).some(
      ([key, command]) => base?.commands?.[key as keyof Commands] !== command,
    );
  if (added)
    findings.push(
      lifecycleFinding(
        change,
        'changed',
        sources.map((s) => s.id),
        '',
        true,
      ),
    );
  else if (!head || (base && digest(base.commands) !== digest(head.commands))) {
    const observations = rows.map((r) =>
      lifecycleSource(
        change,
        r.side,
        r.instance,
        'available',
        null,
        'Explicit install lifecycle metadata retained for a removed package or removed commands.',
        true,
      ),
    );
    sources.push(...observations);
    findings.push(
      lifecycleFinding(
        change,
        'removed',
        observations.map((s) => s.id),
        'An installed package or explicit lifecycle commands were removed; no proposed install-script risk is inferred.',
      ),
    );
  }
  return { sources, findings };
}
/** Pure interpretation of authentic reader results and matching immutable N1 nodes.
 * Every existing side remains required; no command is executed or copied into an excerpt.
 */
export function interpretNpmLifecycle(
  change: PacketChange,
  input: Readonly<{ base?: NpmLifecycleSide; head?: NpmLifecycleSide }>,
): NpmLifecycleResult {
  if (change.ecosystem !== 'npm' || 'basis' in change)
    return freeze({ change: structuredClone(change), sources: [], findings: [] });
  const rows = [];
  if (change.from) rows.push(sideEvidence(change, 'base', change.from, input.base));
  if (change.to) rows.push(sideEvidence(change, 'head', change.to, input.head));
  const all = rows.every((r) => r.source.status === 'available');
  const some = rows.some((r) => r.source.status !== 'unavailable');
  const evidence: ChangeEvidence = {
    status: all ? 'available' : some ? 'partial' : 'unavailable',
    reasons: [...new Set(rows.flatMap((r) => r.source.reasons))].sort(),
    sourceIds: rows.map((r) => r.source.id),
  };
  const observations = lifecycleObservations(change, rows);
  return freeze({
    change: {
      ...structuredClone(change),
      evidence: { ...structuredClone(change.evidence), installScript: evidence },
    },
    ...observations,
  });
}
