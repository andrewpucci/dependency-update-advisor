# ADR 0003: Derive dependency inventory from immutable files

Status: accepted, 2026-09-29.

## Context and Problem Statement

The reviewer must account for npm, GitHub Actions, and uv changes, including
additions, removals, and grouped updates. A missing dependency in the inventory
can produce an unjustified recommendation. GitHub's dependency comparison
may omit a changed dependency or be empty or unavailable while the changed
files remain readable. The [capability map](../specs/README.md#evidence-that-the-implementation-must-cover)
records the pilot cases behind this requirement.

## Considered Options

- Derive the inventory from the PR's immutable base and head manifests,
  lockfiles, and workflow files; use the dependency comparison and Dependabot
  text to corroborate findings and supply applicable evidence.
- Use GitHub's dependency comparison as the inventory and inspect changed
  files only when that response reports a gap or error. An apparently complete
  response cannot reveal an omitted change.

## Decision Outcome

Chosen option: immutable base and head files establish the change inventory.
Each ecosystem collector compares its relevant files at full commit SHAs and
reports its own completeness. GitHub's comparison and Dependabot text can add
evidence or reveal disagreement, but cannot erase a file-derived change or
prove zero changes when empty or unavailable. An unreadable or unsupported
file creates an explicit coverage gap rather than an empty inventory.

The [npm](../specs/SPEC-npm-evidence.md),
[Actions](../specs/SPEC-actions-evidence.md), and
[uv](../specs/SPEC-uv-evidence.md) specs define parsing, reconciliation, and
coverage behavior for each ecosystem.

### Consequences

Inventory remains attributable to the exact PR revisions and can expose
omissions in a secondary source. The repository must maintain bounded parsers
for the supported file formats and tests for additions, removals, omissions,
and malformed input. Unsupported formats and inaccessible files reduce
reported coverage; the reviewer cannot silently claim a complete review.
