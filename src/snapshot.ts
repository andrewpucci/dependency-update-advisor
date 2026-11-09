import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { loadTrustedReviewConfig, MAX_CONFIG_BYTES, type ConfigResult } from './config.js';
import {
  collectSourceContext,
  MAX_SOURCE_FILE_BYTES,
  validateSourceContextInput,
  type SourceContextResult,
} from './context.js';
import { record, type RepositoryIdentity } from './event.js';
import {
  DEPENDABOT_ROOT_LIMITS,
  parseDependabotRoots,
  type DependabotRootsOutcome,
} from './dependabot-roots.js';
import type { GithubRead, GithubTransport } from './runtime.js';
import type { EvidenceReason } from './schema.js';

const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 10_000;
const CONFIG_PATH = '.github/dependabot-review.json';

type SnapshotRead<T> =
  | { kind: 'available'; value: T }
  | { kind: 'unavailable'; reason?: EvidenceReason };
type SnapshotRepository = { visibility: 'public' | 'private'; defaultBranch: string };
type SnapshotCommit = { sha: string; treeSha: string };
/** One direct child of a listed directory; `path` is its name within that directory. */
export type SnapshotTreeEntry = Readonly<{
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}>;
export type SnapshotReads = {
  readRepository: (
    repository: RepositoryIdentity,
    signal?: AbortSignal,
  ) => Promise<SnapshotRead<SnapshotRepository>>;
  readCommit: (
    repository: RepositoryIdentity,
    ref: string,
    signal?: AbortSignal,
  ) => Promise<SnapshotRead<SnapshotCommit>>;
  readTree: (
    repository: RepositoryIdentity,
    sha: string,
    signal?: AbortSignal,
  ) => Promise<SnapshotRead<readonly SnapshotTreeEntry[]>>;
  readBlob: (
    repository: RepositoryIdentity,
    sha: string,
    signal?: AbortSignal,
  ) => Promise<SnapshotRead<Uint8Array>>;
};
export type ContextRevision = Readonly<{ repository: RepositoryIdentity; sha: string }>;
export type TrustedSnapshot = Readonly<{
  contextRevision: ContextRevision;
  visibility: 'public' | 'private';
  config: ConfigResult;
  collectContext: (
    dependencies: readonly { id: string; name: string }[],
  ) => Promise<SourceContextResult>;
  dependabotRoots: () => Promise<DependabotRootsOutcome>;
}>;
export type SnapshotRequest = Readonly<{
  repository: RepositoryIdentity;
  reads: SnapshotReads;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  temporaryRoot?: () => Promise<string>;
}>;
export type SnapshotResult<T> =
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'invalid-config'; config: ConfigResult }>
  | Readonly<{ kind: 'unavailable' }>;

type TreeEntry = SnapshotTreeEntry & { kind: 'tree' | 'file' | 'link' };

class Unavailable extends Error {
  constructor(readonly reason: EvidenceReason = 'unknown') {
    super(reason);
  }
}

function available<T>(value: T): SnapshotRead<T> {
  return { kind: 'available', value };
}

function unavailable<T>(reason?: EvidenceReason): SnapshotRead<T> {
  return reason ? { kind: 'unavailable', reason } : { kind: 'unavailable' };
}

function rawValue(read: GithubRead): unknown | null {
  return read.kind === 'available' ? read.value : null;
}

/** A transport failure keeps its reason; a response that fails validation is malformed. */
function readFailure<T>(read: GithubRead): SnapshotRead<T> {
  return unavailable(read.kind === 'unavailable' ? read.reason : 'malformed');
}

function decodedBlob(value: unknown): Uint8Array | null {
  if (
    !record(value, ['encoding', 'content']) ||
    value.encoding !== 'base64' ||
    typeof value.content !== 'string'
  )
    return null;
  const encoded = value.content.replace(/[\r\n]/gu, '');
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.toString('base64') === encoded ? new Uint8Array(bytes) : null;
}

