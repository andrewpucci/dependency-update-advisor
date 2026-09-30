# Spec: npm Dependency Evidence

Status: approved for planning, 2026-09-23. Module: `npm-evidence` in
[the capability map](README.md).

## Objective

Account for every npm dependency changed by a Dependabot PR, including
paired version updates, unpaired additions and removals, nested package
roots, and transitive lockfile changes. Give the shared reviewer attributable
upstream, vulnerability, and coverage evidence without treating an empty or
unavailable GitHub comparison as proof of no change.

The source reviewer's
[decision-coverage spec](https://github.com/andrewpucci/andrewpucci.com/blob/main/SPEC-dependabot-decision-coverage.md)
defines the grouping baseline. Grouping explains a proven dependency
relationship; it never means each transitive member was researched or safe.

## Tech Stack

The collector uses Node.js 24 ESM with strict TypeScript source and bounded
GitHub REST reads of the PR file list and immutable base/head `package.json`
and `package-lock.json` blobs. It parses npm lockfile v3 data and uses the
shared review-input and coverage schemas. GitHub's
[dependency comparison](https://docs.github.com/en/rest/dependency-graph/dependency-review)
is useful corroboration, while [npm's lockfile format](https://docs.npmjs.com/files/package-lock.json/)
provides package paths and relationships. A bounded advisory lookup may
supplement vulnerability evidence when the comparison omits a changed
package or fails. No install, script, or PR-head checkout is needed.

## Commands

After implementation, this repository must provide:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
npm run build
```

Until extraction, use the source repository's input and coverage tests as
comparison evidence after verifying its current checkout and test runner.

## Project Structure

```text
shared repo: src/evidence/npm.ts         → base/head inventory and coverage
shared repo: src/evidence/npm.test.ts     → lockfile, roots, and API fixtures
shared repo: src/evidence/advisories.ts  → bounded shared advisory lookup
consumer: package.json                   → direct dependency roles and ranges
consumer: package-lock.json              → resolved versions and relationships
```

## Code Style and Evidence Contract

Use an identity that includes ecosystem, package root, package name, and
lockfile package path when needed. Represent `update`, `addition`, and
`removal` explicitly; a missing side has `null` version, not an invented
range. Every item names its immutable source path and marks direct,
transitive, or unknown role. Each collector result also carries `complete`,
`partial`, or `unavailable` coverage with bounded reasons.

```ts
if (!baseVersion && headVersion) return { kind: 'addition', from: null, to: headVersion };
```

The shared reviewer combines this result with other ecosystems by stable
identity. It must preserve npm coverage separately in mixed npm/Actions PRs.

## Requirements

1. Read the full PR file list with pagination. GitHub's
   [list-files endpoint](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)
   has a 3,000-file cap; reaching a cap or missing a page is incomplete
   coverage. Use the verified base and head full SHAs to retrieve relevant
   manifests and locks. Do not rely on possibly truncated PR patch text.
2. Determine candidate npm roots from changed file paths and the trusted
   Dependabot configuration, including nested roots. Reconcile both sources;
   a conflict, unsupported layout, or unexplained changed npm file is a
   coverage gap, not permission to silently use the repository root.
3. Parse bounded base/head JSON and validate lockfile version and required
   fields. V1 understands committed `package-lock.json` v3 package data.
   Missing, malformed, oversized, unsupported, or mismatched manifest/lock
   data leaves the affected root incomplete. Do not run npm to repair it.
4. Compare resolved package instances as well as direct manifest entries.
   Preserve distinct lockfile paths, package sources, and versions; account
   for every paired update and every unpaired addition or removal. Classify
   direct production, development, peer, and optional roles from the
   manifest only when established. Never infer role from a package name.
5. Connect a transitive change to a changed direct dependency only when an
   unambiguous path in the immutable lockfile graph proves the relationship.
   Shared, orphaned, or ambiguous members stay separate unresolved decision
   units. A group retains its exact member count and coverage limits.
6. Reconcile the inventory with GitHub's comparison and Dependabot text as
   untrusted corroboration. An empty response, omitted entry, endpoint 403,
   or rate limit does not delete a manifest or lockfile change. Distinguish
   an unavailable comparison from a verified empty one in diagnostics.
7. Carry comparison advisories for the exact proposed package/version. If
   the comparison lacks applicable vulnerability data, use a bounded
   attributable advisory lookup for resolvable public npm versions. Report
   lookup failure or unsupported sources as unknown vulnerability coverage;
   never state zero vulnerabilities merely because a lookup was unavailable.
8. Preserve bounded range-aware upstream evidence and its provenance: target
   release, resolvable tag comparison, in-range releases, then attributable
   HTTPS package metadata or changelog. Failed lookups yield explicit partial
   or unavailable evidence. Source URLs and claims remain validated before
   analysis and comment rendering.
9. Record decision-relevant lifecycle-script changes only when the immutable
   lockfile signal and safely retrieved exact-version public metadata support
   them. Missing or conflicting metadata makes that question unresolved.
   Registry requests use fixed hosts, bounds, and no redirects; do not send
   private repository content to a public registry.
10. Return every identifiable npm change even if one source fails. An
    unresolved item constrains the shared advisory recommendation, while
    the shared workflow controls the current-head execution status.

## Testing Strategy

Use synthetic, sanitized base/head fixtures and mocked GitHub, advisory, and
registry responses. Cover a single update, direct and transitive additions
and removals, repeated package names at distinct lockfile paths, nested
roots, ambiguous graph paths, grouped decision units, lifecycle deltas,
malformed or unsupported locks, manifest/lock mismatch, truncated files,
pagination limits, empty comparison, endpoint 403, rate-limit 403, omitted
changes, introduced vulnerability, and failed advisory lookup. Include a
public-derived scenario for PR #307's 20 unpaired npm additions without
copying raw payloads. Assert each detected change appears exactly once and
that mixed PRs do not let Actions coverage mask npm gaps.

## Boundaries

- **Always:** Use immutable base/head data, retain package-path identity,
  validate provenance, and report incomplete coverage precisely.
- **Ask first:** Support another lockfile format, add a parser or evidence
  provider, or send a new category of data outside GitHub.
- **Never:** Install PR dependencies, execute PR code or scripts, infer graph
  relationships from names, or turn a comparison error into an empty review.

## Success Criteria

1. The npm fixture accounts for each changed package instance once, with
   correct root, role when known, change kind, and decision-unit membership.
2. A comparison omission or 403 retains all manifest/lockfile changes and
   reports any unresolved vulnerability or upstream-evidence coverage.
3. The 20-addition fixture contains 20 distinct additions, not 20 fabricated
   paired updates or a generic overflow entry.
4. Missing or unsupported data produces visible incomplete coverage and
   cannot yield an unqualified merge recommendation.

## Open Questions

None for v1 behavior. Any expansion beyond lockfile v3 needs its own
validated fixtures and a spec revision.
