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

## Uv Reconciliation Fixtures

`uv-graph.ts` builds bounded synthetic U1 inputs from invented TOML and mocked
immutable read sessions. `uv-metadata.ts` also supplies invented nested Git trees,
blob identities, configured roots, and rename/discovery responses. No consumer
file, live PR payload, installed Python environment, or uv execution supplies
these fixtures.

The adjacent U2 suites in `src/evidence/uv-*.test.ts` cover exact variants,
declaration mapping, project versus requested extras, source/marker separation,
scoped gaps, same-side paths, prose corroboration, and work/retention limits.
`uv.integration.test.ts` passes actual D1 read results through U1 and U2, then
assembles real T4 packets and T5 units beside the existing npm/Actions collectors.
It checks independent comparison failures, zero-change uv failures, nested and
renamed roots, revision 3/5 empty extras, the memberless prose-conflict fallback,
and acceptance at 128 combined records versus rejection at 129.

Synthetic downstream-only research/assessment records exercise packet and unit
behavior. U2 itself leaves research unavailable; these records do not claim live
research, workflow acquisition of current PR text, model output, publication,
consumer adoption, or parity/cutover. See the
[U2 handoff](../../docs/specs/SPEC-uv-relationships.md#implemented-interface-and-handoff)
for the exported interface and retained-source identities, and
[verification #169](https://github.com/andrewpucci/dependency-update-advisor/issues/169)
for exact-revision results and review disposition.

## S2 Upstream Fixtures

`upstream.ts` creates invented immutable npm, Actions and uv files plus fixed-host
HTTP responses. Adjacent S2 integration tests run actual D1/N1/N2/X1/U1/U2,
S2, S1, T4, T5 and C3 exports. Public npm/PyPI identities and Actions version
mappings come from S2 reads and validation, not pre-filled proof records.
Registry integrity, Git blob hashes, manifest correspondence and exact refs
are checked without executing dependency code or performing live research.

Cases include independent comparison 403s, introduced vulnerabilities beside
failed PyPI research, uv marker/local-version variants, grouped member failures,
unsupported Actions subpaths, additions/removals and declaration-only changes.
Only unrelated malware coverage is explicit synthetic S3 scaffolding; it does
not certify S3, model analysis, workflow publication, adoption or cutover.

The 128/129 combined-change fixture uses N1 and N2 relationship output before
lifecycle enrichment to isolate S2's change ceiling. Other mixed fixtures use
full N2 lifecycle enrichment. No collected finding is dropped to fit. A full
packet with 128 changes may independently exceed the existing source/byte caps;
the boundary fixture does not claim that all such packets fit every ceiling.

## S1 Advisory Fixtures

`advisories.ts` creates invented public identity/mapping proofs and GitHub-shaped
HTTP responses alongside actual D1/N1/N2/X1/U1/U2 collectors. Adjacent advisory
suites execute real T4 validation, T5 grouping and C3 evaluation. No test runs
consumer code, installs dependencies, resolves an Actions ref, or performs a
live advisory lookup.

The fixture set covers proposed high/critical vulnerabilities, complete empty
queries, fixed claims with both sides, comparison 403s, SHA applicability,
withdrawal/severity handling, duplicate/conflicting facts, bounded pagination,
stream/time/work/retention failures, additions/removals/declarations, grouped
transitive findings, and 128 versus 129 combined changes. Missing proof remains
unknown. Synthetic proof scaffolding is not evidence of live public-identity
or Actions mapping acquisition. See the [S1 handoff](../../docs/specs/SPEC-advisory-lookup.md#implemented-interface-and-handoff)
and [verification #181](https://github.com/andrewpucci/dependency-update-advisor/issues/181)
for the implemented scope and remaining integration gates.

## M1 Analysis Fixtures

`analysis.ts` extends the invented `policy-signals.ts` and `upstream.ts` scenarios
through actual collectors, S2/S1/S3, trusted C1 parsing, T4 validation, T5 units
and C3 evaluation. It supplies valid aliased reply documents for common validation
and mocked HTTP round trips. No consumer response, repository file, credential,
or raw live model payload supplies a committed fixture.

The C2 helper creates and removes only its own temporary synthetic checkout.
Independent expected context reaches T4 before preparation; available, disabled,
unmatched and truncated usage facts are inspected in the actual POST. The
Actions node-budget option produces a real collector inventory gap beside
independent npm/uv analysis, rather than fabricating complete collector output.

`src/analysis/*.test.ts` cover exact alias/member/source/context attribution,
policy holds, whole-batch rejection, resource boundaries, diagnostics and
deadline/cancellation cleanup. The integration suites pass successful/failed M1
states to real C3/T5 summaries without implementing M2 scheduling. Mutation
checks and revision-specific results belong in
[verification #218](https://github.com/andrewpucci/dependency-update-advisor/issues/218).

The maximum-response fixture uses synthetic whitespace plus sixfold JSON
escaping and bounded metadata to reach the recorded response allowance; it
does not claim to measure tokenizer behavior. The paid spike's incomplete
evidence and approved conservative finish decision remain in #210. Provider
compatibility, M2, workflow, publication, packaging, consumer/adoption, parity
and cutover need separate evidence. See the
[M1 handoff](../../docs/specs/SPEC-mistral-transport.md#implemented-interface-and-handoff).