/** Narrows the shared bounded transport to only the snapshot's authenticated reads. */
export function createGithubSnapshotReads(transport: GithubTransport): SnapshotReads {
  return {
    readRepository: async (repository, signal) => {
      const read = await transport.readRepository(repository, signal);
      const value = rawValue(read);
      if (
        !record(value, ['private', 'default_branch']) ||
        typeof value.private !== 'boolean' ||
        !validRef(value.default_branch)
      )
        return readFailure(read);
      return available({
        visibility: value.private ? 'private' : 'public',
        defaultBranch: value.default_branch,
      });
    },
    readCommit: async (repository, ref, signal) => {
      const read = await transport.readCommit(repository, ref, signal);
      const value = rawValue(read);
      if (
        !record(value, ['sha', 'commit']) ||
        !validSha(value.sha) ||
        !record(value.commit, ['tree']) ||
        !record(value.commit.tree, ['sha']) ||
        !validSha(value.commit.tree.sha)
      )
        return readFailure(read);
      return available({
        sha: value.sha.toLowerCase(),
        treeSha: value.commit.tree.sha.toLowerCase(),
      });
    },
    readTree: async (repository, sha, signal) => {
      const read = await transport.readTree(repository, sha, signal);
      const value = rawValue(read);
      if (
        !record(value, ['truncated', 'tree']) ||
        value.truncated !== false ||
        !Array.isArray(value.tree)
      )
        return record(value, ['truncated']) && value.truncated === true
          ? unavailable('truncated')
          : readFailure(read);
      const entries: SnapshotTreeEntry[] = [];
      for (const item of value.tree) {
        if (
          !record(item, ['path', 'mode', 'type', 'sha']) ||
          typeof item.path !== 'string' ||
          typeof item.mode !== 'string' ||
          typeof item.type !== 'string' ||
          typeof item.sha !== 'string'
        )
          return readFailure(read);
        entries.push({
          path: item.path,
          mode: item.mode,
          type: item.type,
          sha: item.sha,
          ...(typeof item.size === 'number' ? { size: item.size } : {}),
        });
      }
      return available(entries);
    },
    readBlob: async (repository, sha, signal) => {
      const read = await transport.readBlob(repository, sha, signal);
      const bytes = decodedBlob(rawValue(read));
      return bytes ? available(bytes) : readFailure(read);
    },
  };
}

function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{40}$/iu.test(value);
}

function validPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    Buffer.byteLength(path, 'utf8') <= 1024 &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

function validRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character === '\x7f')
  );
}

function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

function classifyEntry(value: SnapshotTreeEntry): TreeEntry | null {
  if (!validPath(value.path) || !validSha(value.sha)) return null;
  // A checkout without submodules leaves each gitlink as an empty directory.
  if (
    (value.mode === '040000' && value.type === 'tree') ||
    (value.mode === '160000' && value.type === 'commit')
  )
    return { ...value, kind: 'tree' };
  if (value.type !== 'blob' || !Number.isSafeInteger(value.size) || (value.size ?? -1) < 0)
    return null;
  if (value.mode === '100644' || value.mode === '100755') return { ...value, kind: 'file' };
  if (value.mode === '120000') return { ...value, kind: 'link' };
  return null;
}

/** Lists only the directories a requested path passes through, one bounded response each. */
class Tree {
  readonly entries = new Map<string, TreeEntry>();
  private readonly listings = new Map<string, Promise<void>>();
  private count = 0;

  constructor(
    private readonly rootSha: string,
    private readonly read: (sha: string) => Promise<SnapshotRead<readonly SnapshotTreeEntry[]>>,
    private readonly active: () => void,
  ) {}

  private list(directory: string, sha: string): Promise<void> {
    let listing = this.listings.get(directory);
    if (!listing) {
      listing = this.load(directory, sha);
      this.listings.set(directory, listing);
    }
    return listing;
  }

  private async load(directory: string, sha: string): Promise<void> {
    this.active();
    const result = await this.read(sha);
    this.active();
    if (result.kind !== 'available') throw new Unavailable(result.reason);
    this.count += result.value.length;
    if (this.count > MAX_TREE_ENTRIES) throw new Unavailable();
    const names = new Set<string>();
    for (const value of result.value) {
      if (!validName(value.path) || names.has(value.path)) throw new Unavailable();
      names.add(value.path);
      const entry = classifyEntry({
        ...value,
        path: directory ? `${directory}/${value.path}` : value.path,
      });
      if (!entry) throw new Unavailable();
      this.entries.set(entry.path, entry);
    }
  }

  /** Undefined when the path, or a prefix that must be a listable directory, is absent. */
  async get(path: string): Promise<TreeEntry | undefined> {
    const parts = path.split('/');
    let directory = '';
    let sha = this.rootSha;
    for (let index = 0; ; index += 1) {
      await this.list(directory, sha);
      const current = parts.slice(0, index + 1).join('/');
      const entry = this.entries.get(current);
      if (!entry || index === parts.length - 1) return entry;
      if (entry.kind !== 'tree' || entry.type === 'commit') return undefined;
      directory = current;
      sha = entry.sha;
    }
  }
}

function contained(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !difference.startsWith('/');
}

function targetPath(path: string, target: string): string | null {
  if (target.startsWith('/')) return null;
  const candidate = join(dirname(path), target);
  return contained('.', candidate) && validPath(candidate) ? candidate : null;
}

async function missing(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return false;
  } catch (error) {
    return (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
  }
}

