# Spec: A1 JavaScript Action Package

Status: approved for planning, 2026-11-08. The user approved the reviewed
draft, including the Opus reviewer's findings, and invoked `as-plan`. Plan
and execution approval remain separate gates. The user then approved the
plan and `as-build auto` (one closing PR). Implemented for #234–#238 and
A1 #24, pending review and merge; the evidence is on #24. Supporting contract for
`shared-review` in [the capability map](README.md), scoped to
[A1 #24](https://github.com/andrewpucci/dependency-update-advisor/issues/24).
The approved [shared-review contract](SPEC-shared-review.md),
[ADR 0001](../adr/0001-typescript-source.md), and
[CI enforcement](SPEC-ci-enforcement.md) remain authoritative; this draft
amends none of them.

## Objective

Package the strict TypeScript reviewer source as one committed JavaScript
bundle that a consumer runner executes under `runs.using: node24` with no
TypeScript loader and no dependency install. CI fails when the committed
bundle differs from a clean build of the same revision.

A1 delivers the packaging mechanism and its integrity gate. It does not
deliver review orchestration, the reusable workflow, or any write path. W2
owns orchestration and the workflow; the old reviewer stays active.

## Assumptions to confirm

1. [T2 #9](https://github.com/andrewpucci/dependency-update-advisor/issues/9),
   [T3 #10](https://github.com/andrewpucci/dependency-update-advisor/issues/10)
   and [O1 #23](https://github.com/andrewpucci/dependency-update-advisor/issues/23)
   are merged. `CONTEXT.md` records T2 and T3 as merged, and O1 merged at
   `c13c7fb` (PR #233). Confirm the blocker issues are closed before planning.
2. `src/index.ts` does not exist. W2's orchestrator does not exist either, so
   A1's entry point is a fail-closed startup stub (see Entry point).
3. The bundler needs no new dependency: Vite+ 1.4.0 may already provide a
   single-file bundler (`vp pack`). This is unverified; dependencies are not
   installed in the drafting checkout. A planning spike confirms it. A new
   bundler dependency needs approval first.
4. The bundle is ESM. The root `package.json` sets `"type": "module"`, so
   Node loads `dist/index.js` as ESM at the pinned SHA, matching the "Node.js
   24 ESM" stack in the shared-review contract.

## Entry point

`src/index.ts` is the single bundle entry. It statically imports every merged
`src/` module that imports a production dependency, keeping reachable
references so tree-shaking cannot drop them, so the bundle contains every
runtime dependency. Its startup calls each production dependency once,
performs no network access, reads no secrets, and writes nothing. Until W2
replaces the body, it exits non-zero with a message that review
orchestration is not wired. Nothing references the action yet, so the stub
cannot affect a PR.

## Commands

```sh
npm ci
npm run build
npm test -- --run
npm run lint
npm run format:check
npm run check
```

`npm run build` is the only new script. It writes only under
`.github/actions/dependabot-review/dist/`, takes no network input, and is
idempotent. It first deletes that `dist/` directory, so a build that writes
nowhere or elsewhere leaves a visible deletion. Unlike the other checks, it
rewrites tracked files by design; the drift check that follows is the gate.
Drift also fails Dependabot PRs that change dependencies or the toolchain;
the author or maintainer rebuilds with `npm run build` and commits the
result. The drift check is:

```sh
npm run build
git diff --exit-code
test -z "$(git status --porcelain --ignored --untracked-files=all | grep -v '^!! node_modules/')"
```

The second command covers the whole tree, including ignored files, so a
build that writes to root `dist/` (hidden by `.gitignore`) or leaves a stray
file fails. The `node_modules/` filter is the only exclusion.

## Project Structure

```text
src/index.ts                                    → action entry point
.github/actions/dependabot-review/action.yml    → runs.using node24, main dist/index.js
.github/actions/dependabot-review/dist/index.js → committed bundle, generated
.github/actions/dependabot-review/dist/THIRD_PARTY_LICENSES → generated notices, if supported
package.json                                    → build script
vite.config.ts                                  → bundler configuration, if Vite+ is used
.github/workflows/ci.yml                        → build and drift steps
tests/ci-workflow.test.ts                       → update the pinned step list and "non-mutating" title
tests/action-package.test.ts                    → startup and bundle-shape tests
scripts/                                        → license-notice script, if the bundler cannot emit one
.gitattributes                                  → generated, LF-only bundle
docs/pr-review.md                               → "Action packaging" prompt
CONTRIBUTING.md, README.md                      → replace the "no build command" text
CONTEXT.md                                      → current checkpoint
```

## Code Style

Keep the existing TypeScript conventions. The bundle is generated: never
edit it by hand, and exclude it from lint, format, and type checks. The
existing `dist/**` ignore patterns in `vite.config.ts` and the `dist` exclude
in `tsconfig.json` are probably anchored to the repository root, so add
explicit patterns for `.github/actions/dependabot-review/dist/` and verify in
the spike that `npm run lint` and `npm run format:check` neither fail on nor
rewrite the bundle. Type checking already skips it because `tsconfig.json`
includes only `.ts` files. In `.gitattributes`, mark the directory
`linguist-generated` so review diffs collapse, and set `-text` (or `eol=lf`)
so Git normalization cannot hide CRLF output.

## Requirements

1. `action.yml` declares `runs.using: node24` and `runs.main: dist/index.js`,
   with name and description. A1 declares no inputs; W2 adds them.
2. The bundle inlines every runtime dependency. It has no bare-specifier
   imports other than `node:` built-ins and needs no `node_modules`.
3. The build is reproducible: no timestamps, absolute paths, or environment
   values in the output; LF line endings; no source map; unminified so diffs
   stay reviewable. Two builds, one of them from a checkout at a different
   path, produce identical bytes.
4. The build runs from the lockfile-pinned toolchain only. It never fetches
   code, and the consumer runner never runs it.
5. CI runs the build and drift check after the existing checks in the same
   `Repository quality` job, keeping its triggers, pins, permissions, timeout,
   and concurrency. Drift, a missing bundle, or an untracked extra file fails.
   Update `tests/ci-workflow.test.ts`, which pins the exact step list and a
   "non-mutating" title, to match. Only SHAs with a passing push-to-`main` CI
   run may be released or pinned by callers: pull-request CI checks the merge
   commit, so two PRs that pass alone can still merge into a drifted `main`.
6. Third-party code in the bundle keeps its license notices: the build emits
   a notice file with each bundled package's license text beside the bundle,
   covered by the same drift check. Use the bundler's feature if it exists;
   otherwise a repository script that reads the installed packages' license
   files. Neither adds a dependency. The lockfile alone does not satisfy this.

## Testing Strategy

Tests are Node tests under `tests/`, run by `npm test -- --run`.

- **Startup test:** export the revision with `git archive` into an empty temp
  directory and delete or omit `node_modules`, so the shipped layout is
  modeled, including the root `package.json` that makes `.js` load as ESM.
  Spawn `process.execPath` with `--no-experimental-strip-types` and
  `NODE_OPTIONS` cleared. Assert a documented exit code other than 1 (a load
  failure such as `ERR_MODULE_NOT_FOUND` also exits 1) and the exact stderr
  message. A TypeScript-loader dependency or a missing inlined import makes it
  fail.
- **Startup claims test:** run the same spawn under Node's `--permission`
  with read access limited to the temp directory, with a sentinel secret in
  the environment, and assert the sentinel never appears in output. The spike
  confirms whether Node 24's permission model also denies network access; if
  not, report that claim as unproven rather than assume it.
- **Bundle-shape test:** assert `dist/` holds exactly the expected files (one
  JavaScript file plus the notice file). Parse the bundle and assert that
  static imports, `require(`, `createRequire`, and dynamic `import()` name
  only `node:` specifiers. Assert each production dependency in `package.json`
  is present in the bundle, so tree-shaking or externalization cannot empty
  it. Assert `action.yml` fields.
- **Drift:** the CI commands above. Evidence: a source edit without a rebuild,
  a hand-edited bundle line, an untracked file in the action directory, a
  build that writes to root `dist/`, and a build that emits nothing each fail
  the check; a clean build passes. Record these runs on
  [A1 #24](https://github.com/andrewpucci/dependency-update-advisor/issues/24).
- **Reproducibility:** a one-time evidence run, not a CI test: build twice,
  once from a `git archive` copy at another path with different `TZ`, locale,
  and `HOME`, reusing the lockfile-installed toolchain. Do not symlink
  `node_modules`, which can leak real paths. CI's drift gate already compares
  a build from another machine and path.
- Per the verification policy, a fresh-context reviewer or the user confirms
  that each new check rejects a plausible wrong implementation. Report it as
  outstanding until that happens.

## Boundaries

- Always: build from trusted source at the workflow commit; keep the bundle
  and its source revision in the same commit; run the full command sequence
  on the exact revision and record it.
- Ask first: adding a bundler dependency; changing the build script, pack
  configuration, or `ci.yml` in a way that weakens the gate; changing CI
  beyond the build and drift steps; adding action inputs; changing
  `action.yml` away from `node24` or `dist/index.js`.
- Never: load the action from a moving branch or a PR checkout; commit
  secrets or raw payloads; edit the bundle by hand; skip the drift check to
  get green; claim review orchestration, publication, adoption, or cutover.

## Success Criteria

- On a clean checkout, `npm ci && npm run build` leaves the tree unchanged.
- The startup test passes without TypeScript tooling or `node_modules`.
- CI fails on each drift mutation above and passes on a clean build.
- `npm run lint`, `npm run format:check`, `npm run check`, and
  `npm test -- --run` pass on the same revision, with the revision, commands
  and outcomes recorded on [A1 #24](https://github.com/andrewpucci/dependency-update-advisor/issues/24).
- Docs no longer say a build command is unavailable.

## Open Questions

1. Resolved 2026-11-08: the user confirmed the fail-closed startup stub as
   A1's entry scope; W2 replaces its body.
2. Resolved 2026-11-08: the user chose `vp pack` if the planning spike
   confirms it produces the single-file ESM bundle. If it cannot, return to
   the user before adding any bundler dependency.
3. Resolved 2026-11-08: the user chose to emit a third-party license notice
   file next to the bundle without extra dependencies. After review, the user
   approved the reviewer's refinement: if the bundler cannot emit it, a
   repository script reads the installed licenses, because the lockfile holds
   no license text.

## Implementation notes

Decisions made while implementing, within the approved scope:

- `vp pack` (tsdown/rolldown) met every need: one unminified ESM file, all
  dependencies inlined with `deps.alwaysBundle`, `fixedExtension: false` for
  a `.js` name, no source map, byte-identical rebuilds. It has no license
  feature, so `scripts/license-notices.mjs` writes `THIRD_PARTY_LICENSES.txt`.
  Packages without a license file (`spdx-exceptions`, `spdx-license-ids`) get
  their declared license and source instead of a build failure.
- Production dependencies are the six in `package.json` `dependencies`. `ajv`
  is a dev dependency used only by tests, so it is not bundled.
- The bundle uses `createRequire(import.meta.url)` and requires Node
  built-ins such as `process` and `buffer` without a `node:` prefix. The shape
  test therefore allows any built-in name, with or without the prefix.
- Node 24 has no `--allow-net`, so the permission model cannot deny network
  access. The startup test asserts the filesystem confinement and that an
  environment secret never appears in output; network silence is unproven.
- The startup test copies `git ls-files --cached --others --exclude-standard`
  from the working tree instead of using `git archive`, so it tests the same
  layout without depending on what is committed.
- The drift mutations were run locally with the exact CI commands rather than
  on scratch pull requests; only the clean run is observed in CI. A build that
  deletes and regenerates `dist/` removes an untracked stray file there, so
  that case passes; a committed stray file fails as tracked drift.
