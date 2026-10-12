# Dependency Update Advisor context

## Current checkpoint

The [C1 config parser and schema](docs/specs/SPEC-config-parser.md) are implemented.
[Local verification](https://github.com/andrewpucci/dependency-update-advisor/issues/5#issuecomment-6116293460)
includes the nonempty-context test follow-up. C2 and C3 own the next context
and policy work. No reviewer workflow exists; the old reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com) remains active.
Repository CI enforces lint, formatting, strict TypeScript checking, and
finite Node tests.

## Next action

Select C2 or C3 after reviewing C1's linked evidence and
[handoffs](docs/specs/SPEC-config-parser.md). Action packaging remains A1.

## Where details live

- The [capability map](docs/specs/README.md) indexes the eight module specs,
  approved for planning, and supporting contracts. The
  [comment-experience contract](docs/specs/SPEC-comment-experience.md) is approved.
- The [B1 baseline](tests/parity/README.md) and [scenario handoff](tests/parity/scenarios.md)
  record source state and gaps under the [B1 contract](docs/specs/SPEC-extraction-baseline.md).
- [B2 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/3#issuecomment-6116292296)
  and [B3 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/4#issuecomment-6116293290)
  record tooling and CI results under the approved
  [B2](docs/specs/SPEC-local-tooling.md) and [B3](docs/specs/SPEC-ci-enforcement.md).
- The [ADR guide](docs/adr/README.md) explains how to record durable choices.
  [Source and action bundle](docs/adr/0001-typescript-source.md),
  [trusted review boundary](docs/adr/0002-privileged-review-boundary.md), and
  [immutable inventory](docs/adr/0003-immutable-files-for-dependency-inventory.md).
- GitHub Issues track implementation work. The working `tasks/plan.md` is
  gitignored and transient per PR. Revision-specific results stay in issues,
  PRs, and CI; specs and ADRs hold contracts and decisions.
- Private consumer evidence and configuration stay in their own repositories.

Update this checkpoint when phases change; keep session history in its source.
