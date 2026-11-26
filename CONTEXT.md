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

The R1 `render-size` outcome is decided and its comment capacity amendment is
merged ([#348](https://github.com/andrewpucci/dependency-update-advisor/issues/348)).

## Next action

Request batching, Track C of limit-register measurement
([#380](https://github.com/andrewpucci/dependency-update-advisor/issues/380)):
fix #438 and #440, then the ask-first C3 probe run (#390). Evidence-coverage
rate fitting (B12 #370, B13 #371) waits for the batched corpus remeasure
(C10 #397), decided 2026-11-26. The
[implementation project](https://github.com/users/andrewpucci/projects/2)
holds the working order. Each change is accepted by a local R1 measurement or
replay before any re-pin. Publication, production claim storage, adoption,
parity, and cutover remain separate gates.

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The [scaled-share function amendment](docs/specs/SPEC-evidence-coverage.md#scaled-share-function-amendment)
  is merged (PR #423); B12 fits its values.
- [#412](https://github.com/andrewpucci/dependency-update-advisor/issues/412)
  keeps the required brief under half the comment cap; compaction is merged
  (PR #434), and the R1 replay and re-pin remain.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues/PRs hold task results; `tasks/plan.md` is gitignored.
