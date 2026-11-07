# Spec: M1 Mistral Transport and Single-Batch Validation

Status: approved for execution, 2026-11-07. Supporting contract for
`analysis-providers` in [the capability map](README.md), scoped to
[M1 #21](https://github.com/andrewpucci/dependency-update-advisor/issues/21).
The approved [analysis-provider contract](SPEC-analysis-providers.md) remains
authoritative. The spike retains its credential and finish-classification gates.

Confirmed scope decision, 2026-11-07: the user agreed that M1 owns
provider-neutral request projection and full response validation for one
batch, as well as Mistral transport. [M2 #22](https://github.com/andrewpucci/dependency-update-advisor/issues/22)
owns scheduling, truncation splits, and aggregation. This confirms the scope
boundary, not approval of the full specification, plan, or execution.

Review revisions accepted by the user, 2026-11-07: batch-local aliases with
local batch binding, internal C3 evaluation, the `do_not_merge` blocker rule,
`temperature: 0`, the rejected-fence parity difference, `not_relevant` context
status, the response-byte rule, and a planning spike for `model_length`.
Those revisions preceded full-spec approval.

Specification approval, 2026-11-07: after editing and reviewing this document,
the user explicitly approved it and invoked `as-plan`. This approves the
revised specification for planning, including the ordered `model_length`
spike. It does not authorize implementation, credential access, or paid calls;
the spike retains its explicit approval condition below.

Plan and execution approval, 2026-11-07: the user invoked `as-build auto`
after reviewing the proposed plan. This approves its nine tasks, initial
resource/interface selections, automatic checkpoints, and per-task commits.
M1.2–M1.4 may proceed while M1.1 awaits the separately required paid-call,
model, and credential-source decisions. Transport remains blocked on M1.1.
Publication and merge are not authorized by this execution approval.

Working handoff: `tasks/plan.md` indexes M1.1–M1.9 as
[#210–#218 under #21](https://github.com/andrewpucci/dependency-update-advisor/issues/21),
in plan order on the implementation project. Issues record current status.
M1.1 is a hard prerequisite of transport; preparation/validation is independent.

Paid-spike approval, 2026-11-07: the user approved at most four synthetic
requests, each capped at 4 MiB, 4,096 completion tokens, and 120 seconds,
within eight minutes total. The user selected `mistral-medium-latest` and
authorized the execution environment's `MISTRAL_API_KEY` source. No credential
value is recorded here. Credential availability and live evidence remain gates;
this does not authorize another model/source or expanding the probe envelope.

## Implemented Independent Analysis Handoff

M1.2–M1.4 supply the preparation and validation path in `src/analysis/`.
`prepareAnalysisBatch` returns a frozen owned handle whose `request` is the
exact bounded chat request and whose `unitIds` retain original T5 identities.
`preparedSnapshot` is an internal inspection boundary for trusted adapters
and fixtures; copied handles cannot resolve through its private ownership map.

`receiveAnalysisReply(batch, receive)` captures ownership around a trusted
adapter's response callback and detaches its returned JSON. The opaque reply
can be used only with that same handle in `validateAnalysisReply`. No raw body
or alias map can be supplied to rebind a reply. The validator restores original
references, normalizes order, preserves per-member context uncertainty and
truncation, and exposes no partial assessment on failure. C3/T5 still own the
authoritative PR decision and independently retain deterministic findings.

The alias/projection and validation details live in `projection.ts` and
`validation.ts`; neither depends on Mistral SDK types. Input-copy work is
bounded separately to 64 levels, 1,048,576 entries, and 8 MiB of string values
for the accepted packet plus T5 expansion. Reply-copy entries/string bytes
are bounded by the selected response ceiling. These are work/retention limits,
not expanded T4/C2 wire allowances or measured performance thresholds.

No Mistral transport, deadline lifecycle, live provider compatibility, M2
scheduling/splits, publication, adoption, or cutover is certified by this path.

## Objective and Scope

Give reviewer contributors one bounded call that returns either validated
assessments for every requested decision unit or a classified failure with
no usable model assessment. Maintainers must never receive a recommendation
based on an unvalidated response, missing credential, or silently omitted unit.

M1 supplies the provider-neutral single-batch contract, projection, reference
validation, and fixed-endpoint Mistral adapter. M2 uses these results to
preserve independent successes, account for every unit, and call the existing
T5/C3 decision guard. M1 does not partition or schedule work, retry requests,
aggregate a PR verdict, collect evidence, read repository files, render
comments, publish status, or implement a workflow. The old reviewer remains
active until adoption, parity, and cutover gates pass.

## Inputs and Existing Contracts

- [C1](SPEC-config-parser.md) selects `mistral` and a model explicitly from
  trusted configuration. Its model syntax is 1–128 ASCII characters matching
  `[A-Za-z0-9][A-Za-z0-9._-]*`; this is not a model-availability guarantee.
  There is no default provider, model, endpoint override, or credential field.
- [T4](SPEC-review-packet.md) supplies a validated immutable packet;
  [T5](SPEC-decision-units.md) supplies its stable ordered `UnitInventory`.
  Use existing unit IDs, including their repository/base/head identity and
  member composition. Never regroup units or substitute package-name keys.
- [C3](SPEC-advisory-policy.md) supplies `evaluateUnitPolicy`, which M1 calls
  itself with the same inventory, trusted config, and the caller's fixed
  evaluation time. Its findings, rule traces, coverage gaps, optional unchecked
  signals, exemptions, default ceiling, and effective ceiling remain authoritative.
- [C2](SPEC-source-context.md) and T4 supply trusted-context provenance and
  already eligible source facts. M1 must preserve disabled/unavailable/partial
  states and may not recover rejected lines from raw files or auxiliary data.
- Trusted orchestration supplies the named `llm_api_key` secret separately,
  explicit resource limits, cancellation, and an analysis deadline that reserves
  time for publication. A packet or provider response cannot authorize I/O,
  excerpt disclosure, a longer deadline, or a GitHub write.

This is one supporting capability within the approved module map. No new
module or dependency direction is proposed. The public
[baseline analysis contract](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/SPEC-analysis-contract.md)
and [transport](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/analysis.mjs)
provide fidelity evidence. Their package-keyed results are adapted to T5
units; their fallback must not replace the shared C3/T5 decision guard.

## Tech Stack and Project Structure

Use the existing Node.js `>=24.11.0 <25`, ESM, strict TypeScript, Node built-ins,
and source-adjacent tests importing from `vite-plus/test`. Native `fetch`
is sufficient; no SDK, runtime validator dependency, or new provider is needed.
Keep external JSON typed as `unknown` until validated.

```text
src/analysis/contract.ts         → provider-neutral projection and assessment validation
src/analysis/contract.test.ts    → identity, references, policy, disclosure, and bounds
src/analysis/mistral.ts          → one fixed-endpoint request and envelope validation
src/analysis/mistral.test.ts     → synthetic HTTP, stream, deadline, and credential tests
src/analysis/*.integration.test.ts → actual C1/C2/T4/T5/C3 handoff with mocked Mistral
docs/specs/SPEC-mistral-transport.md → this M1 supporting contract
```

Paths for new files are proposed. Keep projection and common validation usable
without Mistral types. Reuse `src/config.ts`, `src/context.ts`, `src/schema.ts`,
`src/units.ts`, and `src/policy.ts`; do not introduce competing finding or
policy vocabularies. M2's future `batches.ts` is outside M1.

## Single-Batch Input and Projection

1. Accept an authentic T4/T5 inventory, trusted successful C1 config, the
   evaluation time in epoch milliseconds, and a nonempty ordered subset of
   distinct unit IDs. Reject unknown, duplicate, or reordered units before
   I/O. Compute policy internally with
   `evaluateUnitPolicy(inventory, config, evaluatedAt)`; a failed evaluation
   prevents a call. Do not accept a caller-supplied policy evaluation,
   projection, or ceilings as validated authority. `PolicyEvaluation` records
   neither its time nor its inventory, so a supplied one cannot be checked
   for staleness. Exported types alone do not establish provenance.
2. An empty inventory or empty requested batch makes no provider call. M2/T5
   distinguish a proven empty inventory from missing inventory; M1 does not
   invent a successful empty assessment. Failed config or context preparation
   also prevents a call, following the existing workflow stop conditions.
3. Project only the requested units and their actual members, both existing
   change sides, roles, relationship scope/proofs, per-category evidence
   statuses/reasons, relevant sources, deterministic findings/policy, and
   eligible context. Retain declaration-only npm changes, additions/removals,
   Actions occurrences, uv variants, and null absent sides. Proven grouping
   reduces assessment count, not member identity or evidence obligations.
4. Preserve all three ecosystem inventory statuses and packet-wide coverage
   limits even when a batch contains one ecosystem. An unrelated ecosystem's
   complete evidence cannot conceal an inventory gap. Do not project unrelated
   source text or unrelated units merely because they share a source URL.
5. Retain source IDs, vetted URLs, titles, exact subjects/ranges, source
   status/reasons, and existing truncation flags. Shorten only eligible text
   fields with explicit truncation metadata. Never shorten or drop identity,
   source destinations, findings, required reference bindings, coverage
   status, or policy ceilings to make a request fit. If required structure
   cannot fit, fail projection without sending a partial request.
6. Bound text per source, per unit, and across the serialized projection.
   Measure the final UTF-8 JSON bytes, including escaping and prompt/envelope
   overhead, rather than estimating with string length or `Content-Length`.
   Do not read raw files or perform extra research to fill the projection.
7. Send repository source excerpts only when trusted config explicitly permits
   them and the accepted C2 result contains them. Recheck that opt-out cannot be
   bypassed by an otherwise valid packet/context mismatch. Disabled context
   sends no source lines, file snippets, or reconstructed source facts.
   Partial context never implies complete usage; no match is not non-use.
8. Create a detached immutable projection with an opaque batch identity bound
   to its exact contents, requested unit order, review/context revisions, and
   effective policy/config/time. Exclude credentials. Validation uses this
   exact snapshot, not a later mutable input or another batch's allowlist.
   The identity stays local to the snapshot; it is never sent for the model
   to echo. The canonical identity encoding is selected during planning and
   tested for changes in any decision-relevant input.
9. Give every identifier the model must return a short batch-local alias,
   assigned deterministically in projection order: units, members, sources,
   findings, holds, and context facts. T5 unit IDs embed repository, PR,
   base/head SHAs, and member IDs, so exact echo of the originals is a
   realistic needless failure. The validator resolves each alias back to its
   original identity through this snapshot only. Each context-fact alias is
   tied to its dependency identity, trusted revision, path, and retained
   fact. A path alone is insufficient: two packages may use the same file.
   Do not rewrite collector dependency IDs to force a context match. An
   unproven dependency match supplies no context basis for adoption advice.
10. Keep instructions in a fixed system message; serialize evidence as data
    in a separate user message. Explicitly request the common JSON shape and
    state that upstream, Dependabot, source, and model text are untrusted.
    Prompt instructions supplement local validation; they grant no authority.

## Provider-Neutral Assessment Contract

The closed response document has one `assessments` array and no batch
identity; the batch binding is local. It carries no PR-level verdict, new
evidence, replacement inventory, or replacement policy. Require all
documented fields, explicit empty arrays, and `null` for absent nullable
values. Reject unknown keys, coercions,
unsupported enum values, over-limit strings/lists, and non-object roots.

Each assessment contains these logical fields; planning locks their exact
TypeScript shape and named limits without weakening these semantics:

| Field              | Required meaning                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `unitId`           | Batch-local alias for exactly one requested T5 unit; the validator maps it back to the original ID.            |
| `verdict`          | `merge`, `merge_with_followups`, or `do_not_merge`, subject to C3.                                             |
| `reason`           | Short explanation, with typed source/context references for cited claims.                                      |
| `findingIds`       | Aliases of existing findings for this unit; never model-created finding records.                               |
| `blockers`         | Explanations keyed to existing effective holds, retaining impact, evidence, remediation, and validation steps. |
| `followups`        | Bounded concrete actions explicitly marked `blocking: false`.                                                  |
| `newFunctionality` | At most one newly introduced opt-in capability for the unit, with exact member attribution.                    |

### Identity, references, and policy

1. Require exactly one assessment for every requested unit. Reject omissions,
   duplicates, and unknown aliases. Validate a response only against the
   snapshot whose request produced it; aliases never resolve through another
   batch's snapshot, even when alias counts match. Normalize accepted
   assessments to the original unit order and T5 unit IDs. One invalid
   assessment rejects the whole batch; M1 exposes no apparently valid subset.
   Independent batches remain M2's responsibility.
2. Resolve source aliases against both the projected unit and the exact member,
   change side/range, and evidence category being discussed. A URL present
   elsewhere in the packet does not authorize a claim for this member.
   File/context references must resolve to projected facts of that member
   at the trusted context revision. Missing or unavailable sources cannot
   support a verified upstream claim.
3. Use source and context aliases in reference fields; resolve destinations from
   the projection rather than accepting model-supplied URLs or paths. Reject
   unsupported reference fields and destinations. Model prose remains plain
   untrusted text; O1 must escape it and render links only from vetted references.
   Reference validation establishes attribution, not semantic proof that a
   model's paraphrase is true. Model claims never become deterministic findings.
4. Reject a verdict more permissive than the unit's effective C3 ceiling.
   Retain default/effective policy and override provenance separately. Do not
   repair a rejected verdict by silently clamping it or dropping findings.
   A model cannot invent a security, compatibility, or provenance blocker.
5. Retain every deterministic finding and effective hold outside model-owned
   fields, regardless of what the model mentions. An effective hold is a C3
   rule trace for this unit whose effective verdict is `do_not_merge`: a
   finding-backed trace, or a coverage-rule trace keyed to its gap. Each
   blocker names exactly one such hold, with no duplicates; it cannot create
   a new hold. A `do_not_merge` verdict requires at least one blocker, so a
   unit with no effective hold cannot receive `do_not_merge`. Other verdicts
   have an empty blocker list. Reject violations rather than clamping. C3 holds
   the model does not explain remain visible; a missing explanation cannot
   erase a deterministic hold.
6. A `merge_with_followups` assessment requires a nonempty bounded list of
   specific non-blocking actions. Other verdicts have an empty follow-up list;
   blockers retain their own remediation. Coverage gaps and incomplete units
   remain explicit even if a local policy override relaxes their ceiling.

### Capability advice

Retain `new_capability` and the `use_now`, `consider_later`, and `not_relevant`
classifications from the baseline. Bug fixes, security patches, compatibility
changes, performance work, docs, and maintenance are not new capabilities.
Every capability retains its member ID, vetted upstream source, and rationale.

Both `use_now` and `consider_later` require a concrete adoption action and an
exact matching trusted context fact demonstrating an existing use case.
`use_now` additionally means the proposed update supports adoption now.
`not_relevant` retains its rationale and upstream source; absent action/context
is explicit `null`. Missing context does not authorize invented usage.
`not_relevant` is not a claim that the repository lacks a use case: disabled,
partial, unavailable, or unmatched context is not proof of non-use. The
validated result retains the member's projected context status so O1 can
state when repository usage is unknown.

A direct group may describe a capability only for its directly researched
anchor with its own upstream and context support. Group-backed transitive
members receive no claim of individual research or adoption advice from the
anchor's sources. Unknown or unavailable evidence cannot satisfy these checks.

## Mistral Transport

1. Route only trusted `mistral` selection to this adapter, with the exact
   configured model. Missing provider/model/credential or an unsupported
   provider is unavailable analysis, never a fallback provider/model or an
   anonymous request. Reject empty/whitespace-only or header-invalid secrets
   before I/O; do not trim, rewrite, echo, or persist the credential.
2. POST only to `https://api.mistral.ai/v1/chat/completions` with bearer
   authorization and JSON request/accept headers. Reject redirects, including
   same-origin redirects; do not forward credentials to another destination.
   No endpoint, header, tool, or remote URL is accepted from evidence/config.
   The read token and App write token never enter the adapter.
3. Send the selected model, one choice, non-streaming completion,
   `temperature: 0` as in the baseline,
   `response_format: { type: 'json_object' }`, a bounded `max_tokens`, and
   fixed prompt messages. Supply no tools, tool execution, attachments,
   repository access, or provider-side retrieval. Mistral documents the
   [endpoint, request parameters, and bearer authentication](https://docs.mistral.ai/api/endpoint/chat).
   Its [JSON mode](https://docs.mistral.ai/inference/conversations/structured-output/json_mode)
   still needs an explicit JSON instruction and does not replace local checks.
4. Make at most one HTTP request per invocation. No automatic SDK/fetch retry,
   provider/model fallback, `Retry-After` sleep, or second repair request is
   allowed. HTTP 401/403, 429, 5xx, malformed output, and network failure all
   terminate this invocation. Only the distinct length outcome lets M2
   consider splitting a multi-unit batch.
5. Bound request bytes, response bytes, output tokens, per-request elapsed
   time, and the caller's remaining analysis deadline. Validate limits before
   I/O. Do not start after cancellation/deadline exhaustion. Timeout covers
   headers and the entire response body, not just the initial `fetch` promise.
   Cancellation must settle the call and release timers/readers even when a
   transport or body stalls; late completion cannot become accepted output.
6. Accept only a non-streaming HTTP 200 response with `application/json`
   media type, allowing normal casing and parameters. Reject HTML,
   missing/wrong content type, and SSE.
   Bound actual streamed bytes before decoding or parsing; content-length is
   only an early rejection hint. Stop/cancel on overflow or failure rather
   than draining an unbounded error body. Reject invalid UTF-8 and JSON.
7. Validate the provider envelope separately from the inner review document:
   exactly one choice, valid choice index, assistant role, no tool calls,
   and a supported finish reason. Successful output requires `stop` and a
   nonempty string message content. Reject null, arrays/content chunks,
   refusals, unexpected roles, and tool/function outputs. Ignore only bounded
   provider metadata not consumed by the contract; never return it downstream.
8. A well-formed single choice with `finish_reason: 'length'` yields the
   distinct truncated outcome. Validate envelope fields before classification;
   its partial content need not be valid inner JSON and supplies no usable
   assessment. Unknown finish reasons and invalid envelopes are ordinary
   failures, not permission to split/retry. Mistral's client also defines
   `model_length` (prompt plus output reached the model's context window);
   its classification awaits the planning spike under Open Questions.
   Parse successful content as one JSON document; do not extract fenced
   JSON, repair syntax, or strip prose. This intentionally differs from the
   baseline, which stripped one surrounding code fence: JSON mode makes a
   fence unexpected, and stripping would accept wrapped output. Parity review
   treats a rejected fenced reply as an expected difference.
9. Pass that document through the provider-neutral validator against the exact
   projection. Return only its detached immutable result. Report the selected
   model in diagnostics; do not require a returned resolved model name to equal
   a configured moving alias or silently switch the requested model.

## Outcomes, Budgets, and Diagnostics

The single-batch result distinguishes validated success, length truncation,
invalid preparation, pre-request unavailability, and attempted failure. Carry
the batch/unit identities when preparation established them, plus a fixed
failure category and whether a request was attempted. No failure variant
contains raw content or usable assessments. Keep the original trusted
inventory/policy available independently of this result.

Categories distinguish configuration/credential, projection/budget, cancellation
or deadline, transport, HTTP, media type, response size/encoding, envelope,
inner JSON, assessment schema/reference/policy, and length truncation. Public
reasons and next actions come from fixed safe templates, never exception
messages, provider error bodies, response headers, or supplied text.

M2 maps attempted failures to explicit unavailable/rejected states and
pre-request exhaustion to unattempted states for every affected unit. It may
split only a length-truncated multi-unit batch; one-unit truncation stays
unavailable. It must retain all other validated batches and use
`summarizeDecisionCoverage` with the same config/time. A verified blocker
survives even if every call fails; otherwise unresolved units prohibit a merge
recommendation. A valid single-batch response alone grants neither complete
PR coverage nor successful current-head execution.

Planning must select and record initial numeric limits for source/unit/batch
bytes, text/list/assessment fields, response bytes, completion tokens, and
per-request timeout. M2/W2 own cumulative requests, concurrency, and the
shared deadline/publication reserve. The baseline's 4,096-token completion
limit and 120,000 ms request timeout are comparison inputs, not new approvals.
The response-byte limit must admit a complete reply at the chosen completion
token limit plus envelope overhead, using a recorded bytes-per-token
allowance; otherwise a valid `stop` reply fails as oversized.
Existing C2/T4 ceilings remain upper bounds. Lock chosen values with exact
boundary tests; this draft does not invent performance or coverage thresholds.

Emit or return only allowlisted, bounded diagnostics: provider, validated
selected model, reviewed head, unit/member counts, attempt flag, and fixed
failure category. Do not log payloads, source lines, secrets, arbitrary IDs
or paths, parser/error text, provider metadata, or request/response bodies.
Use synthetic sentinels to check logs, result errors, and diagnostics. Never
persist raw model data in public fixtures or comments.

## Code Style

Use camelCase, discriminated outcomes, explicit string unions, and pure
projection/validation helpers. Inject transport and clock for deterministic
tests. Keep Mistral envelope handling outside the common assessment validator.
The intended reference check is:

```ts
const unit = batch.unitsByAlias.get(assessment.unitId);
if (!unit) return { ok: false, category: 'reference' };
```

This illustrates style, not an implemented signature. Do not hide failure in
an empty successful array or use a thrown parser message as a public reason.

## Commands and Verification

The repository already provides these commands:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

For this documentation-only draft, run:

```sh
npm run lint:md
npm run format:check
git diff --check
```

No `npm run build` script exists yet; A1 owns packaging. Focused M1 commands
can be recorded when their test files exist. Run the four implementation
quality checks on the same exact revision and record results in the relevant
issue/PR, with environment, warnings, and omitted checks. Do not claim a live
model request or workflow integration from mocked tests.

## Testing Strategy and Success Criteria

Use synthetic packets, eligible context, and provider-shaped responses. Mock
HTTP/streams and clocks; default tests require no key, live API, paid call,
consumer checkout, dependency installation from PR content, or external write.
Behavior changes must leave checks that would catch their intended defect.

| Required scenario                                                                 | Observable acceptance                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Missing/invalid config, model, or credential                                      | No request, no fallback, safe classified failure.                                                                           |
| Explicit configured model and named credential                                    | Exactly one POST to the fixed endpoint; the actual request uses only that model/key and fixed headers/options.              |
| Redirects, including to a hostile host                                            | No follow-up request or credential forwarding.                                                                              |
| C2 opt-out and failed preparation                                                 | Actual serialized request contains no source sentinel under opt-out; failures prevent I/O.                                  |
| Real C1/C2/T4/T5/C3 handoff                                                       | A mixed npm/Actions/uv packet forms and projects real units/policy; a mocked valid response returns exactly those units.    |
| Grouped unit, standalone unit, additions/removals, declarations, uv variants      | Member/side/root/occurrence identities and gaps survive; group-backed evidence cannot support individual transitive advice. |
| Same URL/path for different members                                               | Wrong attribution is rejected, including a context fact for the wrong dependency in the same file.                          |
| Response validated against another snapshot, or after inputs change               | Binding check fails; aliases never resolve to another batch's units, even with equal alias counts.                          |
| Long T5/member/source IDs                                                         | The request carries only aliases; a valid aliased response maps back to the exact original IDs.                             |
| Missing/duplicate/unknown assessments or fields                                   | Whole batch fails without exposing a partial assessment set.                                                                |
| Policy violation or invented finding/blocker                                      | Rejected; deterministic findings and holds remain independently available.                                                  |
| `do_not_merge` with empty, duplicate, or non-hold blockers                        | Rejected without clamping; a unit with no effective hold cannot receive `do_not_merge`.                                     |
| Caller-supplied policy evaluation or ceilings                                     | Not accepted; M1's internal C3 evaluation at the supplied time is the only policy binding.                                  |
| `use_now`, `consider_later`, and `not_relevant`                                   | Valid source/context/action combinations pass; unsupported classifications and missing/wrong member context fail.           |
| ASCII/multibyte text and JSON escaping at limits                                  | Exact UTF-8 source/unit/request/response boundaries pass; overflow fails before unbounded retention or I/O as appropriate.  |
| Projection truncation versus required-structure overflow                          | Text shortening is explicit; identity/findings/gaps/ceilings survive, or projection fails intact.                           |
| 401/403, 429, 5xx, network failure, cancellation, timeout                         | One attempt at most, no repair call or sleep, no usable assessment, timers/readers released.                                |
| Wrong/missing content type, SSE, invalid UTF-8, oversized/missing-length streams  | Classified failure; observed bytes and body time remain bounded.                                                            |
| Valid `stop`, `length`, unknown finish, tools/refusal, wrong choice count/content | Only `stop` plus valid inner content succeeds; only valid `length` reports truncation.                                      |
| Maximum-size valid `stop` reply at the completion-token limit                     | Passes the response-byte limit.                                                                                             |
| `not_relevant` under disabled, partial, or unmatched context                      | Result retains the member's context status; it is not represented as proven non-use.                                        |
| Headers arrive then body stalls; transport ignores cancellation; late response    | Invocation settles within its effective budget and never accepts late output.                                               |
| Malformed/fenced JSON or invalid schema/references                                | Ordinary failure, never a length-split signal or silently repaired success.                                                 |
| Blocker plus a failed independent call                                            | Feeding M1 results to real T5/C3 retains the hold and unresolved unit; no PR-level success is inferred.                     |
| Hostile evidence instructions and secret/source/model sentinels                   | Cannot alter endpoint, model, schema, references, or policy; no sentinel leaks into diagnostics/errors/logs.                |
| Mutation of caller inputs or returned values                                      | Projection/validation remains bound to its original immutable snapshot.                                                     |

The integration fixture exercises M1 and existing exports directly; it does
not implement M2 to claim scheduling/splitting coverage. M2 must separately
verify concurrency, request-count limits, recursive splits, every-unit
accounting, independent successes, and PR aggregation. O1/W2/A1 must separately
verify rendering, freshness/publication, named-secret wiring, and packaging.
Consumer trials, live-provider compatibility, adoption, parity, and cutover
remain separate gates. Mocked success does not certify any of them.

## Boundaries

- **Always:** Validate before transmission and after response, preserve exact
  unit/member/source/context attribution and deterministic policy, bound work,
  honor excerpt opt-out, and return explicit safe failures.
- **Ask first:** Add providers, endpoints, SDK/runtime dependencies, data
  categories, or tools; loosen reference checks; change approved budgets or
  workflow time; amend C1/C2/T4/T5/C3 contracts or disclosure policy.
- **Never:** Execute dependency/model code, forward credentials on redirects,
  infer trust from TypeScript alone, log raw data, retry a failed model call
  inside M1, publish unvalidated text, or claim an incomplete PR is reviewed.

## Approved Planning Selections

The following initial choices were approved with the M1 plan. They do not claim
measured performance or live-provider compatibility. No dependency changes
are proposed. M2/W2 still choose their cumulative budgets and publication reserve.

### Initial resource ceilings

| Limit                                              | Proposed value                       | Reason                                                                                      |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Units per prepared batch                           | 8                                    | Small ordered batches; a proven group remains one unit with all its members.                |
| Members/sources/findings retained locally          | T4's 128/1,024/512                   | Preserve the accepted inventory and required findings; no new larger input allowance.       |
| Upstream excerpt UTF-8 bytes                       | 2,048 per source                     | No larger than T4 text; retain truncation metadata.                                         |
| Repository source excerpt                          | C2's existing 500 code units         | Only already eligible C2 text; its 65,536-byte total context cap still applies.             |
| Serialized projected unit bytes                    | 65,536                               | Reject a unit whose required structure cannot fit; never remove members/findings.           |
| Final serialized HTTP request bytes                | 262,144                              | Includes fixed prompts, model/options, JSON string escaping, and envelope.                  |
| Completion tokens                                  | 4,096                                | Retain the baseline completion budget initially.                                            |
| Per-request timeout                                | 120,000 ms maximum                   | Retain baseline ceiling, clipped to the caller's remaining analysis time.                   |
| Inner content allowance                            | 128 UTF-8 bytes per completion token | Conservative planning allowance, not a documented guarantee for every model/tokenizer.      |
| Outer JSON escaping multiplier                     | 6                                    | Allows byte-to-`\uXXXX` expansion when content is encoded inside the response envelope.     |
| Provider envelope allowance                        | 65,536 bytes                         | Bounded metadata overhead beyond generated content.                                         |
| Observed response bytes                            | 3,211,264                            | `4,096 * 128 * 6 + 65,536`; input C2/T4 limits remain unchanged.                            |
| Model reason/rationale/action/impact text          | 1,024 UTF-8 bytes each               | Concise per-unit advice; nonempty when required.                                            |
| Feature text                                       | 512 UTF-8 bytes                      | At most one capability per unit.                                                            |
| Follow-up description                              | 280 UTF-8 bytes                      | Does not expand the baseline's 280-character bound.                                         |
| Follow-ups, remediation steps, validation steps    | 8 each                               | Concrete bounded lists; mandatory nonempty lists where required.                            |
| Blockers, finding references, references per claim | 32 each                              | Model explains a bounded subset; all deterministic findings remain outside model ownership. |

Apply lower caller-supplied limits when valid; reject larger, non-finite,
fractional, unsafe, or incompatible values before I/O. The response cap must
still cover the selected token allowance and envelope; lowering it requires
lowering the completion-token limit consistently. Per-unit bytes count the
fully serialized unit with its attributable source/context records. Count
deduplicated shared records once in the full batch and in every owning unit's
individual budget. No initial packing or retry logic is added to M1.

The response allowance intentionally exceeds T4's input-packet byte ceiling:
the provider nests a JSON document as an escaped string and adds metadata.
It does not enlarge any T4 or C2 input. The spike must record whether its
observed outputs challenge the allowance; a different allowance needs review.
Boundary fixtures prove acceptance within this recorded allowance, not a
universal tokenizer maximum or that all eight rich assessments fit 4,096 tokens.

### Local identity and aliases

Use versioned canonical JSON with object keys sorted by UTF-16 code-unit order
and array order preserved. Hash with Node's SHA-256 over original review and
unit/member identities, the exact aliased projection, trusted model/config,
internal C3 evaluation, fixed epoch time, limits, and prompt/schema version.
The local `batchId` is the lowercase digest, with a version prefix. It never
appears in the prompt or model document; credentials never enter the hash.

Use zero-based base-36 indices with prefixes `u`, `m`, `s`, `f`, `h`, and `c`
for unit/member/source/finding/hold/context references. Assign by deterministic
projection order. Map every reference-bearing field, including relationship
proofs and policy traces; do not send T5 proof-key strings with embedded IDs.
Keep exact original identities in detached local maps. Package names, versions,
vetted destinations, and trusted paths remain evidence data, not echo targets.

Seal the prepared handle and maps with module-private ownership rather than
relying on a public TypeScript brand. The adapter captures that exact handle
when sending and consuming its response; attach the local binding to the
normalized result. A local bound reply paired with another batch must fail.
Raw JSON with coincidentally equal aliases has no independent request proof;
do not expose a production API that reassigns arbitrary raw replies to maps.

### Exported operations and closed wire fields

`prepareAnalysisBatch` takes
`{ inventory, config, evaluatedAt, unitIds, limits }`.
It returns either `{ kind: 'prepared', batch }` or a safe failure without a
usable handle. `config` is the trusted C1 result; `evaluatedAt` is epoch
milliseconds. Re-form T5 units from the accepted packet to check supplied
inventory consistency, and call C3 internally. The trusted caller still
establishes T4 provenance; comparing a packet with itself cannot establish it.

`analyzeMistralBatch(batch, options, dependencies)` accepts only a locally
prepared handle. Options contain the separate `apiKey`, monotonic `deadlineMs`,
and optional abort signal. Dependencies supply native-compatible `fetch` and
monotonic `now` for tests; production uses `performance.now`. Deadline and
epoch evaluation time have different units/origins and are never interchanged.

The response root contains only `assessments`. Each assessment contains exactly
`unitId`, `verdict`, `reason`, `findingIds`, `blockers`, `followups`, and
`newFunctionality`. These nested fields are closed:

- A claim is `{ text, references }`; each reference is either
  `{ kind: 'source', sourceId, memberId, side, category }` or
  `{ kind: 'context', contextId, memberId }`. All IDs are aliases on the wire.
  An explanation of unavailable evidence may have an empty references array;
  that cannot support a verified upstream or usage claim.
- A blocker is `{ holdId, reason, impact, evidence, remediation, validation }`.
  `reason`/`impact` are text, `evidence` is a list of claims, and remediation/
  validation are nonempty bounded text lists. A finding-backed hold requires
  references to that finding's actual evidence; a coverage hold may cite its
  projected gap and cannot invent an available source. `holdId` resolves to
  the exact effective finding-backed trace or coverage gap/trace.
- A follow-up is `{ description, blocking, references }` with literal `false`
  for `blocking`. References use the same typed source/context variants.
- A capability is `{ kind, memberId, feature, sourceId, usefulness, action,
  contextId, rationale }`, with literal `new_capability` for `kind`.
  Nullable `action`/`contextId` are present. Source/member/context attribution
  and the three usefulness cases follow the approved capability rules.

Normalized output restores original IDs and derives destinations, context
status/reasons, findings, and holds from the snapshot rather than echoing model
versions. A success is `{ kind: 'validated', batchId, unitIds, assessments }`.
Other result kinds are `invalid`, `unavailable`, `failed`, and `truncated`,
with fixed `category`, `attempted`, and prepared identities when available;
none carries usable assessments or raw provider data. Missing credentials are
`unavailable` with `attempted: false`; invalid preparation is `invalid`;
HTTP/body/parse/schema failures after dispatch are `failed`; a recognized
completion-length stop is `truncated`. M2 maps these to existing C3 states;
the transport does not publish them or aggregate a verdict.

The native POST uses `redirect: 'error'`, `credentials: 'omit'`, `n: 1`,
`stream: false`, and the fixed options already specified. Accept only choice
index `0`; normal nullable/empty absent tool/refusal fields are not themselves
a refusal or tool call, but populated ones fail. Body validation remains
independent of selected model aliases and bounded ignorable provider metadata.

## Open Questions

1. `finish_reason: 'model_length'`. Decided 2026-11-07: the plan includes a
   spike, ordered before the transport task, that settles this with actual
   Mistral requests. Without the spike, the draft would leave it as an
   ordinary failure that M2 cannot split. Determine whether an over-context
   request returns HTTP 400 or HTTP 200 with `model_length`, and whether
   `max_tokens` changes that. Then either treat a well-formed `model_length`
   like `length` or record it as an ordinary failure, and amend this spec.
   The spike needs a credential and paid calls with the user's approval. It
   uses synthetic input; record sanitized findings in the issue, never raw
   payloads. It is outside default tests.

No other question requires a product-scope decision. Numeric budgets,
canonical identity, aliases, and exported types are recorded above and approved
for execution. Paid-call, model, credential-source, and evidence-based finish
classification decisions remain required before transport.
