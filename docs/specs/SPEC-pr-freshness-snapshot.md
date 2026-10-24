# Spec: Reuse Validated PR Freshness Snapshots

Status: implemented on `issue-110`, pending review and merge.
Approved for execution, 2026-10-24.
Approval: the user invoked `as-plan` on 2026-10-24 after receiving the draft.
This approves the specification for planning; plan and execution approval
remain separate gates. The user approved the three-task plan and invoked
`as-build auto` on 2026-10-24, authorizing execution in one PR to close #110
and child issues #111–#113. This includes verification, commits, and the PR;
it does not authorize merge, publication by the reviewer, adoption, or cutover.
Supporting contract for `shared-review` in [the capability map](README.md),
scoped to [issue #110](https://github.com/andrewpucci/dependency-update-advisor/issues/110)
under [D1 #13](https://github.com/andrewpucci/dependency-update-advisor/issues/13).
This amends the shared classifier interface in [T1](SPEC-event-verification.md)
and [D1](SPEC-github-read.md); their freshness behavior remains authoritative.
No new capability or dependency direction is proposed.

## Objective

Let T1 freshness verification and D1 metadata checks classify a moved-base PR
using one validated binding and one parsed PR snapshot. Reuse those values
when the comparison arrives, preserving all freshness outcomes, read ordering,
and failure mappings. The users are contributors maintaining these two callers.

Before this refactor, `classifyPullRequest(binding, response, comparison?)`
reparsed both inputs each time. Both callers invoked it before and after the
comparison; `reverifyReviewBinding` also parsed its binding before its run
read. The shared context removes repeated validation without weakening either
external input boundary.

## Snapshot and Interface Contract

1. Keep unknown binding input runtime-validated and detached from caller-owned
   objects. T1 validates once at entry to `reverifyReviewBinding`; all later
   stages reuse that owned binding. D1 validates once at session creation and
   reuses its owned binding across metadata checks. A TypeScript annotation or
   cast is not evidence that a binding has passed validation.
2. Parse each newly read PR response once. Validate the same required fields
   and identities as today, then classify it against the owned binding. A
   terminal `current`, `obsolete`, or verification error needs no comparison.
   A moved-base result retains the normalized values needed to finish the
   decision, including the observed base SHA and bound merge-base identity.
3. The comparison stage validates only the newly supplied comparison response.
   Require its echoed base to match the observed PR base and its merge base
   to be a full SHA. Compare that merge base to the original binding. Do not
   reparse, clone again for validation, or reread the raw binding or PR response
   to finish this stage.
4. Keep retained values owned and immutable across the comparison await.
   Mutation of the original inputs cannot change the comparison target or
   decision. Retain only the normalized fields needed for classification,
   rather than a raw API payload. Reuse is confined to that observed snapshot;
   a later metadata read receives its own parse and classification.
5. T1 owns the shared classification logic and comparison validation. Both
   callers use it; D1 retains responsibility for `changed_files` validation,
   HTTP transport, budgets, and mapping verification outcomes to D1 results.
   Existing before/after pagination checks remain independent checks.
6. `createPullRequestClassifier(binding)` provides the runtime-validated
   context for both callers. It returns `null` or a frozen context exposing
   its owned `binding` and `classify(response)` operation. The `compare`
   branch carries `baseSha` and `complete(comparisonResponse)`; completion
   returns a terminal classification. Keep parsed-input helpers private.
   All repository callers and their fixtures use this interface; the old
   optional-comparison signature is removed.

The [T1 freshness decision table](SPEC-event-verification.md#freshness-decision-table)
remains the source of truth. Preserve malformed-input and identity-mismatch
categories, run/association precedence, obsolete-result precedence, fixed
diagnostics, and D1 failure mappings. No result grants ownership or write
authority, updates the binding, or substitutes another head, attempt, or base.

The comparison request remains
`GET /repos/{owner}/{repo}/compare/{baseSha}...{headSha}?per_page=1&page=2`,
with the same request count, targets, timing, and budget accounting.
[PR #108](https://github.com/andrewpucci/dependency-update-advisor/pull/108)
owns that request's payload fix; this scope does not revise it.

## Tech Stack, Project Structure, and Code Style

Use the existing Node.js `>=24.11.0 <25`, ESM, strict TypeScript, and Vite+
stack with no new dependencies or toolchain changes.

| Location                  | Responsibility                                                                  |
| ------------------------- | ------------------------------------------------------------------------------- |
| `src/event.ts`            | Owned binding validation, shared PR classification, T1 freshness orchestration. |
| `src/github-read.ts`      | D1 session and metadata integration.                                            |
| `src/event.test.ts`       | T1 decision-table, validation, and freshness fixtures.                          |
| `src/github-read.test.ts` | D1 transport, result, and budget fixtures.                                      |
| `docs/specs/`             | This proposal, affected interface documentation, and approval index.            |

Use small pure validators, `unknown` at external boundaries, single quotes,
and discriminated unions consistent with the existing source. Preserve fixed
structured errors, for example:

```ts
const invalidComparison: VerificationError = {
  kind: 'error',
  category: 'input',
  field: 'comparison',
};
```

## Testing Strategy and Success Criteria

Use existing synthetic fixtures and mocked reads from `vite-plus/test`.
Preserve the behavioral assertions in the T1 base-identity and D1 suites;
adapt their calls to the revised interface without weakening their scenarios.

1. Demonstrate one binding parse for each T1 reverify call and one at D1
   session creation, with no repeated binding validation inside classification.
   Each reached PR snapshot is parsed once, including a moved-base check.
   Unreached stages after early rejection need no parse. Establish this with
   focused deterministic instrumentation or access-count fixtures plus review
   of the validation call paths; no production counters or public test hooks.
2. Exercise every T1 freshness-table row through the shared interface and both
   callers: unchanged base, retarget, head move, closure/merge, moved base with
   equal or changed merge base, and failed/malformed comparison. Preserve
   exact error categories/fields and D1 reason/obsolete mappings.
3. Preserve no-comparison assertions for terminal decisions and exactly one
   comparison dispatch when required. Keep run/association rejection precedence
   and safe diagnostics covered by the existing fixtures.
4. Check snapshot ownership across a delayed comparison: mutating the original
   binding or PR response after parsing cannot alter its target or outcome.
   A subsequent metadata read must classify its new response independently;
   it cannot reuse an earlier PR classification.
5. Existing D1 budget, cancellation, `changed_files`, and pagination-bracketing
   fixtures still pass with unchanged request targets and accounting. Full
   repository checks pass on the implementation revision.
6. No new or worsened function exceeds the existing advisory complexity
   threshold of 15. Use the [complexity contract](SPEC-complexity-review.md);
   preserve the analyzer and its advisory repository-wide status.

No new coverage percentage, timing benchmark, live API fixture, or performance
threshold is required. Unit checks establish local classification and reuse;
they do not certify live transport, publication, adoption, or cutover.

## Commands

For documentation-only changes:

```sh
npm run lint:md
npm run format:check
git diff --check
```

For implementation changes, run the existing repository checks
and focused suites on the same revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run src/event.test.ts src/github-read.test.ts
npm test -- --run
git diff --check
npm run complexity -- --base origin/main
```

The complexity command measures committed `HEAD`, so run it after the source
changes are committed or inspect the equivalent CI report for that head.
Record exact revisions, environment, commands, outcomes, and omitted checks in
issue #110 or its PR. Documentation checks do not establish implementation verification.

## Boundaries

- **Always:** Preserve runtime validation, detached identities, existing
  freshness semantics, read ordering, D1 budgets, and safe fixed diagnostics.
  Keep the old reviewer active through its separate parity/cutover gates.
- **Ask first:** Change freshness or error semantics, comparison requests,
  exported consumer result shapes beyond the shared classifier, dependencies,
  permissions, verification tooling, or approved scope. Record spec approval
  before planning, and plan/execution approval separately before implementation.
- **Never:** Accept an unchecked binding as validated, cache freshness across
  PR reads, execute PR code, authorize writes from this context, or publish
  private consumer details or raw payloads.

## Implementation Handoff

T1 and D1 implement this contract for #110 and #111–#113 on `issue-110`.
[Verification #113](https://github.com/andrewpucci/dependency-update-advisor/issues/113)
records revision-specific checks and review evidence. Live transport,
publication, adoption, and cutover remain separate gates; the old reviewer
stays active.

## Open Questions

None. T1 documents the shared interface; this contract defines its ownership
and reuse requirements.
