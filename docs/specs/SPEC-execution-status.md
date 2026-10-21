# Spec: T2 Current-Head Execution Status

Status: approved for T2 execution, 2026-10-20. Supporting contract for
`shared-review` in [the capability map](README.md), scoped to
[issue #9: T2](https://github.com/andrewpucci/dependency-update-advisor/issues/9).
Approval: the user approved this contract, including the rules under
[Review Decision](#review-decision), on 2026-10-20 after rereading the
revised draft. The user then approved the implementation plan and invoked
`as-build auto`, authorizing all four tasks and one PR closing #9 and #66–#69.
Execution includes per-task commits and autonomous quality checkpoints; live
reviewer publication remains outside this approval.
The approved [shared workflow contract](SPEC-shared-review.md) and
[T1 publication handoff](SPEC-event-verification.md#publication-handoff)
remain authoritative.

Implementation: the [status boundary](../../src/status.ts) and
[tests](../../src/status.test.ts) are implemented and merged into `main`.
[Verification issue #69](https://github.com/andrewpucci/dependency-update-advisor/issues/69)
records exact-revision evidence and the remaining integration limits.

## Review Decision

The isolated T2 contract is approved with these rules:

- Recheck freshness and ownership after a confirmed status write. Stop on
  obsolete or uncertain results, retaining attribution to the original SHA.
- Attempt each status write once. Return a status-write error on rejection or
  uncertain acknowledgement. T2 never retries or falls back; W2's always-run
  `failure` attempt under amended requirement 7 is the only authorized recovery.
  A manual workflow re-run is a new attempt, not recovery.
- Every error result fails the job, including input errors before pending.
  An `obsolete` result stops publication without failing the job.
- Treat every write error as an unknown outcome, even a definite HTTP rejection;
  the diagnostic label still records which kind of failure occurred.
- Use exact descriptions, with `. Previous comment is stale` appended when
  trusted data shows the prior comment describes another head.

The approval scope is T2's status request/result boundary and mocked tests.
Live publication remains gated on the reusable workflow (W1), end-to-end
orchestration (W2), and managed comments (T3), as detailed under
[Integration Gates](#integration-gates).

T2 relies on the parent's
[amended requirement 7](SPEC-shared-review.md#requirements): a failed pending
write stops before any comment mutation, and a failed terminal write after an
accurate current-head comment leaves `pending` and a failed job.

## Objective

Give consumer maintainers an advisory `dependabot-review` commit status that
reports whether the review of a specific current PR head completed. Publish
pending, success, and failure only with a reverified T1 binding and exclusive
W2 ownership. A failed or uncertain write must never be reported as a
successful current-head review.

T2 owns the status request, publication result, and mocked publication tests.
It does not decide dependency recommendations, update managed comments,
mint credentials, implement replay storage, or supply the privileged workflow.

## Inputs and Scope

- Issue #9 and the approved parent contract supply the status name, advisory
  meaning, three states, and failure behavior. No new module is needed.
- [T1](SPEC-event-verification.md) supplies `ReviewBinding`, `FreshnessReads`,
  and `reverifyReviewBinding`. T1 is merged into `main` in
  [PR #63](https://github.com/andrewpucci/dependency-update-advisor/pull/63).
  Its issue #8 and subtasks #59–#62 are closed. A binding is a
  snapshot, not permanent write authority.
- T2 accepts trusted reviewer execution metadata and an explicit review
  outcome from W2. The privileged reviewer run is distinct from the source CI
  run in the T1 binding. Neither CI conclusion nor local verdict authorizes
  reviewer success.
- The [reusable workflow (W1)](https://github.com/andrewpucci/dependency-update-advisor/issues/25)
  must supply bounded GitHub transport and a repository-scoped App token with
  the approved `Commit statuses: write` permission. These are integration
  requirements, not implemented T2 transport or credentials.
- [End-to-end orchestration (W2)](https://github.com/andrewpucci/dependency-update-advisor/issues/26)
  must supply exclusive ownership checks for the exact review identity and
  coordinate T2 with [managed comments (T3)](https://github.com/andrewpucci/dependency-update-advisor/issues/10).
- Isolated implementation may use injected reads, writes, and ownership
  checks. Live writes require the approved W1/W2 integration, including the
  unresolved durable claim mechanism. Mocks do not establish those gates.

## Status Contract

### Attribution and metadata

Build the request from the runtime-validated, owned binding snapshot. The
consumer base repository is the status target, including when the PR head
repository differs. Use the full bound head SHA, never a branch name,
merge SHA, default-branch SHA, or newly discovered head.

Use `POST /repos/{owner}/{repo}/statuses/{sha}` with the exact context
`dependabot-review`. GitHub documents the request fields, App permission,
and `201 Created` response in
[Create a commit status](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status).
The request has no documented PR-head precondition; this design therefore
detects observed races rather than promising an atomic PR/status write.

Include a target URL for the privileged reviewer run attempt, constructed
from trusted execution identities on GitHub's fixed origin. Do not reuse an
event-supplied URL or link only to the source CI run. Use these exact
descriptions, derived only from state and a trusted stale-comment indicator:

| State     | Meaning                                     | Description                        |
| --------- | ------------------------------------------- | ---------------------------------- |
| `pending` | A current-head review is running.           | `Review in progress`               |
| `success` | A complete current-head result is recorded. | `Review completed`                 |
| `failure` | The review is unavailable or incomplete.    | `Review unavailable or incomplete` |

When W2 reports that the prior managed comment describes another head,
pending and failure descriptions append `. Previous comment is stale`, for
example `Review in progress. Previous comment is stale`.
W2 sets that indicator only from a completed, trusted comment read. Omit the
suffix when no read has completed or the read failed; the read may precede
pending, but pending does not wait for it. Do not interpolate PR text,
provider output, exception messages, credentials, or source excerpts.

### State selection

Distinguish a **comment-publication failure**, where T3 cannot record the
managed review comment, from a **status-write failure**, where T2 cannot
confirm its requested commit status. The first can require a `failure` status;
the second returns an error, and T2 makes no fallback status write. Only W2's
always-run recovery attempt, described under
[Integration Gates](#integration-gates), may follow it.

1. Publish pending before analysis or comment mutation. If it cannot be
   confirmed, report a status-write error and require the privileged job to
   fail before any comment mutation; do not continue to a successful review.
2. Publish success only after W2 confirms a complete result is recorded for
   this exact binding, including the required current-head managed comment.
   Complete evidence and analysis with `do_not_merge` may still yield success.
   A successful source CI conclusion or local policy override is insufficient.
3. Publish failure for invalid config, unavailable provider credentials or
   analysis, incomplete required evidence, or comment-publication failure,
   provided a fresh binding and exclusive ownership can still be established.
   An unusable App token prevents any status write; the transport rejection
   is a status-write error. Invalid config and other pre-analysis failures
   leave the prior comment intact.
   An incomplete current-head comment may accompany failure under T3/W2.
4. T2 cannot independently prove review completeness or comment recording.
   W2 owns those facts and must not provide a success outcome prematurely.
   Reject missing, malformed, or inconsistent outcome input before writing.
5. Use these three states; do not substitute GitHub's `error` state, change
   the context, or configure it as a required branch check.

### Before and after every write

Validate all external inputs at runtime and copy identities before awaiting
reads. Use T1's real freshness operation, with injected read transport, for
pending and both terminal states. Require an affirmative ownership check for
the exact binding before each write. Order the checks with W2 so freshness
and ownership are checked immediately before dispatch, without intervening
analysis or comment operations.

- An obsolete binding or lost ownership stops publication. Never rebind or
  write a failure onto a replacement head or attempt.
- A freshness or ownership error authorizes no write. A claim confirmed as
  lost is obsolete; unavailable, malformed, or mismatched claim data is an
  ownership error. Never reinterpret either as ownership.
- After a confirmed write, recheck freshness and ownership before returning
  current-head publication success. A head advance, closed/merged PR, newer
  source attempt, or lost claim makes the result obsolete. A failed post-write
  check makes currentness unknown and returns an error.
- A post-write obsolete/error result records that a status was confirmed on
  the original SHA; it does not claim that status was rolled back. Stop further
  writes from that operation. Do not compensate on a new head or overwrite a
  newer attempt's status on the same head.

Reads and writes are not atomic. A confirmed original-head status may remain
after the PR moves, and a change after the final check is still possible.
Report only what was observed, retain exact SHA/run attribution, and never
claim a review of a later head. W2 must prevent older owners publishing over
newer owners; a process-local flag or a one-time ownership read is insufficient.

### Status-write results and errors

Return an explicit published, obsolete, or error result. A published result
means the requested state was confirmed and subsequent checks observed
freshness and ownership; publishing a failure state is not review success.
Every result records whether the write was not attempted, confirmed, or has
an unknown outcome. Confirmed writes carry a bounded receipt containing the
original head SHA, state, context, and status ID. Do not expose raw bodies.

| Result               | Write outcome            | Meaning                                                                    |
| -------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `published`          | confirmed                | Write confirmed; post-write checks observed freshness and ownership.       |
| `obsolete`           | not attempted, confirmed | Head, PR, attempt, or claim moved on; stop publishing without job failure. |
| `input` error        | not attempted            | Missing or malformed binding, outcome, claim, or reviewer metadata.        |
| `verification` error | not attempted            | T1 freshness returned an error before the write.                           |
| `ownership` error    | not attempted            | Claim data was unavailable, malformed, or for another identity.            |
| `write` error        | unknown                  | Rejection, transport error, timeout, or invalid acknowledgement.           |
| `post-write` error   | confirmed                | Write confirmed, but a post-write check failed, so currentness is unknown. |

Every error result requires the privileged job to fail. An obsolete result
ends this operation's publication; a newer owner or head is responsible for
the current status. Treat every `write` error as an unknown outcome, even an
HTTP rejection, because T2 neither retries nor reconciles the write. Its
stable diagnostic label still distinguishes rejection, transport error,
timeout, and invalid acknowledgement.

Confirm the transport's `201` response and validate the returned status ID,
state, context, target URL, and description against the request. A malformed
or conflicting response cannot count as confirmed publication. GitHub's create
response does not supply a separate head SHA field; receipt attribution uses
the immutable SHA in the dispatched request.

A timeout or unusable acknowledgement may follow a server-side write: retain
that uncertainty and never turn it into success. Use stable diagnostic
categories and field labels, omitting raw API errors and untrusted values.

T2 makes one create attempt per operation and performs no automatic retry or
fallback status write. W2's always-run `failure` attempt is the only
separately authorized recovery operation; it must repeat validation,
freshness, and ownership checks. A manual workflow re-run is a new attempt
under W2 ownership, not recovery. T1 errors cannot supply a fallback failure
target. Do not mutate comments as error recovery.

## Integration Gates

T3/W2 must implement [amended requirement 7](SPEC-shared-review.md#requirements):
confirm pending before any comment mutation, and write the terminal status
only after the comment outcome is known. T2 cannot make the two GitHub writes
atomic or undo a performed comment write.

W2 must also run one guarded `failure` attempt from an always-run step when
the job is failing after this run attempted pending and holds no confirmed
terminal status. It never runs after a confirmed `success` or `failure`, so
it cannot overwrite an accurate terminal status. That attempt is a separate
operation that repeats validation, freshness, and ownership checks. If it also
fails, or the runner is lost, the head may keep `pending` with a failed job.
That is an accepted v1 limit of the advisory, non-required status.

Before live publication, W2 must have an approved coordination and recovery
contract, with exclusive durable claims, ownership transfer, and prevention
of older-owner writes. W1 must supply bounded transport and trusted execution.
Consumer adoption must separately prove App status permissions. These are
integration prerequisites, not additional storage or workflow scope for T2.

## Tech Stack and Project Structure

Use the existing Node.js range `>=24.11.0 <25`, ESM, strict TypeScript, and
source-adjacent tests importing from `vite-plus/test`. Keep the pinned
toolchain and lockfile; no new dependency is required for isolated T2 tests.

```text
src/status.ts                         → state, request, and publication boundary
src/status.test.ts                    → synthetic transport/claim/race fixtures
src/event.ts                          → existing T1 binding and freshness operation
docs/specs/SPEC-execution-status.md    → this T2 supporting contract
docs/specs/README.md                   → index and approval state
```

The source and tests implement the isolated publication boundary. Preserve
existing configuration, evidence, provider, and policy modules.
Action entry points, bundles, workflows, and replay backends remain separate.

## Code Style

Use existing single-quote ESM TypeScript conventions and explicit unions.
Treat transport responses and external outcome/claim input as `unknown` until
validated. Keep transport, credentials, and claim storage outside status logic.
Use copied immutable identities and named result categories, for example:

```ts
type ExecutionState = 'pending' | 'success' | 'failure';
type StatusReceipt = Readonly<{
  headSha: string;
  state: ExecutionState;
  context: 'dependabot-review';
  statusId: number;
}>;
```

The [source module](../../src/status.ts) owns the exported TypeScript types.
A TypeScript brand or caller boolean cannot replace runtime freshness and
ownership checks.

## T2 Interface

`publishExecutionStatus(input, dependencies)` accepts unknown input and returns
`Promise<StatusResult>`. It copies input before validation or asynchronous reads
so caller mutation or changing accessors cannot alter the validated intent.

| Input field                             | Required meaning                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `binding`                               | T1 `ReviewBinding`; revalidated by the real freshness operation.                                                              |
| `reviewer.runId`, `reviewer.runAttempt` | Positive safe integers for the privileged reviewer in the consumer repository, distinct from the source CI run.               |
| `outcome.identity`                      | Exact bound `ReviewIdentity` tuple.                                                                                           |
| `outcome.kind`                          | `running` → pending; `complete` → success; `incomplete` → failure. W2 owns the underlying evidence and analysis facts.        |
| `outcome.commentRecorded`               | Must be exactly `true` for `complete`, confirming W2 recorded the current-head managed comment.                               |
| `previousCommentIsStale`                | Optional boolean from W2's trusted read. Missing or `false` omits the suffix; failed/unfinished reads must not supply `true`. |

W2 must supply outcome and comment facts from trusted orchestration; the shape
check does not independently prove their truth. CI conclusion and advisory
recommendation do not select the status. Unknown input fields do not become
request fields or diagnostics. Invalid or uncloneable input returns an error.

`StatusDependencies` has only three capabilities:

- `reads`: T1 `FreshnessReads`, with run and PR reads returning unknown data.
- `readOwnership(identity)`: returns unknown data with the exact `identity`
  tuple and `state` of `owned` or `lost`. Other responses or read failures are
  ownership errors. T2 provides a frozen copy of the identity; W2 implements
  real cross-job exclusion behind the injected check.
- `createStatus(request)`: performs one authenticated create through W1's
  bounded transport and returns unknown `{ status, data }`. `status` is the
  HTTP response code; `data` is the decoded commit-status body. Rejecting with
  `{ kind: 'timeout' }` identifies a known timeout; other exceptions are
  transport errors. Exception properties and text remain untrusted.

`StatusRequest` contains only the consumer `repository` (`id`, `owner`, `name`),
full `sha`, `state`, `context`, `target_url`, and `description`. T2 freezes the
request and repository, encodes URL path segments on GitHub's fixed origin,
and copies acknowledgement fields into a frozen `StatusReceipt`. The transport
must use those exact targets; it must not follow payload URLs or retry creates.

`StatusResult` encodes the allowed result/write-outcome combinations in
[the result table](#status-write-results-and-errors). W2 must fail its job for
any `kind: 'error'`; `obsolete` stops publication without job failure.
`published` confirms the requested state, so a published `failure` receipt does
not mean reviewer success. W2 retains responsibility for the guarded always-run
failure operation and must not infer a confirmed terminal status from a write
error with an unknown outcome.

## Testing Strategy

Use sanitized synthetic identities, full SHAs, mocked transport and claim
results, and the real T1 freshness operation. Assert the repository, full SHA,
context, state, description, and reviewer-run URL for every dispatched write.
For every rejected pre-write case, assert zero status writes. T2 accepts no
comment writer, so comment mutation is structurally outside its interface.
No live token or new coverage/performance threshold is needed.

### State selection fixtures

These fixtures distinguish reviewer completion from the recommendation and
verify the requested status metadata.

| Fixture                                                                               | Expected behavior                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Fresh binding and owned claim, for pending/success/failure                            | One exact-head request; matching acknowledgement and post-checks confirm publication. |
| Complete recorded result with `do_not_merge`                                          | Success execution status; recommendation is unchanged.                                |
| Invalid config, missing analysis, incomplete evidence, or comment-publication failure | Failure only with fresh ownership; pre-analysis failure retains the old comment.      |
| Source CI succeeds or policy selects merge, but review is incomplete                  | No success status.                                                                    |
| Prior comment belongs to an older head                                                | Pending/failure description has the exact stale suffix.                               |
| Comment read not completed or failed                                                  | No stale suffix.                                                                      |

### Pre-write rejection

Run rejection cases before each of the three states. Confirm that rejected
inputs and failed checks authorize no status write.

| Fixture                                                                  | Expected behavior                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Missing/malformed binding, outcome, claim, or reviewer metadata          | `input` error; no request or untrusted diagnostics.                              |
| Head advances, PR closes/merges, or newer source attempt starts          | `obsolete`; zero writes, no replacement binding.                                 |
| Freshness read fails or returns invalid/mismatched identity              | `verification` error; zero writes, including fallback failure.                   |
| Claim confirmed lost                                                     | `obsolete`; zero writes.                                                         |
| Claim unavailable, malformed, or for another identity                    | `ownership` error; zero writes.                                                  |
| Mutable input across awaits, hostile URLs, or secret-like API exceptions | Fixed request attribution and origin throughout the operation; safe diagnostics. |

### Write acknowledgement

A rejected or unconfirmed status write returns an error. It must never be
converted into reviewer success or an automatic retry.

| Fixture                                                                                | Expected behavior                                                      |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 401/403/404/422/429/5xx, transport rejection, or timeout                               | `write` error, unknown outcome; no claimed success or automatic retry. |
| Wrong/missing acknowledgement ID, state, context, URL, description, or response status | `write` error; retain possible server-side write uncertainty.          |

### Post-write changes

Exercise changes during each of pending, success, and failure writes. Retain
confirmed original-head receipts even when later checks reject currentness.

| Fixture                                                               | Expected behavior                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Head advances, PR closes/merges, or newer attempt starts during write | Original-SHA receipt retained; `obsolete`, no new-head or compensating write. |
| Claim confirmed lost after the write                                  | Confirmed receipt retained; `obsolete`, never current-head success.           |
| Post-write freshness or ownership check fails                         | Confirmed receipt retained; `post-write` error, never current-head success.   |

These unit fixtures establish T2 behavior with supplied claim checks. They do
not certify cross-job exclusion, comment ordering, the always-run failure
step, consumer permissions, or cutover; W2 integration fixtures cover those.

## Commands

For this documentation change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

After implementation, run the existing checks on one exact shared revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Focused status and freshness tests:

```sh
npm test -- --run src/status.test.ts src/event.test.ts
```

No build command exists yet; packaging remains A1. Record the exact revision,
Node/npm versions, commands, outcomes, warnings, and omitted checks in issue #9
or its PR. Documentation validation is not implementation evidence.

## Boundaries

- **Always:** Reverify and check exclusive ownership before every write;
  preserve exact SHA attribution, uncertainty, safe diagnostics, and the
  advisory meaning. Require job failure for every T2 error result.
- **Ask first:** Change status meaning/context, add dependencies or permissions,
  require the status for merging, select claim storage, or widen T2 into live
  workflow/comment coordination. Record approval in the relevant contract.
- **Never:** Rebind to a new head, trust CI success as reviewer completion,
  write from a rejected binding, expose secrets/raw payloads, execute PR code,
  claim atomic publication or cross-job protection from mocked tests, or
  retire the old reviewer before parity and cutover gates pass.

## Success Criteria

1. Pending, success, and failure target only the freshly verified, exclusively
   owned head with exact `dependabot-review` context and reviewer-run link.
2. Success requires a recorded complete result; incomplete review and policy
   overrides cannot impersonate completed execution.
3. Pre-write rejection produces no write. Post-write change retains original
   attribution and cannot claim current-head success or initiate compensation.
4. Every error result, including uncertain acknowledgements, requires job
   failure and never reports a successful review; T2 has no comment-write path.
5. Status SHA/context and pre/post-write fixtures pass alongside all four
   implementation checks on the same revision, with evidence in issue #9 or
   its PR. W1/W2/T3 and adoption gates remain separately verifiable.

## Open Questions

The approved T2 choices are listed in
[Review Decision](#review-decision). These integration mechanisms remain
deferred; [Integration Gates](#integration-gates) states their obligations:

- W2: durable claim storage, trusted provenance, ownership transfer, and recovery.
- W1: bounded transport limits.
- T3/W2: write ordering and the always-run failure step.

This contract does not select those mechanisms or authorize live writes.