class Materializer {
  constructor(
    private readonly root: string,
    private readonly repository: RepositoryIdentity,
    private readonly reads: SnapshotReads,
    private readonly signal: AbortSignal | undefined,
    private readonly active: () => void,
    private readonly tree: Tree,
  ) {}

  private path(path: string): string {
    const target = join(this.root, path);
    if (!contained(this.root, target)) throw new Unavailable();
    return target;
  }

  async bytes(entry: TreeEntry): Promise<Uint8Array> {
    if ((entry.size ?? Infinity) > MAX_BLOB_BYTES) throw new Unavailable('budget');
    this.active();
    const result = await this.reads.readBlob(this.repository, entry.sha, this.signal);
    this.active();
    if (result.kind !== 'available') throw new Unavailable(result.reason);
    if (result.value.byteLength !== entry.size) throw new Unavailable('malformed');
    return result.value;
  }

  /**
   * A file past its reader's limit is replaced, unfetched, by a placeholder one byte longer than
   * that limit. C1/C2 stop reading there and report their own limit; the bytes are never decoded.
   */
  private async payload(entry: TreeEntry, limit: number): Promise<Uint8Array> {
    if ((entry.size ?? Infinity) > limit) return new Uint8Array(limit + 1);
    return this.bytes(entry);
  }

  private async linkTarget(entry: TreeEntry): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.bytes(entry));
  }

  private async parents(path: string): Promise<void> {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      const entry = this.tree.entries.get(parent);
      if (!entry || entry.kind !== 'tree') throw new Unavailable();
      await fs.mkdir(this.path(parent), { recursive: true, mode: 0o700 });
    }
  }

  async materialize(
    path: string,
    content: 'payload' | 'placeholder' = 'placeholder',
    options: Readonly<{ linkTarget?: string; limit?: number }> = {},
  ): Promise<boolean> {
    const entry = await this.tree.get(path);
    if (!entry) return false;
    await this.parents(path);
    const destination = this.path(path);
    if (entry.kind === 'tree') {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      return true;
    }
    if (!(await missing(destination)) && !(entry.kind === 'file' && content === 'payload'))
      return true;
    if (entry.kind === 'link') {
      const target =
        content === 'payload' ? (options.linkTarget ?? (await this.linkTarget(entry))) : '.';
      await fs.symlink(target, destination);
      return true;
    }
    const bytes =
      content === 'payload'
        ? await this.payload(entry, options.limit ?? MAX_SOURCE_FILE_BYTES)
        : new Uint8Array();
    await fs.writeFile(destination, bytes, { mode: entry.mode === '100755' ? 0o700 : 0o600 });
    return true;
  }

  /** Stops at the first link or file prefix so C2 sees the same blocking entry a checkout has. */
  async materializePrefixes(path: string): Promise<void> {
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      const current = parts.slice(0, index).join('/');
      const entry = await this.tree.get(current);
      if (!entry) return;
      await this.materialize(current);
      if (entry.kind !== 'tree') return;
    }
  }

  async materializeConfig(path = CONFIG_PATH, seen = new Set<string>()): Promise<void> {
    if (seen.has(path)) throw new Unavailable();
    seen.add(path);
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const current = parts.slice(0, index + 1).join('/');
      const entry = await this.tree.get(current);
      if (!entry) return;
      if (entry.kind === 'link') {
        const target = await this.linkTarget(entry);
        await this.materialize(current, 'payload', { linkTarget: target });
        const resolved = targetPath(current, target);
        if (!resolved) return;
        const suffix = parts.slice(index + 1).join('/');
        return this.materializeConfig(suffix ? `${resolved}/${suffix}` : resolved, seen);
      }
      await this.materialize(
        current,
        entry.kind === 'file' && index === parts.length - 1 ? 'payload' : 'placeholder',
        { limit: MAX_CONFIG_BYTES },
      );
    }
  }
}

function inventory(tree: Tree): readonly string[] {
  return [...tree.entries.values()]
    .filter((entry) => entry.kind === 'file' || entry.kind === 'link')
    .map((entry) => entry.path)
    .sort();
}

function trackedFiles(files: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    yield* files;
  })();
}

const DEPENDABOT_NAMES = ['dependabot.yml', 'dependabot.yaml'] as const;

/**
 * Reads the Dependabot configuration at the pinned revision. A failed read is never absence:
 * only a listing that proves both names missing is `absent`.
 */
