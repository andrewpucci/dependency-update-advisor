# Dependency Update Advisor context

## Current checkpoint

This public repository is in the specification phase. It will house a shared
reviewer for dependency update PRs. No reviewer code or consumer workflow has
been added. The reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com) is the
running baseline; inspect its current checkout before extraction.

The [seven-module capability map](CAPABILITY-MAP-shared-dependabot-review.md)
is a draft. Five `SPEC-*.md` documents are also drafts. Specs for
`analysis-providers`, `npm-actions-evidence`, and `repo-adoption` are still
missing. There is no approved implementation plan.

## Next action

Review and record approval or changes in the capability map. Then review the
existing specs, write the missing three, and resolve their open questions.
Plan implementation only after the relevant specs are approved.

## Where details live

- The capability map indexes modules and approval state; `SPEC-*.md` files
  define behavior and acceptance criteria.
- `docs/adr/` holds the reasoning behind approved architectural decisions.
- GitHub Issues track implementation work. A working `tasks/plan.md` may link
  issues when an ordered handoff is useful.
- Private consumer evidence and configuration stay in their own repositories.

Update this checkpoint in place when the phase changes. Keep detailed decisions,
task history, and session notes in their sources of truth rather than here.
