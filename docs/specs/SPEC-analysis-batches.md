# Spec: Bounded Decision-Unit Analysis

Status: approved for execution, 2026-11-07. Module: `analysis-providers` in the
[capability map](README.md). Scope: [M2 #22](https://github.com/andrewpucci/dependency-update-advisor/issues/22).
The user's invocation of `as-plan` on the reviewed draft approves it for
planning under the repository instructions. The user approved the plan and
`as-build auto` execution on 2026-11-07.

Limit citation amendment (L10,
[#382](https://github.com/andrewpucci/dependency-update-advisor/issues/382)):
the user approved this spec's change on 2026-11-26. It cites register
entries as `limit:<id>` instead of stating their values, with no value
change.

Review revision accepted by the user, 2026-11-07: a multi-unit `budget`
preparation failure may be re-prepared as smaller batches without a model
call. The reviewed revisions are included in the planning approval above.

Review revision accepted by the user, 2026-11-07: units left
undispatched because the request budget ran out carry the M2 category
`call_budget`, not M1's `budget`. M1's `budget` keeps its meaning of a unit or
request too large to prepare, so diagnostics can tell the two apart.

Amendment, 2026-11-11: the user approved splitting M1's `http` category into
`http-auth`, `http-rate-limit`, `http-server`, and `http-other`, in
[Amendment 4][a4-309] of the W2 spec (#309). M2 settles each exactly as it
settled `http`: `unavailable`, attempted.

Review revision accepted by the user, 2026-11-07: a result not
bound to its prepared batch stays `rejected` with `reference`, and its
attempted flag follows the result as reported, `validated` counting as
attempted. Records and calls dispatched then agree.

## Objective and assumptions

Give maintainers a complete, trustworthy accounting of model analysis for a
reviewed dependency PR, even when some calls fail. Schedule bounded batches of
T5 decision units through M1, retain independently validated assessments, and
hand the complete state inventory to T5 and C3. The approved
[provider contract](SPEC-analysis-providers.md),
[M1 handoff](SPEC-mistral-transport.md#implemented-interface-and-handoff),
[T5 contract](SPEC-decision-units.md), and
[C3 policy contract](SPEC-advisory-policy.md) remain authoritative.

Assumptions for review: this scope uses the existing Mistral adapter and
validated inventory, does not publish comments or statuses, and selects
numeric scheduling budgets during planning. M1 and T5 are dependencies;
their presence does not prove workflow integration or production parity.

## Contract

1. Accept the trusted T4-backed T5 inventory, the same trusted config and
   epoch-millisecond `evaluatedAt` used for policy, and a bounded caller
   deadline and cancellation signal. The deadline uses M1's monotonic
   `deadlineMs`/`now()` clock; never interchange it with `evaluatedAt`.
   Reject invalid or inconsistent inputs before dispatch. Keep a detached
   snapshot so caller mutation or a late result cannot change attribution.
2. Process units in stable inventory order in nonempty batches no larger than
   M1 permits. A grouped unit is indivisible. Bound total calls, concurrent
   calls, and elapsed analysis time; reserve the caller's publication time.
   Budget values and a deterministic scheduling/packing policy are planning
   choices, not unreviewed defaults in this draft. No call starts after its
   deadline, cancellation, or exhausted request budget. Given the same
   inventory, limits, and per-batch outcomes, the dispatched batches and
   final states do not depend on completion order or timing, except where
   the deadline or cancellation stops work.
3. Preparation is local and consumes no request budget. M1 reports both an
   oversized unit and an oversized multi-unit request as `invalid` with
   category `budget`. After that result for a multi-unit batch, re-prepare
   its units as smaller nonempty batches; this is packing, not a model retry
   or truncation split. A unit that cannot be prepared alone is unavailable
   without a call. Other preparation categories (`input`, `configuration`,
   `projection`) mean the trusted inputs are inconsistent, not that a batch
   is too large. Reject the run under item 1: dispatch nothing further,
   retain accepted successes, and mark remaining units `unavailable`. Count
   preparation work against the elapsed-time budget.
4. Accept a success only when M1 validated it against the exact prepared batch
   and it accounts for exactly its units. Reject stale, duplicate, unknown,
   cross-batch, or mismatched results; never attach an assessment to another
   head, unit, or group. Preserve valid independent successes regardless of
   completion order or failure elsewhere.
5. Only M1's recognized `truncated` completion for a multi-unit batch permits
   splitting into smaller nonempty batches. Recursively split within the same
   cumulative limits. A truncated single unit is unavailable. No other
   dispatched failure causes a retry or split. That includes HTTP failures
   such as HTTP 400; envelope failures, including M1's ordinary
   `model_length` result; malformed replies; validation failures; and
   timeouts. Preparation failures do not become truncation. No final
   aggregation model call occurs.
6. Account for every inventory unit exactly once in stable order: validated
   `assessed`, or an explicit `unavailable`, `rejected`, or `unattempted`
   state with a bounded actionable reason, using the
   [state mapping](#state-mapping) below. Distinguish a failed dispatched
   call from work never dispatched, including split children left unattempted
   after budget exhaustion. Never represent an intermediate truncated parent
   as a second final unit result.
7. C3's `AssessmentState` carries only the state, verdict, reason, next
   action, and coverage limits. Return a per-unit M2 record beside it that
   retains the attempted flag, fixed failure category, local batch identity,
   and, for an assessed unit, M1's validated assessment content. Do not add
   these fields to C3 or T5 types.
8. A deadline or cancellation stops new work and settles the run within its
   effective budget; cancel in-flight work where possible and ignore late
   completions. Preserve successes accepted before the cutoff. A transport
   that ignores cancellation still cannot extend the scheduler's result
   beyond that effective budget. Concurrent scheduling must respect the
   limit at all times.
9. Pass only validated states for the complete, original inventory to T5's
   coverage handoff and its C3 guard, with the same config and evaluation
   time. Do not duplicate policy precedence. Verified effective blockers survive
   missing analysis; otherwise unresolved units yield `decision_incomplete`.
   Packet-wide gaps and empty inventory retain T5's special outcomes.
10. Classify a run as `analysis_unavailable` only when the inventory has at
    least one unit and none is `assessed`, including when every unit is
    `rejected`. It is an additional label: it never replaces T5's outcome,
    hides a verified blocker, or removes findings or unresolved units. A proven
    empty inventory makes no call and is never `analysis_unavailable`.
    Advisory verdict and execution status remain separate; W2 owns
    publication and status.
11. Preserve deterministic findings, evidence gaps, group attribution, and
    validated assessment content. Diagnostics contain only bounded allowlisted
    fields and fixed categories consistent with M1: provider, selected model,
    reviewed head, unit/member counts, calls dispatched, truncation splits,
    maximum split depth (`maxSplitDepth`), per-call durations
    (`callDurationsMs`), per-state unit counts, and failure categories. Never
    expose credentials, source excerpts, raw model responses, arbitrary error
    text, or payloads.

### State mapping

This adopts M1's approved
[handoff table](SPEC-mistral-transport.md#implemented-interface-and-handoff)
and settles the categories it does not name. Each unresolved state carries a
fixed reason, next action, and coverage limits.

| M1 result or condition                                                                                                                                    | M2 state                           | Attempted   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------- |
| `validated`                                                                                                                                               | `assessed` with normalized verdict | yes         |
| `failed`: `envelope`, `json`, `schema`, `reference`, or `policy`                                                                                          | `rejected`                         | yes         |
| `failed`: `transport`, `http-auth`, `http-rate-limit`, `http-server`, `http-other`, `media-type`, `response-size`, `encoding`, `deadline`, or `cancelled` | `unavailable`                      | yes         |
| `truncated` for a multi-unit batch                                                                                                                        | split under item 5                 | yes         |
| `truncated` for a single unit                                                                                                                             | `unavailable`                      | yes         |
| `invalid` preparation of a single unit, or pre-call `unavailable` with `configuration`                                                                    | `unavailable`                      | no          |
| Pre-call `unavailable` with `cancelled` or `deadline`, or not dispatched after request-budget exhaustion                                                  | `unattempted`                      | no          |
| Result not bound to its prepared batch                                                                                                                    | `rejected` with `reference`        | as reported |
| Any other category                                                                                                                                        | `unavailable`                      | as reported |

A `budget` preparation failure for a multi-unit batch is re-packed under
item 3 and has no final state of its own. A unit not dispatched after
request-budget exhaustion carries category `call_budget`; this is the only
category M2 adds to M1's set.

## Structure and style

Use Node.js 24 ESM and strict TypeScript. `src/analysis/batches.ts` owns
scheduling and result accounting; focused tests live beside it, with synthetic
integration fixtures under `tests/` where appropriate. M1 owns projection,
transport, and response validation; T5/C3 own coverage and policy. Use
discriminated outcomes and injected clock/transport for deterministic tests.
For example, a recognized truncation is handled explicitly:

```ts
if (result.kind === 'truncated' && units.length > 1) {
  enqueueSplit(units);
}
```

The example expresses the condition, not an approved exported interface or
queue policy. Exact signatures and any additional dependencies require review
in the plan.

## Testing and acceptance

Use the existing test runner, synthetic packets, fake clocks, and controlled
transport; no secret, paid call, or external write is required. Behavior changes
must leave checks that would catch their defect. Test the real M1/T5/C3 handoff
as well as scheduler isolation. At minimum verify:

- Stable complete accounting for mixed standalone and grouped units, including
  successes that complete before or after another batch fails.
- Exact call and concurrency limits, deadline and cancellation boundaries,
  request-budget exhaustion during recursive splits, and no late-result use.
- Recursive length splits, single-unit truncation, and unscheduled children;
  malformed, HTTP, `model_length` envelope, timeout, and schema failures never
  split or retry.
- A multi-unit `budget` preparation failure re-packs into smaller batches
  without a call or request-budget use; a unit that cannot be prepared alone
  is `unavailable` with attempted false; other preparation categories
  do not re-pack.
- Every row of the state mapping, including pre- and post-dispatch
  cancellation and deadline, yields its listed state and attempted flag, and
  the M2 record retains category, batch identity, and assessment content.
- Reordered completion timing with the same per-batch outcomes yields the
  same dispatched batches and final states, including under budget
  exhaustion; the deadline and `evaluatedAt` clocks are never interchanged.
- Units left after request-budget exhaustion report `call_budget`, and an
  oversized single unit reports `budget`; the categories never collide.
- Duplicate, omitted, unknown, wrong-head, wrong-group, and cross-batch
  assessments cannot become accepted states; mutation cannot change binding.
- A verified blocker alongside failed or unattempted units stays visible;
  a relaxed hold with unresolved work remains incomplete. Packet-wide gaps and
  complete versus incomplete empty inventories use T5's outcomes.
- `analysis_unavailable` applies to a nonempty inventory with no assessed
  unit, including all-`rejected` results, alongside an unchanged T5 outcome
  and any verified blocker; a proven empty inventory makes no call and does
  not receive it.
- Missing credentials and all-unavailable results retain findings and do not
  imply execution success. Diagnostics and returned failures do not leak
  synthetic secret, source, provider-body, or error sentinels.

Run the following on the exact implementation revision and record revision,
results, warnings, and unrun gates in the issue or PR:

```sh
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run complexity -- --base origin/main
```

The complexity report is advisory and measures committed source at `HEAD`.
For this documentation draft run `npm run lint:md`, `npm run format:check`,
and `git diff --check`. A mocked integration does not establish live provider
compatibility, workflow publication, packaging, adoption, parity, or cutover.

## Timing and Split-Depth Diagnostics Amendment

**Status: implemented and merged. The user approved planning on 2026-11-15
(by invoking `as-plan` on this reviewed draft, after a fresh-context Opus
review); `callDurationsMs`
([#331](https://github.com/andrewpucci/dependency-update-advisor/issues/331))
and `maxSplitDepth`
([#332](https://github.com/andrewpucci/dependency-update-advisor/issues/332))
are implemented and merged in PR #336. The companion
[W2 Amendment 5](SPEC-review-orchestration.md#diagnostic-amendment-5-assessment-failure-reason-and-analysis-timing)
([#334](https://github.com/andrewpucci/dependency-update-advisor/issues/334))
is implemented and merged in PR #345, which prints the values on the
no-write rehearsal line and trace.** Effort tier: L (adds fields to M2's
exported diagnostics and amends item 11's closed allowlist). Scoped to a new
issue under
[#309](https://github.com/andrewpucci/dependency-update-advisor/issues/309),
not to #329. The
[R1 rehearsal evidence amendment](SPEC-adoption-self.md#rehearsal-evidence-amendment)
records its first rehearsal without these fields.

### Why

The reasoning-model change raised each call to a
`limit:analysis.requestTimeoutMs` timeout and `limit:analysis.completionTokens`
completion tokens against this spec's unchanged `limit:analysis.maxAnalysisMs`
analysis maximum.
Diagnostics report `callsDispatched` and `truncationSplits` as counts only, and
nothing prints them, so a maintainer cannot tell how close calls run to the
timeout or whether a batch keeps truncating. Job-log step timing spans the whole
action and cannot supply either value.

### Diagnostics contract

1. Diagnostics add `callDurationsMs`: one integer per call counted in
   `callsDispatched`, in wave order (the order batches enter a wave, which is
   queue order and independent of completion order). Its length always equals
   `callsDispatched`, so it is bounded by the `limit:analysis.maxCalls` call
   cap.
2. A duration is measured inside the scheduler's per-call wrapper, from just
   before M1 is invoked to the call's settlement, on the injected monotonic
   deadline clock (never `evaluatedAt`), as a non-negative integer (fractions
   truncated). M1 records no time itself.
   - A call that ends as `cancelled`, `deadline`, or `transport` records the
     elapsed time at that cutoff.
   - A late result that is ignored records the actual time it settled.
   - A call cancelled before M1 is invoked still counts as dispatched, as
     `callsDispatched` already does, and records 0. That branch is
     defensive: the scheduler checks cancellation immediately before starting
     a call, so no public input reaches it, and it has no behavior check.
   - A result with `attempted: false` is not counted in `callsDispatched` and
     has no entry.
3. Diagnostics add `maxSplitDepth`: the greatest split depth reached by any
   truncation split, a non-negative integer. A first-level batch has depth 0;
   a truncation split of a batch at depth _d_ yields two children at depth
   _d_ + 1 and records depth _d_ + 1. A preparation-budget re-pack yields
   children at its parent's depth and does not change `maxSplitDepth`. The
   midpoint split and the `limit:analysis.maxUnits` batch limit bound it at
   the base-2 logarithm of that limit, rounded up. A value of 2 or more means
   a half-batch was truncated and split again.
   `truncationSplits` keeps its meaning.
4. Both fields are integers only: no payloads, reasoning text, provider
   bodies, or error text. They change no scheduling, retry, split, state
   mapping, or outcome. Item 11's field list includes both names; existing
   fields and order are unchanged.

### Checks

Each is written first and shown failing on the prior code or a named mutation:

- With a fake monotonic clock and controlled transport, `callDurationsMs`
  equals the scripted per-call durations in wave order, with reordered
  completion unchanged. A case mixes `attempted: false` results with attempted
  ones: length equals `callsDispatched`, so the array has no entry for the
  unattempted calls. Mutations: wall-clock instead of monotonic time; one entry
  per scheduled call instead of per dispatched call; completion order; omitting
  the cutoff entry.
- Exact split depths: an 8-unit batch that truncates, then both 4-unit halves
  truncate, gives `truncationSplits` 3 and `maxSplitDepth` exactly 2; one batch
  split once gives 1; no split gives 0. A 24-unit run where two first-level
  batches truncate in different waves gives `maxSplitDepth` 1. Mutations:
  counting total splits instead of depth; counting waves that contained a
  split; incrementing depth on a budget re-pack.
- Existing record, coverage, and diagnostics assertions pass unchanged, and a
  sentinel case shows only integers are added.

Commands: those in [Testing and acceptance](#testing-and-acceptance) above,
on the exact implementation revision.

### Amendment Boundaries

- **Always:** keep the new fields integer-only and derived from the injected
  clocks and scheduler state; leave scheduling untouched.
- **Ask first:** add any other diagnostic field, include text, or change a
  limit.
- **Never:** record payload, reasoning, or error text, or let a diagnostic
  change an outcome.

### Companion W2 amendment

Reporting a number was Ask-first under
[W2 Amendment 4](SPEC-review-orchestration.md#amendment-4-boundaries). A
separate, L-tier W2 amendment,
[Amendment 5](SPEC-review-orchestration.md#diagnostic-amendment-5-assessment-failure-reason-and-analysis-timing)
(implemented and merged in PR #345), passes them to the fixed stderr line and
trace as bounded integers.

## Boundaries and open planning choices

- **Always:** honor approved M1/T5/C3 limits and provenance; bound work;
  retain independent successes and unresolved work; use the existing guard.
- **Ask first:** change approved contracts, workflow deadlines or model
  budgets; add a provider, dependency, or data category; loosen validation.
- **Never:** retry ordinary failures, split a decision unit, infer successful
  review from incomplete analysis, publish raw model data, or retire the old
  reviewer before its separate cutover gates pass.

Planning must propose and obtain approval for initial request-count,
concurrency, and time budgets, publication reserve, the deterministic
scheduling, packing, re-preparation, and split order, and the exported
interface and M2 record field names. W2 decides whether a missing credential
fails execution when the inventory is proven empty. These are not evidence
of measured provider performance. No product scope change or numeric
threshold is approved by this draft.

## Execution selections and handoff

The user approved the M2 plan and `as-build auto` on 2026-11-07. Initial
ceilings are `limit:analysis.maxCalls` reserved calls,
`limit:analysis.maxConcurrentCalls` concurrent calls,
`limit:analysis.maxAnalysisMs` analysis, and a
`limit:analysis.publicationReserveMs` publication reserve. A supplied workflow
deadline clips the analysis deadline. These are operational limits, not measured
provider performance; W2 must reconcile them with its own deadline and wiring.

Amended (L11; approved by the maintainer on 2026-11-28,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)):
`limit:analysis.maxAnalysisMs` is no longer a ceiling. The analysis deadline is
the supplied deadline less the publication reserve, and
`limit:analysis.maxAnalysisMs`, a copy of `limit:job.maxAnalysisTimeMs`, is the
least analysis time a run gets.

`analyzeDecisionUnits` accepts the inventory, trusted config, evaluation time,
credential and monotonic deadline. It returns ordered records, T5 coverage,
a separate analysis-unavailable flag, and bounded diagnostics. Each record
retains its C3 state and any validated M1 assessment. Work runs in deterministic
waves; local preparation-budget failures and response-length truncations use
ordered midpoint subdivision. Cancellation and deadlines preserve accepted
independent results and leave other work explicit. M1 validates each response;
T5 and C3 retain the authoritative outcome. The injected adapter is a trusted
test seam, not an interface for binding arbitrary provider replies.

M2 does not establish live provider behavior, current-head publication,
workflow credential wiring, packaging, adoption, parity, or cutover. The old
reviewer remains active until those separate gates pass.

[a4-309]: SPEC-review-orchestration.md#diagnostic-amendment-4-fixed-model-unavailable-reason
