# Dependency Update Advisor context

## Current checkpoint

The [B1 extraction baseline](tests/parity/README.md) is established locally
for the existing reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com).
The [scenario handoff](tests/parity/scenarios.md) records known gaps and
required shared behavior. No shared reviewer code or consumer workflow has
been added; the old reviewer remains active. Local code and Markdown lint
and format checks are available.

The [eight-module capability map](docs/specs/README.md)
and all eight module specs are approved for planning. The
[comment-experience contract](docs/specs/SPEC-comment-experience.md) is also approved.
The [B1 specification](docs/specs/SPEC-extraction-baseline.md) is approved.
The [B2 local-tooling specification](docs/specs/SPEC-local-tooling.md) is approved
for execution; local-toolchain implementation is in progress.

## Next action

Complete and verify the B2 local tooling for issue #3 using the working plan.
Preserve the documented source fixes and coverage gaps during extraction.

## Where details live

- The capability map indexes modules and approval state; `SPEC-*.md` files
  define behavior and acceptance criteria.
- The [ADR guide](docs/adr/README.md) explains how to record durable choices.
  [ADR 0001](docs/adr/0001-typescript-source.md) records the TypeScript source
  and packaged JavaScript action choice. [ADR 0002](docs/adr/0002-privileged-review-boundary.md)
  and [ADR 0003](docs/adr/0003-immutable-files-for-dependency-inventory.md)
  record the trusted review boundary and dependency inventory source.
- GitHub Issues track implementation work. The working `tasks/plan.md` is
  gitignored and transient per PR; durable contracts and evidence stay tracked.
- Private consumer evidence and configuration stay in their own repositories.

Update this checkpoint in place when the phase changes. Keep detailed decisions,
task history, and session notes in their sources of truth rather than here.
