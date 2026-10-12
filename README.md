# Dependency Update Advisor

Dependency Update Advisor is a planned reusable, advisory reviewer for
Dependabot pull requests on GitHub. It will explain what changed, surface
security and compatibility evidence, show what remains unknown, and give a
maintainer a concrete next action. Each consumer keeps its own review policy
and context configuration.

**Status:** Foundation tooling is available; the module specs are approved
for planning. This repository has no runnable shared reviewer or published
reusable review workflow. Do not point consumer repositories at it until
implementation, parity checks, and the staged cutover are complete.

The [C1 config parser](src/config.ts) and [v1 schema](schemas/review-config-v1.json)
are implemented and [locally verified](docs/verification/C1-config-parser.md).

## V1 scope

- A SHA-pinned reusable GitHub Actions workflow and reviewer action.
- npm, GitHub Actions, and uv dependency updates opened by Dependabot.
- Repository-local JSON configuration for provider, source-excerpt, and
  advisory policy choices. Mistral is the only tested provider planned for v1.
- A managed PR comment and a separate current-head execution status. Both are
  advisory; the status is not a required branch check in v1.
- Explicit incomplete coverage when evidence is unavailable. The privileged
  workflow does not execute pull-request code or consume untrusted artifacts
  or caches.

Other update bots and code hosts are possible later additions, not v1 scope.

## Design documents

Start with [project context](CONTEXT.md) and the
[capability map](docs/specs/README.md). The map indexes the eight approved
module specs and supporting contract in `docs/specs/`.
[Comment experience](docs/specs/SPEC-comment-experience.md) defines the
reader-facing review brief.

The existing reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com) is the
behavioral baseline. It stays active until the shared implementation has
passed the documented parity and cutover gates.

## Working on this project

Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution practices and
[AGENTS.md](AGENTS.md) for agent-specific rules. With Node.js 24
(`>=24.11.0 <25`), run the same sequence as repository CI:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

These commands install the pinned toolchain, lint code and Markdown, check
formatting, strictly type-check TypeScript source and tests without emitting
files, and run Node tests once. Use `npm run lint:md` for Markdown alone.
`npm run format:check` checks Markdown, config, and code without changing
files; use `npm run format` to apply formatting locally.

The action build and committed-bundle integrity gate arrive with A1 once an
action entry point exists. No build command is available yet.

Oxfmt formats Markdown syntax while preserving prose line breaks.
markdownlint-cli2 checks document structure, links, image alt text, code-fence
labels, and prose length without changing files.
