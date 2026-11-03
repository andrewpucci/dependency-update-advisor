# Dependency Update Advisor context

## Current checkpoint

[C1 config](docs/specs/SPEC-config-parser.md),
[C2 context](docs/specs/SPEC-source-context.md),
[C3 policy](docs/specs/SPEC-advisory-policy.md),
[T1 verification](docs/specs/SPEC-event-verification.md),
[T2 status](docs/specs/SPEC-execution-status.md),
[T3 comments](docs/specs/SPEC-managed-comments.md),
[T4 packet validation](docs/specs/SPEC-review-packet.md),
[T5 decision units](docs/specs/SPEC-decision-units.md), and
[D1 reads](docs/specs/SPEC-github-read.md) are merged into `main`.
[T4 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/84)
and [T5 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/99)
record exact-revision checks and remaining integration gates.
[Advisory complexity review](docs/specs/SPEC-complexity-review.md) is merged.
No shared workflow exists; the old reviewer stays active.

## Next action

[S1 #19](docs/specs/SPEC-advisory-lookup.md) is implemented locally.
`issue-19` awaits review; #181 holds verification and remaining gates.
[U2 #18](docs/specs/SPEC-uv-relationships.md) awaits review/merge; #169 holds evidence.
[N2 #15](docs/specs/SPEC-npm-relationships.md) is implemented on
`issue-15`, pending review/merge; #140 holds verification. #93 stays separate.
[#110 snapshot reuse](docs/specs/SPEC-pr-freshness-snapshot.md) awaits review/merge;
[verification #113](https://github.com/andrewpucci/dependency-update-advisor/issues/113)
retains remaining gates. W1/W2 must supply bounded reads and exclusive claims
before T2/T3 writes. Downstream work: [S3](https://github.com/andrewpucci/dependency-update-advisor/issues/53)
supplies evidence, [M2](https://github.com/andrewpucci/dependency-update-advisor/issues/22)
validates assessments, [O1](https://github.com/andrewpucci/dependency-update-advisor/issues/23)
renders results, and T2/T3/W2 own publication. C2 handoffs remain gates;
packaging remains A1. Unit tests do not certify these integrations or cutover.

## Where details live

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues/PRs hold tasks and results; `tasks/plan.md` is gitignored.
