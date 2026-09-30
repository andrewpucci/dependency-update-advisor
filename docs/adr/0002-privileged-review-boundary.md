# ADR 0002: Run privileged review after CI with trusted code

Status: accepted, 2026-09-29.

## Context and Problem Statement

The reviewer needs credentials to publish a PR comment and commit status, but
the Dependabot PR supplies untrusted files and may start an unprivileged CI
run. Publication must apply only to the open PR's current head. A review also
needs to follow the intended CI workflow without treating that workflow's
artifacts or caches as trusted inputs.

GitHub allows a `workflow_run` job to access secrets and write tokens even
when the preceding job could not. It also [warns against running untrusted
code in that privileged job](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

## Considered Options

- Trigger a small consumer `workflow_run` caller after CI and invoke the
  shared reviewer through a full-SHA-pinned reusable workflow.
- Run the reviewer directly on `pull_request_target`. This can use trusted
  default-branch workflow code and credentials, but would need separate
  correlation with the intended CI run. It has the same obligation to avoid
  [executing PR code with elevated trust](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

## Decision Outcome

Chosen option: a `workflow_run` caller and SHA-pinned `workflow_call` reviewer.
The trigger supplies the CI run identity, while the called workflow supplies
reviewed code at a fixed commit. The privileged job verifies the repository,
run, PR, and current head before writing. It reads PR files as data through
bounded APIs; it never executes PR code or consumes upstream artifacts or
caches. Named secrets and narrow token permissions limit the publication
authority.

The [shared review spec](../specs/SPEC-shared-review.md) owns the exact event,
permission, head-verification, and publication requirements.

### Consequences

The publication step stays separate from untrusted PR execution and is tied
to a specific CI run and PR head. Every consumer must maintain a caller pinned
to a reviewed commit. The extra workflow and identity checks add setup and
failure paths; obsolete runs must exit without publishing, and releases
require reviewed SHA updates in consumers.
