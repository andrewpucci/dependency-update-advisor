# Spec: Local TypeScript and Test Tooling

Status: approved for B2 execution, 2026-10-03. Supporting contract for `shared-review`
in [the capability map](README.md), scoped to
[issue #3: B2](https://github.com/andrewpucci/dependency-update-advisor/issues/3).
Approval: the user requested `as-plan` and then `as-build auto` for this
specification and its presented plan on 2026-10-03, authorizing execution.
The approved [shared-review contract](SPEC-shared-review.md) and
[ADR 0001](../adr/0001-typescript-source.md) remain authoritative.

## Objective

Let contributors validate TypeScript source and tests from a clean checkout
on Node.js 24 using repository-local, pinned tools. Complete the existing
lint and formatting checks with strict compiler checking and a working test
runner. CI enforcement and contributor-command documentation belong to
[issue #4: B3](https://github.com/andrewpucci/dependency-update-advisor/issues/4),
which depends on B2.

B2 establishes the toolchain. Reviewer extraction, domain behavior, action
packaging, consumer workflows, parity verification, and cutover remain in
their existing scopes. No action build is required for B2.

## Known Inputs and Assumptions

- The attached issue and live GitHub issue agree on the command sequence and
  strict checking of both source and tests.
- The user selected Vitest through the existing pinned Vite+ toolchain on
  2026-10-03. This selects the runner; it does not approve this specification.
- At drafting revision `01fa737238959d19dd3039475f85a33c3f3b4270`, the
  repository has no reviewer source, TypeScript configuration, or `check`,
  `test`, or `build` scripts. `tests/parity/` contains baseline documentation.
- B2 depends on B1. GitHub marks
  [issue #2](https://github.com/andrewpucci/dependency-update-advisor/issues/2)
  completed as of 2026-10-03; the local context and B1 plan still describe
  handoff review and publication as pending. B2 does not rewrite those records
  or infer shared-reviewer parity from issue closure.

## Tech Stack

Preserve ESM and the declared Node.js range `>=24.11.0 <25`. Keep the existing
exact pins: `vite-plus` 1.0.0 and `markdownlint-cli2` 0.23.3. The installed
Vite+ package supplies Vitest 5.0.1 and exposes its APIs through
`vite-plus/test`; no separate Vitest dependency is needed. This matches the
[Vite+ test documentation](https://viteplus.dev/guide/test).

Add exact development-dependency pins for the TypeScript compiler and
Node.js 24 type declarations, with the updated npm lockfile committed.
Select compatible versions during planning and record them before execution;
do not upgrade the existing toolchain as an incidental change. The compiler
must be the repository-local `tsc`, not a global installation or a tool
downloaded on demand. Record the actual Node.js and npm versions used.

## Commands

The implemented B2 toolchain provides these commands:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

`npm run check` must invoke `tsc --project tsconfig.json --noEmit`, directly
or through a repository-local script. `strict: true` must also be configured.
`npm test` must delegate to `vp test` and forward `--run` for a finite run.
Keep the existing lint and format commands. No build or development server
command is introduced by this scope.

For changes to this specification, use the documentation checks:

```sh
npm run lint:md
npm run format:check
git diff --check
```

## Project Structure

```text
package.json                    → pinned dependencies and public npm scripts
package-lock.json               → reproducible dependency resolution
tsconfig.json                   → strict checking of source, tests, and tool config
vite.config.ts                  → existing lint/format config plus Node test config
src/**/*.ts                     → future reviewer source and adjacent *.test.ts files
tests/**/*.test.ts              → toolchain smoke test and future scenario tests
tests/parity/                   → existing baseline documentation, preserved
docs/specs/SPEC-local-tooling.md → this supporting contract
```

The source globs describe the future layout, not authorization to extract
reviewer code. B2 may add one small TypeScript toolchain smoke test under
`tests/`; it need not add placeholder application source.

## Code Style and Configuration Contract

Use ESM TypeScript with the existing single-quote formatting. Import test
APIs explicitly from `vite-plus/test`. For example, the test style is:

```ts
import { basename } from 'node:path';
import { expect, test } from 'vite-plus/test';

test('loads Node built-ins from a TypeScript test', () => {
  const fixturePath: string = 'tests/parity/README.md';
  expect(basename(fixturePath)).toBe('README.md');
});
```

This illustrates toolchain validation; it is not reviewer or parity evidence.
Place test settings in the existing `vite.config.ts`, using the Node
environment and discovering both `src/**/*.test.ts` and `tests/**/*.test.ts`.
Do not add a browser environment or a second test configuration.

The TypeScript configuration must include all `src/**/*.ts`, `tests/**/*.ts`,
and `vite.config.ts`, including tests adjacent to source. Exclude generated
output and workspace notes. Use ESM module resolution compatible with Node.js
24 and Vite+; confirm the concrete compiler options during planning.
Do not disable individual strict checks to make the smoke test pass.
TypeScript's [strict option](https://www.typescriptlang.org/tsconfig/strict.html)
enables its strict-checking family;
[noEmit](https://www.typescriptlang.org/tsconfig/noEmit.html) prevents compiler
output. Test transpilation and linting do not replace compiler checking.

## Testing Strategy

Include a small passing TypeScript smoke test with a Node built-in import
and a real assertion so B2 proves discovery, execution, and type resolution.
An empty suite or `passWithNoTests` is insufficient. No coverage percentage
or reviewer scenario coverage is claimed by this foundational check.

Verify failure behavior in an isolated validation checkout: introduce a
temporary type error in source, then in a test, and confirm `npm run check`
fails for each. Include a strictness-sensitive case such as an implicit-any
parameter. Confirm a deliberately failing assertion makes the test command
fail. Remove all probes and rerun the required passing sequence. Record probe
contents, commands, and exit codes; do not retain intentionally broken files.

Run final validation from a clean checkout of the implemented revision with
no preinstalled dependencies or reliance on global tools. Record the full
commit SHA, Node.js/npm/compiler/Vite+/Vitest versions, exact commands, exit
codes, and executed test-file/test counts. Verify installation and checks
leave tracked files unchanged and compiler checking emits no output.
Preserve warnings and failed or blocked outcomes in the evidence.

Hand off the verified local commands to B3 for CI enforcement and updates to
`CONTRIBUTING.md`. B2 leaves the existing CI job and contributor instructions
unchanged; the action build remains a later packaging scope.

## Boundaries

- **Always:** Pin development tools and commit their lockfile; check source
  and tests strictly; preserve baseline evidence; record exact validation
  state and outcomes; review public diffs for restricted consumer details.
- **Ask first:** Replace or upgrade the existing toolchain, add unrelated
  dependencies, weaken checking, or expand into reviewer extraction, action
  packaging, coverage targets, consumer changes, or cutover.
- **Never:** Publish private consumer details or credentials; execute consumer
  PR code with review credentials; suppress type errors to claim success;
  accept an empty test run as validation; or retire the existing reviewer.

## Success Criteria

1. A clean Node.js 24 checkout passes `npm ci`, `npm run lint`,
   `npm run format:check`, `npm run check`, and `npm test -- --run` using
   repository-local pinned tools.
2. Compiler checking covers source, tests, and tool configuration with
   `strict` and `noEmit`; isolated probes prove type errors in both source
   and tests produce nonzero exits, with no compiler output emitted.
3. At least one TypeScript test executes in the Node environment; a failing
   assertion produces a nonzero exit. No no-tests bypass is enabled.
4. The verification record gives B3 the exact local commands to enforce in
   CI and document, without implementing B3 as part of B2.
5. Validation evidence identifies the exact implemented revision, environment,
   tool versions, command results, and test counts. Reviewer code, consumer
   configuration, B1 evidence, and the active reviewer remain unchanged.

## Open Questions

None. The [B2 verification record](../verification/B2-local-tooling.md) records
the selected pins, compiler configuration adjustment, and command outcomes.
The user authorized the B2 implementation plan through `as-build auto`.
