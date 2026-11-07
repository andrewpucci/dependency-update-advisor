import { createHash } from 'node:crypto';
import { isPlainObject, isEvidencePath } from './common.js';
import { readToml } from './uv-toml.js';
import {
  requireUpstream,
  upstreamCopy,
  upstreamText,
  UpstreamFailure,
  type UpstreamReader,
  type GithubUpstreamTarget,
} from './upstream-read.js';
import type { EvidenceReason } from '../schema.js';

export type UpstreamRepository = Readonly<{ repository: string; directory: string }>;
export type PackageResearchTarget = Readonly<{
  ecosystem: 'npm' | 'uv';
  name: string;
  version: string;
  metadata: Readonly<Record<string, unknown>>;
}>;
export type UpstreamDocument = Readonly<{
  kind: 'release' | 'compare' | 'metadata';
  url: string;
  title: string;
  text: string;
  range: { from: string | null; to: string | null } | null;
}>;
export type ResearchAttempt = Readonly<{
  stage: 'release' | 'compare' | 'range' | 'changelog' | 'mapping';
  target: string;
  url: string | null;
  outcome: 'available' | 'unavailable' | 'skipped';
  reasons: readonly EvidenceReason[];
  range: { from: string | null; to: string | null } | null;
}>;
export type UpstreamResearch = {
  status: 'available' | 'partial' | 'unavailable';
  reasons: EvidenceReason[];
  sources: UpstreamDocument[];
  attempts: ResearchAttempt[];
  repository?: UpstreamRepository;
  head?: { sha: string; ref: string };
};
export function upstreamReason(error: unknown): EvidenceReason {
  return error instanceof UpstreamFailure ? error.reason : 'malformed';
}
export async function githubData(
  reader: UpstreamReader,
  target: Omit<GithubUpstreamTarget, 'kind'>,
) {
  const result = await reader.read({ kind: 'github', ...target });
  requireUpstream(result.status === 'available' && result.data, result.reasons[0] ?? 'unknown');
  return result.data;
}
export async function publicRepository(repository: string, reader: UpstreamReader) {
  const data = await githubData(reader, { repository, resource: 'repository' });
  requireUpstream(
    data.private === false &&
      typeof data.full_name === 'string' &&
      data.full_name.toLowerCase() === repository.toLowerCase(),
    'conflict',
  );
}
export function repositoryCandidate(
  metadata: Readonly<Record<string, unknown>>,
): UpstreamRepository {
  const repo = metadata.repository;
  const candidates: unknown[] = [];
  if (typeof repo === 'string') candidates.push(repo);
  if (isPlainObject(repo)) candidates.push(repo.url);
  if (isPlainObject(metadata.project_urls))
    for (const [key, value] of Object.entries(metadata.project_urls)) {
      if (['source', 'source code', 'repository'].includes(key.toLowerCase()))
        candidates.push(value);
    }
  const normalized = new Set(
    candidates
      .filter((v): v is string => typeof v === 'string')
      .map((value) => {
        const url = new URL(value.replace(/^git\+https:/u, 'https:'));
        requireUpstream(
          url.origin === 'https://github.com' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash,
          'unsupported',
        );
        requireUpstream(/^\/[a-z\d][a-z\d-]*\/[a-z\d_.-]+\/?$/iu.test(url.pathname), 'unsupported');
        return url.pathname
          .replace(/^\/|\/$/gu, '')
          .replace(/\.git$/u, '')
          .toLowerCase();
      }),
  );
  requireUpstream(normalized.size === 1, normalized.size ? 'conflict' : 'unsupported');
  const directory = isPlainObject(repo) && repo.directory !== undefined ? repo.directory : '';
  requireUpstream(directory === '' || isEvidencePath(directory), 'unsupported');
  return { repository: [...normalized][0], directory: String(directory) };
}
export async function resolveUpstreamRef(
  repository: string,
  ref: string,
  reader: UpstreamReader,
): Promise<
  | { status: 'available'; sha: string; ref: string }
  | { status: 'unavailable'; reason: EvidenceReason }
