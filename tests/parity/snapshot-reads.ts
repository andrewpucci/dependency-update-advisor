import type { SnapshotReads, SnapshotTreeEntry } from '../../src/snapshot.js';

const REVISION = 'a'.repeat(40);
const ROOT_TREE = '9'.repeat(40);

export type FakeTreeEntry = SnapshotTreeEntry;

export function treeEntry(
  path: string,
  mode: string,
  sha: string,
  type = 'blob',
  size?: number,
): FakeTreeEntry {
  return { path, mode, sha, type, ...(size === undefined ? {} : { size }) };
}

/**
 * Serves each directory's direct children the way GitHub's non-recursive tree endpoint does, from a
 * flat list of repository paths, and records every read.
 */
export function snapshotReads(
  tree: readonly FakeTreeEntry[],
  blobs: Readonly<Record<string, string>>,
  options: { visibility?: 'public' | 'private'; revision?: string } = {},
): SnapshotReads & { calls: string[] } {
  const calls: string[] = [];
  const directories = new Map<string, string>([[ROOT_TREE, '']]);
  for (const item of tree) if (item.type === 'tree') directories.set(item.sha, item.path);
  return {
    calls,
    readRepository: async () => {
      calls.push('repository');
      return {
        kind: 'available',
        value: { visibility: options.visibility ?? 'public', defaultBranch: 'main' },
      };
    },
    readCommit: async () => {
      calls.push('commit');
      return {
        kind: 'available',
        value: { sha: options.revision ?? REVISION, treeSha: ROOT_TREE },
      };
    },
    readTree: async (_repository, sha) => {
      calls.push(`tree:${sha}`);
      const directory = directories.get(sha);
      if (directory === undefined) return { kind: 'unavailable' };
      const prefix = directory ? `${directory}/` : '';
      return {
        kind: 'available',
        value: tree
          .filter(
            (item) => item.path.startsWith(prefix) && !item.path.slice(prefix.length).includes('/'),
          )
          .map((item) => ({
            ...item,
            path: item.path.slice(prefix.length),
            ...(item.type === 'blob' && item.size === undefined
              ? { size: Buffer.byteLength(blobs[item.sha] ?? '') }
              : {}),
          })),
      };
    },
    readBlob: async (_repository, sha) => {
      calls.push(`blob:${sha}`);
      const value = blobs[sha];
      return value === undefined
        ? { kind: 'unavailable' }
        : { kind: 'available', value: new TextEncoder().encode(value) };
    },
  };
}
