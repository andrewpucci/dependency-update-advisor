# Spec: W2 Review Orchestration

Status: approved for planning, 2026-11-08. The user approved this specification
with edits and invoked `as-plan`; execution requires separate approval of the
resulting plan. Supporting contract for `shared-review`, scoped to
[W2 #26](https://github.com/andrewpucci/dependency-update-advisor/issues/26).
The approved [shared-review contract](SPEC-shared-review.md), [event
verification](SPEC-event-verification.md), [execution-status](SPEC-execution-status.md),
[managed-comments](SPEC-managed-comments.md), [GitHub reads](SPEC-github-read.md),
and [reusable workflow](SPEC-reusable-workflow.md), together with
[trusted config](SPEC-config-parser.md), [source context](SPEC-source-context.md),
and [packet validation](SPEC-review-packet.md), remain authoritative. This
draft does not select a production claim backend or authorize live publication.

**Diagnostic amendment, approved for planning 2026-11-11:** The R1 no-write
rehearsal recorded the intentionally redacted `internal-failure` outcome, but
that aggregate does not identify a safe investigation boundary. The evidence
is recorded in [#27](https://github.com/andrewpucci/dependency-update-advisor/issues/27).
The user approved the following amendment for planning on 2026-11-11 and
approved its execution on 2026-11-11; the work is merged. This amendment does
not authorize live publication or a production claim backend.

The user approved this W2 supporting-contract map on 2026-11-08:

| Supporting contract            | Responsibility                                                                                                                  | Depends on                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `review-orchestration`         | Bind an action invocation to a current Dependabot PR and coordinate existing read, evidence, analysis, and rendering contracts. | W1, T1, T2, T3, D1, M1/M2, S1/S2/S3, N2, X1, U2, O1 |
| `review-publication`           | Exclusive ownership, ordered status/comment writes, recovery, and no-write rehearsal behavior.                                  | `review-orchestration`, T2, T3                      |
| `shared-release-observations`  | Reuse exact PyPI release observations across S2 and S3 within a review.                                                         | `review-orchestration`, S2, S3                      |
| `bounded-reader-consolidation` | Move eligible legacy readers to shared bounded-request plumbing without changing documented outcomes.                           | Existing reader contracts                           |

Build order: `review-orchestration` -> `review-publication` ->
`shared-release-observations`; `bounded-reader-consolidation` may proceed
once its preservation tests are ready. The remaining rows receive their own
drafts only after this one is reviewed.

## Objective

Replace the action package's fail-closed startup stub with a credential-aware,
bounded coordinator. For a valid, current Dependabot CI completion, it
constructs the existing T1/C1/C2/D1/evidence/M2/O1 handoffs exactly once and produces
one redacted review outcome for the later publication contract. It never loads
PR code, treats unavailable data as empty evidence, leaks a credential, or
claims that a live review was published.

The immediate users are shared-review maintainers and future consumer adoption.
Success is integration tests for current-head, invalid-config, incomplete
evidence, model failure, stale-run, and duplicate-run behavior, plus a
controlled no-write rehearsal. A real status or comment write remains outside
this contract until `review-publication` and consumer adoption approve a
production claim backend.

## Assumptions and Decisions

1. W1 supplies four declared inputs: `github-token`, `app-token`,
   `llm-api-key`, and `ci-workflow`. W2 rejects an absent or empty value for
   review execution; the workflow-level required-secret check may pass an
   empty string. An empty LLM key does not prevent T1 verification and claim
   acquisition using otherwise valid inputs for a failure-status-only handoff.
2. The expected repository owner/name and numeric ID come from the runner's
   trusted repository context, never the event. Planning must verify the exact
   called-workflow context variables before selecting the runtime adapter.
3. `ci-workflow` is a repository-relative `.github/workflows/` path. W2
   validates that shape and resolves its ID and exact returned path at
   GitHub's fixed API origin; it does not assume a full path is a REST selector.
4. W2 receives an injected atomic `ClaimStore`. A test implementation is the
   only backend in scope. Production storage, credentials, retention, and
   consumer configuration belong to `repo-adoption`; this draft adds no
   service or permission.
5. An empty LLM key fails the review even for a proven-empty inventory.
6. W1 supplies no checkout. W2 resolves the consumer's authenticated default
   branch once to a full commit SHA, then uses bounded API reads at that SHA
   to materialize the trusted temporary filesystem snapshot required by C1/C2.
   This snapshot is data only; no repository code or scripts are executed.

## Commands

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run build
git diff --exit-code
test -z "$(git status --porcelain --ignored --untracked-files=all | grep -v '^!! node_modules/')"
```

Use focused orchestration tests while iterating, then run the full sequence on
the exact revision. Build and clean-tree checks preserve the committed bundle
and licence notices; they do not authorize a live action run.

## Project Structure

```text
src/index.ts                  -> action entry point; invokes W2 after startup checks
src/review.ts                 -> coordinator and tagged outcome algebra (new)
src/review.test.ts            -> mocked end-to-end coordinator tests (new)
src/github-client.ts          -> fixed-origin, bounded GitHub adapter (new)
src/github-client.test.ts     -> URL, transport, and capability tests (new)
src/event.ts                  -> T1 identity/freshness validation
src/github-read.ts            -> D1 immutable evidence session
src/config.ts, src/context.ts -> C1/C2 trusted config and bounded source context
src/evidence/*.ts             -> collectors; receive neither App nor LLM token
src/analysis/*.ts             -> M1/M2; only adapter receives LLM key
src/status.ts, src/comments.ts -> T2/T3, used by the later publication contract
```

Planning selects exact exports and filenames but may not duplicate an existing
validator or weaken a bounded-read contract.

## Code Style

Use strict TypeScript, ESM, immutable copied boundary values, injected
dependencies, and explicit tagged outcomes. Every environment value and API
response is untrusted until its owning contract validates it. Never log raw
responses, error messages, model data, excerpts, or credentials.

```ts
const current = await reverifyReviewBinding(binding, reads);
if (current.kind !== 'fresh') return { kind: 'not-published', reason: current.kind };

const claim = await claims.read(binding.identity);
if (claim.kind !== 'owned') return { kind: 'not-published', reason: 'ownership' };

return Object.freeze({ kind: 'ready-for-publication', binding, packet, decision });
```

Each dependency receives only its needed capability: GitHub evidence gets the
read token, registries get credential-free fetch, the M1 adapter gets the LLM
key, and a future T2/T3 publisher gets the App token. No downstream module
receives `process.env` or a general fetch function.

## Requirements

1. **Input and context validation.** Reject an invalid event, trusted
   repository context, workflow path, or empty declared input before any
   collector or model operation. Invalid or unverifiable identity authorizes
   no publication handoff. With otherwise valid inputs, an empty LLM key
   still permits T1 verification and exclusive claim acquisition so a fresh,
   owned failure can request a failure status without a comment. Missing read
   credentials must not fall back to the App token or event identity.
   Diagnostics and stderr contain no secret or raw input.
2. **Fixed, bounded GitHub transport.** Use only `https://api.github.com`,
   separately encode path segments, reject redirects, and bound W2 request
   count, bytes, and elapsed time. Cancellation/close aborts work and releases
   bodies. Existing distinctions, including permission/feature versus rate-limit
   403, are preserved.

   Approved execution envelope, amended 2026-11-09: 944 total requests, 1 MiB
   per response, 54 MiB total response bytes, a 15,000 ms request timeout, and
   a 240,000 ms total deadline. Exceeding any bound is a fail-closed
   unavailable outcome; it does not replace an individual reader's approved
   limits.

   The requests and bytes are divided between readers; one reader never
   borrows from another. The time limit is one shared deadline.

   | Reader                                    | Requests | Bytes   |
   | ----------------------------------------- | -------- | ------- |
   | Snapshot reads (repository, commit, tree) | 200      | 9 MiB   |
   | Freshness reads (workflow, run, PR)       | 24       | 3 MiB   |
   | GitHub evidence session                   | 160      | 12 MiB  |
   | npm registry details                      | 64       | 4 MiB   |
   | Upstream evidence                         | 240      | 15 MiB  |
   | Advisory lookup                           | 80       | 5 MiB   |
   | Signals: malware                          | 40       | 1.5 MiB |
   | Signals: npm publish times                | 40       | 1.5 MiB |
   | Signals: npm registry policy              | 64       | 2 MiB   |
   | Signals: PyPI metadata                    | 16       | 0.5 MiB |
   | Signals: Actions upstream                 | 16       | 0.5 MiB |

   Research reads scale with the group. Measured per extra npm package, the
   upstream reader needs about 7 requests (5 GitHub plus 2 registry), advisory
   lookup 2, and the malware and publish-time readers 1 each, so these shares
   cover a group of 32 changed packages, as a test confirms. A larger group
   exhausts a share and ends incomplete with a `budget` reason; the 240,000 ms
   deadline, not the request count, bounds a very large group.

   The snapshot share covers C1's 128 excerpt files with their directories.
   Freshness reads are reserved separately so a heavy snapshot cannot prevent
   the checks that keep a finished review valid. A failed freshness read is
   an internal failure, never a stale head.

3. **Credential separation.** `github-token` performs GitHub reads;
   `app-token` is reserved for later publication. Collectors, source context,
   public registries, and M1/M2 never receive the App token; collectors and
   GitHub transport never receive the LLM key. Registry requests omit
   credentials and reject cross-origin continuation. Research requests to
   `https://api.github.com` (advisories, releases, comparisons) carry the same
   `github-token` as the consumer reads, because the unauthenticated limit of
   60 requests an hour cannot cover a real group; that token is sent to no
   other host, and every other research request stays credential-free.
4. **Current binding.** Resolve the expected workflow from trusted context and
   `ci-workflow`, then call T1 with bounded reads and replay state. T1 skip,
   error, or stale freshness is terminal and is ineligible for publication.
   Reverify the immutable binding before every later externally mutating
   handoff.
5. **Exclusive claim.** Atomically claim the complete T1 identity with owner
   nonce, state, and monotonic generation. Only the present owner continues;
   duplicate identity is skipped. A later eligible attempt for the same PR
   supersedes the earlier owner, which observes `lost` before every later
   external write. An abandoned owner cannot resume; recovery needs a new
   eligible attempt. A local set or read-then-write implementation fails this
   requirement.
6. **Bounded pipeline and cleanup.** While fresh and owned, load C1 config
   through the snapshot contract below before collectors start. Invoke D1 and
   each applicable npm, Actions, and uv collector, then collect C2 context for
   the dependency identities and supply it before validating the assembled T4
   packet. Preserve each coverage/reason in T4/T5. Invoke S1/S2/S3, M2, and O1
   only through their documented, validated interfaces, using the same
   successful C1 config and policy
   evaluation time. Never fabricate an empty inventory, advisory, or decision.
   Close every session and remove the temporary snapshot in `finally`;
   cancellation reaches pending work and late results are ignored.
7. **Publication handoff only.** Return distinct redacted outcomes:
   `skipped`, `stale`, `invalid-config`, `incomplete-evidence`,
   `model-unavailable`, `complete`, and `internal-failure`. Keep status
   eligibility separate from comment eligibility. A fresh, owned failure
   retains its immutable binding and claim attribution for a failure-status-only
   handoff even when no body can be rendered. Invalid config, an empty LLM key,
   unusable analysis input, and renderer failure preserve the prior comment;
   they never require a fabricated packet or brief to request failure. A
   complete or accurately rendered incomplete result may also supply a
   comment-ready body. The handoff states whether a body exists, separately
   from what the outcome may eventually do. When no packet could be assembled,
   it also names each source that gave no usable evidence (an ecosystem or the
   packet) with one fixed evidence reason, never error text. A group too large
   for the brief to render without truncating a required item is a failure
   with a `brief` gap and reason `budget`, not a defect. Only a complete
   result is eligible for eventual success, after publication confirms the
   current-head comment was recorded.
   Skipped, stale, unverified, or unowned outcomes authorize neither status nor
   comment publication. This contract calls neither T2/T3 writer nor a real
   App-token request; the later publisher rechecks freshness and ownership.
8. **No-write rehearsal.** A rehearsal sink records intended pending/failure/
   success/comment operations, binding, and ordering without a network write.
   It refuses a real App token, has no live-client fallback, and emits only
   bounded, sanitized traces.
9. **Startup diagnostics.** Replacing A1's stub retains its fail-closed
   self-check exit behavior and redaction guarantee. An operator-visible check
   name requires an action-package amendment and a sentinel-redaction test;
   errors and stacks remain forbidden.

## Diagnostic Amendment: Fixed Internal-Failure Stages

This amendment preserves the current outcome contract while making the
no-write rehearsal diagnosable without exposing exception data. It is scoped to
the action's bounded stderr and rehearsal trace; it introduces no status,
comment, configuration, permission, token, trigger, or network-write change.

1. **Additive, fixed detail.** `internal-failure` remains the exact public
   `ReviewOutcomeKind`. An internal failure carries exactly one optional
   `InternalFailureStage` selected from this closed vocabulary:

   - `snapshot` — resolving or materializing the trusted default-branch
     snapshot, including C1/C2 inputs;
   - `packet` — collecting or validating the evidence packet before research;
   - `research` — S1/S2/S3 evidence acquisition and aggregation;
   - `assessment` — M1/M2 analysis or O1 brief rendering;
   - `handoff` — constructing or recording the otherwise publication-eligible
     handoff; or
   - `unclassified` — any unexpected boundary not safely attributable to one
     of the preceding stages.

   The stage is a literal selected by trusted code. It must not be derived from
   an exception name, message, stack, response body, URL, config value, source
   content, PR input, credential, or provider output. Non-`internal-failure`
   outcomes carry no stage.

2. **Redacted reporting.** When a no-write rehearsal records an internal
   failure, its bounded stderr line includes only the literal outcome and
   stage, in the form `internal-failure at <stage>`. The trace may retain that
   same literal stage with the existing binding and operation ordering. No
   stage is sent to a status, comment, or future publisher by this amendment.
   The existing fixed startup diagnostics remain the only output for startup
   self-check failures; an uncategorized exception at that boundary maps to
   `unclassified` if it reaches the rehearsal result.
3. **Fail-closed preservation.** Mapping a stage neither converts an outcome
   to success nor makes a skipped, stale, unverified, or unowned attempt
   publication eligible. Every cleanup, cancellation, ownership, freshness,
   credential-separation, and no-live-write requirement above remains
   unchanged. Failure to classify safely uses `unclassified`; it never emits
   raw diagnostic data.
4. **Required checks.** The implementation must inject a sentinel-bearing
   failure at each classified boundary and prove the corresponding literal
   stage is reported. It must also inject an unexpected failure and prove it
   maps to `unclassified`. The action-level rehearsal test must assert its
   shipped bundle emits the exact fixed diagnostic form. All those tests must
   prove stderr and traces omit the sentinel, plus credentials, config values,
   source lines, raw exception text, response bodies, URLs, and stacks. A
   named mutation that interpolates an exception message or selects a stage
   outside this vocabulary must fail a test. Existing no-write assertions must
   continue to prove that no status, comment, App-token request, or other live
   write occurs.

### Amendment Boundaries

- **Always:** retain the exact outcome kinds and redaction guarantee, use only
  the six literal stages above, and record a stage only for
  `internal-failure`.
- **Ask first:** add or rename a stage, surface it in status or comment text,
  change A1's startup interface, alter the workflow trigger, or change an App
  permission or secret.
- **Never:** report a raw error or external payload, infer a stage from
  untrusted data, weaken fail-closed behavior, or use this diagnostic work to
  start publication or production-claim implementation.

## Diagnostic Amendment 2: Failure Cause, Progress, and Elapsed Time

**Status: draft, not approved.** This amendment is proposed for review. It
changes the approved stage vocabulary above, so per its "Ask first" boundary it
needs the maintainer's recorded approval before planning or implementation.

The first fixed-stage amendment shipped. The R1 rehearsal of PR head `657f221`
then reported `internal-failure at unclassified` after about 288 seconds, past
the 240-second evidence-read envelope. `unclassified` is the label for five
different sites (the entry and final freshness checks, a failed freshness read
before research or the model, an uncaught `evaluate()` error, an unattributed
snapshot-callback defect, and an uncaught startup error), so it cannot tell a
budget exhaustion from a defect. This amendment adds the smallest fixed detail
that distinguishes them, so one rehearsal run is enough to name the next fix.
It adds no status, comment, configuration, permission, token, trigger, or
network-write change and keeps the same redaction guarantee.

1. **`freshness` stage.** Add `freshness` to `InternalFailureStage`: failing to
   re-verify ownership or the current PR head (the entry check, the checks
   before research and before the model, and the final check). It replaces
   `unclassified` at those four sites. `unclassified` keeps its remaining
   meaning.
2. **Fixed `cause`.** An internal failure also carries exactly one optional
   `InternalFailureCause` from this closed vocabulary, chosen by trusted code
   from its own state and never from an exception name, message, stack,
   response body, URL, config value, PR input, or provider output:

   - `deadline` — the attempt clock was at or past the evidence deadline when
     the failure was recorded;
   - `aborted` — the attempt's abort signal had fired (ownership lost or a
     freshness error) before the deadline;
   - `rejected` — a boundary returned a not-ready or internal-failure result
     rather than throwing;
   - `threw` — a boundary threw and none of the above applies;
   - `ownership-read`, `run-read`, `pull-request-read`, `comparison-read`, or
     `binding` — a `freshness` failure, selected from the existing fixed
     `field` and `category` of the freshness result (`VerificationError`).

   Precedence is the freshness literal when one applies, then `deadline`, then
   `aborted`, then `rejected`, then `threw`.

3. **Progress marker.** An internal failure also carries `reached`, the last
   boundary the attempt entered, from the closed ordered set `start`,
   `snapshot`, `packet`, `research`, `assessment`, `handoff`. Trusted code
   sets it as it enters each boundary, so even an `unclassified` failure shows
   how far the attempt got. `start` is everything before the snapshot.
4. **Elapsed time.** An internal failure carries `elapsed`, whole seconds
   since the attempt started, from the injected clock and capped at the job
   budget (900). It is a bounded non-negative integer and no other number is
   reported.
5. **Redacted reporting.** The bounded stderr line extends to
   `internal-failure at <stage> (cause <cause>, reached <boundary>, after <n>s)`
   with only those fixed values, and the trace retains the same literals. The
   fields are recorded only for `internal-failure`; the existing startup
   self-check diagnostics are unchanged. An uncategorized startup exception
   reports `unclassified` with `cause threw`, `reached start`, and a computed
   `elapsed`, or omits fields it cannot set safely.
6. **Fail-closed preservation.** Every requirement of the first amendment
   holds: a stage, cause, progress marker, or elapsed value never converts an
   outcome to success or makes a skipped, stale, unverified, or unowned attempt
   publication eligible. This amendment does not change which outcome a
   deadline produces; whether a post-deadline freshness failure should end as
   incomplete evidence is a separate behavior decision that this diagnostic
   work informs but does not make.
7. **Required checks.** Tests inject a sentinel-bearing failure and prove, for
   each cause and each `reached` value, that exactly the literal is reported,
   including `freshness` at all four sites with each fixed read field. They
   also prove deadline precedence by advancing the injected clock and abort
   precedence by firing the signal, and that stderr and traces omit the
   sentinel, credentials, config values, source lines, raw exception text,
   response bodies, URLs, and stacks. Named mutations that derive a cause or
   stage from an exception name or message, report an unlisted value, report
   an uncapped or non-integer `elapsed`, or record the fields on a
   non-`internal-failure` outcome must each fail a test. The shipped-bundle
   test asserts the exact stderr form. Existing no-write assertions continue
   to prove that no status, comment, App-token request, or other live write
   occurs.

### Considered and not proposed

- **Failing collector or source** (`npm`, `actions`, `uv`) for a `packet`
  failure: useful, but an assembly throw does not identify its source without
  threading per-collector tracking through T4 assembly. Revisit if `packet`
  failures dominate.
- **Request and byte counters** from the evidence accounting: bounded and
  non-secret, but `deadline` plus `elapsed` answers the immediate question.
  Add them only if a `deadline` failure needs a budget breakdown.
- **Per-boundary durations**: derivable from successive runs of the progress
  marker plus `elapsed`; not worth a larger reported surface.

### Draft Amendment Boundaries

- **Always:** report only the closed vocabularies above and one bounded
  integer, record them only for `internal-failure`, and choose each value in
  trusted code from its own state.
- **Ask first:** add or rename a stage, cause, or progress value; report any
  other number; surface these fields in status or comment text; or change the
  workflow trigger, an App permission, or a secret.
- **Never:** report a raw error or external payload, infer a value from
  untrusted data, weaken fail-closed behavior, or use this work to change
  deadline behavior or start publication.

### Trusted config and context snapshot

Resolve repository visibility and the default-branch identity through trusted,
bounded repository reads. Resolve that branch to one full commit SHA before
reading config, tree entries, or source bytes, and pin every such read to that
SHA. Retain the repository identity and SHA as T4's `contextRevision`; neither
the event nor PR base/head is a substitute. Later default-branch movement must
not mix revisions within a snapshot.

Materialize only the bounded filesystem data needed by the existing C1/C2
contracts in an isolated temporary directory. Preserve tree entry types,
missing paths, C1's config-link containment behavior, and C2's source-symlink
rejection; never flatten a symlink into an eligible ordinary source file.
Reuse the existing validators and eligibility rules rather than duplicate
them in the API adapter. Planning must demonstrate how materialization
preserves those contracts and obtain approval for any necessary C1/C2
interface amendment before execution.

Load `.github/dependabot-review.json` through C1 with its existing byte, UTF-8,
schema, provenance, and diagnostic limits. Only confirmed absence uses missing
file defaults; permission, transport, malformed, or exhausted-budget results
remain failures. No selected provider means no model request. Invalid config
stops before evidence collectors or model calls and produces a status-only
failure handoff when fresh and owned.

Use authenticated visibility, dependency identities, and a bounded tracked-file
inventory from the same trusted revision with C2. Validate the configured
boundary and shared eligibility before acquiring source contents. Missing-file
defaults and explicit opt-out acquire no source bytes and yield C2's disabled
result; private opt-in without a nonempty exact file list fails before source
contents are read. Opt-in acquires only eligible selected files under C2's
existing limits. Incomplete inventory or failed reads cannot become an empty
successful context. Supply T4 with the authentic successful C2 result, including
disabled/unavailable/partial distinctions, and matching `contextRevision`;
never synthesize either from PR files. Only validated C2 excerpts may reach M1.

## Testing Strategy

Use source-adjacent `vite-plus/test` tests with injected clock, fetch,
context, claim store, registry adapters, model transport, and rehearsal sink.
Name tests for the requirements they exercise. For every failure scenario,
assert that diagnostics and stderr omit sentinel
credentials, config values, source lines, and raw exception text.

| Scenario                                                          | Required assertion                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Valid current head and complete mocked evidence/model             | One bounded pipeline creates an exact-bound `complete` handoff; rehearsal records success with no live request.  |
| Invalid config or empty LLM key, otherwise valid inputs           | Fresh owned failure retains its binding; rehearsal records failure only, no comment; no collector/model starts.  |
| Invalid identity, missing read token, or initial ownership denial | No publication-eligible handoff or App-token fallback; no collector/model/comment starts or sentinel leaks.      |
| Trusted config absent versus failed read                          | Confirmed absence alone uses C1 defaults; failed reads yield status-only failure, never defaults or model calls. |
| Source-context opt-out                                            | C2 returns disabled; no source bytes are acquired and the actual model request contains no source excerpts.      |
| Valid source-context opt-in                                       | Actual C1/C2 feed T4/M1; config, inventory, source facts, and contextRevision share one pinned trusted revision. |
| Invalid private opt-in or ineligible source paths                 | C2 rules prevent source-content reads; no PR source or flattened symlink can supply a context fact.              |
| Trusted snapshot moves, fails, or exceeds bounds                  | No mixed revisions, empty-success fallback, or usable partial failure; temporary files are removed on all exits. |
| Unusable analysis input or renderer failure                       | Fresh owned failure remains status-only; rehearsal records failure and preserves the prior comment.              |
| Required evidence partial/unavailable                             | No success; reasons and coverage reach the incomplete handoff.                                                   |
| Model failure, timeout, or cancellation                           | No success; raw model response/error cannot reach diagnostics.                                                   |
| Stale before or after collection                                  | No publication-eligible result; sessions close and late results cannot revive it.                                |
| Duplicate, simultaneous, replacement, abandoned claims            | One owner advances; replaced owner sees `lost`; recovery needs a new eligible attempt.                           |
| Path/credential probes                                            | Fixed-origin encoded targets; every dependency sees only its assigned capability.                                |

The suite must reject the former startup stub, a mutation that omits ownership
rechecks, a mutation that maps unavailable evidence to empty, a mutation that
drops bound failures instead of handing off a failure status, and a mutation
that substitutes PR-head config or source for the trusted snapshot. A
fresh-context reviewer must assess these behavior checks before M/L execution.

## Boundaries

- **Always:** Verify trusted repository/workflow identity and current head; use
  bounded fixed-origin reads; preserve coverage/reasons; close sessions; keep
  capabilities separate; record exact verification in the future issue or PR.
- **Ask first:** Select/configure production claim storage; add a secret, App
  permission, or service; amend C1/C2/T1/T2/T3/D1/M1/M2/O1; enable live publication;
  change workflow shape; or alter a reader failure reason.
- **Never:** Execute/checkout PR code; read artifacts/caches; trust event
  identity; use a moving ref; treat failure as empty evidence; pass App token to
  collectors/model; expose raw credential/payload; or present rehearsal as live.

## Success Criteria

1. A fail-closed action path runs from declared inputs through current T1
   binding, trusted C1/C2 snapshot, and bounded D1/collector/analysis/rendering
   handoffs to a redacted publication handoff. Bound failures remain eligible
   for failure-status-only publication without a replacement comment.
2. Current success, invalid config, incomplete evidence, model failure, stale
   and duplicate events, and claim replacement each have deterministic outcomes
   with no unauthorized side effect.
3. Tests prove fixed-origin encoding, cleanup, credential separation, and
   atomic test-store ownership.
4. One controlled no-write rehearsal records intended operations without a live
   status/comment write or production claim backend.
5. The Commands sequence plus `git diff --check` passes on the exact
   implementation revision; exact results belong in its issue or PR.

## Open Questions

1. `review-publication` must select the production claim backend, trusted
   provenance, retention, and consumer configuration before live writes.
2. Planning must verify called-workflow repository context and GitHub's
   workflow REST selector behavior from official documentation.
