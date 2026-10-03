# Extraction Baseline: B1

Recorded 2026-10-03 for
[issue #2](https://github.com/andrewpucci/dependency-update-advisor/issues/2),
under the approved [baseline contract](../../docs/specs/SPEC-extraction-baseline.md).

The selected baseline is the committed public-source revision
[`0f767f27c92f55fc5aecf1cc93cacb3897d6290b`](https://github.com/andrewpucci/andrewpucci.com/commit/0f767f27c92f55fc5aecf1cc93cacb3897d6290b)
alone. **No staged, unstaged, or untracked change is included.** Its 20 existing
focused test files passed all 159 tests in an isolated reproduction.
This identifies the committed planning checkout; it does not identify the
current deployed reviewer or certify shared-reviewer parity.

See [the scenario handoff](scenarios.md) for observed behavior, known gaps,
reproducible synthetic probes, and the behavior extraction must preserve or
improve. The old reviewer remains active.

## Source Observation and Selection

At 2026-10-03 16:15:47 UTC, the original source checkout had:

| Property                    | Observed state                                       |
| --------------------------- | ---------------------------------------------------- |
| Branch                      | `main`                                               |
| HEAD                        | `0f767f27c92f55fc5aecf1cc93cacb3897d6290b`           |
| Cached `origin/main`        | `659c7f24398d577c45bcb6ca96d22273de21574e`           |
| Divergence against that ref | 35 commits ahead, 7 behind                           |
| Staged changes              | None                                                 |
| Unstaged changes            | Eight reviewer files, 99 insertions and 12 deletions |
| Untracked state             | One local pilot note, excluded                       |

The source ref was not refreshed or changed. A separate GitHub MCP read of
`main` returned the same `659c7f24398d577c45bcb6ca96d22273de21574e` revision.
The histories diverge and the reviewer implementations differ; neither the
working tree nor `origin/main` was substituted for the selected snapshot.

The relevant local diff was inspected and excluded to make the baseline
reproducible from one immutable commit. Exclusion does not authorize losing
the fixes during extraction:

| Changed files under the public source reviewer directory | Excluded behavior                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `batches.mjs`, `batches.test.ts`                         | Preserve deterministic blockers when every model batch is unavailable; point rerun guidance to CI.                                     |
| `reporting.mjs`, `reporting.test.ts`                     | Tell the maintainer to rerun CI to refresh unavailable analysis.                                                                       |
| `review.mjs`, `review.test.ts`                           | Normalize an empty packet after a GitHub request limit to an interrupted collection.                                                   |
| `run.mjs`, `run.test.ts`                                 | Treat `workflow_run.run_attempt > 1` as an explicit refresh and preserve the old comment when any falsy packet follows a GitHub limit. |

The untracked pilot note contributes only sanitized public-scenario provenance,
not executable behavior or an included patch. No consumer-private evidence is
copied here. No local-diff reconstruction artifact is required for this
commit-only baseline.

## Inspection and Reproduction Commands

The following source inspection commands all exited 0:

```sh
git status --short --branch --untracked-files=all
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git log --oneline --left-right HEAD...origin/main
git diff --stat origin/main...HEAD
git diff --cached --stat
git diff --stat
git diff --cached --binary
git diff --binary
git ls-files --others --exclude-standard
git show HEAD:package.json
git show HEAD:vite-test.config.ts
git ls-tree -r --name-only HEAD -- .github/actions-scripts/dependabot-review
```

Committed code, its imported helpers, the workflow, test configuration, source
specs, and relevant local changes were inspected. The final original-checkout
check matched the initial HEAD, branch, remote ref, status, staged/unstaged
diffs, and untracked pilot-note contents.

An independent local clone was created with `git clone --local --no-hardlinks
--no-checkout`, then checked out at the selected SHA using `git checkout
--detach 0f767f27c92f55fc5aecf1cc93cacb3897d6290b`. The original checkout
was not used for installation or tests. Reproduction elsewhere can clone the
public source repository and check out that same SHA.

In the isolated source root, these setup and test commands exited 0:

```sh
vp install --frozen-lockfile
node --version
npm --version
vp --version
npm test -- --project server .github/actions-scripts/dependabot-review \
  --reporter=default --reporter=json --outputFile=../b1-focused-tests.json
```

Environment: macOS arm64, Node.js 24.18.0, npm 11.16.0, global Vite+ CLI 0.2.7,
local `vite-plus` 0.2.9, and Vitest 4.1.10. Installation ran the source's
existing postinstall and prepare scripts only in the isolated clone.

The committed and post-install lockfile SHA-256 both equal
`67591a4d534cb281ca1ef5423040e6a8aa50a9625f9c3cb2fc4b62a11ef95e27`.
The isolated clone had no tracked changes after setup and tests. The original
source checkout's observed state remained unchanged.

## Focused Test Inventory and Outcomes

Run started at 2026-10-03 16:17:22 UTC and exited 0: **20 files, 159 tests
passed; 0 failed, 0 skipped, 0 todo**. The discovered source-adjacent test-file
set exactly matched the executed file set. Vitest's JSON suite count is 46
because it includes nested suites; that is not the test-file count.

All paths below are relative to the public source's
`.github/actions-scripts/dependabot-review/` at the selected SHA.

| Test file                 | Passed tests | Principal concern                                     |
| ------------------------- | ------------ | ----------------------------------------------------- |
| `analysis.test.ts`        | 5            | Provider failures and response validation             |
| `batches.test.ts`         | 17           | Bounded analysis, grouping, partial results, verdicts |
| `context.test.ts`         | 3            | Trusted repository context                            |
| `coverage.test.ts`        | 4            | Manifest roles and lockfile relationships             |
| `diagnostics.test.ts`     | 3            | Bounded diagnostics                                   |
| `dry-run.test.ts`         | 5            | Preflight and no-write command behavior               |
| `event.test.ts`           | 3            | Workflow-run PR resolution                            |
| `freshness.test.ts`       | 3            | Head/digest deduplication and explicit refresh        |
| `github.test.ts`          | 12           | Request governance, pagination, managed comments      |
| `handoff.test.ts`         | 3            | Head-bound research handoff                           |
| `inputs.test.ts`          | 24           | Evidence collection and inventory normalization       |
| `lifecycle.test.ts`       | 3            | Install-script metadata and limits                    |
| `policy.test.ts`          | 13           | Deterministic advisory policy                         |
| `provenance.test.ts`      | 12           | Isolated, script-free npm verifier                    |
| `reporting.test.ts`       | 11           | Comment content and size bounds                       |
| `review-metadata.test.ts` | 2            | Canonical packet identity                             |
| `review.test.ts`          | 5            | Trusted input loading and request-limit behavior      |
| `run.test.ts`             | 7            | Orchestration and managed-comment lifecycle           |
| `schema.test.ts`          | 21           | Runtime validation and attribution                    |
| `workflow.test.js`        | 3            | Trusted checkout and restricted token wiring          |

External services and writes were mocked in these focused tests. No live model
request, live PR dry run, credential retrieval, consumer trial, browser suite,
full-site build, or coverage measurement was performed. Passing these tests
does not prove the later adoption and cutover gates.

## Shared Documentation Verification

The evidence change is based on shared revision
`5302777acb73fab71fd1a3bc74bef784826336df` plus the working documentation changes.
`npm run lint:md`, `npm run format:check`, and `git diff --check` all exited 0.
Edited local links resolved, the context index stayed within 40 lines, and
the documented synthetic probe command ran successfully in the isolated copy.
The public documentation was reviewed for restricted consumer details. No
shared runtime tests are implied by the source-focused results above.
