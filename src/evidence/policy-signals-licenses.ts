import parse from 'spdx-expression-parse';
import { PACKET_LIMITS, type PacketChange, type PacketSource } from '../schema.js';
import { advisoryCheck } from './advisory-read.js';
import {
  observe,
  recordSignal,
  retainSignalFinding,
  signalId,
  type Observation,
  type PolicySignalInput,
  type SignalEnrichment,
} from './policy-signals.js';

type LicenseLimits = { maxBytes: number; maxTokens: number; maxDepth: number };
function terms(node: parse.Info, operator: 'and' | 'or'): parse.Info[] {
  return 'conjunction' in node && node.conjunction === operator
    ? [...terms(node.left, operator), ...terms(node.right, operator)]
    : [node];
}
function serialize(node: parse.Info): string {
  if ('license' in node)
    return (
      node.license + (node.plus ? '+' : '') + (node.exception ? ' WITH ' + node.exception : '')
    );
  return (
    '(' +
    terms(node, node.conjunction)
      .map(serialize)
      .join(' ' + node.conjunction.toUpperCase() + ' ') +
    ')'
  );
}
export function canonicalLicense(
  value: unknown,
  limits: LicenseLimits,
): Observation<string | null> {
  return observe(() => {
    if (value === null) return null;
    advisoryCheck(typeof value === 'string');
    advisoryCheck(Buffer.byteLength(value) <= limits.maxBytes, 'budget');
    const tokens = value.match(/[()]|[^()\s]+/gu) ?? [];
    advisoryCheck(tokens.length <= limits.maxTokens, 'budget');
    let depth = 0;
    for (const t of tokens) {
      if (t === '(') advisoryCheck(++depth <= limits.maxDepth, 'budget');
      else if (t === ')') advisoryCheck(--depth >= 0);
    }
    advisoryCheck(depth === 0);
    return serialize(parse(value.trim()));
  });
}
type LicenseSide = { license: Observation<string | null>; url: string | null };
function licenseSide(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  side: 'base' | 'head',
  raw?: LicenseSide,
): { value: string | null; source: PacketSource } | undefined {
  const fact =
    raw?.license.kind === 'known'
      ? canonicalLicense(raw.license.value, {
          maxBytes: PACKET_LIMITS.textBytes,
          maxTokens: input.limits.maxJsonEntries,
          maxDepth: input.limits.maxJsonDepth,
        })
      : (raw?.license ?? {
          kind: 'unchecked' as const,
          reason: 'unsupported' as const,
        });
  const source = recordSignal(
    input,
    output,
    change,
    side,
    'license',
    fact.kind === 'known' && raw?.url ? { url: raw.url, value: { license: fact.value } } : null,
    fact.kind === 'unchecked' ? fact.reason : 'missing',
  );
  if (fact.kind === 'known' && source.status === 'available') return { value: fact.value, source };
  return undefined;
}
export function collectLicenseSignals(
  input: PolicySignalInput,
  output: SignalEnrichment,
  change: PacketChange,
  sides: Partial<Record<'base' | 'head', LicenseSide>>,
) {
  const normalized: Partial<
    Record<'base' | 'head', { value: string | null; source: PacketSource }>
  > = {};
  for (const side of ['base', 'head'] as const) {
    if (!(side === 'base' ? change.from : change.to)) continue;
    normalized[side] = licenseSide(input, output, change, side, sides[side]);
  }
  const a = normalized.base,
    b = normalized.head;
  if (a?.value && b?.value && a.value !== b.value)
    retainSignalFinding(output, {
      id: signalId(input.binding.identity, change.id, 'licenseChange'),
      memberId: change.id,
      kind: 'licenseChange',
      currentLicense: a.value,
      proposedLicense: b.value,
      references: [a.source.id, b.source.id],
      rationale: 'The verified declared license changes from ' + a.value + ' to ' + b.value + '.',
      remediation: ['Confirm the proposed license terms are acceptable before merging.'],
      validation: ['Review both exact-version declared license expressions.'],
    });
}
