import {
  classifyPullRequest,
  parseReviewBinding,
  record,
  type ReviewBinding,
  type RepositoryIdentity,
} from './event.js';
import { PACKET_LIMITS, type EvidenceReason } from './schema.js';

export type GithubReadLimits = Readonly<{
  maxRequests: number;
  maxPages: number;
  maxFiles: number;
  maxJsonEntries: number;
  maxResponseBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxRetainedBytes: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}>;
export type GithubReadDependencies = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}>;
type Failure = Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;
export type GithubFileChange = Readonly<{
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  blobSha: string | null;
}>;
export type GithubDiscovery = Readonly<{
  kind: 'available' | 'partial' | 'unavailable' | 'obsolete';
  binding: ReviewBinding;
  files: readonly GithubFileChange[];
  complete: boolean;
  reasons: readonly EvidenceReason[];
}>;
export type GithubFileRequest = Readonly<{ side: 'base' | 'head'; path: string }>;
type FileProvenance = Readonly<{
  side: 'base' | 'head';
  repository: RepositoryIdentity;
  commitSha: string;
  path: string;
}>;
export type GithubFileResult =
  | { kind: 'invalid' }
  | (FileProvenance &
      (
        | { kind: 'available'; blobSha: string; bytes: Uint8Array }
        | { kind: 'absent'; treeSha: string }
        | Failure
      ));
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type GithubComparison = Readonly<{
  kind: 'available' | 'partial' | 'unavailable';
  repository: RepositoryIdentity;
  baseSha: string;
  headRepository: RepositoryIdentity;
  headSha: string;
  mergeBaseSha: string;
  records: readonly Readonly<Record<string, JsonValue>>[];
  reasons: readonly EvidenceReason[];
}>;
export type GithubReadSession = Readonly<{
  discoverFiles: () => Promise<GithubDiscovery>;
  readFile: (request: unknown) => Promise<GithubFileResult>;
  readComparison: () => Promise<GithubComparison>;
  close: () => void;
}>;
export type GithubReadCreation =
  | { kind: 'invalid' }
  | { kind: 'obsolete' }
  | Failure
  | { kind: 'ready'; binding: ReviewBinding; session: GithubReadSession };

const ORIGIN = 'https://api.github.com';
const LIMIT_KEYS = [
  'maxRequests',
  'maxPages',
  'maxFiles',
  'maxJsonEntries',
  'maxResponseBytes',
  'maxFileBytes',
  'maxTotalBytes',
  'maxRetainedBytes',
  'requestTimeoutMs',
  'totalTimeoutMs',
] as const;
const TYPE_FOR_MODE: Readonly<Record<string, string>> = {
  '040000': 'tree',
  '100644': 'blob',
  '100755': 'blob',
  '120000': 'blob',
  '160000': 'commit',
};
class ReadFailure extends Error {
  constructor(
    readonly reason: EvidenceReason,
    readonly obsolete = false,
  ) {
    super(reason);
  }
}
function requireRead(condition: unknown, reason: EvidenceReason = 'malformed'): asserts condition {
  if (!condition) throw new ReadFailure(reason);
}
function fixedFailure(error: unknown): Failure {
  return { kind: 'unavailable', reason: error instanceof ReadFailure ? error.reason : 'unknown' };
}
function parseLimits(value: unknown): GithubReadLimits | null {
  if (!record(value)) return null;
  const copy: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return null;
    copy[key] = n;
  }
  const limits = copy as GithubReadLimits;
  if (
    limits.maxResponseBytes > limits.maxTotalBytes ||
    limits.maxFileBytes > limits.maxTotalBytes ||
    limits.requestTimeoutMs > limits.totalTimeoutMs
  )
    return null;
  return Object.freeze(limits);
}
function repoPath(repo: RepositoryIdentity): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
function httpReason(response: Response, body: unknown): EvidenceReason {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const retry = response.headers.get('retry-after');
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (remaining === '0' ||
        (retry !== null && /^\d+$/u.test(retry) && Number.isSafeInteger(Number(retry)))))
  )
    return 'rate_limit';
  if (response.status === 404) return 'missing';
  if (
    response.status === 401 ||
    (response.status === 403 &&
      record(body) &&
      typeof body.message === 'string' &&
      [
        'Resource not accessible by integration',
        'Resource not accessible by personal access token',
      ].includes(body.message))
  )
    return 'permission';
  return 'unknown';
}

