# Capability Map: Dependency Update Advisor

Status: draft for human review, 2026-09-23. The original six-module map was
approved in the source repository; this seven-module revision adds a provider
adapter boundary and must be reviewed before planning.

The v1 product is an advisory reviewer for Dependabot pull requests on GitHub.
It will serve four initial repositories and cover npm, GitHub Actions, and uv.
The name leaves room for other update bots and hosts later; v1 does
not implement those adapters.

| Module ID              | Responsibility                                                                                                                                                              | Depends on                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `review-config`        | Validate trusted, repository-local provider, context, and advisory policy choices.                                                                                          | —                                                           |
| `shared-review`        | Host the pinned reusable workflow and reviewer action; verify events and PR heads, publish review status, and manage the comment.                                           | `review-config`                                             |
| `analysis-providers`   | Translate the provider-neutral analysis contract into a tested Mistral adapter for v1.                                                                                      | `review-config`, `shared-review`                            |
| `npm-actions-evidence` | Reconcile GitHub comparison results with npm manifests, lockfiles, Dependabot text, and workflow diffs; account for updates, additions, removals, and nested package roots. | `shared-review`                                             |
| `uv-evidence`          | Collect direct and transitive uv changes from `pyproject.toml` and `uv.lock`, including extras, additions, removals, and explicit coverage gaps.                            | `shared-review`                                             |
| `repo-adoption`        | Add SHA-pinned callers, explicit config and credentials, and current-head status verification to each initial consumer.                                                     | `analysis-providers`, `npm-actions-evidence`, `uv-evidence` |
| `parity-cutover`       | Compare all consumers with the baseline and scenario fixtures, restore any material fidelity loss, then retire the source repository's local reviewer.                      | `repo-adoption`                                             |

Build order: `review-config` → `shared-review` → (`analysis-providers`,
`npm-actions-evidence`, and `uv-evidence`) → `repo-adoption` →
`parity-cutover`.

## Shared contracts

- The reviewer is advisory. A `dependabot-review` commit status reports
  whether the current-head review completed; it is not a required branch check
  in v1. A failed review leaves the old comment intact and publishes a failed
  status on the current PR head.
- The privileged `workflow_run` binds the intended CI run to an open
  Dependabot PR and its current head before writing. It uses trusted code,
  named secrets, minimum permissions, and a full-SHA-pinned reusable workflow.
  It does not execute PR code or consume untrusted artifacts or caches.
- Configuration is local to each consumer. Defaults are fail secure: no model
  provider and no source excerpts without explicit choices. Local advisory
  rules may override defaults in either direction, but cannot hide findings
  or incomplete coverage.
- Mistral is the only tested v1 model adapter. The analysis contract remains
  provider-neutral so another adapter can be added after its own tests.
- An empty or unavailable GitHub dependency comparison is not proof that no
  dependencies or vulnerabilities changed. npm, Actions, and uv collectors
  use immutable manifests, lockfiles, and workflow diffs as needed and report
  coverage limits explicitly.
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

- [Review configuration](SPEC-review-config.md) — draft.
- [Shared workflow](SPEC-shared-review.md) — draft.
- [uv evidence](SPEC-uv-evidence.md) — draft.
- [Comment experience](SPEC-comment-experience.md) — draft supporting contract.
- [Parity and cutover](SPEC-parity-cutover.md) — draft.
- `analysis-providers`, `npm-actions-evidence`, and `repo-adoption` — module
  specs still to be drafted after this map is reviewed.

The source repository's existing Dependabot specs and reviewer code provide
the fidelity baseline. Private consumer policy, exact excerpt allowlists,
credential choices, and private PR links belong in their consumer repositories,
not in this public implementation repository.
