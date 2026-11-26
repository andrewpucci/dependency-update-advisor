# Contributing to Dependency Update Advisor

This public repository contains specifications and local validation tooling,
but no runnable shared reviewer. Start with [CONTEXT.md](CONTEXT.md), the
[capability map](docs/specs/README.md), and the spec for
the area you want to change. Follow [AGENTS.md](AGENTS.md) when using a coding
agent.

## Design and review

- Use the [PR body template](.github/pull_request_template.md) to state the
  change, contract, validation, and risks. Before completing a review, apply
  the relevant checks in the [review guide](docs/pr-review.md). Use its
  summary template to report findings.
- Treat every spec marked `draft` as a proposal. Record explicit approval in
  that file before planning or implementing its scope.
- Keep each change within an approved module boundary. Update the relevant
  spec when behavior or its acceptance criteria change.
- Follow the [ADR guide](docs/adr/README.md) when a durable architectural
  choice needs an explanation. Use GitHub Issues for individual implementation
  tasks once their specs are approved.
- Review changes against the source reviewer's current behavior and the
  documented fail-secure and trusted-workflow boundaries. Preserve the old
  reviewer until the parity and cutover gates pass.

## Writing and privacy

- Put the reader's purpose, decision, or next action near the start. Use
  descriptive headings, short paragraphs, and restrained formatting.
- Write requirements as observable behavior with a testable success criterion.
  Keep `CONTEXT.md` short and replace stale status instead of appending a log.
- Use synthetic, sanitized fixtures in this public repository. Keep private
  consumer PR links, exact source paths, excerpt allowlists, credentials, raw
  model payloads, and consumer-specific policy in their consumer repositories.
- Cite the source of non-obvious API behavior. Separate verified evidence
  from assumptions or implementation choices left for planning.

## Checks

For documentation-only changes, run `npm run lint:md`,
`npm run format:check`, and `git diff --check`. Verify edited local links and
inspect the diff for private consumer details. Before publishing, inspect the
staged diff as well. Report the exact commands and revision checked; do not
claim tests that were not run.

Keep verification commands and behavioral limits in repository docs. Record
revision-specific results in the relevant issue or PR, with links to CI runs.
Include the tested SHA, environment, commands, outcomes, warnings, and checks
not run. Development history and temporary probe results belong there too.

### Repository quality checks

