import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { loadTrustedReviewConfig, type ConfigResult } from './config.js';
import {
  collectSourceContext,
  validateSourceContextInput,
  type SourceContextResult,
} from './context.js';
import { record, type RepositoryIdentity } from './event.js';
import type { GithubRead, GithubTransport } from './runtime.js';

const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_TREE_ENTRIES = 10_000;
const CONFIG_PATH = '.github/dependabot-review.json';

type SnapshotRead<T> = { kind: 'available'; value: T } | { kind: 'unavailable' };
type SnapshotRepository = { visibility: 'public' | 'private'; defaultBranch: string };
type SnapshotCommit = { sha: string; treeSha: string };
export type SnapshotTreeEntry = Readonly<{
  path: string;
  mode: string;
  type: string;
  sha: string;
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

class Unavailable extends Error {}

function available<T>(value: T): SnapshotRead<T> {
  return { kind: 'available', value };
}

function unavailable<T>(): SnapshotRead<T> {
  return { kind: 'unavailable' };
}

function rawValue(read: GithubRead): unknown | null {
  return read.kind === 'available' ? read.value : null;
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
      const value = rawValue(await transport.readRepository(repository, signal));
      if (
        !record(value, ['private', 'default_branch']) ||
        typeof value.private !== 'boolean' ||
        !validRef(value.default_branch)
      )
        return unavailable();
      return available({
        visibility: value.private ? 'private' : 'public',
        defaultBranch: value.default_branch,
      });
    },
    readCommit: async (repository, ref, signal) => {
      const value = rawValue(await transport.readCommit(repository, ref, signal));
      if (
        !record(value, ['sha', 'commit']) ||
        !validSha(value.sha) ||
        !record(value.commit, ['tree']) ||
        !record(value.commit.tree, ['sha']) ||
        !validSha(value.commit.tree.sha)
      )
        return unavailable();
      return available({
        sha: value.sha.toLowerCase(),
        treeSha: value.commit.tree.sha.toLowerCase(),
      });
    },
    readTree: async (repository, sha, signal) => {
      const value = rawValue(await transport.readTree(repository, sha, signal));
      if (
        !record(value, ['truncated', 'tree']) ||
        value.truncated !== false ||
        !Array.isArray(value.tree)
      )
        return unavailable();
      const entries: SnapshotTreeEntry[] = [];
      for (const item of value.tree) {
        if (
          !record(item, ['path', 'mode', 'type', 'sha']) ||
          typeof item.path !== 'string' ||
          typeof item.mode !== 'string' ||
          typeof item.type !== 'string' ||
          typeof item.sha !== 'string'
        )
          return unavailable();
        entries.push({ path: item.path, mode: item.mode, type: item.type, sha: item.sha });
      }
      return available(entries);
    },
    readBlob: async (repository, sha, signal) => {
      const bytes = decodedBlob(rawValue(await transport.readBlob(repository, sha, signal)));
      return bytes ? available(bytes) : unavailable();
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

function classifyEntry(value: SnapshotTreeEntry): TreeEntry | null {
  if (!validPath(value.path) || !validSha(value.sha)) return null;
  if (value.mode === '040000' && value.type === 'tree') return { ...value, kind: 'tree' };
  if ((value.mode === '100644' || value.mode === '100755') && value.type === 'blob')
    return { ...value, kind: 'file' };
  if (value.mode === '120000' && value.type === 'blob') return { ...value, kind: 'link' };
  return null;
}

function treeIndex(entries: readonly SnapshotTreeEntry[]): Map<string, TreeEntry> {
  if (entries.length > MAX_TREE_ENTRIES) throw new Unavailable();
  const index = new Map<string, TreeEntry>();
  for (const value of entries) {
    const entry = classifyEntry(value);
    if (!entry || index.has(entry.path)) throw new Unavailable();
    index.set(entry.path, entry);
  }
  for (const entry of index.values()) {
    for (let parent = dirname(entry.path); parent !== '.'; parent = dirname(parent)) {
      if (index.get(parent)?.kind !== 'tree') throw new Unavailable();
    }
  }
  return index;
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
    private readonly entries: Map<string, TreeEntry>,
  ) {}

  private path(path: string): string {
    const target = join(this.root, path);
    if (!contained(this.root, target)) throw new Unavailable();
    return target;
  }

  private async bytes(entry: TreeEntry): Promise<Uint8Array> {
    this.active();
    const result = await this.reads.readBlob(this.repository, entry.sha, this.signal);
    this.active();
    if (result.kind !== 'available' || result.value.byteLength > MAX_BLOB_BYTES)
      throw new Unavailable();
    return result.value;
  }

  private async linkTarget(entry: TreeEntry): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.bytes(entry));
  }

  private async parents(path: string): Promise<void> {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      const entry = this.entries.get(parent);
      if (!entry || entry.kind !== 'tree') throw new Unavailable();
      await fs.mkdir(this.path(parent), { recursive: true, mode: 0o700 });
    }
  }

  async materialize(
    path: string,
    content: 'payload' | 'placeholder' = 'placeholder',
    linkTarget?: string,
  ): Promise<boolean> {
    const entry = this.entries.get(path);
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
      const target = content === 'payload' ? (linkTarget ?? (await this.linkTarget(entry))) : '.';
      await fs.symlink(target, destination);
      return true;
    }
    const bytes = content === 'payload' ? await this.bytes(entry) : new Uint8Array();
    await fs.writeFile(destination, bytes, { mode: entry.mode === '100755' ? 0o700 : 0o600 });
    return true;
  }

  async materializeConfig(path = CONFIG_PATH, seen = new Set<string>()): Promise<void> {
    if (seen.has(path)) throw new Unavailable();
    seen.add(path);
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const current = parts.slice(0, index + 1).join('/');
      const entry = this.entries.get(current);
      if (!entry) return;
      if (entry.kind === 'link') {
        const target = await this.linkTarget(entry);
        await this.materialize(current, 'payload', target);
        const resolved = targetPath(current, target);
        if (!resolved) return;
        const suffix = parts.slice(index + 1).join('/');
        return this.materializeConfig(suffix ? `${resolved}/${suffix}` : resolved, seen);
      }
      await this.materialize(
        current,
        entry.kind === 'file' && index === parts.length - 1 ? 'payload' : 'placeholder',
      );
    }
  }
}

