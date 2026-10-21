# Dependency Update Advisor context

## Current checkpoint

[C1 config](docs/specs/SPEC-config-parser.md),
[C2 context](docs/specs/SPEC-source-context.md),
[C3 policy](docs/specs/SPEC-advisory-policy.md),
[T1 verification](docs/specs/SPEC-event-verification.md),
[T2 status](docs/specs/SPEC-execution-status.md), and
[T3 comments](docs/specs/SPEC-managed-comments.md) are merged into `main`.
T3 merged in [PR #76](https://github.com/andrewpucci/dependency-update-advisor/pull/76).
[T4 packet validation](docs/specs/SPEC-review-packet.md) is merged in
[PR #89](https://github.com/andrewpucci/dependency-update-advisor/pull/89).
[T4 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/84)
records exact-revision checks and remaining integration gates.
[Advisory complexity review](docs/specs/SPEC-complexity-review.md) is merged.
[T5 decision units](docs/specs/SPEC-decision-units.md) are implemented on this
branch for #12 and #94–#99, pending one PR and merge.
[T5 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/99)
retains integration gates. No shared workflow exists; the old reviewer stays active.

## Next action

Review the T5 implementation for [#12](https://github.com/andrewpucci/dependency-update-advisor/issues/12)
and #94–#99 in one PR. Reachability extension #93 remains deferred.
W1/W2 must supply bounded reads and exclusive claims before T2/T3 writes.
B1–B3 and C1–C3 are merged. Downstream work:
[S3](https://github.com/andrewpucci/dependency-update-advisor/issues/53) supplies
evidence, [T5](https://github.com/andrewpucci/dependency-update-advisor/issues/12)
forms units, [M2](https://github.com/andrewpucci/dependency-update-advisor/issues/22)
validates assessments, [O1](https://github.com/andrewpucci/dependency-update-advisor/issues/23)
renders results, and T2/T3/W2 own publication. C2 handoffs remain gates;
packaging remains A1. Unit tests do not certify these integrations or cutover.

## Where details live

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues and PRs hold implementation tasks and revision-specific evidence.
  The gitignored `tasks/plan.md` is transient; private consumer records stay local.
