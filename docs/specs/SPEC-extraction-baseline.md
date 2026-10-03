# Spec: Reviewer Extraction Baseline

Status: approved for B1 execution, 2026-10-03. Supporting contract for `parity-cutover`
in [the capability map](README.md), scoped to
[issue #2: B1](https://github.com/andrewpucci/dependency-update-advisor/issues/2).
Approval: the user approved this specification and the B1 plan in this session
on 2026-10-03 ("approved"). The approved
[parity and cutover contract](SPEC-parity-cutover.md) remains authoritative.

## Objective

Give extraction work a reproducible reference for the existing reviewer in
`andrewpucci/andrewpucci.com`: exact code state, existing focused tests, and
sanitized public scenarios. A future contributor must be able to reconstruct
the selected state and distinguish its observed behavior from local changes
and from the shared reviewer's required behavior.

This scope produces baseline evidence. It does not extract code, introduce a
test harness, change consumers, demonstrate shared-reviewer parity, or retire
the existing reviewer.

## Known Inputs and Assumptions

- Issue #2 reports a planning checkout at
  `0f767f27c92f55fc5aecf1cc93cacb3897d6290b`, with uncommitted changes and
  divergence from `origin/main`. This is a historical candidate, not a
  verified current checkout or selected baseline.
- The public committed
  [package manifest](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/package.json),
  [reviewer directory](https://github.com/andrewpucci/andrewpucci.com/tree/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review),
  and [test configuration](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/vite-test.config.ts)
  were inspected while drafting. They establish the available commands and
  test files at that revision, not test outcomes or local-diff contents.
- Prefer a committed revision for reproduction. If extraction needs local
  behavior, identify and preserve the exact included changes separately.
  Never describe an unrecorded working tree as a commit-only baseline.

## Tech Stack

Git inspection, the source revision's Node.js and npm toolchain, and its
existing Vite+ test runner. The historical candidate uses Node.js 24 or newer,
declares npm 11.16.0, and routes focused tests through the `server` project.
Record the versions actually used; do not silently substitute the current
shared repository's toolchain or add dependencies to the source checkout.

## Commands

During B1 execution, run these read-only commands from the source checkout.
Keep full output local until it has been reviewed for publication:

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

Record the observation time and whether `origin/main` was refreshed. A cached
remote-tracking ref proves divergence against that ref, not current GitHub
state. If it is absent, report that limitation rather than treating it as
zero divergence. Inspect the committed reviewer files, their imported helpers,
workflow, and relevant source documentation at the candidate revision, along
with each relevant local change. Listing files alone is insufficient.

In an isolated reproduction of the selected state, after checking its scripts
and installing dependencies according to its documented setup, run:

```sh
node --version
npm --version
npm test -- --project server .github/actions-scripts/dependabot-review
```

This focused command exists at the historical candidate. Reconfirm it and
the selected test inventory if another revision is chosen. Record dependency
setup commands too; do not run installs or tests in the original checkout.
No build or development server is needed for B1. Live dry runs belong to later
parity work; they are not a substitute for the focused test evidence here.

For this specification and the eventual public baseline notes, run from the
shared repository:

```sh
npm ci
npm run lint:md
npm run format:check
git diff --check
```

The shared repository does not yet provide `check`, `test`, or `build` scripts.

## Project Structure

```text
docs/specs/SPEC-extraction-baseline.md   → this supporting contract
tests/parity/README.md                  → proposed public baseline record and scenario index
tests/parity/fixtures/                  → proposed sanitized fixtures, if needed for B1
source: .github/actions-scripts/dependabot-review/ → existing code and focused tests
source: .github/workflows/dependabot-intelligent-review.yml → existing workflow
source-local evidence storage          → complete diffs, raw output, and restricted records
```

The public evidence paths are proposed outputs, not existing test tooling.
Use repository-relative public paths. Machine paths and private consumer
evidence remain outside this repository. Temporary workspace notes are not
the sole durable record of an included local diff.

## Requirements

1. Observe the source checkout without changing its branch, index, files,
   configuration, or active reviewer. Record HEAD, branch, remote-tracking
   revision, divergence counts, and staged, unstaged, and untracked state.
   Distinguish current observation from the issue's historical report.
2. Inventory committed reviewer behavior and relevant local changes. For each
   relevant change, record whether it is included or excluded and why. Include
   supporting tests, imported helpers, workflow, manifest, lockfile, and test
   configuration changes when they affect reproduction. Identify unrelated
   changes without copying their contents into the baseline.
3. Select one baseline: a full commit SHA alone, or a full SHA plus a precisely
   identified set of local changes. For the latter, preserve reconstructable
   patches and any included untracked files, their application order, and
   content digests in durable source-local storage. A diff summary or hash
   alone is insufficient. Publish only sanitized descriptions and safe
   identifiers; keep any restricted content in its source repository.
4. Reconstruct and test that exact state in an isolated location. Record the
   source SHA, included-change identity, lockfile identity, actual Node.js/npm
   versions, setup and test commands, exit codes, test-file and test counts,
   skipped tests, failures, and environment limitations. Verify the executed
   test inventory matches the selected source's focused tests. Do not fix
   failures as part of B1 or report results from another checkout as evidence.
5. Identify sanitized public scenarios with provenance, immutable input
   revisions where available, relevant existing tests, and behavior to compare.
   Include the parent contract's public PR #302 Actions comparison omission
   and PR #307's 20 unpaired npm additions. Record unavailable historical
   inputs as gaps. Label synthetic replacements as synthetic.
6. Catalog the parent contract's unavailable-comparison and introduced-
   vulnerability scenarios separately as synthetic coverage needs. Do not
   publish private uv inputs or claim that these scenarios were exercised by
   the public pilot. B1 need not implement collectors or new scenario tests.
7. For each scenario, separate observed baseline behavior, known defect or
   coverage gap, and required shared-reviewer behavior. A baseline defect
   cannot authorize an empty inventory, hidden advisory finding, or erased
   coverage limit in the shared reviewer.
8. Publish a reviewed public baseline record that links the focused test
   inventory and scenario index. Preserve failed or blocked outcomes honestly;
   they leave the extraction baseline unverified. Missing source state,
   unreconstructable included changes, or unexecuted tests must remain explicit
   blockers, not implied completion.

## Record Style

Use short Markdown records with full SHAs, exact commands, and explicit
outcomes. Keep observations distinct from requirements. For example, a
scenario description can state:

```text
Scenario: Actions update omitted by dependency comparison
Provenance: public source PR #302; input base/head revisions recorded separately
Observed baseline behavior: pending execution against the selected state
Required shared behavior: identify the update from workflow evidence,
or report incomplete Actions coverage
Evidence: pending; listing a scenario does not establish parity
```

Do not populate pass counts, approval, or a selected revision until evidence
exists. Fixtures preserve relevant dependency names, versions, change counts,
and failure semantics while removing consumer-specific sensitive content.

## Testing Strategy

Run every existing focused reviewer test at the selected state. At the
historical candidate, the inventory includes analysis, batches, context,
coverage, diagnostics, dry-run, event, freshness, GitHub access, handoff,
inputs, lifecycle, policy, provenance, reporting, review metadata,
orchestration, run entry point, schema, and workflow tests. Reconcile this
list with actual discovered files and execution output at the selected state.

Use those existing tests without changing their assertions. Do not invent
coverage thresholds or infer scenario coverage from a filename. Associate
scenarios with actual assertions where they exist and mark the rest as gaps.
Review the record for reproducibility and privacy, check edited local links,
and run the shared documentation checks before publishing it.

## Boundaries

- **Always:** Keep the source checkout read only, bind test outcomes to an
  exact reconstructed state, preserve known defects and coverage gaps, and
  inspect both working and staged public diffs for restricted details before
  publication.
- **Ask first:** Accept a fidelity regression, broaden consumer data egress,
  or expand B1 into source fixes, extraction, adoption, or cutover.
- **Never:** Publish credentials, raw model packets, private consumer links,
  exact private source paths, excerpt allowlists, or unsanitized fixtures;
  overwrite source changes; treat failed tests as passing; or retire the
  existing reviewer during baseline work.

## Success Criteria

1. The public record identifies one reproducible source SHA and every included
   local change, with durable reconstruction evidence for any such change.
2. Source status, committed behavior, divergence, and relevant local changes
   have been inspected; included and excluded state are unambiguous.
3. Existing focused tests pass against exactly that state, with exact setup
   and test commands, environment, inventory, counts, and outcomes recorded.
4. A sanitized public scenario index covers #302 and #307, separates observed
   behavior from required behavior, and identifies synthetic coverage needs.
5. Documentation checks and privacy review pass. The source checkout remains
   unchanged, and the old reviewer remains active.

## Open Questions

None for the contract. The selected source revision, excluded local changes,
focused test outcomes, and scenario gaps are recorded in the
[B1 baseline evidence](../../tests/parity/README.md). Approval of this
specification is separate from review of the resulting extraction handoff.
