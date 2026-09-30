# Dependency Update Advisor context

## Current checkpoint

This public repository is in the specification phase. It will house a shared
reviewer for dependency update PRs. No reviewer code or consumer workflow has
been added. Local code and Markdown lint and format checks are available. The
existing reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com) is the
running baseline; inspect its current checkout before extraction.

The [eight-module capability map](docs/specs/README.md)
and all eight module specs are approved for planning. The
[comment-experience contract](docs/specs/SPEC-comment-experience.md) is also approved.
The implementation plan will be published separately from this scaffold.

## Next action

Land the scaffold, then publish the approved implementation plan and establish
the exact source baseline before extracting reviewer code.

## Where details live

- The capability map indexes modules and approval state; `SPEC-*.md` files
  define behavior and acceptance criteria.
- The [ADR guide](docs/adr/README.md) explains how to record durable choices.
  [ADR 0001](docs/adr/0001-typescript-source.md) records the TypeScript source
  and packaged JavaScript action choice. [ADR 0002](docs/adr/0002-privileged-review-boundary.md)
  and [ADR 0003](docs/adr/0003-immutable-files-for-dependency-inventory.md)
  record the trusted review boundary and dependency inventory source.
- GitHub Issues track implementation work. A working `tasks/plan.md` may link
  issues when an ordered handoff is useful.
- Private consumer evidence and configuration stay in their own repositories.

Update this checkpoint in place when the phase changes. Keep detailed decisions,
task history, and session notes in their sources of truth rather than here.
