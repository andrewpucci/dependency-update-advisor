# Repository agent instructions

This file is project-specific and applies to work in
`dependency-update-advisor`. Read [CONTEXT.md](CONTEXT.md), the
[capability map](docs/specs/README.md), the relevant module spec, and
`git status` before changing files. Treat a draft as a draft;
conversation history alone is not approval.

## Current phase

See [CONTEXT.md](CONTEXT.md) for the current checkpoint. Do not treat example
commands in draft specs as executable until the corresponding tooling exists.

## Sources of truth

- The [capability map](docs/specs/README.md) indexes modules and their approval
  state. Keep the map and module specs together in `docs/specs/` when applying
  a spec-driven workflow.
- Each `docs/specs/SPEC-*.md` records a module or cross-cutting contract. Index
  new specs in the map and record explicit approval in the file before planning
  or implementing that scope.
- `CONTEXT.md` is a one-screen orientation index (aim for 40 lines or fewer).
  Replace stale status when a phase changes. Link to specs, ADRs, and issues
  instead of copying decisions or appending session logs.
- Approved architectural decisions belong in `docs/adr/` when they need a
  durable explanation of why. Follow the [ADR guide](docs/adr/README.md):
  create a record when a specific decision is ready, not as a placeholder.
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

For documentation changes, run `npm run lint:md`, `npm run format:check`, and
`git diff --check`; inspect the staged diff for private consumer details
before publishing. Once code exists, run the commands documented in the
repository and relevant spec before committing.
