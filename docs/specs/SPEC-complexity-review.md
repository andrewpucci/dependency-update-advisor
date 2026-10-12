# Spec: Advisory Complexity Review

Status: approved scope, 2026-10-12. Supporting repository tooling contract.
Implementation task: [issue #64](https://github.com/andrewpucci/dependency-update-advisor/issues/64).
Approval: the user requested adoption of Videmory's PR complexity review:
“let's use that here too”. This authorizes the advisory report and sticky
comment described below; it does not authorize a new required merge gate.
Analyzer choice: on 2026-10-12 the user selected SonarJS through the existing
Vite+/Oxlint engine after comparing alternatives.

## Objective

Adapt the existing complexity review to TypeScript: compare functions against
the merge base, report current counts and scores, and highlight only new or
worsened functions above the inherited advisory threshold of 15. Complexity
findings do not fail the job. Analysis errors do fail it.

## Commands

With the repository's Node.js 24 toolchain, test the adapter and run a local
report using the commands below. The report reads committed source at `HEAD`;
uncommitted edits are not measured.

```sh
npm ci
npm run test:complexity
npm run complexity -- --base origin/main
```

These adapter tests run separately from the Vite+ suite. For complexity-tooling
changes, also run the [repository quality checks](../../CONTRIBUTING.md#repository-quality-checks).

## Report behavior

Measure tracked `.ts` and `.mjs` files in `src/` and `scripts/`, excluding
filenames ending in `.test.ts`, `.test.mjs`, `.d.ts`, or `.d.mjs`. Compare the
checked-out revision with the merge base of the selected ref. On PRs, check out
the immutable PR head and compare with the event's base SHA; on pushes to `main`,
compare with the previous push SHA. Unknown base refs and syntax errors must
not yield a clean report.

Match functions by path and name, ranking duplicate names by descending
complexity as in the original implementation. Moved or renamed functions
count as new; anonymous functions share a name and are matched by rank.
Show zero-complexity functions in the headline count as well. Inline lint
suppressions must not hide complexity scores.

Show at most 100 regression rows, ordered by descending score, and state when
the list is truncated. The comment job must reject reports exceeding 60,000
characters.

## Workflow and boundaries

- Run a separate `Complexity` workflow on PRs targeting `main` and pushes to
  `main`. Publish Markdown in the job summary, identifying both measured SHAs.
- The analysis job has read-only contents access and no provider secrets.
  Never install or execute base-revision code; read source through git.
- A separate job with no checkout uses `pull-requests: write` to upsert a
  bot-owned `<!-- complexity-report -->` comment for same-repository PRs.
  Forks retain the summary and skip comment publication. Skip closed PRs and
  outdated PR heads.
- Pin actions by full SHA. Pass report data through environment variables,
  never interpolate it into JavaScript or shell source. Enforce the comment
  length limit defined under [Report behavior](#report-behavior).
- Keep this separate from the planned dependency reviewer and its status.
  Do not change rulesets, introduce a blocking complexity threshold, or claim
  observed CI verification without an actual run.

## Analyzer maintenance

Use SonarJS cognitive complexity through the pinned Vite+/Oxlint engine.
Keep SonarJS in the root development dependencies and lockfile. npm installs
ESLint and a nested TypeScript as SonarJS peer and package dependencies, but
the analyzer never executes them. No separate analyzer package or TypeScript
ESLint parser is needed. Preserve the project's TypeScript 7 compiler,
CI quality job, and required checks.

The plugin adapter imports the pinned S3776 module directly to avoid
initializing unrelated type-aware rules that depend on TypeScript's JavaScript
API. Run `npm run test:complexity` when upgrading SonarJS or Vite+; the module
path and plugin bridge are compatibility boundaries.

## Verification

Use Node's test runner for the report adapter. Cover real TypeScript
measurements, threshold boundaries, new/worse/unchanged/improved functions,
duplicate-name matching, syntax errors, and report rendering. Exercise the
CLI against git revisions and run the existing repository validation sequence.
Document local commands and behavior in `CONTRIBUTING.md`; revision-specific
results belong in the implementation issue or PR.
