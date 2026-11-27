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
import { viaAdvisoryHttp } from './advisory-http.js';
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
  uvArtifacts?: boolean;
  partialActionsInventory?: boolean;
  actionChange?: 'owner' | 'mutable';
  anchorUnchanged?: boolean;
  duplicateNames?: number;
  /** Transitive pip packages under the uv `orbit` member, each moving from 1.0.0 to 2.0.0. */
  uvChildren?: number;
  /** Direct pip packages the project declares beside `orbit`, each moving from 1.0.0 to 2.0.0. */
  uvDirect?: number;
  /** Pads each PyPI version response's description to about this many bytes, as a README is. */
  pypiDescriptionBytes?: number;
  /**
   * Gives each GitHub release of a pip package this many wheel asset records, shaped as the REST
   * API returns them, so a member's upstream reads carry a real package's size.
   */
  pipReleaseAssets?: number;
  /** Discovery records for one spelling; the harness default stores each target as itself. */
  stored?: Parameters<typeof viaAdvisoryHttp>[1];
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
      ...packageNode('orbit', options.anchorUnchanged ? '1.0.0' : version),
      dependencies: Object.fromEntries(names.map((n) => [n, '*'])),
    },
    ...(options.declaration ? { 'node_modules/steady': packageNode('steady', '1.0.0') } : {}),
    ...Object.fromEntries(
      names.map((name) => ['node_modules/' + name, packageNode(name, version)]),
    ),
    // Same-named nested additions at a different version than the hoisted copy, as in R1.
    ...Object.fromEntries(
      Array.from({ length: head ? (options.duplicateNames ?? 0) : 0 }, (_, i) => [
        'node_modules/orbit/node_modules/child-' + i,
        packageNode('child-' + i, '1.0.0'),
      ]),
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
const BOT = 'https://api.github.com/users/github-actions%5Bbot%5D';
/** The uploader of a release asset built in Actions, as the REST API returns it. */
const ACTIONS_BOT = {
  login: 'github-actions[bot]',
  id: 41_898_282,
  node_id: 'MDM6Qm90NDE4OTgyODI=',
  avatar_url: 'https://avatars.githubusercontent.com/in/15368?v=4',
  gravatar_id: '',
  url: BOT,
  html_url: 'https://github.com/apps/github-actions',
  followers_url: `${BOT}/followers`,
  following_url: `${BOT}/following{/other_user}`,
  gists_url: `${BOT}/gists{/gist_id}`,
  starred_url: `${BOT}/starred{/owner}{/repo}`,
  subscriptions_url: `${BOT}/subscriptions`,
  organizations_url: `${BOT}/orgs`,
  repos_url: `${BOT}/repos`,
  events_url: `${BOT}/events{/privacy}`,
  received_events_url: `${BOT}/received_events`,
  type: 'Bot',
  user_view_type: 'public',
  site_admin: false,
};
/** One GitHub release asset record, shaped as the REST API returns it. */
function releaseAsset(repository: string, version: string, index: number) {
  const name = `pkg-${version}-${index}-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`;
  return {
    url: `https://api.github.com/repos/${repository}/releases/assets/${100_000 + index}`,
    id: 100_000 + index,
    node_id: `RA_kwDOFixture${index}`,
    name,
    label: '',
    uploader: ACTIONS_BOT,
    content_type: 'application/octet-stream',
    state: 'uploaded',
    size: 1_234_567,
    download_count: 42,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
  };
}
function pipRelease(repository: string, version: string, assets = 0) {
  const plain = release(repository, version);
  if (!assets || !repository.split('/')[1]?.startsWith('py-')) return plain;
  return {
    ...plain,
    assets: Array.from({ length: assets }, (_, i) => releaseAsset(repository, version, i)),
  };
}
function githubResponse(url: URL, options: Options) {
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
      ? Response.json(pipRelease(repository, version, options.pipReleaseAssets))
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
  return viaAdvisoryHttp(async (value: string, init: RequestInit) => {
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
              description: 'Exact PyPI version metadata.'.padEnd(
                options.pypiDescriptionBytes ?? 0,
                ' Release notes and usage.',
              ),
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
    if (url.origin === 'https://api.github.com') return githubResponse(url, options);
    throw new Error('Unexpected research host');
  }, options.stored);
}
/** Invented HTTP/file snapshots through authentic collectors; no public-identity proof is pre-filled. */
export async function upstreamScenario(options: Options = {}) {
  const artifacts = (version: string) =>
    options.uvArtifacts
      ? `sdist={url="https://files.pythonhosted.org/orbit-${version}.tar.gz",hash="sha256:${'a'.repeat(64)}"}\nwheels=[{url="https://files.pythonhosted.org/orbit-${version}.whl",hash="sha256:${'b'.repeat(64)}"}]\n`
      : '';
  const direct = Array.from({ length: options.uvDirect ?? 0 }, (_, i) => `pydirect-${i}`);
  const manifest = uvManifest.replace(
    'dependencies=["orbit>=1"]',
    `dependencies=[${['orbit', ...direct].map((name) => `"${name}>=1"`).join(',')}]`,
  );
  const python = (head: boolean) => {
    const version = head ? '2.0.0' : '1.0.0';
    const children = Array.from({ length: options.uvChildren ?? 0 }, (_, i) => `pychild-${i}`);
    const dependencies = children.length
      ? `dependencies=[${children.map((name) => `{name="${name}"}`).join(',')}]\n`
      : '';
    const declared = ['orbit', ...direct];
    if (!options.uvVariants)
      return (
        uvLock(version, dependencies + artifacts(version))
          .replace(
            'dependencies=[{name="orbit"}]',
            `dependencies=[${declared.map((name) => `{name="${name}"}`).join(',')}]`,
          )
          .replace(
            'requires-dist=[{name="orbit",specifier=">=1"}]',
            `requires-dist=[${declared.map((name) => `{name="${name}",specifier=">=1"}`).join(',')}]`,
          ) + [...children, ...direct].map((name) => uvPackage(name, version)).join('')
      );
    return (
      uvLock(version, 'resolution-markers=["sys_platform == \'linux\'"]\n' + artifacts(version)) +
      uvPackage(
        'orbit',
        version + '+other',
        'resolution-markers=["sys_platform != \'linux\'"]\n' + artifacts(version + '+other'),
      )
    );
  };
  const files = (head: boolean) => ({
    ...npmFiles(head, options),
    'pyproject.toml': manifest,
    'uv.lock': python(head),
    '.github/workflows/ci.yml': `jobs:\n  review:\n    steps:\n      - uses: ${head && options.actionChange === 'owner' ? 'other-owner/action' : 'fixture/action'}${options.actionsSubpath ? '/component' : ''}@${head && options.actionChange === 'mutable' ? 'v2.0.0' : (head ? '2' : '1').repeat(40)}\n`,
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
          maxYamlNodes: options.partialActionsInventory ? 1 : 100_000,
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
      consumerFetch: fixture.fetch,
      consumerReadLimits: fixture.readLimits,
      artifactParseLimits: fixture.input.limits,
      npm,
      actions,
      uv,
      fetch,
      requests,
      advisoryLimits: advisoryTestLimits,
      coverage: { npm: npm.coverage, actions: actions.coverage, uv: uv.coverage },
      relationships: [...npm.relationships, ...uv.relationships],
      reachability: [],
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
