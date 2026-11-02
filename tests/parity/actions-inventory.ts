import { createHash } from 'node:crypto';
import type { PacketExpected } from '../../src/schema.js';
import type { GithubReadLimits } from '../../src/github-read.js';

/** Synthetic immutable files/transport derived from the documented omission, not a historical API replay. */
export function actionsScenario(comparison: 'empty' | 'omission' = 'empty') {
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
  const identities = {
    setup: 'voidzero-dev/setup-vp',
    codeql: 'github/codeql-action/upload-sarif',
    chromaui: 'chromaui/action',
  };
  const refs = {
    base: { setup: '1'.repeat(40), codeql: '3'.repeat(40), chromaui: '5'.repeat(40) },
    head: { setup: '2'.repeat(40), codeql: '4'.repeat(40), chromaui: '6'.repeat(40) },
  };
  const workflows: Record<string, (keyof typeof identities)[]> = {
    'build.yml': ['setup', 'setup'],
    'quality.yml': ['setup', 'codeql'],
    'preview.yml': ['setup', 'chromaui'],
    'test.yml': ['setup'],
    'security.yml': ['codeql'],
  };
  const objects = new Map<string, unknown>(),
    headBlobs = new Map<string, string>();
  const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
  const tree = (entries: unknown[]) => {
    const sha = hash(entries);
    objects.set(sha, { sha, truncated: false, tree: entries });
    return sha;
  };
  for (const side of ['base', 'head'] as const) {
    const entries = Object.entries(workflows).map(([path, actions]) => {
      const text = `jobs:\n  review:\n    steps:\n${actions.map((action) => `      - uses: ${identities[action]}@${refs[side][action]}`).join('\n')}\n`;
      const bytes = Buffer.from(text),
        sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      objects.set(sha, {
        sha,
        encoding: 'base64',
        size: bytes.length,
        content: bytes.toString('base64'),
      });
      if (side === 'head') headBlobs.set(path, sha);
      return { path, mode: '100644', type: 'blob', sha };
    });
    const workflowTree = tree(entries);
    const githubTree = tree([
      { path: 'workflows', mode: '040000', type: 'tree', sha: workflowTree },
    ]);
    const root = tree([{ path: '.github', mode: '040000', type: 'tree', sha: githubTree }]);
    const sha = side === 'base' ? BASE : HEAD;
    objects.set(sha, { sha, tree: { sha: root } });
  }
  const readLimits: GithubReadLimits = {
    maxRequests: 200,
    maxPages: 10,
    maxFiles: 100,
    maxJsonEntries: 10000,
    maxResponseBytes: 1_000_000,
    maxFileBytes: 100_000,
    maxTotalBytes: 10_000_000,
    maxRetainedBytes: 5_000_000,
    requestTimeoutMs: 1000,
    totalTimeoutMs: 10000,
  };
  const requests: string[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const fetch = async (url: string, init: RequestInit) => {
    requests.push(url);
    const target = new URL(url),
      prefix = '/repos/example/consumer';
    if (
      target.origin !== 'https://api.github.com' ||
      !target.pathname.startsWith(prefix) ||
      init.method !== 'GET' ||
      init.redirect !== 'manual'
    )
      throw new Error('unexpected synthetic request policy');
    const path = target.pathname.slice(prefix.length);
    if (path === '/pulls/42')
      return json({
        number: 42,
        state: 'open',
        merged: false,
        user: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
        base: { ref: 'main', sha: BASE, repo: { id: 101, full_name: 'example/consumer' } },
        head: { sha: HEAD, repo: { id: 101, full_name: 'example/consumer' } },
        changed_files: Object.keys(workflows).length,
      });
    if (path === '/pulls/42/files')
      return json(
        Object.keys(workflows).map((name) => ({
          filename: `.github/workflows/${name}`,
          status: 'modified',
          sha: headBlobs.get(name),
        })),
      );
    if (path.startsWith('/git/')) {
      const value = objects.get(path.split('/').at(-1)!);
      if (!value) throw new Error('unknown synthetic object');
      return json(value);
    }
    if (path === `/dependency-graph/compare/${BASE}...${HEAD}`)
      return json(
        comparison === 'empty'
          ? []
          : (['base', 'head'] as const).flatMap((side) =>
              (['setup', 'chromaui'] as const).map((action) => ({
                ecosystem: 'actions',
                manifest: '.github/workflows/preview.yml',
                name: identities[action],
                version: refs[side][action],
                change_type: side === 'base' ? 'removed' : 'added',
                vulnerabilities: [],
              })),
            ),
      );
    throw new Error('unexpected synthetic API route');
  };
  return { binding, readLimits, requests, fetch };
}
