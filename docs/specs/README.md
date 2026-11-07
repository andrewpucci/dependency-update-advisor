# Capability Map: Dependency Update Advisor

Status: approved for specification, 2026-09-23.

The v1 product is an advisory reviewer for Dependabot pull requests on GitHub.
It will serve four initial repositories and cover npm, GitHub Actions, and uv.
The name leaves room for other update bots and hosts later; v1 does
not implement those adapters.

| Module ID            | Responsibility                                                                                                                                              | Depends on                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `review-config`      | Validate trusted, repository-local provider, context, and advisory policy choices.                                                                          | —                                                                       |
| `shared-review`      | Host the pinned reusable workflow and reviewer action; verify events and PR heads, publish review status, and manage the comment.                           | `review-config`                                                         |
| `analysis-providers` | Translate the provider-neutral analysis contract into a tested Mistral adapter for v1.                                                                      | `review-config`, `shared-review`                                        |
| `npm-evidence`       | Reconcile GitHub comparison results with npm manifests, lockfiles, and Dependabot text; account for updates, additions, removals, and nested package roots. | `shared-review`                                                         |
| `actions-evidence`   | Reconcile GitHub comparison results with workflow diffs and Dependabot text; account for Actions updates, additions, removals, and coverage gaps.           | `shared-review`                                                         |
| `uv-evidence`        | Collect direct and transitive uv changes from `pyproject.toml` and `uv.lock`, including extras, additions, removals, and explicit coverage gaps.            | `shared-review`                                                         |
| `repo-adoption`      | Add SHA-pinned callers, explicit config and credentials, and current-head status verification to each initial consumer.                                     | `analysis-providers`, `npm-evidence`, `actions-evidence`, `uv-evidence` |
| `parity-cutover`     | Compare all consumers with the baseline and scenario fixtures, restore any material fidelity loss, then retire the source repository's local reviewer.      | `repo-adoption`                                                         |

Build order: `review-config` → `shared-review` → (`analysis-providers`,
`npm-evidence`, `actions-evidence`, and `uv-evidence`) → `repo-adoption` →
`parity-cutover`.

## Shared contracts

- Reviewer source and tests use strict TypeScript. The pinned workflow runs a
  committed JavaScript action bundle built from that source; external data
  remains subject to runtime validation. See [ADR 0001](../adr/0001-typescript-source.md).
- The reviewer is advisory. A `dependabot-review` commit status reports
  whether the current-head review completed; it is not a required branch check
  in v1. A failed review leaves the old comment intact and publishes a failed
  status on the current PR head.
- The privileged `workflow_run` binds the intended CI run to an open
  Dependabot PR and its current head before writing. It uses trusted code,
  named secrets, minimum permissions, and a full-SHA-pinned reusable workflow.
  It does not execute PR code or consume untrusted artifacts or caches. See
  [ADR 0002](../adr/0002-privileged-review-boundary.md).
- Configuration is local to each consumer. Defaults are fail secure: no model
  provider and no source excerpts without explicit choices. Local advisory
  rules may override defaults in either direction, but cannot hide findings
  or incomplete coverage.
- Mistral is the only tested v1 model adapter. The analysis contract remains
  provider-neutral so another adapter can be added after its own tests.
- An empty or unavailable GitHub dependency comparison is not proof that no
  dependencies or vulnerabilities changed. npm, Actions, and uv collectors
  use immutable manifests, lockfiles, and workflow diffs as needed and report
  coverage limits explicitly. See
  [ADR 0003](../adr/0003-immutable-files-for-dependency-inventory.md).
- Each evidence collector reports its own coverage. The shared reviewer
  combines their results for grouped PRs without allowing one ecosystem's
  evidence to conceal another's incomplete coverage.
- The comment follows [the comment experience spec](SPEC-comment-experience.md):
  decision and next action first, evidence limits visible, and a reviewed head
  near the opening.

## Evidence that the implementation must cover

