# Dependency Update Advisor context

## Current checkpoint

The [C1 config parser and schema](docs/specs/SPEC-config-parser.md) are implemented
and [locally verified](docs/verification/C1-config-parser.md), including the
nonempty-context test follow-up. C2 and C3 own the next context and policy work.
No reviewer workflow exists; the old reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com) remains active.
Repository CI enforces lint, formatting, strict TypeScript checking, and
finite Node tests.

## Next action

Review the [C1 verification](docs/verification/C1-config-parser.md), then
select C2 or C3. The [C1 spec](docs/specs/SPEC-config-parser.md) defines their
handoffs. Reviewer action packaging remains A1.

## Where details live

- The [capability map](docs/specs/README.md) indexes the eight module specs,
  approved for planning, and supporting contracts. The
  [comment-experience contract](docs/specs/SPEC-comment-experience.md) is approved.
- The [B1 baseline](tests/parity/README.md) and [scenario handoff](tests/parity/scenarios.md)
  record the selected source state and known gaps under the
  [approved B1 contract](docs/specs/SPEC-extraction-baseline.md).
- [B2 verification](docs/verification/B2-local-tooling.md) and
  [B3 verification](docs/verification/B3-ci-enforcement.md) record tooling and CI
  evidence under the approved [B2](docs/specs/SPEC-local-tooling.md) and
  [B3](docs/specs/SPEC-ci-enforcement.md) execution contracts.
- The [ADR guide](docs/adr/README.md) explains how to record durable choices.
  [ADR 0001](docs/adr/0001-typescript-source.md) records the TypeScript source
  and packaged JavaScript action choice. [ADR 0002](docs/adr/0002-privileged-review-boundary.md)
  and [ADR 0003](docs/adr/0003-immutable-files-for-dependency-inventory.md)
  record the trusted review boundary and dependency inventory source.
- GitHub Issues track implementation work. The working `tasks/plan.md` is
  gitignored and transient per PR; durable contracts and evidence stay tracked.
- Private consumer evidence and configuration stay in their own repositories.

Update this checkpoint when phases change; keep session history in its source.
