# Verification: B2 Local Development Tooling

Recorded 2026-10-03 at 21:26:52 UTC for
[issue #3](https://github.com/andrewpucci/dependency-update-advisor/issues/3),
under the approved [local-tooling contract](../specs/SPEC-local-tooling.md).

The implemented revision
`8a68a56fcb5506664eb102337caeb2eedd06cbfe` passed the complete B2 command
sequence in an isolated clean checkout. One TypeScript test ran and passed.
Separate probes confirmed discovery and nonzero exits for invalid types,
implicit-any parameters, failed assertions, and an empty suite. These results
validate the toolchain, not reviewer behavior or shared-reviewer parity.

## Revision and Environment

The validation copy was a local clone created with `git clone --local
--no-hardlinks --no-checkout`, then checked out with `git checkout --detach
8a68a56fcb5506664eb102337caeb2eedd06cbfe`. Both operations exited 0.
It started with no `node_modules` and an empty `git status --porcelain`.
Local source and destination paths are omitted from this public record.
No global TypeScript, Vite+, or Vitest installation was used.

| Component         | Observed version |
| ----------------- | ---------------- |
| OS / architecture | macOS / arm64    |
| Node.js           | 24.13.0          |
| npm               | 11.19.0          |
| TypeScript        | 7.0.2            |
| `@types/node`     | 24.19.1          |
| Vite+             | 1.0.0            |
| Vitest            | 5.0.1            |
| markdownlint-cli2 | 0.23.3           |
| markdownlint      | 0.41.1           |
| Vite              | 8.3.1            |
| Rolldown          | 1.2.11           |
| Oxfmt             | 0.70.0           |
| Oxlint            | 1.85.0           |
| oxlint-tsgolint   | 7.0.2003         |
| tsdown            | 0.23.0           |

The committed lockfile SHA-256 before and after validation was:

```text
da6e36c6bb66d2f32bdeef657184441f4453173771bf7c14b435674203afb358
```

Lockfile review found no changed or removed pre-existing package entries.
The additions are the compiler, its optional platform packages, Node types,
and `undici-types` required by those types.

## Clean-Checkout Commands and Outcomes

Commands ran in this order; each exited 0:

```sh
git rev-parse HEAD
node --version
npm --version
npm ci
node_modules/.bin/tsc --version
node_modules/.bin/vp --version
npm run lint
npm run format:check
npm run check
npm test -- --run
git status --short --untracked-files=all
```

`npm ci` installed 179 packages and audited 180. Lint checked code and
24 Markdown files with no issues. Formatting passed. `npm run check` invoked
`tsc --project tsconfig.json --noEmit` with strict checking enabled. Vitest
reported **1 file, 1 test passed; 0 failed or skipped**. The final status
command produced no output: installation and validation left tracked files
unchanged and added no untracked source files.

Installation reported five high-severity audit findings, as the original
toolchain installation had also reported before B2. It also warned that
`fsevents@2.3.3` had install scripts not covered by `allowScripts`.
No audit repair or install-script approval was performed as part of B2.
These warnings do not turn the successful command exit into a failed result,
and they remain unresolved rather than being omitted from the evidence.

Remediation is temporarily deferred as of 2026-10-03.
[Issue #33](https://github.com/andrewpucci/dependency-update-advisor/issues/33)
tracks the single underlying
[braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), its
dependency paths, limited current lint exposure, and absence of a published
patch. Review is due **2026-10-10**, or earlier if a fix is released or lint
inputs change. Audit results remain visible; no dependency or audit-policy
change was made. The issue records the recheck at
`ff7b55654a95d964e05eb2ecb32963c4f6fffdb8` separately from B2's original run.

## Discovery and Failure Probes

These checks ran in the isolated checkout of the same implemented revision.
Each temporary file was removed before the next independent probe. The
committed smoke test remained present except during the empty-suite check.

| Probe                                     | Command                         | Exit | Observed result                           |
| ----------------------------------------- | ------------------------------- | ---- | ----------------------------------------- |
| Source-adjacent test plus committed test  | `npm test -- --run`             | 0    | 2 files and 2 tests passed.               |
| Invalid assignment in source              | `npm run check`                 | 1    | TS2322 names `src/toolchain-probe.ts`.    |
| Invalid assignment under tests            | `npm run check`                 | 1    | TS2322 names `tests/toolchain-probe.ts`.  |
| Implicit-any source parameter             | `npm run check`                 | 1    | TS7006 rejects the untyped parameter.     |
| Deliberately failed test assertion        | `npm test -- --run`             | 1    | 1 failed and 1 passed file/test.          |
| Inverted Node-environment smoke assertion | `npm test -- --run`             | 1    | The committed smoke test failed.          |
| Committed test temporarily removed        | `npm test -- --run`             | 1    | No test files found; no no-tests bypass.  |
| Effective compiler options                | `npm run check -- --showConfig` | 0    | `strict` and `noEmit` are enabled.        |
| Compiler file inventory                   | `npm run check -- --listFiles`  | 0    | Includes smoke test and `vite.config.ts`. |

The source-discovery probe was `src/toolchain-probe.test.ts`:

```ts
import { expect, test } from 'vite-plus/test';
test('discovers a source-adjacent TypeScript test', () => {
  expect(process.versions.node.split('.')[0]).toBe('24');
});
```

The same invalid assignment was used independently in
`src/toolchain-probe.ts` and `tests/toolchain-probe.ts`:

```ts
export const value: string = 1;
```

The strictness probe used `src/toolchain-probe.ts`:

```ts
export function identity(value) {
  return value;
}
```

The failed-assertion probe was `tests/toolchain-probe.test.ts`:

```ts
import { expect, test } from 'vite-plus/test';
test('rejects a failed assertion', () => {
  expect(1).toBe(2);
});
```

For the smoke-test mutation, `.not.toHaveProperty('document')` was replaced
with `.toHaveProperty('document')`; the test failed, then its original bytes
were restored. The empty-suite check temporarily removed that test and also
restored its original bytes. The probe snippets above preserve their content
with expanded line breaks for readability.

After restoring the exact committed files, `npm run lint`,
`npm run format:check`, `npm run check`, and `npm test -- --run` all exited 0.
The restored suite again passed one file and one test.
`git status --short --untracked-files=all` exited 0 with no output. The
lockfile digest was unchanged. A file inventory outside dependencies and Git
metadata found no emitted JavaScript, JavaScript maps, declarations, or
TypeScript incremental state. All probes were removed.

## Compiler Configuration Adjustment

The initial `lib: [ES2023]` configuration failed with TS2304 diagnostics for
DOM types referenced by the installed Vite+/Vitest and tinybench declarations.
Vite+'s `defineConfig` export imports Vitest configuration types, including
browser declarations. Adding `DOM` to the declaration libraries resolved
those diagnostics without disabling strict checks or adding `skipLibCheck`.
TypeScript's [library documentation](https://www.typescriptlang.org/tsconfig/lib.html)
describes these declaration sets. Tests still run with `environment: node`,
and the smoke test verifies that `document` is absent at runtime. No browser
runner or browser runtime was added.

Before adding the scripts, `npm test -- --run` and `npm run check` each
returned 1 because the requested script was missing. After configuration and
the declaration-library adjustment, both commands passed; final verification
above ran against the committed implementation rather than those preliminary
working changes.

## B3 Handoff and Limits

B3 can enforce the verified `npm ci`, `npm run lint`,
`npm run format:check`, `npm run check`, and `npm test -- --run` sequence in
CI and update contributor instructions. Its workflow assertions and observed
CI run remain separate verification. B2 did not change CI, consumer workflows,
reviewer source, or baseline evidence. The old reviewer remains active.

No action build command exists yet, so no action packaging or bundle check
was run. This record's documentation is added after the validated
implementation revision; documentation checks on it are separate from the
clean-checkout toolchain results above.

The documentation-only record, specification, and checkpoint changes were
checked against `8a68a56fcb5506664eb102337caeb2eedd06cbfe` plus those working
edits with `npm run lint:md`, `npm run format:check`, `git diff --check`, and
`git diff --cached --check`; each exited 0. Edited local links were checked
and the public working and staged diffs were inspected for restricted details.
