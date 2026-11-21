# Plan: Limit register

Status: approved for execution by the user on 2026-11-17. Implements
[the limit register spec](../docs/specs/SPEC-limit-register.md), which the
user approved for planning on 2026-11-17. Parent issue: #372; task issues
#373–#386, in plan order.

## Preconditions

- The evidence-coverage work B4–B8 is committed (signed). Phase 1 moves
  limits those patches add or change.
- Evidence-coverage B11 (scaled shares) starts after L2, so its base, rate,
  and ceiling parameters are born as register entries.

## Execution model

The coordinator writes each task card and reviews, mutates, and runs the full
check set; implementers edit only the files their card lists. Every value
change, deletion, new configurable limit, spec amendment, live probe, and
paid call is Ask-first, as the spec's boundaries say.

## Phase 1: register and enforcement, values unchanged

### L1. Register module and entry type (#373)

Create `src/limits.ts` with the entry type from spec section 1 (`id`,
`value`, `unit`, `protects`, `basis`, `effect`, `test`, `configurable`) and a
lookup by id. Move `PACKET_LIMITS` into it; `PACKET_LIMITS` stays exported as
a view. **Acceptance:** the full check set passes unchanged; a test fails
when an entry names a basis kind outside the five, or a `derived` formula
names an unknown id. **Scope:** M.

### L2. Research and budget limits (#374)

Move `EVIDENCE_READ_ENVELOPE`, `EVIDENCE_READ_ALLOCATION`,
`W2_EVIDENCE_LIMITS`, `RESEARCH_CACHE_LIMITS`, research.ts's local limits,
and `SIGNAL_ATTEMPTS_PER_MEMBER` (as a `structural` derived entry). Repeated
values become `derived`. **Acceptance:** values unchanged; existing budget
tests pass unchanged. **Scope:** M.

### L3. Collection, config, rendering, analysis, and transport limits (#375)

Move the remaining `src/` limits. Remove second copies: the comment body cap
(three literals), the identity bounds, and config's source-root and
excerpt-file counts. **Acceptance:** the boundary tests named in the spec's
verification pass unchanged. **Scope:** L (crosses modules).

### L4. Scripts and workflow timeouts (#376)

Move `scripts/` thresholds and record each workflow's `timeout-minutes` as an
entry. **Scope:** M.

### L5. Code enforcement in `vp lint` (#377)

Enable oxlint's `no-magic-numbers` for non-test `src/` and `scripts/`, off in
`src/limits.ts`. Add the custom rule for a numeric literal that initializes a
named constant or field outside the register, as a repository oxlint plugin
following `scripts/complexity/plugin.mjs`. First confirm the rule's options
(the spec's trial saw the 0/1/−1 ignore list not apply). Allowlist entries
carry a reason. **Acceptance:** both of the spec's planted mutations fail
`vp lint`; the migrated tree passes. **Scope:** L (verification tooling).

### L6. `npm run check:limits` (#378)

Checks for workflow timeouts, spec text, `limit:<id>` citations, named
tests, and (after phase 2) `unjustified` entries. Before choosing how to
scope the spec-text match, measure how many spec lines each register value
matches; record the count on the task issue. The pending-amendment allowlist
starts with today's spec values. Wire it into CI. **Acceptance:** each
mutation in the spec's verification list fails the command. **Scope:** L.

### Checkpoint L1

- Full check set passes; no outcome changed.
- Fresh-context review of the enforcement checks: each rejects a plausible
  wrong implementation.

## Phase 2: bases decided

### L7. What each limit protects (#379)

Fill `protects` and `basis` for every entry from the local audit. List the
limits that name no harm or outside constraint as deletion proposals for the
user. **Ask-first:** each deletion. **Scope:** M per batch.

### L8. Measurement (#380)

Run `npm run measure:demand` over this repository's Dependabot PRs and
propose `measured` values with headroom. This is evidence-coverage B12
widened to every measurable limit; its approval gate stays. **Ask-first.**

### L9. External citations and the comment-limit probe (#381)

Cite platform limits with dates. The comment probe posts comments in a test
repository the user chooses. **Ask-first.**

### L10. Spec amendments (#382)

Amend each approved spec listed in spec section 2 to cite `limit:<id>`
instead of values, one approval per spec. Remove each from the
pending-amendment allowlist as it lands. **Ask-first.**

### L11. Close migration (#383)

Turn on the `unjustified` failure. **Acceptance:** no `unjustified` entry and
an empty pending-amendment allowlist.

## Phase 3: adopter configuration

### L12. Config contract and parser (#384)

Amend the review-config and config-parser specs (Ask-first), then add the
approved limits to the schema and parser with spec section 5's precedence
rules. **Acceptance:** the spec's three configurable-limit tests per limit.
**Scope:** L.

### L13. Job budget workflow input (#385)

A reusable-workflow input for the job budget, from which the pipeline derives
its job window. A separate decision, per the spec. **Ask-first.**

### L14. `docs/budget-guide.md` (#386)

How to set each configurable limit and why, linking to the schema and the
register for values. **Scope:** S.

## Risks

| Risk                                                         | Mitigation                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `no-magic-numbers` reports hundreds of non-limits            | L5 sizes the allowlist first and confirms the rule's options |
| Spec-text matching flags small numbers used for other things | L6 measures matches before choosing the scope                |
| Moving limits changes behavior                               | Phase 1 changes no value; existing boundary tests must pass  |
| B11 lands before the register and adds new literals          | B11 waits for L2                                             |

## Open questions

None for planning.
