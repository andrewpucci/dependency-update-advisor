# Spec: Repository Adoption

Status: approved for planning, 2026-09-23. Module: `repo-adoption` in
[the capability map](README.md).

## Objective

Prepare each of the four initial consumer repositories to call the shared
reviewer safely and prove that it can review the current PR head, publish
its advisory execution status, and manage its own comment. Each consumer
keeps its Dependabot schedule, provider credential, excerpt choice, and
review policy local. This module establishes a working caller and an
adoption record for each repository; `SPEC-parity-cutover.md` owns the final
cross-repository parity decision and retirement of the old reviewer.

## Tech Stack

A GitHub Actions `workflow_run` caller, a public
[SHA-pinned reusable workflow](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
trusted default-branch `.github/dependabot-review.json`, individually named
secrets, and a repository-scoped GitHub App installation token. The called
workflow runs the shared reviewer action at its own pinned commit. GitHub's
[`workflow_run` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
can expose credentials, so the caller must preserve the trusted-code and
untrusted-PR-data boundary from `SPEC-shared-review.md`.

## Commands

After implementation, validate the shared revision with:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
npm run build
```

In each consumer, run that repository's documented lint, type-check, and
required tests against the exact caller/config revision. No generic command
is assumed for all four consumers. Record the commands and outcomes in that
consumer's adoption record.

## Project Structure

```text
shared repo: .github/workflows/dependabot-review.yml → pinned workflow_call target
shared repo: tests/adoption/                    → sanitized caller contract fixtures
consumer: .github/workflows/dependabot-review.yml → small workflow_run caller
consumer: .github/dependabot-review.json       → trusted local choices
consumer: .github/dependabot.yml               → unchanged schedule and ecosystems
consumer: local adoption record                → private configuration and trial evidence
```

## Code Style and Caller Contract

Keep the caller declarative and small. Pin the shared workflow to a full
commit SHA, set explicit minimum `GITHUB_TOKEN` permissions, and map only
`llm_api_key`, `review_app_id`, and `review_app_private_key` secrets. Do not
use `secrets: inherit`, a moving ref, a PR checkout, an artifact, or a cache
in the privileged job. The caller names the intended completed CI workflow;
the shared reviewer verifies its identity, run attempt, PR, actor, and head
again before any write.

The config parser, not the caller, decides provider, model, excerpt scope,
and advisory rules. A changed config in the PR head cannot affect that run.

## Requirements

1. Inventory each consumer's current Dependabot ecosystems, directories,
   local reviewer behavior, comment owner, CI workflow identity, credentials,
   and branch rules. Keep private paths, PR links, exact excerpt allowlists,
   secrets, and review-policy decisions in that consumer's adoption record,
   not in this public repository.
2. Add a config at the trusted default branch that validates against
   `SPEC-review-config.md`. Explicitly select the supported provider and
   model, choose `sendSourceExcerptsToModel: true` or `false`, and record
   policy overrides or use of shared defaults. Missing config remains a
   secure runtime default but does not satisfy the adoption gate.
3. If a private consumer enables source excerpts, review the exact effective
   file allowlist, allowed source-line shape, excluded content, provider
   destination, and a no-send payload sample before enabling transmission.
   Store the disclosure record locally. An opt-out must send no source lines.
4. Configure only the named provider and App secrets. Verify that the App
   installation is scoped to that repository and can write its managed issue
   comment and the `dependabot-review` commit status. Keep the built-in
   `GITHUB_TOKEN` read permissions limited to the documented inputs.
5. Add the caller with the intended CI workflow name and a full shared
   workflow SHA. Test its reusable-workflow resolution and bundled action
   revision. Reject moving refs, secret inheritance, PR-head checkout or
   execution, untrusted artifacts or caches, and extra write permissions.
6. Run a no-write rehearsal on a representative current-head Dependabot PR
   before allowing publication. Then use a controlled PR to prove a complete
   current-head comment and successful execution status, an invalid-config
   failure status that preserves an older comment, and stale-run rejection.
   Coordinate the trial so old and new reviewers cannot both mutate the same
   managed comment for that PR.
7. Keep the previous reviewer available throughout adoption. A failed trial
   restores the prior caller or reviewer without rewriting Git history.
   Record the shared SHA, consumer revision, tests, observed head/status,
   no-write findings, and rollback ref in the consumer repository.
8. Do not add `dependabot-review` to required branch checks in v1. A
   completed `do_not_merge` recommendation can have a successful execution
   status; incomplete execution fails its status regardless of local verdict
   overrides.

## Testing Strategy

Use sanitized caller and config fixtures in the shared repository to assert
full-SHA pinning, named secrets, token permissions, trusted code resolution,
and absence of PR execution, artifact, and cache paths. In each consumer,
run its own checks and a controlled live trial for current-head success,
invalid-config failure, stale head, comment ownership, status permissions,
and excerpt opt-in or opt-out. Record exact revisions and commands. Live
consumer evidence stays in the consumer repository.

## Boundaries

- **Always:** Validate explicit local config, full-SHA caller, permissions,
  current-head writes, comment ownership, and rollback in each consumer.
- **Ask first:** Change Dependabot scheduling, add a provider or secret, widen
  private excerpt transmission, or make the advisory status required.
- **Never:** Publish private adoption records here, inherit all secrets,
  execute PR code with credentials, or retire the old reviewer during adoption.

## Success Criteria

1. Each of the four consumers has a validated local config, named secrets,
   and a full-SHA-pinned caller tied to its intended CI workflow.
2. Each consumer proves both a successful current-head review and a visible
   failed status for a controlled invalid config, with the older comment
   preserved; obsolete runs cannot write to a newer head.
3. Each consumer's local adoption record names exact revisions, commands,
   excerpt choice, status and comment evidence, and a reversible rollback.
4. The old reviewer remains available until the separate parity and cutover
   gates pass.

## Open Questions

None for the shared adoption contract. Consumer-specific choices and trial
PRs are recorded locally during adoption.
