# Spec: Adopt the Shared Reviewer in This Repository (R1)

Status: approved for planning, 2026-11-11; the user approved the plan
(`tasks/plan.md`, tasks #283–#289, gate #282) the same day, after a
fresh-context Opus review. Execution approval is a separate gate.
Supporting consumer record for
[#27](https://github.com/andrewpucci/dependency-update-advisor/issues/27) under
`repo-adoption` in [the capability map](README.md). It applies
[SPEC-repo-adoption.md](SPEC-repo-adoption.md) to this repository as the first
of four consumers and adds no shared-contract change.

## Objective

Make `andrewpucci/dependency-update-advisor` call its own pinned shared
reviewer, and prove that it analyzes the current Dependabot PR head, publishes
the advisory `dependabot-review` status, and manages only its own comment. This
repository has no previous reviewer, so rollback is reverting the caller and
config commits. The separate parity and cutover gate is not part of R1.

The repository is public, so sanitized adoption evidence lives in the R1 issue
and PR. Secrets, raw model payloads, and unsanitized fixtures stay out.

## Tech Stack

Unchanged from [SPEC-repo-adoption.md](SPEC-repo-adoption.md): a `workflow_run`
caller, the SHA-pinned `workflow_call` target in
`.github/workflows/dependabot-review.yml`, trusted default-branch
`.github/dependabot-review.json`, three named secrets, and a repository-scoped
GitHub App token.

## Decisions (confirmed 2026-11-11)

- Provider `mistral`, model `mistral-large-latest`.
- `sendSourceExcerptsToModel: false`. No source lines are sent; the excerpt
  disclosure review is recorded as not applicable. Enabling excerpts later is an
  Ask-first change that reopens that review.
- No `policy` section: shared default verdict rules apply, recorded as the
  explicit policy choice. `context.sourceRoots` stays `["src"]`.
- The Dependabot schedule and ecosystems already in `.github/dependabot.yml`
  are retained: npm and GitHub Actions, both at `/`, weekly on Tuesday at 09:00
  America/Los_Angeles. R1 reviews and records the rationale and changes no value.

## Assumptions to verify during inventory

1. The caller triggers on `workflow_run` for the workflow named `CI` and passes
   the literal `ci_workflow: .github/workflows/ci.yml`.
2. The caller references the shared workflow by full commit SHA from this
   repository's `main`: first a commit that includes the merged W2 no-write
   rehearsal (user decision 2026-11-11: the caller merges before live
   publication exists), re-pinned to the publication commit for the live trial.
   A moving ref is never used.
3. Secrets are exactly `llm_api_key`, `review_app_client_id`, and
   `review_app_private_key`, with no `secrets: inherit`. The App is installed on
   this repository only, with issues and statuses write access.
4. Branch rules, comment ownership, and the App identity are unrecorded and are
   inventoried from live GitHub state, not assumed. The caller filename is
   `.github/workflows/dependabot-review-caller.yml`; its first no-write pin is
   `8493d18e987a94dc263e47f6ef9d1452bf9cec82`, the passing `main` revision that
   contains merged W2 rehearsal code.

## Commands

Run against the exact caller and config revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run build
git diff --exit-code
```

`ci.yml` runs this sequence plus a check that the build leaves no untracked or
ignored output. The no-write rehearsal command comes from the
W2 interface (merged in
[PR #257](https://github.com/andrewpucci/dependency-update-advisor/pull/257))
and is confirmed against that code during planning, not assumed here.

## Project Structure

```text
.github/dependabot.yml                    → reviewed, unchanged
.github/dependabot-review.json            → new trusted config (decisions above)
.github/workflows/dependabot-review-caller.yml → new workflow_run caller
tests/adoption/                           → caller and config contract fixtures
docs/specs/SPEC-adoption-self.md          → this spec
```

The caller's filename may not equal the reusable workflow's
(`dependabot-review.yml`); planning picks the final name.

## Code Style

Keep the caller declarative: full-SHA `uses`, explicit minimum `permissions`,
three mapped secrets, no checkout, artifact, or cache, and no expression in
`ci_workflow`.

```json
{
  "version": 1,
  "analysis": { "provider": "mistral", "model": "mistral-large-latest" },
  "context": { "sourceRoots": ["src"], "sendSourceExcerptsToModel": false }
}
```

## Testing Strategy

- Contract tests in `tests/adoption/` fail on a moving ref, `secrets: inherit`,
  extra write permissions, a PR checkout or execution step, an artifact or cache
  step, an expression-valued `ci_workflow`, a missing config, or a config that
  does not validate against `schemas/review-config-v1.json`. Each test must be
  shown failing on a named mutation of the caller or config.
- Verify reusable-workflow and bundled-action resolution at the pinned SHA.
- No-write rehearsal on a representative current-head Dependabot PR, then a
  controlled PR trial covering the three live cases below. The live trial
  depends on live publication and a production claim backend; W2 #26 merged
  only the no-write rehearsal, so those remain separate gates.

## Boundaries

- **Always:** pin the full SHA, keep minimum permissions, write only to the
  current head, preserve the older comment on failure, and keep the old-reviewer
  question out of R1.
- **Ask first:** change the Dependabot schedule, add a provider or secret,
  enable excerpts, or make `dependabot-review` required.
- **Never:** commit secrets or raw model payloads, inherit secrets, execute PR
  code with credentials, or claim a live result that did not run.

## Success Criteria

1. `.github/dependabot-review.json` is merged on `main` with the decisions above
   and validates against the schema.
2. The caller is merged with a full-SHA pin and `ci.yml` identity, and the
   contract tests reject each named mutation.
3. A controlled PR shows a successful current-head status plus a managed
   comment; an invalid-config run shows a failed status with the older comment
   preserved; a stale run is rejected without writing.
4. The R1 issue records shared and consumer revisions, exact commands, observed
   head and status, the no-excerpt choice, the no-write findings, and a
   revert-based rollback. `dependabot-review` stays advisory.
5. Reusable-workflow and bundled-action resolution, App permissions, and a
   controlled current-head trial pass before the next adopter starts.

## Open Questions

- W2 #26 is merged (2026-11-10) as a no-write rehearsal. Resolved 2026-11-11:
  the caller merges as a no-write rehearsal before live publication and the
  production claim backend land; those gates (G1) block only the live trial.
  [#282](https://github.com/andrewpucci/dependency-update-advisor/issues/282)
  tracks G1's review-publication specification and production claim backend.
- Resolved 2026-11-11: the invalid-config proof uses a temporary invalid config
  on `main`, then a revert. `main` CI is knowingly red for that window.
- Final caller filename and the App's name and installation.
