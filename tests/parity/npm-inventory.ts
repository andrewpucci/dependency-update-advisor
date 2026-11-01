import { createHash } from 'node:crypto';
import type { PacketExpected } from '../../src/schema.js';

/** Synthetic API-shaped fixtures, not a captured historical consumer payload. */
export function npmScenario(additions = 20, rangeChange = false, comparison = 'empty') {
  const BASE = 'b'.repeat(40),
    HEAD = 'a'.repeat(40);
  const repository = { id: 101, owner: 'example', name: 'consumer' };
  const binding: PacketExpected['binding'] = {
    repository,
    workflow: { id: 301, path: '.github/workflows/ci.yml' },
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headRepository: repository,
    headSha: HEAD,
    baseRef: 'main',
    baseSha: BASE,
    mergeBaseSha: BASE,
    actorId: 201,
    conclusion: 'success',
    identity: [101, 301, 401, 1, 42, HEAD],
  };
  const expected: PacketExpected = {
    binding,
    baseSha: BASE,
    contextRevision: { repository, sha: 'c'.repeat(40) },
    context: { ok: true, status: 'disabled', dependencies: [], reasons: [] },
  };
  const objects = new Map<string, unknown>(),
    trees = new Map<string, unknown>();
  const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
  const node = (name: string, version: string) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  });
  for (const side of ['base', 'head'] as const) {
    const manifest = {
      dependencies: { 'fixture-anchor': side === 'head' && rangeChange ? '^1.1' : '^1' },
    };
    const packages: Record<string, unknown> = {
      '': manifest,
      'node_modules/fixture-anchor': {
        ...node('fixture-anchor', side === 'head' && additions ? '1.1.0' : '1.0.0'),
        dependencies:
          side === 'head'
            ? Object.fromEntries(
                Array.from({ length: additions }, (_, i) => [`synthetic-child-${i}`, '1.0.0']),
              )
            : {},
      },
    };
    if (side === 'head')
      for (let i = 0; i < additions; i++)
        packages[`node_modules/synthetic-child-${i}`] = node(`synthetic-child-${i}`, '1.0.0');
    const files = {
      'package.json': manifest,
      'package-lock.json': { lockfileVersion: 3, packages },
    };
    const tree = Object.entries(files).map(([path, value]) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const sha = hash(value);
      objects.set(sha, {
        sha,
        encoding: 'base64',
        size: bytes.length,
        content: bytes.toString('base64'),
      });
      return { path, mode: '100644', type: 'blob', sha };
    });
    const sha = hash(tree);
    trees.set(sha, { sha, truncated: false, tree });
    objects.set(side === 'base' ? BASE : HEAD, {
      sha: side === 'base' ? BASE : HEAD,
      tree: { sha },
    });
  }
  const changed = rangeChange ? ['package-lock.json', 'package.json'] : ['package-lock.json'];
  const requests: string[] = [];
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers });
  const fetch = async (url: string, init: RequestInit) => {
    requests.push(url);
    if (init.method !== 'GET' || init.redirect !== 'manual')
      throw new Error('unexpected synthetic transport policy');
    const target = new URL(url);
    if (target.origin !== 'https://api.github.com') throw new Error('unexpected synthetic origin');
    const path = target.pathname.replace('/repos/example/consumer', '');
    if (path === '/pulls/42')
      return json({
        number: 42,
        state: 'open',
        merged: false,
        user: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
        base: { ref: 'main', sha: BASE, repo: { id: 101, full_name: 'example/consumer' } },
        head: { sha: HEAD, repo: { id: 101, full_name: 'example/consumer' } },
        changed_files: changed.length,
      });
    if (path === '/pulls/42/files')
      return json(
        changed.map((filename) => ({ filename, status: 'modified', sha: 'e'.repeat(40) })),
      );
    if (path.startsWith('/git/trees/')) return json(trees.get(path.split('/').at(-1)!));
    if (path.startsWith('/git/')) return json(objects.get(path.split('/').at(-1)!));
    if (path.startsWith('/dependency-graph/compare/')) {
      if (comparison === 'permission')
        return json({ message: 'Resource not accessible by integration' }, 403);
      if (comparison === 'unknown') return json({ message: 'Comparison unavailable' }, 403);
      if (comparison === 'rate_limit') return json({}, 403, { 'x-ratelimit-remaining': '0' });
      return json(
        comparison === 'omission'
          ? [
              {
                change_type: 'added',
                ecosystem: 'npm',
                manifest: 'package-lock.json',
                name: 'fixture-anchor',
                version: '1.1.0',
                vulnerabilities: [],
              },
            ]
          : [],
      );
    }
    throw new Error('unexpected synthetic API request');
  };
  const absent = {
    id: 'other',
    kind: 'file-list',
    ecosystems: ['actions', 'uv'],
    memberIds: [],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'inventory',
      repository,
      baseSha: BASE,
      headSha: HEAD,
      absentEcosystems: ['actions', 'uv'],
    },
  };
  return { binding, expected, fetch, requests, absent };
}
