# Spec: Shared Dependabot Review Flow

Status: draft for human review. Module: `shared-review` in
`CAPABILITY-MAP-shared-dependabot-review.md`.

## Objective

Run one reusable, advisory Dependabot reviewer from the initial consumers
without granting pull-request content access to review credentials. Every
review result or failure must be attributable to the exact current PR head.
An older managed comment must never appear to be a successful review of a new
head merely because the new run failed.

The caller remains a small `workflow_run` workflow in each repository. The
shared repository supplies the reusable workflow and reviewer action. This
module owns event verification, privilege boundaries, review execution status,
and managed-comment handoff. Evidence and provider-specific behavior belong
to their own modules.

## Tech Stack

GitHub Actions `workflow_run` and `workflow_call`, a public reusable workflow
pinned to a full commit SHA by each caller, Node.js 24 ESM, GitHub REST API,
and a GitHub App installation token with only the permissions required to
manage the PR comment and a commit status. GitHub documents that a
[`workflow_run` job can access secrets and write tokens](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
and that [the caller can pin a reusable workflow to a SHA](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

## Commands

This shared repository must provide these commands after implementation:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
```

Until extraction, run focused workflow and event regression tests in the
source repository with:

```sh
vp test run .github/actions-scripts/dependabot-review/workflow.test.js .github/actions-scripts/dependabot-review/event.test.ts
```

## Project Structure

```text
shared repo: .github/workflows/dependabot-review.yml → workflow_call entry point
shared repo: .github/actions/dependabot-review/      → action at the workflow's commit
shared repo: src/event.mjs                            → CI run and PR-head binding
shared repo: src/status.mjs                           → current-head review status
shared repo: src/review.mjs                           → orchestration and comment handoff
shared repo: src/*.test.ts                            → event, status, and workflow tests
consumer: .github/workflows/dependabot-review.yml   → minimal workflow_run caller
```

## Code Style and Workflow Contract

Use immutable repository, workflow-run, PR number, and full head-SHA
identities. Keep event parsing pure and validate data again before every
external write. Caller jobs reference the shared workflow as
`andrewpucci/dependency-update-advisor/.github/workflows/dependabot-review.yml@<full-commit-sha>`.
Within the called workflow, reference its bundled action using
`$/.github/actions/dependabot-review`, which GitHub resolves at
[the running workflow's own commit](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
Never load the action from a moving branch or from a PR checkout.

## Requirements

1. The caller triggers only on completion of the intended CI workflow. The
   shared reviewer verifies the source repository and workflow identity, the
   `pull_request` event type, Dependabot actor, run ID and attempt, PR number,
   and full `workflow_run.head_sha` against API-read PR metadata. The PR must
   still be open and its current head must match before any comment or status
   write. A mismatch is an obsolete run, not a review of the new head.
2. Fetch only the trusted default-branch workflow, reviewer code, and local
   config for execution. Read PR manifests, lockfiles, and diffs through
   bounded APIs as untrusted data. Never check out or execute PR-head code,
   restore or write an untrusted cache, download upstream CI artifacts, or
   run dependency installation or scripts from the PR in the privileged job.
   This applies even when a preceding CI job succeeded. GitHub's
   [`workflow_run` guidance](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
   specifically warns about untrusted code and cache poisoning.
3. Each caller pins the public reusable workflow to a full commit SHA.
   Third-party actions in the privileged job are pinned to full SHAs. The
   shared action uses the `$/.github/actions/...` syntax so it resolves at
   the called workflow's own commit. A release updates callers through a
   reviewed SHA change.
4. Set the built-in `GITHUB_TOKEN` permissions to `contents: read` and
   `pull-requests: read`, adding another read permission only if a documented
   endpoint requires it. Pass only individually
   named `llm_api_key`, `review_app_id`, and `review_app_private_key` secrets;
   never use `secrets: inherit`. Mint a short-lived App token limited to the
   caller repository with `Issues: write` for the managed timeline comment
   and `Commit statuses: write` for the head status. Do not pass the App token
   to evidence collectors or the LLM adapter. GitHub documents
   [issue-comment](https://docs.github.com/en/rest/issues/comments) and
   [commit-status](https://docs.github.com/en/rest/commits/statuses)
   permissions separately.
5. Publish a `dependabot-review` commit status on the verified PR head. Use
   `pending` while a current-head review is running, `success` only after a
   complete current-head result is recorded, and `failure` when config,
   credentials, model analysis, required evidence, or publication leaves the
   review unavailable or incomplete. A current but incomplete comment may
   still be published alongside the failed status. The status description
   and target URL point to the run and state, when applicable, that an older
   managed comment is stale. Re-read the PR head immediately
   before the terminal status and comment write; never publish a result for
   a superseded head. A failed status for one head cannot stand in for the
   next head.
6. The status is **advisory in v1** and is not configured as a required branch
   check. It reports whether the reviewer completed, not whether its
   recommendation is `merge`; a completed `do_not_merge` recommendation may
   have a successful execution status, while a local verdict override cannot
   turn an incomplete review status into success. GitHub
   [blocks merges only when checks are required](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
   and [required checks must pass on the latest SHA](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
   Any later decision to require this status changes the product contract and
   needs a separate review.
7. Invalid config and other pre-analysis failures leave the prior managed
   comment unchanged but publish the failed current-head status. If status
   publication itself fails, fail the privileged job, do not mutate the
   managed comment, and do not report a current successful review. Adoption
   tests must prove that status publishing works in each consumer before
   cutover.
8. Keep the managed comment owned by the designated App and include the
   reviewed head SHA, policy and coverage summary, and explicit unavailable
   analysis. A new successful review replaces only that App's prior comment.
   Duplicate or obsolete workflow events cannot delete or overwrite a
   current review. The rendered comment follows
   [the comment-experience spec](SPEC-comment-experience.md).
9. Bound network requests, payloads, concurrency, and execution time.
   Distinguish a feature or permission 403 from a GitHub rate-limit 403 using
   response context; neither can be treated as an empty dependency change
   set. Keep secrets, source excerpts, raw model payloads, and untrusted PR
   text out of logs. [GitHub secret redaction is not guaranteed](https://docs.github.com/en/actions/concepts/security/secrets).

## Testing Strategy

Use mocked GitHub responses and workflow-file assertions. Cover accepted and
rejected workflow IDs, repository mismatch, non-PR events, non-Dependabot
actors, missing PR association, stale head before and after collection,
duplicate run attempts, invalid config, comment publication failure, status
publication failure, unavailable model analysis, incomplete evidence with a
current comment, a completed `do_not_merge` recommendation, and a successful
current-head comment. Assert the status
SHA and context in every case. Verify SHA-pinned callers, `$/.github/actions`
resolution, named secrets, minimum permissions, and absence of PR checkout,
artifact downloads, cache restore, and untrusted script execution.

## Boundaries

- **Always:** Verify the CI run and current PR head, use trusted code, publish
  an advisory head status, and preserve an older comment on a failed review.
- **Ask first:** Change the status into a required branch check, add a secret
  or App permission, consume an artifact or cache, or change the privileged
  trigger.
- **Never:** Execute PR-head code with credentials, use a moving shared-flow
  ref, inherit all secrets, or silently treat a failed run as a current review.

## Success Criteria

1. A bad config on a new PR head leaves the older comment intact and shows a
   failed `dependabot-review` status on the new head with a run link.
2. A valid review publishes a current-head comment and successful execution
   status; an obsolete run cannot mutate either for a newer head.
3. Tests prove that the privileged job uses pinned trusted code, no untrusted
   artifacts or caches, named secrets, and minimum permissions.
4. Each of the four callers can publish the head status with its App token
   before the old local reviewer is retired.

## Open Questions

None for the advisory v1 contract. The implementation repository is
[`andrewpucci/dependency-update-advisor`](https://github.com/andrewpucci/dependency-update-advisor).
The action path is selected during implementation; callers must pin the
shared workflow to a full commit SHA.
