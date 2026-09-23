# Repository agent instructions

This file is project-specific and applies to work in
`dependency-update-advisor`. Read [CONTEXT.md](CONTEXT.md), the
[capability map](CAPABILITY-MAP-shared-dependabot-review.md), the relevant
module spec, and `git status` before changing files. Treat a draft as a draft;
conversation history alone is not approval.

## Current phase

The seven-module map and the copied module specs await human review. There is
no reviewer implementation, package manifest, workflow, or release yet. The
next task is to review the map and resolve its module boundaries, then finish
and review the missing specs. Do not treat the example commands in draft specs
as executable in this checkout until the corresponding tooling exists.

## Sources of truth

- The capability map indexes modules and their approval state.
- Each `SPEC-*.md` records a module or cross-cutting contract. Record explicit
  approval in the file before planning or implementing that scope.
- `CONTEXT.md` records current project state and the next handoff; keep it
  current when a phase completes.
- Approved architectural decisions belong in `docs/adr/` when they need a
  durable explanation of why. Create an ADR when a decision is made; do not
  prefill placeholder decisions.
- Use GitHub Issues for individual implementation tasks. If an approved plan
  needs an ordered working handoff, use `tasks/plan.md` on the working branch
  and link its issues. The plan need not remain after the work is complete.

## Boundaries

- This repository is public. Do not commit private consumer PR links, exact
  source paths, excerpt allowlists, credentials, raw model payloads, or
  unsanitized fixtures. Keep those records in their consumer repositories.
- Keep each consumer's `dependabot.yml`, provider secret, excerpt choice, and
  review policy local. The shared repository defines only the schema and
  reviewer behavior.
- Preserve fail-secure coverage and the trusted-workflow boundary defined in
  the specs. Keep the old reviewer active until parity and cutover gates pass.
- Do not copy personal machine instructions or the full upstream
  `agent-skills` package into this repository. Use installed skills as a
  process; store project decisions and evidence here.
- Do not invent quality thresholds, approval, or completed verification.
  Report exactly which commands ran and against which revision.

## Verification

For documentation changes, run `git diff --check` and inspect the staged diff
for private consumer details before publishing. Once code exists, run the
commands documented in the repository and relevant spec before committing.
