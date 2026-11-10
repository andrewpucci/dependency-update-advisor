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
The shared workflow remains fail closed and the old reviewer stays active.
W2 orchestration is implemented on the working branch as a no-write rehearsal,
with [C4 Dependabot roots](docs/specs/SPEC-dependabot-roots.md) supplying the
collectors' trusted roots; it awaits fresh-context review and merge before any
adoption, publication, or claim-backend work.

## Next action

[S1](docs/specs/SPEC-advisory-lookup.md), [S2](docs/specs/SPEC-upstream-evidence.md),
[S3](docs/specs/SPEC-policy-signals.md), M1 and M2 are merged; their separate
integration gates remain open.
[U2 #18](docs/specs/SPEC-uv-relationships.md) awaits review/merge; #169 holds evidence.
[N2 #15](docs/specs/SPEC-npm-relationships.md) is implemented on
`issue-15`, pending review/merge; #140 holds verification. #93 stays separate.
[#110 snapshot reuse](docs/specs/SPEC-pr-freshness-snapshot.md) awaits review/merge;
[verification #113](https://github.com/andrewpucci/dependency-update-advisor/issues/113)
retains remaining gates. W1/W2 must supply bounded reads and exclusive claims
before T2/T3 writes.
[O1 #23](docs/specs/SPEC-decision-brief.md) implemented, pending review/merge;
[verification #232](https://github.com/andrewpucci/dependency-update-advisor/issues/232)
tracks its remaining gates. W2, C2, adoption, parity and cutover need proof.
[A1 #24](docs/specs/SPEC-action-package.md) is merged into `main`.
[W1 #25](docs/specs/SPEC-reusable-workflow.md) is implemented, pending review.
[W2 #26 review orchestration](docs/specs/SPEC-review-orchestration.md) has its
approved plan implemented as the no-write rehearsal on this branch. Production
claim storage and live publication remain separate supporting contracts. #209
has approved-for-planning [shared PyPI release observations](docs/specs/SPEC-shared-release-observations.md)
and [bounded-reader consolidation](docs/specs/SPEC-bounded-reader-consolidation.md)
contracts. The user approved #260–#264 and `as-build auto`; implementation is
in progress on this branch.

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues/PRs hold tasks and results; `tasks/plan.md` is gitignored.
