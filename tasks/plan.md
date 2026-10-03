# Implementation Plan: B1 Extraction Baseline

Status: approved for B1 execution, 2026-10-03.
Approval: the user approved the specification and this plan, including the
single task and its ordered execution steps, in this session ("approved").
Execution: baseline evidence prepared and verified locally; review of the
handoff and publication are pending.

## Overview and Authority

Establish the exact existing-reviewer state that later extraction will use,
run its focused tests, and record sanitized public scenarios. Scope comes
from [issue #2](https://github.com/andrewpucci/dependency-update-advisor/issues/2)
and the approved [parity-cutover contract](../docs/specs/SPEC-parity-cutover.md).
The [extraction-baseline specification](../docs/specs/SPEC-extraction-baseline.md)
is the approved supporting contract for this task.

GitHub Issues is the task list target. B1 already has one issue with acceptance
criteria and verification steps, so retain it as one task with sequential
execution steps. Do not create duplicate issues or a `tasks/todo.md` checklist.

## Dependency Order

```text
Observe committed state and relevant local changes
  → select and reconstruct the baseline
  → run existing focused tests
  → record public scenarios and sanitized outcomes
  → review baseline evidence before extraction
```

B1 has no prerequisite implementation issue. Although the `parity-cutover`
module's final rollout follows adoption, its baseline work must happen before
copying reviewer behavior. This plan covers only that preparatory task, not
the remaining modules or final parity and retirement gates.

## Implementation Choices

- Keep the original source checkout read only. Use an isolated reproduction
  for dependency installation and tests so existing local changes survive.
- Record one full source SHA and explicitly include or exclude relevant local
  changes. Preserve included changes in reconstructable form; do not rely on
  a moving branch or a description of a diff.
- Use the selected source revision's documented setup and focused tests.
  Record failures as evidence; source fixes are separate work.
- Keep the public result small: one baseline record with its test inventory
  and scenario index. Add sanitized fixtures only where needed to make the
  identified scenarios reproducible. Full restricted evidence stays local to
  its source repository.
- Compare observed behavior with the approved contract. Existing defects
  remain visible and cannot weaken the shared reviewer's coverage requirements.

These are approved execution choices, not new architecture decisions.

## Task List

1. [#2 — B1: Establish the extraction baseline](https://github.com/andrewpucci/dependency-update-advisor/issues/2)
   — no issue dependency; completes the evidence handoff before extraction.

## B1 Execution Steps

### 1. Inspect and select the source state

Inspect source HEAD, branch, status, remote-tracking revision, divergence,
committed reviewer behavior, and staged, unstaged, and untracked changes.
Review related workflow, helpers, tests, manifest, lockfile, and test
configuration. Classify changes as relevant or unrelated and explicitly state
which are part of the baseline.

The issue's `0f767f27c92f55fc5aecf1cc93cacb3897d6290b` is a historical
candidate. Compare it with the actual checkout rather than assuming the
checkout or local diff is unchanged. Record the observation time and whether
the remote-tracking ref was refreshed; absence or staleness must be visible.

Deliverable: a selected full SHA, inclusion decisions, and reconstructable
evidence for any included changes. Keep complete raw observations in
source-local evidence storage and prepare only safe public summaries.

### 2. Reproduce the state and run focused tests

Build an isolated copy of the selected committed state, applying only the
included changes. Check the source's scripts and dependency setup before
running anything. Record the lockfile identity, Node.js/npm versions, setup
commands, and test command. At the historical candidate, the focused command
verified during specification drafting is:

```sh
npm test -- --project server .github/actions-scripts/dependabot-review
```

Reconfirm it at the selected revision. Inventory the selected source's focused
test files and reconcile them with actual execution output. Record exit codes,
counts, skips, failures, and environment limitations. Do not run shared
repository tests as a substitute or repair the source during this task.

Deliverable: test evidence bound to the selected SHA and included-change
identity. If reproduction or test execution fails, preserve the outcome and
leave the verification checkpoint open.

### Checkpoint: Reproducible state

- [x] The selected source state can be reconstructed from the recorded inputs.
- [x] Existing focused tests have run against that state, with outcomes and
      test inventory recorded and any failures or limitations visible.
- [x] The original source checkout's state is unchanged.

### 3. Record the public scenario handoff

Create `tests/parity/README.md` with the baseline identity, inclusion decisions,
test inventory and outcomes, and public scenario index. Identify PR #302's
Actions comparison omission and PR #307's 20 unpaired npm additions, with
immutable input revisions where available and links to relevant existing
assertions. Mark unavailable historical inputs and missing test coverage.

Distinguish observed behavior, known defects, and behavior required by the
approved contract. Identify unavailable-comparison and introduced-vulnerability
cases as synthetic coverage needed later. Do not imply they were exercised
by the public pilot or create collectors and a shared test harness in B1.

If a small sanitized fixture is needed, preserve the dependency and failure
semantics and document its provenance. Keep private consumer inputs, paths,
allowlists, credentials, raw model packets, and unsanitized logs out of public
files. Verify edited local links and inspect the complete diff before
publication, including the staged diff if publishing is requested.

Deliverable: the public baseline record and any necessary sanitized fixtures,
with restricted reconstruction evidence retained in the source repository.

### Checkpoint: Baseline handoff

- [x] Issue #2's acceptance criterion and all three verification items are
      supported by recorded evidence; unresolved limitations remain explicit.
- [x] Documentation checks and local-link checks pass; the public diff has
      been reviewed for restricted consumer details.
- [ ] The baseline evidence is reviewed before extraction begins. B1 does
      not authorize adoption, a fidelity regression, or reviewer retirement.

## Verification and Scope

Before publishing the public notes, run:

```sh
npm run lint:md
npm run format:check
git diff --check
```

Record the checked shared revision plus working changes. Source-focused tests
run against the separately recorded source state. The shared repository has
no `check`, `test`, or `build` scripts yet; no build is required for these notes.

Likely public files: `tests/parity/README.md` and, only if needed, one or two
files under `tests/parity/fixtures/`. Source code and workflow files are read
only. Estimated scope: small to medium, one focused session if source setup
works. If reconstruction or setup exposes a separate defect, record the
blocker and scope follow-up work rather than expanding B1 silently.

## Risks and Mitigations

| Risk                                        | Effect                                          | Mitigation                                                                     |
| ------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Checkout differs from the planning snapshot | Wrong behavior becomes the baseline             | Inspect current state and identify every included change before testing.       |
| Local changes cannot be reconstructed       | Tests cannot substantiate the selected state    | Preserve exact included changes durably before creating the test copy.         |
| Source setup or focused tests fail          | Baseline verification remains incomplete        | Record the exact failure and revision; separate any repairs from B1.           |
| Historical API or PR data is unavailable    | Scenario evidence cannot be reproduced directly | Preserve available immutable inputs and label synthetic replacements and gaps. |
| Restricted evidence enters public notes     | Consumer details are disclosed                  | Keep raw evidence source-local and review public working and staged diffs.     |

## Sequencing and Open Questions

Keep state selection, reproduction, tests, and final evidence recording
sequential. After the state is selected, scenario inspection could be done
independently of tests, but this small task needs no additional agent work.

The [B1 evidence](../tests/parity/README.md) records the selected commit-only
baseline, source-state observation, 159 passing tests in 20 files, excluded
local changes, and scenario gaps. The historical PR #307 comparison payload is
unavailable; its 20-addition mechanism is reproducible with synthetic data.
Review the resulting evidence before beginning extraction. The implementation
issue remains open pending publication of the locally prepared handoff.
