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

[W2 Amendment 5](docs/specs/SPEC-review-orchestration.md#diagnostic-amendment-5-assessment-failure-reason-and-analysis-timing)
([#334](https://github.com/andrewpucci/dependency-update-advisor/issues/334),
[#337](https://github.com/andrewpucci/dependency-update-advisor/issues/337))
is implemented and merged in [PR #345](https://github.com/andrewpucci/dependency-update-advisor/pull/345).
No-write rehearsals now name assessment failures and print M2 timing on stderr
and in the trace.

## Next action

Decide [#348](https://github.com/andrewpucci/dependency-update-advisor/issues/348):
the R1 caller re-pin and diagnostics rehearsal are complete, but the no-write
run ended fail closed at `render-size`. Its sanitized reason and timing are
recorded on [#309](https://github.com/andrewpucci/dependency-update-advisor/issues/309).
Publication, production claim storage, adoption, parity, and cutover remain
separate gates.

- The [capability map](docs/specs/README.md) indexes module and contract status.
- The S1/S3 [package name form amendment](docs/specs/SPEC-advisory-lookup.md#package-name-form-amendment)
  is implemented, pending review and merge
  ([#398](https://github.com/andrewpucci/dependency-update-advisor/issues/398)).
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- Issues/PRs hold task results; `tasks/plan.md` is gitignored.
