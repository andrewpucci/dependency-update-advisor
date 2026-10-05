# Spec: Repository Check Enforcement in CI

Status: approved for B3 execution, 2026-10-04. Supporting contract for `shared-review`
in [the capability map](README.md), scoped to
[issue #4: B3](https://github.com/andrewpucci/dependency-update-advisor/issues/4).
Approval: the user requested as-plan on 2026-10-04, then as-build auto on
2026-10-04, approving this specification and its three-task implementation
plan for autonomous execution, including observed CI verification.
The approved [shared-review contract](SPEC-shared-review.md) and
[local-tooling contract](SPEC-local-tooling.md) remain authoritative.

## Objective

Give contributors and maintainers one executable validation sequence locally
and in repository CI. Every eligible pull request and push must run the
existing non-mutating lint, format, strict TypeScript, and test checks against
an identified revision. Documentation must describe the commands that exist
today and distinguish them from future action packaging.

B3 enforces B2's toolchain; it does not extract reviewer code or introduce
new tooling. A1 adds the action build and committed-bundle integrity gate
once the action entry point exists. The old reviewer remains active.

## Known Inputs and Assumptions

- The attachment and live issue #4 agree on scope and verification. GitHub
  marks [B2](https://github.com/andrewpucci/dependency-update-advisor/issues/3)
  completed. Its [verification record](../verification/B2-local-tooling.md)
  supplies the implemented command sequence and clean-checkout evidence.
- At drafting revision `e18f848b95ef5355dce3d41b4c8d7e873119b88c`, CI already
  installs dependencies and checks lint and formatting. Type checking and
  tests exist locally but are absent from CI. `README.md` and
  `CONTRIBUTING.md` still describe them as unavailable.
- Preserve the existing workflow identity, triggers, job name, runner,
  timeout, concurrency behavior, action pins, permissions, and cache policy.
  No repository ruleset change is needed to extend the existing check.
- Reviewed revision policy: preserve the event's default checkout. For a
  pull request, validate GitHub's generated merge commit; for a push, validate
  the pushed commit. Record the actual checkout SHA rather than describing
  a merge-commit run as a direct PR-head run. The user selected this policy
  on 2026-10-04; the specification and plan are approved for execution.

## Tech Stack

Use the existing GitHub Actions workflow and Node.js 24 within the declared
range `>=24.11.0 <25`. Keep the exact local development pins and lockfile:
Vite+ 1.0.0, TypeScript 7.0.2, Node types 24.19.1, and markdownlint-cli2 0.23.3.
Vite+ supplies the Node test runner. No new runtime or test dependency is
required by this scope.

Preserve full-SHA-pinned `actions/checkout` and `actions/setup-node`,
`persist-credentials: false`, and `package-manager-cache: false`. Record
the actual Node.js and npm versions because selecting major version 24 does
not identify a particular patch release.

## Commands

CI and full local validation must use this sequence, in order:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

`npm ci` installs the committed lockfile. The four validation commands do
not fix or rewrite tracked files: lint covers code and Markdown, format
checking uses `vp fmt --check`, type checking invokes
`tsc --project tsconfig.json --noEmit` with strict checking enabled, and tests
run through `vp test` with `--run` forwarded for finite execution. Existing
test discovery covers source-adjacent and `tests/` TypeScript tests in Node.

`npm run format` remains an explicit local editing command, never a CI
validation step. `npm run build` does not exist and must not be invoked or
documented as available by B3. Its future build and drift checks belong to A1.

For documentation-only edits to this specification, run:

```sh
npm run lint:md
npm run format:check
git diff --check
```

## Project Structure

```text
.github/workflows/ci.yml           → existing repository quality gate
package.json / package-lock.json   → existing scripts and pinned toolchain
tsconfig.json / vite.config.ts     → existing strict checking and Node tests
tests/*.test.ts                    → workflow contract assertions
README.md                         → concise current contributor commands
CONTRIBUTING.md                    → full checks and future A1 distinction
docs/specs/SPEC-ci-enforcement.md  → this B3 supporting contract
docs/specs/README.md               → spec index and approval state
docs/verification/                → revision-specific B3 evidence
CONTEXT.md                        → current checkpoint and next action
```

Keep B1 parity documents and B2 verification intact. Update the checkpoint
when B3's actual phase changes; planning does not establish execution results.

## Code Style and Workflow Contract

Extend the existing YAML style with named steps and explicit repository npm
commands. For example, the missing checks should read:

```yaml
- name: Type check
  run: npm run check
- name: Run tests
  run: npm test -- --run
```

Use the existing ESM TypeScript conventions and explicit imports from
`vite-plus/test` for workflow assertions. Test observable workflow behavior
without imposing unrelated formatting or adding a YAML dependency merely
to inspect this small workflow. Select the assertion mechanism in planning.

### Required behavior

1. Keep workflow name `CI`, job ID `quality`, and check name
   `Repository quality`. Run on pull requests targeting `main` and pushes
   to `main`, without new path filters or selective skips for the checks.
2. Run installation and each check as an explicit step in the same job,
   against the same checkout. A nonzero installation or check exit fails
   the job; do not mask failures with `continue-on-error`, shell fallbacks,
   or no-tests bypasses. Later checks may be skipped after a failure.
3. Preserve `ubuntu-latest`, the ten-minute job timeout, cancellation of
   superseded runs, and `contents: read` permissions. No provider secrets,
   review App credentials, privileged triggers, or cache sharing are added.
   This ordinary CI job may execute PR tests without reviewer credentials;
   the privileged review flow's trusted-code boundary remains separate.
4. Log `git rev-parse HEAD`, `node --version`, and `npm --version` before
   validation. The tested SHA must match the event checkout identity. Do
   not substitute a moving branch checkout or infer the tested revision
   solely from workflow-run metadata. GitHub documents the
   [default checkout ref](https://github.com/actions/checkout#usage) and
   [pull-request merge SHA](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).
5. Update `README.md` and `CONTRIBUTING.md` to explain the complete current
   command sequence, strict checking of source and tests, finite test mode,
   and the distinction between format checking and applying formatting.
   Preserve the documentation-only check sequence and describe the action
   build and bundle gate as A1 work. Keep the planned reviewer advisory.

## Testing Strategy

Add focused workflow contract assertions to the existing Node test suite.
They must detect an omitted type-check or test step, a wrong or mutating
validation command, wrong step ordering, and masked validation failures.
Also assert the preserved triggers, check identity, read-only permissions,
action pins, disabled persisted credentials and cache, and revision logging.
No coverage percentage or reviewer parity is claimed by these checks.

Run the complete command sequence from a clean checkout of the candidate
revision, without preinstalled dependencies or reliance on global tools.
Confirm checks leave tracked files unchanged. Review edited local links and
the public diff for restricted consumer details.

Static assertions and local checks alone do not complete B3. Observe a real
successful `CI` / `Repository quality` run containing all four checks.
Record its URL, run ID and attempt, event, actual checkout SHA, associated
PR head when applicable, Node.js/npm versions, step results, and test counts.
For a merge-commit run, identify both the tested merge SHA and PR head;
the workflow-run metadata's head SHA alone is insufficient.

Run the local sequence against the same tested SHA in a clean checkout and
record commands and exit codes. Preliminary checks at another candidate SHA
must be labeled separately. If another push or base update changes the tested
revision, evidence for the old revision cannot validate the new one.
Cancelled or skipped runs do not count as successful execution.

Store sanitized evidence in `docs/verification/B3-ci-enforcement.md`, including
warnings and any failures or unavailable checks. A missing observed CI run
is an incomplete verification item, not an inferred pass. B2's existing audit
deferral remains separate; B3 neither changes audit policy nor claims repair.

## Boundaries

- **Always:** Enforce the existing non-mutating commands, preserve check
  identity and the trusted-review boundary, identify the actual tested SHA,
  keep documentation accurate, and record local and observed CI evidence.
- **Ask first:** Change checkout policy from the reviewed choice, workflow
  identity or triggers, permissions, rulesets, toolchain pins, dependency or
  cache policy, quality thresholds, or the scope of action packaging.
- **Never:** Publish private consumer details or credentials, give PR tests
  reviewer secrets, auto-fix files to claim a passing check, suppress failures,
  accept an empty test suite, invent CI evidence, or retire the old reviewer.

## Success Criteria

1. CI executes `npm ci`, `npm run lint`, `npm run format:check`,
   `npm run check`, and `npm test -- --run` in order on eligible events;
   a failing command prevents a successful quality job.
2. Workflow assertions pass and detect missing or weakened gates. Existing
   CI identity and security settings remain intact.
3. README and contributor instructions agree with available scripts and CI.
   Action build and committed-bundle integrity enforcement remain A1 work.
4. A clean local run and an observed successful CI run validate the same
   explicitly recorded checkout SHA. The evidence identifies commands,
   environment, outcomes, and run details without claiming reviewer parity.

## Open Questions

None. The reviewed checkout policy retains merge-commit validation for
integration testing with `main`. The implementation plan is approved for
autonomous execution.
