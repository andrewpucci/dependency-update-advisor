import { createHash } from 'node:crypto';
import { createGithubReadSession } from '../../src/github-read.js';
import { collectNpmInventory } from '../../src/evidence/npm.js';
import { enrichNpmEvidence, proveNpmRelationships } from '../../src/evidence/npm-graph.js';
import { collectActionsInventory } from '../../src/evidence/actions.js';
import { collectUvMetadata } from '../../src/evidence/uv.js';
import { reconcileUvGraph } from '../../src/evidence/uv-graph.js';
import type { UpstreamInput } from '../../src/evidence/upstream.js';
import type { AdvisoryEnrichment } from '../../src/evidence/advisories.js';
import type { PacketSource } from '../../src/schema.js';
import { uvMetadataScenario } from './uv-metadata.js';
import { uvManifest, uvLock, uvPackage } from './uv-graph.js';
import { advisoryTestLimits, syntheticAdvisory } from './advisories.js';

export const upstreamTestLimits = {
  ...advisoryTestLimits,
  maxRequests: 5000,
  maxPages: 1000,
  maxTagCandidates: 1000,
  maxTagDepth: 10,
  maxWork: 10_000_000,
  maxAttempts: 2000,
  maxRetainedBytes: 2_000_000,
};
const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
type Options = {
  lifecycle?: boolean;
  children?: number;
  extras?: boolean;
  declaration?: boolean;
  missingPyPI?: boolean;
  vulnerableNpm?: boolean;
  uvVariants?: boolean;
  actionsSubpath?: boolean;
  failedAdvisoryChild?: boolean;
};
function packageNode(name: string, version: string) {
  return {
    version,
    integrity,
    hasInstallScript: false,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  };
}
function npmFiles(head: boolean, options: Options) {
  const version = head ? '2.0.0' : '1.0.0';
  const manifest = {
    dependencies: { orbit: '*', ...(options.declaration ? { steady: head ? '^1.0' : '^1' } : {}) },
  };
  const names = Array.from({ length: options.children ?? 1 }, (_, i) => 'child-' + i);
  if (options.extras) names.push(head ? 'added' : 'removed');
  const packages = {
    '': manifest,
    'node_modules/orbit': {
      ...packageNode('orbit', version),
      dependencies: Object.fromEntries(names.map((n) => [n, '*'])),
    },
    ...(options.declaration ? { 'node_modules/steady': packageNode('steady', '1.0.0') } : {}),
    ...Object.fromEntries(
      names.map((name) => ['node_modules/' + name, packageNode(name, version)]),
    ),
  };
  return {
    'package.json': JSON.stringify(manifest),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages }),
  };
}
function contents(text: string) {
  const bytes = Buffer.from(text);
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    content: bytes.toString('base64'),
    sha: createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex'),
  };
}
function release(repository: string, version: string) {
  return {
    id: version === '1.0.0' ? 1 : 2,
    tag_name: 'v' + version,
    draft: false,
    published_at: '2026-10-01T00:00:00Z',
    html_url: 'https://github.com/' + repository + '/releases/tag/v' + version,
    name: version + ' fixture release',
    body: 'Version-specific fixture notes.',
  };
}
function githubResponse(url: URL) {
  const repository = url.pathname.split('/').slice(2, 4).join('/');
  const tail = url.pathname.split('/').slice(4).map(decodeURIComponent).join('/');
  const repo = repository.split('/')[1];
  if (!tail) return Response.json({ private: false, full_name: repository });
  if (tail.startsWith('commits/')) return Response.json({ sha: tail.slice('commits/'.length) });
  const ref = tail.slice('git/ref/'.length);
  if (tail.startsWith('git/ref/') && ['tags/v1.0.0', 'tags/v2.0.0'].includes(ref))
    return Response.json({
      ref: 'refs/' + ref,
      object: { type: 'commit', sha: (ref.endsWith('1.0.0') ? '1' : '2').repeat(40) },
    });
  if (tail === 'releases')
    return Response.json(['1.0.0', '2.0.0'].map((v) => release(repository, v)));
  if (tail.startsWith('releases/tags/v')) {
    const version = tail.slice('releases/tags/v'.length);
    return ['1.0.0', '2.0.0'].includes(version)
      ? Response.json(release(repository, version))
      : Response.json({}, { status: 404 });
  }
  if (tail.startsWith('contents/')) {
    const version = url.searchParams.get('ref') === '1'.repeat(40) ? '1.0.0' : '2.0.0';
    if (repo.startsWith('npm-') && tail === 'contents/package.json')
      return Response.json(contents(JSON.stringify({ name: repo.slice(4), version })));
    if (repo.startsWith('py-') && tail === 'contents/pyproject.toml')
      return Response.json(contents(`[project]\nname="${repo.slice(3)}"\nversion="${version}"\n`));
  }
  return Response.json({}, { status: 404 });
}
function researchFetch(options: Options, requests: string[]) {
  return async (value: string, init: RequestInit) => {
    requests.push(value);
    if (init.redirect !== 'manual' || init.credentials !== 'omit')
      throw new Error('Unexpected research transport policy');
    const url = new URL(value),
      parts = url.pathname.split('/').map(decodeURIComponent);
    if (url.origin === 'https://registry.npmjs.org') {
      const [, name, version] = parts;
      return Response.json({
        _id: name + '@' + version,
        name,
        version,
        dist: { integrity },
        scripts: {},
        description: 'Exact npm version metadata.',
        repository: { url: 'https://github.com/fixture/npm-' + name },
      });
    }
    if (url.origin === 'https://pypi.org')
      return options.missingPyPI
        ? Response.json({}, { status: 404 })
        : Response.json({
            info: {
              name: parts[2],
              version: parts[3],
              description: 'Exact PyPI version metadata.',
              project_urls: { Source: 'https://github.com/fixture/py-' + parts[2] },
            },
          });
    if (url.origin === 'https://api.github.com' && url.pathname === '/advisories') {
      if (
        options.failedAdvisoryChild &&
        url.searchParams.get('affects') === 'child-0@2.0.0' &&
        url.searchParams.get('ecosystem') === 'npm'
      )
        return Response.json({}, { status: 500 });
      return Response.json(
        options.vulnerableNpm &&
          url.searchParams.get('ecosystem') === 'npm' &&
          url.searchParams.get('affects') === 'orbit@2.0.0'
          ? [
              {
                ...syntheticAdvisory,
                vulnerabilities: [
                  {
                    package: { ecosystem: 'npm', name: 'orbit' },
                    vulnerable_version_range: '>=2.0.0',
                  },
                ],
              },
            ]
          : [],
      );
    }
    if (url.origin === 'https://api.github.com') return githubResponse(url);
    throw new Error('Unexpected research host');
  };
}
/** Invented HTTP/file snapshots through authentic collectors; no public-identity proof is pre-filled. */
export async function upstreamScenario(options: Options = {}) {
  const python = (head: boolean) => {
    const version = head ? '2.0.0' : '1.0.0';
    if (!options.uvVariants) return uvLock(version);
    return (
      uvLock(version, 'resolution-markers=["sys_platform == \'linux\'"]\n') +
      uvPackage('orbit', version + '+other', 'resolution-markers=["sys_platform != \'linux\'"]\n')
    );
  };
  const files = (head: boolean) => ({
    ...npmFiles(head, options),
    'pyproject.toml': uvManifest,
    'uv.lock': python(head),
    '.github/workflows/ci.yml': `jobs:\n  review:\n    steps:\n      - uses: fixture/action${options.actionsSubpath ? '/component' : ''}@${(head ? '2' : '1').repeat(40)}\n`,
  });
  const fixture = uvMetadataScenario('permission403', {
    files: { base: files(false), head: files(true) },
  });
  const requests: string[] = [],
    fetch = researchFetch(options, requests);
  const opened = await createGithubReadSession(
    {
      binding: fixture.input.binding,
      limits: { ...fixture.readLimits, maxRequests: 1000, maxJsonEntries: 1_000_000 },
    },
    { fetch: fixture.fetch, now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('D1');
  try {
    const raw = await collectNpmInventory(
      {
        binding: fixture.input.binding,
        roots: ['.'],
        configRevision: fixture.input.configRevision,
        limits: { ...upstreamTestLimits, maxFileBytes: 500_000, maxRoots: 10 },
      },
      { session: opened.session },
    );
    const graphInput = {
      binding: fixture.input.binding,
      inventory: raw,
      limits: { ...upstreamTestLimits, maxGraphWork: 10_000_000 },
    };
    const npm =
      options.lifecycle === false
        ? proveNpmRelationships(graphInput)
        : await enrichNpmEvidence(graphInput, { now: () => 0, fetch });
    const actions = await collectActionsInventory(
      {
        binding: fixture.input.binding,
        limits: {
          maxFileBytes: 100_000,
          maxWorkflows: 20,
          maxYamlNodes: 100_000,
          maxYamlDepth: 32,
          maxAliasExpansions: 100,
          maxOccurrences: 1000,
          maxRetainedBytes: 2_000_000,
        },
      },
      { session: opened.session },
    );
    const metadata = await collectUvMetadata(fixture.input, { session: opened.session });
    const uv = reconcileUvGraph({
      binding: fixture.input.binding,
      metadata,
      limits: { maxGraphWork: 10_000_000, maxRetainedBytes: 2_000_000 },
    });
    if (npm.kind !== 'inventory' || actions.kind !== 'inventory' || uv.kind !== 'inventory')
      throw new Error(JSON.stringify({ npm: npm.kind, actions: actions.kind, uv: uv.kind }));
    const input: UpstreamInput = {
      binding: fixture.input.binding,
      changes: [...npm.changes, ...actions.changes, ...uv.changes],
      sources: [...npm.sources, ...actions.sources, ...uv.sources],
      findings: [...npm.findings, ...uv.findings],
      npmInventory: npm,
      limits: upstreamTestLimits,
    };
    return {
      input,
      npm,
      actions,
      uv,
      fetch,
      requests,
      advisoryLimits: advisoryTestLimits,
      coverage: { npm: npm.coverage, actions: actions.coverage, uv: uv.coverage },
      relationships: [...npm.relationships, ...uv.relationships],
      expected: {
        binding: fixture.input.binding,
        baseSha: fixture.input.binding.baseSha,
        contextRevision: fixture.input.configRevision,
        context: { ok: true as const, status: 'disabled' as const, dependencies: [], reasons: [] },
      },
    };
  } finally {
    opened.session.close();
  }
}
/** S3-only scaffolding: these records do not represent a malware query or certify S3. */
export function addSyntheticMalwareCoverage(result: AdvisoryEnrichment) {
  const changes = structuredClone(result.changes),
    sources = [...result.sources];
  for (const change of changes) {
    if ('basis' in change) continue;
    const instance = change.to ?? change.from;
    if (!instance) throw new Error('side');
    const side = change.to ? ('head' as const) : ('base' as const);
    const value = 'ref' in instance ? instance.ref : instance.version;
    const id = 's3-scaffold:' + change.id;
    const source: PacketSource = {
      id,
      kind: 'malware',
      ecosystems: [change.ecosystem],
      memberIds: [change.id],
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'upstream',
        url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
        title: 'Synthetic S3 test scaffolding',
        excerpt: 'Invented unrelated malware coverage; no live lookup performed.',
        excerptTruncated: false,
        subjects: [{ memberId: change.id, side, value }],
        range: side === 'head' ? { from: null, to: value } : { from: value, to: null },
      },
    };
    sources.push(source);
    change.evidence.malware = { status: 'available', reasons: [], sourceIds: [id] };
  }
  return { changes, sources, findings: result.findings };
}