With Node.js 24 (`>=24.11.0 <25`), run the commands used by the
`Repository quality` CI job:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run build
git diff --exit-code
test -z "$(git status --porcelain --ignored --untracked-files=all | grep -v '^!! node_modules/')"
```

`npm ci` installs the committed lockfile. `npm run lint` runs code and
Markdown linting. `npm run format:check` checks formatting without changing
files. `npm run check` invokes the strict TypeScript compiler with `noEmit`
over source, tests, and tool configuration. `npm test -- --run` executes
the TypeScript test suite once through Vite+; `--run` avoids watch mode. These
four validation commands do not repair or rewrite tracked files.
`npm run build` is the exception: it deletes and regenerates the committed
action bundle, so CI follows it with the drift checks described below.

For changes to complexity tooling, also run `npm run test:complexity`.
Those adapter tests run separately from the Vite+ suite, as described in
[Complexity review](#complexity-review).

The [CI workflow](.github/workflows/ci.yml) runs these checks on every pull
request targeting `main` and every push to `main`. Its `Repository quality`
check must pass before merging, and the PR branch must be up to date with
`main`. The [main ruleset](https://github.com/andrewpucci/dependency-update-advisor/rules)
also requires pull requests and resolved review threads, blocks force pushes
and deletion, and has no bypass actors. No approving reviews are required.
The planned `dependabot-review` status remains advisory.

CI logs the actual checkout SHA and Node/npm versions before validation and
verifies that the checkout matches the event SHA. Pull-request CI keeps the
default merge-commit checkout; it tests integration with `main`. Record that
tested merge SHA separately from the PR head when reporting verification.

Use `npm run format` to apply formatting locally. Oxfmt formats Markdown
syntax and preserves prose line breaks. Markdown linting checks structure,
links, and prose length without fixing files; its line-length rule excludes
tables and code blocks.

Markdown linting includes hidden directories and scans `**/*.md`, excluding
`.context/**` and `node_modules/**`. Keep these checks non-mutating.

### Action bundle

`npm run build` bundles `src/index.ts` with `vp pack` into
`.github/actions/dependabot-review/dist/index.js`, inlining every dependency
so the action runs under `runs.using: node24` with no TypeScript loader and no
install. It also writes `THIRD_PARTY_LICENSES.txt` beside the bundle. Never
edit these files by hand; change the source and rebuild.

CI runs the build, then fails on `git diff --exit-code` (tracked drift) and on
any untracked or ignored file other than `node_modules/` (stray output). To fix
a drift failure, run `npm run build` and commit the result. This includes
Dependabot PRs that change dependencies or the toolchain: rebuild on the PR
branch before merging.

Pull-request CI checks the merge commit, so two PRs that pass alone can still
merge into a drifted `main`. Release or pin only a SHA whose push-to-`main` CI
run passed. Until W2 lands, the bundle is a fail-closed stub that runs no
review; see the [action package spec](docs/specs/SPEC-action-package.md).

### Complexity review

The separate [Complexity workflow](.github/workflows/complexity.yml) reports
new or worsened functions above a SonarJS cognitive complexity score of 15.
Findings are advisory; analyzer failures fail the job. Complexity is not a
required merge check. Same-repository PRs receive a comment that is updated
on each review; fork PRs receive only a job summary.

To test the adapter and run the report locally, use the commands below.
The report reads committed source at `HEAD`; uncommitted edits are not measured.

```sh
npm ci
npm run test:complexity
npm run complexity -- --base origin/main
```

The report measures tracked `.ts` and `.mjs` files in `src/` and `scripts/`.
It excludes filenames ending in `.test.ts`, `.test.mjs`, `.d.ts`, or `.d.mjs`.
Functions are matched by path and name, ranking duplicate names by descending
score; moves and renames count as new. Zero-score functions count toward the
headline totals, and inline lint suppressions do not hide complexity scores.

On PRs, the workflow compares the PR head with the merge base of the event's
base SHA; pushes to `main` compare with the previous push SHA. The summary
identifies both measured revisions. Invalid source or missing base refs fail
rather than producing a clean comparison. The report shows at most 100
regression rows; comment publication rejects reports over 60,000 characters.

SonarJS runs through the existing Vite+/Oxlint engine with the root lockfile.
The comment job runs without source checkout and skips closed PRs or outdated
heads. See the [complexity contract](docs/specs/SPEC-complexity-review.md) for
workflow permissions, adapter maintenance, and verification requirements.

### Read-demand measurement

The [evidence coverage spec](docs/specs/SPEC-evidence-coverage.md) sets
research budgets from measured demand. To measure one Dependabot PR, open or
closed, run:

```sh
MEASURE_PR=<number> GITHUB_TOKEN=<read token> npm run measure:demand
```

It reads the PR's snapshot, collectors, and public research sources with the
model stubbed, and writes nothing to GitHub. `MEASURE_REPO` (default this
repository), `MEASURE_CI_WORKFLOW` (default `.github/workflows/ci.yml`), and
`MEASURE_OUT` (a JSON report path) are optional. The report holds counts per
research stage and host, repeated-URL requests, stage stop reasons, inventory
units, and members' evidence states and reasons per category; it records no
URL, header, token, or response body. Share only aggregate counts for consumer
repositories.

`MEASURE_TARGETS_OUT` (a path under `.context/`) also writes the advisory and
malware targets the readers settled and the tag candidates the run requested.
That file names public packages and tags, so it stays under `.context/` and is
never committed.

### Batching equivalence probe

Before a batch path is enabled, the
[batching reconciliation](docs/specs/SPEC-advisory-lookup.md#batching-reconciliation-amendment)
requires a recorded check that batches return what per-target queries return.
Replay a targets file from `measure:demand` both ways with:

```sh
MEASURE_TARGETS_IN=.context/<targets file> GITHUB_TOKEN=<read token> npm run probe:batching
```

It runs fixed seeds with or without a targets file, makes no model call, and
writes nothing to GitHub. Every request counts against
`probe.batching.maxRequests`. `PROBE_OUT` (a JSON report path) is optional. The
report holds counts, sizes, and disagreements by kind; it names no package or
tag and records no URL query, token, or response body.

Use a personal read token: the request cap's basis assumes its hourly quota,
not a workflow `GITHUB_TOKEN`'s. The report's `verdict` is `complete` only when
the run finished and every answer it needed was compared; `incomplete` counts
what was not compared, by kind. `equivalent` is `false` when any disagreement
was found, `true` only for a complete run with none, and `null` otherwise. A
run stopped by the request cap or a request error still writes what it
measured, with `stopped` saying why.
