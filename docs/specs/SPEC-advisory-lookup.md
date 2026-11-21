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
use a package-only query as version proof (stored-name discovery uses one only
to learn stored forms), strip version qualifiers, approximate
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
`api.github.com/advisories` routes and, for PyPI reviewed lookups, the
`api.osv.dev/v1/query` route (see the
[Package Name Form Amendment](#package-name-form-amendment)); reject redirects
and arbitrary pagination URLs. Public global reads require no additional
permission. Credential routing remains trusted workflow responsibility; never
receive the comment/status App token, provider secret, cookies, source
excerpts, or consumer workflow text.
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
findings, and request/total time. The transport pins GitHub API version
`2026-03-10` and runs serially. Since the
[Package Name Form Amendment](#package-name-form-amendment), it sends PyPI
reviewed targets to one OSV query, Actions reviewed and `pip`/`actions` malware
targets to stored-name discovery followed by one versioned GitHub query, and npm
targets to one exact `package@version` query. It follows validated cursors and
page tokens, omits credentials, rejects redirects and makes no retries. Close the
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

## Package Name Form Amendment

**Status: approved for planning, 2026-11-20; implemented on branch
`claude/funny-hermann-5d3a1c` for #399–#406, pending review and merge.** The
user explicitly approved
the reviewed draft after approving each design decision below. Plan and
execution approval remain separate gates. Tracked in
[#398](https://github.com/andrewpucci/dependency-update-advisor/issues/398),
with tasks #399–#406.
Effort tier: L. It amends "Exact GitHub advisory queries" and the reader
behind it, and adds [OSV](https://google.github.io/osv.dev/api/) as the
provider for PyPI reviewed-vulnerability lookups. The
[policy signals spec](SPEC-policy-signals.md#package-name-form-amendment)
applies the GitHub two-step lookup to malware queries. Eligible identities,
packet version 1, and the meaning of complete vulnerability coverage are
unchanged. Design decisions so far:

- 2026-11-19: the user approved a two-step GitHub lookup: discover the stored
  name forms, then query every form at the exact version.
- 2026-11-19: the user approved splitting discovery across requests and
  always citing the versioned query.
- 2026-11-19: the user approved adding OSV for PyPI reviewed vulnerabilities
  and keeping the GitHub two-step lookup for Actions and malware.
- 2026-11-19: the user approved citing `https://api.osv.dev/v1/query` for a
  complete empty OSV lookup.
- 2026-11-20: the user accepted the separator-run gap below as a stated
  limit of `pip` malware lookups.
- 2026-11-20: the user approved the register values under "Cost and register
  values".
- 2026-11-20: after a fresh-context review, the user approved defining the
  OSV response shape, keying OSV reuse by request body, a case-and-separator
  discovery fixture, joining several same-package ranges, and stating the
  reduced group capacity under "Cost and register values".
- 2026-11-20: the user approved fixing the review's non-blocking findings in
  this amendment and stating heavy OSV responses and JSON entry use as known
  limits with follow-ups.
- 2026-11-20: the user approved the revised eight-task implementation plan,
  tracking issues #398–#406, one signed commit, and execution on this branch.
- 2026-11-20: after a fresh-context code review, the user approved stating
  the byte cost of `pip` reviewed lookups and the scope of the severity check.

### Why

GitHub's `affects` filter matches the package name in the form an advisory
stores it, and one PyPI project can be stored in several forms. S1 sends only
the normalized lowercase PyPI name, so a complete lookup can miss applicable
advisories, and the reviewer then reports "checked, none found". Read-only
GitHub probes on 2026-11-19 (`type=reviewed`, `per_page=100`):

| Ecosystem | `affects`                         | Advisories | Stored names                                       |
| --------- | --------------------------------- | ---------: | -------------------------------------------------- |
| `pip`     | `pillow@8.0.0`                    |         26 | `pillow`                                           |
| `pip`     | `Pillow@8.0.0`                    |         46 | `Pillow`; none shared with the 26                  |
| `pip`     | `pillow@8.0.0,Pillow@8.0.0`       |         72 | both                                               |
| `pip`     | `pyyaml@3.13`                     |          0 | —                                                  |
| `pip`     | `PyYAML@3.13`                     |          2 | `PyYAML`: GHSA-8q59-q68h-6hv4, GHSA-rprw-h62v-c2w7 |
| `pip`     | `pyyaml` or `PyYAML`              |          4 | the same 4 for both: `PyYAML` ×2, `pyyaml` ×2      |
| `pip`     | `jupyter-server`                  |         15 | `jupyter-server`                                   |
| `pip`     | `jupyter_server`                  |          2 | `jupyter_server`, including one for `<= 2.20.0`    |
| `pip`     | `jupyter-server,jupyter_server`   |         17 | both                                               |
| `actions` | `TJ-Actions/Changed-Files@45.0.7` |          0 | —                                                  |
| `actions` | `tj-actions/changed-files@45.0.7` |          1 | `tj-actions/changed-files`                         |
| `actions` | `TJ-Actions/Changed-Files`        |          2 | `tj-actions/changed-files`                         |

A versioned target matches the stored name exactly, including case and
separators. A package-only target ignores case but not separators. A comma
list returns the union. GitHub documents only the union ("any of package or
package@version"); the rest is observed behavior.

OSV mirrors GitHub's reviewed advisories, normalizes PyPI names, and
evaluates the version itself. OSV `v1/query` probes on the same day:

- `pyyaml` and `PyYAML` at `3.13` both returned GHSA-8q59-q68h-6hv4 and
  GHSA-rprw-h62v-c2w7.
- `jupyter-server` and `jupyter_server` at `2.17.0` returned the same set,
  including GHSA-c3mw-737p-c7g2.
- `pillow` at `8.0.0` returned 70 GHSA records, exactly GitHub's 70 active
  records across both stored names. GitHub's other 2 are withdrawn. The same
  791,379-byte response held 57 PyPA (`PYSEC`) records; one of them applies
  to `8.0.0` where its GHSA alias applies only to `>= 9.2.0, < 9.3.0`.
- OSV returned nothing for `tj-actions/changed-files` at `45.0.7`, though
  it holds that advisory: it does not order GitHub Actions versions.
- OSV has none of GitHub's malware advisories (3 of 3 checked). It has
  OpenSSF `MAL-` records for the same packages under other IDs.

### Decision for review

1. **Provider by target.**

   | Query                           | Provider and query                                         |
   | ------------------------------- | ---------------------------------------------------------- |
   | `pip` reviewed vulnerabilities  | OSV, one exact query (items 2–5)                           |
   | `actions` reviewed, all malware | GitHub, stored-form discovery then a versioned query (6–8) |
   | `npm`                           | GitHub, one exact query; only item 8 changes it            |

2. **OSV query.** The reader sends `POST https://api.osv.dev/v1/query` with a
   locally built JSON body: `package.ecosystem` `PyPI`, `package.name` the
   normalized name, and `version` the exact version. Its only headers are
   `accept: application/json` and `content-type: application/json`; GitHub's
   `accept` and API-version headers are not sent. It sends no credentials and
   follows no redirects. A response body must be a JSON object whose only keys
   are an optional `vulns` array and an optional `next_page_token` string; any
   other key or type is `malformed`. A body with neither key is a complete
   page with no records: OSV answered `{}` for `pyyaml` at `6.0.2` on
   2026-11-20. When a response carries `next_page_token`, the reader resends
   the same body with that value in the request field `page_token`, even if
   the page had no records. The lookup is complete only after a page with no
   token. A repeated or malformed token leaves it incomplete with `conflict`
   or `malformed`, as GitHub's cursor rules do.
3. **OSV records.** The reader keeps only records whose `id` matches S1's
   GHSA identity format and whose `database_specific.github_reviewed` is
   exactly `true`; it ignores the rest (for example `PYSEC` records), so the
   checked scope stays GitHub's reviewed advisories. A kept record must have a
   bounded `summary`; an absent or null `withdrawn` is active, a valid time is
   a withdrawn record, and anything else is `malformed`. It must have at
   least one `affected` entry with ecosystem `PyPI` and the target's
   normalized name; none is `conflict`. Each such entry must have exactly one
   `ECOSYSTEM` range with one `introduced` event and at most one `fixed` or
   `last_affected` event; anything else is `conflict`. Entries for other
   packages are ignored. Several same-package entries are normal: on
   2026-11-20, all 51 GHSA records OSV returned for `django` at `4.2.0` had 2
   to 6 of them.
4. **OSV record mapping.** The URL is the canonical
   `https://github.com/advisories/<id>`, which S1 already validates. The range
   is built from each entry's events, in record order, joined by a spaced
   `||`: `< F`, `>= I, < F`, `<= L`, `>= I, <= L`, or `>= I`, with
   `introduced` `0` omitted. It describes OSV's record and can differ in form
   from GitHub's: for 16 of the 70 Pillow records, OSV gives `< 13.0.0` where
   GitHub gives `<= 12.3.0`, or omits GitHub's `>= 0`. OSV evaluates
   applicability; the range is not re-evaluated locally, and both sides of an
   OSV lookup use the same form. Severity maps `database_specific.severity`
   `CRITICAL`, `HIGH`, `MODERATE`, and `LOW` to S1's values; absent or null is
   unscored; any other value is `malformed`.
5. **OSV citation.** Positive findings cite the canonical advisory URL, as
   today. A complete empty lookup cites `https://api.osv.dev/v1/query`, which
   was fetched; its excerpt names OSV's mirror of GitHub-reviewed advisories,
   and its subject names the exact member and version. OSV can lag GitHub, so
   the source claims only what OSV returned. A D1 comparison positive that a
   lagging OSV omits stays cited with a visible `conflict` gap, under S1's
   existing comparison rule.
6. **GitHub discovery.** For an `actions` reviewed target and for every
   `pip` or `actions` malware target, the reader first sends package-only
   queries with the same fixed ecosystem and type filters and `per_page=50`.
   For `pip`, they list every spelling of the normalized name with each
   separator replaced by `-`, `_`, or `.`, in a fixed order, split across as
   many requests as the discovery URL cap requires. Each request's first URL
   is filled to at most 256 bytes under the cap, which leaves room for the
   `after` cursor; a continuation URL over the cap is `budget`. For `actions`,
   one request lists the mapped `owner/repo` name. The reader follows every
   page of every request under the existing cursor rules. Every returned
   record must name at least one package in the query ecosystem whose name,
   canonicalized, equals the target's canonical name: PEP 503 normalization
   for `pip`, case folding for `actions`. Otherwise the lookup is incomplete
   with `malformed`. The stored forms are the distinct such names, as
   returned.
7. **GitHub versioned query.** After a complete discovery, the reader always
   sends one query whose `affects` lists `form@version` for every stored
   form, sorted. When discovery found no form, it lists the normalized name
   for `pip` or the mapped name for `actions`. That URL was fetched and stays
   short; it is the lookup's URL and the citation for a complete empty
   result. Discovery URLs are not cited, and a package-only query never
   establishes applicability. Listing several targets is sound because they
   are one package at one version, so the batching concern in "Exact GitHub
   advisory queries" (a batch response does not establish which queried
   versions match) does not arise. A record's matching entries are its
   entries in the query ecosystem whose canonicalized name equals the
   target's. None is `conflict`. Several are joined in record order, as in
   item 4, into the record's range, because GitHub does not say which one
   matched.
8. **Several entries, every GitHub query.** The joined-range rule in items 3
   and 7 also replaces today's single-entry rule for npm singleton queries.
   Each matching entry needs a valid `vulnerable_version_range`; otherwise
   the record is `conflict`. A joined range over the packet's text bound
   (`PACKET_LIMITS.identityBytes`) is `budget`, never truncated; the longest
   joined range in the recorded Django and TensorFlow responses was 120
   bytes.
9. **Failure.** An incomplete discovery leaves the lookup incomplete with its
   reason and sends no versioned query. No incomplete OSV or GitHub read
   becomes an empty result. A rate limit stops further requests to that
   provider for the rest of the session, as S1 requires; an OSV rate limit
   does not stop GitHub requests, and a GitHub rate limit does not stop OSV
   requests.
10. **Reuse and bounds.** Base and head of one package share discovery reads
    in the reader, keyed by full URL. A failed discovery is reused too, so the
    second side ends incomplete with the same reason instead of retrying.
    Every OSV query is a POST to one URL, so any reuse of an OSV read is keyed
    by method, URL, and the exact request body. A cache keyed only by method,
    URL, and headers, as the [evidence coverage](SPEC-evidence-coverage.md)
    draft §2.2 states, would return one package's OSV answer for another; it
    must add the body before it covers OSV reads. OSV and GitHub reads count
    against the stage's existing request, byte, and time budgets. A target
    over the spelling ceiling is `unsupported` before any request. A versioned
    URL is checked after discovery: one that would exceed the packet's
    provenance URL bound (`PACKET_LIMITS.identityBytes`, 1,024 bytes) is
    `unsupported`, and no versioned request is sent. Measured on 2026-11-19
    and 2026-11-20, one discovery URL is 87–158 bytes for names with up to one
    separator, 944–998 bytes for three-separator names such as
    `apache-airflow-providers-amazon` (27 spellings), and 3,077–3,563 bytes
    for four-separator names such as `opentelemetry-exporter-otlp-proto-http`
    (81 spellings).

### S1 text this supersedes

Where they conflict, this amendment replaces these statements; the
implementation updates them in place:

- "Implemented Interface and Handoff": the transport "queries reviewed
  singleton `package@version` targets serially". It now routes by item 1.
- "Transport, Bounds, and Failure Behavior": "Restrict requests to locally
  constructed HTTPS `api.github.com/advisories` routes". The OSV route in
  item 2 is also allowed.
- "Exact GitHub advisory queries": "do not … use a package-only query as
  version proof". Discovery uses a package-only query only to learn stored
  forms, never as version proof.

### Known limits

- **Separator runs.** GitHub discovery does not list a stored form that uses
  a run of separators (`a__b`), so it is not found. PEP 503 treats such a
  name as the same project. After item 1, this affects only `pip` malware
  lookups; OSV normalizes names for reviewed vulnerabilities. This amendment
  states the limit instead of claiming discovery is exhaustive.
- **Heavy OSV responses.** OSV returns one response per query with no page
  size. TensorFlow 2.4.0 was 3,983,856 bytes on 2026-11-20, over the 1 MiB
  per-response cap, so such a package ends `budget`. A remedy (a larger
  OSV-only cap with streaming filters, or a GitHub fallback) is a follow-up.
- **JSON entry use.** The reader's JSON entry budget is shared across its
  responses. OSV's Pillow and Django responses used 19,268 and 17,316
  entries, against 6,060 for GitHub's two Pillow pages, so about 11 heavy
  sides can exhaust a reader. Task verification measures this; counting per
  response would change the bound's meaning and is a follow-up.

### Cost and register values

OSV replaces discovery for the heaviest case: Pillow 8.0.0 is one
791,379-byte OSV response, against a 1,009,662-byte first GitHub discovery
page plus a second page and a 746,178-byte versioned response. OSV offers no
field selection, so `PYSEC` records count toward bytes. Actions and malware
targets cost at least one more GitHub request each; malware responses are
small. A heavily advised package can now end `budget` where S1 used to report
a false complete result. The discovery page size, discovery URL cap, spelling
ceiling, and OSV per-response size are register values for the plan; pages
must fit the per-response cap, as evidence coverage §1.6 requires. Approving
this amendment does not approve the values.

**Group capacity (stated limit, 2026-11-20).** Stage shares are unchanged.
The malware share (40 requests) was sized at one request per package, so a
group of only `pip` or `actions` packages, at two or more requests each, now
completes malware for about 20 packages instead of about 40. Actions reviewed
lookups take three requests per update instead of two, so the advisory share
(80 requests) covers about 26 Actions updates instead of about 40. `npm`
groups and `pip` reviewed request counts are unaffected, but bytes are not:
Pillow 8.0.0's OSV response is 791,379 bytes per side, so about three heavily
advised `pip` updates exhaust the advisory share's 5 MiB. GitHub's correct
two-spelling query costs about the same (746,178 bytes), so the cost comes
with the fix, not with OSV. Members past a share end
`budget`, a visible gap. The 944-request envelope is fully allocated, so
resizing is left to the [evidence coverage](SPEC-evidence-coverage.md)
budget scaling (#350). The `src/budget.ts` comment is corrected to match.

Approved values, from probes on 2026-11-20:

| Value                 | Proposed           | Evidence                                                                                            |
| --------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Discovery page size   | 50                 | A 100-record `pillow` page was 1,009,662 bytes against the 1 MiB cap; 50 leaves about half.         |
| Discovery URL cap     | 4,096 bytes        | GitHub accepted discovery URLs of 996, 3,399, and 4,371 bytes and returned 414 at 8,259 and 11,499. |
| Spelling ceiling      | 243 (5 separators) | Five-separator names need about 3 discovery requests under the cap; six would need about 9.         |
| OSV per-response size | existing 1 MiB cap | OSV has no page size; the `pillow` response was 791,379 bytes.                                      |

### Transport

The bounded request helper gains a POST with a fixed JSON body and
`content-type: application/json`, used only for the OSV query, with the
headers in item 2. Allowed destinations become locally built
`https://api.github.com/advisories` and `https://api.osv.dev/v1/query`
routes. Credential, redirect, streaming, and timeout rules are unchanged.
OSV's 429 is a rate limit, scoped to OSV as item 9 says.

### Verification

Fixtures are real responses recorded on 2026-11-19 and 2026-11-20, trimmed
to the fields the reader validates. A synthetic fixture says so in its name
and in the test that uses it; the recorded Pillow data has no
`last_affected` event and no unreviewed GHSA, so those cases are synthetic.

- **PyYAML 3.13 (failing first).** The OSV response for `pyyaml` at `3.13`
  yields GHSA-8q59-q68h-6hv4 and GHSA-rprw-h62v-c2w7, complete. The current
  reader sends GitHub `pyyaml@3.13`, receives the recorded empty list, and
  reports a complete empty lookup, so this check fails on it.
- **OSV request.** The exact request body and headers are asserted, with no
  GitHub headers.
- **Several entries.** The recorded OSV `django` `4.2.0` response completes,
  and a record with 3 `django` entries keeps all three ranges, joined in
  record order. A GitHub record with two same-package entries, such as
  GHSA-q874-g24w-4q9g for `jupyter-server`, keeps both, as does an npm
  singleton record. A malformed second entry is `conflict`. A joined range
  over the bound is `budget`.
- **OSV scope.** A recorded response with `PYSEC` records and a GHSA record
  with entries in other ecosystems keeps only GHSA records for the target
  package. A synthetic unreviewed GHSA, one whose `github_reviewed` is the
  string `"true"`, and one with a malformed id are excluded or `malformed`
  as item 3 says. A synthetic `withdrawn` time gives a withdrawn record; an
  invalid one is `malformed`. Tests assert the severity of every kept record
  in the recorded Pillow, PyYAML, and Django fixtures, matching GitHub's
  recorded values where they exist; a one-time offline comparison on
  2026-11-19 found all 70 Pillow 8.0.0 records matched. Range text follows
  OSV's events.
- **OSV boundaries.** The recorded `{}` is a complete empty lookup; an
  object with an unknown key or a non-array `vulns` is `malformed`. Two `pip`
  targets in one reader send two OSV requests with their own bodies. A
  followed `next_page_token` is sent as `page_token`, including after an
  empty page; a repeated token; no matching `affected` entry (`conflict`); an
  unexpected event shape (`conflict`); an unexpected severity (`malformed`);
  a redirect. A 429 stops further OSV requests while a GitHub Actions lookup
  in the same reader still runs.
- **Actions case.** A mapped `TJ-Actions/Changed-Files` at `45.0.7` discovers
  `tj-actions/changed-files` and finds the recorded advisory.
- **Discovery reuse.** Base and head of one Actions update make one discovery
  request; a failed discovery is reused and both sides end incomplete with
  its reason.
- **Malware discovery.** A `pip` malware target sends `type=malware`
  discovery listing every separator spelling, split so that every first URL
  is at least 256 bytes under the cap, then one versioned query. An empty
  discovery is followed by a versioned query for the normalized name, which
  a complete empty result cites. A failed discovery page, including one in a
  later split request, sends no versioned query. A continuation URL over the
  cap is `budget`. A discovery record with no canonical match is
  `malformed`. A synthetic fixture built from the recorded `jupyter-server`
  and `jupyter_server` discovery records, with one stored name changed to
  `Jupyter_Server`, has a stored name that differs from the canonical
  `jupyter-server` in both case and separator; that record counts, and the
  versioned query lists all three stored forms. A target over the spelling
  ceiling sends no request. Discovered forms whose versioned URL exceeds
  1,024 bytes are `unsupported` with no versioned request. Malware discovery
  is never reused for reviewed lookups.
- **npm** sends one exact GitHub query, as today.
- **Named mutations fail those checks:** querying GitHub for `pip` reviewed
  targets; keeping `PYSEC` or unreviewed records; accepting a truthy
  non-boolean `github_reviewed`; omitting `next_page_token`, or sending it
  under its response name; sending only the normalized spelling to GitHub
  discovery; omitting one separator spelling or split request; comparing a
  stored name to the canonical name without canonicalizing the stored name's
  case or separators (for example `stored === canonical(target)`); treating
  `{}` as malformed or an unknown-key object as empty; keying OSV reuse
  without the request body; stopping GitHub requests on an OSV rate limit;
  retrying a failed discovery for the second side; treating a failed
  discovery as empty; citing a discovery URL; matching a versioned entry by
  exact string instead of canonical name; keeping only the first of several
  same-package entries; and failing a record because it has several.
- Full repository checks, `npm run complexity`, and the action bundle drift
  check pass on the implementation revision.

### Amendment boundaries

- **Always:** keep inventory identities unchanged; clear a target only from
  a complete OSV query or a complete versioned query after a complete
  discovery; query every discovered stored form; and name the provider that
  was checked.
- **Ask first:** the register values, a different citation URL bound, a
  separator-run search, OSV for malware or Actions, `PYSEC` records, a local
  range evaluator, or a change to npm names.
- **Never:** treat a failed or partial read as empty, retain a non-GHSA OSV
  record as a GitHub advisory, send a versioned spelling other than the
  discovered forms or, when none, the normalized or mapped name, or cite a
  URL that was not fetched.

<!-- markdownlint-disable MD024 -- repeats the approved subheadings. -->

## Batched Lookup Amendment

**Status: approved for planning, 2026-11-19.** The user explicitly approved
the reviewed draft after a fresh-context review whose blocking findings were
resolved. Plan and execution approval remain separate gates, and approval
does not set any limit value. Scoped to
[#380](https://github.com/andrewpucci/dependency-update-advisor/issues/380)
(limit register L8). Effort tier: L. It amends "Exact GitHub advisory
queries", which deferred batching until it had an amended contract and
fixtures. The [policy signals spec](SPEC-policy-signals.md#batched-malware-lookup-amendment)
applies the same rule to malware queries.

### Why

The workflow token gets 1,000 REST requests per hour per repository
([GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
checked 2026-11-19), and Dependabot can open several PRs in the same hour.
Measured on 2026-11-19, one exact query per target per side made 196 of PR
#276's 556 GitHub requests, and malware queries made another 102. Every one
of those 298 responses was an empty list.

### Decision for review

Check eligible targets in batches, and keep today's singleton query for any
target a batch cannot settle.

1. **Batch query.** Before per-member collection, a pre-pass groups each
   stage's eligible exact targets by API ecosystem, side, and advisory type.
   It sends one query per group with the same fixed filters as the singleton
   query and an `affects` list of exact `package@version` targets, built
   locally in a deterministic order. GitHub returns advisories that "affect
   any of package or package@version", up to 1,000 packages, as long as the
   URL fits
   ([global advisories](https://docs.github.com/en/rest/security-advisories/global-advisories),
   checked 2026-11-19).
2. **Register entries.** Targets per batch, URL length, and the batch page
   size each get a register entry. The page size must fit the per-response
   cap, as [evidence coverage](SPEC-evidence-coverage.md) §1.6 requires: one
   `Pillow@8.0.0` singleton page was 539,431 bytes on 2026-11-19. The plan
   proposes all three values after the equivalence check, as an Ask-first
   decision; approving this amendment does not approve values.
3. **Complete batches only.** Follow every page within bounds, under the
   existing cursor rules. A batch is complete only when every page succeeded
   and validated. An incomplete batch clears nothing. Its targets fall back to
   singleton queries while the reader can still read; after a rate limit,
   which stops all requests in the session as today, each unsettled target
   gets the stop reason.
4. **Clearing rule.** In a complete batch, a target is cleared when no
   returned advisory names its package, in the batch's ecosystem, in any
   `vulnerabilities` entry. A cleared target has the same outcome as a
   singleton query for it that returned no active matches: an advisory GitHub
   matches to that target is returned by the batch and names its package.
   This claims equivalence with the singleton query, nothing stronger; see
   item 9.
5. **Attribution from a batch record (decided 2026-11-19).** A returned record
   whose entries in the batch's ecosystem name exactly one batched package
   applies to that target: GitHub returned it because it affects some batched
   target, and it names no other. The record is attributed to that target
   without a singleton query, and S1's record validation applies unchanged.
   A target named by any record that names two or more batched packages gets
   today's singleton query, whose result decides. Singleton queries for named
   targets run before the stage sends further batches. Without this item, a
   failed singleton query would discard a known positive: S3 emits malware
   "even if another page fails", and the C3 `incompleteEvidence` gap can be
   relaxed to `merge`.
6. **Name comparison.** Entries in other ecosystems are ignored for clearing
   and attribution but still validated; GitHub returns them routinely (the
   npm `lodash@4.17.20` results include a RubyGems `lodash-rails` entry).
   Names in the batch's ecosystem are compared exactly as the query sent
   them. A malformed entry, or a returned advisory that names no batched
   package, means the comparison cannot be trusted, and the whole batch falls
   back.
7. **Provenance (decided 2026-11-19).** A cleared target cites the singleton
   query URL that reproduces its empty result, and its source text says it was
   checked in a batched query. This amends "Evidence Representation" ("Use
   the query URL for a successful empty lookup"): that URL was not itself
   fetched. Citing the batch query was rejected because its URL can exceed
   the packet's source text limit.
8. **Bounds and cache.** The pre-pass's requests and bytes count against the
   stage's share, not any member's allowance. Batches are cached by full URL
   like other research reads; a singleton query is never answered from a
   batch entry.
9. **Eligibility and name form are unchanged.** GitHub silently ignores a
   target it cannot parse, in a batch and a singleton query alike, and it
   matches names in the case it stores them (2026-11-19: `pillow@8.0.0`
   returned 26 advisories, `Pillow@8.0.0` 46). S1 sends lowercase PyPI names
   today, so singleton queries already miss some PyPI advisories. Batching
   inherits that gap without widening it; fixing the query name form is a
   separate S1 change.

### Verification

- **Recorded equivalence check.** Before the batch path is enabled, query
  real targets both ways and record that every singleton match is returned
  and named by its batch. PR #276's targets alone are not enough: all 298 of
  its advisory and malware responses were empty. Seed the check with known
  positives, among them `lodash@4.17.20`, `@babel/traverse@7.22.0`,
  `Pillow@8.0.0`, `tj-actions/changed-files@45.0.7`, and a known npm malware
  package, with one positive placed last in a batch at the proposed maximum
  size. Record what GitHub does above 1,000 targets. A probe on 2026-11-19
  with four npm targets matched: the batch returned the same 7 advisories as
  the four singleton queries (4, 3, 0, 0).
- **Remeasure.** Rerun `npm run measure:demand` over the L8 corpus; L8's
  fitted advisory and malware rates come from that run.

### Fixtures

- An empty complete batch clears every target, and every cleared target
  appears in a fetched batch URL.
- A record naming one batched package is attributed to it with no singleton
  query.
- A record naming two batched packages, one at a version it does not affect:
  both get singleton queries, and those decide.
- A record with an entry in another ecosystem: that entry is ignored.
- A returned record that names no batched package: the batch falls back.
- A failed second page: every target in the batch falls back; after a rate
  limit, unsettled targets get `rate_limit`.
- An oversized page: the batch falls back within the stage's share.
- A malformed `vulnerabilities` entry: the batch falls back.
- A scoped npm name.

### Amendment boundaries

- **Always:** clear a target only from a complete batch, attribute a batch
  record only when it names exactly one batched package, keep singleton
  queries for every other named target, and leave the meaning of complete
  vulnerability coverage unchanged.
- **Ask first:** batch size, URL length, and page size values, a local range
  evaluator, or caching across runs.
- **Never:** clear a target from a partial or failed batch, attribute a
  record that names two or more batched packages, or drop a target from
  accounting.

<!-- markdownlint-enable MD024 -->

## Batching Reconciliation Amendment

**Status: draft for review, 2026-11-20.** The user approved decisions D1–D4
below on 2026-11-20 in
[#408](https://github.com/andrewpucci/dependency-update-advisor/issues/408).
This section records them; it is not approved until a fresh-context review
passes and the user approves it. Plan and execution approval remain separate
gates, and no limit value changes. Effort tier: L. It reconciles the
[Batched Lookup Amendment](#batched-lookup-amendment), approved 2026-11-19
before the name form change, with the
[Package Name Form Amendment](#package-name-form-amendment), approved
2026-11-20. Neither section's text is edited; where they conflict, this
section decides. The
[policy signals spec](SPEC-policy-signals.md#batching-reconciliation-amendment)
applies it to malware queries.

### Why the amendments conflict

The Batched Lookup Amendment batches the one exact GitHub query each target
had on 2026-11-19. The Package Name Form Amendment then replaced that query
for every target except npm: `pip` reviewed lookups go to OSV, and Actions
reviewed lookups and `pip` and Actions malware lookups discover stored name
forms before one versioned query. A versioned query depends on its target's
own discovery, so the batch rules cannot apply to it unchanged.

### Reconciliation decisions

1. **`pip` reviewed lookups are not batched (D1).** OSV requests do not use
   the GitHub request budget that batching protects. OSV's
   `POST /v1/querybatch` returns only each record's `id` and `modified`, so it
   cannot check `github_reviewed`, and OSV's documentation does not claim it
   returns the same set as `/v1/query`. Batching would also widen W2
   Amendment 6's no-write exemption. `querybatch` stays an Ask-first option.
2. **npm keeps the batch rules (D2), with three changes.**
   - An attributed record's several same-package entries are joined into one
     range, as Package Name Form item 8 requires, instead of failing.
   - A GitHub rate limit stops GitHub requests only, as Package Name Form
     item 9 requires. Batch item 3's "which stops all requests in the session"
     no longer holds.
   - The batch page size is fitted to an npm example measured by C2, not to
     the `Pillow@8.0.0` singleton page in batch item 2. The value is still an
     Ask-first decision at C3.
3. **Discovery is batched across targets (D3).** A discovery batch is the
   set of package-only queries that together list every spelling of several
   targets of one ecosystem and advisory type. It keeps Package Name Form
   item 6's request rules unchanged: the URL cap
   (`limit:advisory.discovery.urlBytes`), the first-URL cursor headroom
   (`limit:advisory.discovery.cursorHeadroomBytes`), the page size
   (`limit:advisory.discovery.pageSize`), the cursor rules, a continuation URL
   over the cap being `budget`, and the separator-run limit. Item 10's
   spelling ceiling and versioned-URL bound also apply per target.
   - **Complete.** A discovery batch is complete only when every page of
     every one of its requests succeeded and validated, and every spelling of
     every batched target appears in a fetched discovery URL.
   - **Matching.** A record names a target when it has an entry in the query
     ecosystem whose name, canonicalized, equals the target's canonical name,
     as Package Name Form item 6 defines it. The same comparison decides
     validation, hits, and stored forms. A target's stored forms are the
     distinct matching names across every record in the batch.
   - **Validation.** Every returned record must name at least one batched
     target. Otherwise the batch is `malformed`.
   - **Clearing.** A target that no record names in a complete batch is
     cleared without its versioned query. It cites the unfetched versioned
     URL that would reproduce the empty result: the normalized name for
     `pip` or the mapped name for Actions, at the target's version. Its
     source text says it was checked in a batched query, as batch item 7
     does for npm. This reverses Package Name Form item 7's "always sends"
     for cleared targets only.
   - **Hits.** A target that a record names gets its versioned query for its
     stored forms, as today. Discovery never attributes a record: a malware
     hit followed by a failed versioned query is incomplete, with no
     finding.
   - **Fallback.** An incomplete batch clears nothing, and every one of its
     targets falls back to per-target discovery. Per-target discovery follows
     Package Name Form items 6 and 7 unchanged, including the versioned query
     after an empty discovery.
4. **Superseded text (D4).** Where they conflict, this section replaces:
   - Batched Lookup Amendment items 1–7, its fixtures, and its boundaries,
     which now apply to npm only; versioned batches are npm only.
   - Batched Lookup Amendment item 9, replaced by the Package Name Form
     Amendment.
   - The `Pillow@8.0.0` seed of the equivalence check, which is dropped.
   - Package Name Form item 7's "always sends one query", which gains the
     clearing exception in decision 3.
   - The Package Name Form boundaries "clear a target only from a complete
     OSV query or a complete versioned query after a complete discovery" and
     "Never … cite a URL that was not fetched", which gain the same
     exception for a target cleared by a complete discovery batch.
   - The Package Name Form verification "An empty discovery is followed by a
     versioned query for the normalized name", which now holds for
     per-target discovery only.
   - "Evidence Representation" ("Use the query URL for a successful empty
     lookup"), which gains the discovery clearing exception alongside batch
     item 7's npm exception.
   - The Package Name Form cost statement "Actions and malware targets cost
     at least one more GitHub request each" and its group capacity figures,
     which now bound the per-target path only.

### Reconciliation verification

- **C1** records the targets the reader settles, not discovery spellings or
  OSV lookups.
- **C2's equivalence check** is seeded with `lodash@4.17.20`,
  `@babel/traverse@7.22.0`, a known npm malware package,
  `tj-actions/changed-files@45.0.7`, and `flo-pro-adk`, plus a name with three
  or more separators. It adds a discovery comparison: every stored form that
  per-target discovery finds is returned and named by its discovery batch.
- **C5** settles both batch kinds.

### Reconciliation fixtures

- The attributed-record survival fixture is npm only.
- A discovery hit followed by a failed versioned query: the lookup is
  incomplete, and no finding is emitted.
- An empty complete discovery batch clears each target, citing its
  unfetched versioned URL.
- Every spelling of each cleared target appears in a fetched discovery URL.
- A record in a discovery batch that names no batched target: the batch is
  `malformed`.
- A stored name that differs from the target in case and separators (for
  example `Jupyter_Server` for `jupyter-server`) is a hit, not a clear; the
  mutation `stored === canonical(target)` fails this fixture.
- A discovery batch whose second request fails: every target in the batch,
  including those the failed request did not carry, falls back to
  per-target discovery.

### Reconciliation boundaries

- **Always:** clear a discovery target only from a complete batch, send the
  versioned query for every discovery hit, and keep npm's batch rules as
  approved except where decision 2 changes them.
- **Ask first:** `querybatch`, and every value the batch amendments mark Ask
  first.
- **Never:** batch `pip` reviewed lookups through OSV without a new decision,
  attribute a record from discovery, or clear a target from an incomplete
  discovery batch.
