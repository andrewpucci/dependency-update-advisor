import { isDeepStrictEqual } from 'node:util';
import { parseReviewBinding, type ReviewBinding } from './event.js';
import { formDecisionUnits, type DecisionCoverage } from './units.js';
import type { UnitRecord } from './analysis/batches.js';
import type { SignalAttempt } from './evidence/policy-signals.js';

export type DecisionBriefInput = Readonly<{
  binding: ReviewBinding;
  generatedAt: string;
  reviewDigest?: string;
  coverage: DecisionCoverage;
  records: readonly UnitRecord[];
  analysisUnavailable: boolean;
  signalAttempts: readonly SignalAttempt[];
}>;
export type DecisionBriefResult =
  | Readonly<{ ok: true; body: string }>
  | Readonly<{ ok: false; category: 'input' | 'reference' | 'content' | 'size' }>;

/** Render an attributed review body; publication readiness is decided by the caller. */
export function renderDecisionBrief(input: DecisionBriefInput): DecisionBriefResult {
  try {
    const binding = parseReviewBinding(input.binding);
    if (
      !binding ||
      !/^[a-z0-9-]+$/u.test(binding.repository.owner) ||
      !/^[a-z0-9._-]+$/u.test(binding.repository.name) ||
      !isDeepStrictEqual(binding, input.coverage.inventory.packet.binding) ||
      !isDeepStrictEqual(
        formDecisionUnits(input.coverage.inventory.packet),
        input.coverage.inventory,
      ) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(input.generatedAt) ||
      new Date(input.generatedAt).toISOString() !== input.generatedAt ||
      (input.reviewDigest !== undefined && !/^[a-f\d]{64}$/u.test(input.reviewDigest))
    )
      return { ok: false, category: 'input' };
    const { counts, inventoryGaps, outcome } = input.coverage;
    if (
      outcome.kind !== 'empty_inventory' ||
      input.analysisUnavailable ||
      input.records.length !== 0 ||
      input.signalAttempts.length !== 0 ||
      input.coverage.inventory.units.length !== 0 ||
      input.coverage.inventory.packet.changes.length !== 0 ||
      counts.changedMembers !== 0 ||
      counts.units !== 0 ||
      counts.assessedUnits !== 0 ||
      counts.unresolvedUnits !== 0 ||
      counts.groupedUnits !== 0 ||
      counts.standaloneUnits !== 0 ||
      inventoryGaps.length !== 0 ||
      Object.values(input.coverage.inventory.packet.coverage).some(
        (entry) => entry.status === 'partial' || entry.status === 'unavailable',
      )
    )
      return { ok: false, category: 'content' };
    const { owner, name } = binding.repository;
    const body = [
      '<!-- dependabot-intelligent-review -->',
      `<!-- reviewed-head: ${binding.headSha} -->`,
      ...(input.reviewDigest ? [`<!-- review-digest: ${input.reviewDigest} -->`] : []),
      '',
      `# Dependabot review: ${owner}/${name} #${binding.pullNumber}`,
      '',
      'No dependency changes to review.',
      '',
      '**Next action:** No dependency action is needed.',
      '',
      'Evidence coverage: complete; 0 changed updates, 0 assessed decision units, 0 unresolved decision units.',
      '',
      `Reviewed head: [${binding.headSha}](https://github.com/${owner}/${name}/commit/${binding.headSha})`,
      `Generated: ${input.generatedAt}`,
    ].join('\n');
    return body.length <= 50_000 ? { ok: true, body } : { ok: false, category: 'size' };
  } catch {
    return { ok: false, category: 'input' };
  }
}