function inventory(entries: Map<string, TreeEntry>): readonly string[] {
  return [...entries.values()]
    .filter((entry) => entry.kind === 'file' || entry.kind === 'link')
    .map((entry) => entry.path)
    .sort();
}

function trackedFiles(files: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    yield* files;
  })();
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
    const tree = await request.reads.readTree(
      request.repository,
      commit.value.treeSha.toLowerCase(),
      request.signal,
    );
    active();
    if (tree.kind !== 'available') throw new Unavailable();
    const entries = treeIndex(tree.value);
    root = await (request.temporaryRoot?.() ?? fs.mkdtemp(join(tmpdir(), 'review-snapshot-')));
    if (!root) throw new Unavailable();
    const snapshotRoot = root;
    const materializer = new Materializer(
      snapshotRoot,
      request.repository,
      request.reads,
      request.signal,
      active,
      entries,
    );
    await materializer.materializeConfig();
    active();
    const config = await loadTrustedReviewConfig(snapshotRoot);
    active();
    if (!config.ok) return { kind: 'invalid-config', config };
    const files = inventory(entries);
    const snapshot: TrustedSnapshot = {
      contextRevision: Object.freeze({ repository: request.repository, sha: revision }),
      visibility: repository.value.visibility,
      config,
      collectContext: async (dependencies) => {
        try {
          for (const path of [
            ...config.config.context.sourceRoots,
            ...config.config.context.excerptFiles,
          ])
            await materializer.materialize(path);
          active();
          const input = {
            config,
            checkoutRoot: snapshotRoot,
            visibility: repository.value.visibility,
            dependencies,
            trackedFiles: trackedFiles(files),
          };
          const validation = await validateSourceContextInput(input);
          if (!validation.ok || validation.state !== 'ready') return collectSourceContext(input);
          for (const path of validation.files) await materializer.materialize(path, 'payload');
          active();
          return await collectSourceContext({ ...input, trackedFiles: trackedFiles(files) });
        } catch (error) {
          if (error instanceof Unavailable) throw error;
          return sourceFailure();
        }
      },
    };
    const value = await use(Object.freeze(snapshot));
    active();
    return { kind: 'ready', value };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
}
