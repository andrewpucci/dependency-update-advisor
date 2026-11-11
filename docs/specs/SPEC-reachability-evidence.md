# Spec: Complete npm/uv Reachability Evidence for Multi-Anchor Grouping

Status: implemented on `issue-93` for tasks #266-#274, pending fresh-context review
and merge. Approved for planning 2026-11-10; the user approved the plan and
`as-build auto` the same day.
Supporting contract for `shared-review`, `npm-evidence`, and `uv-evidence` in
[the capability map](README.md), scoped to
[issue #93](https://github.com/andrewpucci/dependency-update-advisor/issues/93).
It proposes amendments to the [T4 packet](SPEC-review-packet.md),
[T5 decision units](SPEC-decision-units.md),
[npm relationships](SPEC-npm-relationships.md), and
[uv relationships](SPEC-uv-relationships.md) contracts. Those approved specs stay
authoritative until the amendments are applied.
The implemented initial T5 scope does not depend on this draft.

The 2026-11-09 interview settled four choices, recorded under
[Decisions](#decisions): per-pair verdict evidence, an in-place v1 amendment,
candidate accounting on every side a candidate exists, and a 1,024-verdict cap
with explicit truncation.

## Objective

Let a root with several changed direct dependencies group each transitive change
under its one reachable changed anchor, without ever treating a missing path as
proof that another anchor cannot reach the member. Today T5 forms a direct group
only when the root holds exactly one changed direct dependency. Every other
member stays standalone, which is safe but inflates decision-unit counts.

Success means a trusted collector can state, per changed direct candidate and
changed member, either a positive path, a proven absence, or an attributable
reason it cannot say. T5 groups only when that evidence leaves exactly one
reachable candidate. Anything less stays standalone with a fixed reason and
keeps every finding, evidence requirement, and limit.

Out of scope: causation or safety claims, `group_backed` evidence, Actions
grouping, dependency-group or peer-only graph support beyond N2/U2's existing
subsets, provider batching, rendering, and publication.

## Inputs and Assumptions

- T4 is merged: it validates positive `RelationshipProof` structure only. It
  does not read lockfiles, so it cannot confirm edges, completeness, or the
  absence of other paths. Grouping already trusts the authenticated collector's
  assertions; this draft keeps that boundary and adds assertions that T4
  validates structurally and T5 applies conservatively.
- Collectors (N2, U2) run in the trusted workflow on immutable base/head bytes
  and never execute PR code ([ADR 0002](../adr/0002-privileged-review-boundary.md),
  [ADR 0003](../adr/0003-immutable-files-for-dependency-inventory.md)). PR text,
  Dependabot prose, model output, package names, and versions never create
  verdicts.
- N2 (`src/evidence/npm-graph.ts`) and U2 (`src/evidence/uv-paths.ts`) are on
  `main`, as is the packet assembler `assembleReviewPacket` in `src/packet.ts`;
  the capability map's "pending merge" wording is stale. No consumer has
  adopted any packet; the old reviewer stays active.
- Candidate set: a changed direct resolved dependency, whether an addition,
  update, or removal, in the member's ecosystem and root. This keeps T5's
  existing counting rule.

## Evidence Contract

### Positive paths stay `relationships`

A `reachable` outcome is a T4 `RelationshipProof` unchanged. This draft adds no
second representation of a positive path, so a verdict cannot contradict a proof
by construction. A proof alone never establishes uniqueness.

### New `reachability` verdicts

The v1 envelope gains one required array, `reachability`, of closed records:

```ts
type ReachabilityVerdict = {
  ecosystem: 'npm' | 'uv';
  side: 'base' | 'head';
  sourceId: string; // immutable lock source for this root and side
  anchorId: string; // changed direct change with an instance on `side`
  memberId: string | null; // changed non-anchor change; null only when non-proving
  outcome: 'unreachable' | 'unknown' | 'unsupported' | 'failed' | 'truncated';
  reasons: EvidenceReason[]; // empty for 'unreachable', nonempty otherwise
};
```

- `unreachable` is proven absence: the collector traversed the exact-instance
  graph from the anchor on that side in that lock source and found no supported
  path to the member's exact instance. It requires `memberId` and no reasons.
- `unknown`, `unsupported`, `failed`, and `truncated` prove nothing. Reasons use
  T4's existing ten-entry `EvidenceReason` vocabulary, with a required subset
  per outcome: `unsupported` includes `unsupported`; `truncated` includes
  `truncated` or `budget`; `unknown` includes `unknown`; `failed` includes at
  least one of `permission`, `rate_limit`, `timeout`, `missing`, `malformed`, or
  `conflict`.
- Emission is all-or-nothing per anchor and side: either pair records
  (`memberId` set) or one scope record (`memberId: null`), never both. A scope
  record means the collector could not complete that anchor's traversal on that
  side for any member in the root. This includes anchors it never started, so
  every unfinished anchor gets its own scope record and the limit stays
  attributable.
- A pair with no record is `unknown`. Omission never proves absence, and a
  missing proof never proves absence.
- Verdicts and second proofs are optional evidence. A collector emits a pair
  record only for a member that has a positive proof from exactly one candidate
  anchor. For a member reachable from several candidates it emits proofs for
  at most two of them, enough for T5 to report `ambiguous_anchors`, and no
  verdicts. Members with no reachable candidate get neither. When bounds bind,
  the packet assembler drops optional evidence as described under Bounds and
  keeps an attributable limit. Dropping never creates a group.
- There is no completeness flag at ecosystem, root, or lockfile level. One
  `unreachable` record asserts one anchor/member/side/source fact.

### When a collector may emit `unreachable`

All of these must hold, otherwise it emits a non-proving outcome:

1. The traversal started at the anchor's exact instance on that side and
   covered its whole resolved closure in the single lock source for that root.
2. Every edge in the closure was resolved to an exact instance or affirmatively
   absent under N2's lookup-chain rule. No unresolved chain position, unreadable
   candidate, unsupported edge (peer-only, link, workspace, override,
   shrinkwrap, unsupported source/specifier), or uv selector ambiguity remained
   in the closure.
3. Neither the N1/U1 work budget nor the verdict cap interrupted it.
4. The lock source's own status is `available` with no reasons.
5. For uv, the closure ignores marker and extras contexts: it contains every
   node and edge reachable under any marker or extras guard, so a path that
   exists only on some platform or extra still counts as reachable. A node or
   edge skipped because its marker, extras, or membership is unresolved makes
   the verdict non-proving. (A traversal confined to the anchor's own marker
   context would wrongly report `unreachable` for a package another anchor
   reaches only under `sys_platform == 'win32'`.)

Condition 2 is strict, and many npm closures contain a peer-only or link edge.
Low grouping yield in such roots is an accepted trade-off, not a defect; those
members stay standalone and assessable. An edge outside the anchor's closure
does not invalidate its absence. A single traversal per anchor and side yields
every pair for that anchor, so cost follows existing graph bounds rather than
the pair count.

The closure must classify every skipped edge, never fold it into "absent". The
existing resolvers return an undifferentiated null or undefined for zero
candidates, several candidates, an unresolved path, and a true absence. Only an
affirmative absence under N2's lookup-chain rule counts as absence. A selector
that matches zero or several targets, an unresolved chain position, or an entry
with no instance makes the verdict `unknown` or `unsupported`. The uv closure
(condition 5) cannot reuse the current single-context `pathTo`, `children`, or
`compatible()` helpers; it needs its own marker-agnostic traversal.

### What T4 validates

T4 stays structural, matching the existing proof checks:

- Closed fields at every level; `reachability` is required, may be empty, and
  holds at most 1,024 records; reasons obey the 32-entry list bound.
- `anchorId` and `memberId` name known resolved changes in one ecosystem and one
  root on that side. The anchor has role `direct` and an instance on `side`; the
  member has role `transitive` and an instance on `side`. Unknown-role and
  declaration-basis changes cannot appear. Proofs already reject declaration
  basis and wrong ecosystem (`src/schema.ts:1467-1476`); the role checks are new
  for verdicts.
- `sourceId` names an immutable lock inventory source whose path is the root's
  `package-lock.json` or `uv.lock`, as proofs already require, and that scopes
  both changes for that side. Several source records may cite one lock file, so
  duplicates key on the pair alone (next rule).
- `unreachable` has a `memberId` and no reasons; every other outcome has the
  reasons its outcome requires; `memberId: null` is valid only for non-proving
  outcomes.
- No duplicate `(side, anchorId, memberId)`, whatever the source record, and no
  anchor/side with both a scope record and a pair record. An `unreachable`
  record is rejected when it conflicts with a positive proof for the same
  anchor, member, and side, or when a proof on that side and the same lock file
  (ignoring which source record cites it, as `src/schema.ts:1455` and the T4
  contract do) passes through the anchor's instance before the member's. A path
  through the anchor proves reachability. This is defense in depth: it does not
  detect a path composed from two separate proofs. A non-proving record beside
  a proof is accepted; the proof wins.
- Overflow rejects the packet; it never trims. The existing 1 MiB packet byte
  ceiling still applies, and it can bind before the count: a record holds three
  IDs of up to 1,024 bytes each, so a worst-case record is above 3 KB, and
  roughly 330 bytes is only a typical figure. The assembler drops optional
  evidence first as described under Bounds.

T4 does not claim the traversal was exhaustive. That remains the authenticated
collector's assertion, stated plainly in the packet spec.

### What T5 may conclude

For a member M with applicable side(s) (head for additions, base for removals,
both for updates), T5 forms a direct group under changed direct anchor A only if
all hold:

1. The ecosystem inventory slot is `complete`, and no change in M's root has
   role `unknown`. The candidate set must be enumerable.
2. A and M are in the same root, neither moves roots, and A has a positive
   `RelationshipProof` on the side matching M's change kind (the existing rule:
   head for updates and additions, base for removals).
3. Every other changed direct candidate C in M's root (any side of C names that
   root) is accounted for:
   - If C has an instance on a side M uses, in M's root on that side, C needs an
     `unreachable` verdict for M on each such side. A removed C needs base; an
     added C needs head; an updated C needs each side M uses. For an update M,
     A's base side is not required.
   - If C has no instance on any side M uses, C blocks grouping: a removed
     candidate blocks a head-only member (addition), and an added candidate
     blocks a base-only member (removal). No verdict can prove such a pair
     unrelated, so this keeps the approved rationale that a direct removal
     might explain a head-side change (`SPEC-decision-units.md`, "Conservative
     proven grouping"). A package rename therefore leaves the added
     transitives standalone.

A positive proof from another candidate on a counted side also fails condition
3, since a proof and an `unreachable` verdict cannot coexist.

Any other case leaves M standalone with a fixed reason and next action. When
several conditions apply, report the first row, checked in this order (it
extends the current order in `src/units.ts`):

| Order | Condition                                                                                               | Standalone reason                                                               |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1     | Actions, or an `unknown` role in the root, or no changed direct candidate                               | existing `actions_occurrence`, `unknown_role`, `no_direct_change`               |
| 2     | Incomplete ecosystem inventory                                                                          | existing `inventory_incomplete`                                                 |
| 3     | Several candidates and no `reachability` record names any candidate of M's root (legacy or opted out)   | `multiple_direct_changes`, unchanged                                            |
| 4     | The anchor candidate or M moves roots                                                                   | existing `multiple_roots`                                                       |
| 5     | Two or more candidates have a positive proof for M                                                      | `ambiguous_anchors` (new), citing each proof key                                |
| 6     | No candidate has a positive proof for M                                                                 | existing `missing_relationship`                                                 |
| 7     | A counted candidate's verdict is missing, `unknown`, `unsupported`, `failed`, or `truncated`, or blocks | `reachability_unproven` (new), citing the non-proving record or the absent pair |

Legacy has one definition, applied per root: more than one candidate in M's
root and no `reachability` record, pair or scope, whose `anchorId` is one of
those candidates. It is checked before proofs, so an empty `reachability`
yields today's output exactly for every root, including roots whose collector
emits no proofs. A collector that emits any record for a root's candidates
leaves legacy and takes responsibility for the rest of that root's pairs.

Group wording is unchanged: grouping records a proven relationship to the one
reachable changed direct dependency. It does not claim causation, safety,
exclusive reachability from unchanged directs, or individual research. Sharing
with unchanged direct dependencies alone never forbids grouping. Each member
keeps its own findings and required evidence, and T5 never emits `group_backed`.
A fully assessed standalone unit can resolve relationship uncertainty unless a
concrete required-evidence question remains unanswered.

A group record cites its proof keys and the canonical keys of every
`unreachable` verdict it relied on, serialized like proof keys: sorted object
keys, unchanged array order, never array position. Non-proving records surface
as attributable informational limits on the standalone units they affected, not
as required-evidence gaps by themselves. They belong in a new unit-level
informational field (name chosen in planning, for example `relationshipLimits`),
not in `unit.sources` or C3's `coverageLimits`. C3 turns any unavailable source
entry into a required gap, and `summarizePolicy` folds `coverageLimits` into
unresolved units (`src/policy.ts:392-396`). Either would contradict the
confirmed T5 semantics that inability to group is not by itself a
required-evidence failure.

Several groups may now exist in one root. Never group direct dependencies
together and never assign one member to several units.

## Cases the Contract Must Cover

| Case                           | Rule                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct addition                | Candidate on head only. Needs a head verdict for each member that uses head; it blocks a base-only member (removal).                                                                                                                    |
| Direct removal                 | Candidate on base only. Needs a base verdict for each member that uses base; it blocks a head-only member (addition). A removal beside an update can group only with a proven `unreachable` base record.                                |
| Declaration-only change        | A package dropped from `package.json` at an unchanged version is a declaration-basis change, not a candidate. It is treated like sharing with an unchanged direct dependency and never forbids grouping.                                |
| Direct update                  | Candidate on both sides. Non-claimed update needs a verdict on each side the member uses.                                                                                                                                               |
| Unknown role                   | Not an anchor or member candidate; any unknown role in the root blocks grouping.                                                                                                                                                        |
| Direct that stops being direct | npm: an update whose base and head roles conflict (for example direct on base, installed only transitively on head) becomes `unknown`, as uv already does, so it blocks the root instead of vanishing from the base-side candidate set. |
| Repeated installed instances   | Verdicts bind to change IDs and exact instances. A verdict for one instance never covers another path or root of the same package name.                                                                                                 |
| npm nested roots               | Candidates are per root; a verdict and its lock source must name the member's root. Root-moving changes count in each root they name and cannot anchor or join a group.                                                                 |
| uv variants                    | Verdicts bind to the exact variant change ID. Variant confusion is invalid. An activation path T4 cannot represent is `unsupported`, never `unreachable`.                                                                               |
| Base/head mismatch             | A verdict with the wrong side, a source from the other revision, or an anchor with no instance on that side is rejected.                                                                                                                |
| Truncation and failure         | Explicit non-proving outcome. Members stay standalone, no change is dropped, and the limit stays attributable.                                                                                                                          |

## Bounds, Compatibility, and Migration

- Cap: 1,024 verdicts per packet, one new T4 limit beside 128 changes, 256
  proofs, and 32-instance paths. With at most 128 changes, one scope-level
  `truncated` record per anchor and side (at most 256) fits the cap, so an
  unfinished anchor can always be reported instead of overflowing. Pair counts
  can pass the cap quickly (19 anchors by 100 members by 2 sides is 3,800), so
  collectors emit pair records only for members with one reachable candidate
  and fall back to scope records for the rest.
- Proofs: at most two per member (the claimed anchor and one more to evidence
  ambiguity), and at most 127 members, so at most 254, within the 256 cap.
  Today N2 and U2 emit proofs only for a root with one changed direct
  dependency; under this draft they emit them for every member with a reachable
  candidate.
- Packet-wide budgets: the 1,024 cap and the 1 MiB ceiling are per packet, but
  N2 and U2 run separately and a packet can mix npm and uv. Each collector
  returns its optional evidence (verdicts and second proofs) tagged as optional.
  The packet assembler, not a collector, owns the drop step: in a fixed order
  (uv before npm, then largest canonical key first) it replaces an anchor/side's
  pair records with one scope `truncated` record, then drops second proofs,
  until the packet fits, and keeps an attributable limit for each. It never
  drops changes, sources, findings, or the claimed anchor's proof. A valid large
  mixed packet is therefore never rejected for optional evidence, and every drop
  degrades toward standalone. Today npm's `packetBounds` returns
  `unavailable`/`budget` for the whole result on overflow; the npm amendment
  must narrow that to non-optional evidence.
- T5 builds one map keyed by side, anchor, and member, so its added work is
  linear in verdicts plus candidates and needs no graph traversal.
- Every missing or dropped record degrades to a standalone unit, never to a
  group. That is the fail-secure property to test.
- Compatibility (decided): amend v1 in place with `reachability` required. T4
  rejects a packet without it under its closed-field rule, so no existing
  packet is silently read as a complete graph. N2/U2 emit `[]` at minimum, which
  means no absence evidence and today's single-anchor T5 behavior. There is no
  adopted packet or old-reviewer dependency to migrate. This changes what
  version 1 means for the collectors, which the user accepted on 2026-11-09.
  Packets built by the current collectors will be rejected once `reachability`
  is required. Because T4 rejects unknown
  and missing fields, the T4 validator, every collector, and every fixture that
  builds a packet must change in one commit, adding `reachability: []` at
  minimum.
- Parity: more groups mean fewer units than the initial conservative T5, closer
  to the baseline's full-lockfile grouping. Record the difference during parity
  review. It never weakens required evidence.

## Amendments to Review Before Expanding Grouping

Each is a matching edit to an approved spec, applied only after this draft is
approved. This draft edits none of them. The user decided on 2026-11-09 that
they land in a docs-only PR after approval. The planned wait for the `issue-15`
and `issue-18` merges is moot: both collectors are on `main`, so the amendment
PR can land first and no spec text disagrees with `main`.

| Spec                                                                     | Amendment                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [T4 packet](SPEC-review-packet.md)                                       | Add `reachability` to the envelope, validation rules, 1,024 cap, and fixtures; state that T4 still does not certify traversal exhaustiveness.                                                                                          |
| [T5 units](SPEC-decision-units.md)                                       | Replace the exactly-one-direct restriction with the grouping rule and precedence above, add the two reasons, the unit citation and limit fields, keep the legacy empty-array path.                                                     |
| [npm inventory](SPEC-npm-inventory.md)                                   | Make an update's conflicting base/head roles `unknown`, matching uv, so a dropped direct dependency stays a base-side candidate blocker.                                                                                               |
| [npm relationships](SPEC-npm-relationships.md)                           | Collector emits verdicts per anchor and side under the traversal conditions above; eligibility items 1 and 4 reference the new rule; `packetBounds` returns optional evidence for the assembler to drop instead of failing the result. |
| [uv relationships](SPEC-uv-relationships.md)                             | Same, with variant-exact IDs, a new marker- and extras-agnostic closure traversal, and `unsupported` for unrepresentable activation paths.                                                                                             |
| [npm evidence](SPEC-npm-evidence.md), [uv evidence](SPEC-uv-evidence.md) | Update the shared/orphaned/ambiguous language so multi-anchor grouping points here, not to a deferred follow-up.                                                                                                                       |
| [Capability map](README.md)                                              | Index this spec; update the #93 references.                                                                                                                                                                                            |

## Commands

For this documentation-only change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

Any later approved implementation runs, on one exact shared revision:

```sh
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Record exact revisions, commands, and outcomes in the relevant issue or PR.
Local contract tests do not certify consumer adoption or cutover. Example
commands in this draft are not executable until the tooling exists.

## Project Structure

```text
docs/specs/SPEC-reachability-evidence.md → this draft contract
src/schema.ts, src/schema.test.ts        → proposed T4 field, validation, fixtures
src/units.ts, src/units.test.ts          → proposed T5 grouping rule and reasons
N2/U2 collector modules                  → proposed verdict emission (see their specs)
```

## Code Style

Follow the repository's strict TypeScript conventions: camelCase, explicit
unions, `.js` import suffixes, single quotes, frozen detached outputs. The
verdict type above is the intended shape; planning may rename fields.

## Testing Strategy

Synthetic, sanitized, bounded fixtures only; no live calls or private consumer
records. Contract fixtures must distinguish:

| Fixture                                                                                                     | Observable result (and the wrong implementation it rejects)                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three candidates (addition, removal, update) with one proof; verdicts complete                              | Groups under the proven anchor; cited verdict keys are asserted exactly. Rejects checking only head for update members, or ignoring the removal.                  |
| Two candidates both with a positive proof for M                                                             | `ambiguous_anchors` citing both proof keys. Rejects picking the first or shortest proof.                                                                          |
| Proven `unreachable` versus an omitted pair beside other records                                            | Group versus `reachability_unproven`. Rejects treating omission as absence. Include a base-side omission and an update member.                                    |
| Sharing with unchanged direct dependencies                                                                  | Still groups, sharing explained, no causation claim. Rejects counting unchanged directs as candidates.                                                            |
| Direct removal R alongside update A, base verdict present or absent                                         | Groups only with the base `unreachable`; absent gives `reachability_unproven`. Rejects ignoring removals.                                                         |
| Removed direct beside an added member; added direct beside a removed member                                 | Standalone `reachability_unproven` (blocked, no verdict possible). Rejects dropping a candidate with no instance on M's side.                                     |
| Base/head mismatch (wrong side, wrong-revision source, anchor without that side)                            | One T4 rejection per sub-case. Rejects checking only that `sourceId` exists.                                                                                      |
| Cross-root verdict                                                                                          | T4 rejects. Separately, a valid sibling-uv-variant verdict is accepted and that member stays standalone. Rejects keying on package name.                          |
| Each non-proving outcome with a wrong reason subset; `memberId: null` with `unreachable`                    | T4 rejects each. A valid non-proving record leaves the member standalone and appears in the unit-level limit field, not `sources`, with no required-evidence gap. |
| `unreachable` beside a proof for the same pair, citing a different source record of the same lock file      | T4 rejects. Rejects comparing source IDs literally.                                                                                                               |
| `unreachable(C, M)` with a proof path A to C to M; second case with C appearing after M                     | First rejected; second accepted. Rejects dropping any proof containing C.                                                                                         |
| Empty `reachability` with 0, 1, and 2 proofs in a multi-anchor root                                         | Deep-equals current T5 output (`multiple_direct_changes`). Rejects reordering the checks.                                                                         |
| Verdict cap at 1,024 and one beyond, including a mixed npm+uv packet                                        | Cap accepted; overflow rejected by T4; the assembler stays under the cap. Rejects per-collector caps.                                                             |
| Near-1 MiB mixed packet with optional evidence                                                              | Assembler drops optional evidence in the stated order, records limits, accepts the packet; no change dropped and no group forms from a partial drop.              |
| Permuted changes, proofs, and verdicts                                                                      | Same membership, unit IDs, and cited keys. Rejects array-position keys.                                                                                           |
| Several groups in one root, plus a member reachable from two candidates                                     | Each member in one unit; the shared member stays standalone; no directs grouped together.                                                                         |
| npm direct dropped on head but still installed; and the reverse                                             | Role `unknown`, root groups nothing until proven. Rejects keeping `transitive`.                                                                                   |
| uv: package reached by A unconditionally and by C only under a marker; extras-only and fork-marker variants | A U2 test on lock bytes: `unreachable(C)` is never emitted. Rejects reusing the single-context `compatible()` traversal.                                          |
| Two source records for one lock file, conflicting                                                           | T4 rejects the duplicate pair. Rejects keying duplicates on `sourceId`.                                                                                           |
| Scope record beside pair records for one anchor and side                                                    | T4 rejects.                                                                                                                                                       |
| Repeated npm instances; root-moving candidate                                                               | Verdicts bind to change IDs and the matching root side only. Rejects name-based matching.                                                                         |

Each new behavior check must be shown to fail on the prior code or a named
mutation (for example, "treat a missing verdict as unreachable"), then pass.
A fresh-context reviewer or the user must confirm each fixture rejects a
plausible wrong implementation. The second Opus review assessed the earlier
fixture list; this strengthened list has not been re-reviewed.

## Boundaries

- **Always:** Bind evidence to exact base/head revisions, side, lock source, and
  change IDs; degrade any missing evidence to standalone; keep every finding and
  evidence requirement on its own member; preserve non-proving reasons.
- **Ask first:** Edit any approved spec above; change a T4 limit or envelope;
  add a dependency, I/O, or graph engine; change publication or provider
  budgets; reinterpret existing packets.
- **Never:** Infer reachability from names, prose, or a bare completeness flag;
  treat omission, truncation, or failure as absence; drop changes to fit a
  budget; emit `group_backed`; claim causation or safety.

## Decisions

Confirmed with the user on 2026-11-09:

1. Evidence is per-pair verdicts (anchor, member, side), not a full edge list or
   a per-root completeness attestation.
2. The packet change amends v1 in place; `reachability` is required, `[]` means
   no absence evidence.
3. Candidate accounting needs a proven verdict on every side a candidate
   exists; a direct removal beside an update can group only with that proof.
4. The cap is 1,024 verdicts; truncation is explicit evidence, not a rejection.
5. For an update member, the claimed anchor's base-side reachability is not
   required; only other candidates need verdicts on each side M uses.
6. T4's ten-entry `EvidenceReason` vocabulary is reused, with a required subset
   per outcome.
7. npm closes the dropped-direct gap through an N1 amendment: conflicting
   base/head roles become `unknown`, as uv already does.
8. The amendments to approved specs land in a docs-only PR after approval.
   (The sequencing after the `issue-15`/`issue-18` merges no longer applies;
   both are on `main`.)
9. An ADR records the in-place v1 amendment policy ("amend v1 in place until a
   consumer adopts it; absence evidence is asserted by the trusted collector").
   It is [ADR 0006](../adr/0006-amend-packet-v1-in-place-for-reachability.md),
   written with the amendment PR.
10. A removed direct candidate keeps blocking head-only members (additions), and
    an added direct candidate keeps blocking base-only members (removals),
    preserving the approved T5 rationale. Rename-style PRs stay standalone.

## Review

Two fresh-context Opus reviews have run. The first (2026-11-09) found four
blocking issues: dropped npm directs, duplicate/scope records, packet byte and
proof budgets, and the uv marker/extras closure. The second found that the
precedence table broke the `[]` promise (K1) and that the cap and byte budgets
are packet-wide across collectors (K2), plus the removed-candidate question
(decision 10), weak fixtures, and smaller edits. This revision applies all of
them. It has not been re-reviewed after the second round.

## Open Questions

None. The packet assembler's drop step belongs in `assembleReviewPacket`
(`src/packet.ts`), the single place that merges collector fragments, per the
plan.

Fresh-context reviews run at the plan's review phase.

## Implemented Interface and Handoff

Implemented on `issue-93` (commits for #267-#273; this refresh is #274). Names
and behavior the spec left to planning:

- **T4** (`src/schema.ts`): `ReviewPacket.reachability: ReachabilityVerdict[]`,
  `PACKET_LIMITS.reachability` (1,024), and the structural rules above.
- **T5** (`src/units.ts`): `DecisionUnit.verdictKeys` and
  `DecisionUnit.relationshipLimits`; reasons `ambiguous_anchors` and
  `reachability_unproven`. Legacy is decided per root: more than one candidate
  and no record whose `anchorId` is one of them.
- **Collectors**: `src/evidence/npm-reach.ts` and `uv-reach.ts` build the
  closures (npm classifies every skipped edge; uv ignores markers and extras and
  follows every optional-dependency edge). Results carry `reachability` and
  `optionalRelationships`. N1 reports conflicting base/head roles as `unknown`
  with a `conflict` gap.
- **Assembler** (`src/packet.ts`, `src/optional-evidence.ts`): packet-wide
  drops, in the order the spec states, reported as `droppedOptional`. A
  collector fragment may omit the optional fields; the packet field is always
  present.
- **Retained bytes** (`src/evidence/optional-retained.ts`, shared by N2 and U2):
  pair groups degrade to scope records, then second proofs and scope records go,
  before a required-content overflow can fail a collector.
- **uv budget cut**: after work is exhausted the existing relationship-summary
  budget marker stops further members, so a truncated scope record appears only
  for a closure cut before that point; later members get no proofs and stay
  standalone.
- **Pinned batch identities** in `src/analysis/contract.test.ts` changed because
  the analysis batch identity hashes the packet and units; request bytes and
  request hashes are unchanged, so the provider payload is unaffected.

Verification and remaining gates are recorded in
[#274](https://github.com/andrewpucci/dependency-update-advisor/issues/274):
fresh-context review of the new checks, publication, adoption, parity, and
cutover stay separate.

## Approval

Approved for planning on 2026-11-10: the user invoked `as-plan` on this
reviewed draft, after two fresh-context Opus reviews, and said further
fresh-context reviews run at the plan's review phase. This approves planning
only. The user approved the plan on 2026-11-10 (tasks #266-#274, sub-issues of
#93, one closing PR). Execution needs its own approval (`as-build`), and the
amendments to approved specs still need their own review. This work does not
block T5, N2, or U2 delivery.
