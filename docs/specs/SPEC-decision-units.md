# Spec: T5 Deterministic Decision Units

Status: approved for T5 execution, 2026-10-21. Supporting contract for `shared-review`
in [the capability map](README.md), scoped to
[issue #12: T5](https://github.com/andrewpucci/dependency-update-advisor/issues/12).
The [shared workflow](SPEC-shared-review.md), [T4 packet](SPEC-review-packet.md),
and [C3 policy](SPEC-advisory-policy.md) contracts remain authoritative.
The user confirmed the grouping, standalone resolution, revision identity,
completion, and follow-up scope decisions in the 2026-10-21 interview.
Those decisions are incorporated below. The reachability follow-up is tracked
under [Approval and follow-up](#approval-and-follow-up).
Approval: after confirming the interview decisions and reviewing the revised
specification, the user invoked `as-plan` on 2026-10-21 and requested child
issues under #12 on the project board. This authorizes planning and issue
organization. The user subsequently invoked `as-build auto`, approving the
six-task plan for #94–#99 and one PR closing those tasks and parent #12.
The deferred reachability extension #93 remains outside this execution scope.

## Objective

Give reviewer contributors a deterministic partition of every detected change
into meaningful decision units. Give maintainers an honest accounting of
assessed and unresolved work without claiming that grouped transitive members
were individually researched. Verified effective blockers survive missing model
analysis, and no unresolved unit can become a merge recommendation.

T5 owns unit formation, the packet-to-C3 policy projection, and coverage
accounting around C3's existing decision guard. It does not collect evidence,
parse lockfiles, call a model, validate raw model responses, render comments,
publish status, or establish current-head write authority.

Implementation: the isolated [unit handoff](../../src/units.ts) and its
[fixtures](../../src/units.test.ts) are implemented in
[PR #100](https://github.com/andrewpucci/dependency-update-advisor/pull/100), merged
into `main`. [Verification issue #99](https://github.com/andrewpucci/dependency-update-advisor/issues/99)
records exact-revision evidence and remaining downstream integration gates.

## Inputs and Assumptions

- This is one capability within the approved `shared-review` module, not a new
  module or a replacement capability map.
- C3 is implemented. T4's validator is merged in
  [PR #89](https://github.com/andrewpucci/dependency-update-advisor/pull/89).
  Downstream integration remains separate. Read their approved contracts and
  actual exports before implementation.
- Unit formation accepts only T4's successful, detached readonly packet.
  Rejected packets expose no usable inventory. The trusted caller must pass
  through T4; a TypeScript cast cannot establish validation or trust.
- Every change has its exact T4 identity, role, nullable base/head sides,
  evidence categories, findings, and immutable source references. T5 must not
  infer missing roles, repair inventory, or pair additions with removals.
- The caller supplies successful trusted configuration and a fixed evaluation
  time to C3. Assessment states arrive only after M2 validates them against
  the exact unit inventory and policy ceilings.
- No runnable shared workflow is implied. The old reviewer remains active.

## Unit Contract

### Partition, identity, and order

1. Every packet change belongs to exactly one nonempty unit. The union of
   member IDs equals the change inventory, with no duplicates or invented
   members. Additions, removals, unknown roles, repeated names, and distinct
   installed instances all count. A grouped unit counts as one decision but
   retains the exact number and identities of its changed members.
2. A standalone unit has one member and no anchor. A direct group has one
   changed direct anchor and one or more proven transitive members. A direct
   dependency without eligible members stays standalone. Never group direct
   dependencies together or assign one transitive member to several units.
3. Identity includes the verified repository, pull number, packet base SHA,
   and reviewed head SHA; the ecosystem; the unit kind; the anchor change ID
   when present; and the sorted member change IDs. Change IDs are the packet's
   `changes[].id` values, which T4 keeps unique within a packet and which
   findings and sources already cite. Never use display names or array
   indices. T5 does not re-derive T4's internal instance keys. The collector
   must assign stable change IDs for the same revisions; if it does not, unit
   identity changes and old assessments fail to attach rather than attaching
   to a different member. Canonical encoding must be unambiguous; if hashing
   is used, detect any duplicate result rather than merging units on a
   collision.
4. Sort member IDs and units by a documented locale-independent ordering of
   canonical identity. Permuting changes, proofs, sources, or findings cannot
   change membership, IDs, or output order. A new base or reviewed head changes
   unit identity; adding or removing a member changes that group's identity.
   Even when the PR head is unchanged, a different packet base prevents prior
   assessments from attaching, so a later review assesses those units afresh.
   Stable member IDs cannot make an assessment reusable across different
   base/head revisions. Unit identity does not decide whether a published
   review is obsolete. T1 freshness decides that; under the approved
   [base-identity amendment](SPEC-event-verification.md#base-identity-amendment),
   a moved base SHA with an unchanged merge base stays fresh.
5. Unit records retain member IDs, anchor, exact count, grouping reasons and
   proof keys, member evidence links, findings, and coverage limits. A proof
   key is the canonical serialization of the entire validated
   `RelationshipProof`, including side, lock source ID, and path; T4 already
   rejects duplicate proofs by this value. Never cite a proof by array
   position. Keep large source/context records in the original packet and
   refer to them by validated IDs. Grouping grants no additional source
   disclosure rights.

### Conservative proven grouping

Only npm and uv lockfile relationships can form direct groups. Actions
occurrences always remain standalone, including repeated uses of one action.
Package names, scopes, versions, platform suffixes, Dependabot group labels,
and model prose are never relationship evidence.

A grouping proof must run from the changed direct anchor to the exact changed
transitive member in the same ecosystem, root, revision side, and immutable
lockfile. The member's change kind selects the side: head for updates and
additions, base for removals. The anchor must have an instance on that side,
so a removed anchor cannot anchor a head-side member and an added anchor
cannot anchor a removed member. Do not reverse an edge, combine different
sides or lockfiles, or infer a path between unconnected proofs. Several paths
to the same anchor are not several anchors.

T4 checks only structural consistency: proof endpoints match the recorded
changes, every step shares one root and lock source, and instances agree
across proofs and changes. T4 does not read the lockfile, so it cannot confirm
that adjacent steps are real dependency edges, that the graph is complete, or
that no other path exists. Grouping therefore trusts the authenticated
collector's asserted paths, as the T4 contract does.

Initial restriction: the ecosystem's inventory slot must be `complete`, and
the applicable root must contain exactly one direct change, counted across
both sides and all change kinds. A change counts toward every root that its
base or head side names. T4 records inventory coverage per ecosystem, not per
root, so the ecosystem slot gates every root in it. Partial/unavailable
inventory or any unknown role in that ecosystem/root prevents claiming this
uniqueness. Several direct changes in the root leave transitive members
standalone even when only one has a supplied positive path. Counting both
sides keeps a direct removal that might explain a head-side transitive change
from being ignored. Missing paths cannot establish that another candidate is
unreachable.

A change whose base and head name different roots counts in both inventories
but remains standalone and cannot anchor a group. Otherwise one moving anchor
could join base-root removals and head-root updates into a cross-root group.

The [npm evidence contract](SPEC-npm-evidence.md) keeps shared, orphaned, or
ambiguous members as separate unresolved units. The confirmed interpretation
for this supporting contract is that "shared" means a member that could belong to
more than one changed direct anchor. With exactly one direct change in a
complete root, a member reachable from that anchor is grouped even when
unchanged direct dependencies also reach it. Preserve known sharing in the
group's explanation, alongside each member's own findings and evidence
requirements. The group records a proven relationship to the only direct
change; it does not claim that the anchor caused the transitive change,
exclusive reachability, or individual research.

"Unresolved" means ungrouped and pending its own assessment; a standalone unit
stays unresolved until M2 validates an assessment for it.
The [uv evidence contract](SPEC-uv-evidence.md) maps a transitive change only
when the lockfile graph proves it and marks an unreliable mapping incomplete.
The confirmed interpretation is a standalone unit with a fixed relationship
reason. An unreliable mapping is a required-evidence gap only when it leaves
a concrete required-evidence question unanswered; inability to group alone
does not create that gap.

This keeps grouping sound with the current packet contract. Broader grouping
requires a reviewed collector/T4 extension that proves complete reachability
for all candidate anchors at the exact root and revision. A bare completeness
flag or an omitted proof is insufficient. Retaining cited proofs and explicit
standalone reasons gives that extension a clear boundary without requiring a
different assessment or policy model. Until then, a grouped PR with several
direct changes in one root gets no transitive grouping in that root. The cost
is more standalone units, which provider budgets must not silently discard.
The extension belongs to npm/uv collector planning, where the lockfile is
parsed, plus a matching T4 packet change, not to this T5 scope; see
[reachability follow-up #93](https://github.com/andrewpucci/dependency-update-advisor/issues/93).

Ambiguous, absent, insufficient, wrong-side, or unsupported relationship
evidence leaves the change standalone with a fixed reason and a concrete next
action. A structurally valid T4 path is not automatically a sufficient T5
grouping proof. No raw lockfile retrieval or new graph-completeness assertion
is added to T4 by this draft.

Standalone analysis can resolve such a unit using its own validated evidence;
inability to group is not by itself a required-evidence failure. Until an
assessment is validated, the unit remains explicitly unattempted or unresolved.
Relationship uncertainty must remain visible after assessment; it cannot be
relabelled as successful grouping. A complete standalone assessment resolves
the unit when its required evidence is complete. If the unexplained relationship
leaves a compatibility, security, or other required-evidence question unanswered,
retain that gap under C3; do not treat the assessment as resolving the question.

### Preserve evidence and project to C3

Each formed unit projects to the existing C3 `PolicyUnit`. Members use change
IDs. A member's `name` is the npm/uv `name` or the Actions `action`, taken
from the head side when present and otherwise the base side. Updates retain
current/proposed versions or refs, additions only proposed, and removals only
current. Retain the original packet for richer instance,
source, and context details that C3's `Member` does not carry.

Assign each finding to the one unit containing its `memberId`, without changing
its ID, applicability, references, severity, remediation, or validation steps.
Evaluate all member findings, including transitive ones. A group cannot hide
one member's malware, vulnerability, install-script change, or incompatibility.
Effective C3 policy, including explicit relaxations and the fixed malware hold,
remains authoritative.

Project each member/category evidence record to a distinct, stable C3
`EvidenceSource`. Preserve its status, original source links, and all reason
codes in structured mapping metadata. C3's single `reason` is the first
recorded reason in T4's fixed reason vocabulary order (`permission` through
`unknown`), independent of input order. T4 does not export that order at
runtime, so T5 restates the 10-entry order and tests it against T4's
`EvidenceReason` union; exporting it from T4 instead is an Ask-first change.
An `available` record has no reasons and uses an empty `reason`, which C3
never reports. C3's `coverageLimits` retains all limits. Aggregate each unit's
limits without losing member attribution.
Preserve optional signal names so C3 classifies failed publish-time,
deprecation, trust, and publisher lookups as unchecked signals.

Grouping never promotes a member's `partial` or `unavailable` evidence to
`available` or `group_backed`. This initial T5 scope does not synthesize
`group_backed` evidence: T4's individually attributed evidence remains the
authority. The [T4 contract](SPEC-review-packet.md) reserves `group_backed`
for T5, so nothing emits it in this scope. An anchor's available advisory,
malware, or script metadata cannot substitute for another member's lookup.
Grouping reduces assessment units, not required evidence. M2's later provider
projection must preserve these facts.

### Assessments, unresolved work, and packet-wide gaps

Formation creates no assessed states. Before analysis, T5 passes every unit
to C3 as explicitly `unattempted` with an action to run analysis. After
analysis, pass only M2's validated `assessed`, `unavailable`, `unattempted`,
or `rejected` states keyed by this inventory. A unit without an M2 state is
passed with no state and stays unresolved under C3's existing `missing`
semantics; T5 does not substitute `unattempted`. Duplicate/unknown unit IDs
and stale-head/group results must be rejected by M2 before this handoff; T5
must not silently attach them.

Use `evaluatePolicy` and `summarizePolicy` from `src/policy.ts`. Do not copy rule
matching, override logic, verdict ranking, or the decision guard into T5.

- An effective verified finding hold yields `do_not_merge` with every
  unresolved unit still retained, even if all analysis is unavailable.
- Otherwise, any unresolved unit yields `decision_incomplete`.
- Complete validated units may yield advice only within C3's ceilings. If an
  override relaxes the only hold while another unit remains unresolved, the
  result is `decision_incomplete`, with the finding still retained.
- A model-only hold must not override unresolved work by pretending to be a
  verified finding. Completed model advice still follows C3's guard.

Retain all three ecosystem inventory slots separately from the units.
`partial`/`unavailable` inventory remains a packet-wide gap, including when
there are zero known changes or every known unit is assessed. T5's coverage
summary must expose these gaps with ecosystem, reasons, source IDs, and
concrete recovery actions. Do not invent a dependency unit for an unknown
change count or attach a root-wide gap to an unrelated package.

C3's guard does not accept packet-wide inventory gaps, and with zero units it
returns `merge`. T5's handoff therefore carries one authoritative outcome that
O1, T2, and W2 must read:

- With packet-wide gaps, the outcome is `do_not_merge` only when
  `summarizePolicy(evaluation, {}).decision` is `do_not_merge`, and otherwise
  `decision_incomplete`. With no states, every unit is missing, so C3's
  documented guard returns `do_not_merge` only for a verified finding hold.
  Validated model advice stays in the unit assessments.
- Without packet-wide gaps and with at least one unit, the outcome is C3's
  `decision` from the real assessment states.
- A zero-change packet with all slots complete/not applicable returns an
  explicit empty-inventory outcome with zero assessments and no merge verdict.
  No model analysis is needed. O1 presents "No dependency changes to review";
  W2 owns its no-work publication behavior. Never describe zero units as
  successful model analysis. Zero known changes after failed or incomplete
  collection remain `decision_incomplete`, not a proven empty inventory.

T5 keeps C3's summaries as nested provenance under names that cannot be
mistaken for the final outcome. The exact field names are planning choices.
This narrow inventory check calls C3 rather than repeating its guard or unit
precedence.

Expose changed-member count, total units, assessed units, unresolved units,
grouped/standalone counts, per-ecosystem coverage, and required evidence gaps.
Assessed plus unresolved equals total units. Evidence completeness and decision
coverage remain separate: an assessed unit can still have required evidence
gaps, and relaxed policy cannot turn those gaps into execution success.
Optional unchecked signals alone do not fail execution. T2/W2 decide and
publish execution status; T5 returns facts, not write authority or success.

## Tech Stack and Project Structure

Use Node.js `>=24.11.0 <25`, ESM, strict TypeScript, Node built-ins, and
source-adjacent tests importing from `vite-plus/test`. Keep existing pins;
no new dependency, network access, credential, or runtime schema is needed.

```text
src/units.ts                      → proposed formation, C3 projection, coverage handoff
src/units.test.ts                 → proposed grouping and incomplete-decision fixtures
src/schema.ts                     → existing T4 packet types and bounded validation
src/policy.ts                     → existing C3 evaluator and sole unit decision guard
docs/specs/SPEC-decision-units.md → this T5 supporting contract
```

Keep operations pure and inputs readonly. Reuse T4/C3 types, return detached
results, and do not mutate the packet or caller-supplied assessment states.
The exported signatures and encoding are described below. Do not introduce a
generic graph engine or plugin layer.

## Implemented Interface and Handoffs

`src/units.ts` exports three pure operations:

```ts
formDecisionUnits(packet): UnitInventory
evaluateUnitPolicy(inventory, config, evaluatedAt): PolicyResult
summarizeDecisionCoverage(inventory, config, evaluatedAt, states?): DecisionCoverage | ConfigFailure
```

These signatures are abbreviated; the source defines their strict types.
`packet` is the successful T4 `PacketResult` packet, and `config` uses C3's
existing config argument. `evaluatedAt` is caller-supplied UTC epoch
milliseconds. Formation and evaluation do no I/O or external validation.
No operation grants execution success or publication authority.

`UnitInventory` contains a detached frozen packet and frozen `DecisionUnit`s.
Each unit extends C3's `PolicyUnit` with ecosystem, kind, nullable anchor,
member IDs/count, proof keys, relationship reason/action, and `evidenceLinks`.
These links map C3 source IDs to original packet member/category, status,
sorted source IDs, and all fixed reasons. C3 sources use JSON tuples
`[memberId, category]`; attributable coverage-limit strings use
`[memberId, category, status, reason]`. Findings and packet citations remain
unchanged. Source/context text stays in the packet rather than being copied
into a separate provider projection.

Unit IDs are JSON tuples containing repository ID, lowercased owner/name,
PR number, base/head SHAs, ecosystem, unit kind, anchor ID, and sorted member
IDs. Proof keys serialize the whole proof with recursively sorted object keys
and unchanged array order. Strings are ordered by UTF-16 code units, without
locale dependence. No hashing, graph traversal, or new packet cap is added.

Standalone reasons are `independent_change`, `actions_occurrence`,
`unknown_role`, `inventory_incomplete`, `multiple_direct_changes`,
`no_direct_change`, `missing_relationship`, and `multiple_roots`.
Groups use `proven_relationship`. Every reason carries a fixed next action.
T4 has no separate unchanged-sharer list; T5 preserves asserted paths and the
source table without inventing sharers, causation, or exclusive reachability.

`evaluateUnitPolicy` delegates to C3 with this inventory's units. Failed
configuration returns only C3's failure. `summarizeDecisionCoverage` evaluates
that same inventory internally, so a caller cannot pair a separate policy
evaluation with a different inventory. The caller must use the same trusted
config/time throughout analysis and supply only M2-validated states for those
units. An omitted states argument creates pre-analysis `unattempted` states;
an explicit empty map preserves post-analysis `missing` states. T5 does not
validate raw model results or accept stale/unknown unit IDs on M2's behalf.

On success, `DecisionCoverage` exposes one authoritative `outcome`:

- `{ kind: 'advice', verdict }` for C3 advice, including a verified hold with
  unresolved work still retained;
- `{ kind: 'decision_incomplete' }` for unresolved work or inventory gaps
  without a verified hold;
- `{ kind: 'empty_inventory' }` for a proven empty inventory, without a merge
  verdict or fabricated model assessment.

The result retains the inventory, exact member/unit/assessed/unresolved and
grouped/standalone counts, and all packet-wide `inventoryGaps`. Each gap has
ecosystem/status, ordered reasons, source IDs, and reason-specific recovery
actions. Per-ecosystem coverage remains in `inventory.packet.coverage`.
`policyProvenance.assessments` is C3's real-state summary; when inventory gaps
exist, `policyProvenance.withoutAssessments` records the no-state guard used
to identify verified holds. Neither nested summary is an alternative final
outcome. All outputs are detached frozen snapshots.

## Commands

For this documentation-only change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

For implementation, install with `npm ci` if needed, then run on one revision:

```sh
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Once the proposed test file exists, a focused command is:

```sh
npm test -- --run src/units.test.ts src/policy.test.ts src/schema.test.ts
```

Record exact SHA, working-tree changes, environment, commands, outcomes, and
checks not run in issue #12 or its PR. Installation is separate from validation.
There is no build command yet; packaging remains A1.

## Code Style

Use camelCase, explicit unions, `.js` import suffixes, single quotes, and
focused assertions. This existing C3 API demonstrates the required missing
assessment behavior; `policy` is a successful evaluation for a nonempty
inventory with no verified hold:

```ts
import { expect } from 'vite-plus/test';
import { summarizePolicy } from './policy.js';

const result = summarizePolicy(policy, {});
expect(result.decision).toBe('decision_incomplete');
expect(result.unresolvedUnits).toHaveLength(policy.units.length);
```

The snippet illustrates a contract assertion, not a new runtime entry point.

## Testing Strategy and Success Criteria

Use synthetic bounded packets and table-driven unit tests. Do not use live
GitHub/model calls, private consumer records, or invented numeric coverage bars.

| Required case                                                                                    | Observable result                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed ecosystems, repeated npm roots/paths, uv variants, repeated Actions uses                   | Every exact change occurs in one unit; no identity collapse or cross-root/ecosystem grouping.                                                           |
| One changed direct anchor and proven transitive paths                                            | One direct group with exact member identities/count and cited proof keys.                                                                               |
| One changed direct anchor; transitive member also reached by an unchanged direct dependency      | Grouping allowed with known sharing explained, member findings/evidence preserved, and no claim that the anchor caused the change.                      |
| Several changed direct candidates, unknown roles, missing/ambiguous paths                        | Conservative standalone units with attributable reasons and actions.                                                                                    |
| Ungroupable member with complete standalone assessment and required evidence                     | Unit resolved; relationship uncertainty remains visible without creating a required-evidence gap by itself.                                             |
| Unexplained relationship leaves a concrete required-evidence question unanswered                 | Question and evidence gap survive standalone assessment and constrain advice/completion under C3.                                                       |
| Direct removal plus direct update in one root; transitive update with a head path                | Standalone; the removal counts as a second direct change in that root.                                                                                  |
| Updated anchor with a removed member; removed anchor with a head-side member                     | Base-side proof groups the removed member; a removed anchor cannot anchor a head-side member.                                                           |
| Positive path with partial/unavailable ecosystem inventory                                       | Standalone unit; unknown additional direct changes cannot be ruled out.                                                                                 |
| Updates/additions/removals, wrong-side or unrelated lockfile proofs                              | Only eligible same-side proofs group; every other change survives standalone.                                                                           |
| Synthetic 20 unpaired additions and removed-only inventory                                       | No fabricated version pair or dropped change; complete counts retained.                                                                                 |
| Permutations of changes/proofs, repeated calls, frozen inputs, new base/head SHAs or member sets | Deterministic membership/IDs/proof keys/order; no mutation or cross-call state; changed identity invalidates old assessments.                           |
| Actions, npm, and uv members; several reasons on one evidence record, permuted                   | Correct C3 member `name`; `reason` is the first in T4's vocabulary order; all reasons retained.                                                         |
| Required lookup failure in one grouped member; anchor evidence available                         | Member gap survives; no fabricated `group_backed`, clean-advisory, or malware claim.                                                                    |
| Failed optional lookup versus failed required lookup                                             | Correct C3 unchecked-signal versus evidence-gap classification and preserved reasons.                                                                   |
| Verified blocker plus one/all unavailable units                                                  | `do_not_merge` with findings and complete unresolved queue; no fallback loss.                                                                           |
| Only blocker relaxed while another unit is unresolved                                            | `decision_incomplete`; original finding and override provenance survive.                                                                                |
| Assessed, rejected, unavailable, unattempted, and omitted states                                 | Each unit counted once as assessed or unresolved; valid independent results retained.                                                                   |
| Complete known units plus partial/unavailable inventory, including zero changes                  | Packet-wide gaps survive and prevent a merge recommendation without a verified hold.                                                                    |
| Packet-wide gap with C3 `merge`, a model-only `do_not_merge`, or a verified hold                 | Authoritative outcome is `decision_incomplete`, `decision_incomplete`, or `do_not_merge`; C3's summaries stay nested provenance.                        |
| Complete empty inventory versus unavailable empty inventory                                      | Explicit empty-inventory outcome with no merge verdict versus `decision_incomplete` with the packet-wide gap; neither claims successful model analysis. |
| Assessed unit with required gap and locally relaxed evidence rule                                | Advice follows C3; evidence gap remains for failed execution handoff.                                                                                   |
| T4 maximum packet dimensions                                                                     | No hidden slicing, new lower cap, proof explosion, or lost inventory; grouping work is bounded by accepted input.                                       |

M2 must separately test raw model validation, exact unit accounting, and
cross-batch/stale-unit rejection. O1 must verify visible counts, group wording,
all blockers, and actionable unresolved queues. W2/T2/T3 must verify current-head
failure and publication ordering. Unit tests do not certify these integrations,
collector graph sufficiency, outbound disclosure, adoption, parity, or cutover.

## Boundaries

- **Always:** Partition all changes, cite immutable grouping proof, preserve
  member findings/evidence and all ecosystem gaps, use C3's guard, and keep
  decision coverage separate from evidence and execution completion.
- **Ask first:** Broaden grouping proof, synthesize group-backed evidence, change
  T4/C3 interfaces or resource ceilings, add dependencies/I/O, or change policy,
  publication semantics, provider budgets, or the privileged workflow boundary.
- **Never:** Infer relationships from names or model prose, execute PR code,
  trim members/findings to fit, label groups safe or individually researched,
  manufacture assessments, hide unresolved work behind policy overrides, or
  turn missing inventory/analysis into a merge recommendation.

## Baseline and Approval

The [B1 handoff](../../tests/parity/README.md) pins the
[source coverage contract](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/SPEC-dependabot-decision-coverage.md).
The baseline parsed full npm lockfiles. T5 instead consumes T4's bounded proof
records. More conservative grouping and explicit standalone assessment can
increase unit counts; record this proposed difference during parity review,
without weakening required evidence or claiming fidelity before comparison.

## Approval and Follow-up

The interview settled the behavioral choices above: grouping with unchanged
sharers, standalone resolution, revision-bound identity, counting direct
changes across both sides/all kinds, and distinct incomplete/empty outcomes.

[Issue #93](https://github.com/andrewpucci/dependency-update-advisor/issues/93)
tracks complete reachability evidence in npm/uv collector planning and the
matching T4 packet extension. The tracking prerequisite is satisfied. Broader
grouping remains outside T5, and implementing that follow-up is not a blocker
for the initial T5 scope.

The specification is approved for planning as recorded above. The implementation
plan is indexed in [parent #12](https://github.com/andrewpucci/dependency-update-advisor/issues/12),
with child issues #94–#99 and a local working handoff in `tasks/plan.md`.
The user approved that plan with `as-build auto` as recorded above.
