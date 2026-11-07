# Spec: S3 Advisory Policy Signals

Status: approved for execution, 2026-11-07. Supporting contract for
`shared-review` in
[the capability map](README.md), scoped to
[issue #53: S3](https://github.com/andrewpucci/dependency-update-advisor/issues/53).
This supplies evidence to the approved [C3 policy](SPEC-advisory-policy.md);
it adds no capability-map module or dependency direction. Specification,
planning, and execution approval remain separate gates.

Specification approval, 2026-11-07: the user reviewed and updated the draft,
then invoked `as-plan`. Under the repository approval rule, this approves
the revised specification for planning, including its removal coverage,
streaming npm timestamps, publisher-kind and maintainer-snapshot comparisons,
trust chronology attribution, and same-commit Actions release selection.
The ordered handoff is `tasks/plan.md`; implementation tasks belong under
issue #53 on the implementation project. Plan approval, dependency pins,
and execution approval remain separate and are not recorded by this step.

Implementation handoff:
[#195–#207 under #53](https://github.com/andrewpucci/dependency-update-advisor/issues/53)
cover malware, bounded ecosystem metadata, exact artifact attribution,
license normalization, outcome preservation, integration, and verification.
Tasks #195–#206 are implemented on the working branch; final review and
verification disposition remain in
[#207](https://github.com/andrewpucci/dependency-update-advisor/issues/207).

Plan and execution approval, 2026-11-07: the user invoked `as-build auto`
in response to the proposed thirteen-task plan and its three exact dependency
pins. This authorizes #195–#207 in dependency order, per-task commits,
verification checkpoints, and issue/project progress updates without stopping
between successful tasks. New decisions still require user input. Publication,
merge, adoption, parity, and cutover remain separate gates.

## Objective and Scope

Give maintainers source-backed malware, release, publishing, license, and
Actions pinning evidence for every resolved changed dependency, including
transitive members. Successful security checks must describe the exact target
checked. Missing optional metadata must remain visible without becoming a
required-evidence failure or an invented finding.

S3 consumes immutable [N1](SPEC-npm-inventory.md),
[X1](SPEC-actions-inventory.md), and [U1](SPEC-uv-metadata.md)/
[U2](SPEC-uv-relationships.md) changes, [S2](SPEC-upstream-evidence.md)
public-identity proofs and Actions mappings, and
[S1](SPEC-advisory-lookup.md) vulnerability evidence. It enriches the existing
[T4 packet](SPEC-review-packet.md) for [T5](SPEC-decision-units.md) and C3.
S2 proof acquisition is an integration dependency beyond the issue's original
S1/N1/X1/U1 blockers; a mock proof does not certify that handoff.

S1 retains reviewed vulnerability queries and severity normalization. S3 owns
explicit malware queries, optional policy metadata, normalized license
comparisons, and deterministic findings from those facts and immutable
inventory. N2 retains required install-script evidence; collectors retain
package-source and Actions reference identities. S3 does not regroup changes,
change policy defaults, assess compatibility, call a model, render or publish
a review, package the action, adopt consumers, or authorize cutover. The old
reviewer stays active.

## Inputs and Handoff

1. Trusted orchestration supplies a validated T1 binding, immutable changes,
   their sources, existing findings, S1/S2 proofs and lookup results, and
   explicit budgets and evaluation time. Validate unknown input and exact
   source attribution before network I/O. Invalid or unavailable inventory
   cannot become an empty successful collection.
2. Check malware for every proposed resolved version/ref. T4 requires
   malware coverage for every change, including removals, from the head
   side when one exists and otherwise the base side. Query a removal's base
   resolved version/ref, without inventing a proposed version. A base-side
   match is a cited observation; it never emits `affects_proposed` or
   claims that the removal resolves malware.
   Collect proposed publish time and deprecation/yank state; collect current
   and proposed publisher, trust, and license facts when those sides exist.
   Retrieve base publish time when needed to prove a trust downgrade.
3. Preserve distinct roots, installed npm aliases, uv sources/markers/extras,
   and Actions occurrences. A shared request may serve identical targets;
   sources, side outcomes, and findings must remain attributed to each
   member. Group membership never substitutes for a member's malware check.
   Declaration-only npm records keep empty research and receive no lookup.
   Unresolved uv members retain collector gaps, rather than guessed versions.
4. Return detached immutable enrichment preserving the binding, inventory,
   relationships, unrelated research categories, and existing findings. Add
   scoped sources, per-member evidence, deterministic findings, and bounded
   attempt outcomes. Repeated enrichment must not duplicate equivalent
   sources/findings or silently replace contradictory evidence.
5. Separate `enriched`, invalid-input, and fixed-reason unavailable outcomes.
   A failed optional lookup is a member signal outcome within enrichment;
   it is not a top-level failure. If safe bounded output cannot retain known
   findings and required failure diagnostics, return unavailable rather than
   a successful truncated packet.
6. Orchestration assembles all ecosystem slots and C2 context, validates T4,
   then invokes T5/C3 and later M2/O1/W2. S3 never certifies execution success.
   Keep per-side lookup attempts separate from packet version 1, which has
   no attempt-history field; workflow integration must carry these outcomes
   to assessment/rendering without silently discarding them.

## Required Evidence, Optional Signals, and Information

Use the existing classification, without adding configuration or changing C3:

| Evidence                                           | Failure or absence                                                                              | Successful observation                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Malware lookup                                     | Required `malware` coverage is partial/unavailable with a fixed reason. Never infer no malware. | Exact complete query is available; active applicable matches emit `malware`.                                            |
| Publish time                                       | `publishTime` unchecked signal with its reason.                                                 | `releaseMetadata.publishedAt` in UTC epoch milliseconds.                                                                |
| Deprecation/yank                                   | `deprecation` unchecked signal with its reason.                                                 | Positive registry marker emits `releaseMetadata.deprecated`; complete negative observation remains evidence.            |
| Trust/provenance                                   | `trust` unchecked signal with its reason when unexposed, failed, or ambiguous.                  | Comparable version-bound observations may establish a downgrade; documented absence on both sides is no finding or gap. |
| Publisher                                          | `publisher` unchecked signal with its reason when unexposed, failed, or ambiguous.              | Comparable version-bound identities may establish a change.                                                             |
| License                                            | Missing, failed, unknown, or unparseable data stays informational, with a bounded reason.       | Different verified normalized expressions emit `licenseChange`.                                                         |
| Install scripts, package source, Actions inventory | Preserve required coverage under the owning collector contract.                                 | Preserve existing findings; exact inventory can support source/identity/pinning findings.                               |

An unchecked signal never creates or removes a finding, triggers
`incompleteEvidence`, or alone fails execution status. License information
must not be linked as failed required `upstream` evidence. A metadata request
used by several categories records each category's independent result: a
publish-time failure cannot erase successful malware coverage, and optional
metadata cannot satisfy required upstream or vulnerability research.

## Exact Targets and Allowed Sources

Reuse S1's `PublicPackageIdentity` and `ActionVersionMapping` attribution
requirements and S2's public-origin proof acquisition. Public lookup
eligibility requires the immutable recorded registry source, exact actual
package name/version, and attributable proof. Do not send private/custom
registry names to public namesakes. Preserve npm alias targets, PyPI name
normalization, exact uv variants, Actions subpaths and reusable-workflow
identities. An unsupported mapping leaves explicit uncertainty.

Use locally constructed HTTPS routes on `registry.npmjs.org`, `pypi.org`,
and `api.github.com`. Reuse bounded N2/S2 readers or validated observations
where they provide the necessary fields and exact attribution. Extending a
reader must preserve its existing identity, integrity, and failure checks.
S2 excerpts alone are not structured publish-time, trust, or publisher proof.
Do not scrape package pages, download/install packages, execute upstream code,
or fetch arbitrary metadata/reference URLs.

### Malware and severity

The [GitHub global advisory API](https://docs.github.com/en/rest/security-advisories/global-advisories)
excludes malware by default. Use a separate exact ecosystem/package/version
query with `type=malware`; v1 uses GitHub rather than adding an OSV adapter.
Keep S1's `type=reviewed` vulnerability check independent. uv queries use API
ecosystem `pip`; packet sources and members retain ecosystem `uv`.

Apply S1's canonical advisory URL/ID, package-entry, affected-target,
withdrawal, pagination, conflict, and bounded positive-retention checks to
malware records, accepting only the requested malware type. Querying a SHA
requires S2's attributable exact ref-to-version mapping; do not guess a
semantic version. Preserve original refs in packet subjects. Without a
usable mapping, malware coverage remains required and unavailable.

An active attributable proposed-side match emits `malware` with
`affects_proposed`, even if another page fails. Retain withdrawn records as
non-active observations. A successful empty complete exact query means only
that this provider returned no active matching malware records. Empty
comparison data, S1 results, and prose never establish malware coverage.
Conflicts leave the affected check incomplete while retaining independent
nonconflicting positives. A failed recheck cannot clear an existing finding.

Malware coverage is provider-scoped and varies by ecosystem. GitHub
publishes PyPI malware under ecosystem `pip`, but has few or no `actions`
malware records. An Actions malware source must say that it records
GitHub's advisory result, not a scan of the action's code.

Retain S1's tested mapping of GitHub `medium` to `moderate` and `unknown` to
omitted severity. Unexpected values remain malformed, never low. Malware
holds are independent of severity and cannot be relaxed by configuration.

### Publish time and deprecation/yank

For npm, use full [package metadata](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
`time[exactVersion]`, paired with the validated exact-version document that
N2 reads. Only full metadata exposes `time`; the abbreviated document and
the version document do not. Full metadata for popular packages can be tens
of megabytes with thousands of `time` entries. Read it with a streaming
extractor that retains only the current and proposed `time` entries. Skipped
content counts toward byte, work, and duration limits, not retained-entry
limits. This read has its own optional budget. Exhausting it leaves publish
time and trust chronology unchecked, never required evidence incomplete.
Never use package creation/modification time or a dist-tag as the version's
publication time. Read the exact version's `deprecated` message; retain a
bounded reason.
Missing/empty markers mean not deprecated only in a complete supported
version response; malformed or incomplete responses are unchecked.

For PyPI, the [release JSON endpoint](https://docs.pypi.org/api/json/#get-a-release)
provides exact-version metadata and file upload times. Define release publish
time as the earliest valid upload time among the complete returned release
files; later wheel uploads do not reset release age. No files, invalid times,
identity conflicts, or incomplete enumeration leave the signal unchecked.
Preserve that derivation in provenance. The timestamp is registry release
availability, not source commit time.

[PyPI yanking](https://docs.pypi.org/project-management/yanking/) currently
applies to entire releases. Validate the release marker against file markers
when supplied; retain the reason, including an empty reason. Contradictory
mixed file state is unchecked with `conflict`, never an invented release-wide
negative. Missing booleans or wrong types cannot become `false`.

For Actions, use `published_at` from an attributable, non-draft
[GitHub release](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
for the recorded ref. Floating tags such as `v5` usually have no release of
their own. In that case, use a non-draft release whose tag S2 proves
resolves to the same commit as the recorded ref. When several qualify, use
the earliest `published_at` and record the selected tag. Do not use
`created_at`, tagger/commit time, the latest release, or a repository-root
release for an unproven component. No attributable release means unchecked
publish time; a SHA without an S2 mapping has no release publication time.
Absent an equivalent supported deprecation marker, Actions deprecation is
explicitly unsupported and unchecked.

Validate timestamps with explicit timezone and finite safe millisecond
conversion. A future timestamp relative to the supplied evaluation time is
conflicting metadata, not a negative release age. Emit the fact; C3 alone
applies the configured age window and verified S1 security-fix exemption.
S3 must neither read Dependabot cooldown nor suppress other findings for a
fresh security fix.

### Trust and publisher comparisons

Retain the observation type and evidence level, not an unexplained numeric
trust score. Distinguish registry-reported trusted publishing, registry-reported
attestation presence, independently verified attestation if supported,
documented absence, and unknown. A metadata pointer is not a verified
attestation. An unsupported signature/predicate or failed verification is
unchecked, never verified absence. Do not equate a registry signature with
trusted publishing or provenance, or infer safety from any of these signals.
The [npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements/)
expressly limits what provenance establishes.

Compare like evidence from the same supported mechanism for both exact
versions. A downgrade requires an earlier-published current version with
positive trusted-publishing/provenance evidence and a proposed version with
confirmed weaker or absent corresponding evidence. Preserve the ordering
proof and both observations. T4 lets a `trust_downgrade` finding cite only
`trust` sources, so record the ordering proof as a `trust` source for the
chronology response. Its subjects cover both sides, and its excerpt states
both publish times. Missing chronology or an unknown side leaves trust
unchecked. A current version published after the proposed version is
known chronology with no downgrade: the proposed version predates the
current guarantee. Do not invent an ordering between unrelated mechanisms;
losing one known guarantee remains a downgrade even if another is present.
Documented absence on both sides is neither a downgrade nor a gap. This
scope compares recorded current/proposed versions, without scanning unrelated
package history.

For npm, the registry documents version-specific
[`_npmUser`](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
as the publishing user. Compare a stable public account identifier, excluding
email. A trusted-publisher identity requires an exposed version-bound
`_npmUser.trustedPublisher` record. Its provider and configuration IDs form a
separate namespace from human accounts. Its display name, such as
`GitHub Actions`, is not an account. Compare identities only within one kind:
human account names, or trusted-publisher provider/configuration IDs. A
change of kind between the two versions is itself a `publisher` change.
Retain both kinds in the finding, never a cross-namespace name comparison.
Losing trusted publishing also feeds the trust comparison above.

The exact version document's `maintainers` array is a publish-time snapshot.
C3 counts a changed maintainer as a publisher signal. Compare the set of
public account names, excluding email, between the two version snapshots;
a different set emits a `publisher` change. Package authors, git committers,
and the package-level current maintainer list cannot establish who published
or maintained an earlier version.

PyPI's [Integrity API](https://docs.pypi.org/api/integrity/) is per distribution
file. Artifact provenance may support a scoped observation only when its
project/version/filename and digest bind to the relevant locked artifact.
Never choose an arbitrary wheel to stand for all uv platforms/extras. A
version-level conclusion requires complete compatible observations for the
relevant artifact set; incomplete, conflicting, or unbound observations are
unchecked. Self-declared author/maintainer fields are not publishing accounts.
PyPI exposes no version-bound maintainer snapshot, so maintainer comparison
is unsupported and unchecked.
Actions release authors and repository owners likewise do not establish
registry publisher or trusted-publishing identity.

Before implementation, the plan must identify each supported trust field or
endpoint, its absence semantics, artifact scope, and any verifier dependency.
Unsupported mechanisms produce explained unchecked signals. Downloading and
cryptographically verifying attestation bundles is not implicitly authorized
by approving a metadata collector; any such implementation scope and exact
dependency pins require explicit plan approval.

### Licenses and Actions inventory

Use exact-version declared npm license metadata and PyPI structured license
expressions when exposed. Python's
[Core Metadata license contract](https://packaging.python.org/en/latest/specifications/core-metadata/#license-expression)
distinguishes structured expressions from legacy free text. Accept a legacy
value only if it parses as a supported license expression; do not guess from
classifiers, prose, file names, or a repository's current default-branch
license. Actions license facts likewise need attributable structured evidence
at the recorded ref; otherwise retain unknown information.

Normalize parsed expressions to stable formatting, including whitespace and
redundant grouping, while preserving identifiers, `AND`/`OR`/`WITH` semantics,
exceptions, and `-only`/`-or-later`. Never compare by lowercasing arbitrary
text, stripping punctuation, or sorting tokens. Emit `licenseChange` only
when both sides are known and normalized expressions differ. Retain old/new
values, sources, affected member, and a request to confirm terms. Add no
license allowlist, denylist, or configuration. Parser choice and any new
dependency remain planning decisions requiring approval.

Consume X1's immutable occurrence pairing and ref kinds. Only the recorded
full 40-hex commit SHA is immutable; a tag resolved to a SHA by research
remains a mutable inventory ref. Emit `supplyChainChange` for paired owner or
repository changes, and for full-SHA to tag/branch/other mutable ref changes.
Unknown non-SHA refs remain mutable for this comparison. Preserve original
case/text but compare repository identity as T4 does. A subpath edit alone
is not an owner/repository change. Cite both immutable workflow sides;
additions/removals or unpaired occurrences cannot invent a two-side finding.
Retain collector coverage gaps independently.

## Representation and Bounds

Use existing `PacketChange`, `PacketSource`, `ChangeEvidence`, and `Finding`
types. Source kinds are `malware`, `publishTime`, `deprecation`, `trust`,
`publisher`, and informational `metadata`; do not add a required license
category. Optional category names must exactly match T4/T5/C3. Each failed
optional category retains its specific reason and sources. Two-side signals
retain side outcomes separately and cannot appear complete if a required
comparison side failed; proposed-only signals need no invented base lookup.
T4 accepts these entries as `available` with a head-side source alone, so
S3 must mark a two-side signal `partial` when its base side failed.

T4 maps `metadata` sources to the required `upstream` category. License
sources therefore never appear in any `ChangeEvidence` entry; only
`licenseChange` findings cite them. A failed license read is an unlinked
`unavailable` `metadata` source with its reason. `informational` findings
cannot cite unavailable sources, so workflow integration carries that
reason to rendering with the attempt outcomes.

Successful upstream sources carry safe HTTPS URLs, bounded factual excerpts,
exact member/side subjects, and non-null inventory endpoint ranges when
cited by findings. Advisory-specific sources carry the advisory ID and
affected expression separately from that endpoint range. Unavailable
provenance need not invent a URL. License/publisher/trust comparisons cite
both sides; release metadata cites the head; Actions identity/pinning cites
both immutable files. An excerpt cannot claim verification of omitted data.

Keep bounded per-side attempts with category, exact target, safe URL when
known, outcome, fixed `EvidenceReason` values, source IDs, and truncation.
Distinguish unattempted budget exhaustion from a request failure. Use the
existing reasons for missing, malformed, unsupported, conflict, permission,
rate limit, timeout, truncation, budget, and unknown as applicable; network
failures use `unknown` rather than inventing a new packet reason.
Do not expose raw exception bodies, publisher email, credentials, or consumer
metadata in diagnostics.

Use injected fetch, clock, and cancellation. Explicit caller limits bound
requests/pages, streamed response and total bytes, JSON depth/entries, work,
attempts, findings, retained output, and request/total duration. Preserve T4
caps; no new numeric quality thresholds are introduced here. Share requests
only by exact target and query kind within a review; malware and reviewed
advisory caches cannot collide. Optional work must not consume a reserved
required-security budget and prevent malware checks.

Reject redirects and non-allowlisted continuations; validate same-host
pagination, unchanged filters, cursor progress, and complete final pages.
Allow no generic URL fetcher. Registry requests receive no GitHub credential.
Credential routing remains trusted workflow responsibility; S3 never receives
the comment/status App token, model secret, cookies, or source excerpts.
Close readers and cancel unused bodies/timers after completion or abort.

## Tech Stack, Structure, and Code Style

Use the repository's Node.js `>=24.11.0 <25`, ESM, strict TypeScript, pinned
toolchain, and source-adjacent `vite-plus/test` tests. Reuse existing bounded
readers and pure normalization helpers where their contracts fit. No new
dependency is approved by specification approval. Proposed file placement:

```text
src/evidence/policy-signals.ts           → orchestration and scoped enrichment
src/evidence/policy-signals-read.ts      → bounded metadata adapters
src/evidence/policy-signals*.test.ts     → fixtures and integration handoffs
src/evidence/advisory-read.ts           → explicit query-type support, preserving S1
src/evidence/advisories.ts              → existing identity and attribution boundary
src/evidence/npm-registry.ts            → reusable exact npm metadata/integrity reads
src/evidence/upstream*.ts               → reusable S2 proof and release observations
src/schema.ts / src/units.ts / src/policy.ts → existing validation/grouping/policy
```

Keep unknown external data outside typed facts until runtime validation.
Use discriminated outcomes so a failed lookup cannot masquerade as absence:

```ts
type Observation<T> =
  | { kind: 'known'; value: T; sourceIds: readonly string[] }
  | { kind: 'unchecked'; reason: EvidenceReason; sourceIds: readonly string[] };
```

This illustrates style; the implemented entry point is `enrichPolicySignals`
in `src/evidence/policy-signals.ts`. Keep transport,
normalization, and policy evaluation separate; prefer existing packet and
finding variants over parallel schemas.

## Commands and Testing Strategy

For documentation-only specification/plan changes, run the existing commands:

```sh
npm run lint:md
npm run format:check
git diff --check
```

After implementation, run the repository checks on the exact shared revision:

```sh
npm run lint
npm run format:check
npm run check
npm test -- --run
git diff --check
```

Use the pinned toolchain and `npm ci` only if installation is needed. Do not
claim a build command or live shared reviewer exists. Record exact revision,
commands, outcomes, and integration limits in the implementation issue/PR.

Use sanitized synthetic HTTP fixtures with injected fetch/clock/cancellation.
Each behavior change leaves a check that would catch its defect; retain
existing S1/N2/S2 checks when extending readers. Required cases:

| Fixture                                                                                    | Required assertion                                                                                        |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Active malware, including a transitive member; relaxed policy overrides                    | Explicit `type=malware` request; attributed finding survives T4/T5 and C3 always holds.                   |
| Empty malware response; reviewed response only; unsupported exact mapping                  | Only a complete malware query satisfies coverage; other cases cannot mean no malware.                     |
| Removal with clean and malicious base versions; Actions empty malware response             | Base-side query satisfies T4 coverage; no `affects_proposed`; Actions source states provider scope.       |
| Malware final-page failure, withdrawn/conflicting records, positive before failure         | Preserve independent positives and incomplete coverage; withdrawn records do not actively hold.           |
| GitHub `medium`, `unknown`, and unexpected severity                                        | S1 normalization preserved; malformed values never become permissive policy input.                        |
| Fresh version; exact age-window boundary; fresh verified S1 security fix                   | C3 computes age/exemption for the correct member and retains other findings.                              |
| npm time map and version identity; PyPI multiple file uploads; Actions mapped release      | Exact publish time; earliest release upload; `published_at` rather than commit/create time.               |
| Large full npm metadata streamed; extractor budget exhausted                               | Only two `time` entries retained; exhaustion leaves publish time and trust chronology unchecked.          |
| Floating Actions tag without its own release; several releases at one commit               | Earliest same-commit release is used and its tag recorded; no proven commit means unchecked.              |
| npm deprecated; PyPI yanked with/without reason; conflicting markers                       | Positive reason retained; failed/ambiguous optional metadata is unchecked.                                |
| Earlier current trusted/provenanced version to weaker proposed; absent on both             | Proven downgrade finding versus no finding/gap; unknown does not mean absent.                             |
| Downgrade chronology source; current published after proposed                              | Finding cites a two-side `trust` chronology source; later current version is known with no downgrade.     |
| Trust or publisher with a failed base side and successful head side                        | Entry is `partial` and an unchecked signal, never `available`; no finding.                                |
| Trust chronology failure, artifact mismatch, mixed uv artifacts, invalid attestation claim | No invented downgrade or verified trust; scoped unchecked reason survives.                                |
| Different exact publishers; unchanged account; mutable maintainer/author change            | Only comparable version-bound identities create a publisher finding; no email retained.                   |
| Human account to trusted publisher and back; changed trusted-publisher configuration       | Each kind change or ID change emits `publisher`; display names are never compared as accounts.            |
| npm version maintainer snapshots differ or match; PyPI maintainer comparison               | Different snapshot sets emit `publisher`; matching sets do not; PyPI stays unsupported and unchecked.     |
| License change, transitive change, formatting-only expression, missing/legacy garbage      | Verified semantic identifiers preserved; unknown remains informational; formatting alone emits no change. |
| Failed license read beside complete upstream evidence                                      | License source stays out of every evidence entry; no `upstream` gap; reason retained for rendering.       |
| Action owner/repository change, SHA-to-tag/branch/unknown, SHA-to-SHA, subpath-only edit   | Only contracted identity/pinning changes emit findings with both file citations.                          |
| Each optional signal: missing, 403, 429, timeout, malformed, unsupported, conflict, budget | Explained unchecked signal; no gap or required-status failure caused by it.                               |
| Same failures for malware, install scripts, or immutable Actions inventory                 | Required gap remains; optional success cannot mask it.                                                    |
| Private/custom source, aliases, repeated roots, uv variants, unpaired occurrences          | No private-name disclosure, guessed targets, cross-member findings, or grouping changes.                  |
| Redirect/pagination attacks, body/JSON/work/output limits, abort and rerun                 | Bounds hold, resources close, no silent omission or duplicate/conflicting success.                        |

Add a real collector/S2/S1/S3/T4/T5/C3 handoff for npm, Actions, uv, and a
mixed packet. Exercise available required evidence with only unchecked
optional signals, and assert no `incompleteEvidence` rule caused by those
signals; exercise malware failure and assert the required gap. Verify positive
findings, source categories, exact sides/ranges, unit attribution, and final
policy ceilings. Label unrelated C2/model/workflow scaffolding explicitly.
These checks do not certify live transport, M2 analysis, O1 rendering, W2
publication/status ownership, consumer adoption, parity, or cutover.

## Boundaries and Success Criteria

- **Always:** Validate exact targets and evidence provenance, retain every
  independent finding and coverage limit, distinguish optional signals from
  required gaps, use bounded reads, and preserve existing policy and trust
  boundaries. Keep private consumer data in consumer repositories.
- **Ask first:** Amend approved packet/policy/inventory contracts, add a
  provider/endpoint outside this scope, choose new dependencies or attestation
  verifiers, or change workflow permissions, publication, CI, or cutover.
- **Never:** Infer no malware from a failed check, invent publisher/trust or
  license facts, execute PR/upstream code, let provenance clear malware or
  other findings, suppress missing per-member evidence through grouping, or
  treat specification approval as plan/execution approval.

S3 is complete when all resolved proposed members receive explicit malware
outcomes, available policy facts produce attributable existing finding types,
all failed optional signals remain explained and non-failing, and real
T4/T5/C3 integration proves those distinctions within existing bounds.
Required install-script and inventory failures stay required. Revision-specific
verification and remaining downstream gates must be recorded before claiming
implementation completion.

Integration limits: X1 represents owner/repository replacements as removal
plus addition, so those records do not establish a paired S3 identity finding.
Rich research can reach T4's independent source/output caps before reaching
the 128-change limit; rejection remains explicit and fail secure. Live
transport, workflow diagnostics and budget allocation, M2/O1/W2, packaging,
adoption, parity, and cutover remain separate gates in #207.

## Approved Scope and Planning Decisions

The approved scope uses GitHub-only malware queries, comparison of recorded
current/proposed trust rather than historical scanning, and registry-reported
trust observations with explicit evidence levels. It also requires that
human/trusted-publisher kind changes and npm maintainer snapshot changes
emit `publisher` findings, and that a floating Actions tag uses the earliest
release at its proven commit. The implementation plan must enumerate
supported trust
metadata/absence semantics, artifact handling, license-parser support, the
streaming metadata extractor and any parser it needs, any exact dependency
pins, and caller budget allocation. These implementation choices require
separate plan approval before execution.
