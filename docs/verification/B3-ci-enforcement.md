# Verification: B3 Repository CI Enforcement

Recorded 2026-10-05 at 03:30:42 UTC for
[B3 #4](https://github.com/andrewpucci/dependency-update-advisor/issues/4),
under the approved [CI enforcement contract](../specs/SPEC-ci-enforcement.md).

The implemented CI gate passed an observed pull-request run and a clean local
run against the same actual merge SHA. Both executed two test files and five
tests. Four workflow assertions protect command order, revision logging,
triggers/check identity, and setup/security settings. Eleven isolated probes
were rejected. This validates repository tooling and CI, not reviewer behavior
or shared-reviewer parity.

## Revision and Observed CI Run

| Identity                | Observed value                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| PR                      | [#38](https://github.com/andrewpucci/dependency-update-advisor/pull/38)                                     |
| Run                     | [37259615356](https://github.com/andrewpucci/dependency-update-advisor/actions/runs/37259615356), attempt 1 |
| Event / workflow / job  | `pull_request` / `CI` / `Repository quality`                                                                |
| Actual tested merge SHA | `dff7be509ee3b3c1754485f974f00eb2799e041e`                                                                  |
| Associated PR head      | `09b1c0cf72fa13a992fd3bb46752ddf813627d63`                                                                  |
| Base SHA                | `e18f848b95ef5355dce3d41b4c8d7e873119b88c`                                                                  |
| Job started / completed | 2026-10-05 03:29:08 / 03:29:23 UTC                                                                          |
| Run and job conclusion  | Success                                                                                                     |

The revision step logged the tested merge SHA and successfully checked it
against `GITHUB_SHA`. Fetching `refs/pull/38/merge` produced that same SHA;
its parents match the base and PR head above. Workflow-run metadata reports
the associated PR head, so it is not used as the checkout identity. PR CI
keeps GitHub's default merge-commit checkout.

The job used Ubuntu 24.04.5 (`ubuntu-latest`), Node.js 24.21.0, and npm
11.19.0. Checkout, setup, revision logging, installation, and every required
check succeeded; none was skipped or cancelled. The revision step used
`/usr/bin/bash -e {0}`.

| Validation step      | Command                | CI conclusion                    |
| -------------------- | ---------------------- | -------------------------------- |
| Install dependencies | `npm ci`               | Success                          |
| Lint                 | `npm run lint`         | Success                          |
| Check formatting     | `npm run format:check` | Success                          |
| Type check           | `npm run check`        | Success                          |
| Run tests            | `npm test -- --run`    | Success; 2 files, 5 tests passed |

The workflow retains its check name, read-only permissions, full-SHA action
pins, disabled persisted credentials, disabled caching, event filters,
timeout, and concurrency. Type checking and tests are explicit steps after
format checking; command failures are not masked.

## Same-SHA Clean Local Validation

An isolated copy was created with `git clone --local --no-hardlinks
--no-checkout` and checked out detached at the tested merge SHA above.
Both setup operations exited 0. It started without `node_modules` and
with an empty `git status --porcelain`. Source/destination machine paths
are omitted from this public record.

The local environment was macOS / arm64, Node.js 24.13.0, and npm 11.19.0.
The repository-local compiler reported TypeScript 7.0.2 and Vite+ reported
1.0.0; both version commands exited 0. Local and CI Node patches differ
within the declared Node.js 24 range and are recorded separately.

These commands ran in order; every command exited 0:

```sh
git rev-parse HEAD
node --version
npm --version
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
git status --short --untracked-files=all
```

Installation added 179 packages and audited 180 locally; CI added 178 and
audited 179. Local lint checked 26 Markdown files without issues, formatting
passed, and strict compiler checking invoked
`tsc --project tsconfig.json --noEmit`. Tests passed **2 files, 5 tests;
0 failed or skipped** in Node. No global compiler or test runner was used.

Final status was empty: checks left tracked files unchanged and added no
untracked source files. An inventory outside dependencies and Git metadata
found no emitted JavaScript, maps, declarations, or TypeScript incremental
state. The lockfile matched the committed tested revision with this digest:

```text
da6e36c6bb66d2f32bdeef657184441f4453173771bf7c14b435674203afb358
```

## Regression Assertions and Failure Probes

Before extending CI, `npm test -- --run tests/ci-workflow.test.ts` ran against
`a6b8cd0` plus the new test file. It exited 1: three of four assertions failed
because revision logging, type checking, and test execution were missing.
After adding the steps, the focused command exited 0 with four passing tests.
Final full validation passed at that revision plus the task edits, committed
as `734345c96eb96844179e4e6304a446d73cd63feb`.

These probes ran independently in a separate checkout of `a6b8cd0` with the
new workflow and assertion file copied in. Each ran the focused command above
and exited 1. After restoring the exact workflow bytes, `npm test -- --run`
exited 0 with two files and five tests passing.

| Probe                   | Rejected behavior                               |
| ----------------------- | ----------------------------------------------- |
| Missing type-check step | Omitted compiler gate                           |
| Missing test step       | Omitted test gate                               |
| Reordered checks        | Tests before type checking                      |
| Mutating format command | `npm run format` replacing `format:check`       |
| Masked step failure     | `continue-on-error: true`                       |
| Shell fallback          | Type check followed by `\|\| true`              |
| Comment decoy           | Commented command standing in for execution     |
| Unrelated-job decoy     | Another job's command standing in for this gate |
| Disabled identity check | `true` replacing the SHA equality check         |
| Job permission override | `contents: write` overriding read-only access   |
| Custom shell defaults   | `bash {0}` removing default failure handling    |

The assertions target the current small workflow structure, not general YAML
validation. The observed Actions run separately verifies syntax and execution.
Raw probe and runner logs remain in ignored working notes.

## Documentation Verification and Warnings

README and CONTRIBUTING command blocks were compared with npm scripts and
CI, and edited local links were checked. Documentation checks passed against
`734345c` plus those edits, committed as
`09b1c0cf72fa13a992fd3bb46752ddf813627d63`.

Intermediate checks caught a formatting issue after the last assertion edit
and a long status line in the ignored working plan. The test file was
formatted and the plan line wrapped; affected checks then passed. These were
preliminary working-tree failures, not failures of the observed run.

Both clean local installation and CI reported five high-severity audit
findings. Local installation also warned about unapproved install scripts
for `fsevents@2.3.3`. No audit repair or install-script approval was performed.
The [existing deferral in #33](https://github.com/andrewpucci/dependency-update-advisor/issues/33)
remains unresolved; B3 does not change dependency pins or audit policy.

This record and its checkpoint update are added after the tested revision.
Their documentation checks and subsequent current CI results are separate
from the same-SHA implementation evidence above. A later evidence commit
does not change which revision the earlier run validated.

The record/checkpoint edits passed `npm run lint:md`,
`npm run format:check`, and `git diff --check` against `09b1c0c` plus those
working edits. Edited local links were checked and the public diff reviewed.

No action entry point or build command exists. Action packaging and the
committed-bundle integrity gate remain A1 work. No consumer configuration,
privileged reviewer code, baseline evidence, or active reviewer was changed.
