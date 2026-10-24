# Spec: T1 CI Event and Current PR Head Verification

Status: approved for T1 execution, 2026-10-12; implemented and merged into
`main` in [PR #63](https://github.com/andrewpucci/dependency-update-advisor/pull/63).
Supporting contract for `shared-review`
in [the capability map](README.md), scoped to
[issue #8: T1](https://github.com/andrewpucci/dependency-update-advisor/issues/8).
Approval: the user invoked `as-build auto` on 2026-10-12 to execute the complete
T1 plan, preferring one PR and allowing a split if needed. This authorizes the
verifier, freshness interface, tests, verification, and PR; it does not
authorize workflow credentials, reviewer publication, adoption, or cutover.
The approved [shared workflow contract](SPEC-shared-review.md) and
[ADR 0002](../adr/0002-privileged-review-boundary.md) remain authoritative.
The [base-identity decision](#base-identity-amendment) is implemented by
[#107](https://github.com/andrewpucci/dependency-update-advisor/issues/107),
as part of the user-authorized D1 execution on 2026-10-24.

## Execution Scope

Implement T1's event verifier and freshness interface, including the
single-association rule: reject missing or multiple PR
associations rather than guess a PR. Accepting any completed CI conclusion
and allowing a new CI attempt to refresh the same head are already selected.

Execution excludes workflows, credential changes, live reviewer publication,
replay storage, consumer adoption, or cutover. The deferred
integration decisions are listed in the [publication handoff](#publication-handoff).

## Objective

Give reviewer contributors one fail-secure gate that binds a completed CI
run attempt to exactly one open Dependabot PR and its full current head SHA.
Unrelated, malformed, stale, ambiguous, and duplicate events must yield no
usable review binding and permit no privileged write.

T1 owns runtime validation, identity comparison, replay classification from
trusted execution state, and a reusable freshness check. It does not publish
statuses or comments, mint tokens, collect dependency evidence, or implement
the privileged workflow. A verified binding is a snapshot, not lasting write
authority. Consumers are status publication
([T2 #9](https://github.com/andrewpucci/dependency-update-advisor/issues/9)),
managed comments ([T3 #10](https://github.com/andrewpucci/dependency-update-advisor/issues/10)),
and end-to-end orchestration ([W2 #26](https://github.com/andrewpucci/dependency-update-advisor/issues/26));
their write obligations live in the [publication handoff](#publication-handoff).

## Inputs and Decisions

- The [event verifier and freshness operation](../../src/event.ts) are
  implemented and merged into `main`. T1 #8 and tasks #59–#62 are closed.
  The [verification issue](https://github.com/andrewpucci/dependency-update-advisor/issues/62)
  records revision-specific checks; no shared reviewer workflow exists.
- The existing capability map already places this responsibility in
  `shared-review`; no new module or capability-map approval is needed.
- Current prerequisites: B1–B3 and C1–C3 are complete and merged into `main`.
  T1 #8 is complete; its listed B2 dependency is satisfied. T2 #9, T3 #10,
  action packaging ([A1 #24](https://github.com/andrewpucci/dependency-update-advisor/issues/24)),
  the reusable workflow ([W1 #25](https://github.com/andrewpucci/dependency-update-advisor/issues/25)),
  and W2 #26 remain open.
- User-selected on 2026-10-12: accept any recognized completed CI conclusion
  for identity verification, including failure and cancellation. Completion
  is not CI success and does not imply successful reviewer execution. A success-only
  trigger would be a policy refinement requiring explicit approval.
- User-approved 2026-10-12: recognize `startup_failure` as a
  completed conclusion and carry it forward like `cancelled`, so a CI run that
  never started is verified rather than reported as malformed input.
- User-selected on 2026-10-12: a newer CI attempt on the same head may refresh
  the review; repeated delivery of an already claimed attempt must not refresh it.
  The [B1 handoff](../../tests/parity/README.md#source-observation-and-selection)
  records rerun refresh behavior that extraction must preserve or improve.
- Approved contract: require exactly one matching PR association in both the event
  and API run data. Reject missing or multiple associations rather than
  guessing from a branch, title, commit lookup, or artifact. This conservative
  v1 behavior may skip a legitimate run; widening it needs an approved contract.
- Trust expectations come from the consumer's default-branch caller and
  authenticated repository/workflow reads, never from the PR or event itself.
  Consumer workflow identifiers remain local; T1 defines their schema and
  comparison behavior without embedding any consumer-specific identity.

## Verification Contract

### Trust and lookup boundary

The caller supplies the outer event name, raw event payload, trusted expected
repository identity, and intended CI workflow identity. Expectations include
the repository's numeric ID and owner/name plus the CI workflow's numeric ID
and exact workflow-file path. Resolve any local workflow selector using the
trusted repository API; never copy the event's workflow ID into expectations.
The shared reusable workflow's repository is not the consumer repository.

Reads use a fixed GitHub API origin and trusted owner/name with validated
numeric identifiers. Do not follow URLs supplied by a payload. The required
read operations are:

| Read                                                        | Purpose                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}` | Confirm intended workflow ID and path in the consumer repository.        |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}`           | Verify the source run and its latest attempt, retaining PR associations. |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}`             | Verify author, repositories, state, head, base ref, and base SHA.        |
| `GET /repos/{owner}/{repo}/compare/{base}...{head}`         | Authenticate merge base after PR/head/replay gates pass.                 |

GitHub documents [workflow reads](https://docs.github.com/en/rest/actions/workflows#get-a-workflow),
[run reads](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run),
and [PR reads](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request).
Workflow/run reads require `actions: read` for private resources; W1 must
include that documented read permission with the existing `contents: read`
and `pull-requests: read`. This does not broaden the publication App token.

The latest-run read must return the same attempt as the event. Reading only
an old attempt's endpoint would fail to detect that a rerun has superseded it.
Do not request `exclude_pull_requests: true`. An unavailable or malformed read
returns a verification error, never an empty association or permissive default.

### Event, workflow, repository, and actor

1. Require outer event name `workflow_run`, payload action `completed`, and
   source run event `pull_request`. Reject `push`, `pull_request_target`,
   `workflow_dispatch`, and other event types even if the actor or head matches.
2. Require positive safe-integer repository IDs, workflow IDs, run IDs, run
   attempts, PR numbers, and actor IDs. Do not coerce strings, round numbers,
   default a missing attempt to 1, or accept `NaN` or infinity in direct calls.
3. Require event repository and source-run repository identity to match the
   trusted consumer identity. API run repository and PR base repository must
   match it too. Numeric identity is mandatory; owner/name comparison follows
   GitHub's case-insensitive repository naming and does not trim whitespace.
4. Require the event and API run workflow IDs to match the trusted expected
   ID; the workflow API ID and exact file path must match that expectation.
   A matching display name alone is insufficient. Extra unrelated API fields
   are allowed, but a conflicting identity field used by T1 must reject.
5. Require the original run actor's login to be exactly `dependabot[bot]`
   and type `Bot`, in both event and API run data, with matching numeric IDs.
   Independently require the API-read PR author to be that same bot identity.
   A Dependabot branch name, PR title, sender, or reviewer job actor is not
   proof of the source run's actor or PR authorship.
6. A human `triggering_actor` on a rerun is allowed when the original actor
   and PR author still pass. Never substitute the triggering actor for the
   original actor. GitHub distinguishes them in its
   [variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables).
7. Require API and event run ID, attempt, source event, completed status,
   conclusion, and full head SHA to agree. A newer API attempt makes the
   event obsolete, even if the PR head is unchanged. An impossible future
   event attempt or another identity conflict is a mismatch.
8. Recognized terminal conclusions are `success`, `failure`, `neutral`,
   `cancelled`, `skipped`, `timed_out`, `action_required`, `stale`, and
   `startup_failure`. GitHub's REST description lists `startup_failure` for
   completed workflow-run webhooks; some third-party schemas omit it.
   Missing, null, or unknown conclusions cannot establish completion.
   GitHub's [workflow-run trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
   fires regardless of the preceding workflow's conclusion. This contract
   carries the conclusion forward without translating it into a verdict.

### PR association and current head

GitHub's [REST schema](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
uses minimal association repositories with `id`, `name`, and `url`; they
omit `owner` and `full_name`. Validate their numeric ID and available name,
then compare against complete run/PR repository objects using ID and
`full_name`. Never derive an owner or read target from an association URL.

1. Require exactly one PR association in event and API run data, with the
   same PR number and base/head repository identities. Reject malformed,
   missing, empty, multiple, or conflicting associations before a PR lookup.
2. Fetch that PR by number in the trusted consumer repository. Require the
   returned number and base repository identity to match, state `open`, and
   no merged result. Do not use the event's PR snapshot as current metadata.
3. Require association head repository identity, source-run head repository
   identity, and API-read PR head repository identity to agree. A head repo
   need not equal the base repo, but a missing or deleted head repo fails
   verification. This does not authorize executing files from that repository.
4. Require full 40-character hexadecimal SHAs, rejecting abbreviated,
   nonhexadecimal, whitespace-padded, and non-string values. Hexadecimal case
   may normalize to lowercase for exact full-value comparison.
5. Require event `workflow_run.head_sha`, API run `head_sha`, both association
   head SHAs, and the current API PR `head.sha` to match. An advanced PR head
   makes the event obsolete; do not relabel it with the new head.
6. Do not use the privileged review job's `GITHUB_SHA`, a branch name, PR merge
   commit, or CI checkout SHA as a substitute. The reviewer trigger uses the
   default branch; repository CI may test a generated merge commit, as
   [B3 documents](SPEC-ci-enforcement.md#known-inputs-and-assumptions).
   The review binding identifies the PR head, not the tested checkout.

### Reruns and replay state

The review identity is `(repository ID, workflow ID, source run ID,
source run attempt, PR number, full head SHA)`. Replaying the same identity
must not start another review or overwrite a current result. An attempt
greater than 1 is not automatically a duplicate.

T1 receives trusted replay state for the verified identity from the workflow
integration. That state distinguishes `unseen`, `claimed`, and `completed`;
only `unseen` is eligible. Unknown, unavailable, malformed, or conflicting
state yields an error. Never infer `unseen` from a failed state lookup or
from absence of a managed comment alone.

A later API-confirmed CI attempt is a new identity and may refresh the same
head. A repeated delivery or reviewer-job rerun for an already claimed or
completed source attempt is skipped. Recovery from a failed claimed attempt
uses a new CI attempt; it must not silently erase replay state. Delayed older
attempts are obsolete regardless of their recorded state.

### Results, freshness, and failures

Return one explicit result: `verified` with a bounded immutable binding;
`skip` with a stable category for obsolete, duplicate, or ineligible events;
or `error` for malformed/conflicting data or unavailable verification.
Only `verified` exposes a binding. Do not return a partially usable PR number
or new-head binding on rejection. Include repository/workflow identity, run
ID/attempt, PR number, full head SHA, `baseRef`, `baseSha`, `mergeBaseSha`,
conclusion, and review identity; exclude
raw payloads, PR text, artifact URLs, and credentials.

The result categories below govern the fixtures. For an eligible event type,
validate required fields before comparing identities. A well-formed but
ineligible event is skipped; malformed data is an error. A confirmed newer
attempt, advanced head, or closed PR is obsolete; other identity disagreements
are mismatches. Use `read` when a required API response cannot be obtained or
decoded, `input` for invalid decoded event/API fields, and `replay` for invalid
or unavailable trusted replay state.

Fixture tables use `skip: reason` and `error: category` as shorthand for the
result's separate fields, not as literal serialized strings.

Provide a freshness operation that rereads the latest run and PR using the
binding, then compares repository, actor, association, open state, latest
attempt, and full head. It returns `fresh`, `obsolete`, or `error` using the
same error categories; it must never update a binding to another head or
attempt. `FreshnessReads` includes `readComparison(repository, base, head)`.
The exported pure `classifyPullRequest(binding, response, comparison?)` parses
the PR and returns `current`, `obsolete`, `compare` with the observed base
SHA, or a fixed verification error. A supplied comparison wrapper validates
its echoed base and merge base. `reverifyReviewBinding` and D1 reuse this
classifier. The [decision table](#freshness-decision-table) also governs
retargets and base movement. Publication uses it under the [handoff contract](#publication-handoff).

Check stable run/repository/actor identities and attempt before same-attempt
completion/conclusion: a newer running attempt with a null conclusion is
obsolete. Freshness reads the bound PR directly even when API associations
become empty. A confirmed closed/advanced bound PR is obsolete before comparing
evolving association head SHAs; conflicting PR numbers/repository IDs remain
mismatches. These projections do not authorize discovery of another PR.

Diagnostics expose stable categories and known field names only. Do not echo
untrusted strings, raw API errors, repository-private PR links, payloads,
source excerpts, or secrets. API 403, 404, 429, transport failures, and invalid
responses remain verification errors; none means an eligible event or no PR.

### Publication handoff

The following obligations belong to integration, with T1 supplying validation
and freshness results:

| Owner                                         | Required integration behavior                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W2 orchestration                              | Retrieve durable replay state, claim identities exclusively, and recheck ownership before each write. Prevent simultaneous claims and publication by an older owner after a newer attempt takes over.           |
| T2 status publication and T3 managed comments | Check freshness immediately before every external write, including pending and failure statuses. Stop on obsolete/error results or a lost claim; retain exact SHA attribution and test post-write head changes. |
| W1 reusable workflow                          | Establish trusted execution and bounded API transport with the documented read permissions. Propagate bounded-read failures to T1.                                                                              |

A process-local set or an unserialized read-then-write replay check is
insufficient. The concrete W2 state mechanism must be specified and approved
before W2 execution or live writes, including trusted provenance,
serialization, ownership transfer, and recovery. That mechanism and transport
byte/request limits remain unresolved;
this contract does not select a backend or claim an implemented transport limit.

T1 errors authorize no fallback write. Integration may publish failure only
after independently establishing a fresh binding and exclusive ownership.
GitHub reads and writes are not atomic: T1 detects changes observed before a
write but cannot prevent a PR moving afterward. An older result must never
be reported as a review of a newer head.

T1 tests establish classification with supplied replay state and mocked API
reads. T2/T3/W2 tests must establish cross-job replay protection and publication
behavior; the old reviewer stays active until parity and cutover gates pass.

## Base-Identity Amendment

Status: implemented for [#107](https://github.com/andrewpucci/dependency-update-advisor/issues/107)
within the D1 plan. The user approved planning and execution on 2026-10-24,
selecting one PR for all seven tasks. This section records the base-identity
contract and its rationale; the read, result, and freshness interfaces above
include it.

### Problem and evidence

T1 reads the PR but discards its base commit. T4 requires a `baseSha` equal
to "the caller's authenticated PR-base snapshot," and no module produces it.
D1 would otherwise mint review identity inside an evidence reader, and the
freshness check would remain blind to base changes.

GitHub's PR `base.sha` is neither the live base tip nor reliably fixed per
head push. A read-only public API survey on 2026-10-24 found:

- 3 of 92 open `nodejs/node` PRs and 5 of 100 open `home-assistant/core` PRs
  had a `base.sha` equal to the current base-branch tip.
- Every recently pushed PR sampled recorded the tip at push time, equal to
  the merge base.
- 39 `nodejs/node` PRs shared one ordinary 2026-10-21 base commit, including
  a head committed in 2024. The base branch was not rewritten. These bases
  moved without a head push; GitHub exposed no trigger.

GitHub's [base-branch documentation](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-base-branch-of-a-pull-request)
says the base commit does not follow later branch updates. Contracts must
handle the observed silent move anyway. A forward base move usually leaves
the merge base, and therefore the PR's three-dot diff, unchanged. A rewrite
or retarget can change the diff without a head change.

### Binding additions

1. Add flat `baseRef`, `baseSha`, and `mergeBaseSha` fields to
   `ReviewBinding`. The base repository remains `repository`.
2. Read `baseRef` and `baseSha` from the same authenticated PR read that
   confirms the head. Do not use the event's PR snapshot. Validate `baseRef`
   as bounded control-free text and compare it exactly; unlike repository
   names, branch names are case-sensitive.
3. After the PR read, add an `EventReads` comparison read of
   `GET /repos/{owner}/{repo}/compare/{baseSha}...{headSha}` in the base
   repository. GitHub documents the
   [commit comparison](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
   Require the echoed `base_commit.sha` to equal the requested base and
   `merge_base_commit.sha` to be a full SHA. Ignore `files` and `commits`.
4. The six-part `ReviewIdentity` tuple is unchanged. Base fields do not alter
   replay, duplicate, or same-head refresh semantics.
5. A failed comparison read is `error: read`; invalid fields are
   `error: input`. Both use a new fixed `comparison` error field.
6. `FreshnessReads` gains the comparison read. T2 and T3 pass `FreshnessReads`
   through and need fixture updates, not behavior changes.

### Freshness decision table

Checks run in this order after the existing run, actor, and association
checks. Freshness never returns a replacement binding or a new base.

| Current PR observation                    | Result                                  |
| ----------------------------------------- | --------------------------------------- |
| Head advanced, PR closed, or PR merged    | `obsolete`, unchanged.                  |
| `baseRef` differs from the binding        | `obsolete`; the PR was retargeted.      |
| `base.sha` equals the binding             | `fresh`; no comparison read.            |
| `base.sha` moved; merge base unchanged    | `fresh`; the reviewed diff still holds. |
| `base.sha` moved; merge base differs      | `obsolete`; the reviewed diff changed.  |
| Comparison read fails or returns bad data | `error: read` or `error: input`.        |

An ambiguous criss-cross history can yield a different but equally valid
merge base. That case reports `obsolete`, which fails securely.

### T4 binding check

T4's `binding()` copies a closed field list before calling T1's parser.
Extend that list with the three base fields; the packet's "compare every
binding field" rule covers them. Require the trusted `expected.baseSha` to
equal `expected.binding.baseSha`. The existing packet `baseSha` equality
check then follows. The T4 envelope shape and coverage semantics are
otherwise unchanged.

### Amendment fixtures and limits

| Scenario                                                               | Expected result                        |
| ---------------------------------------------------------------------- | -------------------------------------- |
| Verified event                                                         | Binding carries all three base fields. |
| Base ref, base SHA, or merge base missing, short, or invalid           | `error: input`.                        |
| Comparison echoes a different base, or the read fails                  | `error: input` or `error: read`.       |
| Freshness: each decision-table row                                     | The row's result.                      |
| Freshness with unchanged `base.sha`                                    | No comparison read dispatched.         |
| Packet binding or `expected.baseSha` disagrees with binding base field | T4 `identity` failure.                 |

Unverified: whether a base-repository comparison resolves a fork head SHA.
Dependabot heads normally share the base repository; until verified, a fork
comparison failure stays `error: read`. The comparison response is T1's
largest read and falls under W1's transport bounds.

## Boundaries

- **Always:** Validate event and API data at runtime; use trusted expectations,
  read-only APIs, full SHAs, safe diagnostics, and fresh checks before writes.
  Preserve prior comments on rejected events and leave the old reviewer active.
- **Ask first:** Widen association discovery, change accepted actors or event
  types, make completion success-only, alter rerun recovery, add dependencies
  or permissions beyond the documented read boundary, or introduce replay
  storage. Record approval before changing those contracts.
- **Never:** Execute PR code, use PR config as expectations, download artifacts,
  restore untrusted caches, guess a PR from text, trust event-supplied URLs,
  authorize writes from a rejected event, or claim workflow replay protection
  from pure validation tests alone.

## Success Criteria

1. A verified result identifies exactly the intended repository, workflow,
   original bot actor, latest completed source run attempt, single open PR,
   and matching full current head, using runtime-validated API reads.
2. Accepted, stale, duplicate, non-PR, and mismatched-event fixtures cover
   issue #8, including independent mutation of each required identity.
3. Rerun refresh and duplicate suppression are distinct; replay uncertainty
   fails securely and no skipped/error result exposes a usable binding.
4. Freshness checks detect head/state/attempt changes without rebinding.
   Assess integration evidence under the [publication handoff](#publication-handoff).
5. All four implementation checks pass on the same exact shared revision,
   with evidence recorded in issue #8 or its PR. Draft documentation checks
   do not satisfy this criterion.

## Testing Strategy

Use synthetic fixtures with complete fake identities and full SHAs, mocked
read responses, and trusted replay snapshots. No live GitHub writes or
consumer credentials are needed. Test observable results, read targets, and
absence of usable bindings on every rejection; do not impose a new coverage
percentage or performance threshold.

### Binding and eligibility fixtures

All cases start with otherwise valid, matching data. Every `skip` or `error`
must omit a binding and authorize no write.

| Scenario                                                                               | Expected result                                                              |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Intended completed Dependabot run, one open PR, matching current head, unseen identity | `verified` with the exact binding.                                           |
| Recognized completed conclusion, including failure, cancellation, or startup failure   | `verified`, retaining the conclusion without inferring CI or review success. |
| New latest attempt on the same head, human rerun initiator, unseen identity            | `verified` with the new attempt; original actor remains Dependabot.          |
| Claimed/completed identity, duplicate delivery, or duplicate reviewer rerun            | `skip: duplicate`.                                                           |
| Old attempt after a newer attempt starts, even on the same head                        | `skip: obsolete`.                                                            |
| Advanced PR head, closed PR, or merged PR                                              | `skip: obsolete`; no replacement binding.                                    |
| Wrong outer event, well-formed non-completion action, or non-PR source event           | `skip: ineligible`.                                                          |
| Consistent non-Dependabot actor or PR author                                           | `skip: ineligible`.                                                          |
| Well-formed empty or multiple PR associations                                          | `skip: ineligible`; no guessed PR lookup.                                    |

### Validation and read-error fixtures

Vary each required field independently; a missing association field differs
from a valid empty association array.

| Scenario                                                                                        | Expected result    |
| ----------------------------------------------------------------------------------------------- | ------------------ |
| Wrong repository/workflow ID/path, display name masking an ID mismatch, or conflicting actor ID | `error: mismatch`. |
| Event attempt greater than the API-confirmed latest attempt                                     | `error: mismatch`. |
| Conflicting PR associations or wrong API PR number/base repository                              | `error: mismatch`. |
| Head repository disagreement                                                                    | `error: mismatch`. |
| Missing/deleted head repository or missing/malformed association fields                         | `error: input`.    |
| Merge/default-branch SHA substituted in one run or association identity                         | `error: mismatch`. |
| Missing/null/primitive required fields, coerced IDs, unsafe integers, or short/invalid SHAs     | `error: input`.    |
| Missing/null/unknown conclusion                                                                 | `error: input`.    |
| Conflicting recognized conclusion or completed-status disagreement                              | `error: mismatch`. |
| API 403/404/429, transport failure, or undecodable response                                     | `error: read`.     |
| Decoded API response with invalid required fields                                               | `error: input`.    |
| Unavailable, malformed, or conflicting trusted replay state                                     | `error: replay`.   |

### Freshness and operational fixtures

These assertions exercise the same result contract at later reads and under
hostile input or mutation.

| Scenario                                                                        | Expected result and assertion                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unchanged run and open PR at freshness check                                    | `fresh`; binding remains unchanged.                                           |
| Head advances, PR closes/merges, or a newer attempt starts at freshness check   | `obsolete`; no replacement binding.                                           |
| Actor, repository, or association disagrees at freshness check                  | `error: mismatch`.                                                            |
| Freshness API read fails                                                        | `error: read`.                                                                |
| Decoded required fields become invalid at freshness check                       | `error: input`.                                                               |
| Hostile unused URL, branch, title, or secret-like field in otherwise valid data | `verified`; read targets remain fixed and raw values never enter diagnostics. |
| Secret-like exception text on a failed API read                                 | `error: read`; diagnostics omit the supplied text.                            |
| Caller mutates fixtures or binding after verification                           | `verified` identities stay unchanged or mutation is rejected.                 |

Vary each required identity independently. Re-run freshness fixtures after
changing head, state, attempt, actor, repository, or association. Verify the
fresh operation never produces a replacement binding. Tests must distinguish
the source CI run identity from the privileged reviewer job identity.

## Tech Stack

Use the existing Node.js range `>=24.11.0 <25`, ESM, strict TypeScript,
and source-adjacent tests importing from `vite-plus/test`. Keep the pinned
toolchain and lockfile. No new runtime or test dependency is required.

Keep parsing and comparison pure. Supply API reads through an injected,
read-only boundary; validate their responses as `unknown` too. Neither the
validator nor its freshness check receives a write token or model credential.
The shared workflow remains responsible for trusted execution and bounded
network transport.

## Project Structure

```text
src/event.ts                           → validation and freshness boundary
src/event.test.ts                      → synthetic event/API/replay fixtures
docs/specs/SPEC-event-verification.md   → this T1 supporting contract
docs/specs/README.md                    → spec index and approval state
```

Prefer inline synthetic fixtures and mocked reads. Preserve existing config,
context, policy, CI, and parity contracts. No new workflow, replay database,
consumer config field, or repository-wide refactor belongs to T1.

## Code Style

Use existing single-quote ESM TypeScript conventions, explicit unions, and
small runtime validators. Accept external data as `unknown`; do not assert
it into a trusted type or coerce malformed identities. Prefer owned copies
for bindings so subsequent input mutation cannot alter their identities.
The result fields and categories follow the contract above. The exported
`EventResult` uses this discriminated shape:

```ts
type EventResult =
  | { kind: 'verified'; binding: Readonly<ReviewBinding> }
  | { kind: 'skip'; reason: 'ineligible' | 'obsolete' | 'duplicate' }
  | { kind: 'error'; category: 'input' | 'mismatch' | 'read' | 'replay'; field: ErrorField };
```

No exported binding type or TypeScript brand can replace runtime freshness
and replay checks at the publication boundary.

### T1 interface

The [source module](../../src/event.ts) owns the exact exported TypeScript
types. `verifyCiEvent(input, reads)` accepts an unknown input with `eventName`,
`payload`, and trusted `expected.repository` (`id`, `owner`, `name`) and
`expected.workflow` (`id`, `path`). `payload` is the decoded workflow-run
webhook object. Both input and read results receive runtime validation.

`EventReads` exposes `readWorkflow(repository, workflowId)`,
`readRun(repository, runId)`, `readPullRequest(repository, pullNumber)`, and
`readReplay(identity)`, each returning `Promise<unknown>`. Replay results have
an exact `identity` tuple and `state` of `unseen`, `claimed`, or `completed`.
T1 does not create that trusted state or supply a transport implementation.

`reverifyReviewBinding(binding, reads)` accepts an unknown binding plus
`FreshnessReads`, which contains only run and PR reads. It returns
`FreshnessResult` (`fresh`, `obsolete`, or the same structured error).
It never reads replay eligibility or returns a replacement binding; W2 checks
exclusive ownership separately. All rejection results omit a binding, and
error fields are fixed labels rather than untrusted property names or values.

`ReviewBinding` contains frozen repository/workflow/head-repository identities,
run ID/attempt, PR number, full head, original actor ID, completed conclusion,
and the frozen `ReviewIdentity` tuple. Normalization copies identities before
awaiting another read, preserving the snapshot against caller mutation.

## Commands

Full implementation verification uses the existing sequence on one exact
shared revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Focused tests become executable only after `src/event.test.ts` exists:

```sh
npm test -- --run src/event.test.ts
```

For documentation-only changes:

```sh
npm run lint:md
npm run format:check
git diff --check
```

No build command exists. Action packaging and bundle integrity remain A1.
Record the tested revision, Node/npm versions, commands, outcomes, warnings,
and omitted checks in issue #8 or its PR. Working-tree documentation checks
do not establish implementation verification or observed consumer behavior.
