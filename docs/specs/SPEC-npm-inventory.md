# Spec: N1 npm Change Inventory

Status: approved for execution, 2026-11-01. Supporting contract for
`npm-evidence` in [the capability map](README.md), scoped to
[issue #14: N1](https://github.com/andrewpucci/dependency-update-advisor/issues/14).
This defines the inventory slice of [npm evidence](SPEC-npm-evidence.md)
and a declaration-record amendment to [T4](SPEC-review-packet.md) and
[T5](SPEC-decision-units.md). It adds no module or dependency direction.

Confirmed interview decision, 2026-10-26: represent declaration-only edits
explicitly and allow complete inventory coverage when fully accounted for.
Approval: after reviewing the saved draft, the user explicitly answered `yes`
to approval for planning on 2026-10-26. This approves the full specification,
including the declaration variant, combined 128-record accounting, and minimal
T4/T5 amendments. The collector and amendments are implemented on `issue-14`,
pending review and merge.

Plan approval, 2026-10-26: after reviewing the eight-task plan, the user
explicitly answered `approve`. The approved order is N1.1–N1.8,
[issues #124–#131 under #14](https://github.com/andrewpucci/dependency-update-advisor/issues/14),
with checkpoints after each pair of tasks. The user invoked `as-build auto`
on 2026-11-01 for all eight tasks in one PR, authorizing implementation,
per-task commits, verification, and one PR closing #14 and #124–#131.
Merge, adoption, and cutover remain separate gates.

Review amendment, 2026-10-26: after reviewing the alternatives, the user
explicitly answered `yes` to giving declaration records an empty `evidence`
object, updating #124 to match, and clarifying C3. Research questions name an
exact version, so they stay on resolved records. The user then explicitly
requested the remaining review fixes and approval, 2026-10-26: resolved npm
sides require a non-null `lockPath`, `directRoles` use is named, and stale
wording is corrected. These amendments are approved with the plan.

## Objective and Scope

Give reviewer contributors an immutable, attributable inventory of npm
changes for maintainers reviewing Dependabot PRs. Preserve resolved updates,
additions, removals, distinct installed instances, nested package roots, and
manifest declarations without inventing a resolved version or dropping an
unpaired side. An empty or unavailable comparison cannot erase file evidence.

N1 owns root reconciliation, bounded manifest/lock parsing, deterministic
inventory, provenance, and npm inventory coverage. It consumes the implemented
[D1 read session](SPEC-github-read.md) and produces inputs for T4 validation.
Its only T5 change is the declaration-record handoff below.

[N2 #15](https://github.com/andrewpucci/dependency-update-advisor/issues/15)
owns proven grouping and lifecycle interpretation. Upstream, advisory, and
registry research, model assessment, rendering, workflow transport, writes,
adoption, and cutover remain separate. N1 does not implement a YAML parser,
new lockfile format, dependency installation, or complete workspace resolution.

## Inputs and Collection Boundary

1. Accept the verified T1 binding, D1 session, trusted configured npm roots,
   and explicit caller-supplied parsing/retention limits. Validate unknown
   external inputs; do not treat a TypeScript cast as validation. Configuration
   provenance must name the trusted revision. The caller owns obtaining and
   interpreting its consumer-local Dependabot configuration; N1 receives
   canonical exact roots, not instructions or globs from PR text.
2. Use `discoverFiles()`, `readFile({ side, path })`, and `readComparison()`
   through D1. Require their repository/revision identities to match the
   binding. Respect D1's sequential-operation, cancellation, and cumulative
   budget contract; do not create a second client, retry with other credentials,
   or follow a response-provided URL. An obsolete discovery ends this attempt
   without a usable inventory.
3. Derive candidates from both current and previous changed paths and trusted
   roots. Include root `.` and nested manifest/lock directories independently.
   Configuration cannot hide a changed npm file outside its selected roots.
   Reconcile overlapping ownership; unexplained files or conflicting root
   assignments produce a scoped gap rather than a repository-root fallback.
4. Read unchanged companion files when necessary. Use previous paths on the
   base side of a rename and current paths on the head side. A directory move
   does not justify pairing unrelated package instances. D1's proven absence
   is distinct from unavailability; generic 404s and failed reads cannot prove
   additions or removals. Both required files absent on one side can establish
   an added/removed root; an absent required companion on a present side is a gap.
5. Keep D1's incomplete discovery visible even when every known npm root is
   readable, including base/merge-base divergence, file caps, and missing pages.
   It cannot prove that npm is absent or that all changed roots were found.
   Completed discovery establishing no relevant changed npm inputs may support
   `not_applicable`; configuration alone cannot.

## Manifest and Lockfile Contract

Use the committed `package.json` and `package-lock.json` v3 `packages` table.
The [npm lockfile documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/#packages)
defines package-location keys and resolved/source fields. Manifest entries
are declarations; the [npm manifest documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#dependencies)
allows ranges and other package specifiers. Neither a range nor a tag is an
exact installed version.

Validate decoded JSON shape, numeric lockfile version `3`, package tables,
paths, and fields used for identity, role, and source attribution. Bound file
bytes before parsing and JSON depth/entries before further traversal. Limits
for roots, parsed entries/depth, and retained result bytes are explicit positive
safe integers supplied by the trusted caller; N1 introduces no implicit
unbounded default or new repository quality threshold. Exhaustion retains
identifiable evidence with `budget`, without claiming complete inventory.
T4's packet ceiling still rejects overflow at its own boundary.

Compare manifest dependency maps with corresponding lock-root declarations
when supplied, excluding the consumer project's own version from dependency
changes. A mismatch, malformed file, unsupported lockfile, or missing companion
leaves the affected root incomplete. Retain independently readable declarations
and instances; never run npm to repair or resolve the input.

Use manifest sections `dependencies`, `devDependencies`, `peerDependencies`,
and `optionalDependencies` for established direct roles. Preserve section
membership on each side, including overlapping declarations. Account for
[optional-dependency precedence](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#optionaldependencies)
when associating a declaration with a resolved direct instance. Lockfile
`dev`/`optional` flags alone cannot establish directness. An unresolved
declaration-to-instance mapping stays unknown and retains its concrete gap.

Keep aliases distinguishable by installed slot and actual package identity
when established. Preserve exact source kind and credential-free identity;
do not collapse Git, URL, path, workspace, or registry changes into a
name/version pair. Do not infer a public registry from a missing or ambiguous
source. Links, workspace ownership, shrinkwrap precedence, overrides, and
other resolution-affecting layouts not fully understood in v1 leave scoped
`unsupported` coverage. Preserve representable instances without following
links or reading the consumer filesystem. Independent nested v3 roots remain
supported; treating every workspace as an independent root is not valid.

Retain immutable normalized root/package snapshots and relevant lock metadata
for N2, including dependency maps, integrity, link, and install-script signals
when present. N1 creates no relationship proofs or lifecycle findings. A
changed resolution-affecting field that cannot yet be represented must remain
a visible gap; equal versions alone cannot prove no relevant change.

## Resolved Changes and Determinism

1. Inventory installed instances by root and lockfile package path. Compare
   exact name, version, and package source on each side. Same-slot, same-name
   version or source changes become `update`; a known one-sided instance is
   an `addition` or `removal` with the other side exactly `null`. A different
   package identity occupying a slot produces removal/addition records.
2. Equal names at different roots or lock paths remain distinct. A path move
   may remain a removal and addition; do not pair by name or array position.
   Unknown/unpairable sides remain separate rather than acquiring invented
   versions, sources, or relationships. Failure to read one side is uncertainty,
   not proof of absence.
3. Record each exact base/head instance at most once among resolved changes.
   Manifest attribution enriches its role and provenance, rather than producing
   a second resolved copy. Each non-null side names its immutable lock source
   and a non-null `lockPath`; direct-role attribution also retains the
   applicable manifest sources. A resolved direct record reports established
   sections through T4's existing `directRoles` (`dependencies` → `production`,
   `devDependencies` → `development`, `peerDependencies` → `peer`,
   `optionalDependencies` → `optional`) for its reviewed side: head, or base for
   a removal. When membership differs between sides, the declaration record
   retains both maps.
4. Assign stable IDs using an unambiguous canonical encoding of bound review
   identity, record basis, root, and semantic side identities. IDs cannot depend
   on input order. If hashing is used, detect collisions rather than merging
   records. Sort output using locale-independent UTF-16 code-unit order of
   canonical identity. Reordering roots, maps, or comparison records changes
   neither IDs, counts, nor provenance.

## Declaration Amendment to T4 and T5

Keep existing resolved npm changes and their side shape. Extend the npm branch
of `PacketChange` with an explicit `basis: 'declaration'` variant in the same
`changes` array. Existing npm records without `basis` retain their resolved
meaning; non-npm records cannot carry this field. Packet version remains `1`,
and old resolved-only packet shapes remain accepted except a resolved side
with `lockPath: null`. T4 currently accepts that manifest-backed side with any
`version` text, including a range; declaration records now own manifest facts,
so the amended validator rejects it rather than allowing two representations.
The amended validator accepts the declaration variant; never strip its
fields to make it pass.

Each declaration record carries `id`, `ecosystem: 'npm'`, `basis`, `kind`,
`from`, `to`, `role: 'direct'`, and an empty `evidence` object. Required
research categories and optional signals ask about an exact version, which a
declaration lacks; the resolved record carries them when the installed version
changes, and a range-only edit changes nothing installed to research.
Declaration records reject `directRoles`; their `specifiers` keys already
carry section membership on each side.
Its non-null sides use this shape, separate from `NpmSide`:

```ts
type NpmDeclarationSide = {
  root: string;
  name: string;
  specifiers: Partial<
    Record<'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies', string>
  >;
  sourceId: string;
};
```

`specifiers` is a nonempty closed map of the exact manifest entries for that
package on that side. Preserve empty strings as declarations where npm allows
them; absence is a missing key, not an empty-string substitute. Reject unsafe
control characters and credential-bearing dependency URLs before returning
evidence; leave an explicit gap instead of copying secrets or repairing values.
Apply T4's existing package-name, path, identity-string, and hostile-object
bounds. No declaration side supplies `version`, `lockPath`, or package-source
claims. It cites a base/head manifest file, never a corroborating comparison.

Create one declaration record per changed root/package declaration map.
Additions/removals have one null side; updates have both sides with different
maps. A production-to-development move is one declaration update retaining
both section maps. Unchanged declarations produce no declaration record.
Within a root, a name change is a removal/addition rather than an assumed rename.
Side root/name identity must agree across an update.

For example, changing `dependencies.widget` from `^1.0.0` to `^1.2.0` while
locking `widget` at `1.5.0` on both sides produces one declaration update and
zero resolved updates. With readable, reconciled companion data, npm inventory
can be `complete`. The manifest edit does not itself create an inventory gap.

When both declarations and resolved instances change, retain both facts in
their distinct bases. Count each once within its own basis and label the
counts distinctly; do not present their sum as a count of distinct packages.
The existing 128-change packet limit counts **all** records across both bases
and all ecosystems. No second allowance or silent trimming is introduced.

The T4 amendment must also:

- Validate declaration kinds, sides, global change IDs, semantic uniqueness,
  and source membership. Resolved-instance uniqueness remains separate from
  declaration uniqueness; two facts about one package may coexist.
- Include declarations in npm coverage and `not_applicable` checks, source
  scopes, findings/context member references, packet bounds, immutable output,
  and safe error handling. Keep the existing failure categories and fields.
- Permit manifest-backed informational findings about the declaration edit.
  Exact-version vulnerability, malware, lifecycle, or other package claims
  require applicable resolved evidence; a specifier cannot stand in for it.
  N1 emits no such researched finding. Required evidence records remain
  explicit on resolved records; incomplete research does not change inventory
  completeness.
- Require an empty `evidence` object on declaration records; reject any
  required research category or optional signal there with a safe fixed error.
- Reject relationship proofs involving declaration records. They are manifest
  observations, not installed graph nodes or grouping anchors.

The minimal T5 amendment partitions every declaration into one standalone
unit, using the existing stable identity and unassessed-unit accounting.
Keep declarations out of the resolved direct-anchor count and relationship
search; their presence cannot create or suppress a resolved group. Project
the declaration's name and ID to C3 without putting specifiers into
`currentVersion` or `proposedVersion`. Its full maps remain in the packet.
It contributes no evidence links, so C3 records no research gap or
`incompleteEvidence` for it; preserve its context references and ecosystem
coverage limits. A declaration-only packet
is not `empty_inventory`, and a complete inventory is not a completed assessment.

M2/O1 and provider integration must retain the basis and before/after
declarations so they can be assessed and shown accurately. Their implementation
remains a downstream gate; this spec does not certify a live review of
declaration-only edits. No C2 opt-in or disclosure permission is expanded.

## Comparison Reconciliation and Coverage

Treat comparison records and supplied Dependabot text as untrusted
corroboration. Match only when exact root, instance, side, and source attribution
are established. Ambiguous matches stay unresolved. A comparison-only record
can identify a discrepancy and a candidate for further immutable reads.
Only emit a packet change once those reads establish the required file-backed
side identities; otherwise retain the discrepancy as a coverage gap. It cannot
turn failed immutable inventory into a complete one or duplicate a known change.
Unattributable/conflicting entries retain explicit coverage limits.

An empty comparison, omission, permission 403, ambiguous 403, rate limit, or
partial response never deletes file-derived changes. Preserve D1's fixed
reason and comparison availability independently from inventory. A failed
comparison alone does not make a fully reconciled file inventory incomplete.
D1 budget exhaustion can prevent later reads; those affected files still
produce actual inventory gaps. Prefer inventory reads before corroboration.

Return detached readonly changes, sources, normalized root snapshots, and npm
coverage. Preserve root/file attribution internally and T4's per-ecosystem
`complete`, `partial`, `unavailable`, or evidence-backed `not_applicable` slot.
Do not emit empty success for a failed root or let Actions/uv coverage mask npm
gaps. Preserve D1 reasons without copying response bodies or exception text.

Every retained resolved change explicitly accounts for upstream, vulnerability,
malware, and install-script research using T4's evidence shape; declaration
records carry none, as defined above. N1 leaves unperformed
research `unavailable` with `missing`; a known unsupported question uses
`unsupported`. Available inventory is not successful research or a claim of
zero vulnerabilities. Later collectors may enrich the exact same inventory
without changing its identities or losing earlier limits.

## Tech Stack, Structure, and Code Style

Use existing Node.js `>=24.11.0 <25`, ESM, strict TypeScript, and Vite+ tests.
No new dependency or toolchain change is selected. Use `unknown` at external
boundaries, discriminated results, camelCase, single quotes, and small pure
parsers consistent with `src/github-read.ts` and `src/schema.ts`.

| Location                              | Responsibility                                                        |
| ------------------------------------- | --------------------------------------------------------------------- |
| `src/evidence/npm.ts`                 | N1 root reconciliation, parsing, changes, coverage, and N2 snapshots. |
| `src/evidence/npm.test.ts`            | Synthetic collection and reconciliation fixtures.                     |
| `src/schema.ts`, `src/schema.test.ts` | Declaration variant and packet validation regressions.                |
| `src/units.ts`, `src/units.test.ts`   | Standalone declarations and preserved resolved grouping.              |
| `tests/parity/`                       | Sanitized scenario provenance and limits.                             |
| `docs/specs/`                         | This spec, affected contracts, and approval index.                    |

The declaration type above is exported from `src/schema.ts`.
Planning selects helper boundaries and fixture storage within this scope.

## Testing Strategy and Success Criteria

Use source-adjacent `vite-plus/test` tests, synthetic immutable repositories,
and mocked D1 results. Include an integration fixture using the real D1
session with mocked transport, then T4 and T5, without live network calls.
Behavior changes must leave regression checks that catch the original defect.

| Scenario                                                                                                                                                                                             | Required observable result                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root and independent nested v3 roots; repeated names and paths                                                                                                                                       | Every resolved update/addition/removal survives once with exact source, root, path, sides, and established role.                                                                               |
| Alias, source change, different package in one slot, path/root move                                                                                                                                  | No name-only collapse or fabricated pairing; source identity and distinct occurrences survive.                                                                                                 |
| Range-only change; role-only move; empty-string specifier                                                                                                                                            | Exact declaration maps survive; no fabricated resolved update; complete reconciled inventory remains complete.                                                                                 |
| Declaration and resolved changes together; unchanged declarations                                                                                                                                    | Distinct bases are retained once; unchanged declarations add no record.                                                                                                                        |
| Declaration-only T4/T5 packet                                                                                                                                                                        | Accepted after amendment, one standalone unit per declaration, no invented versions, not empty success, unassessed work visible, no research gap or `incompleteEvidence` from the declaration. |
| Declaration plus proven resolved group                                                                                                                                                               | Declarations neither anchor groups nor alter resolved-anchor counts; existing grouping fixtures still pass.                                                                                    |
| Malformed declaration maps, duplicate IDs/sides, wrong source side, relationship to a declaration, research category, signal, or `directRoles` on a declaration, resolved side with `lockPath: null` | T4 rejects with safe fixed errors and no usable partial packet.                                                                                                                                |
| Unsupported/malformed/missing lock, inconsistent manifest, unsupported layout                                                                                                                        | Other readable facts survive with affected root gaps; missing sides are not inferred from errors.                                                                                              |
| Added/removed root, rename, unavailable companion, partial discovery                                                                                                                                 | Proven absence permits null sides; unread data and incomplete discovery stay explicit.                                                                                                         |
| Empty/omitted comparison, permission/unknown/rate-limit 403, partial prefix                                                                                                                          | Immutable inventory retained, comparison reason preserved, no zero-vulnerability inference.                                                                                                    |
| Budgets, hostile JSON, excessive nesting, invalid paths or sensitive URLs                                                                                                                            | Bounded processing, no execution, no unsafe retained values or raw diagnostics; overflow never claims complete coverage.                                                                       |
| Reordered/frozen inputs, input mutation after return, mixed ecosystems                                                                                                                               | Stable IDs/order, detached immutable outputs, no input mutation or cross-review state, independent coverage.                                                                                   |
| Exactly 128 records; 129 across bases/ecosystems                                                                                                                                                     | Existing T4 ceiling applies without trimming; overflow returns no usable packet.                                                                                                               |

Preserve a clearly labeled synthetic fixture containing exactly 20 distinct
unpaired npm additions, each with `from: null`, separate package-path identity,
and immutable provenance. Make these transitive lock additions with unchanged
direct declarations so the assertion measures 20 additions, not new declaration
records. Assert that every addition reaches T4 and T5 exactly once, including
with an empty or unavailable comparison.

The [PR #307 baseline](../../tests/parity/scenarios.md#public-npm-unpaired-additions-pr-307)
did not retain the historical 20 names or an immutable pair for that API
payload. Do not claim this synthetic fixture reproduces the original payload
or the full PR. Keep the approved large-PR rejection as an intentional parity
difference. Tests here do not certify registry research, live transport,
outbound disclosure, publication, consumer adoption, or cutover.

## Implemented Handoff

`src/evidence/npm.ts` exports the read-only collector:

```ts
collectNpmInventory(input: unknown, { session }: { session: GithubReadSession }): Promise<NpmInventoryResult>
```

Input contains a verified `binding`, canonical exact `roots`, trusted
`configRevision` (`repository`, full `sha`), and required positive safe-integer
`limits`: `maxFileBytes`, `maxJsonEntries`, `maxJsonDepth`, `maxRoots`, and
`maxRetainedBytes`. File/retention limits count UTF-8 bytes; entry limits count
object properties and array elements across parsed files; depth counts nested
JSON containers. The input envelope is also bounded before binding parsing.
The caller owns the D1 session's lifecycle and credentials.

Results distinguish `invalid`, `obsolete`, fixed `unavailable` reasons, and
`inventory`. An inventory carries the binding, changes, source table, normalized
roots, scoped gaps, independent comparison availability/counts/source IDs, and
npm coverage. Inventory results are detached and deeply frozen. Retention exhaustion
omits snapshots and retains a fitting deterministic change prefix with explicit
`budget` coverage; if no bounded envelope fits, no usable inventory is returned.
This is independent of T4's hard 128-record rejection, which never trims a packet.

Each normalized root side identifies its manifest and lock sources, declaration
maps, installed-path nodes, and unresolved canonical paths. Nodes preserve exact
instances when representable, dependency/optional/peer maps, integrity,
install-script signals, and safe link targets. Missing or unsupported instances
cannot become proof of absence. Snapshots supply N2 with evidence, not proven
relationships. Comparison sources corroborate exact attributable versions and
never substitute for required package research.

Trusted orchestration must assemble other ecosystem slots and C2's separately
trusted result before calling T4, then pass only accepted packets to T5. N1 does
not create provider requests or publication authority. Verification evidence
belongs to [task #131](https://github.com/andrewpucci/dependency-update-advisor/issues/131)
and the PR. N2, research, M2/O1, W1/W2, disclosure, adoption, and cutover remain
separate; the old reviewer stays active.

## Role Amendment for Reachability

Approved for planning 2026-11-10 under
[#93](https://github.com/andrewpucci/dependency-update-advisor/issues/93); see
the [reachability evidence spec](SPEC-reachability-evidence.md). Implemented on
`issue-93` as #269, pending review and merge. N1 classified an update's role
from its head side only, so a package that is direct on base and installed only
transitively on head was reported `transitive` and vanished from the base-side
candidate set. An update whose base and head roles conflict, in either
direction, now becomes `unknown` with a `conflict` coverage reason, matching
uv. An `unknown` role in a root blocks grouping there until proven.
Declaration-only changes remain non-candidates.

## Commands

For documentation-only changes:

```sh
npm run lint:md
npm run format:check
git diff --check
```

For implementation verification:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
git diff --check
```

Run the focused collector, packet, unit, and mocked integration suites:

```sh
npm test -- --run src/evidence/npm.test.ts src/evidence/npm.integration.test.ts src/schema.test.ts src/units.test.ts
```

No build script exists; packaging remains A1. Record the exact shared revision,
working-tree state, Node/npm versions, commands, outcomes, and omitted checks
in issue #14 or its PR. Keep revision-specific results out of durable specs;
distinguish CI merge revisions from PR heads. Documentation checks do not
verify the collector or packet amendment.

## Boundaries and Approval

- **Always:** Use immutable D1 evidence; preserve nullable sides, declaration
  versus resolved meaning, exact identities, per-ecosystem gaps, and safe fixed
  reasons. Run repository checks and keep the old reviewer active.
- **Ask first:** Change the approved packet/declaration contract or
  coverage semantics, raise limits, add lock formats/dependencies/providers,
  expand workspace support, widen disclosure, or change trusted-workflow duties.
  Spec, plan, and execution approvals remain separate.
- **Never:** Install dependencies from the PR, execute PR code/scripts, use
  patches as complete files, infer absence from an HTTP error, follow links or
  untrusted URLs, invent exact versions from ranges, discard overflow, publish
  private consumer records, or claim unverified parity/cutover.

## Open Questions

None. The full specification, eight-task plan, and autonomous execution in
one PR are approved. Merge, adoption, and cutover remain separate gates.
