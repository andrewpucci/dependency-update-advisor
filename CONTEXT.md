# Dependency Update Advisor context

## Current checkpoint

The [C1 config parser and schema](docs/specs/SPEC-config-parser.md),
[C2 source-context boundary](docs/specs/SPEC-source-context.md), and
[C3 advisory policy](docs/specs/SPEC-advisory-policy.md) are implemented on
this branch. C3 includes ten configurable rules, a fixed malware hold,
override provenance, unchecked signals, and an unresolved-decision guard.
Its [verification issue](https://github.com/andrewpucci/dependency-update-advisor/issues/52)
records exact-revision evidence. No shared reviewer workflow exists; the old
reviewer in [`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com)
remains active. CI enforces lint, formatting, strict TypeScript, and finite tests.

## Next action

Review the C3 PR stack in order: [#54](https://github.com/andrewpucci/dependency-update-advisor/pull/54),
[#55](https://github.com/andrewpucci/dependency-update-advisor/pull/55), and
[#56](https://github.com/andrewpucci/dependency-update-advisor/pull/56), then the
verification PR linked from #52. Downstream integration remains open:
[S3](https://github.com/andrewpucci/dependency-update-advisor/issues/53) supplies
evidence, [T5](https://github.com/andrewpucci/dependency-update-advisor/issues/12)
forms units, [M2](https://github.com/andrewpucci/dependency-update-advisor/issues/22)
validates assessments, [O1](https://github.com/andrewpucci/dependency-update-advisor/issues/23)
renders results, and T2/W2 own execution status. C2 handoffs remain gates;
packaging remains A1. C3 unit tests do not certify these integrations or cutover.

## Where details live

- The [capability map](docs/specs/README.md) indexes modules and supporting
  contracts. The [comment contract](docs/specs/SPEC-comment-experience.md) is approved.
- [B1 baseline](tests/parity/README.md) and [scenarios](tests/parity/scenarios.md)
  record source state and parity gaps; [C1 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/5#issuecomment-6116293460)
  and [C2 evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/47)
  record their verification.
- [B2 tooling](docs/specs/SPEC-local-tooling.md) and [B3 CI](docs/specs/SPEC-ci-enforcement.md)
  hold contracts; their issues record revision-specific results.
- The [ADR guide](docs/adr/README.md) indexes durable architecture decisions.
- GitHub Issues and PRs hold implementation tasks and verification evidence.
  The gitignored `tasks/plan.md` is transient; private consumer records stay local.
