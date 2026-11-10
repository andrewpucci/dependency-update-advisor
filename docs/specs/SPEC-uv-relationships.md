# Spec: U2 Conservative uv Change Reconciliation

Status: implemented and on `main`; the reachability amendment below is
approved for planning.
The revised spec was approved for planning on 2026-11-01; execution was
approved on 2026-11-02, as recorded below.
Supporting contract for `uv-evidence` in
[the capability map](README.md), scoped to
[issue #18: U2](https://github.com/andrewpucci/dependency-update-advisor/issues/18).
This supplements [uv evidence](SPEC-uv-evidence.md), consumes
[U1 metadata](SPEC-uv-metadata.md), and preserves the existing
[T4 packet](SPEC-review-packet.md) and [T5 units](SPEC-decision-units.md).
No new module, supported lock format, dependency, or T4/T5 amendment is introduced.
Plan and execution approval are recorded below.

Confirmed scope decision: the user explicitly chose conservative structural
matching for markers and extras. Preserve universal-lock variants and exact
selectors; leave relationships incomplete when proof needs Python version-range
evaluation or Boolean-marker reasoning. On 2026-11-01 the user also
confirmed that a Dependabot range rewrite accompanying the same direct
package's resolved lock change stays an observation without lowering
inventory coverage.

Full-spec approval, 2026-11-01: after making review edits, the user invoked
`as-plan` and requested sub-issues, blocker updates, and project organization.
Under the repository approval rule, this approves the revised specification
for planning and authorizes those tracker updates. The later plan and execution
approval is recorded below.

Corroboration clarification approved, 2026-11-01: the user explicitly
approved an `unavailable`/`conflict` source for zero-member prose
contradictions, retaining `partial`/`conflict` uv coverage and a bounded
observation. This clarifies the existing T4 mapping without changing T4.
Plan and execution approval: on 2026-11-02 the user invoked `as-build auto`
and requested one PR closing the parent and all sub-issues if possible.
This approves the nine-task plan, per-task commits, automated checkpoints,
verification, a branch push, and one PR. Merge and cutover remain separate.

## Objective and Scope

Give maintainers an attributable uv change inventory and explain which
transitive changes have a proven relationship to a changed direct dependency.
Account for updates, additions, removals, sources, markers, and optional extras
without inventing a version pair, environment, or activation path. Every
identifiable change survives even when its role or relationship is unknown.

U2 owns reconciliation of U1's immutable snapshots, manifest/lock consistency,
resolved-change identity, roles, scoped diagnostics, and existing T4/T5
handoffs. It does not resolve Python dependencies, install packages, run uv,
fetch registry metadata, or form decision units. Research, model assessment,
rendering, workflow reads/writes, adoption, and cutover remain separate.
Keep the old reviewer active.

The approved parent also requires PR-description corroboration. U1 deliberately
returns neither PR text nor comparison rows. U2 defines that corroboration
boundary below; obtaining revision-bound text belongs to workflow integration.
Do not claim full parent-contract completion from file reconciliation alone.

## Inputs and Output

1. Consume authentic `collectUvMetadata` results from trusted orchestration,
   including the binding, config revision, roots, snapshots, sources, gaps,
   discovery, and independent comparison state. Validate structural and
   binding/source consistency before reconciliation; a cast does not validate
   external input. Do not accept PR/model-supplied snapshots as collector proof.
2. Preserve `invalid`, `obsolete`, and fixed `unavailable` outcomes. A failed
   input cannot become an empty successful inventory. Do not reread files,
   repair a lock, create a second client, or substitute mutable branch refs.
3. Return detached readonly uv changes, T4 sources and relationship proofs,
   scoped gaps, inventory coverage, comparison availability, and bounded
   observations mapping each output back to exact U1 entries and selectors.
   Retain requested package extras separately from project-extra membership.
   The exported interface and handoff are documented below.
4. Check every retained root/side/file against the verified repository,
   base/head SHA, path, blob or proven-absence identity, and source membership.
   U1's enclosing snapshot ID plus `UvPackage.key` identifies a package
   occurrence. Never treat a package name or list position as that identity.
5. Orchestration combines ecosystem fragments and C2 context, calls T4, and
   passes only its accepted packet to T5. U2 supplies facts without a verdict,
   execution-success claim, or write authority. U1 retention gaps survive.

## Exact Inventory and Pairing

Work independently within each root. Only U1's tested schema 1 revisions 3
and 5, registry packages, and editable `.` self-project are supported. The
self-project associates declarations and is never an external dependency.
Do not pair across roots or infer continuity from a directory rename.

[uv's universal resolution](https://docs.astral.sh/uv/concepts/resolution/#universal-resolution)
can retain multiple versions for different environments. Keep each normalized
name, exact version, credential-free source, and recorded package marker set
distinct. Preserve the root's `requires-python` and resolution markers as
context; they are not evidence that the runner represents all environments.

1. First match unchanged exact instances one-to-one, disregarding source IDs
   and syntactic ordering but retaining semantic identity: every `UvSide`
   field except `sourceId`, including project-extra membership. Package-list
   order is not identity. Preserve unknown metadata separately; missing data
   is not an empty marker or extra set.
2. Among remaining instances, pair a version update only when exactly one
   base and one head candidate share the same root, normalized name, exact
   registry source, and recorded package-marker context. Never choose the
   nearest version, sort versions into pairs, or use a manifest range, PR
   title, or name alone to break a tie.
3. With several possible pairs, retain all identifiable unmatched base/head
   instances as separate removals/additions with an attributable ambiguity
   diagnostic. These records mean differences in the recorded lock inventory,
   not proof of an uninstall/install event in every Python environment.
4. A source or marker-context change is conservatively a removal/addition,
   even if name/version stays equal. Explain the observed difference without
   asserting a proven migration pair. Do not normalize distinct registry URLs
   into one identity or infer public PyPI from a registry-shaped URL.
5. Prove one-sided differences against a complete relevant opposing package
   table or U1's proven absent root side. Unavailable, omitted, or partial
   opposing data cannot prove absence. Retain known observations and a gap
   instead of fabricating a null side; independently proven exact matches or
   pairs may survive when the gaps cannot affect their correspondence.
6. A lock revision change alone is not a dependency change. Normalize the
   documented revision 3/5 omission of empty extra entries only where U1
   establishes an equivalent empty table; do not erase a declared extra or
   turn unknown data into empty data.
7. Compare resolution-affecting metadata even when versions stay equal.
   Root Python constraints, root marker changes, edge rewrites, and changes
   in proven role/extra attribution must remain observations. Emit an exact
   T4 change when its existing sides can represent the difference; otherwise
   retain a scoped coverage gap. Equal versions cannot establish no work.
   A difference only in project-extra membership is a T4 `update` with equal
   versions; a direct one counts as a changed direct dependency for T5.
   An accompanying range rewrite is the exception defined under declarations.

Build IDs from the binding, both revisions, root, change kind, and exact
semantic sides. Like U1 and N2, use a prefixed SHA-256 digest of that
canonical tuple so registry URLs and marker arrays still fit T4's ID limit.
Do not include array positions or discovery order. Sort output
by UTF-16 code units and check collisions rather than silently merging records.
Every external instance participates at most once on each side of the inventory.

## Declarations, Roles, and Extras

Reconcile static manifest declarations against the editable self-project's
ordinary and optional dependency selectors, `requires-dist`, and
`provides-extras` when available. Preserve original list/position provenance.
The [PyPA dependency contract](https://packaging.python.org/en/latest/specifications/dependency-specifiers/)
distinguishes version constraints, requested package extras, and environment
markers. A constraint is never a resolved version.

- Establish a direct package only through a supported association between
  a manifest declaration and an exact self-project lock selector/target.
  Name equality alone is insufficient when variants or conflicting
  declarations exist. A range can be retained and compared structurally
  without claiming it accepts a particular locked version.
- Match supplied selector version/source fields exactly. A selector with
  omitted fields resolves only when the complete relevant table establishes
  a unique target. Do not use a missing source/version as a guessed value.
  Several possible targets stay unproven; never choose by list order.
- Preserve same-name marker-split declarations independently. Establish
  their mapping only through exact retained selectors and compatible
  structural context. Do not resolve ambiguity using PEP 440 evaluation,
  marker implication, simplification, or the runner's Python environment.
- A package reached by both direct and transitive paths is direct. Classify
  it as transitive only when supported graph evidence establishes reachability
  and complete relevant direct-declaration mapping excludes direct membership.
  Otherwise use `unknown`. For paired changes, conflicting base/head roles
  remain explicit and yield `unknown` rather than hiding a role transition.
- Treat each declared project extra as a separate optional scope. Its
  presence does not mean it is enabled in every installation. Several proven
  project-extra memberships can refer to one package instance without
  duplicating it. Preserve empty extras and their declaration provenance.
- Project-extra membership is a property of each package instance on one
  side. It is `[]` when a supported path reaches the instance from the
  self-project's ordinary dependencies, even if extras also reach it.
  Otherwise it is the sorted set of project extras whose optional table
  reaches the instance; any one of them can pull it in. Reachability means
  some recorded environment, not every installation. A non-empty set needs
  every selector that could reach the instance to resolve, so no hidden
  ordinary or extra path remains. If membership is unproven, the side lists
  only proven extras, keeps a scoped gap, and cannot appear in a proof.
- A Dependabot range rewrite, such as raising a `>=` floor, is not a
  declaration-only change. Attach it as an observation to the resolved
  change, with no coverage gap, when only the specifier differs and the
  name, requested extras, marker, and declaring list or project extra match,
  including the self-project's `requires-dist` mirror. Both sides must map
  to proven exact selectors whose targets are the base and head sides of
  one direct resolved change. Otherwise pairing rule 7 applies.
- Requested dependency extras, such as `library[fast]`, activate that target's
  matching optional-dependency table only on that recorded path. Do not confuse
  a dependency's `fast` extra with the project's own `fast` extra or activate
  every optional table merely because it exists in the lock.
- Retain unresolved, missing, dynamic, unsupported, and conflicting declaration
  scopes as gaps. A manifest/lock mismatch cannot be repaired by range solving
  or borrowing another variant's selector. Preserve independently proved roles.

Existing `UvSide.extras` carries sorted proven project-extra membership;
requested package extras and their path activation stay in the attributable
observations. `groups` is empty only for a proven supported no-group scope;
unsupported dependency groups remain gaps. U1 reports dependency groups and
legacy dev dependencies as `unsupported`, so a root with either keeps uv
inventory partial. Packages they may reach keep `unknown` roles, and T5
leaves every uv transitive change standalone. Encode package resolution markers
in the existing opaque `marker` field as a JSON array of sorted distinct exact
marker strings. Use `null` for a valid absent or empty package marker list;
retain its original representation in observations. This is an opaque recorded
context, not a generated Python expression. A parse gap cannot establish that
context: retain a scoped gap rather than substituting `null`. Root resolution
markers and Python constraints remain separate observations. Enforce T4's
marker/extra bounds without truncation; unrepresentable identity stays a gap.

T4 currently has no uv declaration variant. Preserve declaration-only changes
and extra-table changes as structured observations with immutable citations.
If no existing resolved side can express their effect, mark uv inventory
`partial` with `unsupported`, including when there are zero resolved changes.
Do not invent a resolved version or claim a complete empty inventory. A future
uv declaration variant requires a separately approved T4/T5 amendment.

## Graph Relationships and T5 Eligibility

Construct edges only from U1's retained selectors within one root, side, and
lock source. Keep exact package instances and unchanged intermediate packages.
Each traversed edge needs a unique supported target, proven optional-extra
activation, and structurally compatible marker context.

Unconditional ordinary edges are supported. For an initial conditional T4
proof, every package on the path must record the same single exact marker
string, and every edge marker must be absent or exactly that string. All
steps must also retain the same project-extra membership. This deliberately
small subset preserves the guard in every path identity without a solver.
Distinct expressions are not assumed equivalent, compatible, or mutually
exclusive; do not combine paths from different contexts. Paths using a
dependency's optional table require activation state the current T4 path
cannot express, so retain them as observations without an eligibility proof.
The same applies to any other conditional path outside the tested subset.
Do not drop conditions to fit the packet shape.

Use bounded state traversal that distinguishes package instance, requested
extras, project-extra scope, and marker context. A visited set must not merge
different activation states. Avoid enumerating every possible path or subset
of extras. Select one eligible path per anchor/member pair by shortest length,
then canonical code-unit ordering. Cycles terminate; emitted paths have no
repeated instance. Repeated instances required to express an activation path
leave that path unrepresentable in current T4.

Preserve T5's conservative gates:

1. Require complete uv inventory, known roles in the relevant root, and
   exactly one changed direct resolved dependency in that root. Count direct
   additions, updates, and removals across both sides. Broader multi-anchor
   grouping remains [#93](https://github.com/andrewpucci/dependency-update-advisor/issues/93).
2. Use head-side paths for additions/updates and base-side paths for removals.
   The anchor must exist on that side. Never stitch revisions, reverse an
   edge, cross roots, or use a removed anchor for a head-side member.
3. Emit existing `RelationshipProof` records whose endpoints exactly equal
   the changes' applicable `UvSide`s. Every step cites the same immutable
   `uv.lock` source and root. Cite real source membership for both endpoints.
   T4 checks structure and attribution; U2 is responsible for actual edges.
   T4 compares endpoint `sourceId`s exactly. When splitting puts the anchor
   and member in different records of one lock, leave that relationship
   unproven with a fixed `source_split` reason, as N2 does; never emit a
   proof that would make T4 reject the packet.
4. Sharing with unchanged direct dependencies does not prevent grouping.
   Retain observed sharing, without claiming exclusive ownership or causation.
   A missing path does not prove another anchor cannot reach the member.
5. Leave ambiguous or unrepresentable relationships standalone. Relationship
   uncertainty alone need not make an otherwise complete inventory partial:
   T5 permits complete individual assessment. If uncertainty prevents counting,
   pairing, identity, role, or a concrete required-evidence answer, retain the
   corresponding inventory/evidence gap as well.

Grouping changes unit counts, never change counts. Keep each member's findings
and required research attached to that exact member. Do not synthesize
`group_backed`, vulnerability, malware, or successful research evidence.

## Sources, Coverage, and Corroboration

Translate U1 sources into T4 sources with actual change membership. File
provenance retains the repository, side SHA, and exact path; internal
observations retain U1's blob/tree identity. A proven-absence record is not
an available lock file and cannot support a relationship proof. Split source
membership deterministically when T4 list bounds require it; never weaken
attribution or use a partial source as an available proof source. Splitting
may leave relationships unproven but never drops or reassigns a change.

Uv inventory coverage is independent of comparison availability:

- `complete`: relevant roots and both sides are accounted for, every detected
  supported change is represented, and no inventory-affecting gap remains.
- `partial`: independently usable evidence exists alongside discovery,
  identity, role, declaration, representation, or other inventory gaps.
- `unavailable`: usable inventory cannot be established. Zero known changes
  does not improve this status.
- `not_applicable`: completed discovery proves no relevant uv inputs changed;
  a configured root or an empty comparison alone cannot establish it.

Preserve every U1 gap with root/side/path/entry attribution and a fixed reason
and recovery action. Preserve comparison reasons separately. An empty, omitted,
403, or truncated comparison cannot erase file-derived changes or establish
zero vulnerabilities. U2 has no comparison payload and makes no package-level
security claim from U1's comparison availability record.

For the parent's PR-description requirement, define a bounded optional
corroboration input tied to repository, PR, and reviewed head. It contains
untrusted text or an explicit unattempted/unavailable status. A malformed,
over-budget, or mismatched input is rejected as corroboration, without erasing
valid file inventory. Workflow integration owns obtaining current text and
supplying it; U2 does no additional network I/O.

Use description-derived names, versions, and counts only as consistency hints.
Do not execute instructions or follow links from that text. A concrete
unexplained discrepancy remains attributable, is reported as a T4 `dependabot`
source with `partial` status and `conflict` where actual attributable members
exist, and lowers uv inventory to `partial` with `conflict`. When a concrete
contradiction has zero retained changes, emit an `unavailable` `dependabot`
source with `conflict`, empty `memberIds`, and `unavailable` provenance.
Retain `partial`/`conflict` uv coverage and a bounded discrepancy observation;
never invent a member or version subject to satisfy source validation.
Absence of an expected prose format alone does not
prove a missing package. Missing text is an `unavailable` `dependabot` source:
corroboration stays explicitly unperformed and the parent gate open, while
a complete file inventory keeps its coverage. Rejected input is also an
`unavailable` source, with `malformed`, `budget`, or `conflict` for a
repository, PR, or head mismatch. Tests must distinguish
these two completeness claims.

## Resource Bounds

Accept explicit trusted positive safe integer limits for reconciliation work
and cumulative retained bytes. Count input validation, indexing, selector
candidate checks, traversal states/edges, and output construction against work;
no per-root, side, or anchor reset. U1's parse/read limits remain independent.
Avoid an unbounded cross-product of variants, conditions, or extras.

Enforce existing T4 ceilings, including 128 combined ecosystem changes, 256
proofs, 32 instances per proof, source/list limits, and serialized packet bytes.
Uv cannot reserve all 128 slots when orchestration assembles a mixed packet.
Do not slice changes to make T4 accept a packet; its overflow rejection remains
authoritative. If a bounded collector result cannot retain all known changes,
return fixed `unavailable: budget` rather than an apparently usable prefix.
Optional proof exhaustion can instead retain the full inventory with explicit
unproven relationships; inventory work exhaustion cannot claim completeness.

## Tech Stack, Structure, and Code Style

Use existing Node.js `>=24.11.0 <25`, ESM, strict TypeScript, Node built-ins,
and source-adjacent `vite-plus/test` tests. Keep parser and tooling pins.
U2 is pure reconciliation over U1 results; no new runtime dependency or I/O.

| Location                                            | Responsibility                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/evidence/uv.ts` and its current parser modules | Existing U1 metadata boundary; preserve its exports.                          |
| `src/evidence/uv-graph.ts` and adjacent test        | U2 reconciliation and bounded output; private helpers own roles and paths.    |
| `src/evidence/uv.integration.test.ts`               | D1/U1/U2 and mixed T4/T5 handoff fixtures.                                    |
| `tests/parity/uv-metadata.ts` and uv graph fixtures | Invented format structures and honest provenance limits.                      |
| `src/schema.ts`, `src/units.ts`                     | Existing packet/unit contracts; integration consumers, not new graph engines. |
| `docs/specs/SPEC-uv-relationships.md`               | This supporting contract.                                                     |

The plan may choose smaller internal helpers without a generic graph framework.
Use camelCase, `.js` import suffixes, explicit nullable sides, fixed failure
reasons, and deterministic detached results. This existing result convention
illustrates unavailable evidence without invented package identity:

```ts
const result = {
  kind: 'unavailable',
  reason: 'budget',
} as const;
```

## Reachability Amendment

Approved for planning 2026-11-10 under
[#93](https://github.com/andrewpucci/dependency-update-advisor/issues/93); the
normative contract is the [reachability evidence spec](SPEC-reachability-evidence.md).
Implementation is tracked by #270 and #272. The "No ... T4/T5 amendment" line
at the top and the "broader reachability" ask-first item describe the initial
scope. With `reachability` evidence U2:

- uses its own closure traversal that ignores marker and extras contexts, so a
  package another candidate reaches only on some platform or extra still counts
  as reachable; the existing `pathTo`, `children`, and `compatible()` helpers
  are single-context and are not reused for absence;
- treats any node or edge skipped for an unresolved marker, extras, or
  membership as non-proving, and an activation path T4 cannot represent as
  `unsupported`;
- binds verdicts to exact variant change IDs, so a verdict for one variant
  never covers a sibling, and applies the same emission and optional-evidence
  rules as N2.

## Commands and Testing Strategy

For documentation-only updates:

```sh
npm run lint:md
npm run format:check
git diff --check
```

Install with `npm ci` if needed and run all
four shared checks against one exact revision:

```sh
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Focused graph and handoff verification is:

```sh
npm test -- --run src/evidence/uv-graph.test.ts src/evidence/uv.integration.test.ts src/schema.test.ts src/units.test.ts
```

No build command exists; packaging remains A1. Record exact SHA, working-tree
edits, environment, commands, outcomes, and unrun checks in #18 or its PR.
Do not store revision-specific check logs in this durable specification.

Use synthetic bounded metadata and TOML, with mocked transports only.
Assert exact identities, counts, roles, nullable sides, sources, reasons,
proof paths, and T5 unit membership; snapshots alone are insufficient.

| Required fixture                                                                                       | Observable result                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct update, transitive update, addition, removal, unchanged lock                                    | All exact changes retained once; unchanged supported inputs yield zero changes.                                                                            |
| Unique same-source/marker pair; several same-name unmatched variants                                   | Unique pair becomes update; ambiguous candidates remain separate with explanation.                                                                         |
| Same name/version at distinct sources, roots, or marker contexts                                       | No collapse or guessed source migration; each known side remains attributable.                                                                             |
| Revision 3 to 5, omitted empty lock extra, declared empty manifest extra                               | No revision-only package change or invented extra addition/removal.                                                                                        |
| Static declaration, matching editable selector, marker-split declarations                              | Proven direct roles only; ambiguous mapping stays unknown.                                                                                                 |
| Manifest-only range, extra, Python constraint, or edge rewrite                                         | Observable change retained; unrepresentable effects prevent complete empty inventory.                                                                      |
| Dependabot `>=` floor rewrite with the same package lock update; rewrite with extras or marker change  | Range is an attached observation and coverage stays complete; other rewrites follow rule 7.                                                                |
| Four project extras; requested dependency extra; transitive optional edge                              | Separate project and package extras; activate only supported scopes; no instance duplication.                                                              |
| Package reached from core and an extra; extra-only package; unresolved selector; membership-only shift | Core reach gives `[]`; extra-only gives exact set; unproven stays gap and unproven; equal-version update.                                                  |
| Dependency groups or legacy dev dependencies                                                           | Scoped unsupported gap, `unknown` reachable roles, partial uv inventory, and no uv grouping.                                                               |
| Different marker conditions, incompatible forks, conditional cycle                                     | No environment guess or stitched proof; bounded traversal with attributable uncertainty.                                                                   |
| One changed direct anchor and exact unconditional transitive path                                      | T4 accepts proof and T5 groups exact members with findings preserved.                                                                                      |
| Unchanged shared direct dependency; several changed direct anchors                                     | Sharing is retained; several changed anchors remain standalone under existing T5 rules.                                                                    |
| Direct removal beside update; removed transitive; wrong-side path                                      | Both direct changes counted; only eligible same-side proofs survive.                                                                                       |
| Unsupported/malformed/missing companion or partial opposite package table                              | Known evidence survives; unknown absence does not become addition/removal.                                                                                 |
| D1 comparison empty, omission, 403, rate limit, truncation                                             | Same file inventory; independent comparison limits; no zero-vulnerability claim.                                                                           |
| Discovery failure or renamed/nested roots, including zero known changes                                | No cross-root pairing, hidden root, or successful empty result after failure.                                                                              |
| Consistent, contradictory, missing, hostile, stale, or oversized PR prose                              | Prose never becomes proof; disagreement, skipped corroboration, and invalid input stay distinct.                                                           |
| Concrete prose contradiction with zero retained changes                                                | An unavailable/conflict memberless Dependabot source, partial/conflict uv coverage, and a bounded observation pass real T4; no invented member or subject. |
| Input permutations, frozen inputs, repeated calls, changed head SHA                                    | Deterministic IDs/output, no mutation or cross-call state, revision-bound identities.                                                                      |
| Each work/byte/T4 boundary and mixed npm/Actions/uv packet                                             | No silent trimming; authoritative packet rejection or explicit bounded failure.                                                                            |
| More than 32 lock changes split across source records, anchor and member in different records          | All changes retained; cross-record relationship unproven with `source_split`; T4 accepts the packet.                                                       |
| Complete standalone assessment with unproven grouping; actual inventory gap                            | Relationship-only uncertainty can resolve; packet-wide gaps survive and constrain T5 outcome.                                                              |

Integration fixtures must pass actual D1 results through U1, U2, T4, and T5,
including a synthetic comparison 403 and a mixed-ecosystem packet. Keep a
zero-change uv failure visible beside complete npm/Actions slots. Test overflow
through real T4 validation, not a test-local imitation. These fixtures do not
certify live transport, downstream research, publication, adoption, or cutover.

## Boundaries and Review Questions

- **Always:** Preserve immutable provenance, every identifiable variant and
  U1 gap, exact nullable sides, independent comparison state, conservative
  roles/proofs, full member accounting, and existing T4/T5 gates.
- **Ask first:** Add marker/range evaluation, a format/source/layout, a parser
  dependency, uv declaration records, broader reachability, packet/policy
  amendments, network transport, or an external disclosure category.
- **Never:** Execute PR code, run uv/Python, install consumer dependencies,
  follow untrusted metadata URLs, publish private consumer fixtures, infer
  safe upgrades or zero vulnerabilities, hide unresolved work, or disable
  the old reviewer before parity/cutover approval.

The structural-matching decision and revised specification are approved.
The approved packet limits mean declaration-only changes remain partial.
Paths whose activation conditions cannot be preserved remain standalone. Roots with
dependency groups or legacy dev dependencies get no uv grouping until U1
supports them. Project-extra membership and PR-text mapping follow the
definitions above. The PR-text
boundary is specified here, while its transport and full-parent completion
remain integration gates. Execution is authorized as recorded above.

## Planning Handoff

The approved nine-task plan is indexed in
[parent #18](https://github.com/andrewpucci/dependency-update-advisor/issues/18),
with ordered sub-issues #161–#169 in the implementation project. They remain
open pending merge; the project records implementation awaiting review.
The gitignored `tasks/plan.md` holds the dependency graph, interface choices,
checkpoints, and risks. U1 #17 and T5 #12 are satisfied prerequisites;
#169 is the final U2 verification gate. W2 #26 remains separate.

The user approved the zero-member corroboration clarification recorded above.
U2.7 and U2.8 verify that mapping through real T4; no packet amendment is needed.
The plan and auto execution are approved as recorded above.

## Implemented Interface and Handoff

`reconcileUvGraph(input: unknown): UvGraphResult` is the synchronous, pure entry
point in `src/evidence/uv-graph.ts`. Supply an object with `binding`, an authentic
U1 result as `metadata`, and `limits: { maxGraphWork, maxRetainedBytes }`.
Both limits are trusted positive safe integers. The optional `corroboration`
property accepts one of these forms:

```ts
{ status: 'unattempted' }
{ status: 'unavailable', reason: /* existing EvidenceReason */ 'missing' }
{ status: 'available', repository: { id, owner, name }, pullNumber, headSha, text }
```

The available form must match the verified repository, PR number, and head SHA.
There are no default budgets, network calls, Python/uv execution, or new runtime
dependencies. Runtime shape checks do not replace trusted orchestration's duty
to supply authentic U1 results.

`UvGraphResult` preserves `invalid`, `obsolete`, and fixed `unavailable` results.
Its usable form, `kind: 'inventory'`, includes `binding`, `configRevision`, uv-only
`changes`, T4 `sources`, `relationships`, informational `findings`, scoped `gaps`,
`observations`, uv `coverage`, independent `comparison`, and `corroboration`.
Only `coverage.status` expresses inventory completeness. Inventory results are
detached and deeply frozen; all result types are readonly. Each gap has a fixed
recovery `nextAction`.
Observations retain root, side, path, U1 entry or selector, reason, safe structured
value, source/member references, and next action. They can explain a declaration
or metadata change that has no representable PacketChange.

`fileIdentities` retains U1's original immutable file and proven-absence records,
including blob/tree identity. Package, declaration, and metadata observations
refer to these original IDs. Change sides and relationship/corroboration notes
refer to actual T4 sources after deterministic membership splitting (at most
32 member IDs per source). Proven absence is never an available lock file or
relationship source. A proof whose endpoints land in different source records
stays unproven with `source_split`; splitting never drops a change.

`UvSide.marker` is a JSON array of sorted, distinct exact package-marker strings,
or `null` for a proven empty list. Root Python constraints and resolution markers
remain separate observations. `UvSide.extras` records proven project-extra
membership; requested dependency extras remain in selector observations.
No Python range or Boolean-marker evaluation occurs. Same-side paths use the
exact supported marker/extra context. Optional-table paths that T4 cannot express,
unknown roles, incomplete inventories, and multiple changed direct anchors stay
standalone under the unchanged T5 rules.

The tested prose grammar recognizes whole trimmed lines `Bumps NAME from OLD to
NEW.` and `Resolved uv changes: N.` (the final period is optional). The latter
counts all resolved uv change records. Backticks and bounded HTTPS Markdown link
labels can wrap tokens; links are never followed. Names normalize case and
`-_.`; versions remain exact opaque strings. Lines over 4,096 characters and
unrecognized text are inconclusive. Generic grouped-update counts and names
outside the recorded uv inventory cannot establish a contradiction. A version
claim must match both sides of the same change; it cannot pair separate variants.
Only normalized bounded assertions are retained, with explicit truncation flags.
Missing, malformed, stale, oversized, or inconclusive prose keeps a separate
unavailable/unattempted corroboration state without erasing file evidence.
Concrete contradictions use the approved conflict mapping above.

Work is cumulative across validation, candidate scans, selector activation,
traversal, and output construction. Core inventory and terminal output envelopes
are reserved before optional corroboration and relationship work. Optional work
exhaustion retains the full inventory with a visible budget status; if the full
known inventory itself cannot fit, the result is `unavailable: budget`. Changes
are never trimmed to fit. Serialized retained bytes and existing T4 bounds remain
authoritative, including the combined 128-change ceiling across ecosystems.

Orchestration combines these fragments with npm/Actions and C2 context, validates
the assembled packet through T4, then passes only that accepted packet to T5.
U2 leaves upstream, vulnerability, and malware evidence unavailable/missing with
no research source IDs. The mixed fixtures use real D1/U1/U2/T4/T5 code with
invented immutable responses; their downstream research records are test-only.
See [fixture provenance](../../tests/parity/README.md#uv-reconciliation-fixtures)
and [verification #169](https://github.com/andrewpucci/dependency-update-advisor/issues/169).
Workflow acquisition of current PR prose, live transport, research, M2/O1,
publication, packaging, adoption, parity, and cutover remain separate gates.
The old reviewer stays active.
