import { upstreamScenario } from './upstream.js';
import { uvMetadataScenario } from './uv-metadata.js';

export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);
export const NEXT = 'c'.repeat(40);
const full = { id: 101, full_name: 'example/consumer' };
const actor = { id: 201, login: 'dependabot[bot]', type: 'Bot' };
const workflow = { id: 301, path: '.github/workflows/ci.yml' };
const run = {
  id: 401,
  workflow_id: 301,
  run_attempt: 1,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  head_sha: HEAD,
  actor,
  repository: full,
  head_repository: full,
  pull_requests: [
    {
      number: 42,
      base: { repo: { id: 101, name: 'consumer' } },
      head: { sha: HEAD, repo: { id: 101, name: 'consumer' } },
    },
  ],
};
export const eventFile = JSON.stringify({
  action: 'completed',
  repository: full,
  workflow_run: run,
});
const pullRequest = (head: string) => ({
  number: 42,
  state: 'open',
  merged: false,
  user: actor,
  base: { ref: 'main', sha: BASE, repo: full },
  head: { sha: head, repo: full },
});
const rootTree = '9'.repeat(40);
const githubTree = 'e'.repeat(40);
const configBlob = '1'.repeat(40);
const dependabotBlob = '2'.repeat(40);
const providerConfig = JSON.stringify({
  version: 1,
  analysis: { provider: 'mistral', model: 'synthetic-model' },
});
const dependabotYaml = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n';
const unchanged = { 'pyproject.toml': null, 'uv.lock': null };

/** One mocked GitHub: trusted reads, the default-branch snapshot, and consumer evidence. */
export function mockGithub(
  options: {
    config?: string;
    heads?: string[];
    filesFail?: boolean;
    /** Serve npm, Actions, and uv updates, and the public registries they are researched in. */
    changes?: Awaited<ReturnType<typeof upstreamScenario>>;
  } = {},
) {
  const evidence = options.changes
    ? { fetch: options.changes.consumerFetch }
    : uvMetadataScenario('empty', { files: { base: unchanged, head: unchanged } });
  const heads = options.heads ?? [HEAD];
  let pulls = 0;
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const objects = new Map<string, unknown>([
    [
      rootTree,
      {
        truncated: false,
        tree: [{ path: '.github', mode: '040000', type: 'tree', sha: githubTree }],
      },
    ],
    [
      githubTree,
      {
        truncated: false,
        tree: [
          {
            path: 'dependabot-review.json',
            mode: '100644',
            type: 'blob',
            sha: configBlob,
            size: Buffer.byteLength(options.config ?? providerConfig),
          },
          {
            path: 'dependabot.yml',
            mode: '100644',
            type: 'blob',
            sha: dependabotBlob,
            size: Buffer.byteLength(dependabotYaml),
          },
        ],
      },
    ],
  ]);
  const blobs = new Map([
    [configBlob, options.config ?? providerConfig],
    [dependabotBlob, dependabotYaml],
  ]);
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
    headers.push(Object.fromEntries(new Headers(init.headers)));
    const path = new URL(url).pathname.replace('/repos/example/consumer', '');
    const inRepository = new URL(url).pathname.startsWith('/repos/example/consumer');
    if (options.changes && !(new URL(url).origin === 'https://api.github.com' && inRepository))
      return options.changes.fetch(url, init);
    if (new URL(url).origin !== 'https://api.github.com')
      return new Response(null, { status: 404 });
    // Every consumer-repository read needs the read token; GitHub rejects it otherwise.
    if (headers.at(-1)?.authorization !== 'Bearer read-token')
      return new Response(null, { status: 401 });
    if (path === '/actions/workflows/ci.yml' || path === '/actions/workflows/301')
      return json(workflow);
    if (path === '/actions/runs/401') return json(run);
    if (path === '/pulls/42')
      return json({ ...pullRequest(heads[Math.min(pulls++, heads.length - 1)]), changed_files: 0 });
    if (path === `/compare/${BASE}...${HEAD}`)
      return json({ base_commit: { sha: BASE }, merge_base_commit: { sha: BASE } });
    if (path === '') return json({ private: false, default_branch: 'main' });
    if (path === '/commits/main') return json({ sha: HEAD, commit: { tree: { sha: rootTree } } });
    const object = path.split('/').at(-1)!;
    if (path.startsWith('/git/trees/') && objects.has(object)) return json(objects.get(object));
    if (path.startsWith('/git/blobs/') && blobs.has(object))
      return json({
        encoding: 'base64',
        content: Buffer.from(blobs.get(object)!).toString('base64'),
      });
    if (options.filesFail && path.startsWith('/pulls/42/files'))
      return new Response(null, { status: 500 });
    return evidence.fetch(url, init);
  };
  return { fetch, urls, headers };
}
