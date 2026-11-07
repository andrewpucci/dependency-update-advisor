import type { PacketChange } from '../schema.js';
import { resolveAdvisoryTarget } from './advisories.js';
import { observeRef, matchingReleases, recheck } from './upstream-actions.js';
import { resolveUpstreamRef, publicRepository, releaseIdentity } from './upstream-github.js';
import { requireUpstream, upstreamFailureReason, type UpstreamReader } from './upstream-read.js';
import { publishTimestamp } from './npm-publish-times.js';
import {
  recordSignal,
  attachSignalCoverage,
  retainSignalFinding,
  signalId,
  type PolicySignalInput,
  type SignalEnrichment,
} from './policy-signals.js';

export function attachActionInventoryFindings(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
) {
  if (change.ecosystem !== 'actions' || !change.from || !change.to) return;
  const from = change.from,
    to = change.to;
  const kinds: ('action_identity' | 'mutable_action_ref')[] = [];
  if (
    from.action.split('/').slice(0, 2).join('/').toLowerCase() !==
    to.action.split('/').slice(0, 2).join('/').toLowerCase()
  )
    kinds.push('action_identity');
  if (from.refKind === 'sha' && to.refKind !== 'sha') kinds.push('mutable_action_ref');
  for (const kind of kinds)
    retainSignalFinding(output, {
      id: signalId(input.binding.identity, change.id, kind),
      memberId: change.id,
      kind: 'supplyChainChange',
      change: kind,
      references: [...new Set([from.sourceId, to.sourceId])],
      rationale:
        kind === 'action_identity'
          ? 'The immutable workflow changes the action owner or repository.'
          : 'The immutable workflow replaces a full commit SHA with a mutable reference.',
      remediation: ['Review the action identity and pin to a reviewed full commit SHA.'],
      validation: ['Compare both immutable workflow references.'],
    });
}
async function releaseTime(input: PolicySignalInput, change: PacketChange, reader: UpstreamReader) {
  const side = change.to ? 'head' : 'base',
    instance = change.to ?? change.from;
  requireUpstream(
    change.ecosystem === 'actions' && instance && 'action' in instance,
    'unsupported',
  );
  const target = resolveAdvisoryTarget(input, change, side);
  requireUpstream(target, 'unsupported');
  const repository = instance.action.split('/').slice(0, 2).join('/');
  requireUpstream(instance.action === repository, 'unsupported');
  await publicRepository(repository, reader);
  const observed = await observeRef(repository, instance, reader);
  const releases = await matchingReleases(repository, observed.sha, new Map(), reader);
  requireUpstream(releases.length > 0, 'missing');
  requireUpstream(
    releases.some((r) => r.version === target.version),
    'conflict',
  );
  const dated = releases.map((release) => {
    const publishedAt = publishTimestamp(release.data.published_at, input.evaluationTime);
    requireUpstream(publishedAt !== null, 'conflict');
    return { ...release, publishedAt };
  });
  dated.sort((a, b) => a.publishedAt - b.publishedAt || a.tag.localeCompare(b.tag));
  const selected = dated[0];
  const proof = await resolveUpstreamRef(repository, 'tags/' + selected.tag, reader);
  requireUpstream(proof.status === 'available' && proof.sha === observed.sha, 'conflict');
  await recheck(repository, observed, reader);
  const identity = releaseIdentity(selected.data, repository, selected.tag);
  return {
    url: identity.url,
    publishedAt: selected.publishedAt,
    selectedTag: selected.tag,
    commit: observed.sha,
  };
}
async function observeRelease(
  input: PolicySignalInput,
  change: PacketChange,
  reader?: UpstreamReader,
) {
  let known: Awaited<ReturnType<typeof releaseTime>> | null = null,
    reason: import('../schema.js').EvidenceReason = 'unsupported';
  if (reader)
    try {
      known = await releaseTime(input, change, reader);
    } catch (error) {
      reason = upstreamFailureReason(error);
    }
  return { known, reason };
}
function unsupportedSignals(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  side: 'base' | 'head',
) {
  for (const category of ['deprecation', 'trust', 'publisher'] as const) {
    const sources = [];
    for (const s of ['base', 'head'] as const)
      if ((s === 'base' ? change.from : change.to) && (category !== 'deprecation' || s === side))
        sources.push(recordSignal(input, output, change, s, category, null));
    attachSignalCoverage(change, category, sources);
  }
}
export async function collectActionsPolicySignals(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  reader?: UpstreamReader,
) {
  attachActionInventoryFindings(input, output, change);
  const side = change.to ? 'head' : 'base';
  const { known, reason } = await observeRelease(input, change, reader);
  const source = recordSignal(
    input,
    output,
    change,
    side,
    'publishTime',
    known ? { url: known.url, value: known } : null,
    reason,
  );
  attachSignalCoverage(change, 'publishTime', [source]);
  if (change.to && known && source.status === 'available')
    retainSignalFinding(output, {
      id: signalId(source.id, 'releaseMetadata'),
      memberId: change.id,
      kind: 'releaseMetadata',
      publishedAt: known.publishedAt,
      references: [source.id],
      rationale:
        'The earliest qualifying release at the proven Actions commit supplies its publication time.',
      remediation: ['Review the release and configured release-age window.'],
      validation: ['Recheck the original ref, selected tag and release time.'],
    });
  unsupportedSignals(input, output, change, side);
}
