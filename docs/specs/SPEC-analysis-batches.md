# Spec: Bounded Decision-Unit Analysis

Status: approved for execution, 2026-11-07. Module: `analysis-providers` in the
[capability map](README.md). Scope: [M2 #22](https://github.com/andrewpucci/dependency-update-advisor/issues/22).
The user's invocation of `as-plan` on the reviewed draft approves it for
planning under the repository instructions. The user approved the plan and
`as-build auto` execution on 2026-11-07.

Review revision accepted by the user, 2026-11-07: a multi-unit `budget`
preparation failure may be re-prepared as smaller batches without a model
call. The reviewed revisions are included in the planning approval above.

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
    per-state unit counts, and failure categories. Never expose credentials,
    source excerpts, raw model responses, arbitrary error text, or payloads.

### State mapping

This adopts M1's approved
[handoff table](SPEC-mistral-transport.md#implemented-interface-and-handoff)
and settles the categories it does not name. Each unresolved state carries a
fixed reason, next action, and coverage limits.

| M1 result or condition                                                                                   | M2 state                           | Attempted   |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------- |
| `validated`                                                                                              | `assessed` with normalized verdict | yes         |
| `failed`: `envelope`, `json`, `schema`, `reference`, or `policy`                                         | `rejected`                         | yes         |
| `failed`: `transport`, `http`, `media-type`, `response-size`, `encoding`, `deadline`, or `cancelled`     | `unavailable`                      | yes         |
| `truncated` for a multi-unit batch                                                                       | split under item 5                 | yes         |
| `truncated` for a single unit                                                                            | `unavailable`                      | yes         |
| `invalid` preparation of a single unit, or pre-call `unavailable` with `configuration`                   | `unavailable`                      | no          |
| Pre-call `unavailable` with `cancelled` or `deadline`, or not dispatched after request-budget exhaustion | `unattempted`                      | no          |
| Any other category                                                                                       | `unavailable`                      | as reported |

A `budget` preparation failure for a multi-unit batch is re-packed under
item 3 and has no final state of its own.

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
