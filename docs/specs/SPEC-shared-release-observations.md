# Spec: Shared PyPI Release Observations

Status: approved for planning, 2026-11-09. Supporting contract for
`shared-review`, scoped to
[issue #209](https://github.com/andrewpucci/dependency-update-advisor/issues/209).
It implements the approved `shared-release-observations` row in the
[W2 map](SPEC-review-orchestration.md#assumptions-and-decisions).
Specification approval: the user reviewed the saved draft and invoked
`as-plan` on 2026-11-09. Plan and execution approval: the user approved the
ordered #260–#264 handoff and invoked `as-build auto` on 2026-11-09. This
authorizes the tasks in dependency order, their verification checkpoints, and
one closing PR; merge, publication, adoption, parity, and cutover remain
separate gates.

Confirmed scope decision, 2026-11-09: an orchestrator-owned release-observation
cache is charged to the existing **Signals: PyPI metadata** allocation (16
requests and 0.5 MiB). S2 consumes the validated result without spending the
upstream-evidence allocation. This preserves the approved W2 total envelope;
it does not create a budget that either stage may borrow.

## Objective and Scope

Within one review attempt, make one exact public PyPI release JSON observation
serve S2 upstream research and S3 policy signals for every matching uv member
side. The observation retains only bounded validated data both consumers need,
including `info` and exact-release file records, so S3 can derive publication
time, yank state, licence, and scoped provenance candidates without repeating
S2's network request.

The users are review maintainers and maintainers reading bounded evidence.
Success removes the duplicate release request while preserving S2's public
identity proof and S3's per-member policy facts and failure diagnostics. S1
advisory queries, npm, Actions, PyPI provenance sub-resource reads, packet
validation, model analysis, rendering, publication, adoption, parity, and
cutover remain outside this contract. The old reviewer stays active.

## Inputs, Ownership, and Handoff

1. W2 creates one observation session after validating the review binding and
   before it invokes S2/S3. The session accepts only an exact uv name, version,
   and immutable registry identity that both existing readers accept:
   `https://pypi.org/simple` or its trailing-slash form. It locally constructs
   `https://pypi.org/pypi/{name}/{version}/json`; it sends no credentials,
   follows no redirect, and never turns a custom/private registry into a public
   lookup.
2. The session owns the 16-request, 0.5-MiB W2 share and receives the review
   deadline/cancellation capability. Every cached use is free to S2's upstream
   allocation. It enforces per-response, total-response, JSON depth/entry/work,
   retained-data, request-timeout, and review-deadline bounds. Planning selects
   exact limits from the existing bounded-reader vocabulary; it may not add
   unbudgeted retention or increase W2's total envelope.
3. The cache key is the canonical validated endpoint URL. It is attempt-local,
   immutable to consumers, and ends with the review session. Distinct uv
   variants retain independent packet attribution even when sharing one
   observation. A result for one name/version/registry never serves another.
4. The retained observation is a bounded deep copy of only fields needed by
   both contracts: exact identity/version, source/project URLs used by S2, and
   structured release metadata plus complete `urls` file entries used by S3.
   It retains no raw HTTP body, headers, credentials, arbitrary description, or
   mutable objects. Planning must name the projection and prove existing S2/S3
   facts remain derivable before replacing either reader call.
5. Validate returned `info.name` against normalized requested name and
   `info.version` against the exact version before sharing success. Malformed
   JSON, unsupported content type/redirect, identity conflict, an over-limit
   body, stalled request, and invalid retained data are unavailable with current
   fixed reasons. A 404 remains `missing`; rate limiting blocks later PyPI
   session reads; permission and other HTTP outcomes retain their meanings.
6. Cache completed success and completed fixed-reason failure for the exact
   key. In-flight duplicates coalesce and all waiters see the same immutable
   tagged result. Cancellation/close aborts work, releases bodies, clears data,
   and prevents late results repopulating the cache. An exhausted session does
   not manufacture a second attempt in S2 or S3.
7. S2 receives a validated observation adapter, not a general cache or fetch
   capability. It still creates its upstream source attribution and documented
   member outcome. S3 receives the adapter only for exact PyPI release metadata;
   it still creates policy sources, side outcomes, and provenance-file reads.
   Neither consumer can mutate, retain after close, or reinterpret another
   consumer's budget charge.
8. An unavailable shared observation reaches each applicable consumer through
   its existing outcome path. It never becomes empty successful release data, a
   completed required-malware check, or a reason to erase an independent
   finding. S2/S3 may derive different facts but agree on common identity and
   availability.

## Commands

```sh
npm ci
npm test -- --run src/evidence/upstream-read.test.ts src/evidence/policy-signals-pypi.test.ts
npm test -- --run src/review.test.ts
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run build
git diff --check
```

The focused names are implementation-plan targets; exact new filenames follow
the selected W2 seam. The full sequence runs on the implementation revision,
not as evidence this draft is approved.

## Project Structure

```text
src/review.ts                       -> W2 composition; creates/closes the session
src/evidence/shared-pypi-release.ts -> bounded observation session (new; name planned)
src/evidence/upstream-read.ts        -> S2 adapter consumer; no PyPI transport ownership
src/evidence/policy-signals-read.ts  -> S3 adapter consumer; no duplicate release transport
src/evidence/upstream.ts             -> S2 attribution from shared observation
src/evidence/policy-signals-*.ts     -> S3 facts and provenance sub-resource reads
src/review.test.ts                   -> cross-stage/request-count tests
src/evidence/*.test.ts               -> reader-outcome preservation tests
```

The plan may choose a different filename only if it retains this ownership
boundary and updates this section before implementation.

## Code Style

Use strict TypeScript, injected narrow capabilities, immutable tagged results,
and fixed evidence reasons. The session owns transport and budget accounting;
the consumers own evidence attribution.

```ts
const observed = await releases.read(exactUvTarget);
if (observed.kind !== 'available') return unavailableUpstream(observed.reason);
return toUpstreamProof(observed.release, member, side);
```

No consumer receives `process.env`, a credential, a general fetch function, or
the mutable internal map. Do not log response bodies, package metadata, or
endpoint diagnostics.

## Testing Strategy and Success Criteria

1. An integration test invokes S2 then S3, and the reverse, for at least two uv
   sides sharing an exact target. It counts one endpoint request across both
   stages, preserves distinct member/side attribution, and proves credential-
   free manual-redirect transport.
2. Tests prove cache-key isolation for changed version/name/registry, identity
   validation, 404, rate limit, permission, redirect, malformed content,
   byte/work/retention budget, timeout, close, and ignored-abort transport. No
   post-close or late result is exposed.
3. Existing S2 exact-PyPI identity/source tests and S3 publication, yanking,
   licence, and provenance-fact tests pass unchanged. New tests cover any
   previously untested outcome path.
4. W2 allocation tests prove release observation charges Signals: PyPI metadata,
   leaves S2 upstream allocation unchanged for cache hits, and cannot exceed
   the approved 944-request/54-MiB envelope.
5. The full verification sequence succeeds. Review, publication, adoption,
   parity, and cutover remain separate gates.

## Boundaries

- Always: preserve exact-target validation, immutable attribution, bounded
  cleanup, fixed failure reasons, and per-stage outcome semantics.
- Ask first: changing W2's envelope/allocation, adding a dependency, expanding
  retained fields, changing packet schema, or reusing data across attempts.
- Never: query a private/custom registry through PyPI, forward credentials,
  share raw responses, treat unavailable data as negative, or let S2/S3 borrow
  each other's allocation.

## Open Questions

None for the draft. Planning selects the narrowest existing bounded-reader
limit shape and field projection that satisfy unchanged S2/S3 tests.