The public pilot found that GitHub's comparison data omitted an Actions update
on [PR #302](https://github.com/andrewpucci/andrewpucci.com/pull/302), while
the workflow diff and Dependabot text identified it. On
[PR #307](https://github.com/andrewpucci/andrewpucci.com/pull/307), 20 distinct
npm additions were not paired version updates. An endpoint-specific comparison
403 must not become an empty inventory. Synthetic, sanitized fixtures cover these
gaps and an introduced vulnerability before parity is claimed.

## Spec index

- [Review configuration](SPEC-review-config.md) — approved for planning.
- [Trusted config parser](SPEC-config-parser.md) — implemented on `main`
  for C1 #5, with the approved C3 amendment in #49.
- [Bounded source context](SPEC-source-context.md) — approved for C2 execution
  in `review-config`, scoped to issue #6; implemented on `main`, with
  [verification evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/47).
- [Advisory policy rules and overrides](SPEC-advisory-policy.md) — implemented
  on `main` in `review-config` for C3 #7; [verification and integration limits](https://github.com/andrewpucci/dependency-update-advisor/issues/52)
  remain separate from downstream collector, provider, renderer, and workflow gates.
- [Shared workflow](SPEC-shared-review.md) — approved for planning.
- [Applicable vulnerability advisories](SPEC-advisory-lookup.md) — S1 #19 and
  #173–#181 implemented; #19 tracks review and merge. Exact public-identity
  proofs, Actions mappings and separate lookup outcomes preserve T4/T5/C3
  attribution; [verification #181](https://github.com/andrewpucci/dependency-update-advisor/issues/181)
  retains live proof acquisition, downstream workflow and cutover gates.
- [Common review packet validation](SPEC-review-packet.md) — implemented for
  T4 #11 and #77–#84 in `shared-review`, merged in
  [PR #89](https://github.com/andrewpucci/dependency-update-advisor/pull/89).
  [Verification evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/84)
  keeps collector/T5/M2/O1/W2, disclosure, adoption, and cutover gates separate.
  The 128-change rejection remains an approved intentional parity difference.
- [Deterministic decision units](SPEC-decision-units.md) — implemented supporting
  contract for T5 #12 in `shared-review`; initial scope uses proven grouping
  with exactly one direct change per root and complete ecosystem inventory.
  Interview decisions are confirmed; [#93](https://github.com/andrewpucci/dependency-update-advisor/issues/93)
  tracks broader reachability evidence. Implemented for #94–#99 and parent #12
  and merged into `main` in [PR #100](https://github.com/andrewpucci/dependency-update-advisor/pull/100).
  [Verification #99](https://github.com/andrewpucci/dependency-update-advisor/issues/99)
  keeps collector/M2/O1/W2, publication, adoption, and cutover gates separate.
- [Current-head execution status](SPEC-execution-status.md) — approved
  supporting contract for T2 #9 in `shared-review`; implemented and
  merged into `main`. [Verification evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/69)
  remains separate from W1/W2 transport, durable ownership, comment ordering,
  recovery, and consumer adoption.
- [App-owned managed comments](SPEC-managed-comments.md) — implemented for
  T3 #10 in `shared-review` on `ndjamena/as-spec-issue-10`, pending merge.
  [Verification evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/75)
  retains separate W1/W2 transport, ownership, ordering/recovery, O1 rendering,
  exact-body round-trip, and adoption gates.
- [CI event and current PR head verification](SPEC-event-verification.md) —
  approved supporting contract for T1 #8 in `shared-review`; implemented and
  merged into `main` in [PR #63](https://github.com/andrewpucci/dependency-update-advisor/pull/63).
  [Verification evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/62)
  remains separate from W1/W2 transport/claims and T2/T3 publication gates.
  A [base-identity amendment](SPEC-event-verification.md#base-identity-amendment)
  for T1 and the T4 binding check is implemented and merged into `main`;
  [#107](https://github.com/andrewpucci/dependency-update-advisor/issues/107)
  tracks it.
- [Analysis providers](SPEC-analysis-providers.md) — approved for planning.
- [Immutable GitHub evidence reads](SPEC-github-read.md) — implemented for
  D1 #13 and #101–#107 in `shared-review`, merged into `main`. Caller-supplied
  budgets cover discovery, immutable file bytes, and independent comparison
  availability; base/merge-base divergence remains incomplete discovery.
  [Verification #106](https://github.com/andrewpucci/dependency-update-advisor/issues/106)
  retains transport/collector/publication, adoption, and cutover gates.
- [Reuse validated PR freshness snapshots](SPEC-pr-freshness-snapshot.md) —
  supporting T1/D1 interface amendment, implemented on `issue-110`, for
  [#110](https://github.com/andrewpucci/dependency-update-advisor/issues/110)
  in `shared-review`; preserves the base-identity decision table and comparison
  request. Pending review and merge; [verification #113](https://github.com/andrewpucci/dependency-update-advisor/issues/113)
  records exact-revision checks and remaining gates.
- [npm evidence](SPEC-npm-evidence.md) — approved for planning.
- [npm change inventory](SPEC-npm-inventory.md) — implemented for N1 #14 and
  #124–#131, merged into `main` in [PR #132](https://github.com/andrewpucci/dependency-update-advisor/pull/132).
  Includes T4/T5 declaration records and combined 128-record accounting;
  [verification #131](https://github.com/andrewpucci/dependency-update-advisor/issues/131)
  retains separate N2, research, workflow, assessment/rendering, and cutover gates.
- [Proven npm relationships and lifecycle evidence](SPEC-npm-relationships.md) —
  implemented for N2 #15 and #133–#139 on `issue-15`, pending review and merge.
  Preserves T5 single-anchor grouping and exact per-member lifecycle evidence;
  broader reachability remains #93. [Verification #140](https://github.com/andrewpucci/dependency-update-advisor/issues/140)
  retains downstream research, workflow, publication, adoption, and cutover gates.
- [GitHub Actions evidence](SPEC-actions-evidence.md) — approved for planning.
- [GitHub Actions reference inventory](SPEC-actions-inventory.md) — X1 #16 and #142–#149
  implemented on `issue-16`, pending merge.
  The user approved the revised spec and plan and authorized `as-build auto`
  in one PR on 2026-11-01. Exact refs, occurrence pairing, bounded YAML aliases,
  comparison-set corroboration, and D1/T4/T5 fixtures preserve separate coverage.
  [Verification #149](https://github.com/andrewpucci/dependency-update-advisor/issues/149)
  records resolved complexity findings and downstream integration/cutover gates.
- [uv evidence](SPEC-uv-evidence.md) — approved for planning.
- [Tested uv metadata](SPEC-uv-metadata.md) — U1 #17 and #152–#159
  implemented on `issue-17`, pending review and merge. The user approved the
  revised spec/plan and authorized `as-build auto` in one PR on 2026-11-01.
  Supports schema 1 revisions 3 and 5 with exact `smol-toml@1.9.1`, bounded
  immutable snapshots, and independent comparison availability.
  [Verification #159](https://github.com/andrewpucci/dependency-update-advisor/issues/159)
  keeps U2 #18 reconciliation, mixed T4/T5 integration, research, live transport,
  workflow/publication, adoption, and cutover separate.
- [Conservative uv change reconciliation](SPEC-uv-relationships.md) — implemented
  for U2 #18 and #161–#169 on `issue-18`, pending review and merge.
  The user approved the revised spec/plan and authorized `as-build auto`
  in one PR on 2026-11-02. Preserves exact variants, scoped extras, conservative
  same-side proofs, bounded prose hints, and existing T4/T5 gates. Real
  D1/U1/U2/T4/T5 fixtures include mixed ecosystems and the approved zero-member
  conflict mapping. [Verification #169](https://github.com/andrewpucci/dependency-update-advisor/issues/169)
  retains live transport, workflow prose acquisition, research, assessment,
  rendering, publication, packaging, adoption, parity, and cutover gates.
- [Repository adoption](SPEC-repo-adoption.md) — approved for planning.
- [Comment experience](SPEC-comment-experience.md) — approved supporting contract.
- [Parity and cutover](SPEC-parity-cutover.md) — approved for planning.
- [Extraction baseline](SPEC-extraction-baseline.md) — completed B1 #2
  supporting contract for `parity-cutover`; [baseline handoff](../../tests/parity/README.md).
- [Local tooling](SPEC-local-tooling.md) — implemented on `main` for B2 #3
  in `shared-review`; [verification evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/3).
- [CI enforcement](SPEC-ci-enforcement.md) — implemented on `main` for B3 #4
  in `shared-review`; [verification evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/37).
- [Advisory complexity review](SPEC-complexity-review.md) — user-requested
  supporting repository tooling contract; implemented and merged into `main`
  in [PR #65](https://github.com/andrewpucci/dependency-update-advisor/pull/65).
  Separate from dependency review.

The source repository's existing Dependabot specs and reviewer code provide
the fidelity baseline. Private consumer policy, exact excerpt allowlists,
credential choices, and private PR links belong in their consumer repositories,
not in this public implementation repository.
