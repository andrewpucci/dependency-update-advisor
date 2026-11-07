import { isDeepStrictEqual } from 'node:util';
import type { PacketChange, PacketSource, EvidenceReason } from '../schema.js';
import type { NpmMetadataResult } from './npm-registry.js';
import { metadataTarget } from './upstream.js';
import { resolveAdvisoryTarget } from './advisories.js';
import { advisoryCheck, advisoryText } from './advisory-read.js';
import { isPlainObject, byCodeUnit } from './common.js';
import {
  observe,
  recordSignal,
  attachSignalCoverage,
  retainSignalFinding,
  signalId,
  type Observation,
  type PolicySignalInput,
  type SignalEnrichment,
  type NpmTimeSides,
} from './policy-signals.js';

export type Publisher =
  | { kind: 'human'; name: string }
  | { kind: 'trusted'; provider: string; configuration: string };
export type NpmPublishingFacts = {
  deprecated: Observation<{ marker: 'deprecated'; reason: string } | null>;
  trustedPublishing: Observation<boolean>;
  provenance: Observation<boolean>;
  account: Observation<Publisher>;
  maintainers: Observation<string[]>;
  license: Observation<string | null>;
};
export type NpmPolicyReader = { read: (value: unknown) => Promise<NpmMetadataResult> };
function account(data: Record<string, unknown>): Publisher {
  advisoryCheck(isPlainObject(data._npmUser), 'missing');
  const user = data._npmUser;
  if (user.trustedPublisher !== undefined) {
    advisoryCheck(isPlainObject(user.trustedPublisher));
    const t = user.trustedPublisher;
    advisoryCheck(advisoryText(t.id) && advisoryText(t.oidcConfigId), 'unsupported');
    return { kind: 'trusted', provider: t.id, configuration: t.oidcConfigId };
  }
  advisoryCheck(advisoryText(user.name) && /^[a-z\d_.-]+$/iu.test(user.name), 'unsupported');
  return { kind: 'human', name: user.name };
}
export function npmPublishingFacts(value: unknown): NpmPublishingFacts {
  const data = isPlainObject(value) ? value : {};
  return {
    deprecated: observe(() => {
      advisoryCheck(data.deprecated === undefined || typeof data.deprecated === 'string');
      if (!data.deprecated) return null;
      const reason = data.deprecated.replace(/[\p{Cc}\p{Cs}]/gu, ' ').slice(0, 350);
      return {
        marker: 'deprecated' as const,
        reason: reason + (data.deprecated.length > 350 ? ' [reason truncated]' : ''),
      };
    }),
    trustedPublishing: observe(() => {
      if (data._npmUser === undefined) return false;
      advisoryCheck(isPlainObject(data._npmUser));
      if (data._npmUser.trustedPublisher === undefined) return false;
      return account(data).kind === 'trusted';
    }),
    provenance: observe(() => {
      advisoryCheck(isPlainObject(data.dist), 'missing');
      const a = data.dist.attestations;
      if (a === undefined) return false;
      advisoryCheck(
        isPlainObject(a) && advisoryText(a.url) && isPlainObject(a.provenance),
        'unsupported',
      );
      const url = new URL(a.url);
      advisoryCheck(
        url.origin === 'https://registry.npmjs.org' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname.startsWith('/-/npm/v1/attestations/'),
        'unsupported',
      );
      advisoryCheck(a.provenance.predicateType === 'https://slsa.dev/provenance/v1', 'unsupported');
      return true;
    }),
    account: observe(() => account(data)),
    maintainers: observe(() => {
      advisoryCheck(Array.isArray(data.maintainers), 'missing');
      advisoryCheck(data.maintainers.length <= 32, 'budget');
      return [
        ...new Set(
          data.maintainers.map((m) => {
            advisoryCheck(
              isPlainObject(m) && advisoryText(m.name) && /^[a-z\d_.-]+$/iu.test(m.name),
            );
            return m.name;
          }),
        ),
      ].sort(byCodeUnit);
    }),
    license: observe(() => {
      const v = data.license;
      if (v === undefined || v === null) return null;
      if (typeof v === 'string') return v;
      advisoryCheck(isPlainObject(v) && typeof v.type === 'string');
      return v.type;
    }),
  };
}
type Side = {
  facts: NpmPublishingFacts;
  url: string | null;
  trust: PacketSource;
  publisher: Record<'account' | 'maintainers', PacketSource>;
};
export type NpmMetadataSides = Partial<Record<'base' | 'head', Side>>;
function unknownFacts(reason: EvidenceReason): NpmPublishingFacts {
  const unknown = { kind: 'unchecked' as const, reason };
  return {
    deprecated: unknown,
    trustedPublishing: unknown,
    provenance: unknown,
    account: unknown,
    maintainers: unknown,
    license: unknown,
  };
}
function factSource(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  side: 'base' | 'head',
  category: 'trust' | 'publisher',
  facts: Record<string, Observation<unknown>>,
  url: string | null,
) {
  const reasons = [
    ...new Set(Object.values(facts).flatMap((f) => (f.kind === 'unchecked' ? [f.reason] : []))),
  ];
  const some = Object.values(facts).some((f) => f.kind === 'known');
  return recordSignal(
    input,
    output,
    change,
    side,
    category,
    url && some ? { url, value: { level: 'registry_reported', ...facts }, reasons } : null,
    reasons[0] ?? 'unsupported',
  );
}
export function supplyChainFinding(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  kind: 'publisher' | 'trust_downgrade',
  mechanism: string,
  sources: PacketSource[],
) {
  if (sources.some((s) => s.status === 'unavailable')) return;
  retainSignalFinding(output, {
    id: signalId(input.binding.identity, change.id, kind, mechanism),
    memberId: change.id,
    kind: 'supplyChainChange',
    change: kind,
    references: sources.map((s) => s.id),
    rationale:
      kind === 'publisher'
        ? `The exact-version ${mechanism} publishing identities differ.`
        : `The proposed version loses registry-reported ${mechanism} present on the earlier current version.`,
    remediation: ['Review the old and new publishing identities and provenance before merging.'],
    validation: ['Recheck both exact-version registry records and any publishing transition.'],
  });
}
export function comparePublishing(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  sides: NpmMetadataSides,
  times: NpmTimeSides,
) {
  const a = sides.base,
    b = sides.head;
  if (!a || !b) return;
  for (const mechanism of ['account', 'maintainers'] as const) {
    const old = a.facts[mechanism],
      next = b.facts[mechanism];
    if (old.kind === 'known' && next.kind === 'known' && !isDeepStrictEqual(old.value, next.value))
      supplyChainFinding(input, output, change, 'publisher', mechanism, [
        a.publisher[mechanism],
        b.publisher[mechanism],
      ]);
  }
  for (const mechanism of ['trustedPublishing', 'provenance'] as const) {
    const old = a.facts[mechanism],
      next = b.facts[mechanism];
    if (old.kind !== 'known' || next.kind !== 'known' || !old.value || next.value) continue;
    const from = times.base?.publishedAt,
      to = times.head?.publishedAt;
    if (from === undefined || to === undefined) {
      const missing = recordSignal(input, output, change, 'head', 'trust', null, 'missing');
      attachSignalCoverage(change, 'trust', [a.trust, b.trust, missing]);
      continue;
    }
    if (from >= to) continue;
    const p = times.head!.source.provenance;
    advisoryCheck(p.kind === 'upstream');
    const chronology = recordSignal(input, output, change, 'head', 'trust', {
      url: p.url,
      value: { mechanism: 'chronology', fromPublishedAt: from, toPublishedAt: to },
      bothSides: true,
    });
    supplyChainFinding(input, output, change, 'trust_downgrade', mechanism, [
      a.trust,
      b.trust,
      chronology,
    ]);
  }
}
export async function collectNpmPolicySignals(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  times: NpmTimeSides,
  reader?: NpmPolicyReader,
): Promise<NpmMetadataSides> {
  const sides: NpmMetadataSides = {};
  for (const side of ['base', 'head'] as const) {
    if (!(side === 'base' ? change.from : change.to)) continue;
    const eligible = resolveAdvisoryTarget(input, change, side),
      target = eligible ? metadataTarget(input, change, side) : null;
    const result =
      reader && target
        ? await reader.read(target)
        : { kind: 'unavailable' as const, reason: 'unsupported' as const };
    const url = result.kind === 'metadata' ? result.document.url : null;
    const facts =
      result.kind === 'metadata'
        ? npmPublishingFacts(result.document.data)
        : unknownFacts(result.reason);
    const trust = factSource(
      input,
      output,
      change,
      side,
      'trust',
      { trustedPublishing: facts.trustedPublishing, provenance: facts.provenance },
      url,
    );
    const publisher = {
      account: factSource(
        input,
        output,
        change,
        side,
        'publisher',
        { account: facts.account },
        url,
      ),
      maintainers: factSource(
        input,
        output,
        change,
        side,
        'publisher',
        { maintainers: facts.maintainers },
        url,
      ),
    };
    sides[side] = { facts, url, trust, publisher };
    if (side === 'head') {
      const d = facts.deprecated;
      const source = recordSignal(
        input,
        output,
        change,
        side,
        'deprecation',
        d.kind === 'known' && url ? { url, value: { deprecated: d.value } } : null,
        d.kind === 'unchecked' ? d.reason : 'unsupported',
      );
      attachSignalCoverage(change, 'deprecation', [source]);
      if (d.kind === 'known' && d.value && source.status === 'available')
        retainSignalFinding(output, {
          id: signalId(source.id, 'releaseMetadata'),
          memberId: change.id,
          kind: 'releaseMetadata',
          deprecated: d.value,
          references: [source.id],
          rationale: 'The exact proposed npm version is deprecated: ' + d.value.reason,
          remediation: ['Choose a maintained release or review the registry deprecation reason.'],
          validation: ['Check the exact version deprecation marker.'],
        });
    }
  }
  for (const category of ['trust', 'publisher'] as const)
    attachSignalCoverage(
      change,
      category,
      Object.values(sides).flatMap((s) =>
        category === 'publisher' ? Object.values(s.publisher) : [s.trust],
      ),
    );
  comparePublishing(input, output, change, sides, times);
  return sides;
}