> {
  try {
    const data = await githubData(reader, { repository, resource: 'ref', ref });
    requireUpstream(data.ref === 'refs/' + ref && isPlainObject(data.object), 'conflict');
    let object = data.object;
    const seen = new Set<string>();
    for (let depth = 0; depth <= reader.limits.maxTagDepth; depth++) {
      requireUpstream(typeof object.sha === 'string' && /^[a-f\d]{40}$/u.test(object.sha));
      requireUpstream(!seen.has(object.sha), 'conflict');
      seen.add(object.sha);
      if (object.type === 'commit') return { status: 'available', sha: object.sha, ref };
      requireUpstream(object.type === 'tag', 'unsupported');
      requireUpstream(depth < reader.limits.maxTagDepth, 'budget');
      const tag = await githubData(reader, { repository, resource: 'tag', sha: object.sha });
      requireUpstream(tag.sha === object.sha && isPlainObject(tag.object), 'conflict');
      object = tag.object;
    }
    throw new UpstreamFailure('budget');
  } catch (error) {
    return { status: 'unavailable', reason: upstreamReason(error) };
  }
}
export async function immutableContents(
  repo: UpstreamRepository,
  sha: string,
  path: string,
  reader: UpstreamReader,
) {
  const fullPath = repo.directory ? repo.directory + '/' + path : path;
  const data = await githubData(reader, {
    repository: repo.repository,
    resource: 'contents',
    sha,
    path: fullPath,
  });
  requireUpstream(
    data.type === 'file' && data.encoding === 'base64' && typeof data.content === 'string',
    'unsupported',
  );
  const encoded = data.content.replace(/\n/gu, '');
  requireUpstream(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(encoded));
  const bytes = Buffer.from(encoded, 'base64');
  requireUpstream(bytes.byteLength <= reader.limits.maxResponseBytes, 'budget');
  const hash = createHash('sha1')
    .update('blob ' + bytes.byteLength + '\0')
    .update(bytes)
    .digest('hex');
  requireUpstream(
    data.sha === hash && (data.size === undefined || data.size === bytes.length),
    'conflict',
  );
  return bytes;
}
async function packageManifest(
  target: PackageResearchTarget,
  repo: UpstreamRepository,
  sha: string,
  reader: UpstreamReader,
) {
  const path = target.ecosystem === 'npm' ? 'package.json' : 'pyproject.toml';
  const bytes = await immutableContents(repo, sha, path, reader);
  if (target.ecosystem === 'npm')
    return upstreamCopy(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      reader.limits,
    );
  const n = reader.limits.maxJsonEntries;
  const parsed = readToml(bytes, {
    maxFileBytes: reader.limits.maxResponseBytes,
    maxTomlDepth: reader.limits.maxJsonDepth,
    maxTomlEntries: n,
    maxStringBytes: reader.limits.maxResponseBytes,
    maxPackages: n,
    maxDeclarations: n,
    maxEdges: n,
    maxRequirementTokens: n,
    maxMarkerDepth: reader.limits.maxJsonDepth,
  });
  requireUpstream(
    parsed.kind === 'parsed',
    parsed.kind === 'unavailable' ? parsed.reason : 'malformed',
  );
  return parsed.value.project;
}
export async function packageCorrespondence(
  target: PackageResearchTarget,
  repo: UpstreamRepository,
  sha: string,
  reader: UpstreamReader,
) {
  const manifest = await packageManifest(target, repo, sha, reader);
  requireUpstream(isPlainObject(manifest) && typeof manifest.name === 'string', 'unsupported');
  const name =
    target.ecosystem === 'uv'
      ? manifest.name.toLowerCase().replace(/[-_.]+/gu, '-')
      : manifest.name;
  requireUpstream(name === target.name && manifest.version === target.version, 'conflict');
}
export function releaseIdentity(
  data: Readonly<Record<string, unknown>>,
  repository: string,
  tag: string,
): { url: string; title: string } {
  requireUpstream(
    Number.isSafeInteger(data.id) && Number(data.id) > 0 && data.tag_name === tag,
    'conflict',
  );
  requireUpstream(
    data.draft === false &&
      upstreamText(data.published_at) &&
      Number.isFinite(Date.parse(data.published_at)),
    'missing',
  );
  const url = 'https://github.com/' + repository + '/releases/tag/' + encodeURIComponent(tag);
  requireUpstream(
    typeof data.html_url === 'string' &&
      decodeURIComponent(new URL(data.html_url).pathname) ===
        '/' + repository + '/releases/tag/' + tag &&
      new URL(data.html_url).origin === 'https://github.com' &&
      !new URL(data.html_url).search &&
      !new URL(data.html_url).hash &&
      !new URL(data.html_url).username &&
      !new URL(data.html_url).password,
    'conflict',
  );
  return { url, title: upstreamText(data.name) ? data.name : tag };
}
export function releaseDocument(
  data: Readonly<Record<string, unknown>>,
  repository: string,
  tag: string,
): Omit<UpstreamDocument, 'range'> {
  const identity = releaseIdentity(data, repository, tag);
  requireUpstream(typeof data.body === 'string' && data.body.trim().length > 0, 'missing');
  return { kind: 'release', ...identity, text: data.body };
}
export async function targetAtTag(
  target: PackageResearchTarget,
  repo: UpstreamRepository,
  tag: string,
  reader: UpstreamReader,
) {
  const resolved = await resolveUpstreamRef(repo.repository, 'tags/' + tag, reader);
  requireUpstream(
    resolved.status === 'available',
    resolved.status === 'unavailable' ? resolved.reason : 'unknown',
  );
  await packageCorrespondence(target, repo, resolved.sha, reader);
  const release = await githubData(reader, {
    repository: repo.repository,
    resource: 'release',
    ref: tag,
  });
  const document = releaseDocument(release, repo.repository, tag);
  const recheck = await resolveUpstreamRef(repo.repository, 'tags/' + tag, reader);
  requireUpstream(recheck.status === 'available' && recheck.sha === resolved.sha, 'conflict');
  return { document, resolved };
}
export async function collectTargetRelease(
  target: PackageResearchTarget,
  reader: UpstreamReader,
): Promise<UpstreamResearch> {
  const result: UpstreamResearch = {
    status: 'unavailable',
    reasons: [],
    sources: [],
    attempts: [],
  };
  try {
    const repo = repositoryCandidate(target.metadata);
    await publicRepository(repo.repository, reader);
    result.repository = repo;
    const candidates = ['v' + target.version, target.version];
    if (repo.directory) candidates.push(target.name + '@' + target.version);
    for (const [index, tag] of candidates.entries()) {
      const url =
        'https://github.com/' + repo.repository + '/releases/tag/' + encodeURIComponent(tag);
      try {
        requireUpstream(index < reader.limits.maxTagCandidates, 'budget');
        const { document, resolved } = await targetAtTag(target, repo, tag, reader);
        result.sources.push({
          ...document,
          text: `Tag ${tag} resolves to ${resolved.sha}; package identity verified.\n${document.text}`,
          range: { from: null, to: target.version },
        });
        result.head = { sha: resolved.sha, ref: tag };
        result.status = 'available';
        result.attempts.push({
          stage: 'release',
          target: tag,
          url,
          outcome: 'available',
          reasons: [],
          range: { from: null, to: target.version },
        });
        return result;
      } catch (error) {
        const reason = upstreamReason(error);
        result.reasons.push(reason);
        result.attempts.push({
          stage: 'release',
          target: tag,
          url,
          outcome: index < reader.limits.maxTagCandidates ? 'unavailable' : 'skipped',
          reasons: [reason],
          range: { from: null, to: target.version },
        });
      }
    }
  } catch (error) {
    const reason = upstreamReason(error);
    result.reasons.push(reason);
    result.attempts.push({
      stage: 'release',
      target: target.version,
      url: null,
      outcome: 'skipped',
      reasons: [reason],
      range: null,
    });
  }
  result.reasons = [...new Set(result.reasons)];
  return result;
}

