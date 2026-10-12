# Dependency Update Advisor context

## Current checkpoint

The [B1 extraction baseline](tests/parity/README.md) is established locally
for the existing reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com).
The [scenario handoff](tests/parity/scenarios.md) records known gaps and
required shared behavior. The C1 config parser and schema are implemented;
no reviewer workflow exists and the old reviewer remains active. CI enforces lint,
formatting, strict TypeScript checking, and finite Node tests.

The [capability map](docs/specs/README.md) and all eight module specs are
approved for planning. The
[comment-experience contract](docs/specs/SPEC-comment-experience.md) is also approved.
The [B1 specification](docs/specs/SPEC-extraction-baseline.md) is approved.
The [B2 local-tooling specification](docs/specs/SPEC-local-tooling.md) is approved
for execution; [B2 verification](docs/verification/B2-local-tooling.md) records
the implemented revision and clean-checkout results.

## Next action

Review the [C1 verification](docs/verification/C1-config-parser.md), then
select C2 or C3. The [C1 spec](docs/specs/SPEC-config-parser.md) defines their
handoffs. Reviewer action packaging remains A1.

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

Update this checkpoint when phases change; keep session history in its source.
