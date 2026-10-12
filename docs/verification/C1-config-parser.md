# C1 trusted configuration parser verification

C1's local implementation passes the required checks at
`4971cec2d979fef0223391c619bd31356eda5add`, verified on 2026-10-11.
The [C1 spec](../specs/SPEC-config-parser.md) and
[parent issue #5](https://github.com/andrewpucci/dependency-update-advisor/issues/5)
define the scope. This is parser/schema evidence, not reviewer parity or
authorization to transmit excerpts. Publication and CI verification remain
pending; no PR or tested CI merge SHA is claimed.

## Revision and environment

Validation used a fresh detached worktree at the full implementation SHA,
without preinstalled dependencies. The current working branch remained
`issue-5`. Tracked files were unchanged after installation and validation.
This evidence-only commit follows the tested code revision.

| Component     | Observed version |
| ------------- | ---------------- |
| Node.js       | `v24.13.0`       |
| npm           | `11.19.0`        |
| TypeScript    | `7.0.2`          |
| Vite+         | `1.0.0`          |
| Vitest        | `5.0.1`          |
| Ajv, dev-only | `8.20.0`         |

The new lockfile entries are Ajv and its four dev-only dependencies:
`fast-deep-equal` 3.1.3, `fast-uri` 3.1.8, `json-schema-traverse` 1.0.0,
and `require-from-string` 2.0.2. Their installed manifests contain no
`preinstall`, `install`, `postinstall`, or `prepare` scripts. Existing tool
pins were preserved. Runtime configuration code imports only Node built-ins.

## Clean-checkout command results

The detached checkout was created with:

```sh
git worktree add --detach .context/c1-validation-4971cec 4971cec2d979fef0223391c619bd31356eda5add
```

The following commands ran inside that checkout, in this order:

| Command                  | Exit | Observed result                                                 |
| ------------------------ | ---- | --------------------------------------------------------------- |
| `git rev-parse HEAD`     | 0    | Exact implementation SHA above                                  |
| `git status --porcelain` | 0    | Empty before installation                                       |
| `node --version`         | 0    | `v24.13.0`                                                      |
| `npm --version`          | 0    | `11.19.0`                                                       |
| `npm ci`                 | 0    | 184 packages added; 185 audited; warnings below                 |
| `npm run lint`           | 0    | Code lint passed; Markdown lint checked 28 files with no issues |
| `npm run format:check`   | 0    | All 38 matched files passed                                     |
| `npm run check`          | 0    | Strict no-emit compiler check passed                            |
| `npm test -- --run`      | 0    | 3 test files; 237 tests passed                                  |
| `git diff --check`       | 0    | No whitespace errors                                            |
| `git diff --exit-code`   | 0    | Tracked files unchanged                                         |
| `git status --porcelain` | 0    | Empty after validation                                          |

The test total includes 232 config tests in `src/config.test.ts` and five
existing tests across `tests/toolchain.test.ts` and `tests/ci-workflow.test.ts`.
There is no build script yet; action packaging remains A1. No build command
was run or inferred from type checking.

## Contract coverage

| C1 criterion                 | Evidence                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure missing-file defaults | Missing `.github` directory and missing config within a valid parent return no analysis, excerpt opt-out, default roots, empty excerpt files, and all five verdict defaults                         |
| Invalid present files fail   | Malformed JSON/UTF-8, invalid roots/parents, directory targets, read/stat/close errors, dangling/looping/escaping links, and nonregular descriptors yield errors without usable config              |
| JSON Schema/parser agreement | Independent Ajv validation and parser outcomes match explicitly expected fixtures for types, required version, every object level's unknown keys, prototype-like names, fields, rules, and verdicts |
| Bounds and exact syntax      | 16,384/16,385 bytes including multibyte UTF-8; 16/17 roots; 128/129 excerpt files; duplicates; 1/128/129-character model IDs; whitespace/newline/URL rejection; POSIX/Windows path and glob cases   |
| Explicit choices survive     | Empty arrays, opt-out, provider/model, all named rule values, equal-to-default overrides, independent defaults, and override provenance remain intact                                               |
| Safe diagnostics             | Unknown keys identify only a known parent; malformed sensitive-looking input and filesystem errors return fixed filename/category/field metadata without raw values or OS messages                  |
| Bounded loading and cleanup  | Short reads continue to EOF; overflow reads stop at the detection byte; handles close on success, read/stat/encoding/JSON/size failure, and nonregular-descriptor refusal                           |
| Trusted checkout handoff     | Only the supplied checkout supplies configuration; contained config links work and escaped/dangling links fail; workflow verification of checkout trust remains outside C1                          |

The schema describes document validation, not raw byte limits, filesystem
state, repository visibility, or credential availability. Its defaults are
annotations checked against runtime defaults; Ajv does not coerce or repair
fixtures. Runtime parsing is independent of Ajv.

## Regression sensitivity probes

After clean-checkout validation, two temporary mutations were applied only
in the detached validation worktree. Each ran:

```sh
npm test -- --run src/config.test.ts
```

| Temporary mutation                                      | Exit | Result                                                                                   |
| ------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| Set schema top-level `additionalProperties` to `true`   | 1    | 5 failed; 227 passed; unknown-field agreement assertions detected schema drift           |
| Change runtime `MAX_CONFIG_BYTES` from 16,384 to 16,385 | 1    | 5 failed; 227 passed; byte-boundary and read-budget assertions detected permissive drift |
| Restore both original files and rerun focused tests     | 0    | All 232 config tests passed                                                              |
| `git diff --exit-code` after restoration                | 0    | No tracked difference                                                                    |
| `git status --porcelain` after restoration              | 0    | Empty                                                                                    |

Neither mutation is committed. Local probe logs remain under `.context/`.

## Development checks and corrected failures

- C1.1's first focused run exited 1 because `src/config.ts` did not exist.
  The implemented document path then passed 24 focused tests and the full
  repository sequence with 29 tests before commit
  `af5bbdcb0039737cb380d1a32a0e3fd351aadf0e`.
- An initial lint run exited 1 on a control-character regex and an unnecessary
  regex escape. The parser now checks control character codes directly and
  uses a valid glob-character pattern. No lint rule was disabled.
- C1.2's first focused run failed 10 loader tests because the loader did not
  exist. The implemented loader passed those tests. A short-read mock then
  failed strict checking because Node's `read` overload selection did not
  match its positional callback. Using the options form in code and test
  corrected the typing without a suppression. The full sequence passed
  45 tests before commit `404ea1f546df55876e33c8f90cc5fb28bf2ca98f`.
- C1.3's conformance additions passed the existing implementation without a
  behavior change. The full sequence passed 237 tests before commit
  `4971cec2d979fef0223391c619bd31356eda5add`; the isolated probes above
  separately establish regression sensitivity.

## Installation and audit warnings

`npm ci` reported 10 vulnerabilities: three low, one moderate, and six high.
It also warned that existing `fsevents@2.3.3` install scripts were not covered
by `allowScripts`. No new install script was approved, and no forced upgrade
was applied.

`npm audit --json` at the implementation lockfile exited 1. A separate audit
of the baseline manifest/lockfile at
`f81f2372894c9fe74a3ee2a7dd49d09a7f2cda05`, using
`npm audit --json --package-lock-only`, also exited 1. Counts and the complete
reported vulnerability details matched. None of the five added dev packages
was named in the audit findings. The existing
[tooling advisory issue #33](https://github.com/andrewpucci/dependency-update-advisor/issues/33)
tracks the braces finding; this record does not claim remediation of the
remaining baseline advisories or a clean dependency audit.

## Review and next handoff

A local review inspected the parser, schema, tests, dependency/lockfile diff,
and C1 contract for correctness, readability, architecture, security, and
bounded work. No blocking C1 defect was found. Fixtures are synthetic; no
private consumer settings, credentials, payloads, or paths were introduced.
This is a local implementation review, not a submitted GitHub PR approval.

C2 must validate source-file containment, shared exclusions, credential-like
paths/content, private opt-in metadata, and eligibility before collecting or
sending excerpts. C3 must apply effective rules with finding precedence and
preserve coverage and execution state. Workflow integration must verify the
trusted checkout and current PR head, validate credentials, stop on config
failure, preserve the existing comment, and publish the appropriate status.
C1's loader assumes the supplied trusted checkout stays unchanged during
loading; it does not attest to that trust or protect a concurrently replaced
checkout. These integration, disclosure, and policy behaviors were not tested
or claimed by C1.

## Review follow-up: nonempty context preservation

Review of `7055d85ecb91cfba52e0a04d29c251e9b36582c3` found that replacing
both returned context arrays with empty arrays still passed all 237 tests.
Commit `e14c649c35e9c3e619902ac9363764c87f041e81` adds one assertion that
nonempty, nondefault source roots and exact excerpt files survive parsing.
Runtime code and dependencies are unchanged.

The new test was copied into the isolated validation checkout. Discarding
only `sourceRoots`, then only `excerptFiles`, each made
`npm test -- --run src/config.test.ts` exit 1 with one failed and 232 passed
tests. Both probes were restored; `git diff --exit-code` confirmed the
isolated checkout was unchanged. The normal focused run passed all 233
config tests.

The precommit working tree based on `7055d85`, containing only the new test
and committed unchanged as `e14c649`, passed `npm run lint`,
`npm run format:check`, `npm run check`, `npm test -- --run` (three files,
238 tests), and `git diff --check`. This follow-up closes the reported
coverage gap; the original clean-checkout results above retain their original
revision and counts. No new installation, build, or CI result is claimed.
