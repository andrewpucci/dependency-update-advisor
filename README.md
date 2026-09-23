# Dependency Update Advisor

Dependency Update Advisor is a planned reusable, advisory reviewer for
Dependabot pull requests on GitHub. It will explain what changed, surface
security and compatibility evidence, show what remains unknown, and give a
maintainer a concrete next action. Each consumer keeps its own review policy
and context configuration.

**Status:** Design draft. This repository has no runnable reviewer or published
workflow yet. Do not point consumer repositories at it until implementation,
parity checks, and the staged cutover are complete.

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
[capability map](CAPABILITY-MAP-shared-dependabot-review.md). The map indexes
the draft module specs and identifies the three still to be written.
[Comment experience](SPEC-comment-experience.md) defines the reader-facing
review brief. These files are working specifications; their status lines show
what still needs approval.

The existing reviewer in
[`andrewpucci.com`](https://github.com/andrewpucci/andrewpucci.com) is the
behavioral baseline. It stays active until the shared implementation has
passed the documented parity and cutover gates.

## Working on this project

Read [AGENTS.md](AGENTS.md) for repository rules and the next handoff. No
package manager commands are available in this repository yet. Add build,
lint, test, and release commands with the first implementation slice, then
update this README and the specs to match.
