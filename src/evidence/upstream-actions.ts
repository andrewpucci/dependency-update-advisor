import type { PacketChange, ActionsSide, EvidenceReason } from '../schema.js';
import { isPlainObject } from './common.js';
import {
  requireUpstream,
  upstreamText,
  UpstreamFailure,
  upstreamFailureReason,
  type UpstreamReader,
} from './upstream-read.js';
import {
  githubData,
  publicRepository,
  resolveUpstreamRef,
  releaseIdentity,
  releaseDocument,
  collectExactComparison,
  type UpstreamDocument,
  type UpstreamResearch,
  type ResearchAttempt,
} from './upstream-github.js';
import { compareUpstreamVersions } from './upstream-version.js';

export type ActionMappingDraft = Readonly<{
  tag: string;
  sha: string;
  side: 'base' | 'head';
  action: string;
  ref: string;
  name: string;
  version: string;
  document: UpstreamDocument;
}>;
type ObservedRef = { sha: string; namespace: string | null };
/** Release-enumeration tag reads shared by both sides of one change; proof rechecks stay fresh. */
type TagReads = Map<string, Awaited<ReturnType<typeof resolveUpstreamRef>>>;
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
async function releaseAtCommit(
  repository: string,
  sha: string,
  item: unknown,
  seen: Set<string>,
  tags: TagReads,
  reader: UpstreamReader,
) {
  requireUpstream(isPlainObject(item) && upstreamText(item.tag_name));
  if (item.draft === true) return;
  const tag = item.tag_name,
    version = tag.replace(/^v/u, '');
  if (compareUpstreamVersions('npm', version, version) !== 0) return;
  requireUpstream(!seen.has(tag), 'conflict');
  seen.add(tag);
  releaseIdentity(item, repository, tag);
  const key = repository + '\n' + tag;
  const resolved = tags.get(key) ?? (await resolveUpstreamRef(repository, 'tags/' + tag, reader));
  tags.set(key, resolved);
  requireUpstream(
    resolved.status === 'available',
    resolved.status === 'unavailable' ? resolved.reason : 'unknown',
  );
  if (resolved.sha === sha) return { version, tag, data: item };
}
async function matchingReleases(
  repository: string,
  sha: string,
  tags: TagReads,
  reader: UpstreamReader,
) {
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
      const match = await releaseAtCommit(repository, sha, item, seen, tags, reader);
      if (match) matches.push(match);
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
  tags: TagReads,
  reader: UpstreamReader,
) {
  const repository = instance.action.split('/').slice(0, 2).join('/');
  requireUpstream(instance.action === repository, 'unsupported');
  const releases = await matchingReleases(repository, observed.sha, tags, reader);
  const versions = new Set(releases.map((r) => r.version));
  requireUpstream(versions.size === 1, versions.size ? 'conflict' : 'missing');
  const selected = releases[0];
  const current = await resolveUpstreamRef(repository, 'tags/' + selected.tag, reader);
  requireUpstream(current.status === 'available' && current.sha === observed.sha, 'conflict');
  await recheck(repository, observed, reader);
  const identity = releaseIdentity(selected.data, repository, selected.tag);
  const draft: ActionMappingDraft = {
    tag: selected.tag,
    sha: observed.sha,
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
function retainTargetRelease(
  change: Extract<PacketChange, { ecosystem: 'actions' }>,
  side: 'base' | 'head',
  mapped: Awaited<ReturnType<typeof mapping>>,
  research: UpstreamResearch,
) {
  if (change.to ? side !== 'head' : side !== 'base') return;
  const target = mapped.draft.action + '@' + mapped.release.tag;
  try {
    const doc = releaseDocument(mapped.release.data, mapped.draft.name, mapped.release.tag);
    research.sources.push({
      ...doc,
      text: mapped.draft.document.text + '\n' + doc.text,
      range: { from: null, to: mapped.draft.ref },
    });
    research.status = 'available';
    research.reasons = [];
  } catch (error) {
    // The mapping already stands; only the notes for its release are unusable.
    const reason = upstreamFailureReason(error);
    research.attempts.push({
      side,
      stage: 'release',
      target,
      url: mapped.draft.document.url,
      outcome: 'unavailable',
      reasons: [reason],
      range: { from: null, to: mapped.draft.ref },
    });
    return reason;
  }
}
function discardMapping(mappings: ActionMappingDraft[], side: 'base' | 'head') {
  for (let i = mappings.length - 1; i >= 0; i--)
    if (mappings[i].side === side) mappings.splice(i, 1);
}
function recheckFailure(
  research: UpstreamResearch,
  side: 'base' | 'head',
  target: string,
  error: unknown,
) {
  const reason = upstreamFailureReason(error);
  research.attempts.push({
    side,
    stage: 'mapping',
    target,
    url: null,
    outcome: 'unavailable',
    reasons: [reason],
    range: null,
  });
  return reason;
}
function invalidateComparison(research: UpstreamResearch, reason: EvidenceReason) {
  if (!research.sources.some((doc) => doc.kind === 'compare')) return;
  research.sources = research.sources.map((doc) =>
    doc.kind === 'compare'
      ? {
          ...doc,
          range: null,
          text:
            'An inventory ref changed after collection; exact ref applicability is unknown.\n' +
            doc.text,
        }
      : doc,
  );
  research.status = 'partial';
  research.reasons = [...new Set([...research.reasons, reason])];
}
async function mappingTagsStable(
  repository: string,
  side: 'base' | 'head',
  mappings: ActionMappingDraft[],
  reader: UpstreamReader,
) {
  for (const proof of mappings.filter((m) => m.side === side)) {
    const release = await resolveUpstreamRef(repository, 'tags/' + proof.tag, reader);
    requireUpstream(release.status === 'available' && release.sha === proof.sha, 'conflict');
  }
}
async function finalMappingCheck(
  change: Extract<PacketChange, { ecosystem: 'actions' }>,
  side: 'base' | 'head',
  mappings: ActionMappingDraft[],
  research: UpstreamResearch,
  reader: UpstreamReader,
) {
  const instance = side === 'base' ? change.from : change.to;
  if (!instance) return;
  const repository = instance.action.split('/').slice(0, 2).join('/');
  const requiredSide = change.to ? side === 'head' : side === 'base';
  try {
    await mappingTagsStable(repository, side, mappings, reader);
  } catch (error) {
    discardMapping(mappings, side);
    const reason = recheckFailure(
      research,
      side,
      'Final release tag recheck: ' + instance.ref,
      error,
    );
    if (!requiredSide) return;
    research.sources = research.sources.filter((doc) => doc.kind !== 'release');
    if (!research.sources.length) {
      research.status = 'unavailable';
      research.reasons = [reason];
    }
  }
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
    const repository = instance.action.split('/').slice(0, 2).join('/');
    const requiredSide = change.to ? side === 'head' : side === 'base';
    try {
      await recheck(repository, value, reader);
    } catch (error) {
      observed.delete(side);
      discardMapping(mappings, side);
      const reason = recheckFailure(
        research,
        side,
        'Final inventory ref recheck: ' + instance.ref,
        error,
      );
      if (requiredSide) {
        research.sources = [];
        research.status = 'unavailable';
        research.reasons = [reason];
      } else invalidateComparison(research, reason);
      continue;
    }
    await finalMappingCheck(change, side, mappings, research, reader);
  }
}
async function compareActionFallback(
  change: Extract<PacketChange, { ecosystem: 'actions' }>,
  observed: Map<'base' | 'head', ObservedRef>,
  mappings: ActionMappingDraft[],
  research: UpstreamResearch,
  reader: UpstreamReader,
) {
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
    research.attempts.push(...compared.attempts);
    research.status = compared.status;
    research.reasons = compared.reasons;
    await finalRefChecks(change, observed, mappings, research, reader);
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
  const tags: TagReads = new Map();
  for (const side of ['base', 'head'] as const) {
    const instance = side === 'base' ? change.from : change.to;
    if (!instance) continue;
    try {
      const repository = instance.action.split('/').slice(0, 2).join('/');
      await publicRepository(repository, reader);
      const ref = await observeRef(repository, instance, reader);
      observed.set(side, ref);
      const mapped = await mapping(instance, side, ref, tags, reader);
      mappings.push(mapped.draft);
      attempts.push({
        side,
        stage: 'mapping',
        target: instance.action + '@' + instance.ref,
        url: mapped.draft.document.url,
        outcome: 'available',
        reasons: [],
        range: mapped.draft.document.range,
      });
      const notesFailure = retainTargetRelease(change, side, mapped, research);
      if (notesFailure) sideErrors.push(notesFailure);
    } catch (error) {
      const reason = upstreamFailureReason(error);
      sideErrors.push(reason);
      attempts.push({
        side,
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
  await compareActionFallback(change, observed, mappings, research, reader);
  if (research.status === 'unavailable')
    research.reasons = [...new Set([...research.reasons, ...sideErrors])];
  return { research, mappings };
}
