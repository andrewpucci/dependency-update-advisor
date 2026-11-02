# Spec: N2 Proven npm Relationships and Lifecycle Evidence

Status: approved for execution, 2026-11-01. Supporting contract for
`npm-evidence` in
[the capability map](README.md), scoped to
[issue #15: N2](https://github.com/andrewpucci/dependency-update-advisor/issues/15).
This supplements [npm evidence](SPEC-npm-evidence.md), consumes
[N1 inventory](SPEC-npm-inventory.md), and preserves the existing
[T4 packet](SPEC-review-packet.md) and [T5 unit](SPEC-decision-units.md) contracts.
No new capability-map module or dependency direction is proposed.

Confirmed scope decision, 2026-11-01: the user explicitly chose to preserve
T5's rule requiring exactly one changed direct resolved dependency per root.
Broader reachability and multi-anchor grouping remain in
[#93](https://github.com/andrewpucci/dependency-update-advisor/issues/93).
Full-spec approval, 2026-11-01: after revising the saved draft, the user invoked
`as-plan` and requested sub-issues tracked on the implementation project board.
Under the repository approval rule, this approves the revised specification
for planning and authorizes task creation and project organization. The plan
and execution approvals are recorded below. The approved
eight-task handoff is saved in gitignored `tasks/plan.md`; ordered sub-issues
[#133–#140 under #15](https://github.com/andrewpucci/dependency-update-advisor/issues/15)
are on the implementation project with Status `Todo`.

Plan and execution approval, 2026-11-01: the user explicitly answered
`approved` and invoked `as-build auto`, requesting one PR closing all eight
sub-issues if possible. This authorizes N2.1–N2.8, per-task commits, automated
checkpoints, verification, a branch push, and one PR. Parent #15 may close with
the completed scope. Merge, adoption, and cutover remain separate gates.

## Objective and Scope

Give maintainers an attributable explanation of which transitive npm changes
have a proven relationship to a changed direct dependency. Keep every changed
installed instance, declaration, lifecycle question, and coverage limit visible.
Grouping proves a dependency relationship; it establishes neither causation
nor individual research, compatibility, or safety.

N2 owns side-specific lockfile paths, relationship diagnostics, and bounded
install-lifecycle metadata interpretation for resolved npm changes. It supplies
existing T4 relationship, evidence, source, and finding records; T5 continues
to own unit formation. General upstream, advisory, malware, publisher, and
trust research, model assessment, rendering, workflow transport, publication,
adoption, and cutover remain separate. The old reviewer stays active.

## Inputs and Handoff

1. Consume the authentic N1 result from trusted orchestration, including its
   binding, changes, sources, normalized root snapshots, gaps, coverage, and
   independent comparison state. N1 is merged into `main` in
   [PR #132](https://github.com/andrewpucci/dependency-update-advisor/pull/132).
   Reconcile the handoff against its actual exports before implementation.
2. Preserve `invalid`, `obsolete`, and `unavailable` outcomes without turning
   them into an empty successful inventory. Validate binding/source/instance
   consistency and explicit limits before using snapshots. PR text, model
   prose, and caller-supplied paths cannot establish authentic collector data.
3. Return a detached, immutable enrichment of that same inventory. Preserve
   all change IDs, nullable sides, declaration maps, direct roles, source
   identities, existing gaps, and comparison availability. Add relationships,
   attributable diagnostics, lifecycle sources, and findings without pairing,
   deleting, or duplicating inventory records.
4. Missing snapshots, unresolved paths, or unsupported layouts cannot prove
   absence. N1 may omit snapshots after retention exhaustion; preserve its
   `budget` gap and leave relationships unproven. Do not refetch or repair
   lockfiles through a separate client.
5. Trusted orchestration assembles the other ecosystem slots and C2 context,
   then calls T4 and passes only its accepted packet to T5. Preserve existing
   failure behavior on T4 rejection. N2 does not issue an assessment or verdict.

The implementation plan may choose an internal result type. It must document
the exported handoff without changing packet version 1, adding
graph-completeness assertions, or widening T5's grouping eligibility.

## Relationship Contract

### Exact installed edges

Work independently within each N1 root, revision side, and immutable lock
source. The [npm lockfile format](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/#packages)
records installed locations; directory nesting alone does not establish a
logical dependency edge.

For supported conventional `node_modules` layouts, resolve a dependency-map
key to its installed slot: look in the declaring package's own `node_modules`,
then in the `node_modules` of each enclosing package slot, ending at that
root's `node_modules`. A scope directory such as `node_modules/@scope` is part
of a slot name, not an enclosing package. For example, a dependency of
`node_modules/a/node_modules/@s/b` is looked up under
`node_modules/a/node_modules/@s/b/node_modules`, then
`node_modules/a/node_modules`, then `node_modules`. This follows the lookup
direction described by
[npm's folder documentation](https://docs.npmjs.com/cli/v11/configuring-npm/folders/#cycles-conflicts-and-folder-parsimony).
Stop at the nearest recorded slot. A nearer unresolved, linked, or invalid
slot blocks falling through to a farther same-name package. Never search
another root, the consumer filesystem, or the public registry to resolve a
lockfile edge.

Use `dependencies` and installed `optionalDependencies` edges, with optional
entries taking precedence for a duplicate key. A declared optional package
is affirmatively absent, and contributes no edge, only when no slot on its
complete lookup chain is recorded and no chain position is an unresolved
path; an unresolved chain position leaves it unresolved. A missing required
target or unreadable candidate is unresolved. Preserve scoped-name boundaries
and installed alias slots; actual package names alone do not identify targets.
Accept an alias edge only when its target identity is established from the
retained immutable data. Unsupported source/specifier semantics leave that
edge unproven rather than being approximated by a string or semver guess.

Peer-only relationships, links, workspaces, overrides, shrinkwrap, and other
layouts outside N1's supported conventional graph remain explicitly
unsupported for proof construction. Retained peer maps are not ordinary
child edges. A path containing an unsupported edge cannot become a proof;
independent supported positive paths need not be discarded. No completeness
or exclusive-reachability claim follows from this supported subset.

Traverse exact instances, including unchanged intermediate packages. Handle
cycles with a visited-instance set; proofs contain no repeated instance.
Select one deterministic supported path per eligible anchor/member pair:
shortest path, then UTF-16 code-unit ordering of the canonical instance-path
sequence. Several valid paths to the same anchor do not create ambiguity
between anchors and must not cause exponential path enumeration.

### Eligibility and attribution

1. Preserve T5's complete npm inventory gate. Unknown roles in the relevant
   root, partial/unavailable ecosystem inventory, or multiple changed direct
   resolved dependencies prevent grouping. Count direct additions, updates,
   and removals across both revisions, as T5 specifies. Declarations do not
   count as anchors or installed graph nodes.
2. For an update or addition, prove the path in the head lockfile; for a
   removal, use the base lockfile. The anchor must exist on that side. Never
   stitch base and head edges, reverse a dependency, cross roots, or use a
   removed anchor for a head-side member. Root-moving changes cannot anchor
   or join a group.
3. Emit existing `RelationshipProof` records with exact changed endpoint IDs,
   `ecosystem: 'npm'`, side, lock source ID, and the complete path of `NpmSide`
   instances. Every adjacent step must be a resolved immutable edge. Start
   and end must equal the changes' applicable sides, and all steps must cite
   the same root and source. Ensure the lock source scopes both changed
   endpoints, respecting existing source membership bounds.
4. Emit no eligibility proof for an ambiguous or unsupported path. Multiple
   changed direct anchors leave the member standalone even if a positive
   path is known for just one. Missing proofs never establish that other
   anchors are unreachable. T4 verifies structure and attribution; N2 remains
   responsible for actual edges. T5 applies its own conservative gates.
5. Sharing with unchanged direct dependencies does not prevent grouping when
   the existing single-changed-anchor rule is satisfied. Preserve observed
   sharing in an attributable explanation; do not claim exclusive ownership.
   An incomplete search cannot establish that sharing is absent.
6. A member without an eligible path stays standalone, retaining T5's fixed
   reason and next action. Keep more specific N2 observations attributable
   through bounded informational findings citing the immutable files. An
   orphan means no supported path was found; label it unproven when the
   graph search was incomplete. Ambiguity alone is not a required-research
   gap; an independently complete assessment may resolve a standalone unit.

Grouping changes decision counts, never change counts. Each input change must
reach exactly one T5 unit. Findings and research requirements remain attached
to their exact member, including members inside a direct group.

## Lifecycle Evidence Contract

The lockfile's `hasInstallScript` records an install-lifecycle signal, not
script text. npm writes the flag only as `true` and omits it otherwise, so a
missing flag is the ordinary no-signal state; treat an explicit `false` the
same way. Retain which state the lock recorded. An unchanged flag cannot
establish unchanged script commands. The
[npm scripts documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts/#npm-install)
also describes implicit install behavior, so this contract establishes only
the absence of explicit lifecycle commands, never of all installation behavior.

For each changed resolved npm instance, inspect the retained signal and obtain
bounded exact-version public metadata for each existing side when its public
registry source is established. Interpret only `preinstall`, `install`, and
`postinstall` for this contract. Additions have no invented base version;
removals have no invented proposed version. Declaration records retain their
empty evidence object and receive no lifecycle package claims.

Use an injected transport with fixed HTTPS origin `registry.npmjs.org` and
locally constructed, encoded package/exact-version paths. The
[registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
defines version metadata reads. Require the returned name and version to
match the requested instance, and bind the document to the lock instance by
integrity: the lockfile `integrity` must share a hash with `dist.integrity`,
or a `sha1-` lock value must match `dist.shasum`. A missing or mismatched
integrity leaves that side unresolved. Do not follow metadata URLs,
redirects, tags, or tarballs; send no credentials, cookies, repository names,
lock paths, manifest excerpts, or source code. Custom/private/unknown registry,
Git, URL, and local sources stay unsupported without an external lookup.

Validate full JSON shape and bounded lifecycle fields before interpretation.
A side's lifecycle question is answered with no explicit commands only when
its lock flag is missing or `false` and valid full exact-version metadata has
no `preinstall`, `install`, or `postinstall` command and no `gypfile: true`.
Record implicit behavior the metadata cannot express as a visible
informational note, not a required-evidence gap. A `true` flag with valid
metadata showing one of those commands answers it with those exact commands.
Every other combination leaves that side unresolved: a missing flag with a
metadata command, a `true` flag without explaining metadata, `gypfile: true`
without explicit commands, or wrong-version, abbreviated, malformed,
truncated, or contradictory metadata. No script is run, evaluated, fetched
from a tarball, or classified as safe by its text.

Compare established commands exactly, preserving meaningful command text.
A new or changed proposed install command, supported by the immutable signal
and exact applicable metadata, yields existing `supplyChainChange` with
`change: 'install_script'`. Cite `install-script` sources attributed to each
required side under T4. Additions need proposed-side evidence; two-version
claims need both sides. An unchanged `true` flag with different verified
commands still produces a finding. Preserve removals and removed commands
as observations without inventing a proposed-risk finding or a missing side.

Successful `installScript` evidence must cover every existing side as T4
requires. Preserve failed/missing/conflicting lookup reasons as partial or
unavailable evidence, with no supply-chain finding inferred from failure.
Retain lockfile observations as file-backed informational findings and use
separate `install-script` sources for attributable upstream metadata. Keep
excerpts bounded and sanitized; cite exact members/sides/versions even when a
lookup is shared between duplicate installed instances.

N1 currently retains same-instance metadata-only deltas as scoped unsupported
inventory gaps rather than resolved changes. Preserve those gaps and snapshots;
do not invent an equal-version update or silently claim lifecycle coverage for
an unrepresented delta. Expanding that inventory representation requires its
own approved amendment. Grouping can never hide this limitation.

## Bounds, Coverage, and Determinism

Require positive safe-integer caller limits for graph work, metadata requests,
response/total bytes, JSON depth/entries, per-request/total duration, and retained
output. Count graph visits and edge/slot inspections, including failed lookup
steps, against a documented cumulative work budget. Bound cycles and lookup
depth by the normalized input and the work limit. No implicit unbounded retry,
concurrency, or traversal default is allowed.

Reuse completed metadata reads only within an attempt and by exact public
package/version identity. Bind each retained use to its own source/member/side;
never reuse a result across different sources merely because names match.
Support caller cancellation and stop subsequent reads after cancellation or
budget exhaustion. Transport failures use existing safe fixed reasons and
must not expose response bodies or raw exceptions.

Preserve all N1 inventory gaps and independent comparison state. Relationship
search failure alone does not lower otherwise complete change inventory:
leave affected members ungrouped with visible diagnostics. A lifecycle lookup
failure affects member `installScript` evidence, not discovery completeness.
Never mark other required research categories complete from lifecycle data.

Respect existing T4 limits, including 128 combined changes, 256 relationships,
32 instances per path, source membership bounds, and packet bytes. An overlong
path cannot be truncated into a proof. If output cannot retain every inventory
record and necessary evidence limit, return an explicit bounded failure;
never trim changes or hide gaps to make a packet fit. T4 still rejects an
overflowing packet without a usable partial result.

Use stable canonical identities and UTF-16 code-unit order for observations,
proofs, sources, and findings. Reordering maps or roots must preserve output.
Under fixed count and byte budgets it must also preserve which requests are
attempted. Duration limits and cancellation may stop work at different points;
the result shows that as explicit fixed-reason gaps, never as different
claims. Keep inputs
unchanged and output detached; never retain cross-attempt mutable state.

## Tech Stack, Structure, and Code Style

Use Node.js `>=24.11.0 <25`, ESM, strict TypeScript, existing dependencies,
and source-adjacent tests importing from `vite-plus/test`. Follow repository
formatting and the existing fixed-reason evidence vocabulary. Keep graph
interpretation separate from transport and never use a package install to
reconstruct relationships.

| Location                                         | Responsibility                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `src/evidence/npm.ts`                            | Existing N1 inventory and normalized snapshots; unchanged by N2.             |
| `src/evidence/npm.test.ts`                       | Existing N1 fixtures; must keep passing.                                     |
| `src/evidence/npm-graph.ts`                      | Pure relationship proofs and diagnostics; exports the N2 handoff.            |
| `src/evidence/npm-graph.test.ts`                 | Synthetic lockfile graph, identity, and eligibility fixtures.                |
| `src/evidence/npm-registry.ts`                   | Bounded exact-version registry metadata reader and lifecycle interpretation. |
| `src/evidence/npm-registry.test.ts`              | Mocked registry responses, bounds, binding, and lifecycle fixtures.          |
| `src/evidence/npm.integration.test.ts`           | Real N1 → N2 → T4 → T5/C3 handoff with mocked reads.                         |
| `src/schema.ts`, `src/units.ts`, `src/policy.ts` | Existing packet, grouping, and finding contracts; preserve behavior.         |
| `docs/specs/SPEC-npm-relationships.md`           | This supporting contract.                                                    |

The graph module performs no I/O; its handoff calls the registry reader for
lifecycle evidence, so trusted orchestration sees one N2 entry point. The
reader returns validated exact-version documents to its lifecycle
interpretation and is shaped so S3
[#53](https://github.com/andrewpucci/dependency-update-advisor/issues/53) can
reuse it for other exact-version npm metadata; this contract does not require
that reuse. Do not add a new parser/provider dependency or speculative graph
abstraction.

Use the existing proof shape; for example, with exact validated instances:

```ts
const proof: RelationshipProof = {
  ecosystem: 'npm',
  fromId: anchor.id,
  toId: member.id,
  side: 'head',
  sourceId: headLockId,
  path: [anchor.to, intermediate, member.to],
};
```

This illustrates the record contract, not a new executable entry point.
Nullable sides must be narrowed before constructing it.

## Testing Strategy and Success Criteria

Use synthetic sanitized fixtures and mocked GitHub/registry responses. Tests
must exercise actual collector and validator exports rather than reproducing
the implementation in a test helper. Assert exact identities, proof edges,
unit membership/counts, findings, and visible gaps.

| Scenario                                                                                  | Required result                                                                                    |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| One changed direct anchor with nested and hoisted transitive updates                      | Exact supported head paths group once; unchanged intermediate nodes remain in proofs.              |
| Transitive addition/removal; direct addition/removal                                      | Correct null sides and head/base proofs; wrong-side anchors cannot group.                          |
| Duplicate names, versions, scoped names, alias slots, separate roots                      | Only the resolved installed instance is linked; no name-only collapse or cross-root proof.         |
| Nearer duplicate or unresolved slot shadows a farther package                             | Use the nearest proven slot or leave unresolved; never skip the nearer blocker.                    |
| Installed optional dependency; same key in `dependencies` and optional map                | The installed optional edge proves; the optional entry wins the duplicate key.                     |
| Affirmatively absent optional dependency; unresolved position on its chain                | Absent adds no edge; an unresolved chain position leaves the edge unresolved.                      |
| Multiple changed direct dependencies, including removal plus update                       | T5 keeps transitive members standalone even with only one supplied positive path.                  |
| Sharing with unchanged direct dependencies                                                | Eligible grouping remains possible; observed sharing survives without a causation claim.           |
| Orphan, unknown role, unsupported peer/link/workspace edge                                | Standalone unit and attributable reason; no fabricated absence or proof.                           |
| Cycles, diamonds, repeated paths, reordered maps                                          | Termination, canonical supported path, no duplicate proof or changed output.                       |
| Partial npm inventory; snapshot retention exhaustion                                      | Existing gaps survive and grouping is suppressed; no silent successful empty graph.                |
| Declaration-only or declaration plus resolved group                                       | Declarations remain standalone and do not alter resolved-anchor counts or acquire research claims. |
| New/changed explicit script; unchanged true flag with changed commands                    | Exact-version evidence produces a member-specific install-script finding even inside a group.      |
| Unchanged scripts, removed commands, added/removed package                                | Correct existing-side coverage, no invented version or proposed-risk claim.                        |
| Missing or `false` flag; valid full metadata with no lifecycle command or `gypfile`       | That side's evidence is complete; implicit behavior appears as a note, not a gap.                  |
| Missing flag with a metadata command; `true` flag unexplained; `gypfile` without commands | Unresolved conflict for that side; no supply-chain finding is inferred.                            |
| Wrong name/version, integrity mismatch, abbreviated metadata, lookup failure              | Unresolved lifecycle evidence; failure is never a verified supply-chain finding.                   |
| Same-instance metadata-only delta                                                         | Existing inventory gap remains visible; no equal-version update is invented.                       |
| Redirect, private/custom source, credentials, malformed/oversized response                | No unsafe request, disclosure, or raw diagnostics; bounded explicit failure/gap.                   |
| Graph/request/time/retention exhaustion and cancellation                                  | Stop bounded work; retain identifiable changes and limits or return explicit failure.              |
| Overlong proof, source splitting, packet overflow                                         | Never truncate a proof or bypass T4 ceilings; genuine T4 acceptance/rejection is asserted.         |
| Empty/unavailable comparison; mixed npm/Actions packet                                    | Immutable npm evidence survives and each ecosystem retains its own coverage.                       |

Integration fixtures must pass real N1 output through N2 and T4 into T5,
asserting that the union of unit members equals every input change exactly
once. Verify that C3 still receives grouped member lifecycle findings and
missing install-script evidence; neither an anchor nor a successful lookup
for a different instance can erase them. Existing N1, T4, T5, and C3 checks
must continue to pass. No new numeric quality threshold is proposed.

## Implemented N2 Handoff

`src/evidence/npm-graph.ts` exports `proveNpmRelationships(input)` for pure
relationship collection and `enrichNpmEvidence(input, dependencies)` as the
single asynchronous N2 handoff. Input has independently verified `binding`,
authentic N1 `inventory`, and explicit `limits`. Non-inventory N1 outcomes
propagate; successful output retains the N1 fields and adds `relationships`
and `findings`. Output is detached and deeply frozen. Invalid input or a
result that cannot fit returns no usable partial contribution.

Limits require `maxGraphWork`, `maxRetainedBytes`, `maxRequests`,
`maxResponseBytes`, `maxTotalBytes`, `maxJsonEntries`, `maxJsonDepth`,
`requestTimeoutMs`, and `totalTimeoutMs`, all positive safe integers. Graph
work includes structural input inspection and edge/slot/visit processing.
Retention and response limits count UTF-8 bytes. Registry entries count JSON
properties/array elements cumulatively; depth counts containers. Total
registry duration starts after bounded input validation and includes graph
traversal and metadata reads. Count/byte budgets preserve request order;
duration/cancellation yield explicit fixed-reason gaps.

Dependencies supply trusted `fetch`, monotonic `now`, and optional `signal`.
The registry module exports `createNpmRegistryReader(limits, dependencies)`
with sequential, attempt-local `read(request)`, and pure
`interpretNpmLifecycle(change, sides)`. A request has exact `name`, `version`,
`source`, and lockfile `integrity`. A successful metadata result carries a
frozen full document, constructed URL, and validated name/version. Each use
rechecks integrity, including after cache reuse. The reader requests full
JSON and rejects abbreviated content types or documents lacking the full
version `_id`. This is reusable by S3 without implementing its research.

T4 still validates the assembled packet. N2 retains original change-side
source IDs. Proof intermediates may cite the equivalent immutable lock source
already used by both endpoints; endpoints with different source IDs remain
unproven under the current contract. No source identity or membership limit
is rewritten to enable grouping. General research, assessment/rendering,
workflow publication, adoption, and cutover remain separate gates.

## Commands

For documentation-only planning changes:

```sh
npm run lint:md
npm run format:check
git diff --check
```

After separately approved implementation, use Node.js 24 and the committed
repository lockfile:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
git diff --check
```

Focused suites, including the new N2 suites:

```sh
npm test -- --run src/evidence/npm.test.ts src/evidence/npm-graph.test.ts src/evidence/npm-registry.test.ts src/evidence/npm.integration.test.ts src/schema.test.ts src/units.test.ts src/policy.test.ts
```

No build script exists;
packaging remains A1. Record the exact shared revision, working-tree state,
Node/npm versions, commands, outcomes, warnings, and omitted checks in issue
#15 or its PR. Distinguish CI merge revisions from PR heads. Documentation
checks cannot certify implementation, live disclosure, adoption, or cutover.

## Boundaries and Approval

- **Always:** Preserve immutable identities, every N1 record and gap, exact
  proof paths, member findings, separate coverage meanings, and the old reviewer.
- **Ask first:** Change approved inventory/packet/policy semantics, expand
  grouping beyond T5, support more lock layouts, add dependencies/providers,
  widen outbound data/hosts, raise packet ceilings, or change workflow duties.
- **Never:** Install PR dependencies, execute scripts or PR code, follow
  untrusted URLs, infer relationships from names/text, infer no scripts from
  missing metadata, suppress lifecycle gaps through grouping, publish private
  consumer details, or claim unverified parity/cutover.

Full-spec approval, plan approval, and execution approval are separate gates.
The revised specification, eight-task plan, and autonomous execution through
one PR are approved. Merge, adoption, and cutover remain separate gates.

## Open Questions

None for planning. Approval covers the revised lifecycle transport, integrity
binding, interpretation rules, graph resolution, and module split above.
Broader reachability #93 and same-instance metadata-only representation remain
separate amendments. The eight-task plan and autonomous execution in one PR
are approved.