/** Undecodable or absent bodies keep the reason their HTTP status supports. */
function statusFailure(response: Response): EvidenceReason {
  return response.status === 200 ? 'malformed' : httpReason(response, null);
}
/** Node clamps oversized delays to 1 ms; chain platform-sized intervals instead. */
function startTimer(duration: number, expire: () => void): () => void {
  let remaining = duration;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const interval = Math.min(remaining, 2 ** 31 - 1);
    timer = setTimeout(() => {
      remaining -= interval;
      if (remaining > 0) schedule();
      else expire();
    }, interval);
  };
  schedule();
  return () => clearTimeout(timer);
}
function canonicalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= PACKET_LIMITS.identityBytes &&
    !value.includes('\\') &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !/^[a-z][a-z\d+.-]*:/iu.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function fullSha(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f\d]{40}$/iu.test(value) ? value.toLowerCase() : null;
}
function fileChange(value: unknown): GithubFileChange {
  requireRead(record(value));
  requireRead(canonicalPath(value.filename));
  const statuses = ['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'];
  requireRead(typeof value.status === 'string' && statuses.includes(value.status), 'unsupported');
  const previousPath = value.previous_filename ?? null;
  requireRead(previousPath === null || canonicalPath(previousPath));
  requireRead(
    value.status !== 'renamed' || (previousPath !== null && previousPath !== value.filename),
  );
  const blobSha = value.sha === undefined ? null : fullSha(value.sha);
  requireRead(value.sha === undefined || blobSha !== null);
  return Object.freeze({
    path: value.filename,
    previousPath,
    status: value.status as GithubFileChange['status'],
    blobSha,
  });
}
function fileRequest(value: unknown): GithubFileRequest | null {
  try {
    if (!record(value, ['side', 'path'])) return null;
    const side = value.side,
      path = value.path;
    return (side === 'base' || side === 'head') && canonicalPath(path) ? { side, path } : null;
  } catch {
    return null;
  }
}
function base64Size(content: string): number {
  requireRead(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(content));
  return (content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
}
/** Collectors receive deep-frozen records; unserializable structures stay unsupported. */
function frozenRecord(item: Record<string, unknown>): Readonly<Record<string, JsonValue>> {
  try {
    JSON.stringify(item);
  } catch {
    throw new ReadFailure('unsupported');
  }
  const pending: unknown[] = [item];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'object' && value !== null) {
      Object.freeze(value);
      for (const child of Object.values(value)) pending.push(child);
    }
  }
  return item as Readonly<Record<string, JsonValue>>;
}
function nextPage(headers: Headers, paths: readonly string[], page: number): boolean {
  const link = headers.get('link');
  if (link === null) return false;
  let next = false;
  let last: number | null = null;
  const seen = new Set<string>();
  for (const item of link.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/u.exec(item);
    requireRead(match, 'conflict');
    const [, target, rel] = match;
    requireRead(!seen.has(rel!), 'conflict');
    seen.add(rel!);
    const url = URL.parse(target!);
    requireRead(
      url &&
        url.origin === ORIGIN &&
        paths.includes(url.pathname) &&
        !url.hash &&
        !url.username &&
        !url.password,
      'conflict',
    );
    requireRead(
      url.searchParams.size === 2 && url.searchParams.get('per_page') === '100',
      'conflict',
    );
    const number = url.searchParams.get('page');
    requireRead(
      number && /^[1-9]\d*$/u.test(number) && Number.isSafeInteger(Number(number)),
      'conflict',
    );
    const n = Number(number);
    if (rel === 'next') {
      requireRead(n === page + 1, 'conflict');
      next = true;
    }
    if (rel === 'prev') requireRead(n === page - 1, 'conflict');
    if (rel === 'first') requireRead(n === 1, 'conflict');
    if (rel === 'last') {
      requireRead(n >= page, 'conflict');
      last = n;
    }
  }
  requireRead(!next || last === null || last > page, 'conflict');
  return next;
}

