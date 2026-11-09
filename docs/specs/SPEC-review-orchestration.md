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
3. **Credential separation.** `github-token` performs GitHub reads;
   `app-token` is reserved for later publication. Collectors, source context,
   public registries, and M1/M2 never receive the App token; collectors and
   GitHub transport never receive the LLM key. Registry requests omit
   credentials and reject cross-origin continuation.
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
   comment-ready body. Only a complete result is eligible for eventual
   success, after publication confirms the current-head comment was recorded.
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
2. Planning must reconcile W2 transport limits with every existing reader and
   M2's 600,000 ms analysis ceiling plus 60,000 ms publication reserve; no
   numeric W2 limits are approved here.
3. Planning must verify called-workflow repository context and GitHub's
   workflow REST selector behavior from official documentation.