type Endpoint = Readonly<{ sha: string; value: string }>;
type ComparisonState = {
  valid: boolean;
  total: number | null;
  messages: Map<string, string>;
  forward: boolean;
  filesComplete: boolean;
  reasons: Set<EvidenceReason>;
};
function comparisonIdentity(
  data: Readonly<Record<string, unknown>>,
  base: Endpoint,
  state: ComparisonState,
) {
  requireUpstream(isPlainObject(data.base_commit) && data.base_commit.sha === base.sha, 'conflict');
  requireUpstream(isPlainObject(data.merge_base_commit));
  requireUpstream(Number.isSafeInteger(data.total_commits) && Number(data.total_commits) >= 0);
  requireUpstream(state.total === null || state.total === data.total_commits, 'conflict');
  state.total = Number(data.total_commits);
  state.forward =
    data.status === 'ahead' &&
    data.behind_by === 0 &&
    data.ahead_by === state.total &&
    data.merge_base_commit.sha === base.sha;
  if (!state.forward) state.reasons.add('unsupported');
}
function comparisonCommits(data: Readonly<Record<string, unknown>>, state: ComparisonState) {
  requireUpstream(Array.isArray(data.commits));
  for (const commit of data.commits) {
    requireUpstream(
      isPlainObject(commit) && typeof commit.sha === 'string' && /^[a-f\d]{40}$/u.test(commit.sha),
    );
    requireUpstream(isPlainObject(commit.commit) && typeof commit.commit.message === 'string');
    requireUpstream(!state.messages.has(commit.sha), 'conflict');
    state.messages.set(commit.sha, commit.commit.message);
  }
  requireUpstream(state.messages.size <= state.total!, 'conflict');
}
function comparisonFiles(data: Readonly<Record<string, unknown>>, state: ComparisonState) {
  requireUpstream(Array.isArray(data.files));
  state.filesComplete =
    data.files.length < 300 &&
    data.files.every(
      (file) =>
        isPlainObject(file) && upstreamText(file.filename) && typeof file.patch === 'string',
    );
  if (!state.filesComplete) state.reasons.add('truncated');
}
async function comparisonPages(
  repository: string,
  base: Endpoint,
  head: Endpoint,
  reader: UpstreamReader,
) {
  const state: ComparisonState = {
    valid: false,
    total: null,
    messages: new Map(),
    forward: false,
    filesComplete: false,
    reasons: new Set(),
  };
  for (let page = 1; page <= reader.limits.maxPages; page++) {
    try {
      const result = await reader.read({
        kind: 'github',
        repository,
        resource: 'compare',
        base: base.sha,
        head: head.sha,
        page,
      });
      requireUpstream(result.status === 'available' && result.data, result.reasons[0] ?? 'unknown');
      comparisonIdentity(result.data, base, state);
      comparisonCommits(result.data, state);
      if (page === 1) comparisonFiles(result.data, state);
      state.valid = true;
      if (!result.nextPage) {
        if (state.messages.size !== state.total) state.reasons.add('truncated');
        if (state.forward && [...state.messages.keys()].at(-1) !== head.sha)
          state.reasons.add('conflict');
        return state;
      }
      requireUpstream(page < reader.limits.maxPages, 'budget');
    } catch (error) {
      state.reasons.add(upstreamReason(error));
      return state;
    }
  }
  return state;
}
export async function collectExactComparison(
  repository: string,
  base: Endpoint,
  head: Endpoint,
  reader: UpstreamReader,
): Promise<UpstreamResearch> {
  const state = await comparisonPages(repository, base, head, reader);
  const url = 'https://github.com/' + repository + '/compare/' + base.sha + '...' + head.sha;
  const reasons = [...state.reasons];
  const status = !state.valid ? 'unavailable' : reasons.length ? 'partial' : 'available';
  return {
    status,
    reasons,
    sources: state.valid
      ? [
          {
            kind: 'compare',
            url,
            title: `${base.value} to ${head.value} upstream comparison`,
            text:
              `Exact commits ${base.sha} to ${head.sha}. ${status === 'available' ? 'Complete bounded comparison.' : 'Partial comparison; not all changes were reviewed.'}\n` +
              [...state.messages.values()].join('\n'),
            range: { from: base.value, to: head.value },
          },
        ]
      : [],
    attempts: [
      {
        stage: 'compare',
        target: base.value + '...' + head.value,
        url,
        outcome: state.valid ? 'available' : 'unavailable',
        reasons,
        range: { from: base.value, to: head.value },
      },
    ],
  };
}
export async function resolvePackageVersion(
  target: PackageResearchTarget,
  repo: UpstreamRepository,
  reader: UpstreamReader,
) {
  const candidates = ['v' + target.version, target.version];
  if (repo.directory) candidates.push(target.name + '@' + target.version);
  let failure: EvidenceReason = 'missing';
  for (const [index, tag] of candidates.entries()) {
    requireUpstream(index < reader.limits.maxTagCandidates, 'budget');
    const resolved = await resolveUpstreamRef(repo.repository, 'tags/' + tag, reader);
    if (resolved.status !== 'available') {
      failure = resolved.reason;
      continue;
    }
    await packageCorrespondence(target, repo, resolved.sha, reader);
    const check = await resolveUpstreamRef(repo.repository, 'tags/' + tag, reader);
    requireUpstream(check.status === 'available' && check.sha === resolved.sha, 'conflict');
    return { sha: resolved.sha, value: target.version, ref: tag };
  }
  throw new UpstreamFailure(failure);
}
export async function collectPackageComparison(
  base: PackageResearchTarget,
  head: PackageResearchTarget,
  reader: UpstreamReader,
): Promise<UpstreamResearch> {
  try {
    requireUpstream(
      base.ecosystem === head.ecosystem && base.name === head.name && base.version !== head.version,
      'unsupported',
    );
    const before = repositoryCandidate(base.metadata),
      after = repositoryCandidate(head.metadata);
    requireUpstream(
      before.repository === after.repository && before.directory === after.directory,
      'conflict',
    );
    await publicRepository(before.repository, reader);
    const from = await resolvePackageVersion(base, before, reader),
      to = await resolvePackageVersion(head, after, reader);
    return {
      ...(await collectExactComparison(before.repository, from, to, reader)),
      repository: after,
      head: { sha: to.sha, ref: to.ref },
    };
  } catch (error) {
    const reason = upstreamReason(error);
    return {
      status: 'unavailable',
      reasons: [reason],
      sources: [],
      attempts: [
        {
          stage: 'compare',
          target: base.version + '...' + head.version,
          url: null,
          outcome: 'skipped',
          reasons: [reason],
          range: { from: base.version, to: head.version },
        },
      ],
    };
  }
}
