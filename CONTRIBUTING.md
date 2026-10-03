# Contributing to Dependency Update Advisor

This repository is public and currently contains specifications, not a runnable
reviewer. Start with [CONTEXT.md](CONTEXT.md), the
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

Node.js 24, pinned Vite+, and markdownlint-cli2 provide the current checks.
`npm run lint` runs code and Markdown linting:

```sh
npm ci
npm run lint
npm run format:check
```

Oxfmt formats Markdown syntax through `npm run format` and preserves prose
line breaks. markdownlint-cli2 checks structure, links, and prose length but
does not fix files; its line-length rule excludes tables and code blocks.
The foundation slice will add strict TypeScript checking and tests; action
packaging will add the build script. The expected sequence after those slices
is:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run build
```

The `check`, `test`, and `build` commands are not available in this repository
yet. `npm run check` must include strict TypeScript compiler checking of source
and tests. Once the action exists, `npm run build` must reproduce its committed
JavaScript bundle, and CI must check that bundle for drift. Run the focused
tests and other checks named by the relevant approved spec. CI should run the
same checks before a change is merged.

Confirm the documented commands as the foundation and action packaging work
lands.
