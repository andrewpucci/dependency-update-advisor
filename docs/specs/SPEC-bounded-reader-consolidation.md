# Spec: Bounded Reader Consolidation

Status: approved for planning, 2026-11-09. Supporting contract for
`shared-review`, scoped to
[issue #209](https://github.com/andrewpucci/dependency-update-advisor/issues/209).
It implements the approved `bounded-reader-consolidation` row in the
[W2 map](SPEC-review-orchestration.md#assumptions-and-decisions).
Specification approval: the user reviewed the saved draft and invoked
`as-plan` on 2026-11-09. Plan and execution approval: the user approved the
ordered #260–#264 handoff and invoked `as-build auto` on 2026-11-09. This
authorizes the tasks in dependency order, their verification checkpoints, and
one closing PR; merge, publication, adoption, parity, and cutover remain
separate gates.

## Objective and Scope

Move eligible duplicated request plumbing in the S2 upstream reader, npm
registry reader, and S1/S3 advisory reader onto `bounded-request.ts`, while
preserving each reader's documented public outcomes exactly. This is a
behavior-preserving consolidation: no request route, credential rule, response
interpretation, cache scope, budget, packet shape, or evidence decision changes
because a reader adopts the helper.

The users are evidence-reader maintainers, who need one well-tested primitive
for request abort/timeout races and shared deadlines without flattening the
readers' distinct contracts. Existing `npm-publish-times.ts` and
`policy-signals-read.ts` use the helper as its baseline. Scope excludes shared
PyPI observations, network sources, dependencies, budget changes, packet schema
or policy changes, workflow integration, publication, adoption, parity, and
cutover. The old reviewer stays active.

## Reader Contracts to Preserve

| Reader             | Candidate shared responsibility                                     | Reader-owned behavior that must remain unchanged                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream-read.ts` | credential-free GET, abort/timeout race, body release, shared clock | nested npm reads, `truncated` body outcome, attempt-local success/failure cache, sticky budget/timeout stop, origin-specific rate-limit block, GitHub classification and pagination |
| `npm-registry.ts`  | credential-free GET, abort/timeout race, body release, shared clock | integrity binding, per-read oversized-response isolation, exact failure reuse, cache identity, document validation, lifecycle interpretation                                        |
| `advisory-read.ts` | credential-free GET, abort/timeout race, body release, shared clock | GitHub accept/version headers, continuation validation, positive-prefix partial output, rate-limit stop, record normalization and severity semantics                                |

Planning must examine each reader against this table before editing it. A reader
may retain local transport only when a focused preservation test demonstrates a
semantic mismatch the helper cannot support without weakening another contract.
The plan and code must record that exact reason and test; it cannot be an
untracked future cleanup.

## Commands

```sh
npm ci
npm test -- --run src/evidence/bounded-request.test.ts src/evidence/upstream-read.test.ts src/evidence/npm-registry.test.ts src/evidence/advisory-read.test.ts
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run build
git diff --check
```

Run the focused suite before and after each migration. The full sequence runs
on the implementation revision; it neither authorizes a behavior change nor
makes this draft an approved plan.

## Project Structure

```text
src/evidence/bounded-request.ts      -> shared clock and bounded request primitive
src/evidence/bounded-request.test.ts -> helper contract and cancellation tests
src/evidence/upstream-read.ts        -> S2-specific bounded reader adapter
src/evidence/upstream-read.test.ts   -> S2 outcome regression suite
src/evidence/npm-registry.ts         -> npm-specific bounded reader adapter
src/evidence/npm-registry.test.ts    -> npm outcome regression suite
src/evidence/advisory-read.ts         -> S1/S3-specific bounded reader adapter
src/evidence/advisory-read.test.ts    -> advisory outcome regression suite
```

Do not move domain parsing, cache policy, response classification, or evidence
normalization into the helper merely to reduce lines of code.

## Code Style

Use strict TypeScript and a narrow request primitive. The helper returns raw
bounded transport control; each reader owns its domain reason mapping, response
handling, and public tagged result.

```ts
const response = await boundedGet(deps, request, setActiveCancel, async (raw, aborted) =>
  readNpmBody(raw, aborted),
);
return validateExactRegistryDocument(response, target);
```

Keep fixed headers and URL construction visible at the reader call site. Do not
give the helper a general error mapper, mutable global state, or access to a
reader's cache/budget counters.

## Requirements

1. The helper continues credential-free `GET` requests with manual redirects,
   races request timeout, caller cancellation, reader `close()`, and ignored-
   abort transports, aborts on every exit, removes listeners/timers, and
   releases unread bodies. It supports existing public request headers without
   allowing callers to override method, credentials, or redirect behavior.
2. Every migrated reader supplies its shared-deadline calculation. Its request
   count, response/total bytes, JSON work, retained-data budget, pages,
   attempts, and cache accounting remain in that reader. Migration cannot make
   an formerly attempt-local oversized response globally sticky, nor a formerly
   sticky stop recoverable.
3. `upstream-read.ts` preserves nested npm delegation; exact public PyPI and
   GitHub validation; 403 distinction; `rate_limit` origin blocking; sticky
   `budget`/`timeout`; failure-cache retention; and `truncated` after retained
   body bytes. Its `close()` clears attempt-local maps and stops further work.
4. `npm-registry.ts` preserves integrity-bound cache entries, rejection of
   custom/private sources and unbound artifacts, exact document validation,
   per-read body-limit outcomes, failure reuse, and lifecycle evidence semantics.
   Its public failure result keeps the same tagged shape.
5. `advisory-read.ts` preserves GitHub media/API-version headers, singleton
   query construction, continuation validation, `maxPages`/retained finding
   accounting, partial output after validated positive prefix, rate-limit stop,
   withdrawal behavior, and severity normalization. The helper cannot collapse
   partial results into unavailable ones.
6. For each migration, existing failure-reason tests pass unchanged. Before the
   migration add a targeted check for every listed semantic path not already
   covered. The check rejects a named plausible regression, such as removing
   origin blocking, returning empty data on timeout, dropping a positive prefix,
   or retaining an oversized npm response.
7. If a reader cannot migrate, leave it unchanged and add a concise documented
   exception beside this table or in module documentation naming incompatible
   semantics and their preserving test. Do not declare success merely because
   no code changed.

## Testing Strategy and Success Criteria

1. Existing helper tests continue proving cancellation/timeout cleanup; extend
   only for neutral primitive behavior shared by all callers.
2. A focused regression suite preserves every migrated reader's result shape
   and failure tag for invalid input, redirect, rate limit, permission, timeout,
   cancellation, byte exhaustion, malformed body, and repeat reads where they
   apply.
3. Reader tests cover upstream truncation/origin blocking, npm per-read limit
   isolation/integrity, and advisory partial-prefix/pagination. At least one
   named mutation per previously uncovered path fails its new check.
4. Typecheck, lint, formatting, complete tests, action build, and `git diff
   --check` pass. Review verifies no reader gained transport authority or
   changed a documented evidence outcome.

## Boundaries

- Always: preserve reader outcome algebra, budgets, headers, routes, cleanup,
  and unchanged regression tests.
- Ask first: changing helper public behavior, a reader's limits/failure
  taxonomy, dependencies, cache scope, or packet/policy semantics.
- Never: replace unavailable/partial evidence with empty success, weaken
  URL/credential checks, discard an advisory positive prefix, or remove a
  failing-path test to make consolidation pass.

## Open Questions

None for the draft. Planning determines reader-by-reader whether the helper
preserves these contracts directly; exceptions require evidence before
implementation approval.
