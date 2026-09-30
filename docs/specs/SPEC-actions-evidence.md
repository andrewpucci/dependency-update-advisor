# Spec: GitHub Actions Dependency Evidence

Status: approved for planning, 2026-09-23. Module: `actions-evidence` in
[the capability map](README.md).

## Objective

Account for GitHub Actions and reusable-workflow references changed by a
Dependabot PR, even when GitHub's dependency comparison omits an Actions
entry. Give the maintainer the exact workflow location, old and new refs,
attributable security and upstream evidence, and an honest coverage result.
An Actions gap must remain visible in a PR that also changes npm packages.

The public pilot's [PR #302](https://github.com/andrewpucci/andrewpucci.com/pull/302)
had an Actions update visible in the workflow diff and Dependabot text but
absent from the dependency comparison. This is a required regression case.

## Tech Stack

The collector uses Node.js 24 ESM with strict TypeScript source and bounded
GitHub REST reads of the PR file list and immutable base/head workflow blobs
(`.github/workflows/*.yml` and `*.yaml`). It uses a validated YAML reader and
the shared review-input and coverage schemas. GitHub documents both step- and
job-level [`uses:` references](https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems).
The [dependency comparison API](https://docs.github.com/en/rest/dependency-graph/dependency-review)
and [global advisories API](https://docs.github.com/en/rest/security-advisories/global-advisories)
may supplement the inventory and security evidence; neither replaces the
immutable workflow comparison.

## Commands

After implementation, this repository must provide:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
npm run build
```

Until extraction, use the source repository's workflow-input tests as a
comparison baseline after checking its current runner and revision.

## Project Structure

```text
shared repo: src/evidence/actions.ts      → workflow-reference inventory
shared repo: src/evidence/actions.test.ts  → workflow, ref, and API fixtures
shared repo: src/evidence/advisories.ts   → bounded shared advisory lookup
consumer: .github/workflows/*.yml|*.yaml  → immutable workflow references
```

## Code Style and Evidence Contract

Represent each occurrence by workflow path and job or step location, plus
the external action or reusable-workflow identity. Keep `fromRef` and
`toRef` as exact strings. A tag, branch, and commit SHA are distinct ref
kinds; do not invent a version for a SHA or assume a moved tag is immutable.
Use `update`, `addition`, and `removal` explicitly. Every result carries
source path, ecosystem `actions`, evidence provenance, and `complete`,
`partial`, or `unavailable` coverage with bounded reasons.

```ts
if (oldRef === null) return { kind: 'addition', fromRef: null, toRef: newRef };
```

## Requirements

1. Paginate the full PR file list and select changed workflow files,
   including adds, removals, and renames. GitHub's
   [list-files endpoint](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)
   has a 3,000-file cap; hitting it or losing a page is incomplete coverage.
   Read bounded complete blobs at the verified base and head SHAs instead of
   relying on possibly truncated diff patches.
2. Parse workflow YAML as untrusted data without running expressions or
   actions. Inventory external `jobs[*].steps[*].uses` actions and
   `jobs[*].uses` reusable workflows, including repository subpaths. Ignore
   unchanged local `./` references as dependencies; a changed reference
   whose identity or ref cannot be interpreted stays an explicit coverage
   issue rather than disappearing.
3. Compare occurrences across the two immutable versions. Keep distinct
   workflows and locations when the same action appears more than once.
   Account for changed refs, changed action identities, additions, and
   removals. Reordering or renaming that prevents reliable pairing must be
   reported without claiming a verified version update.
4. Reconcile workflow findings with GitHub's dependency comparison and
   Dependabot's PR body as untrusted corroboration. Preserve a workflow
   change even when either source omits it. An empty comparison, endpoint
   403, or rate limit cannot establish complete Actions coverage by itself.
5. For a changed action, retain the exact old and new tag, branch, or SHA.
   Resolve a release or comparison range only when the ref-to-version
   relationship is attributable. Otherwise provide the available repository
   and change links with explicit uncertainty; never turn a changed SHA into
   an invented semantic version.
6. Carry exact applicable comparison advisories. For a resolvable proposed
   action version, a bounded `actions` ecosystem advisory lookup may fill a
   comparison gap. For a SHA or floating ref that cannot be matched safely to
   an affected version, state that vulnerability applicability is unknown.
   An unavailable lookup never means zero vulnerabilities. GitHub notes
   [SHA-pinned actions do not receive Dependabot alerts](https://docs.github.com/en/actions/reference/security/secure-use),
   so an alert's absence is not proof of safety.
7. Keep source URLs, titles, applicable ranges, and fallback outcomes with
   upstream evidence. Bound requests, bodies, and excerpts. Do not fetch
   and execute external action code or send workflow contents to a model as
   instructions.
8. Return each identifiable Actions change and its own coverage result to
   the shared reviewer. In a mixed PR, npm completeness cannot hide an
   Actions omission; the shared reviewer combines the separate results.

## Testing Strategy

Use synthetic workflow files and mocked GitHub and advisory responses.
Cover step actions, job-level reusable workflows, nested action paths,
duplicate occurrences, tag changes, SHA changes, additions, removals,
workflow renames, local references, malformed YAML, unsupported or dynamic
refs, truncated blobs, file pagination cap, empty comparison, endpoint and
rate-limit 403s, applicable advisory, unknown advisory applicability, and
a mixed npm/Actions PR. Add a sanitized PR #302 scenario in which the
workflow comparison finds the omitted action. Assert each changed external
reference is assessed or visibly unresolved exactly once.

## Boundaries

- **Always:** Use immutable workflow files, preserve exact ref strings and
  locations, and report unknown applicability or coverage explicitly.
- **Ask first:** Expand to other workflow directories or YAML constructs,
  add a parser or evidence provider, or claim security coverage for SHA refs.
- **Never:** Execute PR or external action code, infer a version from an
  unattributed SHA, or treat comparison absence as an empty inventory.

## Success Criteria

1. The PR #302 fixture reports the omitted Actions update with its workflow
   location and source even when the comparison result is empty.
2. Each changed external `uses:` occurrence is represented once as an update,
   addition, removal, or unresolved pairing.
3. Missing workflow data or uncertain ref and advisory mapping yields
   visible incomplete coverage, never an unqualified zero-change review.
4. A mixed PR preserves separate npm and Actions coverage and cannot hide
   an Actions gap behind a complete npm result.

## Open Questions

None for v1 behavior. The bounded YAML reader is chosen during planning and
must pass the malformed and unsupported-input fixtures before adoption.
