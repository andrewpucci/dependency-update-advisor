# Spec: S2 Upstream Range Evidence

Status: approved for execution, 2026-11-07. Supporting contract for `shared-review`
in [the capability map](README.md), scoped to
[issue #20: S2](https://github.com/andrewpucci/dependency-update-advisor/issues/20).
This supplies research to the existing npm, Actions, and uv modules; it adds
no capability-map module or dependency direction. Specification, planning,
and execution approval remain separate gates.

Confirmed scope decision, 2026-11-07: the user agreed that S2 should discover
Actions ref-to-version mappings when bounded GitHub evidence proves the
relationship, supplying both upstream research and S1 advisory lookup.
Ambiguous mappings retain explicit uncertainty.

Specification approval, 2026-11-07: the user invoked `as-plan` after reviewing
the saved draft. Under the repository approval rule, this approves the
specification for planning. The ordered handoff is `tasks/plan.md`, with
implementation tasks tracked as sub-issues of #20 on the implementation
project. Plan and execution approval were separate from that step.

Plan and execution approval, 2026-11-07: the user approved the ten-task plan,
including its exact dependency pins, and invoked `as-build auto`. This
authorizes S2.1–S2.10 in order, per-task commits, automatic verification
checkpoints, issue/project updates, and one PR closing #20 and #183–#192 on
merge. Merge itself, consumer adoption, parity and cutover remain separate.

Proposed implementation handoff: [#183–#192 under #20](https://github.com/andrewpucci/dependency-update-advisor/issues/20)
cover public metadata proofs, target notes, comparisons, Actions mappings,
version ordering, range/changelog fallback, bounded outcome preservation,
mixed integration, and exact-revision verification. They are linked in plan
order on the implementation project with Status `Todo`. The plan proposes
exact ordering-library pins, now approved by the execution instruction above.

## Objective and Scope

Give maintainers upstream evidence whose package, recorded version or ref,
applicable range, source URL, and lookup outcome can be checked. Missing
releases, failed comparisons, metadata-only fallbacks, and truncated sources
must never appear to be a completed review of unavailable material.

S2 consumes immutable resolved changes from [N1](SPEC-npm-inventory.md),
[X1](SPEC-actions-inventory.md), and [U1](SPEC-uv-metadata.md) through
[U2](SPEC-uv-relationships.md). It returns bounded research enrichment for
[T4](SPEC-review-packet.md), [T5](SPEC-decision-units.md),
[S1](SPEC-advisory-lookup.md), and later analysis. It preserves collector
identities, roles, relationships, inventory gaps, and independent comparison
availability. Complete inventory does not establish complete research.

S2 owns release/comparison/metadata discovery, attribution, fallback outcomes,
and the confirmed Actions mapping boundary. S1 owns vulnerability queries;
[S3 #53](https://github.com/andrewpucci/dependency-update-advisor/issues/53)
owns malware and policy-signal collection. Compatibility judgments, codemod
findings, model calls, rendering, workflow orchestration, publication,
packaging, adoption, parity, and cutover remain separate. The old reviewer
stays active.

## Inputs and Handoff

1. Trusted orchestration supplies a validated T1 binding, collector changes
   and source table, existing findings, and explicit research budgets.
   Validate unknown inputs, exact inventory references, and limits before
   network I/O. Invalid, obsolete, and unavailable collector results cannot
   become empty successful research.
2. Research the proposed side of updates/additions and the base side of
   removals. Updates may use both sides to establish a comparison. Discover
   public-package identity proofs and Actions mappings for both existing
   sides so S1 can check current and proposed versions. A failed base lookup
   does not erase successful proposed research; it prevents unsupported
   before/after claims. Never invent a missing side.
3. npm declaration records retain their empty research object and receive
   no lookup. Unresolved uv records remain collector gaps. Repeated roots,
   npm aliases and installed paths, uv source/marker/extra variants, and
   Actions occurrences retain separate member attribution even when an
   identical request can be shared.
4. Return detached immutable enrichment with unchanged binding, changes,
   unrelated evidence, findings, and inventory sources. Add upstream sources,
   per-member upstream category results, lookup attempts, public identity
   proofs, and established Actions mappings. Do not return raw HTTP bodies
   or replace other research categories. Re-running S2 on its own output must
   not duplicate sources or manufacture conflicting successful results.
5. Use S1's existing `PublicPackageIdentity` and `ActionVersionMapping`
   shapes in `src/evidence/advisories.ts`. Their source IDs must resolve in
   the returned source table, carry the exact member and side, and pass S1's
   current attribution checks. Preserve original Actions refs in subjects;
   the discovered version is a separate mapping value.
6. Keep a bounded attempt record for every attempted or explicitly skipped
   fallback stage: member/side, source kind, requested target and range,
   safe URL when known, outcome, fixed reasons, selected source IDs, and
   truncation. Distinguish unavailable from unattempted/skipped; explain
   budget exhaustion without claiming that a request ran. This handoff is
   separate from packet version 1, which has no attempt-history field.
7. Orchestration supplies S2 proofs and sources to S1, merges independent
   S3 evidence, assembles all ecosystem slots and C2 context, and invokes
   T4 before T5/C3 and model analysis. S2 neither validates the final packet
   nor declares execution successful. W1/W2 must carry bounded fallback
   diagnostics to later consumers rather than silently discarding them.

The plan must name the exported enrichment/reader interfaces and adapters
against actual collector and S1 exports. It must distinguish S2 network
budgets from D1's consumer-repository reads. No inventory or packet-schema
amendment is proposed.

## Eligible Sources and Identity

Use fixed public npm and PyPI metadata endpoints and GitHub REST endpoints.
Do not infer public lookup eligibility from a display name alone. Establish
the public registry origin from immutable collector metadata before sending
a package name to a public service. Private/custom/unknown registries, path,
workspace, arbitrary URL, and unsupported Git sources remain explicit
`unsupported` research; they are not retried against a public namesake.

For npm, use actual alias target names and exact resolved versions. Reuse
N2's bounded exact-version reader and integrity binding where applicable;
never weaken its checks to obtain a repository URL. For uv, require the
established public PyPI source, normalized package name, and exact returned
version. Its public identity proof establishes registry/package/version
attribution, not wheel-content or installed-environment verification.
Keep source and marker distinctions even when metadata requests are shared.

The [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
exposes version metadata. The
[PyPI JSON API](https://docs.pypi.org/api/json/#get-a-release) provides a
version-specific response. Use those records instead of a mutable latest
description as evidence about an older version. Validate returned names,
versions, content types, and consumed fields before retaining a proof.

Repository URLs in exact-version metadata are discovery candidates. Normalize
only documented GitHub repository URL forms into owner/repository identifiers;
do not fetch their original URL. Reject userinfo, query/fragment credentials,
ambiguous source URLs, and conflicting repository claims. Monorepo package
directories and shared release streams need attributable package-to-release
correspondence; a repository-wide release is not automatically that package's
release. A tag candidate or package-looking title alone is insufficient proof.

For Actions, use the exact X1 owner/repository/subpath or reusable-workflow
identity. No consumer PR text or comment can authorize a different repository
or establish a version mapping. Repository-only change links may be retained
as context with explicit unknown applicability; a constructed link is not
fetched release or comparison evidence.

## Discovery, Ranges, and Fallbacks

Preserve the baseline's ordered strategy: target release, attributable
comparison, in-range releases, then attributable metadata or changelog.
The [B1 baseline](../../tests/parity/README.md) identifies the source revision;
its
[upstream collector](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/inputs.mjs)
is the fidelity reference, not permission to copy its permissive attribution,
exception-to-empty conversions, or larger excerpt limits.

| Stage              | Attribution required                                                                                                                                 | Retained scope and outcome                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target release     | Established package/repository correspondence and exact target tag/ref resolution; validate release identity, tag, URL, publication state, and body. | Notes for the target only. A usable complete target source can satisfy upstream availability; it does not prove that all intervening changes were reviewed.  |
| Comparison         | Same established upstream package/repository, both exact endpoints, resolved commits, and validated response identities.                             | Preserve exact direction and endpoint mapping. Complete bounded comparison evidence may satisfy availability; pagination or missing content remains partial. |
| In-range releases  | Established release stream and proven version ordering or commit ancestry within the requested interval.                                             | Keep each release's native version/ref and narrow scope. A subset is partial, never a complete-range assertion.                                              |
| Metadata/changelog | Exact-version registry metadata, or a known changelog at an established immutable GitHub revision with attributable section scope.                   | Metadata alone is partial. An unscoped changelog remains partial with unknown range. Do not promote a generic description into migration evidence.           |

Try bounded exact tag candidates such as `v<version>` and `<version>` only as
discovery. Any package-prefixed or directory-specific convention must be
established by attributable metadata and fixtures. Do not use `latest`, a
release publication date, a version-looking title, or PR prose as range proof.
GitHub's [releases API](https://docs.github.com/en/rest/releases/releases)
lists published releases separately from ordinary Git tags; absence of a
release is not absence of a tag or change.

For ordered release filtering, use correct ecosystem ordering, including npm
prereleases and Python pre/dev/post/local versions. Lexical sorting, dropping
qualifiers, and comparing only numeric prefixes are prohibited. The plan must
select and document the tested ordering implementation before execution.
Until an ordering form is supported, retain exact target research and mark
range filtering `unsupported`; do not approximate. Upgrades use the interval
after the old version through the proposed version. Downgrades and changed
package identities preserve direction and cannot reuse upgrade assumptions.

Resolve comparison endpoints to full commits and retain that mapping in the
lookup handoff and bounded source text. Construct request paths locally.
Check pagination/count/completeness indicators, response base/head and merge
base, and commit ancestry before claiming an exact forward range. Diverged
history, missing patches, and partial file/commit lists cannot prove a complete
change review. GitHub's
[comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
documents pagination and file-list limits; follow bounded pages and retain
limits rather than treating the first page as exhaustive.

Additions/removals have only one inventory side, so use exact-side releases
or metadata without constructing a fictitious comparison endpoint. A change
of repository/package identity cannot be compared as one continuous release
stream. Preserve useful independent evidence when a stage fails.

A failed preferred source may fall back within remaining budgets. Retain its
failed attempt even when a later source succeeds. A successful independent
fallback does not inherit an unrelated permission failure, but its own scope
determines availability. Rate limits, exhausted budgets, and cancellation stop
affected dispatch; do not evade them through another credential or host.

## Actions Ref-to-Version Discovery

1. Resolve each existing side's exact ref in its established public GitHub
   repository. Preserve the original ref kind and value. A branch or major
   tag remains mutable even after observing its current full commit SHA;
   resolution does not make it an immutable inventory pin.
2. Use exact tag references, bounded release/tag enumeration, and annotated
   tag peeling to compare full commit identities. GitHub documents
   [references](https://docs.github.com/en/rest/git/refs#get-a-reference) and
   [tag objects](https://docs.github.com/en/rest/git/tags#get-a-tag)
   separately. Bound peeling depth and reject cycles, non-commit terminals,
   missing objects, and cross-repository identities. Do not substitute
   `target_commitish`, a default branch, or a release title for the tag's
   resolved commit.
3. Emit a version mapping only when attributable release/tag evidence binds
   the recorded ref's commit to one concrete release version for this action.
   A SHA requires exact equality, not proximity to a release commit. Multiple
   conflicting versions, incomplete candidate enumeration, or unresolved
   tag/branch collisions remain unknown. Recheck mutable refs used in a proof
   before returning it; movement or conflicting observations invalidate the
   affected mapping rather than retargeting the immutable inventory.
4. Preserve subpath and reusable-workflow identity. Repository-root release
   evidence can support a subpath only with an explicit attributable
   correspondence for that component; never silently strip a subpath.
   Root-release evidence about another component does not become a mapping.
5. Return S1's mapping shape with available GitHub `release`, `compare`, or
   `metadata` sources and exact inventory-ref subjects. Keep mapping failures
   separate from upstream availability: a useful SHA comparison can exist
   while vulnerability version applicability remains unsupported. S2 does
   not query advisories or turn an absent alert into safety evidence.

## Packet Projection and Coverage

Use existing T4 source kinds `release`, `compare`, and `metadata`, and evidence
states `available`, `partial`, and `unavailable`. Do not assert `group_backed`;
T5 alone establishes grouping. Available upstream evidence must support the
proposed side, or base for a removal, under current T4 rules.

Every successful source retains its HTTPS URL, bounded title/excerpt,
`excerptTruncated`, and exact member/side/value subjects. A non-null packet
range uses the inventory endpoint values, which remain refs for Actions.
Use `{ from: null, to: proposedValue }` for a target-only source, the inverse
for a removal, and both exact endpoints only for established comparisons.
Unknown applicability uses `range: null`, never a guessed endpoint pair.

Intermediate releases have native ranges that are not inventory endpoints.
Retain those native ranges in the attempt handoff. In packet version 1,
project relevant intermediate notes only as partial contextual sources with
unknown range and an explicit limitation; subjects identify the associated
inventory target, not a claim that the intermediate release is that target.
Such sources cannot establish exact target coverage or a deterministic
range-dependent finding. Never rewrite an intermediate version to make it
pass T4. A richer claim requires a separately reviewed schema amendment.

For example, a target-only source uses existing T4 fields:

```ts
const provenance = {
  kind: 'upstream',
  url: 'https://github.com/example/orbit/releases/tag/v2.0.0',
  title: 'orbit 2.0.0 release notes',
  excerpt: 'Target-release notes; earlier releases were not reviewed.',
  excerptTruncated: false,
  subjects: [{ memberId: 'npm:orbit:update', side: 'head', value: '2.0.0' }],
  range: { from: null, to: '2.0.0' },
} satisfies Extract<SourceProvenance, { kind: 'upstream' }>;
```

Use stable IDs tied to exact lookup identity and member attribution. Deduplicate
requests only within the collection; shared responses produce bounded
member-specific citations. Keep known evidence and existing findings when
another member fails. Do not add findings merely because release prose says
an update is safe, incompatible, or security-related.

Source availability and category completeness are distinct. A fully retrieved,
validated exact-version metadata source is `available` and may support S1's
identity proof, while the member's metadata-only `upstream` category stays
`partial`. Partial contextual sources cannot support such a proof. No
attributable usable content leaves the category unavailable. Empty published
notes cannot stand in for reviewed release content. Retained excerpt
shortening sets `excerptTruncated`; it
does not mean the omitted text was analyzed. Incomplete response bodies,
pagination, or collection leave partial/unavailable coverage. A clipped
source cannot independently establish complete upstream coverage.

## Network, Work, and Privacy Bounds

Use Node.js 24 ESM, strict TypeScript, the pinned repository toolchain, and
injected fetch/clock/cancellation dependencies. No runtime dependency is
selected by this specification. New ordering dependencies need approval during
planning; do not add a homegrown approximation to avoid that decision.

Require positive safe-integer caller limits for requests, pages, tag candidates,
peeling depth, streamed response and cumulative bytes, parsed JSON depth and
entries, retained bytes/attempts, request duration, and total duration.
Validate consistent limits before I/O and bound work before materialization.
Use deterministic sequential dispatch initially; any later concurrency must
preserve cumulative budgets and deterministic retention.

Build allowlisted HTTPS URLs locally. Use manual redirect handling and reject
redirects, including repository renames; record `unsupported` and retain any
independent fallback. Never forward authorization to a redirect destination.
Use credential-free public registry requests and public GitHub research;
never pass the review App write token, provider key, consumer excerpts, or
private package identities. Do not follow arbitrary metadata links, download
archives/assets, execute Markdown/HTML, install packages, or run upstream code.
Changelog reads stay on fixed GitHub APIs at an established full commit.

Normalize failures to T4's fixed reasons. Distinguish rate-limit 403/429 from
permission 403 using response context; ambiguous 403 remains unknown. Keep
404/missing, malformed/content-type, timeout/abort, truncation, conflict,
unsupported, and budget outcomes explicit. No retries or alternate credentials
are implied. Logs contain bounded categories/counts and reviewed identities,
never raw payloads, credentials, PR prose, or excerpts.

Obey existing T4 ceilings, including 128 combined changes, 1,024 sources,
2,048-byte source text, 32-entry lists, and the complete packet byte cap.
No new numeric quality threshold or workflow deadline is proposed. When
retention cannot preserve a valid handoff, return a bounded explicit failure;
never trim changes/findings, leave dangling references, or claim completeness.

## Commands and Project Structure

For this documentation change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

For implementation on the exact documented revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Record installation separately and report SHA, working changes, tool versions,
commands, outcomes, and checks not run in the issue or PR. Distinguish the
CI merge SHA from the PR head. No build command exists yet; packaging is A1.

Proposed locations, with file splits selected during planning:

```text
src/evidence/upstream.ts                 → validation, enrichment, fallback handoff
src/evidence/upstream-read.ts            → bounded fixed-host reads and attribution
src/evidence/upstream*.test.ts           → source, range, mapping, and failure fixtures
src/evidence/upstream.integration.test.ts → real collector/S1/T4/T5/C3 integration
tests/parity/upstream.ts                 → synthetic shared scenarios
docs/specs/SPEC-upstream-evidence.md      → this supporting contract
```

Keep pure identity/range/projection logic apart from transport. Follow existing
readonly discriminated results, `.js` import suffixes, injected dependencies,
and fixed `EvidenceReason` values. Source-adjacent tests use `vite-plus/test`.

## Testing Strategy and Success Criteria

Use invented public identities and mocked HTTP responses; no default test
performs a live lookup. Behavior changes leave a check that would catch the
defect. The following fixtures must pass before S2 is complete:

| Fixture                                                                                   | Required assertion                                                                                                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Target tag with/without `v`, missing release, ordinary tag without release                | Only validated package-specific content becomes release evidence; fallback history records what actually ran.                                |
| Monorepo, conflicting repositories, same version in different packages                    | Repository membership or matching names cannot substitute for component attribution.                                                         |
| Exact full comparison, pagination, divergent history, downgrade, changed identity         | Direction and actual endpoints survive; incomplete history never claims an exhaustive range.                                                 |
| npm prerelease/build identifiers and Python pre/dev/post/local versions                   | Exact versions survive; supported ordering is correct and unsupported ordering never uses lexical/numeric-prefix approximations.             |
| Intermediate-only releases, target-only notes, generic metadata, unscoped changelog       | Narrow/native ranges and partial outcomes survive projection without invented endpoint coverage.                                             |
| Redirect, malformed JSON/content type, 404, permission/rate-limit/ambiguous 403, 429, 5xx | Fixed reasons, no followed redirect or credential leak, no failure converted to an empty successful source.                                  |
| Annotated/lightweight tags, exact SHA, branch/major tag, collisions, tag movement         | Mapping needs established exact commit/version correspondence; mutable refs remain mutable and ambiguity remains unknown.                    |
| Actions subpath and reusable workflow                                                     | Original action identity and refs survive; no unproven repository-root version mapping.                                                      |
| Addition, removal, npm declaration, aliases, repeated roots, uv variants                  | Correct side/identity attribution, no fictitious comparison, no declaration lookup or cross-member evidence borrowing.                       |
| Request/page/time/stream/JSON/peeling/attempt/retention bounds and abort                  | Work stops within budgets, unattempted targets remain explicit, known evidence survives, no invalid packet is returned as usable.            |
| Excerpt clipping and failed final page                                                    | Truncation is visible; retained excerpts do not imply omitted material was reviewed.                                                         |
| Mixed actual N1/X1/U1/U2 → S2 → S1 → T4 → T5 → C3                                         | S2 produces real proofs consumed by S1, required upstream gaps remain visible, and one ecosystem's success cannot conceal another's failure. |

Integration must exercise actual exported collectors and validators, including
an Actions mapping consumed by S1 and a public npm/PyPI identity proof.
Supply unrelated S3 research explicitly as synthetic scaffolding. Assert
preservation of existing findings, inventory/comparison gaps, relationship
proofs, and exact refs, as well as deterministic output and detached inputs.
Tests do not certify live transport, model analysis, rendering, publication,
consumer adoption, parity, or cutover.

## Boundaries and Open Questions

- **Always:** Preserve exact inventory identities, source scope, fallback
  outcomes, independent failures, and known evidence; validate and bound I/O,
  work, text, and final attribution.
- **Ask first:** Add another host/source provider, credential/permission,
  runtime dependency, packet/policy variant, or change the meaning of complete
  upstream coverage or supported ref/range strategies.
- **Never:** Execute dependency code, infer a semantic version from a SHA,
  treat PR prose as proof, leak private identity/content, imply an unavailable
  source was reviewed, or lower T4/fail-secure gates.

No further product-scope question is required for the approved scope. Planning must
select the tested version-ordering implementation, exact tag/component
correspondence rules, and explicit caller budget allocation before execution.
These selections do not authorize broader hosts, guessed mappings, or a
packet-schema amendment. Execution follows the approved implementation plan;
remaining integration and cutover gates are not satisfied by local tests.
