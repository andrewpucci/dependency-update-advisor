# Spec: D1 Immutable GitHub Evidence Reads

Status: approved for execution, 2026-10-24. Supporting contract for `shared-review`
in [the capability map](README.md), scoped to
[issue #13: D1](https://github.com/andrewpucci/dependency-update-advisor/issues/13).
Approval: the user invoked `as-plan` on 2026-10-24 after reviewing the draft.
This approves the D1 contract for planning. The user approved the revised
seven-task plan on 2026-10-24, with #107 preceding #101–#106. The user
authorized execution via `as-build auto` on 2026-10-24,
with every plan step delivered in one PR.
Revised 2026-10-24 and approved for planning by the user's `as-plan`
invocation that day: base identity now comes from the
[T1 base-identity amendment](SPEC-event-verification.md#base-identity-amendment),
which D1 depends on. Identity items 1, 2, and 5 and the identity fixtures changed.

## Objective

Give npm, Actions, and uv collectors bounded, revision-attributable GitHub
inputs without executing PR code. Read the full paginated changed-file list,
resolve requested files at exact base/head commit SHAs, and retain dependency
comparison availability separately. Missing evidence must stay visible rather
than becoming an empty inventory or a claim of zero vulnerabilities.

The [shared workflow contract](SPEC-shared-review.md),
[immutable-inventory decision](../adr/0003-immutable-files-for-dependency-inventory.md),
[T1 binding](SPEC-event-verification.md), and
[T4 packet contract](SPEC-review-packet.md) remain authoritative. D1 supplies
read evidence; ecosystem collectors own root selection, parsing, applicability,
reconciliation, and packet construction. D1 cannot declare an ecosystem
complete or `not_applicable` merely because its HTTP calls succeeded.

## Scope and Decisions

- One supporting capability within `shared-review`; the approved module map
  and dependency direction remain unchanged. T1 #8 and T4 #11 are implemented.
- User-selected on 2026-10-24: require explicit request, byte, and time budgets
  from trusted orchestration. D1 supplies no implicit unlimited mode or new
  fixed performance thresholds. T4's approved packet ceilings still apply.
- Include PR metadata needed to bind reads, paginated changed files, immutable
  file bytes, and dependency-comparison response data. Exclude upstream release,
  advisory, malware, package-registry, and model calls.
- Exclude credentials, live workflows, publication, replay claims, trusted
  default-branch C2 source context, consumer adoption, and cutover. Read success
  confers neither T1 freshness nor T2/T3 write authority.
- User-selected on 2026-10-24: report incomplete discovery when the PR base
  differs from the merge base. Do not add immutable tree comparison recovery
  in v1 or change T4's authenticated PR-base identity.
- Proposed: no automatic retries, alternate credentials, or full-tree inventory
  fallback in D1 v1. Preserve bounded evidence already read after a later failure.

## Read Contract

### Identity and mutable PR metadata

1. Accept a runtime-validated T1 `ReviewBinding`, trusted budgets, and a
   read-only transport. Reuse T1 validation rather than accepting a TypeScript
   cast as proof of identity. The binding's `repository`, `baseRef`,
   `baseSha`, and `mergeBaseSha` are the authenticated base identity; D1
   accepts no separate base input.
2. Fetch PR metadata by the binding's repository and PR number before file
   pagination. Confirm repository IDs/names, PR number, open/unmerged state,
   Dependabot author, head repository, head SHA, and base ref. Re-read after
   pagination and before releasing its usable result. Classify each read with
   T1's base-identity freshness table. A head change, closure, retarget, or
   changed merge base makes this attempt obsolete. A moved `base.sha` with an
   unchanged merge base does not, because the three-dot diff is unchanged.
   Only an observed `base.sha` move triggers a commit comparison, counted in
   this session's budgets. Never combine pages or evidence from different
   snapshots or silently retarget a run.
3. Validate full 40-character hexadecimal commit/object SHAs and normalize
   their case consistently with T1. Reject branch/tag names, abbreviated SHAs,
   merge refs, missing IDs, and conflicting identities before dependent reads.
   Preserve base repository and head repository separately, including forks.
4. GitHub's PR file endpoint takes a PR number, not an immutable SHA. Before/
   after checks detect observed movement; they do not create an atomic snapshot
   or prove an undetected move away and back did not occur. Document this API
   limitation and keep W2's fresh binding and ownership checks before writes.
5. T4's `baseSha` remains the authenticated PR-base snapshot, now the
   binding's `baseSha`. GitHub documents
   [three-dot PR diffs](https://docs.github.com/en/pull-requests/reference/branches#three-dot-and-two-dot-git-diff-comparisons)
   and [merge-base dependency comparisons](https://docs.github.com/en/rest/dependency-graph/dependency-review#get-a-diff-of-the-dependencies-between-commits).
   Do not silently substitute a merge-base SHA for T4's base identity.
   User-selected conservative v1 behavior: if the binding's `mergeBaseSha`
   differs from its `baseSha`, retain readable files but mark changed-file
   discovery incomplete. T1 already established the merge base, so D1 makes
   no initial ancestry read. Do not claim absence from that discovery. Do not
   use a commit comparison's bounded file array as a replacement inventory.
   Full immutable tree comparison is a separate scope choice; PR pagination
   does not prove a two-tip diff.

### Paginated changed files

1. Use `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`, with explicit
   `per_page=100` and consecutive pages starting at 1. GitHub documents the
   [100-entry page maximum and 3,000-file endpoint cap](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files).
   Continue through a full page; require a terminal short/empty page consistent
   with pagination metadata and the PR's `changed_files` count. Validate that
   count as a nonnegative safe integer and compare it before/after collection.
2. Reaching 3,000 files is incomplete even if no next page is advertised.
   Caller page/file budgets, a missing page, duplicate/conflicting paths,
   malformed rows, inconsistent counts, an unexpected empty page, or a looping
   or contradictory next-page link cannot yield a completed discovery result.
   Do not deduplicate a broken listing and then claim complete coverage.
3. Retain canonical current path, nullable previous path, GitHub change status,
   and available object identity. Support additions, removals, modifications,
   and renames. Preserve other documented statuses as uncertain when their
   side semantics cannot be established. Renames retain both paths so a
   collector sees moves into or out of an ecosystem or nested root.
4. Do not use `patch`, `raw_url`, `blob_url`, or `contents_url` as authoritative
   file content or network destinations. Missing/truncated patches are harmless
   only when complete immutable blobs provide the required evidence. Otherwise
   report the missing input. A row's object SHA is not both revisions' blob SHA.
5. Return validated rows already obtained with an explicit partial/unavailable
   discovery state on failure. An unread suffix can hide any ecosystem: no
   collector may use it to assert an absent ecosystem, even when another
   ecosystem's known files were readable.

### Immutable file reads

1. Collectors request canonical repository-relative paths for the appropriate
   base/head repository and commit from the validated snapshot. Allow companion
   inputs not themselves changed, such as a manifest alongside a changed lock.
   A rename uses the previous path on the base side and current path on the
   head side; an addition/removal does not authorize guessing the missing side.
2. Reject absolute paths, traversal segments, empty segments, backslashes,
   control characters, and paths exceeding T4's 1,024 UTF-8-byte identity bound.
   Encode literal path segments when constructing fixed-origin API requests;
   reject URL-shaped targets and never interpret percent escapes as traversal.
   Hidden paths such as `.github/workflows/example.yml` remain supported.
3. Resolve the path through the exact commit's Git tree to a regular blob,
   retaining commit SHA, canonical path, and resolved blob SHA. Bounded tree
   traversal may resolve a requested path; it is not a full-tree diff fallback.
   Validate object identity, type, mode, and any
   [tree truncation flag](https://docs.github.com/en/rest/git/trees#get-a-tree).
   Symlinks, submodules, directories requested as files, and unknown modes are
   unsupported evidence. Never follow their targets or execute their content.
4. Read the resolved full blob SHA using the
   [Git blob API](https://docs.github.com/en/rest/git/blobs#get-a-blob).
   Validate response identity, supported encoding, declared size, and actual
   decoded byte length before exposing bytes. Reject malformed Base64, size
   contradictions, byte overflow, and incomplete transfers. Return complete
   bytes or a failed file read; never return a sliced lockfile as readable.
   A legitimate zero-byte regular blob is available and distinct from failure.
5. Report confirmed absence only when a complete immutable tree lookup proves
   no entry at the requested path. A generic 404, failed tree read, forbidden
   lookup, or empty response body does not prove a dependency addition/removal.
   Missing required companion files remain collector coverage gaps even when
   absence is established. Collectors decide whether a genuinely absent side
   is valid for a particular change.
6. Return detached evidence keyed by repository, commit, path, and blob SHA.
   Any within-session reuse must include full repository/revision identity;
   never cache by path alone or reuse partial bytes as a successful file.
   File bytes are untrusted collector inputs and are not provider-ready content.

### Dependency comparison and failure states

1. Request `GET /repos/{owner}/{repo}/dependency-graph/compare/{base}...{head}`
   with the exact full commit SHAs. Retain requested endpoint identities and
   merge-base scope separately. Its result corroborates immutable inventory;
   neither an empty successful response nor omitted entries establish zero
   changes or zero vulnerabilities.
2. Return bounded validated JSON records and explicit availability. D1 validates
   transport, response shape, and bounds; collectors validate package/version,
   manifest, and advisory applicability before building T4 sources. Preserve
   a validated record prefix as `partial` when a later record is malformed or
   an entry ceiling is reached; broken JSON is `unavailable`. A complete
   HTTP response is not a completeness claim for the dependency graph.
3. Distinguish endpoint/permission 403 from rate-limit 403/429 using validated
   response headers and GitHub's documented response context. GitHub documents
   [feature/fork comparison 403s](https://docs.github.com/en/rest/dependency-graph/dependency-review#get-a-diff-of-the-dependencies-between-commits)
   and [primary/secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit).
   Do not classify every 403 as rate limiting or invent a permission diagnosis
   from arbitrary error text. Ambiguous failures remain `unknown`.
4. Normalize coverage reasons to T4's fixed vocabulary: `permission`,
   `rate_limit`, `timeout`, `missing`, `malformed`, `unsupported`, `truncated`,
   `budget`, `conflict`, and `unknown`. Attribute each failure to the operation,
   repository/revision, and path or requested comparison where applicable.
   Diagnostics contain no raw response body, PR text, exception, or credentials.
5. A comparison failure remains an explicit comparison coverage limit. It
   neither erases file-derived changes nor automatically makes a successfully
   established file inventory incomplete. Required vulnerability/upstream
   coverage remains the collectors' responsibility, including their fallbacks.
   Keep discovery failure, file failure, and corroboration failure distinct.

### Budgets and transport

1. Require finite validated positive safe-integer limits for total requests,
   list pages/entries, JSON collection entries, per-response bytes, per-file
   decoded bytes, total read bytes, per-request duration, and total duration.
   Validate cross-field consistency and reject missing/invalid limits before
   dispatch. Durations are milliseconds; bytes are byte counts, not code units.
   Budgets are supplied by trusted code, never PR content or model output.
   Require a separate `maxRetainedBytes` for cumulative result bytes. Count
   serialized JSON metadata as UTF-8 and file contents as decoded bytes;
   returning another result consumes this budget again, even without caching.
2. Share accounting across metadata, ancestry, pages, path resolution, blobs,
   and comparison within one bound review session. Collectors cannot reset
   the budget by asking for another file. Bound in-memory retained results as
   well as transferred bytes. Downstream T4 limits do not bound network reads.
3. Check limits before dispatch and during response consumption, including
   decompressed bytes and decoded content. Abort on the first overrun and
   cancel underlying work at a deadline. A timeout race that leaves an active
   transfer running does not satisfy this contract. Include all requests and
   failed/aborted body bytes in accounting; budget exhaustion cannot disappear.
4. Use sequential dispatch for v1. D1 makes no internal retries or sleeps;
   a rate limit or timeout is returned promptly. Any future retry policy must
   remain inside the same request, byte, and time accounting.
5. Build only fixed-origin GitHub API GET requests from validated identities.
   Use a read-only credential supplied through trusted transport; never pass
   the publication App token to collectors. Disable automatic redirects and
   never follow response URLs or pagination URLs as arbitrary destinations.
   Validate pagination hints against the expected endpoint and next page.
   Do not create public/download-URL fallbacks or add token permissions.

## Outputs and Integration

The planned interface separates discovery, individual immutable file reads,
and comparison results within one budgeted session. Exact exported names are
chosen during planning; the observable result distinctions are required:

| Result                                   | Required meaning                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Invalid input                            | Fixed validation failure; no dependent request dispatched.                      |
| Obsolete/conflicting identity            | No usable discovery for the attempt; never relabel evidence.                    |
| Discovery available/partial/unavailable  | Snapshot identity, known file rows, fixed reasons, explicit completeness.       |
| File available/absent/unavailable        | Full immutable provenance and complete bytes, proven absence, or fixed reasons. |
| Comparison available/partial/unavailable | Exact requested revisions, bounded records, independent limits.                 |

Return detached readonly values without shared state across reviews. Keep
the bounded session's accounting state internal across its read operations.
No raw HTTP result escapes as a
validated inventory. Collectors map these results to T4 sources and per-ecosystem
coverage, retaining known changes when reads fail. T4 validation, M2/O1, and
W2/T2/T3 integration remain separate gates.

## Tech Stack, Project Structure, and Style

Use the existing Node.js 24 ESM, strict TypeScript, and Vite+ test stack.
No new runtime dependency is selected. Inject a bounded streaming read
transport and clock/cancellation boundary so tests need no live GitHub calls.

```text
src/github-read.ts       → proposed D1 validation, read session, evidence results
src/github-read.test.ts  → proposed mocked transport and boundary fixtures
src/event.ts             → existing T1 binding validation; preserve its contract
src/schema.ts            → existing T4 identity/reason vocabulary and packet gate
src/evidence/            → future ecosystem parsing and reconciliation owners
```

Use `unknown` at external boundaries, named discriminated unions, single
quotes, explicit units, and small validators consistent with adjacent modules.
Illustrative result style, not a promised exported API:

```ts
type FileFailure = Readonly<{
  kind: 'unavailable';
  reason: 'permission' | 'rate_limit' | 'timeout' | 'budget' | 'unknown';
}>;
```

## Commands and Testing Strategy

For documentation-only changes:

```sh
npm run lint:md
npm run format:check
git diff --check
```

After D1 implementation, use the repository's installed tooling:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

No build command exists yet; action packaging remains A1. Record the exact
shared revision, working-tree edits, environment, commands, outcomes, and
unrun checks in the relevant issue or PR. Separate CI merge SHA from PR head.
Unit fixtures do not certify transport credentials, live permissions, collector
fidelity, workflow publication, consumer adoption, or parity/cutover.

Use synthetic table-driven fixtures and streaming transport stubs in
`src/github-read.test.ts`. Assert requested repository/path/SHA, dispatch
count, cancellation, detached outputs, and retained failure provenance.

| Fixture                                                                | Required result                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Multiple pages; exactly 100 rows; zero files                           | Fetch terminal page as needed; reconcile counts; empty success requires completed discovery. |
| Exactly 3,000 files; missing/duplicate page; loop; count mismatch      | Explicit incomplete discovery; no absent-ecosystem proof.                                    |
| Head move, retarget, closure, wrong repo/author, invalid binding       | Obsolete/conflicting result; no mixing or retargeting.                                       |
| Base SHA moves mid-collection: same or changed merge base; read fails  | Same: collection continues. Changed: obsolete. Failed comparison: explicit unavailable.      |
| Binding merge base differs from binding base                           | Incomplete discovery under the user-selected conservative v1 rule; no ancestry read.         |
| Add/remove/rename across roots or ecosystems; unchanged companion      | Both paths and correct immutable side/repository preserved.                                  |
| Same path at different SHAs/repos; conflicting blob ID or size         | Separate provenance; reject contradictions and invalid reuse.                                |
| Zero-byte blob; confirmed absent path; generic 404                     | Available empty bytes, affirmative absence, and failed lookup remain distinct.               |
| Malformed Base64; truncated tree/body; symlink/submodule; unknown mode | No usable partial file or target-following; explicit limits.                                 |
| Empty/omitted comparison; feature 403; primary/secondary rate limit    | Known file evidence retained; independent comparison reasons; no safety inference.           |
| Each supplied count/byte/time bound, exact boundary and one beyond     | Accept complete in-budget evidence; abort overflow with fixed reasons.                       |
| Multibyte bytes; chunked/oversized body; ignored abort; reused session | Correct accounting and cancellation; no budget reset or late success.                        |
| Malicious URL/path/link/error text; mixed npm/Actions/uv               | Fixed-origin reads and safe diagnostics; gaps retain their affected scope.                   |

## Boundaries and Success Criteria

- **Always:** Preserve full immutable identities, paginate, enforce supplied
  budgets, validate external input, distinguish absence from failure, retain
  independent coverage limits, and keep private consumer details local.
- **Ask first:** Change T4 base/coverage semantics, add credentials/permissions,
  add a dependency, implement a tree-diff recovery strategy, or expand beyond
  consumer GitHub evidence reads.
- **Never:** Execute PR code, check out the PR, run dependency installation on
  PR inputs, follow untrusted URLs, log source bytes/raw payloads/secrets,
  silently truncate inventory, or infer zero changes from unavailable evidence.

D1 is complete when mocked tests establish paginated discovery, full-SHA
base/head file reads, immutable provenance, enforced caller budgets, and
honest coverage for caps, truncation, 403s, rate limits, and revision conflicts;
the four implementation checks pass on one exact shared revision; and the
collector/transport/publication integration gates remain explicit.

## Open Questions

No unresolved product choice remains for D1 planning. Numeric orchestration
budgets are not selected here and must be supplied by trusted integration code
before live execution; this is a W1/W2 integration gate. The approved plan
places #107 before #101–#106 under parent #13. Its pre-#101/#104 clarifications
remain recorded in the plan; execution has not started.
