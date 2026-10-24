# Dependency Update Advisor context

## Current checkpoint

[C1 config](docs/specs/SPEC-config-parser.md),
[C2 context](docs/specs/SPEC-source-context.md),
[C3 policy](docs/specs/SPEC-advisory-policy.md),
[T1 verification](docs/specs/SPEC-event-verification.md),
[T2 status](docs/specs/SPEC-execution-status.md),
[T3 comments](docs/specs/SPEC-managed-comments.md),
[T4 packet validation](docs/specs/SPEC-review-packet.md), and
[T5 decision units](docs/specs/SPEC-decision-units.md) are merged into `main`.
T5 merged in [PR #100](https://github.com/andrewpucci/dependency-update-advisor/pull/100);
[T4 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/84)
and [T5 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/99)
record exact-revision checks and remaining integration gates.
[Advisory complexity review](docs/specs/SPEC-complexity-review.md) is merged.
No shared workflow exists; the old reviewer stays active.

## Next action

The revised D1 plan for [#13](https://github.com/andrewpucci/dependency-update-advisor/issues/13)
is approved; execution remains a separate gate.
The [T1 base-identity amendment](docs/specs/SPEC-event-verification.md#base-identity-amendment)
and revised [D1 contract](docs/specs/SPEC-github-read.md) are approved for
planning; [#107](https://github.com/andrewpucci/dependency-update-advisor/issues/107)
is first, before #101–#106. Deferred reachability #93 remains separate.
W1/W2 must supply bounded reads and exclusive claims before T2/T3 writes.
Downstream work: [S3](https://github.com/andrewpucci/dependency-update-advisor/issues/53)
supplies evidence, [M2](https://github.com/andrewpucci/dependency-update-advisor/issues/22)
validates assessments, [O1](https://github.com/andrewpucci/dependency-update-advisor/issues/23)
renders results, and T2/T3/W2 own publication. C2 handoffs remain gates;
packaging remains A1. Unit tests do not certify these integrations or cutover.

## Where details live

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues and PRs hold implementation tasks and revision-specific evidence.
  The gitignored `tasks/plan.md` is transient; private consumer records stay local.