async function readDependabotRoots(
  tree: Tree,
  materializer: Materializer,
  revision: ContextRevision,
  active: () => void,
): Promise<DependabotRootsOutcome> {
  const unusable = (reason: EvidenceReason): DependabotRootsOutcome =>
    Object.freeze({ kind: 'unavailable', reason });
  try {
    const github = await tree.get('.github');
    if (!github) return Object.freeze({ kind: 'absent', revision });
    if (github.kind !== 'tree' || github.type === 'commit') return unusable('unsupported');
    const found: TreeEntry[] = [];
    for (const name of DEPENDABOT_NAMES) {
      const entry = await tree.get(`.github/${name}`);
      if (entry) found.push(entry);
    }
    if (found.length === 0) return Object.freeze({ kind: 'absent', revision });
    const [file] = found;
    if (found.length > 1 || file.kind !== 'file') return unusable('unsupported');
    if ((file.size ?? Infinity) > DEPENDABOT_ROOT_LIMITS.maxFileBytes) return unusable('budget');
    const parsed = parseDependabotRoots(await materializer.bytes(file));
    return Object.freeze(parsed.kind === 'roots' ? { ...parsed, revision } : parsed);
  } catch (error) {
    // Cancellation and staleness end the snapshot; any other failure is an explicit reason.
    active();
    return unusable(error instanceof Unavailable ? error.reason : 'unknown');
  }
}

function sourceFailure(): SourceContextResult {
  return {
    ok: false,
    error: { file: CONFIG_PATH, category: 'read', field: 'context.excerptFiles' },
  };
}

/** Materializes only the C1/C2 boundary and removes it when the callback finishes. */
export async function withTrustedSnapshot<T>(
  request: SnapshotRequest,
  use: (snapshot: TrustedSnapshot) => Promise<T>,
): Promise<SnapshotResult<T>> {
  let root: string | undefined;
  let callbackFailure: { error: unknown } | undefined;
  const active = () => {
    if (request.signal?.aborted || request.isCurrent?.() === false) throw new Unavailable();
  };
  try {
    active();
    const repository = await request.reads.readRepository(request.repository, request.signal);
    active();
    if (
      repository.kind !== 'available' ||
      (repository.value.visibility !== 'public' && repository.value.visibility !== 'private') ||
      !validRef(repository.value.defaultBranch)
    )
      throw new Unavailable();
    const commit = await request.reads.readCommit(
      request.repository,
      repository.value.defaultBranch,
      request.signal,
    );
    active();
    if (
      commit.kind !== 'available' ||
      !validSha(commit.value.sha) ||
      !validSha(commit.value.treeSha)
    )
      throw new Unavailable();
    const revision = commit.value.sha.toLowerCase();
    const tree = new Tree(
      commit.value.treeSha.toLowerCase(),
      (sha) => request.reads.readTree(request.repository, sha, request.signal),
      active,
    );
    root = await (request.temporaryRoot?.() ?? fs.mkdtemp(join(tmpdir(), 'review-snapshot-')));
    if (!root) throw new Unavailable();
    const snapshotRoot = root;
    const materializer = new Materializer(
      snapshotRoot,
      request.repository,
      request.reads,
      request.signal,
      active,
      tree,
    );
    await materializer.materializeConfig();
    active();
    const config = await loadTrustedReviewConfig(snapshotRoot);
    active();
    if (!config.ok) return { kind: 'invalid-config', config };
    const snapshot: TrustedSnapshot = {
      contextRevision: Object.freeze({ repository: request.repository, sha: revision }),
      visibility: repository.value.visibility,
      config,
      dependabotRoots: () =>
        readDependabotRoots(tree, materializer, snapshot.contextRevision, active),
      collectContext: async (dependencies) => {
        try {
          for (const path of [
            ...config.config.context.sourceRoots,
            ...config.config.context.excerptFiles,
          ])
            await materializer.materializePrefixes(path);
          active();
          const files = inventory(tree);
          const input = {
            config,
            checkoutRoot: snapshotRoot,
            visibility: repository.value.visibility,
            dependencies,
            trackedFiles: trackedFiles(files),
          };
          const validation = await validateSourceContextInput(input);
          if (!validation.ok || validation.state !== 'ready') return collectSourceContext(input);
          for (const path of validation.files)
            await materializer.materialize(path, 'payload', { limit: MAX_SOURCE_FILE_BYTES });
          active();
          return await collectSourceContext({ ...input, trackedFiles: trackedFiles(files) });
        } catch (error) {
          if (error instanceof Unavailable) throw error;
          return sourceFailure();
        }
      },
    };
    const value = await use(Object.freeze(snapshot)).catch((error: unknown) => {
      if (!(error instanceof Unavailable)) callbackFailure = { error };
      throw error;
    });
    active();
    return { kind: 'ready', value };
  } catch {
    // Callback defects stay visible to the caller; only snapshot failures become unavailable.
    if (callbackFailure) throw callbackFailure.error;
    return { kind: 'unavailable' };
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
}
