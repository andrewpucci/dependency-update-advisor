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

With Node.js 24 (`>=24.11.0 <25`), run the full local and CI sequence using
the pinned repository toolchain:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

`npm ci` installs the committed lockfile. `npm run lint` runs code and
Markdown linting. `npm run format:check` checks formatting without changing
files. `npm run check` invokes the strict TypeScript compiler with `noEmit`
over source, tests, and tool configuration. `npm test -- --run` executes
the Node test suite once through Vite+; `--run` avoids watch mode. These
four validation commands do not repair or rewrite tracked files.

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
syntax and preserves prose line breaks. markdownlint-cli2 checks structure,
links, and prose length without fixing files; its line-length rule excludes
tables and code blocks.

No build command is available yet. A1 adds `npm run build` once the action
entry point exists, along with CI enforcement that a fresh build reproduces
the committed JavaScript bundle without drift. Until then, run the focused
tests and other checks named by the relevant approved spec, without invoking
an unavailable build command.
