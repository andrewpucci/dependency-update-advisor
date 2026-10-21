# Spec: T4 Common Review Packet Validation

Status: approved for T4 execution, 2026-10-20. Supporting contract for
`shared-review` in
[the capability map](README.md), scoped to
[issue #11: T4](https://github.com/andrewpucci/dependency-update-advisor/issues/11).
The [shared workflow contract](SPEC-shared-review.md) remains authoritative.
Approval: the user approved the full revised specification on 2026-10-20 and
invoked `as-plan`. The user then approved the eight-task plan and invoked
`as-build auto`, authorizing implementation and one PR for #11 and #77–#84.

Decisions approved by the user on 2026-10-20: require all three ecosystem
coverage slots; require inventory evidence for `not_applicable`; cap a packet
at 128 changes; reject overflow without exposing a usable partial packet.
Full-spec approval also covers the resource ceilings, finding links, and
intentional parity difference recorded below. Resource ceilings bound work;
they are not measured performance or test-coverage thresholds.

Clarifications approved by the user on 2026-10-21 during PR #89 review:
upstream excerpts may contain tabs, and relationship path instances must agree
with the changes' recorded instances.

## Objective

Give reviewer contributors one bounded, provider-neutral runtime boundary
between evidence collection and assessment. Accept immutable review identities,
distinct dependency changes, attributable sources, and honest coverage gaps.
Reject malformed or conflicting data before any decision unit or model request
uses it. Validation success means the packet is usable, not that its evidence
is complete, the dependencies are safe, or publication is authorized.

T4 validates collected evidence. [T5 #12](https://github.com/andrewpucci/dependency-update-advisor/issues/12)
forms decision units; [C3](SPEC-advisory-policy.md) evaluates deterministic
policy; [M2 #22](https://github.com/andrewpucci/dependency-update-advisor/issues/22)
validates assessments. Provider selection, credentials, effective configuration,
verdicts, model responses, rendering, and GitHub writes are outside this packet.

Implementation: the isolated [packet validator](../../src/schema.ts) and its
[fixtures](../../src/schema.test.ts) are implemented on this branch, pending
merge. [Verification issue #84](https://github.com/andrewpucci/dependency-update-advisor/issues/84)
records exact revisions and remaining integration gates.

## Inputs and Assumptions

- Issue #11's C1 #5 and T1 #8 prerequisites are closed. Existing
  `src/config.ts`, `src/event.ts`, `src/context.ts`, and `src/policy.ts`
  define the neighboring interfaces.
- This is one capability within `shared-review`; the approved module boundary
  and dependency direction remain unchanged. No new module is proposed.
- The caller supplies T1's verified binding separately from the candidate
  packet. W2 supplies authenticated, immutable base and trusted-context
  revision identities and C2's successful context result. A candidate packet
  cannot establish its own trust or source-disclosure permission.
- Collector code and orchestration are trusted; PR files, Dependabot text,
  package metadata, upstream text, and model output remain untrusted data.
  T4 checks consistency and attribution without fetching or proving the truth
  of source content. Trusted collection must establish that provenance.
- The collected packet precedes T5's units. The later analysis input adds
  ordered units and evaluated policy under the
  [analysis-provider contract](SPEC-analysis-providers.md); T4 does not accept
  caller-supplied grouping or verdicts as already validated conclusions.

## Tech Stack and Project Structure

Use Node.js `>=24.11.0 <25`, ESM, strict TypeScript, Node built-ins, and
source-adjacent tests importing from `vite-plus/test`. Preserve existing
dependency pins. No runtime validator dependency or published JSON Schema is
required for this internal packet boundary.

```text
src/schema.ts                      → packet types, limits, pure runtime validator
src/schema.test.ts                 → synthetic packet and boundary fixtures
src/event.ts                       → existing binding validation and identity semantics
src/context.ts                     → existing C2 result and disclosure boundary
src/policy.ts                      → existing C3 finding vocabulary
docs/specs/SPEC-review-packet.md   → this T4 supporting contract
```

Keep validation separate from collector I/O. Reuse existing identity and
finding contracts without weakening or silently changing them. Integration
adapters belong to their owning tasks; T4 must not implement collectors,
context collection, grouping, or publication to make a fixture pass.

## Packet Contract

### Envelope and immutable identity

The version-1 envelope has exactly `version`, `binding`, `baseSha`,
`contextRevision`, `coverage`, `changes`, `sources`, `findings`,
`relationships`, and `context`. All fields are required; empty arrays are
explicit. Reject unknown fields at every level. Context opt-out is an explicit
C2 disabled result, not omission or `null`.

`binding`, `baseSha`, `contextRevision`, and `context` repeat values the
trusted caller also supplies. The copies make an accepted packet
self-describing for T5, M2, and O1, which receive only the packet; the
equality checks below stop a packet from being paired with another review's
trusted inputs. The caller's values remain the authority.

1. Inspect closed fields and bounds before passing either binding to T1.
   Validate both the separately supplied binding and the packet binding using
   T1's `parseReviewBinding` semantics. Compare every binding field, including
   repository and head-repository IDs/names, workflow ID/path, run ID/attempt,
   PR number, actor ID, conclusion, head SHA, and the six-part identity tuple.
   Repository name casing follows T1. Reject contradictions rather than
   trusting a matching tuple alone. Apply the packet's closed-field and size
   checks in addition to T1's validator.
2. Require positive safe-integer IDs and attempts without coercion. Full Git
   SHAs are exactly 40 hexadecimal characters, normalized consistently with
   T1; reject shortened SHAs, branch names, tags, and synthetic placeholders.
3. `baseSha` must equal the caller's authenticated PR-base snapshot.
   `contextRevision` contains repository identity and a full commit SHA equal
   to the caller's trusted default-branch context snapshot. Never substitute
   the PR head for trusted context. T4 does not resolve Git refs or read GitHub.
4. Every immutable file source identifies repository, commit SHA, and path.
   Inventory sources use the verified base or head repository/revision as
   appropriate; trusted source facts use `contextRevision`. Upstream evidence
   records its exact package/version or Actions ref scope separately.
5. A verified identity is a snapshot. W2 must still acquire exclusive ownership
   and recheck freshness before T2/T3 publication. Packet validation grants
   neither freshness nor write authority.

### Separate ecosystem coverage

`coverage` has exactly `npm`, `actions`, and `uv`. Each slot contains an
inventory `status`, bounded `reasons`, and `sourceIds`. Status is exactly
`complete`, `partial`, `unavailable`, or `not_applicable`.

- `complete` requires successful inventory evidence for the ecosystem and no
  inventory gap. It may contain zero changes when a complete comparison of
  the relevant immutable inputs establishes that result.
- `not_applicable` requires bounded, completed changed-file/root inventory
  evidence establishing no relevant changed inputs. It requires zero changes
  in that ecosystem. An empty dependency comparison or a config omission is
  insufficient. A truncated file list cannot prove absence.
- `partial` and `unavailable` require at least one fixed reason code. Known
  changes survive either state; an unavailable inventory can retain a change
  identified from independent evidence without claiming completeness.
- Missing slots, unknown statuses, unsupported complete claims, or a gap
  alongside `complete`/`not_applicable` reject the packet. Valid incomplete
  inventory is accepted with its exact gaps, including a zero-change inventory
  whose collection failed. It must never become a successful empty review.

Inventory status is separate from evidence availability for each change.
Complete npm inventory does not erase incomplete Actions inventory or a uv
advisory failure. T5 and W2 must consume every slot, even when it has no
change to attach to a unit. A packet-wide inventory gap cannot disappear
because every retained change received an assessment.

### Dependency changes and identity

Every change has a unique `id`, `ecosystem`, explicit `kind` (`update`,
`addition`, or `removal`), `from`/`to` sides, role, source references, and
per-category evidence records. A missing side is exactly `null`: additions
have only `to`, removals only `from`, and updates have both. Reject two missing
sides, unchanged pairs, or a kind inconsistent with the sides.

Each non-null side includes the exact identity and immutable inventory source:

| Ecosystem | Identity retained on each side                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm       | Package root, package name, lockfile package path when present, exact resolved version, and package source identity. Keep aliases and distinct installed instances distinguishable.                                           |
| Actions   | Workflow path, job ID, step index for a step action or explicit job-level reusable-workflow location, owner/repository/subpath, exact ref and ref kind (`tag`, `branch`, `sha`, or `unknown`). A SHA ref requires a full SHA. |
| uv        | Project root, collector-normalized package name, exact resolved version, package source identity, applicable marker, and sorted distinct extra/group identifiers. Distinct locked variants remain distinct.                   |

Package sources distinguish registry, Git, URL, path, and workspace identities;
do not collapse a source change into a name/version-only update. Credentials
are never source identity. Versions and markers are bounded opaque strings:
T4 does not resolve ranges, infer Python environments, or invent semver for
Actions SHAs. A ref whose kind is unknown retains that uncertainty.

Role is exactly `direct`, `transitive`, or `unknown`. npm direct roles may
add the established production/development/peer/optional classifications.
An unsupported or unpairable change stays in the inventory with explicit
uncertainty; collectors can represent identifiable old/new sides as separate
removal/addition records instead of fabricating an update.

Reject duplicate IDs and duplicate semantic changes even when their IDs
differ. Within an ecosystem, one exact base-side instance or head-side
instance cannot belong to two changes. Repeated package names at different
roots/lock paths, repeated Actions occurrences, and uv variants are valid.
IDs must remain stable for the same reviewed head and semantic identity;
neither array position nor display name alone defines identity.

### Sources, evidence states, and findings

`sources` is a table of unique IDs. Each record names its source kind,
ecosystem scope, member scope where applicable, status, provenance, and bounded
coverage reasons. Kinds distinguish immutable file inventory, dependency
comparison, Dependabot corroboration, upstream release/comparison/metadata,
advisory, malware, install-script metadata, and the four optional signals.
Fixed failure reasons include `permission`, `rate_limit`, `timeout`, `missing`,
`malformed`, `unsupported`, `truncated`, `budget`, `conflict`, and `unknown`.
Never use a raw HTTP error or arbitrary exception as a reason code.

Every change explicitly accounts for required upstream, vulnerability, and
malware evidence, plus install-script metadata for npm, under the
[C3 evidence rules](SPEC-advisory-policy.md#1-classify-evidence-before-matching-rules).
Each category has status `available`, `partial`, or `unavailable`, source IDs,
and fixed reasons when incomplete. A failed lookup may omit a URL, but cannot
claim successful evidence or zero findings. `group_backed` is reserved for
T5's proven grouping; a collector packet cannot assert that grouping itself.
T5 maps these category records onto C3's `EvidenceSource` shape, including
its single `reason` and `coverageLimits`; T4 does not produce C3 sources.
The optional `publishTime`, `deprecation`, `trust`, and `publisher` lookups
retain their status as unchecked signals when unavailable; T4 must not turn
them into required gaps or policy findings.

Validate all source IDs against the exact table, their ecosystem/member
scope, category, side, and version/ref attribution. A shared file-list source
may support several ecosystems only with explicit scopes. An npm advisory
cannot substantiate an Actions member with the same display name. Duplicate,
dangling, cross-packet, wrong-side, and cross-ecosystem references reject the
packet. Dependabot text remains corroboration, never sole proof of complete
inventory or a verified blocker.

Upstream/advisory URLs must be absolute HTTPS URLs with a hostname and no
userinfo, control characters, or embedded credentials. File citations use
validated repository/path/SHA identities, not arbitrary file URLs. Successful
upstream records retain title, bounded excerpt, exact applicable range or
explicit unknown range, and truncation state. A claim outside the recorded
range cannot use that source. T4 validates references without following URLs;
collector host policies, redirects, and credential routing remain separate.

`findings` uses C3's existing discriminated finding vocabulary. Validate all
variant fields and enums, unique IDs, nonempty references, bounded
rationale/remediation/validation text, and category-specific source
applicability. Keep unscored advisories unscored; reject unknown severity
rather than weakening a blocker.

Approved linking rule: a finding's `memberId` must equal one
packet `changes[].id`. Each entry in `references` is a `sources` ID, not a raw
URL or path; the source record carries the vetted URL or file citation. Every
referenced source must apply to that change's ecosystem, member, side, and the
finding's category, and its recorded range must cover the claim. Renderers
resolve citations through the source table.

Conflicting applicability for the same advisory/member/side must become a
collector coverage gap, not two asserted facts. A verified incompatibility also
requires its trusted-context reference; model text and ordinary package usage
alone do not prove incompatibility. Acceptance preserves findings without
evaluating policy or claiming independent verification of upstream content.

### Relationship and source-context handoffs

`relationships` contains optional grouping evidence, not decision units. Each
proof names two distinct known change IDs in the same ecosystem/root, the
immutable lock source and side, and a bounded path of exact package instances
whose endpoints match those changes. Reject dangling, cross-root/ecosystem,
self-referential, repeated, or conflicting proofs: a path instance must agree
with other proofs and with the changes' recorded instances on that side,
ignoring which source record cites the lock file. An Actions
occurrence cannot masquerade as an npm/uv lock relationship. T5 must validate
graph sufficiency and ambiguity before assigning a group; merely accepting
the proof's structure does not establish a group.

`context` must equal the separately supplied trusted C2 success result. It
preserves C2's successful result shape, fixed statuses/reasons,
dependency IDs/names, facts, truncation flags, and existing limits. Every
enabled entry must match a packet change; each opted-in change has exactly
one entry even when no usage matched. Disabled context contains no entries
or excerpts. Reject a C2 failure as packet input; workflow integration must
stop on that failure before assessment. The trusted caller must establish
configuration/visibility, opt-in, checkout provenance, and C2 collection before
supplying that expected result. A packet cannot self-attest disclosure
permission. T4 must not recollect
files, widen C2's source types, or turn source-context absence into evidence
of dependency safety. Provider projection and actual outbound disclosure
inspection remain integration gates.

## Bounded Validation and Results

The following approved ceilings bound work, not measured performance or test
coverage. Count all
entries, including duplicates, before duplicate detection; never silently slice
arrays, shorten identities, or delete findings to fit.

| Dimension                                                       | Limit                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Complete serialized packet                                      | 1,048,576 UTF-8 bytes                                                              |
| Changes                                                         | 128 total across all ecosystems; approved                                          |
| Source records / findings / relationship proofs                 | 1,024 / 512 / 256 per packet                                                       |
| Relationship path                                               | 32 package instances per proof                                                     |
| IDs and package names                                           | 1–256 UTF-16 code units, matching C2's existing bound                              |
| Other identity strings, versions, refs, markers, paths, URLs    | 1,024 UTF-8 bytes each; shorter C2 limits still apply                              |
| Rationale, reason detail, title, or upstream excerpt            | 2,048 UTF-8 bytes each                                                             |
| References, reasons, extras/groups, or action texts in one list | 32 entries; each action text also obeys the text cap                               |
| Source context                                                  | Existing C2 caps, including 65,536 serialized bytes and 500 code units per excerpt |

The cap deliberately rejects PRs containing more than 128 detected changes.
[Public PR #307](../../tests/parity/scenarios.md#public-npm-unpaired-additions-pr-307)
exceeds it: its pilot recorded 131 paired updates plus 20 unpaired additions.
The exact packet count depends on collector rules, but any plausible count is
over 128. The shared reviewer will therefore reject a PR like #307 with a
`budget` error, publish a failed current-head status, and leave the prior
comment unchanged. [Parity requirement 4](SPEC-parity-cutover.md#requirements)
must record this as an intentional difference from the current reviewer; the
synthetic 20-addition fixture still covers requirement 5. Never trim
inventory to claim coverage; supporting larger packets requires a reviewed
contract change.

Paths are canonical repository-relative slash-separated strings. Root is
represented explicitly as `.`; other paths reject absolute/drive paths,
backslashes, empty segments, traversal, and control characters. Hidden segments
are allowed for evidence paths such as workflows; this does not relax C2's
stricter excerpt eligibility. Preserve meaningful case and exact refs/versions.
Opaque text and identifiers reject control characters; excerpt text may contain
ordinary line breaks and tabs as data. Do not trim, coerce, or repair invalid values.

Accept only JSON-shaped input: plain records, dense arrays, and supported
primitives. Reject accessors, symbols, prototype-like keys, cycles, exotic
objects, sparse arrays, and non-finite numbers without invoking getters or
serialization hooks. Check fixed shapes, string lengths, and array counts
before recursion, cloning, or serialization. Fixed nesting and per-field bounds
must prevent an oversized input from causing unbounded traversal. Measure the
UTF-8 JSON size of the validated plain candidate before returning it; a future
byte/JSON loader must additionally cap bytes before parsing.

Return either `{ ok: true, packet }` with a detached, deeply immutable snapshot,
or `{ ok: false, error: { category, field } }` with no usable partial packet.
Categories are fixed `input`, `identity`, `duplicate`, `reference`, `coverage`,
or `budget`; fields are known section labels, never supplied keys or values.
Catch inspection failures and produce safe diagnostics. Do not log candidate
data, raw parser/URL errors, paths, excerpts, raw model data, or credentials.
Repeated calls must not share mutable state or retain failed input.
W2 must stop on rejection before assessment or comment mutation, preserving
the prior managed comment and publishing the failed current-head status under
the shared workflow contract. T4 itself performs no writes.

## Code Style

Use camelCase fields, explicit discriminated unions, `unknown` at the runtime
boundary, single quotes, and small validators. Intended behavior and style:

```ts
import { expect, test } from 'vite-plus/test';
import { validateReviewPacket } from './schema.js';

test('rejects a packet for another run attempt', () => {
  const { packet, expected } = packetFixture();
  packet.binding.runAttempt += 1;
  expect(validateReviewPacket(packet, expected)).toEqual({
    ok: false,
    error: { category: 'identity', field: 'binding' },
  });
});
```

The validator and focused test command now exist. The abbreviated
`packetFixture` above stands for the synthetic constructors in the test file;
`expected` holds the binding, base SHA, context revision, and successful C2
result supplied by trusted orchestration.

## Implemented Interface and Handoffs

`src/schema.ts` exports one pure operation:

```ts
validateReviewPacket(candidate: unknown, trusted: unknown): PacketResult
```

`PacketExpected` describes the trusted argument: `binding`, `baseSha`,
`contextRevision`, and a successful `context`. The operation also validates
this argument at runtime and reports any defect in it under field `expected`,
before inspecting the candidate. `PacketResult` is either the fixed safe failure
shape above or a detached deeply readonly `ReviewPacket`. `PACKET_LIMITS`
exports frozen ceilings; callers cannot configure them. No input is mutated,
no I/O occurs, and no caught inspection error or payload is logged.

The exported `PacketChange` union preserves npm, Actions, and uv side shapes.
Each side carries a `sourceId` naming its immutable inventory file. npm uses
an explicit nullable `lockPath`; Actions uses `workflow`, `jobId`, nullable
`stepIndex` for job-level workflows, `action`, `ref`, and `refKind`; uv uses
nullable `marker` and sorted distinct `extras`/`groups`. `PackageSource`
distinguishes registry/Git/URL identities (credential-free HTTPS) from
canonical relative path/workspace identities. A Git URL can retain a revision
fragment; no Git or package resolution occurs here.

`PacketSource` contains `id`, `kind`, `ecosystems`, `memberIds`, `status`,
`reasons`, and `provenance`. `SourceProvenance` has these variants:

| Provenance kind | Required information                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory`     | Consumer repository, verified base/head SHAs, and `absentEcosystems`; paired with `file-list` sources. Available means completed scoped inventory.                            |
| `file`          | Repository, SHA, canonical path, and revision `base`, `head`, or `context`; paired with file sources.                                                                         |
| `upstream`      | HTTPS URL, title, bounded excerpt/truncation flag, exact member/side/value `subjects`, and nullable `range`; advisory identity and affected range are retained when supplied. |
| `unavailable`   | Explicit failed lookup with no invented URL, used only with unavailable source status and fixed reasons.                                                                      |

Upstream `subjects` bind each source to exact current/proposed versions or
refs, not a display name. A non-null range's declared endpoint must match its
subject; a comparison additionally validates every declared endpoint against
its attributed change, including a side omitted from `subjects`. T4 checks
these exact opaque values without interpreting semver or marker expressions.
Collectors retain responsibility for authentic source content, normalization,
and applicability before constructing a packet.

A successful category lookup covers the reviewed side; npm install-script
coverage spans both sides when both exist. Inventory completeness accounts
for every scoped inventory source, including failures not listed in a slot's
`sourceIds`. Unavailable corroborating comparisons do not themselves become
inventory failures. `not_applicable` requires affirmative absence evidence
and zero changes for that ecosystem.

A finding's references resolve through this source table. Proposed-version
claims require appropriately attributed head evidence; resolved advisories,
license changes, and two-version supply-chain claims also need base evidence.
One advisory finding cannot combine unrelated advisory identities. Conflicting
applicability for the same advisory/member/side is rejected across finding
kinds. Proven incompatibility requires proposed-side upstream support and a
trusted-context citation matching that member's supplied C2 fact path; a head
inventory file cannot substitute for the upstream proof. These are attribution
checks, not a claim that package usage alone proves incompatibility.

C2's successful context shape and bounds remain unchanged, including valid
internal tabs in source excerpts. T4 does not repeat filesystem collection,
prove checkout trust, or inspect the outbound provider request.
`RelationshipProof` retains known endpoint change IDs, ecosystem, revision
side, lock-source ID, and a bounded path of exact instances. Its acceptance
proves structural consistency only, leaving grouping ambiguity to T5.

T5 must preserve all inventory gaps, including ecosystems with zero retained
changes, and map category records to C3's `EvidenceSource`. M2/O1 must resolve
source-ID citations against this exact packet. W2 must obtain authentic
collector/C2 inputs and stop on rejection before assessment or publication,
then apply the existing current-head failed-status/old-comment contract.
These handoffs, observed disclosure, adoption, and cutover remain separate
verification gates.

## Testing Strategy and Success Criteria

Use source-adjacent table-driven tests with synthetic immutable identities.
No GitHub, registry, model, filesystem collection, or PR execution is required.

| Fixture group                                                                            | Required observable result                                                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Minimal npm, Actions, uv, and mixed packets                                              | Accepted with exact identities, occurrences, findings, and separate coverage preserved.                           |
| Missing/extra fields, nulls, wrong types, hostile objects, unknown enums                 | Rejected with safe fixed diagnostics and no usable packet.                                                        |
| Run attempt, workflow, repository, actor, PR, base/head/context mismatch                 | Rejected even when a copied identity tuple or display name matches.                                               |
| Omitted/duplicate IDs, duplicate side instances, conflicting pairs                       | Rejected; distinct roots, lock paths, workflow occurrences, and uv variants remain valid.                         |
| Additions/removals and synthetic 20 npm additions                                        | Null sides retained correctly; no fabricated version pair or dropped change.                                      |
| Comparison omission, permission/rate-limit failure, missing/unsupported input            | Known changes retained with explicit incomplete coverage; no zero-change or zero-vulnerability inference.         |
| Missing ecosystem slot or unsupported `not_applicable`                                   | Rejected; completed inventory evidence can establish a valid empty/not-applicable slot.                           |
| Complete npm plus incomplete Actions/uv, including zero retained changes                 | Accepted as structurally valid with all gaps preserved for T5/W2.                                                 |
| Wrong-ecosystem/member/version/ref sources, dangling findings/proofs, raw-URL references | Rejected; applicable sources and immutable file citations survive unchanged.                                      |
| Unknown advisory applicability, unavailable malware/scripts, optional signal failures    | Required gaps remain explicit; optional failures remain unchecked signals; no invented blockers or safety claims. |
| Source opt-out, context mismatch, bad truncation flags, C2 failure                       | Disabled packet contains no excerpts; invalid or unauthorized context cannot proceed.                             |
| Every byte/count bound at the limit and one beyond, including multibyte text             | Exact limits accepted when otherwise valid; overflow rejected without truncation or partial packet.               |
| Frozen inputs, mutation after success, repeated calls, sensitive-looking errors          | No input mutation, cross-call leakage, or sensitive diagnostic output.                                            |

T4 is complete only when those fixtures and all implementation quality commands
pass on one exact shared revision. Tests must also demonstrate that an invalid
packet exposes nothing an assessment consumer can use. Unit tests do not
certify collector completeness, graph grouping, provider projection, outbound
disclosure, publication, consumer adoption, or cutover.

## Commands

For this documentation-only change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

For the later implementation, use the repository's actual commands:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

The focused packet test command is:

```sh
npm test -- --run src/schema.test.ts
```

No build command exists; action packaging remains A1. Record tested SHA,
Node/npm versions, commands, outcomes, warnings, and omitted checks in issue
#11 or its PR, distinguishing working-tree checks from committed-revision
verification and CI merge SHAs from PR heads. Do not put revision-specific
verification history in this specification.

## Boundaries

- **Always:** Validate before assessment; compare trusted expectations;
  preserve exact per-ecosystem gaps and change identities; retain deterministic
  findings; return safe diagnostics and immutable snapshots; use public-safe
  synthetic fixtures.
- **Ask first:** Raise packet limits, relax unknown-field/reference rules,
  change approved identity or coverage semantics, add a dependency or data
  category, widen C2 disclosure, or move collector/grouping duties into T4.
- **Never:** Execute evidence text or PR content, make network requests during
  validation, trust packet-provided credentials/configuration, infer complete
  coverage from an empty API result, hide overflow, accept model-created facts,
  publish private consumer records, or claim unverified integration/parity.

## Approved Scope

The full revised contract is approved for planning, including all resource
ceilings, source-ID references from findings, the collected-evidence boundary
before T5 grouping, and rejection of a PR like #307 as an intentional parity
difference. Three ecosystem slots and evidence-backed `not_applicable` remain
mandatory. The eight-task implementation plan is approved for execution in
one PR.
No T4 contract question remains open.
