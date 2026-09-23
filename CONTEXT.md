# Dependency Update Advisor context

## Purpose and current state

This repository is the future shared home for an advisory Dependabot reviewer
used by four initial consumer repositories. It was created on 2026-09-23 and
is in the specification phase. No reviewer code, workflow, package scripts, or
consumer caller has been added here. The existing reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com) remains the
running baseline; inspect its current checkout and tests before extraction.

The new repository is public. General requirements and synthetic fixtures may
live here. Private consumer PR identifiers, exact source files, credentials,
and source-excerpt disclosure reviews stay with that consumer.

## Decisions already made

- V1 reviews Dependabot PRs on GitHub. The project name leaves room for later
  bots or hosts without adding those adapters now.
- The reusable workflow is called at a full commit SHA. The privileged
  `workflow_run` verifies the intended CI run and current PR head, uses only
  named secrets and minimum permissions, and never executes PR-head code or
  consumes untrusted artifacts or caches.
- The review recommendation is advisory. Its separate commit status reports
  execution on the current head and is not a required branch check in v1.
- Each consumer keeps its Dependabot rules, reviewer config, policy choices,
  provider credential, and explicit source-excerpt choice. Missing config
  fails secure; local verdict rules can override defaults in either direction
  without concealing findings or incomplete coverage.
- The analysis boundary is provider-neutral. Mistral is the only adapter in
  v1 because it can be tested; an OpenAI adapter is outside v1.
- npm, GitHub Actions, and uv are all in v1. uv inventory comes from
  `pyproject.toml` and `uv.lock`, not an assumed GitHub dependency graph.
- The current reviewer is retired only after all initial consumers pass
  fidelity, current-head status, and rollback checks.

## Document and approval state

The original six-module capability map was approved in the source repository.
The seven-module revision here adds `analysis-providers` and is **draft**.
The copied specs for `review-config`, `shared-review`, `uv-evidence`, and
`parity-cutover`, plus the comment-experience contract, are also drafts.
`analysis-providers`, `npm-actions-evidence`, and `repo-adoption` still need
module specs. No implementation plan or task list has been approved. The
drafts contain proposed file paths and commands, not existing tooling.

## Next handoff

1. Review the seven-module [capability map](CAPABILITY-MAP-shared-dependabot-review.md),
   including its dependency direction and build order. Record approval or
   requested changes in the map.
2. Review the copied draft specs for fidelity and public/private separation.
3. Draft and review the three missing module specs. Resolve open questions in
   the existing specs before planning.
4. Only after the map and relevant specs are approved, make an implementation
   plan and track tasks in GitHub Issues. Use a working `tasks/plan.md` only
   if it adds a useful ordered handoff beyond the issues.

The previous checkout had uncommitted reviewer script and test changes when
this scaffold was prepared. They were not copied. Recheck that checkout's
working tree and use its code and existing specs as a behavioral baseline,
not as an assumed approved implementation for this repository.
