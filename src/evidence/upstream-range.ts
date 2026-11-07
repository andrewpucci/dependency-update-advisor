import { PACKET_LIMITS } from '../schema.js';
import { isPlainObject } from './common.js';
import { requireUpstream, upstreamText, type UpstreamReader } from './upstream-read.js';
import {
  repositoryCandidate,
  publicRepository,
  resolveUpstreamRef,
  packageCorrespondence,
  releaseDocument,
  immutableContents,
  resolvePackageVersion,
  upstreamReason,
  type PackageResearchTarget,
  type UpstreamRepository,
  type UpstreamResearch,
} from './upstream-github.js';
import { withinUpstreamRange, compareUpstreamVersions } from './upstream-version.js';

function empty(): UpstreamResearch {
  return { status: 'unavailable', sources: [], attempts: [], reasons: ['unsupported'] };
}
function failed(
  result: UpstreamResearch,
  stage: 'range' | 'changelog',
  target: string,
  error: unknown,
  url: string | null = null,
) {
  const reason = upstreamReason(error);
  result.reasons = [...new Set([...result.reasons, reason])];
  result.attempts.push({
    stage,
    target,
    url,
    outcome: reason === 'unsupported' ? 'skipped' : 'unavailable',
    reasons: [reason],
    range: null,
  });
  result.status = result.sources.length ? 'partial' : 'unavailable';
}
async function intermediate(
  item: unknown,
  before: PackageResearchTarget,
  after: PackageResearchTarget,
  repo: UpstreamRepository,
  reader: UpstreamReader,
  result: UpstreamResearch,
) {
  requireUpstream(isPlainObject(item) && upstreamText(item.tag_name));
  if (item.draft === true) return;
  const tag = item.tag_name;
  const prefix = repo.directory ? after.name + '@' : '';
  const version = (prefix && tag.startsWith(prefix) ? tag.slice(prefix.length) : tag).replace(
    /^v/u,
    '',
  );
  if (withinUpstreamRange(after.ecosystem, version, before.version, after.version) !== true) return;
  const url = 'https://github.com/' + repo.repository + '/releases/tag/' + encodeURIComponent(tag);
  try {
    requireUpstream(result.sources.length < PACKET_LIMITS.listEntries, 'budget');
    const resolved = await resolveUpstreamRef(repo.repository, 'tags/' + tag, reader);
    requireUpstream(
      resolved.status === 'available',
      resolved.status === 'unavailable' ? resolved.reason : 'unknown',
    );
    await packageCorrespondence({ ...after, version }, repo, resolved.sha, reader);
    const doc = releaseDocument(item, repo.repository, tag);
    const checked = await resolveUpstreamRef(repo.repository, 'tags/' + tag, reader);
    requireUpstream(checked.status === 'available' && checked.sha === resolved.sha, 'conflict');
    result.sources.push({
      ...doc,
      range: null,
      text: `Intermediate release ${version}; partial context only, with unknown applicability to the exact proposal.\n${doc.text}`,
    });
    result.attempts.push({
      stage: 'range',
      target: tag,
      url,
      outcome: 'available',
      reasons: [],
      range: { from: version, to: version },
    });
    result.status = 'partial';
  } catch (error) {
    failed(result, 'range', tag, error, url);
  }
}
export async function collectRangeFallback(
  before: PackageResearchTarget,
  after: PackageResearchTarget,
  reader: UpstreamReader,
): Promise<UpstreamResearch> {
  const result = empty();
  try {
    requireUpstream(
      before.name === after.name &&
        before.ecosystem === after.ecosystem &&
        compareUpstreamVersions(after.ecosystem, before.version, after.version) === -1,
      'unsupported',
    );
    const repo = repositoryCandidate(after.metadata),
      previous = repositoryCandidate(before.metadata);
    requireUpstream(
      repo.repository === previous.repository && repo.directory === previous.directory,
      'conflict',
    );
    await publicRepository(repo.repository, reader);
    result.repository = repo;
    let count = 0;
    const seen = new Set<string>();
    for (let page = 1; page <= reader.limits.maxPages; page++) {
      const lookup = await reader.read({
        kind: 'github',
        repository: repo.repository,
        resource: 'releases',
        page,
      });
      requireUpstream(lookup.status === 'available' && lookup.data, lookup.reasons[0] ?? 'unknown');
      requireUpstream(Array.isArray(lookup.data.items));
      for (const item of lookup.data.items) {
        requireUpstream(++count <= reader.limits.maxTagCandidates, 'budget');
        requireUpstream(isPlainObject(item) && upstreamText(item.tag_name));
        requireUpstream(!seen.has(item.tag_name), 'conflict');
        seen.add(item.tag_name);
        await intermediate(item, before, after, repo, reader, result);
      }
      if (!lookup.nextPage) {
        result.attempts.push({
          stage: 'range',
          target: before.version + '...' + after.version,
          url: 'https://github.com/' + repo.repository + '/releases',
          outcome: result.sources.length ? 'available' : 'unavailable',
          reasons: result.reasons,
          range: { from: before.version, to: after.version },
        });
        return result;
      }
      requireUpstream(page < reader.limits.maxPages, 'budget');
    }
  } catch (error) {
    failed(result, 'range', before.version + '...' + after.version, error);
  }
  return result;
}
export async function collectChangelog(
  target: PackageResearchTarget,
  reader: UpstreamReader,
): Promise<UpstreamResearch> {
  const result = empty();
  try {
    const repo = repositoryCandidate(target.metadata);
    await publicRepository(repo.repository, reader);
    const resolved = await resolvePackageVersion(target, repo, reader);
    result.repository = repo;
    result.head = { sha: resolved.sha, ref: resolved.ref };
    for (const path of ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']) {
      const fullPath = repo.directory ? repo.directory + '/' + path : path;
      const url =
        'https://github.com/' + repo.repository + '/blob/' + resolved.sha + '/' + fullPath;
      try {
        const bytes = await immutableContents(repo, resolved.sha, path, reader);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        requireUpstream(text.trim().length > 0, 'missing');
        result.sources.push({
          kind: 'metadata',
          url,
          title: `${target.name} immutable changelog context`,
          text: `Partial changelog context from ${resolved.sha}; applicable version range is unknown.\n${text}`,
          range: null,
        });
        result.attempts.push({
          stage: 'changelog',
          target: path,
          url,
          outcome: 'available',
          reasons: [],
          range: null,
        });
        result.status = 'partial';
        return result;
      } catch (error) {
        failed(result, 'changelog', path, error, url);
      }
    }
  } catch (error) {
    failed(result, 'changelog', target.version, error);
  }
  return result;
}
