import type { PacketChange, ActionsSide, EvidenceReason } from '../schema.js';
import { isPlainObject } from './common.js';
import {
  requireUpstream,
  upstreamText,
  UpstreamFailure,
  type UpstreamReader,
} from './upstream-read.js';
import {
  githubData,
  publicRepository,
  resolveUpstreamRef,
  releaseIdentity,
  releaseDocument,
  collectExactComparison,
  upstreamReason,
  type UpstreamDocument,
  type UpstreamResearch,
  type ResearchAttempt,
} from './upstream-github.js';
import { compareUpstreamVersions } from './upstream-version.js';

export type ActionMappingDraft = Readonly<{
  side: 'base' | 'head';
  action: string;
  ref: string;
  name: string;
  version: string;
  document: UpstreamDocument;
}>;
type ObservedRef = { sha: string; namespace: string | null };
async function observeRef(
  repository: string,
  instance: ActionsSide,
  reader: UpstreamReader,
): Promise<ObservedRef> {
  if (instance.refKind === 'sha') {
    requireUpstream(/^[a-f\d]{40}$/u.test(instance.ref), 'unsupported');
    const data = await githubData(reader, { repository, resource: 'commit', sha: instance.ref });
    requireUpstream(data.sha === instance.ref, 'conflict');
    return { sha: instance.ref, namespace: null };
  }
  const tag = await resolveUpstreamRef(repository, 'tags/' + instance.ref, reader);
  const branch = await resolveUpstreamRef(repository, 'heads/' + instance.ref, reader);
  requireUpstream(!(tag.status === 'available' && branch.status === 'available'), 'conflict');
  if (tag.status === 'available' && branch.status === 'unavailable' && branch.reason === 'missing')
    return { sha: tag.sha, namespace: 'tags/' + instance.ref };
  if (branch.status === 'available' && tag.status === 'unavailable' && tag.reason === 'missing')
    return { sha: branch.sha, namespace: 'heads/' + instance.ref };
  throw new UpstreamFailure(tag.status === 'unavailable' ? tag.reason : 'unknown');
}
async function recheck(repository: string, observed: ObservedRef, reader: UpstreamReader) {
  if (!observed.namespace) return;
  const next = await resolveUpstreamRef(repository, observed.namespace, reader);
  requireUpstream(next.status === 'available' && next.sha === observed.sha, 'conflict');
  const opposite = observed.namespace.startsWith('tags/') ? 'heads/' : 'tags/';
  const collision = await resolveUpstreamRef(
    repository,
    opposite + observed.namespace.slice(observed.namespace.indexOf('/') + 1),
    reader,
  );
  requireUpstream(collision.status === 'unavailable' && collision.reason === 'missing', 'conflict');
}
async function matchingReleases(repository: string, sha: string, reader: UpstreamReader) {
  const matches: { version: string; tag: string; data: Readonly<Record<string, unknown>> }[] = [];
  const seen = new Set<string>();
  let candidates = 0;
  for (let page = 1; page <= reader.limits.maxPages; page++) {
    const result = await reader.read({ kind: 'github', repository, resource: 'releases', page });
    requireUpstream(result.status === 'available' && result.data, result.reasons[0] ?? 'unknown');
    requireUpstream(Array.isArray(result.data.items));
    for (const item of result.data.items) {
      reader.spend(1);
      requireUpstream(++candidates <= reader.limits.maxTagCandidates, 'budget');
      requireUpstream(isPlainObject(item) && upstreamText(item.tag_name));
      if (item.draft === true) continue;
      const tag = item.tag_name,
        version = tag.replace(/^v/u, '');
      if (compareUpstreamVersions('npm', version, version) !== 0) continue;
      requireUpstream(!seen.has(tag), 'conflict');
      seen.add(tag);
      releaseIdentity(item, repository, tag);
      const resolved = await resolveUpstreamRef(repository, 'tags/' + tag, reader);
      requireUpstream(
        resolved.status === 'available',
        resolved.status === 'unavailable' ? resolved.reason : 'unknown',
      );
      if (resolved.sha === sha) matches.push({ version, tag, data: item });
    }
    if (!result.nextPage) return matches;
    requireUpstream(page < reader.limits.maxPages, 'budget');
  }
  throw new UpstreamFailure('budget');
}
async function mapping(
  instance: ActionsSide,
  side: 'base' | 'head',
  observed: ObservedRef,
  reader: UpstreamReader,
) {
  const repository = instance.action.split('/').slice(0, 2).join('/');
  requireUpstream(instance.action === repository, 'unsupported');
  const releases = await matchingReleases(repository, observed.sha, reader);
  const versions = new Set(releases.map((r) => r.version));
  requireUpstream(versions.size === 1, versions.size ? 'conflict' : 'missing');
  const selected = releases[0];
  const current = await resolveUpstreamRef(repository, 'tags/' + selected.tag, reader);
  requireUpstream(current.status === 'available' && current.sha === observed.sha, 'conflict');
  await recheck(repository, observed, reader);
  const identity = releaseIdentity(selected.data, repository, selected.tag);
  const draft: ActionMappingDraft = {
    side,
    action: instance.action,
    ref: instance.ref,
    name: repository,
    version: selected.version,
    document: {
      kind: 'metadata',
      ...identity,
      text: `Action ${instance.action}@${instance.ref} resolves to ${observed.sha}, exactly matching published tag ${selected.tag} and concrete version ${selected.version}.`,
      range: side === 'base' ? { from: instance.ref, to: null } : { from: null, to: instance.ref },
    },
  };
  return { draft, release: selected };
}
async function finalRefChecks(
  change: Extract<PacketChange, { ecosystem: 'actions' }>,
  observed: Map<'base' | 'head', ObservedRef>,
  mappings: ActionMappingDraft[],
  research: UpstreamResearch,
  reader: UpstreamReader,
) {
  for (const [side, value] of observed) {
    const instance = side === 'base' ? change.from : change.to;
    if (!instance) continue;
    try {
      await recheck(instance.action.split('/').slice(0, 2).join('/'), value, reader);
    } catch (error) {
      observed.delete(side);
      for (let i = mappings.length - 1; i >= 0; i--)
        if (mappings[i].side === side) mappings.splice(i, 1);
      const reason = upstreamReason(error);
      research.attempts.push({
        stage: 'mapping',
        target: 'Final ref recheck: ' + instance.ref,
        url: null,
        outcome: 'unavailable',
        reasons: [reason],
        range: null,
      });
      if (change.to ? side === 'head' : side === 'base') {
        research.sources = [];
        research.status = 'unavailable';
        research.reasons = [reason];
      }
    }
  }
}
export async function collectActionResearch(
  change: PacketChange,
  reader: UpstreamReader,
): Promise<{
  research: UpstreamResearch;
  mappings: ActionMappingDraft[];
}> {
  const mappings: ActionMappingDraft[] = [],
    attempts: ResearchAttempt[] = [];
  const research: UpstreamResearch = {
    status: 'unavailable',
    sources: [],
    attempts,
    reasons: ['unsupported'],
  };
  if (change.ecosystem !== 'actions') return { research, mappings };
  const observed = new Map<'base' | 'head', ObservedRef>();
  const sideErrors: EvidenceReason[] = [];
  for (const side of ['base', 'head'] as const) {
    const instance = side === 'base' ? change.from : change.to;
    if (!instance) continue;
    try {
      const repository = instance.action.split('/').slice(0, 2).join('/');
      await publicRepository(repository, reader);
      const ref = await observeRef(repository, instance, reader);
      observed.set(side, ref);
      const mapped = await mapping(instance, side, ref, reader);
      mappings.push(mapped.draft);
      attempts.push({
        stage: 'mapping',
        target: instance.action + '@' + instance.ref,
        url: mapped.draft.document.url,
        outcome: 'available',
        reasons: [],
        range: mapped.draft.document.range,
      });
      if (change.to ? side === 'head' : side === 'base') {
        const doc = releaseDocument(mapped.release.data, repository, mapped.release.tag);
        research.sources.push({
          ...doc,
          text: mapped.draft.document.text + '\n' + doc.text,
          range: { from: null, to: instance.ref },
        });
        research.status = 'available';
        research.reasons = [];
      }
    } catch (error) {
      const reason = upstreamReason(error);
      sideErrors.push(reason);
      attempts.push({
        stage: 'mapping',
        target: instance.action + '@' + instance.ref,
        url: null,
        outcome: reason === 'unsupported' ? 'skipped' : 'unavailable',
        reasons: [reason],
        range: null,
      });
    }
  }
  await finalRefChecks(change, observed, mappings, research, reader);
  const from = observed.get('base'),
    to = observed.get('head');
  if (
    research.status !== 'available' &&
    from &&
    to &&
    change.from &&
    change.to &&
    change.from.action === change.to.action
  ) {
    const repository = change.to.action.split('/').slice(0, 2).join('/');
    const compared = await collectExactComparison(
      repository,
      { sha: from.sha, value: change.from.ref },
      { sha: to.sha, value: change.to.ref },
      reader,
    );
    research.sources.push(...compared.sources);
    attempts.push(...compared.attempts);
    research.status = compared.status;
    research.reasons = compared.reasons;
  }
  if (research.status === 'unavailable')
    research.reasons = [...new Set([...research.reasons, ...sideErrors])];
  return { research, mappings };
}
