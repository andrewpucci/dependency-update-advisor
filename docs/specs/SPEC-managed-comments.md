# Spec: T3 App-Owned Managed Comments

Status: approved for T3 execution, 2026-10-20. Supporting
contract for `shared-review` in [the capability map](README.md), scoped to
[issue #10: T3](https://github.com/andrewpucci/dependency-update-advisor/issues/10).
Planning approval: after revising this contract, the user invoked `as-plan`.
This authorizes planning from the revised contract and creating implementation
task issues, not implementation or live publication.
Execution approval: the user approved the five-task plan and invoked
`as-build auto`, authorizing all tasks, per-task commits, autonomous
checkpoints, and one PR closing #10 and #71–#75. Live reviewer publication
remains outside this approval.
The approved [shared workflow contract](SPEC-shared-review.md),
[T1 publication handoff](SPEC-event-verification.md#publication-handoff), and
[T2 execution-status contract](SPEC-execution-status.md) remain authoritative.

## Objective and Scope

Give a consumer maintainer one App-owned review comment attributable to the
exact reviewed PR head. Record a rendered result only after pending status is
confirmed and current-head ownership is reverified. Preserve the prior comment
on pre-analysis failure; reject obsolete writes and uncertain publication.

T3 owns comment discovery, ownership validation, create/update requests, and
publication results. It accepts the rendered body from trusted orchestration.
It does not render the decision brief, decide completeness, publish statuses,
mint tokens, choose durable claim storage, or implement the workflow.
This is one supporting capability within the approved module map.

An explicitly incomplete current-head brief may replace the prior comment
alongside a failed execution status, as the parent contract allows. A missing
or invalid configuration, unusable analysis input, or failed renderer is not
such a brief: W2 preserves the prior comment and publishes failure if still
fresh and owned. A complete `do_not_merge` brief can accompany execution success.

## Inputs and Handoffs

- [T1](SPEC-event-verification.md) supplies `ReviewBinding`, `FreshnessReads`,
  and the real `reverifyReviewBinding` operation. Its binding is a snapshot,
  not permanent write authority.
- [T2](SPEC-execution-status.md) supplies the status boundary, merged into
  `main`. T3 must not treat that source as completed workflow integration.
- [W1 #25](https://github.com/andrewpucci/dependency-update-advisor/issues/25)
  supplies bounded GitHub transport and the repository-scoped installation
  token with the already approved `Issues: write` permission. No broader
  publication permission or token access for analysis is proposed.
- [W2 #26](https://github.com/andrewpucci/dependency-update-advisor/issues/26)
  supplies exclusive durable ownership, trusted App identity, confirmed
  pending status, and the publication-ready result for this exact binding.
  W2 rejects duplicate deliveries and already claimed/completed source
  attempts before invoking publication; comment absence never proves unseen.
- [O1 #23](https://github.com/andrewpucci/dependency-update-advisor/issues/23)
  supplies the escaped, deterministic body under the approved
  [comment experience](SPEC-comment-experience.md). O1 consumes the metadata
  contract below; T3 can be tested with synthetic rendered bodies first.

Isolated T3 implementation may inject these capabilities. Live publication
requires W1/W2 integration, including the approved durable claim mechanism.
This contract neither selects that mechanism nor authorizes live writes.

### Publication input

The mutation operation accepts one input record. Field names are proposed;
planning may rename them without changing the rules. T3 copies every field
before its first asynchronous read and rejects any violation as an input error.

| Field                 | Required validation                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binding`             | T1 `ReviewBinding`. Repository, PR number, head SHA, and identity come only from it.                                                                                             |
| `result.identity`     | Exactly equals `binding.identity`.                                                                                                                                               |
| `result.kind`         | `complete` or `incomplete`. T3 rejects any other readiness state but does not use or prove completeness.                                                                         |
| `result.body`         | Rendered string that satisfies the metadata and size rules below.                                                                                                                |
| `result.reviewDigest` | Optional 64-character lowercase hexadecimal SHA-256. When present, the body's digest line must carry this value; when absent, the body must have no digest line.                 |
| `publisher.appId`     | Positive safe integer from W1/W2 trusted App metadata.                                                                                                                           |
| `publisher.botUserId` | Positive safe integer from W1/W2 trusted App metadata.                                                                                                                           |
| `pending`             | T2 `StatusReceipt` with `state: 'pending'`, `context: 'dependabot-review'`, `headSha` equal to the binding's head, and a positive `statusId`. W2 attributes it to this identity. |

The read-only discovery operation accepts only `binding` and `publisher`.

## Managed Comment Contract

### Identity and metadata

Preserve the exact marker `<!-- dependabot-intelligent-review -->`. The
[selected B1 renderer](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/reporting.mjs)
emits the following machine-readable prefix; retain its spelling and order:

```text
<!-- dependabot-intelligent-review -->
<!-- reviewed-head: <full 40-character lowercase hexadecimal SHA> -->
<!-- review-digest: <64-character lowercase hexadecimal SHA-256, when present> -->
```

The digest line is optional. Preserve a supplied validated digest; it is not
proof of ownership, completeness, or replay eligibility. Do not skip a newer
eligible CI attempt just because its head or digest matches the prior review.
Require exactly one managed marker and one reviewed-head metadata line in
new bodies, at the start as shown, with the head equal to the binding's head
in lowercase. Reject conflicting/duplicate metadata and a digest line that
differs from the supplied `result.reviewDigest`. Visible head/date, decision
hierarchy, evidence limits, escaping, and safe links remain O1 obligations;
marker validation does not certify arbitrary Markdown as a valid review.

Retain the baseline renderer's 50,000 JavaScript string-unit body ceiling,
including metadata, rather than introducing a larger allowance. T3 rejects
empty, invalid, or oversized bodies before writes and never truncates them.
O1 must fit all required decision content or fail rendering.

The trusted expected publisher contains positive safe-integer App and bot-user
IDs. W1/W2 must establish their relationship from trusted App metadata, not
PR content or a discovered comment. An owned comment requires its API-read
`user.id` to match the designated bot-user ID, `user.type` to be `Bot`, and a
body whose first line, ending at the first `\n`, is exactly the managed marker.
This is deliberately stricter than the baseline's substring match, so quoted
or escaped marker text elsewhere in a body never qualifies. A login, display
name, marker, or `author_association` alone cannot authorize an update. For a
candidate with the designated bot-user ID, if `performed_via_github_app` is
present and non-null, its ID must match the expected App; conflicting or
malformed attribution fails discovery. Missing App attribution does not
replace the required exact bot-user match.

The old `github-actions[bot]` comment and another App's comment are not adopted
just because they carry this marker. T3 does not migrate, edit, or delete
them; consumer cutover owns the old reviewer's retirement.

### Discovery and target selection

Use issue timeline comments, not PR review comments. Construct requests from
the immutable consumer repository and bound PR number. GitHub documents
[listing issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments),
[reading one comment](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment),
[creating](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment),
and [updating](https://docs.github.com/en/rest/issues/comments#update-an-issue-comment).

W1's injected listing operation must return a complete, bounded collection
for this PR, including all pages. A truncated list, exhausted budget,
unavailable page, or failed/invalid response is a discovery error, never an
empty collection. T3 validates the response and explicit completion signal
before selecting a target. W1 separately proves pagination and finite request,
byte, and time budgets; T3 tests incomplete and flattened multi-page results.

Classify only validated API comment data. Require numeric comment/user IDs
and usable raw bodies for ownership classification; unreadable or malformed
entries that prevent classification fail discovery. A comment carries no
issue number, so validate membership of owned candidates by comparing their
`issue_url`, ASCII-lowercased, with
`https://api.github.com/repos/{owner}/{repo}/issues/{pull_number}` built from
the binding's lowercase owner and name. Any other value, including one left by
a repository rename, fails discovery. Payload URLs are data for comparison
only, never request destinations.

- No owned marker comment: create one after complete discovery and final gates.
- Exactly one: update that ID only. An older reviewed head is expected and
  may be replaced. Read the selected comment again by its validated ID before
  updating; require the same ownership, PR membership, marker, and body seen
  during discovery. A disappearance or intervening edit fails discovery;
  do not switch to create or silently select another comment.
- Multiple owned marker comments: return a discovery error, with no mutation,
  that carries the owned comment IDs. W2 writes those IDs to the job log for
  maintainer cleanup; status descriptions remain T2's fixed text. Do not
  choose a winner, update one of the matches, or delete duplicates. The user
  selected this policy.

Ownership of an existing marker comment does not require valid old head/digest
metadata: an authorized current result can repair its own legacy metadata.
Malformed old metadata cannot support a stale-comment assertion. A separate
discovery result may report a valid prior full head, so W2 can set T2's stale
indicator only after a successful trusted read. Failed, incomplete, or
ambiguous reads supply no stale indicator and do not block pending status.
The indicator describes the comment as read before any T3 write. After a
`recorded`, `write`, or `post-write` result, W2 must omit it: the comment then
describes the current head or its state is unknown.

### Publication gates and order

W2 coordinates these steps; T3 never calls T2 or invents fallback status writes:

1. T1 verifies the source identity and W2 claims it exclusively. W2 confirms
   T2 pending for that identity before any comment mutation. A failed or
   uncertain pending write stops the review before comment mutation.
2. W2 obtains a publication-ready complete or explicitly incomplete rendered
   result. T3 validates and copies the [publication input](#publication-input)
   before asynchronous reads. A caller boolean alone is not a confirmed
   pending receipt.
3. T3 runs these steps in order: list comments; reread the selected comment,
   when one exists; run T1's real freshness check; require W2 ownership for
   the exact identity; dispatch the write. Perform no analysis or further
   comment lookup between the freshness check and the write. Lost ownership
   or an obsolete binding returns obsolete; unavailable, malformed, or
   mismatched checks return a verification or ownership error. Neither
   authorizes a write.
4. Perform at most one create or update. Validate the acknowledgement, then
   recheck freshness and ownership before returning a recorded current result.
   If an owned comment already has the exact requested body, make no mutation
   and apply the same final freshness/ownership checks before confirming it
   as recorded. Head or digest equality alone is insufficient. Because
   nothing was written, a failed check on this path returns obsolete without
   a receipt, or a verification or ownership error, never a `post-write` error.
5. Only a recorded complete result permits W2 to give T2 `complete` with
   `commentRecorded: true`. A recorded incomplete result requires T2 failure.
   Comment errors require job failure and a guarded failure status when fresh
   ownership can still be established; obsolete results stop publication.

Every pre-analysis failure bypasses the mutation operation. W2 may use the
read-only discovery operation for stale-comment metadata, but never clears,
relabels, or replaces the old body merely to announce failure.

GitHub comment reads and writes have no documented PR-head precondition.
Freshness/ownership checks detect observed races; they do not make an upsert
atomic. If the PR closes, head advances, source attempt changes, or claim is
lost during a confirmed write, retain the receipt for the original identity
and return obsolete. A failed post-write check returns an error with confirmed
mutation and unknown currentness. Neither result authorizes success, deletion,
rollback, rebinding, or a write to the replacement head.

W2 must prevent older owners publishing after takeover, including on the same
head. A process-local flag or one ownership read cannot establish that property.
Changes after the final check remain possible; metadata always identifies the
original reviewed head. Unit mocks do not establish cross-job exclusion.

### Requests, receipts, and uncertainty

Use only these operations against GitHub's fixed API origin:

```text
GET   /repos/{owner}/{repo}/issues/{pull_number}/comments
GET   /repos/{owner}/{repo}/issues/comments/{comment_id}
POST  /repos/{owner}/{repo}/issues/{pull_number}/comments
PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
```

Create/update payloads contain only the validated rendered `body`. Freeze
copied request identities and encode path segments; never follow event,
comment, or model-supplied URLs. No delete, reaction, review, or credential
capability belongs in T3's interface.

Confirm the documented `201` create or `200` update response and validate its
positive numeric ID, exact body, expected bot attribution, and bound PR
membership. An update must acknowledge the selected comment ID. Return a
bounded receipt with the original review identity, its head SHA in canonical
lowercase form, the comment ID, and whether it was created, updated, or
already identical. Omit raw bodies and API errors from receipts and diagnostics.

| Result                                                     | Mutation evidence                                                | W2 meaning                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `recorded`                                                 | Confirmed create/update, or identical owned comment read         | Final checks observed freshness and ownership; completeness still comes from W2. |
| `obsolete`                                                 | Not attempted or confirmed, with original receipt when available | Stop without job failure; never claim a review of the newer identity.            |
| `input`, `discovery`, `verification`, or `ownership` error | Not attempted                                                    | Fail job; no comment mutation authorized.                                        |
| `write` error                                              | Unknown                                                          | Fail job; no claimed recording or automatic retry.                               |
| `post-write` error                                         | Confirmed, with original receipt                                 | Fail job; currentness unknown; no compensation.                                  |

A rejected request, timeout, transport error, or invalid acknowledgement is
a write error with unknown mutation outcome. Keep stable diagnostic labels
for rejection, timeout, transport, and acknowledgement; never echo API text,
PR text, source excerpts, secrets, or model payloads. Do not reinterpret 403,
404, 429, or 5xx as absence or successful publication.

T3 and its transport do not retry writes, reconcile uncertain creates, fall
back from update to create, or clean up by deletion. A later eligible CI
attempt rediscovers the comment under a new claim. This avoids blind duplicate
creates after a lost acknowledgement. Durable claim/recovery rules remain W2's.

If T2's terminal write fails after an accurate comment was recorded, leave
that comment and fail the job. W2 owns the one always-run failure attempt
under [amended requirement 7](SPEC-shared-review.md#requirements), with fresh
binding and ownership and only when no terminal status is confirmed. If
recovery fails or the runner is lost, pending may remain; T3 does not undo
the comment or claim atomic status/comment publication.

## Tech Stack, Structure, and Code Style

Use the existing Node.js `>=24.11.0 <25`, ESM, strict TypeScript, and
source-adjacent tests importing from `vite-plus/test`. No new dependency is
needed for isolated T3. Preserve the lockfile and existing toolchain.

```text
src/comments.ts                      → proposed discovery and publication boundary
src/comments.test.ts                 → proposed synthetic ownership/write/race fixtures
src/event.ts                         → existing T1 binding and freshness operation
src/status.ts                        → existing T2 status boundary
docs/specs/SPEC-managed-comments.md   → this supporting contract
docs/specs/README.md                  → index and approval state
```

Keep single-quote ESM conventions, explicit result unions, copied immutable
identities, and transport responses typed as `unknown` until validated.
Keep read-only discovery usable independently of mutation. Inject T1 reads,
W2 ownership checks, complete comment listing, single-comment reads, and the
two writers; storage and credentials remain outside the module. For example:

```ts
type CommentReceipt = Readonly<{
  identity: ReviewIdentity;
  headSha: string;
  commentId: number;
  operation: 'created' | 'updated' | 'identical';
}>;
```

This illustrates style, not an implemented export. The implementation must
runtime-validate binding, result readiness, publisher, and pending evidence;
a TypeScript brand does not prove provenance. W2 owns the truth of completeness
and pending attribution; T3's shape checks cannot independently prove them.

## Testing Strategy and Success Criteria

Use synthetic identities, full SHAs, real T1 freshness logic, and injected
GitHub/claim responses. Assert exact repository, PR/comment ID, body, request
count, and receipt attribution. Every pre-write rejection must have zero
comment writes. No live token, model call, or new coverage threshold is needed.

| Fixture                                                                                                                                        | Required behavior                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Complete result, no owned comment, confirmed pending and fresh claim                                                                           | One create; validated acknowledgement and final checks yield recorded.                                                      |
| One owned comment on an older head, including a match beyond the first page and a mixed-case canonical `issue_url`                             | Update only its ID after reread; preserve marker, current head, and optional digest.                                        |
| Human/other App copies marker; same App has an unrelated comment or the marker off the first line; legacy Actions bot has marker               | None is updated or deleted; complete discovery may create the App's own comment.                                            |
| Malformed ownership fields, conflicting App attribution on a designated-bot candidate, wrong `issue_url` membership, or multiple owned matches | Reject unsafe discovery; no mutation; ambiguity reports only owned comment IDs. Well-formed other authors remain unrelated. |
| Missing page, truncated result, invalid data, permission/rate-limit error, or exhausted read budget                                            | Discovery error, never empty inventory or blind create.                                                                     |
| Selected comment disappears, changes body/marker/owner, or moves outside expected membership on reread                                         | Discovery error; no create fallback.                                                                                        |
| Invalid input/pending receipt, mismatched result identity/head/digest, duplicate metadata, empty/oversized body                                | Input error; no mutation. Include exact 50,000 boundary and one-unit overflow.                                              |
| Config/pre-analysis/renderer failure, or failed/uncertain pending                                                                              | W2 never invokes mutation; prior body unchanged; terminal behavior follows T2.                                              |
| Explicitly incomplete brief and complete `do_not_merge` brief                                                                                  | Both may record; W2 requests failure and success respectively.                                                              |
| Duplicate delivery or claimed/completed source attempt                                                                                         | W2 skips publication; comment absence is not replay authority.                                                              |
| New eligible CI attempt, same head/digest                                                                                                      | May refresh; only an exactly identical body can avoid mutation.                                                             |
| Head advances, PR closes/merges, newer source attempt, or claim lost before dispatch                                                           | Obsolete, zero writes, no replacement binding.                                                                              |
| Freshness or ownership unavailable/malformed/mismatched before dispatch, or after an identical-body read                                       | Error, zero writes; no fallback target or `post-write` result.                                                              |
| Create/update rejection, timeout, transport failure, or wrong acknowledgement status/ID/body/author/membership                                 | Write error, unknown outcome; one attempt only, no retry or deletion.                                                       |
| Head/attempt/claim changes during a confirmed write                                                                                            | Obsolete with original receipt; no new-head or compensating write.                                                          |
| Freshness/ownership read fails after a confirmed write                                                                                         | Post-write error with original receipt; no claimed current success.                                                         |
| Terminal status fails after recorded comment                                                                                                   | W2 leaves body intact and uses only its guarded failure recovery.                                                           |
| Caller mutation across awaits, hostile URLs/accessors, or secret-like exceptions                                                               | Fixed copied targets and safe diagnostics; no untrusted value leaks.                                                        |

Passing T3 fixtures establishes the isolated ownership and publication
boundary. W1 must separately prove complete bounded pagination, token scope,
and App-to-bot identity. W1 or adoption must also show, with a recorded or
live response, that GitHub returns created, updated, and reread bodies
byte-identical to the request; exact-body acknowledgement, reread, and
identical-body checks depend on it and synthetic mocks cannot prove it.
W2 must prove pending/comment/terminal ordering, durable replay protection
and takeover, preservation paths, stale-indicator omission after T3 writes,
and always-run recovery. O1 must prove the visible brief and escaping.
Adoption and parity remain separate gates; the old reviewer stays active.

## Commands

For this documentation change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

After T3 implementation, run on one exact shared revision:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

Focused tests after the proposed comment test file exists:

```sh
npm test -- --run src/comments.test.ts src/status.test.ts src/event.test.ts
```

No build command exists yet; packaging remains A1. Record the tested SHA,
Node/npm versions, commands, outcomes, warnings, and omitted checks in issue
#10 or its PR. Documentation checks are not implementation or live-write
evidence. Inspect the diff for private consumer details before publishing.

## Boundaries

- **Always:** Preserve exact review attribution, runtime validation, designated
  App ownership, confirmed pending, fresh checks, publication uncertainty, and
  pre-analysis comment preservation. Fail the job on every T3 error.
- **Ask first:** Change the managed marker, adopt another author's comment,
  delete or post additional managed comments, broaden App permissions, add a
  dependency, choose replay storage, or widen into live workflow coordination.
  Record approval in the relevant contract.
- **Never:** Execute PR code, infer ownership from a marker/login, treat failed
  listing as empty, use digest equality as replay authority, retry uncertain
  writes, rebind to another head, expose private data, claim atomic publication
  or durable exclusion from mocks, or retire the old reviewer before cutover.

## Approval Scope and Remaining Gates

The user selected stopping publication and reporting ambiguity when multiple
App-owned marker comments match, leaving cleanup to the maintainer. This
decision resolves that policy question. The subsequent `as-plan` invocation
authorizes planning from the revised contract.

The implementation plan is approved for isolated T3 execution. Concrete live transport
budgets, trusted App-to-bot resolution, durable claims, takeover, and recovery
remain integration decisions requiring their own contracts.

Execution approval does not authorize live reviewer publication.
