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
W2 orchestration is merged into `main` as a no-write rehearsal, with
[C4 Dependabot roots](docs/specs/SPEC-dependabot-roots.md) supplying the
collectors' trusted roots. Its R1 rehearsal reached the trusted workflow but
recorded a redacted `internal-failure`; the fixed-stage diagnostic amendment is
merged. The R1 rehearsal reported `internal-failure at unclassified`;
[#297](https://github.com/andrewpucci/dependency-update-advisor/issues/297)
tracked the cause, a final freshness check failing after the transport window.
Its Amendment 2 code and the R1 caller re-pin
([#304](https://github.com/andrewpucci/dependency-update-advisor/issues/304))
are merged. Amendment 3
([#306](https://github.com/andrewpucci/dependency-update-advisor/issues/306))
adds a 60,000 ms pre-startup allowance to the job window and is merged. The
next rehearsal ended `model-unavailable`;
[#309](https://github.com/andrewpucci/dependency-update-advisor/issues/309)
added a fixed reason (Amendment 4, merged), which showed Mistral's reasoning
model needs `top_p`, chunked content, and larger budgets (M1 amendment,
implemented, pending review and merge; live rehearsal remains).
Publication and production claim storage remain separate gates.

## Next action

[S1](docs/specs/SPEC-advisory-lookup.md), [S2](docs/specs/SPEC-upstream-evidence.md),
[S3](docs/specs/SPEC-policy-signals.md), M1 and M2 are merged; their separate
integration gates remain open.
[U2 #18](docs/specs/SPEC-uv-relationships.md) and
[N2 #15](docs/specs/SPEC-npm-relationships.md) are on `main`; #169 and #140 hold
verification. [#93 reachability](docs/specs/SPEC-reachability-evidence.md) is
implemented on `issue-93` (#266–#274), pending fresh-context review and merge.
[#110 snapshot reuse](docs/specs/SPEC-pr-freshness-snapshot.md) awaits review/merge;
[verification #113](https://github.com/andrewpucci/dependency-update-advisor/issues/113)
retains remaining gates. W1/W2 must supply bounded reads and exclusive claims
before T2/T3 writes.
[O1 #23](docs/specs/SPEC-decision-brief.md) implemented, pending review/merge;
[verification #232](https://github.com/andrewpucci/dependency-update-advisor/issues/232)
tracks its remaining gates. W2, C2, adoption, parity and cutover need proof.
[A1 #24](docs/specs/SPEC-action-package.md) is merged into `main`.
[W1 #25](docs/specs/SPEC-reusable-workflow.md) is implemented, pending review.
[W2 #26 review orchestration](docs/specs/SPEC-review-orchestration.md) is
merged on `main` as the no-write rehearsal. Production claim storage and live
publication remain separate supporting contracts. #209
has implemented [shared PyPI release observations](docs/specs/SPEC-shared-release-observations.md)
and [bounded-reader consolidation](docs/specs/SPEC-bounded-reader-consolidation.md)
on `issue-209`. Its ordered #260–#264 tasks are pending fresh-context review
and merge; publication, adoption, parity, and cutover remain separate gates.

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues/PRs hold tasks and results; `tasks/plan.md` is gitignored.