class ReadSession implements GithubReadSession {
  private requests = 0;
  private pages = 0;
  private files = 0;
  private busy = false;
  private bytes = 0;
  private entries = 0;
  private retained = 0;
  private stopped: EvidenceReason | null = null;
  private active: AbortController | null = null;
  private readonly started: number;
  private lastTime: number;
  constructor(
    readonly binding: ReviewBinding,
    private readonly limits: GithubReadLimits,
    private readonly dependencies: GithubReadDependencies,
  ) {
    this.started = this.lastTime = dependencies.now();
    requireRead(Number.isFinite(this.started), 'unknown');
  }
  close(): void {
    this.stopped ??= 'budget';
    this.active?.abort();
  }
  private elapsed(): number {
    const time = this.dependencies.now();
    requireRead(Number.isFinite(time) && time >= this.lastTime, 'unknown');
    this.lastTime = time;
    return time - this.started;
  }
  private check(): void {
    if (this.stopped) throw new ReadFailure(this.stopped);
    if (this.elapsed() >= this.limits.totalTimeoutMs) {
      this.stopped ??= 'timeout';
      this.active?.abort();
      throw new ReadFailure('timeout');
    }
  }
  private consumeEntries(value: unknown): void {
    const pending = [value];
    while (pending.length) {
      this.check();
      const item = pending.pop();
      if (typeof item === 'number') requireRead(Number.isFinite(item));
      if (typeof item !== 'object' || item === null) continue;
      const children = Object.values(item);
      this.entries += children.length;
      if (this.entries > this.limits.maxJsonEntries) {
        this.stopped ??= 'budget';
        throw new ReadFailure('budget');
      }
      for (const child of children) pending.push(child);
    }
  }
  private retain(value: unknown, bytes = 0): void {
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8') + bytes;
    if (size > this.limits.maxRetainedBytes - this.retained) {
      this.stopped ??= 'budget';
      throw new ReadFailure('budget');
    }
    this.retained += size;
  }
  private finishCollection<T, R>(rows: T[], result: () => R, noteBudget: () => void): R {
    let output = result();
    let size = Buffer.byteLength(JSON.stringify(output), 'utf8');
    const remaining = this.limits.maxRetainedBytes - this.retained;
    if (size > remaining) {
      noteBudget();
      this.stopped ??= 'budget';
      output = result();
      size = Buffer.byteLength(JSON.stringify(output), 'utf8');
      // Charge each removed row once; large prefix overflows must remain linear.
      while (rows.length && size > remaining) {
        const removed = rows.pop();
        size -= Buffer.byteLength(JSON.stringify(removed), 'utf8') + (rows.length ? 1 : 0);
        if (!rows.length) size = Buffer.byteLength(JSON.stringify(result()), 'utf8');
      }
      output = result();
    }
    if (size <= remaining) this.retained += size;
    return output;
  }
  private reserveRequest(): number {
    this.check();
    const remaining = this.limits.totalTimeoutMs - this.elapsed();
    if (remaining <= 0) {
      this.stopped ??= 'timeout';
      throw new ReadFailure('timeout');
    }
    if (this.requests >= this.limits.maxRequests) {
      this.stopped ??= 'budget';
      throw new ReadFailure('budget');
    }
    this.requests++;
    return Math.min(this.limits.requestTimeoutMs, remaining);
  }
  private async readBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    aborted: Promise<never>,
    controller: AbortController,
  ): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) return Buffer.concat(chunks, length);
      this.bytes += chunk.value.byteLength;
      length += chunk.value.byteLength;
      if (length > this.limits.maxResponseBytes || this.bytes > this.limits.maxTotalBytes) {
        this.stopped ??= 'budget';
        controller.abort();
        throw new ReadFailure('budget');
      }
      this.check();
      chunks.push(chunk.value);
    }
  }
  private parseBody(response: Response, body: Buffer): unknown {
    this.check();
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      throw new ReadFailure(statusFailure(response));
    }
    if (response.status !== 200) {
      this.consumeEntries(value);
      throw new ReadFailure(httpReason(response, value));
    }
    this.check();
    return value;
  }
  private async get(path: string): Promise<{ value: unknown; headers: Headers }> {
    const duration = this.reserveRequest();
    const controller = new AbortController();
    this.active = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let expired = false;
    const cancel = () => {
      if (reader) void reader.cancel().catch(() => {});
    };
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          cancel();
          reject(new ReadFailure(expired ? 'timeout' : 'budget'));
        },
        { once: true },
      );
    });
    const stopTimer = startTimer(duration, () => {
      expired = true;
      this.stopped ??= 'timeout';
      controller.abort();
    });
    try {
      const response = await Promise.race([
        this.dependencies
          .fetch(`${ORIGIN}${path}`, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
            },
          })
          .then((result) => {
            if (controller.signal.aborted) {
              void result.body?.cancel().catch(() => {});
              throw new ReadFailure('timeout');
            }
            return result;
          }),
        aborted,
      ]);
      if (response.body === null) throw new ReadFailure(statusFailure(response));
      reader = response.body.getReader();
      requireRead(!response.redirected, 'unknown');
      const body = await this.readBody(reader, aborted, controller);
      return { value: this.parseBody(response, body), headers: response.headers };
    } catch (error) {
      if (error instanceof ReadFailure) throw error;
      throw new ReadFailure(reader ? 'truncated' : 'unknown');
    } finally {
      stopTimer();
      cancel();
      if (this.active === controller) this.active = null;
    }
  }
  async metadata(): Promise<number> {
    const path = `${repoPath(this.binding.repository)}/pulls/${this.binding.pullNumber}`;
    const { value } = await this.get(path);
    this.consumeEntries(value);
    const state = classifyPullRequest(this.binding, value);
    if (state.kind === 'obsolete') throw new ReadFailure('conflict', true);
    if (state.kind === 'error')
      throw new ReadFailure(state.category === 'mismatch' ? 'conflict' : 'malformed');
    if (state.kind === 'compare') {
      const comparison = await this.get(
        `${repoPath(this.binding.repository)}/compare/${state.baseSha}...${this.binding.headSha}`,
      );
      this.consumeEntries(comparison.value);
      const checked = classifyPullRequest(this.binding, value, { value: comparison.value });
      if (checked.kind === 'obsolete') throw new ReadFailure('conflict', true);
      requireRead(checked.kind === 'current');
    }
    requireRead(
      record(value) &&
        typeof value.changed_files === 'number' &&
        Number.isSafeInteger(value.changed_files) &&
        value.changed_files >= 0,
    );
    return value.changed_files;
  }
  async discoverFiles(): Promise<GithubDiscovery> {
    const files: GithubFileChange[] = [];
    const reasons = new Set<EvidenceReason>();
    const result = (kind?: 'obsolete'): GithubDiscovery => ({
      kind: kind ?? (reasons.size === 0 ? 'available' : files.length ? 'partial' : 'unavailable'),
      binding: this.binding,
      files: kind === 'obsolete' ? [] : [...files],
      complete: kind !== 'obsolete' && reasons.size === 0,
      reasons: [...reasons],
    });
    if (this.busy) {
      reasons.add('conflict');
      return result();
    }
    this.busy = true;
    try {
      this.check();
      const count = await this.metadata();
      if (this.binding.baseSha !== this.binding.mergeBaseSha) reasons.add('conflict');
      try {
        await this.listFiles(count, files, reasons);
      } catch (error) {
        const reason = fixedFailure(error).reason;
        reasons.add(reason);
        if (reason === 'budget') this.stopped ??= 'budget';
      }
      requireRead((await this.metadata()) === count, 'conflict');
    } catch (error) {
      reasons.add(fixedFailure(error).reason);
      if (error instanceof ReadFailure && error.obsolete) {
        this.stopped ??= 'conflict';
        return result('obsolete');
      }
    } finally {
      this.busy = false;
    }
    return this.finishCollection(files, result, () => {
      reasons.add('budget');
    });
  }
  private async listFiles(
    count: number,
    files: GithubFileChange[],
    reasons: Set<EvidenceReason>,
  ): Promise<void> {
    const seen = { paths: new Set<string>(), previous: new Set<string>() };
    const path = `${repoPath(this.binding.repository)}/pulls/${this.binding.pullNumber}/files`;
    // GitHub's pagination links address the same endpoint by repository ID.
    const linkPaths = [
      path,
      `/repositories/${this.binding.repository.id}/pulls/${this.binding.pullNumber}/files`,
    ];
    for (let page = 1; ; page++) {
      requireRead(this.pages < this.limits.maxPages, 'budget');
      this.pages++;
      const response = await this.get(`${path}?per_page=100&page=${page}`);
      requireRead(Array.isArray(response.value) && response.value.length <= 100);
      for (const value of response.value) this.addFile(value, files, reasons, seen);
      const hasNext = nextPage(response.headers, linkPaths, page);
      if (files.length >= 3000) {
        reasons.add('truncated');
        return;
      }
      if (response.value.length < 100) {
        requireRead(!hasNext, 'conflict');
        requireRead(files.length === count, 'conflict');
        return;
      }
    }
  }
  private addFile(
    value: unknown,
    files: GithubFileChange[],
    reasons: Set<EvidenceReason>,
    seen: { paths: Set<string>; previous: Set<string> },
  ): void {
    requireRead(this.files < this.limits.maxFiles, 'budget');
    this.files++;
    this.consumeEntries([value]);
    const change = fileChange(value);
    requireRead(
      !seen.paths.has(change.path) &&
        (!change.previousPath || !seen.previous.has(change.previousPath)),
      'conflict',
    );
    seen.paths.add(change.path);
    if (change.previousPath) seen.previous.add(change.previousPath);
    files.push(change);
    if (!['added', 'removed', 'modified', 'renamed'].includes(change.status))
      reasons.add('unsupported');
  }
  async readFile(request: unknown): Promise<GithubFileResult> {
    const input = fileRequest(request);
    if (!input) return { kind: 'invalid' };
    const { side, path } = input;
    const repository = side === 'base' ? this.binding.repository : this.binding.headRepository;
    const commitSha = side === 'base' ? this.binding.baseSha : this.binding.headSha;
    const provenance: FileProvenance = { side, repository, commitSha, path };
    if (this.busy) return { ...provenance, kind: 'unavailable', reason: 'conflict' };
    this.busy = true;
    try {
      this.check();
      const prefix = repoPath(repository);
      let treeSha = await this.rootTree(prefix, commitSha);
      const segments = path.split('/');
      for (const [index, name] of segments.entries()) {
        const found = await this.treeEntry(prefix, treeSha, name);
        if (!found) {
          const absent = { ...provenance, kind: 'absent' as const, treeSha };
          this.retain(absent);
          return absent;
        }
        if (index < segments.length - 1) {
          requireRead(found.mode === '040000', 'unsupported');
          treeSha = found.sha;
          continue;
        }
        requireRead(found.mode === '100644' || found.mode === '100755', 'unsupported');
        const bytes = await this.blobBytes(prefix, found.sha);
        const metadata = { ...provenance, kind: 'available' as const, blobSha: found.sha };
        this.retain(metadata, bytes.length);
        return { ...metadata, bytes: new Uint8Array(bytes) };
      }
      throw new ReadFailure('unknown');
    } catch (error) {
      const failure = fixedFailure(error);
      if (failure.reason === 'budget') this.stopped ??= 'budget';
      return { ...provenance, ...failure };
    } finally {
      this.busy = false;
    }
  }
  private async rootTree(prefix: string, commitSha: string): Promise<string> {
    const { value: commit } = await this.get(`${prefix}/git/commits/${commitSha}`);
    this.consumeEntries(commit);
    requireRead(record(commit) && fullSha(commit.sha) === commitSha && record(commit.tree));
    const root = fullSha(commit.tree.sha);
    requireRead(root);
    return root;
  }
  private async treeEntry(
    prefix: string,
    treeSha: string,
    name: string,
  ): Promise<{ mode: string; sha: string } | null> {
    const { value: tree } = await this.get(`${prefix}/git/trees/${treeSha}`);
    this.consumeEntries(tree);
    requireRead(
      record(tree) &&
        fullSha(tree.sha) === treeSha &&
        typeof tree.truncated === 'boolean' &&
        Array.isArray(tree.tree),
    );
    requireRead(!tree.truncated, 'truncated');
    let found: { mode: string; sha: string } | null = null;
    for (const item of tree.tree) {
      requireRead(
        record(item) &&
          typeof item.path === 'string' &&
          item.path !== '' &&
          !item.path.includes('/') &&
          typeof item.mode === 'string' &&
          typeof item.type === 'string',
      );
      const sha = fullSha(item.sha);
      requireRead(sha);
      // Unrequested siblings may carry names or modes D1 never reads.
      if (item.path !== name) continue;
      requireRead(!found, 'conflict');
      requireRead(Object.hasOwn(TYPE_FOR_MODE, item.mode), 'unsupported');
      requireRead(TYPE_FOR_MODE[item.mode] === item.type);
      found = { mode: item.mode, sha };
    }
    return found;
  }
  private async blobBytes(prefix: string, sha: string): Promise<Buffer> {
    const { value: blob } = await this.get(`${prefix}/git/blobs/${sha}`);
    this.consumeEntries(blob);
    requireRead(
      record(blob) &&
        fullSha(blob.sha) === sha &&
        typeof blob.size === 'number' &&
        Number.isSafeInteger(blob.size) &&
        blob.size >= 0 &&
        typeof blob.content === 'string',
    );
    requireRead(blob.encoding === 'base64', 'unsupported');
    const content = blob.content.replace(/[\r\n]/gu, '');
    const size = base64Size(content);
    requireRead(size === blob.size);
    if (size > this.limits.maxFileBytes || size > this.limits.maxTotalBytes - this.bytes) {
      this.stopped ??= 'budget';
      throw new ReadFailure('budget');
    }
    this.bytes += size;
    const bytes = Buffer.from(content, 'base64');
    requireRead(bytes.length === size && bytes.toString('base64') === content);
    return bytes;
  }
  async readComparison(): Promise<GithubComparison> {
    const records: Readonly<Record<string, JsonValue>>[] = [];
    const reasons: EvidenceReason[] = [];
    const provenance = {
      repository: this.binding.repository,
      baseSha: this.binding.baseSha,
      headRepository: this.binding.headRepository,
      headSha: this.binding.headSha,
      mergeBaseSha: this.binding.mergeBaseSha,
    };
    const result = (): GithubComparison => ({
      ...provenance,
      kind: reasons.length === 0 ? 'available' : records.length ? 'partial' : 'unavailable',
      records: [...records],
      reasons: [...reasons],
    });
    if (this.busy) {
      reasons.push('conflict');
      return result();
    }
    this.busy = true;
    try {
      this.check();
      const response = await this.get(
        `${repoPath(this.binding.repository)}/dependency-graph/compare/${this.binding.baseSha}...${this.binding.headSha}`,
      );
      requireRead(Array.isArray(response.value));
      for (const item of response.value) {
        requireRead(record(item));
        this.consumeEntries([item]);
        records.push(frozenRecord(item));
      }
    } catch (error) {
      const reason = fixedFailure(error).reason;
      if (reason === 'budget') this.stopped ??= 'budget';
      reasons.push(reason);
    } finally {
      this.busy = false;
    }
    return this.finishCollection(records, result, () => {
      if (!reasons.includes('budget')) reasons.push('budget');
    });
  }
  async initialize(): Promise<void> {
    await this.metadata();
    this.retain({ binding: this.binding });
  }
}

