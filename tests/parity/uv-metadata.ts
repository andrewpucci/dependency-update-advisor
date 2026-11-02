import { createHash } from 'node:crypto';
import type { ReviewBinding } from '../../src/event.js';
import type { GithubReadLimits } from '../../src/github-read.js';
import type { UvLimits } from '../../src/evidence/uv.js';
export type UvComparisonMode =
  | 'empty'
  | 'omission'
  | 'permission403'
  | 'unknown403'
  | 'rate403'
  | 'rate429'
  | 'partial';
type Options = { headLock?: 'missing' | 'malformed' | 'unsupported'; discoveryFailure?: boolean };
const manifest = `[project]
name="synthetic-project"
requires-python=">=3.11"
dependencies=["Orbit_Core>=1,<2; python_version < '3.13'", "orbit-core==2; python_version >= '3.13'"]
[project.optional-dependencies]
cli=["nova>=3"]
docs=["nova[Docs]>=3"]
empty=[]
web=["nova>=3; sys_platform != 'win32'"]
`;
function lock(revision: 3 | 5) {
  return `version=1
revision=${revision}
requires-python=">=3.11"
resolution-markers=["python_version < '3.13'", "python_version >= '3.13'"]
[[package]]
name="synthetic-project"
version="0.1.0"
source={editable="."}
dependencies=[{name="orbit-core",version="1.0",source={registry="https://pypi.org/simple"},marker="python_version < '3.13'"},{name="orbit-core",version="2.0",source={registry="https://pypi.org/simple"},marker="python_version >= '3.13'"}]
[package.optional-dependencies]
cli=[{name="nova"}]
docs=[{name="nova",extra=["docs"]}]
${revision === 5 ? 'empty=[]\n' : ''}web=[{name="nova",marker="sys_platform != 'win32'"}]
[package.metadata]
requires-dist=[{name="orbit-core",specifier=">=1,<2",marker="python_version < '3.13'"},{name="orbit-core",specifier="==2",marker="python_version >= '3.13'"},{name="nova",specifier=">=3",marker="extra == 'cli'"}]
provides-extras=["cli","docs","empty","web"]
[[package]]
name="orbit-core"
version="1.0"
source={registry="https://pypi.org/simple"}
resolution-markers=["python_version < '3.13'"]
dependencies=[{name="nova",marker="sys_platform == 'linux'"}]
[[package]]
name="orbit-core"
version="2.0"
source={registry="https://pypi.org/simple"}
resolution-markers=["python_version >= '3.13'"]
[[package]]
name="nova"
version="3.0"
source={registry="https://pypi.org/simple"}
[package.optional-dependencies]
docs=[]
`;
}
function comparisonResponse(mode: UvComparisonMode) {
  const row = {
    ecosystem: 'npm',
    manifest: 'package-lock.json',
    name: 'invented-comparison-only',
    version: '1',
    change_type: 'added',
    vulnerabilities: [],
  };
  const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
  if (mode === 'permission403')
    return json({ message: 'Resource not accessible by integration' }, { status: 403 });
  if (mode === 'unknown403')
    return json({ message: 'Synthetic ambiguous restriction' }, { status: 403 });
  if (mode === 'rate403')
    return json(
      { message: 'Synthetic rate limit' },
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    );
  if (mode === 'rate429') return json({ message: 'Synthetic rate limit' }, { status: 429 });
  return json(mode === 'empty' ? [] : mode === 'partial' ? [row, null] : [row]);
}
/** Invented format structures and HTTP objects only; no consumer content or archived API replay. */
export function uvMetadataScenario(mode: UvComparisonMode = 'empty', options: Options = {}) {
  const BASE = 'b'.repeat(40),
    HEAD = 'a'.repeat(40),
    repository = { id: 101, owner: 'example', name: 'consumer' };
  const binding: ReviewBinding = {
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
  const limits: UvLimits = {
    maxFileBytes: 100000,
    maxTomlDepth: 32,
    maxTomlEntries: 100000,
    maxPackages: 1000,
    maxDeclarations: 1000,
    maxEdges: 1000,
    maxStringBytes: 4096,
    maxRequirementTokens: 200,
    maxMarkerDepth: 16,
    maxRoots: 20,
    maxRetainedBytes: 1000000,
  };
  const readLimits: GithubReadLimits = {
    maxRequests: 100,
    maxPages: 10,
    maxFiles: 100,
    maxJsonEntries: 10000,
    maxResponseBytes: 1000000,
    maxFileBytes: 100000,
    maxTotalBytes: 10000000,
    maxRetainedBytes: 5000000,
    requestTimeoutMs: 1000,
    totalTimeoutMs: 10000,
  };
  const objects = new Map<string, unknown>(),
    headBlobs = new Map<string, string>();
  for (const side of ['base', 'head'] as const) {
    const files: Record<string, string> = {
      'pyproject.toml': manifest,
      'uv.lock': lock(side === 'base' ? 3 : 5),
    };
    if (side === 'head' && options.headLock === 'missing') delete files['uv.lock'];
    if (side === 'head' && options.headLock === 'malformed')
      files['uv.lock'] = 'version=1\nrevision=[';
    if (side === 'head' && options.headLock === 'unsupported')
      files['uv.lock'] = 'version=1\nrevision=4';
    const tree = Object.entries(files).map(([path, text]) => {
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
    const treeSha = createHash('sha1').update(JSON.stringify(tree)).digest('hex');
    objects.set(treeSha, { sha: treeSha, truncated: false, tree });
    const commitSha = side === 'base' ? BASE : HEAD;
    objects.set(commitSha, { sha: commitSha, tree: { sha: treeSha } });
  }
  const requests: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push(url);
    const target = new URL(url),
      prefix = '/repos/example/consumer';
    if (
      target.origin !== 'https://api.github.com' ||
      !target.pathname.startsWith(prefix + '/') ||
      init.method !== 'GET' ||
      init.redirect !== 'manual'
    )
      throw new Error('unexpected synthetic request policy');
    const path = target.pathname.slice(prefix.length),
      json = (value: unknown) => new Response(JSON.stringify(value));
    if (path === '/pulls/42')
      return json({
        number: 42,
        state: 'open',
        merged: false,
        user: { id: 201, login: 'dependabot[bot]', type: 'Bot' },
        base: { ref: 'main', sha: BASE, repo: { id: 101, full_name: 'example/consumer' } },
        head: { sha: HEAD, repo: { id: 101, full_name: 'example/consumer' } },
        changed_files: 2,
      });
    if (path === '/pulls/42/files')
      return options.discoveryFailure
        ? new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
            status: 403,
          })
        : json(
            ['pyproject.toml', 'uv.lock'].map((filename) => ({
              filename,
              status:
                filename === 'uv.lock' && options.headLock === 'missing' ? 'removed' : 'modified',
              sha: headBlobs.get(filename) ?? 'c'.repeat(40),
            })),
          );
    if (path.startsWith('/git/')) {
      const value = objects.get(path.split('/').at(-1)!);
      if (!value) throw new Error('unknown synthetic object');
      return json(value);
    }
    if (path === `/dependency-graph/compare/${BASE}...${HEAD}`) return comparisonResponse(mode);
    throw new Error('unexpected synthetic API route');
  };
  return {
    input: { binding, roots: ['.'], configRevision: { repository, sha: BASE }, limits },
    readLimits,
    requests,
    fetch,
  };
}
