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
The shared workflow remains fail closed and the old reviewer stays active.
[W2 orchestration](docs/specs/SPEC-review-orchestration.md) is merged as a
no-write rehearsal; [C4 Dependabot roots](docs/specs/SPEC-dependabot-roots.md)
supplies its collectors' trusted roots. Its diagnostic history and separate
publication/production-claim gates are in the W2 spec.

[M1 transport](docs/specs/SPEC-mistral-transport.md) and
[M2 batching](docs/specs/SPEC-analysis-batches.md), including M2 timing and
split-depth diagnostics, are merged. The [capability map](docs/specs/README.md)
is authoritative for all contract status and remaining integration gates.

The R1 no-write rehearsal ended fail closed at `render-size`; see
[#348](https://github.com/andrewpucci/dependency-update-advisor/issues/348).

## Next action

Plan [evidence coverage](docs/specs/SPEC-evidence-coverage.md)
([#350](https://github.com/andrewpucci/dependency-update-advisor/issues/350)),
then the
[comment capacity amendment](docs/specs/SPEC-comment-experience.md#comment-capacity-amendment)
(#348), which renders its evidence states. Both are approved for planning,
2026-11-16; plan and execution approval are separate gates. Each is accepted
by a local R1 measurement or replay before any re-pin. Publication,
production claim storage, adoption, parity, and cutover remain separate gates.

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The S1/S3 [package name form amendment](docs/specs/SPEC-advisory-lookup.md#package-name-form-amendment)
  is implemented, pending review and merge
  ([#398](https://github.com/andrewpucci/dependency-update-advisor/issues/398)).
- The L9 [external citations amendment](docs/specs/SPEC-limit-register.md#external-citations-amendment)
  ([#381](https://github.com/andrewpucci/dependency-update-advisor/issues/381))
  is merged into `main` (PR #425).
- The [scaled-share function amendment](docs/specs/SPEC-evidence-coverage.md#scaled-share-function-amendment)
  (B11 #369, #414–#422) is merged into `main` (PR #423); B12 (#370) measures
  and fits its values.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues/PRs hold task results; `tasks/plan.md` is gitignored.
