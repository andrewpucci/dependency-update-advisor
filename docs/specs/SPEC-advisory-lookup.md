# Spec: S1 Applicable Vulnerability Advisories

Status: implemented; [#19](https://github.com/andrewpucci/dependency-update-advisor/issues/19)
tracks review and merge, 2026-11-06.
Supporting contract for `shared-review`
in [the capability map](README.md), scoped to
[issue #19: S1](https://github.com/andrewpucci/dependency-update-advisor/issues/19).
This supplies shared research to the approved npm, Actions, and uv evidence
modules without adding a capability-map module or changing dependency direction.

Confirmed scope decision: the user agreed to query both current and proposed
resolved versions so the evidence can distinguish advisories that apply to the
proposal from advisories the update resolves.

Specification approval, 2026-11-03: the user invoked `as-plan` after reviewing
the saved draft. Under the repository approval rule, this approves this
specification for planning. The ordered handoff lives in `tasks/plan.md`, with
individual tasks tracked as sub-issues of #19 on the implementation project.
Plan and execution approval were separate from that step.

Plan and execution approval, 2026-11-03: the user invoked `as-build auto`
after reviewing the nine-task handoff. This authorizes S1.1–S1.9 in order,
per-task commits, automated verification checkpoints, and issue/project
updates. Merge, publication, consumer adoption, parity and cutover remain
separate gates.

Implementation handoff: ordered [#173–#181 under #19](https://github.com/andrewpucci/dependency-update-advisor/issues/19)
cover exact lookup, pagination/failure handling, two-side conclusions,
comparison positives, uv, Actions mappings, conflict/retention behavior,
mixed real-collector integration, and exact-revision verification. They are
tracked on the implementation project. [Verification #181](https://github.com/andrewpucci/dependency-update-advisor/issues/181)
records revision-specific checks, review disposition, and remaining gates.

## Objective and Scope

Give maintainers attributable vulnerability findings for exact changed
dependency instances. Preserve known findings when another lookup fails, and
make failed, unsupported, or incomplete applicability checks explicitly unknown.
A successful empty lookup means no matching advisories from the checked source
for that exact package/version; it is never a general claim of safety.

S1 consumes the immutable inventory from [N1](SPEC-npm-inventory.md),
[X1](SPEC-actions-inventory.md), and [U1](SPEC-uv-metadata.md), with uv resolved
changes supplied by [U2](SPEC-uv-relationships.md). It enriches existing
[T4 packet](SPEC-review-packet.md) records for [T5](SPEC-decision-units.md)
and [C3 policy](SPEC-advisory-policy.md). It does not pair changes, prove
relationships, assess compatibility, call a model, render or publish a review,
or change execution status.

Malware research, upstream release research, ref-to-version discovery,
workflow orchestration, action packaging, adoption, parity, and cutover remain
separate. S1 cannot mark those categories complete. The old reviewer stays active.

## Inputs and Handoff

1. Trusted orchestration supplies the verified review binding, exact collector
   changes and source table, independent inventory/comparison coverage, existing
   findings, and explicit lookup budgets. Reject inconsistent bindings, duplicate
   identities, dangling inventory sources, and invalid limits before network I/O.
   Preserve invalid, obsolete, and unavailable collector outcomes; none becomes
   an empty successful inventory.
2. Research each existing resolved side: head for additions, base for removals,
   and both for updates. Never invent a missing version. npm declaration records
   keep their empty research object and receive no advisory lookup or finding.
   Any uv declaration or unresolved package without a resolved change remains
   the upstream collector's explicit gap, not a guessed research target.
3. Return detached immutable enrichment with the same change IDs, sides,
   roles, roots, source identities, grouping proofs, and inventory gaps. Add
   advisory sources, vulnerability evidence, findings, and bounded side-specific
   lookup outcomes. Preserve unrelated evidence and comparison availability.
4. Keep each result attributable to the exact ecosystem, member, side, source
   identity, and recorded version/ref. Repeated npm paths, uv source/marker
   variants, and Actions occurrences remain distinct members even when a request
   is shared. Cache only within this collection by exact eligible query identity;
   construct member-specific citations without exceeding T4 membership bounds.
5. Orchestration merges the enrichment with other research, assembles all
   ecosystem slots and trusted C2 context, and invokes T4 before T5/C3.
   S1 does not assert that the packet, assessment, or execution is complete.
   Packet version 1 and existing policy finding variants remain unchanged.

The plan must name the exported handoff and its adapters against actual
collector exports. No widening of N1/X1/U1/U2 inventory semantics is authorized
by this contract.

## Lookup and Applicability Contract

### Eligible exact identities

| Inventory ecosystem | Advisory ecosystem | Eligible identity and limits                                                                                                                                                                                            |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm                 | `npm`              | Exact actual package name and resolved version from an established public npm registry source. Preserve aliases' actual package identity; an installed slot name alone is insufficient.                                 |
| uv                  | `pip`              | Normalized PyPI package name and exact resolved version from an established public PyPI source. Keep uv as the inventory ecosystem and preserve source/marker/extras distinctions.                                      |
| Actions             | `actions`          | Established advisory package identity and exact version, with attributable mapping to the recorded action/ref. Repository subpaths and reusable workflows require their own proven mapping; do not silently strip them. |

Custom/private/unknown registries, Git, URL, path, workspace, unresolved
versions, and ambiguous identities remain unsupported for public lookup.
Do not send private package identities to a public lookup. A matching display
name or plausible version cannot establish that a different source is the
public package. Unknown public-source eligibility remains unknown.

Actions SHAs, branches, major-only tags, and other floating refs do not become
semantic versions. A comment, PR title, or version-looking tag alone cannot
prove a ref-to-version mapping. S1 may consume an attributable mapping supplied
by trusted research, bound to this exact recorded ref and action identity; it
does not discover that mapping or execute action code. Without it, retain
`unsupported` vulnerability coverage. Do not reinterpret a SHA as a version
or infer safety from absent Dependabot alerts. Packet subjects continue to use
the exact inventory ref, retaining the mapping in bounded provenance.

### Exact GitHub advisory queries

Use GitHub's [global security advisories API](https://docs.github.com/en/rest/security-advisories/global-advisories)
as the v1 lookup provider. It supports ecosystem filtering, exact
`package@version` filters, and cursor pagination. Query reviewed vulnerability
advisories explicitly; do not infer malware coverage from that query.

The proposed initial strategy is one exact package/version per paginated
query, deduplicated across identical eligible targets. GitHub accepts multiple
targets but returns advisories matching any target; a batch response does not
establish which queried versions match. Singleton queries avoid adding a
second semver/PEP 440 applicability evaluator. Batching that relies on local
range evaluation needs an amended contract and appropriate fixtures.

Build query parameters locally with URL encoding. Do not accept a caller URL,
use a package-only query as version proof, strip version qualifiers, approximate
prereleases, or infer applicability from `first_patched_version` alone.
Validate the returned advisory identity, reviewed type, withdrawal state,
matching ecosystem/package entry, severity, affected range, title, and canonical
advisory URL before retaining a finding. The exact-version query supplies
version applicability; a package match in an unrelated or malformed response
cannot substitute for the query result.

Follow all pages within bounds. Validate cursors and keep the original exact
ecosystem/version filters; reject cross-host, changed-filter, repeated-cursor,
or malformed continuations. A failed final page leaves the query incomplete
even if an earlier page was empty or supplied valid findings.

Use active reviewed advisories for vulnerability claims. Preserve an explicitly
withdrawn record as withdrawn when attributable; it cannot support an active
blocker. Unexpected types or contradictory withdrawal/applicability data leave
the affected lookup incomplete. Never silently classify an unreviewed or
malware record as a reviewed vulnerability.

### Comparison evidence and fallback

GitHub's [dependency comparison endpoint](https://docs.github.com/en/rest/dependency-graph/dependency-review)
can carry advisory IDs, URLs, summaries, and severities for added/removed exact
versions. Accept these only from a bounded D1 comparison tied to this review's
base/head identities and an unambiguous exact inventory-side/package match.
Create advisory-category provenance; an inventory comparison citation alone
cannot substantiate a vulnerability finding under T4.

Retain attributable positive comparison findings even if the global lookup
fails. Use the exact global lookup when comparison evidence is missing or
cannot establish the relevant side's vulnerability coverage. A comparison
omission, empty response, or empty vulnerability array alone is not an
exhaustive advisory check. Comparison 403s remain separate diagnostics and
cannot erase immutable inventory or independently successful advisory evidence.

Current collector summaries do not retain all raw advisory fields. When
comparison evidence is supplied, orchestration must pass the bounded D1
comparison result explicitly; S1 must not reconstruct advisories from summary
counts, refetch through an unbounded client, or require a second inventory.
Absence of that optional result still permits independent exact global queries.

### Findings and two-side conclusions

| Evidence                                                                                                                 | Required conclusion                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Valid active advisory returned for the exact proposed target                                                             | Emit `vulnerability` with `affects_proposed`, including when base research failed.                                      |
| Complete base check excludes the same advisory; proposed target is affected                                              | The same finding may explain that the update introduces this advisory. Do not invent a new policy variant.              |
| Base target is affected; complete proposed check excludes that advisory for the same established package/source identity | Emit `resolved_by_proposed`, supported by both sides.                                                                   |
| Proposed target is affected; base is affected or unknown                                                                 | Retain the proposed finding; do not call it newly introduced without complete base evidence.                            |
| Complete exact-side check returns no active matches                                                                      | Record available scoped evidence with no active findings; say which provider and exact target were checked.             |
| Base-only removal                                                                                                        | Retain attributable base observations; removal alone is not a `resolved_by_proposed` version claim.                     |
| Unsupported target, failed lookup, partial pages, conflicting applicability                                              | Keep vulnerability coverage partial or unavailable with fixed reasons; never synthesize an unaffected or fixed finding. |

Successful empty proposed research must be complete for the exact same advisory
identity before supporting a fixed conclusion. Retain the base advisory's GHSA
identity and affected range alongside the proposed absence proof, using
separate attributed sources for the two sides. One finding cannot combine
unrelated advisory IDs. No finding is required for every unrelated advisory
merely to express an empty query.

Deduplicate by advisory identity and exact member, preserving side evidence.
Conflicting severities, ranges, identities, or applicability for that claim
become an explicit `conflict` gap; do not choose the weaker claim. Retain
independent nonconflicting findings. A partly failed lookup cannot clear an
existing verified proposed-side finding.

Normalize GitHub `medium` to C3 `moderate` and `unknown` to omitted severity.
Accept `critical`, `high`, and `low` unchanged. Missing/null documented unscored
data remains unscored; unexpected severity strings are malformed, never low.
Do not derive a severity from prose or add a CVSS-based policy rule.

## Evidence Representation

Use existing `PacketSource`, `ChangeEvidence`, and `Finding` types.
Successful sources have `kind: 'advisory'`, HTTPS provenance, bounded title
and excerpt, exact `subjects`, and advisory identity/affected range for
advisory-specific claims. Use the query URL for a successful empty lookup;
use the validated canonical advisory URL for a positive finding. Never fetch
arbitrary advisory reference URLs.

Every finding citation needs a non-null provenance `range` whose base/head
endpoint equals its exact subject value, as T4 requires. Keep this endpoint
range distinct from `affectedRange`, which is the advisory's vulnerable-version
expression. When a finding includes that expression, every referenced advisory
source must retain the same expression, including proposed absence evidence
used to establish that particular advisory is fixed.

Sources identify the original member ecosystem and exact recorded version/ref,
even when the API ecosystem differs. A failed lookup may use unavailable
provenance without an invented URL. Findings reference source IDs, and each
`memberId` equals an existing change ID. A fixed finding cites both base and
head evidence for the same GHSA. Respect T4 text, source, finding, membership,
and total packet bounds without weakening them.

The packet vulnerability category covers the reviewed side: head when present,
otherwise base. Preserve the result of every attempted side separately in the
enrichment. A failed base lookup prevents introduced/fixed conclusions but does
not negate independently complete proposed-side coverage. Proposed-side
failure remains a required gap even when base research succeeds. Neither a
group nor another ecosystem can supply missing exact-member vulnerability
coverage. Other research categories retain their existing state.

## Transport, Bounds, and Failure Behavior

Use an injected fetch/clock and explicit cancellation, following existing
D1/N2 conventions. Restrict requests to locally constructed HTTPS
`api.github.com/advisories` routes; reject redirects and arbitrary pagination
URLs. Public global reads require no additional permission. Credential routing
remains trusted workflow responsibility; never receive the comment/status App
token, provider secret, cookies, source excerpts, or consumer workflow text.
Send only eligible package/version identifiers and fixed query parameters.

Require explicit positive safe-integer limits for requests, pages, response
and total streamed bytes, JSON entries/depth, retained bytes/findings, and
request/total time. Use serial requests initially. Validate consistent limits
before I/O, enforce body limits while streaming, and stop parsing/traversal at
work limits. Count continuations and any retry against the same budgets.
No implicit unbounded defaults, retries, queue, or persistent cache.

Preserve valid findings from completed work when a later request fails. Do not
drop inventory or silently truncate findings to fit. If retention prevents
keeping all findings, reserve a bounded gap for every affected member and
leave its coverage incomplete; if even a truthful result cannot fit, return
explicit unavailable enrichment and preserve the caller's original inventory.
Do not delete preexisting findings to make the enrichment fit.

Map failures to T4 reasons: `permission`, `rate_limit`, `timeout`, `missing`,
`malformed`, `unsupported`, `truncated`, `budget`, `conflict`, or `unknown`.
Distinguish a permission 403 from a rate-limit 403 using response context;
an ambiguous 403 stays unknown. GitHub documents
[rate-limit response headers and secondary limits](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors).
On rate limiting, stop issuing requests in this session and mark remaining
targets unresolved; do not sleep past the collection deadline. A 404, 422,
server error, malformed body, abort, or redirect is never an empty match set.
Do not log raw error bodies, query payloads, credentials, or untrusted text.

## Tech Stack, Structure, and Code Style

Use the pinned Node.js `>=24.11.0 <25`, ESM, strict TypeScript, and adjacent
tests importing from `vite-plus/test`. No parser, SDK, version-range package,
new secret, config field, or permission is proposed.

```text
src/evidence/advisories.ts         → bounded shared advisory enrichment
src/evidence/advisory-read.ts      → exact query transport and normalization
src/evidence/advisory-evidence.ts  → source/finding attribution and reconciliation
src/evidence/advisories.test.ts    → identity, applicability, and failure cases
src/evidence/*.integration.test.ts → authentic collector/T4/T5/C3 handoffs
tests/parity/                     → synthetic scenario helpers when needed
docs/specs/SPEC-advisory-lookup.md → this S1 supporting contract
```

Use discriminated outcomes, pure normalization helpers, stable IDs, immutable
returns, fixed diagnostics, and explicit unknown states. Preserve the original
ref/version in sources; normalization for API lookup cannot mutate inventory.
For example, severity normalization must fail closed:

```ts
if (severity === 'medium') return 'moderate';
if (severity === 'unknown') return undefined;
if (severity === 'critical' || severity === 'high' || severity === 'low') return severity;
throw new TypeError('Invalid advisory severity');
```

## Implemented Interface and Handoff

`createAdvisoryReader(limits, dependencies)` returns `invalid` or a ready,
collection-local reader with `read(target)` and `close()`. Dependencies supply
fetch, monotonic time and optional cancellation. Explicit `AdvisoryLimits`
cover requests, pages, response/total bytes, JSON entries/depth, retained bytes,
findings, and request/total time. The transport pins API version `2026-03-10`,
queries reviewed singleton `package@version` targets serially, follows validated
cursors, omits credentials, rejects redirects and makes no retries. Close the
reader in the caller's `finally` block.

`enrichAdvisories(input, { reader })` consumes an `AdvisoryInput`: binding,
normalized changes/sources/findings, limits, required `publicIdentities`, and
optional `actionVersions` and bounded D1 `comparisons`. Trusted orchestration
selects authentic successful N1/N2, X1 and U1/U2 handoffs and preserves failed
collector outcomes before calling S1. No generic collector wrapper, inventory
reconstruction or packet-schema change was added.

`PublicPackageIdentity` binds member, side, ecosystem, actual name/version,
original registry source identity and proof source IDs. npm requires the public
npm origin; uv requires `https://pypi.org/simple` with optional trailing slash.
Proofs cite available exact-side public metadata. A registry hostname alone
does not establish public availability. `ActionVersionMapping` binds member,
side, full action/ref, advisory package/version and proof source IDs. Its
available upstream sources belong to that action's GitHub repository and exact
recorded ref; subpaths and workflow occurrences retain their full identities.
These proof producers remain live integration gates, not S1 discovery APIs.

`AdvisoryResult` is `invalid`, `unavailable` with a fixed reason, or immutable
`enriched` data with binding, changes, sources, findings and side-specific
`lookups`. Apply only these enriched fields over original collector data,
preserving snapshots, relationships, inventory gaps, ecosystem coverage and
comparison state. `kind` and `lookups` are diagnostics outside packet version 1.
On failure, keep original inventory/findings and mark research unavailable;
failed enrichment cannot establish newly complete research. T4 validates the
final assembled packet.

Exact queries are deduplicated only within one enrichment. Conflicting same-side
GHSA facts yield explicit gaps; independent findings survive. A comparison
positive contradicted by a complete global query remains cited with a conflict
gap. Disagreeing package URLs cannot establish a claim. If new member evidence
exceeds retention limits, bounded `budget` diagnostics replace that member's
new enrichment, retaining all original findings and completed independent
members. If even a truthful fallback cannot fit, enrichment is unavailable.
No inventory member is dropped.

`tests/parity/advisories.ts` supplies synthetic HTTP and proof fixtures for
actual D1/N1/N2/X1/U1/U2, T4, T5 and C3. These cover proposed high/critical
blockers, two-side fixed claims, comparison failures, source/ref attribution,
grouped-member findings and the combined 128-change boundary. Public identity
and Actions mappings are explicitly invented test scaffolding. Advisory and
consumer HTTP responses are mocked. No live proof acquisition, S2/S3,
workflow, assessment, rendering/publication, packaging, adoption or cutover
completion is implied.

## Commands and Testing Strategy

For this documentation change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

For implementation, install the pinned toolchain if needed, then run all four
checks against the same exact shared revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

No build command exists yet; packaging remains A1. Record the tested SHA,
working changes if any, environment, commands, outcomes, and checks not run
in the implementation issue or PR. Distinguish PR head from CI merge SHA.
No new quality threshold is proposed.

Use synthetic immutable inventories and mocked advisory/transport responses.
Behavior changes must leave checks that would catch the defect. Required cases:

| Fixture                                                                                                                                  | Required assertion                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introduced high/critical vulnerability                                                                                                   | Exact proposed finding survives T4/T5 and triggers the existing C3 default; introduction is asserted only with complete base evidence.                         |
| Still affected, fixed, unchanged version, and failed base/head lookup combinations                                                       | No invented introduction/fix; valid proposed blockers survive failure, fixed findings have both sides, and only reviewed-side success satisfies that category. |
| npm additions/removals/declarations, aliases, repeated paths and roots                                                                   | Correct nullable sides and exact identities; declarations cause no lookup, removals cause no fabricated proposal, repeated members retain separate citations.  |
| uv versions, normalized names, distinct sources/markers/extras                                                                           | `pip` query maps back to uv with exact member provenance; private/custom sources never masquerade as PyPI.                                                     |
| Actions version mapping, subpath, reusable workflow, SHA/branch/floating tag                                                             | Proven mapping retains original refs; absent/ambiguous mapping remains unknown and sends no guessed version query.                                             |
| Comparison omission/empty/permission 403 with successful exact lookup                                                                    | Immutable inventory survives, comparison failure stays visible, independent advisory results are retained.                                                     |
| Advisory permission/ambiguous/rate-limit 403, 429, 404, 422, 5xx, abort                                                                  | Fixed reasons and explicit unknown coverage; rate limiting stops subsequent requests; no response becomes zero vulnerabilities.                                |
| Empty full lookup, multiple pages, failed final page, repeated/hostile cursor                                                            | Only a complete valid query establishes an empty scoped result; valid earlier findings survive incomplete pagination.                                          |
| Multiple advisory package entries, wrong identity/ecosystem/version attribution, withdrawn/unreviewed/malware, unscored/invalid severity | No cross-target inference, accidental malware coverage, severity downgrade, or active withdrawn blocker.                                                       |
| Conflicting comparison/global facts and duplicate GHSA records                                                                           | One nonconflicting claim per exact member/advisory; conflicts remain gaps without hiding independent findings.                                                 |
| Request/time/stream/JSON/retention/packet limits and hostile URLs                                                                        | Bounds hold, no redirected credential/request leak, no silent loss of findings or upgraded coverage.                                                           |
| Mixed npm/Actions/uv through authentic collectors, T4, T5, C3                                                                            | One complete ecosystem cannot hide another's unknown applicability; exact citations validate and unrelated research remains unchanged.                         |

Integration fixtures must execute the actual available N1/X1/U1/U2 collectors,
S1, T4, T5, and C3 rather than replacing their handoffs with assertions about
mocked acceptance. Supply unrelated synthetic research explicitly and identify
it as test scaffolding; these fixtures do not certify S2/S3, live transport,
model assessment, rendering, publication, consumer adoption, or cutover.

## Boundaries and Success Criteria

- **Always:** Retain exact instances and known findings, check each eligible
  existing side, validate attributable sources, bound I/O and work, and expose
  every required unknown under existing T4/C3 rules.
- **Ask first:** Add a provider, dependency, credential/permission, registry,
  ref-resolution strategy, local range evaluator, packet/policy variant, or
  change the meaning of complete vulnerability coverage.
- **Never:** Execute dependency code, resolve/install packages, infer a SHA's
  semantic version, send private source data, treat failed research as zero
  vulnerabilities, relax T4 limits, or claim adoption/parity from unit tests.

S1 is complete when the fixture matrix proves bounded attributable proposed
findings across eligible ecosystems, two-side evidence supports fixed claims,
comparison failures preserve inventory and independent research, and unsupported
or incomplete lookups remain explicit unknowns through T4/T5/C3. The four
implementation checks must pass on the exact documented revision.

## Open Questions

None for the implemented scope. Live proof acquisition and caller-wide budget
allocation remain explicit integration gates. New discovery strategies,
providers, permissions, range evaluators or coverage meanings need separately
approved scope.
