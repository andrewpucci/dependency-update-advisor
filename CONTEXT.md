# Dependency Update Advisor context

## Current checkpoint

The [C1 config parser and schema](docs/specs/SPEC-config-parser.md),
[C2 source-context boundary](docs/specs/SPEC-source-context.md), and
[C3 advisory policy](docs/specs/SPEC-advisory-policy.md) are merged into `main`.
[C3 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/52)
records verification limits. [T1 verification and freshness](src/event.ts)
are merged into `main` in [PR #63](https://github.com/andrewpucci/dependency-update-advisor/pull/63);
[T1 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/62)
records checks and their limits. [Advisory complexity review](docs/specs/SPEC-complexity-review.md)
is merged in [PR #65](https://github.com/andrewpucci/dependency-update-advisor/pull/65).
[T2 status publication](src/status.ts) is implemented on `issue-9`, pending merge;
[T2 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/69)
keeps W1/W2/T3 and adoption gates separate.
No shared reviewer workflow exists; the old reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com)
remains active. CI enforces lint, formatting, strict TypeScript, and finite tests.

## Next action

Review T2's implementation for [issue #9](https://github.com/andrewpucci/dependency-update-advisor/issues/9)
under the approved [execution-status contract](docs/specs/SPEC-execution-status.md).
W1/W2 must supply bounded reads and exclusive claims before T2/T3 writes.
B1–B3, C1–C3, and T1 are merged. Open downstream work:
[S3](https://github.com/andrewpucci/dependency-update-advisor/issues/53) supplies
evidence, [T5](https://github.com/andrewpucci/dependency-update-advisor/issues/12)
forms units, [M2](https://github.com/andrewpucci/dependency-update-advisor/issues/22)
validates assessments, [O1](https://github.com/andrewpucci/dependency-update-advisor/issues/23)
renders results, and T2/T3/W2 own publication. C2 handoffs remain gates;
packaging remains A1. Unit tests do not certify these integrations or cutover.

## Where details live

- The [capability map](docs/specs/README.md) indexes modules and supporting
  contracts. The [comment contract](docs/specs/SPEC-comment-experience.md) is approved.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- GitHub Issues and PRs hold implementation tasks and verification evidence.
  The gitignored `tasks/plan.md` is transient; private consumer records stay local.
