import { createHash } from 'node:crypto';
import { collectUvMetadata } from '../../src/evidence/uv.js';
import type { GithubReadSession } from '../../src/github-read.js';
import { uvMetadataScenario } from './uv-metadata.js';

export const uvManifest =
  '[project]\nname="project"\nrequires-python=">=3.11"\ndependencies=["orbit>=1"]\n';
export function uvPackage(name: string, version: string, fields = '') {
  return `[[package]]\nname="${name}"\nversion="${version}"\nsource={registry="https://pypi.org/simple"}\n${fields}`;
}
export function uvLock(version: string, fields = '') {
  return `version=1\nrevision=3\nrequires-python=">=3.11"\n[[package]]\nname="project"\nsource={editable="."}\ndependencies=[{name="orbit"}]\n[package.metadata]\nrequires-dist=[{name="orbit",specifier=">=1"}]\n${uvPackage('orbit', version, fields)}`;
}
/** Invented metadata through the real U1 parser; this session is not a live HTTP replay. */
export async function uvGraphFixture(overrides: Record<string, string | null> = {}) {
  const f = uvMetadataScenario();
  const files: Record<string, string | null> = {
    'base:pyproject.toml': uvManifest,
    'head:pyproject.toml': uvManifest,
    'base:uv.lock': uvLock('1'),
    'head:uv.lock': uvLock('2'),
    ...overrides,
  };
  const paths = [...new Set(Object.keys(files).map((k) => k.slice(k.indexOf(':') + 1)))]
    .filter((p) => /(?:^|\/)(?:pyproject\.toml|uv\.lock)$/u.test(p))
    .sort();
  f.input.roots = [
    ...new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'))),
  ].sort();
  const binding = f.input.binding;
  const session: GithubReadSession = {
    discoverFiles: async () => ({
      kind: 'available',
      binding,
      complete: true,
      reasons: [],
      files: paths.map((path) => ({ path, previousPath: null, status: 'modified', blobSha: null })),
    }),
    readFile: async (request) => {
      const { side, path } = request as { side: 'base' | 'head'; path: string };
      const value = files[`${side}:${path}`];
      const provenance = {
        side,
        path,
        repository: side === 'base' ? binding.repository : binding.headRepository,
        commitSha: side === 'base' ? binding.baseSha : binding.headSha,
      };
      if (value === undefined || value === null)
        return { ...provenance, kind: 'absent', treeSha: 'd'.repeat(40) };
      return {
        ...provenance,
        kind: 'available',
        blobSha: createHash('sha1').update(value).digest('hex'),
        bytes: Buffer.from(value),
      };
    },
    readComparison: async () => ({
      kind: 'unavailable',
      repository: binding.repository,
      headRepository: binding.headRepository,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      mergeBaseSha: binding.mergeBaseSha,
      records: [],
      reasons: ['permission'],
    }),
    close: () => {},
  };
  const metadata = await collectUvMetadata(f.input, { session });
  if (metadata.kind !== 'metadata') throw new Error('expected parsed synthetic metadata');
  return { binding, metadata, limits: { maxGraphWork: 1_000_000, maxRetainedBytes: 2_000_000 } };
}

export function uvPacket(result: {
  binding: Awaited<ReturnType<typeof uvGraphFixture>>['binding'];
  configRevision: unknown;
  changes: unknown;
  sources: readonly unknown[];
  coverage: unknown;
  relationships: unknown;
  findings: unknown;
}) {
  const context = { ok: true, status: 'disabled', dependencies: [], reasons: [] };
  const expected = {
    binding: result.binding,
    baseSha: result.binding.baseSha,
    contextRevision: result.configRevision,
    context,
  };
  const absent = {
    id: 'other-inventory',
    kind: 'file-list',
    ecosystems: ['npm', 'actions'],
    memberIds: [],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'inventory',
      repository: result.binding.repository,
      baseSha: result.binding.baseSha,
      headSha: result.binding.headSha,
      absentEcosystems: ['npm', 'actions'],
    },
  };
  return {
    expected,
    packet: {
      version: 1,
      ...expected,
      changes: result.changes,
      sources: [...result.sources, absent],
      findings: result.findings,
      relationships: result.relationships,
      reachability: [],
      coverage: {
        npm: { status: 'not_applicable', reasons: [], sourceIds: [absent.id] },
        actions: { status: 'not_applicable', reasons: [], sourceIds: [absent.id] },
        uv: result.coverage,
      },
    },
  };
}