/** A session shares caller-supplied budgets across every read; creation grants no write authority. */
export async function createGithubReadSession(
  input: unknown,
  dependencies: GithubReadDependencies,
): Promise<GithubReadCreation> {
  let binding: ReviewBinding | null;
  let limits: GithubReadLimits | null;
  try {
    if (!record(input, ['binding', 'limits'])) return { kind: 'invalid' };
    binding = parseReviewBinding(input.binding);
    limits = parseLimits(input.limits);
    if (!binding || !limits) return { kind: 'invalid' };
    for (const value of [
      binding.repository.owner,
      binding.repository.name,
      binding.headRepository.owner,
      binding.headRepository.name,
    ]) {
      if (Buffer.byteLength(value, 'utf8') > PACKET_LIMITS.identityBytes)
        return { kind: 'invalid' };
    }
  } catch {
    return { kind: 'invalid' };
  }
  try {
    const session = new ReadSession(binding, limits, dependencies);
    await session.initialize();
    return {
      kind: 'ready',
      binding,
      session: Object.freeze({
        discoverFiles: () => session.discoverFiles(),
        readFile: (request: unknown) => session.readFile(request),
        readComparison: () => session.readComparison(),
        close: () => session.close(),
      }),
    };
  } catch (error) {
    return error instanceof ReadFailure && error.obsolete
      ? { kind: 'obsolete' }
      : fixedFailure(error);
  }
}
