# Spec: C3 Advisory Policy Rules and Local Overrides

Status: approved for C3 execution, 2026-10-12. Supporting contract for
`review-config` in
[the capability map](README.md), scoped to
[issue #7: C3](https://github.com/andrewpucci/dependency-update-advisor/issues/7).

Approval: the user approved this contract and the C3 implementation plan for
execution on 2026-10-12. The approved
[configuration module](SPEC-review-config.md) remains authoritative.

## Objective

Let repository maintainers change the ten named advisory rules in either
direction while preserving the facts behind every recommendation. A known
malicious package always holds the update. Contributors need a deterministic
policy evaluator whose outputs retain findings, evidence gaps, unchecked
signals, unresolved decision units, and the source of each override.

C3 consumes C1's validated trusted configuration. It owns rule evaluation,
verdict precedence, the decision guard, and the policy handoff for later
analysis and rendering. It does not collect evidence, call a model, render or
publish comments, or publish GitHub execution status. Its local tests must
prove the policy invariants without claiming those integrations are complete.

## Inputs and Assumptions

- C1 is implemented and its [issue #5](https://github.com/andrewpucci/dependency-update-advisor/issues/5)
  is closed. `src/config.ts` already returns effective verdicts, explicit
  overrides, and `origin: 'file' | 'missing'` on success. A failed config
  result contains no usable policy and must stop the caller.
- C1 currently accepts five rules. C3 implements the amendment recorded in the
  configuration module and the [C1 parser contract](SPEC-config-parser.md):
  `src/config.ts`, its tests, and the JSON Schema accept the five new rule
  names, each defaulting to `merge_with_followups`, and
  `policy.minimumReleaseAgeDays`, an integer from 1 through 30 that defaults
  to 1. `maliciousPackage` is not a configuration key; a present
  `policy.verdicts.maliciousPackage` is an unknown field and fails
  validation. No other configuration field changes.
- The caller supplies the review evaluation time with the normalized input.
  C3 never reads the clock, so release-age matching stays deterministic.
- The [B1 baseline](../../tests/parity/README.md) identifies the immutable
  source reviewer. Its [policy contract](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/SPEC-review-policy.md)
  and [policy evaluator](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/policy.mjs)
  supply the defaults below. Explicit overrides supersede default advice only
  as authorized by the configuration module.
- Callers establish checkout trust, evidence validation, and decision-unit
  identity. C3 accepts normalized, validated data rather than raw API or model
  payloads. Missing analysis is not a validated assessment.
- Decision-unit coverage and evidence availability are separate. An assessed
  unit may have an evidence gap; an unavailable or unattempted unit has no
  validated decision. Neither local policy nor a model may change those facts.
- The existing [analysis-provider](SPEC-analysis-providers.md),
  [shared-review](SPEC-shared-review.md), and
  [comment-experience](SPEC-comment-experience.md) contracts own downstream
  validation, execution status, and presentation.

## Tech Stack

Use the existing Node.js range `>=24.11.0 <25`, ESM, strict TypeScript,
and source-adjacent tests importing from `vite-plus/test`. Keep the pinned
toolchain and lockfile. This capability requires no runtime dependency,
provider credential, or network access. The only configuration changes are
the five rule names and the release-age field above.

## Commands

For documentation changes:

```sh
npm run lint:md
npm run format:check
git diff --check
```

For implementation, use the existing repository checks on the same revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Record installation separately. Record the exact tested SHA, environment,
commands, outcomes, and checks not run in the issue or PR; distinguish a CI
merge SHA from the PR head. There is no build command yet; packaging remains A1.

## Project Structure

```text
src/policy.ts                     → proposed rule evaluation, precedence, and decision guard
src/policy.test.ts                → proposed findings, overrides, and coverage tests
src/config.ts                     → validated policy and provenance boundary; add rules and window
src/config.test.ts                → parser tests; add new rules, policy handoff, and default agreement
schemas/review-config-v1.json     → editor contract; add the new rules and release-age field
docs/specs/SPEC-advisory-policy.md → this C3 supporting contract
```

Use synthetic fixtures in tests. Do not copy consumer configurations or
extract the whole source reviewer to implement this capability.

## Policy Contract

Sections 1 and 2 decide which findings exist. Sections 3 to 5 decide how
those findings become ceilings and a recommendation. Section 6 records
intended differences from the source reviewer.

### 1. Classify evidence before matching rules

1. **Required evidence.** Only `available` and `group_backed` evidence
   satisfy required evidence. Every other status, including `partial`,
   `unavailable`, and any unrecognized status, triggers `incompleteEvidence`.
   Group-backed evidence does not prove that every group member was assessed
   independently. Vulnerability and malware coverage are required: an
   unavailable, failed, truncated, or unsupported advisory or malware lookup
   triggers `incompleteEvidence` and never means zero vulnerabilities or no
   malware. Install-script metadata stays required as the
   [npm evidence contract](SPEC-npm-evidence.md) already specifies.
2. **Unchecked signals.** Publish time, deprecation or yank status, trusted
   publishing or provenance, and publisher identity are optional signals. A
   failed lookup for one of them is an unchecked signal: retain its unit,
   signal, and reason for an explained note. An unchecked signal is not an
   evidence gap, does not trigger `incompleteEvidence`, does not make
   required evidence incomplete, and cannot by itself fail execution status.
   It never creates or removes a finding.
3. **Informational evidence.** A license identifier by itself, and other
   retained evidence that matches no rule, stays informational. Preserve it
   even when it contributes no policy verdict. Do not invent a license
   allowlist, denylist, or configuration field.
4. **Severity.** Callers supply advisory severity as exactly `critical`,
   `high`, `moderate`, or `low`, or omit it for an unscored advisory. Reject
   any other value, including a differently cased one, as invalid input;
   never map it to a relaxable rule. Severity normalization belongs to the
   evidence collectors: they map GitHub's `medium` to `moderate` and
   `unknown` to an unscored advisory.
5. **Verification.** Unverified model prose cannot create any finding that
   matches a rule or the malware hold. Applicability and source validation
   belong to evidence and analysis boundaries, not configurable rule
   predicates.

### 2. Match rules from verified evidence

Five rule names and defaults already exist in C1; C3 adds the last five and
the fixed malware hold. Match every applicable rule; do not select only the
first finding for a package or decision unit.

| Rule                          | Applies when                                                                                                                                                                             | Shared default                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `incompleteEvidence`          | Required evidence for a unit has any status other than `available` or `group_backed`; an assessed unit may still receive bounded advice.                                                 | `merge_with_followups`           |
| `highOrCriticalVulnerability` | A verified unresolved `critical` or `high` advisory affects the proposed version.                                                                                                        | `do_not_merge`                   |
| `moderateOrLowVulnerability`  | A verified unresolved `moderate`, `low`, or unscored advisory affects the proposed version.                                                                                              | `merge_with_followups`           |
| `incompatibleMigration`       | Verified upgrade evidence and trusted repository context prove an incompatible migration.                                                                                                | `do_not_merge`                   |
| `applicableCodemod`           | Verified upgrade-range evidence establishes an applicable codemod.                                                                                                                       | `merge_with_followups`           |
| `compatibilityUncertainty`    | Verified evidence shows a change that may break supported runtimes or downstream consumers without proving incompatibility with trusted repository context.                              | `merge_with_followups`           |
| `supplyChainChange`           | Verified evidence shows a changed install script, package source, publisher, trust level, or GitHub Action identity or pinning.                                                          | `merge_with_followups`           |
| `licenseChange`               | Verified license identifiers differ between the current and proposed versions.                                                                                                           | `merge_with_followups`           |
| `recentRelease`               | A proposed version was published fewer than `policy.minimumReleaseAgeDays` days before the review evaluation time, unless it resolves a verified advisory affecting the current version. | `merge_with_followups`           |
| `deprecatedRelease`           | Verified registry metadata marks a proposed version as deprecated or yanked.                                                                                                             | `merge_with_followups`           |
| `maliciousPackage` (fixed)    | A verified malware advisory affects a proposed version.                                                                                                                                  | `do_not_merge`, not configurable |

1. An unscored verified advisory uses `moderateOrLowVulnerability`; lack of a
   score does not discard the finding. A resolved advisory or one proven not
   to affect the proposed version does not trigger a vulnerability rule.
2. `compatibilityUncertainty` covers a verified raised runtime or engine
   floor, a tightened peer range, or a deprecated workflow input, including
   one introduced by a transitive dependency. It concerns runtimes or
   downstream consumers that the repository's own CI may not exercise.
   `incompatibleMigration` remains the rule for proven incompatibility with
   trusted repository context; when both apply, precedence picks the stricter
   effective verdict and both findings remain. A repository without
   downstream consumers may set this rule to `merge`.
3. `supplyChainChange` covers each of these verified signals:
   - a new or changed install lifecycle script;
   - a package source changed from its registry to a git URL, tarball, or
     other source;
   - a trust downgrade, where an earlier-published version had trusted
     publishing or a provenance attestation and the proposed version has
     weaker or no such evidence;
   - a changed publishing account or maintainer for the proposed version,
     where registry metadata exposes it;
   - a GitHub Action whose owner or repository changed rather than only its
     ref, or whose reference moved from a full commit SHA to a tag, branch,
     or other mutable ref.

   Missing or conflicting install-script metadata is an evidence gap. A
   failed trust or publisher lookup is an unchecked signal. Package source
   and Action identity or pinning come from the immutable lockfile and
   workflow inventory, whose failures are coverage gaps under their evidence
   contracts. None of these failures is a supply-chain finding. A version and
   its predecessors that all lack trusted publishing or attestations involve
   no downgrade, so that is neither a finding nor a gap. Valid provenance is
   not proof of safety, so its presence never removes another finding.

4. `licenseChange` covers a verified difference between the declared license
   identifiers of the current and proposed versions, including a change
   introduced by a transitive dependency. A missing, unknown, or unparseable
   license stays informational; it is neither a license finding nor an
   evidence gap. Formatting-only differences that name the same license
   expression do not trigger the rule.
5. `recentRelease` compares each proposed version's verified publish time,
   including transitive versions, with the caller-supplied evaluation time.
   It applies when the difference is less than the configured number of days.
   It skips a version that verified advisory evidence shows resolves an
   advisory affecting the current version, and records that exemption; other
   rules still apply to that version. A publish time that cannot be retrieved
   is an unchecked signal. The follow-up names the earliest time the window
   ends and asks for a re-run then. This complements, and does not read,
   Dependabot `cooldown`, which uses the same day unit.
6. `deprecatedRelease` covers an npm version with a `deprecated` message, a
   PyPI release marked yanked, and an equivalent verified registry marker in
   other supported ecosystems. Unavailable registry metadata is an unchecked
   signal. The finding retains the registry's reason when supplied.
7. `maliciousPackage` applies when a verified malware advisory, such as a
   GitHub `malware` advisory or an OpenSSF `MAL-` record, affects a proposed
   version, including a transitive one. It is a fixed hold: no configuration
   value can change it, and it always yields `do_not_merge`. Collectors must
   request malware advisories explicitly because GitHub's global advisory
   endpoint excludes them by default. A withdrawn advisory no longer applies.
8. Findings for the rules added by C3 carry what changed, who or what is
   affected, and a concrete follow-up:
   - a consumer migration note or codemod for a compatibility change;
   - a script and source review for a supply-chain change;
   - the old and new license, with a request to confirm the new terms;
   - the registry's deprecation or yank reason.

### 3. Replace each default before combining findings

A ceiling is the most permissive verdict that policy allows for one decision
unit or for the whole update. A validated assessment or final recommendation
may be stricter than its ceiling, never more permissive.

1. Consume only successful C1 results. Missing-file defaults, a minimal
   present file, and an empty `policy.verdicts` object all use shared defaults.
   Invalid present configuration must never become permissive defaults.
2. A configured value replaces that rule's default, including a less
   restrictive value. Every named rule accepts `merge`,
   `merge_with_followups`, and `do_not_merge`; rules absent from the explicit
   override map retain defaults. The fixed `maliciousPackage` hold is not a
   named rule and has no override.
3. Evaluate applicability independently of configured verdicts. Setting a
   vulnerability rule to `merge` changes advice, not whether the vulnerability
   exists or whether its remediation must be retained.
4. Combine effective verdicts with `do_not_merge` > `merge_with_followups` >
   `merge`. Compute a ceiling for each decision unit from that unit's
   applicable findings, and an aggregate ceiling across all findings,
   packages, decision units, and ecosystems. Results must not depend on input
   order or on which overridden rule is encountered first.
5. A unit with no applicable advisory rule has a `merge` ceiling, as does an
   aggregate with none. This does not prove complete evidence, validated
   analysis, or successful review execution.
6. A validated model assessment for a unit may be stricter than that unit's
   effective ceiling, but never more permissive. One unit's findings do not
   constrain an unrelated unit's assessment. A configured relaxation changes
   a ceiling only for the corresponding named rule.

### 4. Preserve findings and expose policy provenance

1. Do not mutate input configuration, evidence, findings, or assessment
   states. Preserve stable finding and unit identities, package/version
   identity, source references, severity, affected status/range when supplied,
   rationale, remediation, and validation steps. Keep evidence gaps, unchecked
   signals, and coverage limits attributable to their original units.
2. Return the effective ten-rule policy, release-age window, unchecked
   signals, and C1 configuration origin with the policy result. For every
   applied rule retain its rule name, default verdict, effective verdict,
   whether it was explicitly configured, and the affected finding or unit
   identity. Record the malware hold as fixed rather than configurable.
   Override source is the trusted `.github/dependabot-review.json` field;
   never include an absolute path or the raw configuration document.
3. Distinguish an explicit override equal to its default from an absent
   override, for both rule verdicts and the release-age window. Record
   configured but non-applicable rules in effective policy metadata without
   inventing findings for them.
4. Retain default and effective ceilings for each unit and in aggregate.
   Distinguish a changed individual rule from a changed ceiling: relaxing one
   rule may leave a unit or aggregate ceiling unchanged because another
   finding is stricter. The final recommendation also depends on assessment
   states under section 5. Give downstream consumers enough structured data
   to explain either case without recomputing policy from comment text.
5. Findings remain visible even if every model batch is unavailable. The
   [B1 scenario handoff](../../tests/parity/scenarios.md#synthetic-introduced-vulnerability)
   records a source fallback that lost deterministic blockers; reproducing
   that loss is not acceptable parity.

### 5. Keep unresolved decisions and execution separate

1. `incompleteEvidence` may change the ceiling for an assessed unit with an
   evidence gap. It cannot create an assessment for an unavailable,
   unattempted, omitted, or rejected unit. Keep those units unresolved and
   retain their coverage limits and specific next actions.
2. C3 exports one pure decision guard. The analysis-provider aggregation calls
   it rather than reimplementing precedence. The guard receives the policy
   result and validated assessment states for the complete unit inventory; a
   unit without a supplied state is unresolved. It applies, in order:
   1. An effective verified `do_not_merge` finding remains a visible hold,
      with every unresolved unit retained.
   2. Otherwise, any unresolved unit yields `decision_incomplete`, with no
      merge recommendation.
   3. Otherwise, it combines the complete validated assessments, each within
      its unit's effective ceiling, using the same precedence. Only this case
      can yield `merge` or `merge_with_followups`.
3. If an override relaxes the only blocking finding, that finding remains in
   the evidence. If another unit is unresolved, the result becomes
   `decision_incomplete`, not a merge recommendation.
4. `analysis_unavailable` is the analysis-provider classification for a run
   with no validated assessment. C3 does not compute it. It is never a merge
   recommendation and cannot replace the guard's hold or remove known
   findings or unresolved units.
5. Execution completion is independent of the advisory verdict. C3 cannot
   turn failure, unavailable analysis, incomplete required evidence, or
   publication failure into success. An assessed evidence gap may have
   locally relaxed advice while still requiring failed execution status
   under the shared-review contract. An unchecked signal alone does not
   require failed execution status.
6. Expose policy ceilings, findings, unchecked signals, and unresolved-unit
   information for downstream consumers; do not infer GitHub execution
   success from them. Local contract tests cover this handoff. Provider
   aggregation, comment visibility, and current-head status tests remain
   integration gates in their owning modules.

### 6. Record differences from the source reviewer

Default parity records each difference below with its reason under the
[parity contract](SPEC-parity-cutover.md); none is a regression.

1. The B1 evaluator returns one PR-wide ceiling. Parity compares that value
   with the aggregate ceiling; per-unit ceilings are an intended extension for
   decision units.
2. The source policy contract required a follow-up for compatibility
   uncertainty, but the pinned source evaluator had no finding kind for it or
   for supply-chain changes, release age, deprecation, or malware. Findings
   from every rule added by C3, and from the malware hold, are intended
   policy differences.
3. The source policy kept licenses informational until a repository license
   policy was approved; `licenseChange` is that approved policy.
4. Detecting the new findings belongs to the npm, Actions, and uv evidence
   modules, tracked in
   [S3 #53](https://github.com/andrewpucci/dependency-update-advisor/issues/53).
   Until those modules emit the findings, C3 tests use synthetic findings
   only.

## Code Style

Use camelCase, explicit unions, readonly inputs, stable identities, and small
pure functions. Reuse C1's `Verdict`, `PolicyRule`, and `PolicyOverrides` types;
`maliciousPackage` stays outside `PolicyRule` so the type system cannot accept
an override for it. Export C1's default map from `src/config.ts` as a frozen
readonly constant rather than adding a second drifting map; existing fields
parse unchanged. Avoid dynamic rule plugins and precedence hidden in prompt
wording.

This existing parser API illustrates test style and explicit provenance:

```ts
import { expect, test } from 'vite-plus/test';
import { parseReviewConfig } from './config.js';

test('preserves an explicit advisory relaxation', () => {
  const result = parseReviewConfig(
    '{"version":1,"policy":{"verdicts":{"highOrCriticalVulnerability":"merge"}}}',
  );
  if (!result.ok) throw new Error('expected valid configuration');
  expect(result.config.policy.verdicts.highOrCriticalVulnerability).toBe('merge');
  expect(result.overrides.highOrCriticalVulnerability).toBe('merge');
  expect(result.origin).toBe('file');
});
```

The example is illustrative; exact evaluator signatures and normalized types
are selected during planning within the observable contract above.

## Testing Strategy

Use table-driven Vitest tests, focused assertions, and synthetic findings.
No live GitHub or model calls are needed. Do not invent a numeric coverage bar.
Rows follow the policy contract sections in order.

| Required case                                                                        | Expected behavior                                                                                                            |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `partial`, `unavailable`, and unrecognized evidence statuses                         | Each triggers `incompleteEvidence`; `available` and `group_backed` do not.                                                   |
| Failed advisory lookup for a proposed version                                        | Triggers `incompleteEvidence`; never reported as zero vulnerabilities.                                                       |
| Failed malware lookup                                                                | Triggers `incompleteEvidence`; never reported as no malware.                                                                 |
| Only unchecked signals and otherwise complete evidence                               | Explained notes retained; no evidence gap, `incompleteEvidence` match, or required execution failure.                        |
| Failed source with an unrecognized signal name                                       | Treated as a required source: triggers `incompleteEvidence`, never an unchecked signal.                                      |
| Unrecognized or differently cased severity, with `moderateOrLowVulnerability: merge` | Input rejected; the advisory never matches a relaxable rule.                                                                 |
| Unrecognized advisory applicability or finding kind                                  | Input rejected; the finding never silently matches no rule.                                                                  |
| GitHub `medium` and `unknown` severities after collector normalization               | Match `moderateOrLowVulnerability` as `moderate` and unscored.                                                               |
| Several severities, unscored, resolved, and unaffected advisories                    | Correct rule matching and preserved attributable evidence.                                                                   |
| Compatibility uncertainty with and without proven incompatible migration             | `merge_with_followups` alone; `do_not_merge` with both; both findings retained.                                              |
| Install script, source, publisher, trust downgrade, Action identity, SHA-to-tag      | Each matches `supplyChainChange`; missing script metadata is a gap; failed trust or publisher lookups are unchecked signals. |
| No trusted publishing or attestation on either version                               | No `supplyChainChange` finding and no evidence gap.                                                                          |
| Verified license change, including a transitive one                                  | Matches `licenseChange` with old and new identifiers; formatting-only differences do not.                                    |
| Unchanged, missing, or unknown license and complete evidence with no policy finding  | No license finding or gap; `merge` ceiling is not a completed review.                                                        |
| Version published just inside, at, and after the window; configured window           | Matches `recentRelease` only inside the window; a failed publish-time lookup is an unchecked signal, not a gap.              |
| Fresh version resolving a verified advisory affecting the current version            | Exempt from `recentRelease` with the exemption recorded; other rules still apply.                                            |
| Deprecated npm version and yanked PyPI release                                       | Each matches `deprecatedRelease` with its reason; failed metadata lookup is an unchecked signal.                             |
| Malware advisory with every named rule relaxed to `merge`                            | `do_not_merge` hold remains; config naming `maliciousPackage` fails validation.                                              |
| Missing config, minimal file, empty verdict map                                      | Identical default ceilings; configuration origin remains distinguishable.                                                    |
| Each of ten named rules with each of three verdicts                                  | Correct effective verdict, retained evidence, and explicit override provenance.                                              |
| Window of 0, 31, 1.5, `"1"`, or `null`; explicit 1 and an absent window              | Invalid values fail validation; explicit and default windows stay distinguishable.                                           |
| High advisory relaxed to `merge` plus proven incompatible migration                  | Independent default incompatibility keeps `do_not_merge`.                                                                    |
| Evidence gap tightened to `do_not_merge` plus a relaxed vulnerability                | Stricter evidence rule wins; both findings remain.                                                                           |
| Blocker in one unit and no finding in another                                        | Per-unit ceilings differ; aggregate is `do_not_merge`; unrelated unit keeps `merge`.                                         |
| Permuted findings, units, and mixed ecosystems                                       | Same per-unit and aggregate ceilings; no coverage concealed by another unit.                                                 |
| Explicit equal-to-default and non-applicable overrides                               | Accurate metadata; no false recommendation change or invented finding.                                                       |
| Repeated calls and frozen inputs                                                     | No mutation or cross-call leakage; parser/schema defaults still agree.                                                       |
| Assessed unit with a gap and `incompleteEvidence: merge`                             | Relaxed ceiling with unchanged evidence and execution-completion facts.                                                      |
| Unavailable or unattempted unit with all applicable rules relaxed                    | Unresolved unit remains; no merge recommendation or success inference.                                                       |
| Effective blocker plus unresolved unit, including all analysis unavailable           | Guard returns the `do_not_merge` hold with the blocker and complete unresolved queue.                                        |
| Only blocker relaxed while a different unit is unresolved                            | Finding retained; guard returns `decision_incomplete`.                                                                       |
| Unit without a supplied assessment state                                             | Treated as unresolved; never merge-ready.                                                                                    |
| Failed C1 result                                                                     | No evaluable policy or permissive fallback.                                                                                  |

Later integration must reject model advice exceeding a unit's effective
ceiling, call the C3 guard for aggregation, explain changed defaults in the
comment, display findings and unresolved units, and retain failed execution
status. Passing C3 unit tests alone does not certify those integrations or
end-to-end reviewer parity.

## Boundaries

- **Always:** Use validated trusted configuration and source-backed findings;
  apply overrides before independent-finding precedence; preserve evidence,
  coverage, unresolved states, and explicit override provenance; run the
  documented checks before committing implementation.
- **Ask first:** Add or rename a rule, change defaults or rule applicability,
  expand config/schema fields, introduce a dependency, or change the approved
  analysis, comment, execution-status, or trust contracts.
- **Never:** Let configuration relax or remove the malware hold, execute
  repository policy, accept PR-head config in the privileged reviewer, let
  model prose invent findings, hide a finding or unassessed unit, map an
  unrecognized severity or evidence status to permissive advice, equate
  relaxed advice with successful execution, or commit private consumer
  details, credentials, or raw payloads.

## Success Criteria

1. All ten named rules support both stricter and less restrictive advice
   where their defaults permit it; omitted rules retain C1 defaults. A
   verified malware advisory always holds the update.
2. Independent findings combine using the most restrictive effective verdict
   per unit and in aggregate, with order-independent outcomes and no loss of
   findings across units.
3. Default/effective ceilings and explicit provenance explain when a rule
   changed advice and when another finding kept a ceiling unchanged.
4. Evidence gaps and unresolved units survive every override. No unresolved
   unit becomes merge-ready; a known effective blocker survives unavailable
   analysis; a failed execution cannot become success through local policy.
5. An unrecognized severity or evidence status never reaches a relaxable
   rule or a less restrictive result. Each unchecked signal is explained, is
   never silently omitted, and does not fail execution status by itself.
6. The C1 parser, schema, and their tests accept the five new rules and the
   release-age window with their defaults, reject a `maliciousPackage`
   override, and parse existing five-rule configurations unchanged.
7. Parser-to-policy and pure policy tests cover the matrix above. All four
   implementation quality commands pass on the same recorded revision.
8. Downstream integration obligations are explicit and remain open until
   their owning modules prove provider, renderer, and status behavior.

## Open Questions

None for the advisory behavior. Evaluator signatures and the smallest
normalized input/result types are planning choices, not approval to implement
downstream modules.
