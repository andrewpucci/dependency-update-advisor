# Spec: O1 Decision Brief Rendering

Status: approved for execution, 2026-11-08. The user's `as-plan` invocation
approved the reviewed draft for planning; the user then approved the plan and
invoked `as-build auto`. Live publication remains outside this approval.
The renderer and focused integration tests are implemented, pending overall
review and merge. A fresh-context reviewer checked the new behavior tests.
The user-provided desktop preview preceded the approved label and link changes;
the refreshed narrow preview included them. The user approved linking each
assessment's `Policy` label to the shared policy guide on 2026-11-08; no
desktop or narrow preview yet includes that link.
Module: `shared-review` in the [capability map](README.md). Scope:
[O1 #23](https://github.com/andrewpucci/dependency-update-advisor/issues/23).
The approved [comment experience](SPEC-comment-experience.md) remains the
reader-facing contract. This draft does not amend it.

## Objective and scope

Render a deterministic, actionable Markdown brief for a maintainer reviewing
one Dependabot PR, including grouped and incomplete reviews. The maintainer
can see the recommendation, next action, coverage, and reviewed head near the
opening, and can identify every blocker, unresolved decision unit, and
required evidence gap even at the body-size boundary.

O1 renders validated review data and does not collect or research evidence,
call a model, calculate policy, publish comments or
statuses, or authorize live writes. The approved T3, T5, M2, S1, S2 and S3
contracts remain authoritative; their separate integration and cutover gates
are not satisfied by renderer tests.

## Inputs and output

- Accept the bound repository, PR and full reviewed head, a supplied UTC
  generation time, and an optional validated digest. Do not derive identity
  from external prose or read the clock inside rendering.
- Consume the validated T4/T5 inventory and coverage, C3 policy findings,
  M2 per-unit records and assessments, and validated S1 advisory, S2 upstream
  and S3 policy-signal evidence, including the S3 attempt outcomes and
  failed-license reasons that workflow integration carries to rendering.
  Preserve their provenance and attribution. Each is approved, but its
  implementation and integration must be verified at the revision used.
- Do not recalculate policy or treat the M2 `analysis_unavailable` label as a
  replacement for T5's outcome. A verified hold stays visible alongside
  unavailable analysis; incomplete and empty inventories must not acquire a
  fabricated merge recommendation.
- Produce either a fully rendered body ready for T3's validation or a bounded
  rendering failure. Inconsistent identity, missing required decision content,
  invalid references or inability to fit required content must fail rather
  than produce a misleading partial body. W2 owns the failure handoff and
  preserves the previous comment under the approved workflow contract.
- A fully rendered body is not a complete review. W2 assigns T3's
  `result.kind` under the [shared workflow](SPEC-shared-review.md) contract;
  T5 keeps evidence completeness separate from decision coverage. O1 neither
  assigns `kind` nor implies a complete review while unresolved units,
  packet-wide gaps, or required evidence gaps remain.
- Exact input types, binding checks, and the interfaces to the real S1, S2,
  S3, M2 and T3 implementations are planning choices; synthetic seams do not
  prove those integrations work.

## Opening by outcome

The opening reads T5's authoritative outcome and M2's separate label. M2
assigns `analysis_unavailable` only when no unit is assessed, so it never
accompanies merge advice or an empty inventory.

| T5 outcome                    | `analysis_unavailable` | Recommendation and next action                                                                       |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| advice `merge`                | never                  | Advisory merge recommendation; next action follows any remaining evidence gap.                       |
| advice `merge_with_followups` | never                  | Merge with follow-ups; next action names the follow-ups.                                             |
| advice `do_not_merge`         | absent                 | Hold with its concrete blocker; next action addresses the blocker.                                   |
| advice `do_not_merge`         | present                | Hold with its concrete blocker and unavailable analysis; also give the analysis recovery action.     |
| `decision_incomplete`         | absent                 | **No merge recommendation**; next action comes from the decision queue or inventory-gap recovery.    |
| `decision_incomplete`         | present                | **No merge recommendation**; keep inventory-gap recovery and also give the analysis recovery action. |
| `empty_inventory`             | never                  | "No dependency changes to review", without a verdict or claim of successful analysis.                |

The analysis recovery action follows the M2 failure categories O1 receives.
For a failure a rerun can clear, such as transport, deadline or `call_budget`,
tell the maintainer to rerun CI, preserving the
[excluded B1 baseline fix](../../tests/parity/README.md). For `configuration`,
direct the maintainer to correct the provider configuration or credential
before rerunning CI; a rerun alone cannot fix it. Planning maps every M2
category to its action. Exact wording beyond the quoted empty-inventory text
is a planning choice.

## Rendering contract

1. Use the exact T3 metadata prefix: the managed marker, the full lowercase
   reviewed-head line, and the optional matching review-digest line, in that
   order. Title the document as a Dependabot review that includes the
   repository and PR. Show a visible head link near the opening and the
   supplied UTC date. The body ceiling is 50,000 JavaScript string units
   including metadata, as specified by T3.
2. Lead with recommendation, concrete next action, and evidence completeness,
   in that order, following [Opening by outcome](#opening-by-outcome). Show
   effective blockers before unresolved work. Do not imply approval for
   incomplete analysis or confuse review execution status with an advisory
   verdict.
3. Show applicable sections in the approved order: Reasons not to merge,
   Decision queue, Decision coverage, Package assessments, Non-blocking
   follow-ups, New capabilities to adopt now, and lower-priority detail.
   Use one heading level for peer sections. Include changed-update,
   assessed-unit, and unresolved-unit counts with their meanings; explain
   grouped assessment without implying separate research for each member.
   Preserve packet-wide and ecosystem coverage gaps.
4. Each unresolved unit names its package or direct-update group, changed
   update count, evidence gap, and concrete next action. Never replace units
   with an aggregate or hide a blocker. Each blocker retains its impact,
   evidence, remediation, and validation step. Each assessed unit with a
   required evidence gap appears in Non-blocking follow-ups with its package
   and exact next action. Assessments distinguish local context from upstream
   evidence, and identify role, policy, and evidence status without
   presenting unknowns as facts. The `Policy` label links to the shared
   [policy guide](../policy-guide.md) through a renderer-owned constant URL;
   the guide describes defaults, and the displayed result stays specific to
   the review and its overrides.
5. Only show actionable, supported Use now items; place Consider later after
   decision-relevant material and Not relevant rationale in controlled
   `<details>`. Keep long remediation prompts and research handoffs below the
   decision brief, collapsed when appropriate. Render only vetted links.
6. Treat package names, evidence, and model-produced text as untrusted even
   after structural validation. Escape Markdown, HTML, code fences and link
   syntax in context. Also neutralize GitHub's autolinks: user and team
   mentions, `#123` and `owner/repo#123` references, bare URLs, commit SHAs,
   and emoji shortcodes. Do not allow text or URLs to create headings, hidden
   content, metadata, mentions, references, or unvetted destinations. Only
   renderer-owned controlled HTML and vetted links are allowed. Do not expose
   raw provider responses, secrets, or private source excerpts.
7. When the full body is too large, deterministically omit lower-priority
   material, such as Use now, Consider later, and Not relevant detail, and
   disclose the omission. Preserve the opening, coverage limits, every blocker
   and its required content, every unresolved unit and its action, and every
   assessed unit's required evidence gap with its package and next action.
   Measure the final escaped body, including metadata and omission note. If
   those required contents cannot fit, return failure; never truncate a
   required item or publish a body above the ceiling.

## Structure and style

Use strict TypeScript, Node.js 24 ESM, GitHub Markdown, and source-adjacent
Vitest tests. `src/reporting.ts` and `src/reporting.test.ts` are proposed
locations; exact signatures belong in the plan. No new dependency or client
code is required by this contract. Prefer short prose, descriptive links and
consistent peer headings, with no decorative elements. For example:

```ts
lines.push(`**Next action:** ${escape(action)}`);
```

This illustrates the existing style contract, not a complete escaping method.

## Implementation handoff

[`renderDecisionBrief`](../../src/reporting.ts) accepts the T1 binding, a UTC
generation timestamp, an optional digest, T5 coverage, M2 unit records and
analysis-unavailable flag, and S3 attempt records with their bound identity.
S1 and S2 evidence reaches it through the validated packet. It returns either
an attributed body or a bounded failure; W2 establishes provenance and decides
T3 publication readiness. It does not publish a comment or status.

The renderer checks the supplied identity, inventory, unit and assessment
accounting, required and optional evidence gaps, and reference attribution.
It preserves the T5 outcome rather than deciding policy. It escapes external
text and neutralizes GitHub autolinks, accepts only vetted HTTPS source URLs,
and applies the 50,000-string-unit ceiling to the final body. It omits
lower-priority sections with a notice when necessary and fails if required
decision content cannot fit. The renderer relies on trusted orchestration for
the provenance of the supplied T5/M2/S3 results; shape consistency alone does
not prove that an arbitrary caller supplied authentic results.

The synthetic grouped fixture runs the actual collectors and analysis
handoffs, then supplies the rendered body to T3 with mocked GitHub transport.
It does not prove live provider behavior, workflow ownership or publication,
GitHub body round-tripping, adoption, parity, or cutover. The old reviewer
remains active until those separate gates pass.

## Verification and acceptance

Focused assertions must cover every row of
[Opening by outcome](#opening-by-outcome); a grouped PR; a verified blocker
with unresolved analysis; complete and partial evidence, including an assessed
unit with a required gap; each unresolved M2 state and failure category,
including every unit unavailable for `configuration` beside an inventory gap;
S3 failed-license reasons;
optional sections; peer heading consistency; deterministic order; and
attribution of head, date and metadata. Exercise real
T4/T5/C3/S1/S2/S3/M2-to-renderer and renderer-to-T3 handoffs at an exact
shared revision, including inconsistent bindings and invalid references.
Synthetic data must not substitute for those integration checks.

Test hostile text and link targets in every rendering context, including fake
metadata, closing details tags, mentions, issue references in this and other
repositories, bare URLs, commit SHAs, and emoji shortcodes. Also render those
hostile fixtures through GitHub's Markdown API (`POST /markdown` in `gfm` mode
with a repository context), which stores nothing, and record that the output
contains no user mention, issue link, or unvetted `href`. Test the exact
50,000-unit boundary using escaped output, metadata, omission notice, and
non-ASCII text; prove required items, including required evidence gaps of
assessed units, survive omission and overfull required content fails. Include
a plausible wrong implementation check for each new behavior check. Use
focused assertions rather than snapshots alone.

The [B1 parity scenarios](../../tests/parity/scenarios.md) have no assessed
grouped fixture: T4 rejects the full #307 inventory, and its variants stop at
inventory and unit handoff. Planning must create a sanitized, assessed grouped
fixture within T4's limit from those scenarios and use it as the
representative grouped comment. Compare its content with the B1 reporting
baseline and record each intentional difference; the full
[parity matrix](SPEC-parity-cutover.md) remains a parity-cutover gate.

Inspect the representative grouped comment in desktop and narrow GitHub
layouts; record the environment and result. GitHub's own comment Preview tab,
which renders without posting, is acceptable; a mock or local preview alone is
not proof of GitHub rendering. Exercise failure handoff without a live write;
live publication and old-comment preservation remain W2/T3 integration gates.

On the exact implementation revision run and record results and remaining gates:

```sh
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run complexity -- --base origin/main
```

The complexity report is advisory and reads committed source. For this draft
run `npm run lint:md`, `npm run format:check`, and `git diff --check`.
Live transport, workflow publication, packaging, adoption, parity and cutover
remain separate verification gates.

## Boundaries and open planning choices

- **Always:** preserve authoritative outcome and provenance, surface gaps and
  required actions, escape untrusted content, and enforce the T3 ceiling.
- **Ask first:** amend an approved contract, change comment identity or status
  semantics, add a dependency, or introduce a public interface or data
  category that the approved plan does not name.
- **Never:** hide unresolved units or required evidence gaps, invent evidence,
  publish unvetted links, mentions, or raw model output, perform GitHub writes
  from the renderer, or retire the old reviewer before separate cutover gates
  pass.

Planning must propose the concrete renderer interface, input consistency and
link-vetting strategy, autolink neutralization method, deterministic omission
order, and test/inspection fixtures. No new numeric threshold, dependency,
live publication, plan, or implementation is approved by this contract. M2's
per-unit `Re-run dependency analysis.` wording is outside O1; changing it
requires a separate M2 amendment.
