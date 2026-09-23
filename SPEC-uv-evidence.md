# Spec: uv Dependency Evidence

Status: draft for human review. Module: `uv-evidence` in
`CAPABILITY-MAP-shared-dependabot-review.md`.

## Objective

Give uv-based Python Dependabot PRs the same attributable, fail-secure
update inventory expected of npm reviews while retaining `pyproject.toml`,
`uv.lock`, and the `uv` Dependabot ecosystem. Identify direct and transitive
version changes, additions, removals, optional extras, and any limits of the
available evidence. An empty GitHub dependency-graph comparison must never
mean that no uv dependencies changed.

GitHub [supports uv in Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories),
but its [dependency-graph supported-files table](https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems)
does not list `uv.lock`. A comparison endpoint can also return HTTP 403 for a
repository whose PR files remain readable. This module must not depend on that
endpoint for Python inventory.

## Tech Stack

Node.js 24 ESM, bounded retrieval of base and head `pyproject.toml` and
`uv.lock` blobs, validated TOML data, and the shared review-input and
coverage schemas. A GitHub global-advisory lookup may supplement vulnerability
evidence for resolved PyPI package versions. The reviewer does not install
Python dependencies or execute either commit's code.

## Commands

This repository must provide these commands after implementation:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
```

## Project Structure

```text
shared repo: src/evidence/uv.mjs         → validated uv inventory and coverage
shared repo: src/evidence/uv.test.ts     → base/head and failure fixtures
shared repo: src/evidence/advisories.mjs → bounded shared advisory lookup
consumer: pyproject.toml               → direct dependencies and extras
consumer: uv.lock                      → resolved package graph
```

## Code Style and Evidence Contract

Use stable identities that include normalized package name, source, resolved
version, and applicable markers when needed; do not collapse distinct locked
variants into one inferred update. Every output item carries ecosystem,
direct/transitive classification when established, `from` and `to` versions
when present, relevant extra or group, and a coverage status with source path.
Uncertain classification is explicit rather than guessed.

## Requirements

1. Read base and head files by immutable full SHA. Validate file size, TOML
   syntax, lockfile version, and required fields before comparing. A missing,
   malformed, unsupported, or truncated file produces a bounded coverage
   diagnostic, not an empty inventory or a successful zero-change review.
2. Compare `pyproject.toml` direct dependencies and all declared optional
   extras with `uv.lock` resolved packages for both commits. Preserve package
   names, versions, sources, markers, and dependency relationships needed to
   distinguish direct from transitive changes and their applicable extras.
   Do not assume one installed environment represents the universal lock.
3. Account for each paired version update and each unpaired addition or
   removal. Map a transitive change to its direct scope only when the lockfile
   graph proves the relationship. If a marker, source, or extra prevents a
   reliable mapping, retain the package change and mark that part incomplete.
4. Reconcile the package inventory with Dependabot's PR description and
   changed-file list as untrusted corroborating data. A group count or PR
   title alone cannot prove complete coverage. In particular, an empty,
   missing, or 403 GitHub dependency comparison cannot erase changes found
   in `pyproject.toml` or `uv.lock`.
5. For resolvable proposed PyPI versions, query a bounded, attributable
   advisory source when the comparison API provides no vulnerability data.
   GitHub's [global security advisories endpoint](https://docs.github.com/en/rest/security-advisories/global-advisories)
   accepts multiple `package@version` filters. Retain advisory URL, severity,
   affected package and version, and lookup status. A failed, truncated, or
   inapplicable lookup leaves vulnerability coverage unavailable; it cannot
   be reported as zero vulnerabilities.
6. Do not check out or execute PR-head files, resolve packages, run `uv`,
   install dependencies, or send private source excerpts to an advisory
   service. The evidence collector reads package metadata only and sends
   model context through the separately configured analysis boundary.
7. Keep the review advisory. Missing evidence constrains the default
   recommendation through the shared deterministic policy and remains
   visible even if a repository overrides that recommendation locally.

## Testing Strategy

Use checked-in synthetic fixtures, including a private-repository 403
scenario. Cover direct updates, transitive updates, additions,
removals, multiple extras, conditional markers, the same package with
distinct sources or versions, unchanged locks, changed manifests without a
matching lock update, unsupported lock versions, malformed TOML, API 403,
empty graph responses, advisory findings, and unavailable advisory lookups.
Assert that every detected change is assessed or explicitly marked
incomplete. Network calls are mocked; no test executes PR content.

## Boundaries

- **Always:** Use immutable base/head inputs, preserve package identity and
  provenance, and state partial coverage precisely.
- **Ask first:** Add a new parser dependency, advisory provider, supported
  lockfile version, or source-data category sent outside GitHub.
- **Never:** Treat an empty GitHub graph as uv coverage, infer transitive
  scope without graph evidence, or execute untrusted Python project files.

## Success Criteria

1. The uv fixture yields all identifiable direct and
   transitive changes from `pyproject.toml` and `uv.lock`, with any unresolved
   extras or relationships called out explicitly.
2. The same fixture remains reviewable when the dependency comparison API
   returns 403; the comment does not claim zero changes or zero
   vulnerabilities because of that response.
3. Missing and malformed input fixtures produce incomplete coverage, not an
   empty successful review.
4. A uv consumer retains `uv.lock` as its only committed Python lockfile and
   its `uv` Dependabot configuration.

## Open Questions

- Which bounded TOML reader and lockfile versions the first implementation
  will support. The plan may choose these, but unsupported versions must
  produce incomplete coverage rather than guessed results.
