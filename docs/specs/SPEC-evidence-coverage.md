# Spec: Evidence Coverage and Scaled Read Budgets

**Status: approved for planning, 2026-11-16.** The user explicitly approved
the reviewed draft (merged in PR #351) after a fresh-context review whose
blocking findings were resolved. Plan and execution approval remain separate
gates. Cross-cutting supporting contract for
`shared-review` in [the capability map](README.md). Scoped to
[#350](https://github.com/andrewpucci/dependency-update-advisor/issues/350)
under [#342](https://github.com/andrewpucci/dependency-update-advisor/issues/342).
Effort tier: L. It amends the
[W2 execution envelope](SPEC-review-orchestration.md), the per-collection
cache scope in [S1 advisory lookup](SPEC-advisory-lookup.md), and the
stage-failure behavior of [S3 policy signals](SPEC-policy-signals.md) and of
research orchestration. It brings the code into line with retention rules
that S1 and [S2 upstream evidence](SPEC-upstream-evidence.md) already state.
It adds repository tooling for measuring read demand. It does not change any
evidence attribution rule, add a host, authorize publication, or authorize a
live rerun.

## Objective

A maintainer reading a review of an ordinary Dependabot PR should see whether
each package was checked for advisories, malware, install scripts, and
upstream changes. When a check finds something, it is a prominent flag. When a
check ran and found nothing, that is the normal case and takes one line. When
a check could not run, the review says why, says whether rerunning CI will
help, and withholds a merge recommendation as it does today.

Today a single direct update can stop every research stage early and discard
its completed work. The review then reports almost nothing as checked and
tells the reader to rerun CI for a failure that will repeat.

## Evidence

The R1 no-write rehearsal on Dependabot PR #276 (head `657f221`) bumps one
package in `package.json`, `vite-plus` 1.4.0 → 1.5.0. Its lockfile changes 93
packages. They are mostly platform-binary siblings from the oxc, rolldown,
vitest, and vite-plus repositories, at a small number of shared versions.

A local demand measurement replayed the run's research against live GitHub and
npm reads, with the model stubbed, first at current limits and then with every
read and retention limit raised tenfold:

| Stage      | At current limits                                        | Limits ×10                                      | Binding limit                    |
| ---------- | -------------------------------------------------------- | ----------------------------------------------- | -------------------------------- |
| npm reads  | 64 requests, then `budget` for 60 install-script members | 183 requests                                    | Registry share, 64 requests      |
| Upstream   | Stage `budget` after 240 requests; nothing retained      | Completed: 456 requests (244 were 404), 88 s    | Upstream share, 240 requests     |
| Advisories | `enriched` with no lookups; vulnerability `unsupported`  | Completed: 183 lookups, no advisory found, 32 s | Identity proofs held by upstream |
| Signals    | Stage `budget` in 57 ms, before any request              | 101 requests, then stage `budget`               | 512 attempts, then not isolated  |
| Total      | 348 requests                                             | 967 requests, 592 to `api.github.com`, 172 s    | 944-request envelope             |

- Upstream spent its 240-request share; 129 of its 142 GitHub requests were
  404s from tag candidates. Two releases-list responses exceeded the 1 MiB
  per-response cap (1.1 MiB for vite-plus and 2.8 MiB for oxc). Each failed
  only its own lookup, so target-release evidence for the directly updated
  package would be missing even within budget.
- Advisory lookups need public identity proofs, which S2 establishes from npm
  registry reads. When the upstream stage stopped, its proofs were discarded
  with it, so no advisory lookup ran.
- Signals reserves six attempts per member, so 92 members exceed its fixed
  512-attempt ceiling before any read. Raised, its 92 malware lookups ran and
  found nothing, but the stage still ended `budget` for a cause not isolated
  here, and discarded them. npm package documents read for publish times
  reached 4.46 MiB.
- At ×10, 267 research reads repeated a path already read in the same run.
  The measurement recorded paths without query strings, so planning
  re-measures with full URLs. A further 274 repeated paths were advisory
  queries that differ by query string, and 23 were event and freshness reads
  that must stay live.
- The stage failures reached each member as `missing` (malware, upstream) or
  `unsupported` (vulnerability), not as `budget`.

The fixed shares were sized from "about 7 upstream requests per extra package
× 32 packages". Demand actually grows with distinct release subjects and
retained bytes. Package count overstates the first and ignores the second.

## Contract

### 1. A limit fails what it bounds, not completed work

1. A response over the per-response cap, a member's attempt allowance, or a
   member's retained-byte allowance makes that member's affected category
   `partial` or `unavailable`. Other members and categories keep their
   results.
2. When a stage's request, byte, or time share is exhausted, every completed
   member result is retained. Members not yet researched become
   `unavailable` with the stage's actual reason, such as `budget` or
   `timeout`, never a substituted `missing` or `unsupported`.
3. Public identity proofs established from npm registry reads are retained
   when the upstream stage stops early, so S1 lookups can run for every
   member with a proof. S1's identity rule is unchanged.
4. If the enriched packet fails revalidation, only the members whose
   enrichment fails validation revert to their collected evidence, with
   reason `malformed`. If the failure cannot be attributed to members, the
   collected packet is used and every member's research categories are
   reported `unavailable` with `malformed`; research is never reported as
   having run.
5. Retained evidence stays within the review packet limits. When retention
   would exceed them, members are kept in the priority order of section 3.5,
   and members beyond the limit become `unavailable` with `budget`.
6. A reader requests list pages small enough to fit the per-response cap.
   Raising the cap is not the fix.

Items 1–3 are already required by S1 ("preserve valid findings from completed
work when a later request fails") and S2 ("preserve useful independent
evidence when a stage fails"). Items 2–5 amend S3 and research orchestration.

### 2. Read each thing once per run

1. **Scope.** Research readers (npm registry details, upstream, advisory, and
   signals) share one cache for the run. Event verification, snapshot, and
   freshness reads never use it, so a later head or run read is always live.
   The cache is discarded when the run ends.
2. **Key.** The key is method, full URL including query string, and every
   request header that can change the response. Advisory and malware queries
   differ by query string, so they never share an entry, as S3 requires.
3. **Charging.** The first reader to make a request is charged for it.
   A cache hit costs no request or bytes from any share.
4. **Attribution.** Sibling packages from one repository and version share
   repository-level reads through the cache. Each package still proves its
   own package/repository correspondence and target, as S2 requires.
5. **Tag candidates.** Planning accounts for every 404 in the R1
   measurement. It removes candidates that S2's discovery rule does not
   require and keeps those it does.

This amends S1's "cache only within this collection" and "deduplicated only
within one enrichment" to one cache across the run's research readers. S2's
research budgets stay independent of consumer-repository reads, because those
reads are outside the cache.

### 3. Scaled budgets

Each research share is computed from the size of the change, then capped:

```text
share(stage) = min(ceiling(stage), base(stage) + Σ rate(stage, unit) × count(unit))
```

1. **Units.** Counts come from trusted inventory and research progress, never
   from PR text:
   - members, by role (direct, transitive, added, removed);
   - distinct established (repository, version) release subjects;
   - members per optional signal category.

   A share whose subject count is not known until an earlier stage runs, such
   as upstream after registry reads, is computed at the start of that stage.

2. **Smaller changes get smaller budgets.** A one-package change gets a small
   share and fails faster on a runaway reader. A large fan-out gets more, up
   to its ceiling.
3. **Ceilings come from real constraints:** the job's time window, the
   research deadline, GitHub's request rate limit for the workflow token,
   runner memory, and the review packet limits. GitHub requests across all
   stages are capped together, because they share one rate limit; in R1 at
   ×10 they reached 592. Planning cites current GitHub documentation for the
   rate limit and leaves headroom for reruns within the same hour.
4. **Rates come from measurement.** `base` and `rate` values, and the
   per-member attempt and retained-byte allowances of section 1.1, are fitted
   to the demand corpus below and recorded with the corpus revision. A plan
   proposes the fitting method (for example, a percentile per unit with stated
   headroom) and the resulting values, and the user approves both before they
   replace the current shares.
5. **Priority when a ceiling binds.** Direct and added members are researched
   first, then members with install scripts, then the remaining members in
   inventory order. Reaching a ceiling never drops a member from accounting.

### 4. Reader-facing evidence states

Each required category of each member has one coverage state, and may also
have findings:

| State               | Meaning                                                 |
| ------------------- | ------------------------------------------------------- |
| Checked, none found | `available` from a complete check, with no finding.     |
| Found               | `available` or `partial`, with an attributable finding. |
| Not checked         | `partial` or `unavailable`.                             |

A `partial` category with a finding is both found and not checked; the
finding never hides the coverage limit. Not checked keeps today's fail-secure
effect: it withholds a merge recommendation as policy requires. Absence from
an unchecked category is never shown as clean.

Each reason has a fixed next action. A gap with several reasons states each
distinct action, and says to rerun CI only when every one of its reasons
allows it:

| Reason                                          | Rerun helps | Next action                                                                       |
| ----------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `rate_limit`, `timeout`                         | Yes         | Rerun CI later.                                                                   |
| `permission`                                    | After a fix | Correct the reviewer's token permissions, then rerun CI.                          |
| `budget`                                        | No          | The review could not check these packages within its limits; check them manually. |
| `missing`, `unsupported`                        | No          | No supported source was found; check them manually.                               |
| `malformed`, `truncated`, `conflict`, `unknown` | No          | The source could not be trusted; check them manually.                             |

"Check them manually" names the category's concrete step: the GitHub Advisory
Database for vulnerability and malware, the package's install scripts for
install-script evidence, and its release notes for upstream evidence. The
[comment capacity amendment](SPEC-comment-experience.md#comment-capacity-amendment)
owns how these states and actions are rendered.

## Demand corpus and measurement tooling

1. Add a research-only measurement entry point that takes a repository, base
   SHA, and head SHA. It runs the existing collectors and research with the
   model stubbed. It reports requests, bytes, and time per stage and host;
   repeated full URLs; each stage's stop reason; and the units above. It
   never publishes, and it records no response body, token, or model payload.
2. Its corpus is this repository's Dependabot PRs, open and closed, which are
   public. Consumer PRs are measured locally, and only their aggregate counts
   are shared.
3. Re-measuring a corpus entry at the same revision gives the same unit
   counts. Request counts may vary with upstream changes and are reported
   with their measurement date.

## Verification

- **Per-item failure.** Synthetic checks prove that one oversized response,
  one member's exhausted attempts, and one member's retained-byte overflow
  each leave other members' results intact. A named mutation that stops the
  stage on any of them fails.
- **Retained progress and reasons.** A stage share exhausted midway retains
  completed members, and unresearched members carry the stage's reason.
  Mutations that return the collected packet on stage failure, or report
  `missing` for a budget stop, fail.
- **Revalidation.** One member's invalid enrichment reverts only that member.
  The mutation "use the collected packet when any member fails revalidation"
  fails.
- **Packet limits.** A fixture whose retained evidence would exceed the review
  packet limits keeps the highest-priority members' evidence and marks the
  rest `unavailable` with `budget`. The mutation "mark every member
  `malformed` when the packet overflows" fails.
- **Identity survival.** With upstream stopped early, S1 still looks up every
  member with a registry identity proof.
- **Cache.** Identical research requests are read once and charged once.
  These mutations fail: a key without the query string, which lets advisory
  and malware queries collide; a key without the version; and serving a
  freshness read of a pull request whose head changed after research from
  the cache.
- **Scaled shares.** For fixed unit counts, the computed share equals the
  formula, is never above its ceiling, and grows monotonically with each
  count. A one-member change gets a smaller share than R1. A mutation that
  takes any count from PR title or body text, rather than trusted inventory,
  fails.
- **Reason actions.** Every reason in the evidence reason list maps to the
  action above. A gap with a non-transient reason never says to rerun CI.
- **R1 acceptance, local and free.** The demand measurement of PR #276 shows
  no stage-wide stop. Vulnerability and malware coverage are `available` for
  every eligible member: each resolved npm member with an established public
  registry identity, as S1's npm row defines (92 of the 93 records in R1; the
  declaration record has none). Total GitHub requests stay within the
  approved ceiling. The sanitized result is recorded on the issue before any
  R1 re-pin.
- Existing collector, packet, and W2 checks pass unchanged except where this
  spec supersedes them, and each superseded assertion is named in the plan.

## Boundaries

- **Always:** account for every member; keep fail-secure coverage; keep each
  attribution rule in S1–S3; keep event and freshness reads live; measure
  before setting a number.
- **Ask first:** the fitting method, the fitted rates, allowances, and
  ceilings; adding evidence reasons;
  whether an unchecked sibling of a checked release subject may count as
  checked; any new host or data source.
- **Never:** treat unchecked as clean; share results between members without
  each member's own proof; cache across runs, PR heads, or verification
  reads; raise a ceiling past a real constraint to fit one PR.

## Out of scope

- Comment rendering, which the comment capacity amendment owns.
- M1 validation rejections: three whole batches (21 units) in R1 were
  rejected with category `reference`, which needs its own issue.
- The local R1 record/replay and demand harness used for the measurements
  stays outside the repository; section "Demand corpus and measurement
  tooling" specifies the committed replacement.

## Open questions

- Whether a platform-binary sibling with the same repository, version, and
  publisher as a checked member can rely on that member's upstream research.
  Fail-secure says no today.
- What stopped the signals stage at ×10. The measurement tooling's stop
  reason answers this before planning sets the signals share.

## Scaled-Share Function Amendment

**Status: approved for planning, 2026-11-21; implemented on branch
`claude/dependency-update-advisor-spec-965015` for #369 and #414–#422,
pending review and merge.** The user invoked `as-plan` on the reviewed draft
after a fresh-context review whose blocking findings were resolved, then
approved the plan and execution (`as-build auto`) the same day. It refines
section 3 for
[#369](https://github.com/andrewpucci/dependency-update-advisor/issues/369)
(task B11 under #350). The user confirmed the decisions below in an interview
on 2026-11-21. The #350 plan that #369 cites ("local `tasks/plan.md`") is no
longer on disk; this amendment works from #369, this spec, and the
[limit register](SPEC-limit-register.md) plan. Effort tier: L. It changes
research share computation, adds a run-level GitHub quota guard to research
reads, a bounded wait and retry, a required `retryAfter` field in packet
version 1, and a retry time in the comment, which the
[comment capacity amendment](SPEC-comment-experience.md#retry-time-amendment)
renders. It sets no fitted value. B12 measures and fits the values, and B13
applies them; both keep their approval gates.

Decisions confirmed on 2026-11-21:

- The joint GitHub cap counts research's GitHub requests only: the upstream,
  advisory, and signals stages. Snapshot, session, and freshness reads keep
  their own shares and are never charged to it.
- The cap follows GitHub's reported quota instead of a fixed number, because
  the limit is shared by every run in the repository during the hour.
- When the cap stops research, only GitHub requests are refused; requests to
  other hosts continue.
- Research waits for a known reset only within its existing time and never
  extends the job.
- When the reset time is known, the comment says when to rerun CI.
- The retry time is a field in the packet, not a value carried beside it.
- B11 counts members only; release subjects are left to B12.
- R1's "approved ceiling" is the sum of the research stages' request
  ceilings.
- B11 is A1 only; the quota guard is its own task.

### Why the cap follows the reported quota

Every research and consumer read uses the workflow's `GITHUB_TOKEN`. GitHub
documents its limit as 1,000 requests per hour per repository, or 15,000 for
resources in a GitHub Enterprise Cloud account, with a secondary limit of 900
points per minute, where most `GET` requests cost 1 point
([REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
checked 2026-11-21). Reruns and simultaneous Dependabot PRs draw from the
same hourly quota, which a fixed per-run number cannot see. In R1 at ×10 one
run alone made 592 GitHub requests, so two such runs within the hour would
exceed the quota whatever each run's cap said. Every GitHub response reports
the remaining quota, so the guard reads that instead of adding a limit that
would need its own basis.

### Base text this supersedes

Approving this amendment amends the approved base spec as follows:

- Base section 3.3, "GitHub requests across all stages are capped together,
  because they share one rate limit", is met by the A2 quota guard for
  research's GitHub requests. Snapshot, session, and freshness reads stay
  bounded by their own shares.
- Base section 3.3, "Planning cites current GitHub documentation for the rate
  limit and leaves headroom for reruns within the same hour", is replaced.
  The citation is in "Why the cap follows the reported quota". No fixed
  headroom is set: the guard reads GitHub's reported remaining quota, which
  already reflects reruns and other runs in the same hour.
- The base R1 acceptance, "Total GitHub requests stay within the approved
  ceiling", now means: research's GitHub requests in the R1 demand
  measurement stay within the sum of the upstream, advisory, and signals
  request ceilings. That sum is a `derived` register entry over those
  ceilings, not a new value, and the measurement reports it beside the
  observed count.
- Base section 3.1's release-subject unit is left out of this version (A1.2).

### A1. Scaled shares

`researchShares(units, parameters)` returns, for each research share and
each of its request and byte dimensions:

```text
share = min(ceiling, base + Σ rate(unit) × count(unit))
```

1. **Shares.** Upstream, advisory, and each of the five signals readers. The
   signals stage share is the sum of its readers' computed shares. The
   collection registry share stays fixed, because #369 limits B11 to
   `src/budget.ts`, `src/budget.test.ts`, and `src/research.ts`. Until it
   scales, install-script coverage stays bounded by that fixed share.
2. **Units.** Counts come only from the trusted packet's resolved changes.
   Declaration (`basis`) records, sources, and findings are never counted as
   members; R1's 93 records are 92 members. The units are:
   - members whose role is `direct`;
   - members whose role is `transitive` or `unknown`;
   - members whose `kind` is an addition, and members whose `kind` is a
     removal;
   - members eligible for each optional signal category.

   Distinct (repository, version) release subjects are not a B11 unit. The
   repository is established only inside the upstream stage, member by
   member, from registry metadata, and the collection registry reader keeps
   none, so the count does not exist when the stage starts. This supersedes
   base section 3.1's release-subject unit for this version. B12 may propose
   a release-subject count if its measurements show members alone fit demand
   poorly; that proposal is ask-first.

   Every share takes a rate for each member-role unit (direct, transitive,
   added, removed). Each signals reader also takes a rate for the members
   eligible for its own category. No other share and unit pair has a rate.

3. **When.** Each share is computed when its reader is opened, from the
   counts known then. Every unit is known before research starts, so the
   signals metadata reader, which is opened before the upstream stage because
   upstream shares it for PyPI, gets the same share it would get later.
4. **Arithmetic.** Rates are non-negative, which makes every share
   non-decreasing in every count. `base + Σ rate × count` is computed
   exactly and rounded up to an integer before the ceiling is applied.
5. **Floors.** A request share is at least 1. A byte share is at least the
   per-response cap, or its ceiling when that is smaller, so a small change
   can still read one full response. A share is never above its ceiling.
6. **Register entries.** The existing `evidence.allocation.*` share entries
   become the ceilings; no value is copied. Each share's `base` is a
   `derived` entry equal to its ceiling. Each `rate` is an `unjustified`
   entry of 0, with the note "awaiting B12/L8 measurement". Specs cite these
   as `` `limit:<id>` ``, never by value. `unjustified` entries pass
   `check:limits` only while its migration flag is open, so B12 and B13 must
   replace these rates before L11 (#383) closes migration.
7. **Starting behavior.** With those entries every computed share equals
   today's share, so B11 leaves every existing budget, research, and pipeline
   test passing without a changed assertion. Later tasks change fixtures
   where they say so (A4). The envelope stays the derived sum of the
   ceilings, and the signals split stays exact; a run's computed shares may
   total less.

### A2. Research GitHub quota guard

1. **Scope.** One guard per run covers live research requests to
   `https://api.github.com`. It sits below the research cache, so a cache hit
   is never charged. Snapshot, session, and freshness reads never pass
   through it.
2. **Estimate.** The guard tracks the quota window named by
   `x-ratelimit-reset`. Within one window it keeps the lowest valid
   `x-ratelimit-remaining` seen on a live research response from GitHub,
   less one for every GitHub research request started after that response
   arrived, and that response's reset time. A valid response naming a later
   reset starts a new window and replaces both. Once the reset time passes,
   the estimate is cleared until the next valid header. A cached response's
   headers are never read. A missing or invalid header leaves the estimate
   unchanged; with no estimate, only the per-stage shares bound the run. A
   response naming an earlier reset than the current window's is ignored.
3. **Valid headers.** A header value is valid only when it is a string of
   ASCII digits that parses to a safe integer. `x-ratelimit-reset` must also
   name a time after the current wall time (A2.4) and within the quota
   window, a register entry citing GitHub's hourly limit. A response whose
   `x-ratelimit-resource` is present and is not `core` is ignored, because
   research reads only REST core endpoints. Headers on responses from any
   host other than `api.github.com` are never read.
4. **Clock.** Research's `now` is monotonic, not wall time, and
   `x-ratelimit-reset` is Unix seconds. Research therefore gains an injected
   wall clock in Unix milliseconds (`Date.now()` in production). Reset times,
   "the next hour", and window expiry are judged on that clock. A wait is
   converted to `now` units as the retry time less the current wall time, and
   is compared with the research deadline on `now`. Nothing compares a wall
   time with `now` directly.
5. **Reserve.** The guard refuses a request that would bring the estimate
   below the reserve, so research does not take the quota of the GitHub
   reads that follow it, as far as the estimate can tell. The guard limits
   that risk rather than removing it: with no estimate yet, the first
   research request of a run, and the first after each reset, is sent
   unguarded, and other runs in the repository spend the same quota between
   responses. The reserve is a structural `derived` entry: the GitHub
   reads of every freshness recheck after research. Today those are the
   recheck before the model and the final recheck, each reading the run, the
   pull request, and, when it applies, the comparison. A test pins the
   reserve to both call sites, so adding a recheck after research fails it.
6. **Refusal.** A refused request is never sent and is not charged to its
   stage share; the guard decides before the share is charged. It reaches its
   reader as `rate_limit`, never as `unknown` or `malformed`. That reader
   stops its GitHub requests. Its members not yet researched for the affected
   category become `unavailable` with `rate_limit`, and completed members are
   kept, as base section 1.2 says. Requests to other hosts, such as OSV and
   the npm registry, continue.
   A3 decides whether the reader first waits.
7. **Resuming.** A reader that stopped without waiting makes no more GitHub
   requests for the rest of its stage, as the readers do today. A reader that
   waited under A3 resumes. A later stage still runs; while the estimate is
   at the reserve its GitHub requests are refused, subject to A3, and once the
   window's reset passes and the estimate is cleared (A2.2) they are sent
   again.
8. **Measurement.** The demand measurement runs research with the guard.
   It reports each guard refusal and the reported remaining quota, so a
   measurement cut short by the real quota is visible and is re-run after the
   reset rather than read as low demand.

### A3. Bounded wait and retry

1. **Retry time.** For a guard refusal, the retry time is the reset time of
   the estimate's window (A2.2). For a GitHub 403 or 429 for a rate limit, it
   is the `retry-after` seconds when present, otherwise `x-ratelimit-reset`
   when `x-ratelimit-remaining` is 0. Each comes from a live `api.github.com`
   response and is valid only as A2.3 defines. A retry time outside the
   quota window is ignored.
2. **Wait.** If the retry time plus one research request timeout falls
   before the research deadline, the reader waits until the retry time and
   sends the request again. Each reader waits at most the register's wait
   count per run (one); a later
   rate-limit stop in a reader that has waited ends `rate_limit` without
   waiting. The wait honors the run's abort signal and counts toward the
   reader's time. If the wait does not fit, the request ends `rate_limit` as
   A2.6 says. The wait is in the reader, before it starts the request: the
   bounded request helper starts its per-request timer before calling fetch,
   so a wait inside fetch would be cut off by that timer. The retried request
   is a new live request, checked by the guard and charged to the share like
   any other.
3. **Retry outcome.** The retried request's own result stands: a 404 is
   `missing`, a timeout is `timeout`, and so on. Only another rate-limit
   response, or another guard refusal, ends it `rate_limit`.
4. **No extension.** Waiting takes nothing from analysis, the freshness
   allowance, or the workflow's `timeout-minutes`.
5. **Expected effect (not normative).** The research deadline is the
   evidence deadline measured from job start and shared with collection, so
   research often has well under its full time left. The hourly reset will
   rarely fall inside it; a short secondary-limit `retry-after` sometimes
   will. No check depends on how often a wait fits.
6. **Register entries.** The quota window is an `external` entry citing
   GitHub's hourly limit. The number of waits per reader is a `safety` entry:
   one wait bounds how much of research's time a single reader can spend
   idle.

### A4. Retry time in the review

1. **Value.** The run keeps the latest valid retry time from A3.1 among the
   GitHub rate-limit stops that ended members `rate_limit`.
2. **Packet field.** The packet envelope gains one required field,
   `retryAfter`: an RFC 3339 UTC timestamp with whole seconds, or `null` when
   no retry time is known. Following
   [ADR 0006](../adr/0006-amend-packet-v1-in-place-for-reachability.md),
   version 1 is amended in place, because nothing has adopted the packet; the
   [T4 packet spec](SPEC-review-packet.md#retry-time-amendment) records the
   change. Collectors set `null`, and research sets the value. A packet
   missing the field is rejected by the closed-field rule. T4 validates the
   format only; research checks that the time falls within the quota window
   before setting it. The field is run-level, not per member, and is not
   projected to the model. This is the second in-place change to version 1;
   ADR 0006's consequence still holds, so a new version is required before
   any external consumer adopts a packet.
3. **Carried through.** Revalidation rebuilds the envelope field by field
   from the collected packet, so it must take `retryAfter` from the enriched
   packet, or a value set by research is lost. The handoff passes the
   packet's value to the renderer, and `DecisionBriefInput` gains a
   `retryAfter` field of the same type.
4. **Rendering.** When a gap's action is "Rerun CI later" and
   `retryAfter` is set, the action says "Rerun CI after HH:MM UTC.": 24-hour,
   zero-padded UTC time, rounded up to the next whole minute; a time already
   on a whole minute is kept. The time is at most an hour after the review,
   whose time the comment already shows, so no date is added when it passes
   midnight. The renderer builds the text from the validated timestamp
   itself, never by escaping untrusted text, because escaping would alter the
   colon. Without a known time, the action is unchanged. A gap with a
   non-transient reason still never says to rerun CI.
5. **Timeout-only gaps.** The time also applies to a gap whose only reason is
   `timeout`, because rerunning CI repeats the run's GitHub reads and would
   meet the same exhausted quota before the reset.

### Tasks for planning

1. **B11: scaled shares** (A1). Scope M: `src/budget.ts`,
   `src/budget.test.ts`, `src/research.ts`, and the new register entries in
   `src/limits.ts`.
2. **Research GitHub quota guard** (A2), after B11. Scope L: the research
   fetch path, the readers' refusal handling, the reserve test at both
   pipeline recheck sites, and the R1 ceiling register entry. It takes over
   #369's "capped together" acceptance criterion and its "cap GitHub requests
   per stage only" mutation.
3. **Wait and retry** (A3), after the guard. Scope M: the GitHub-reading
   readers (`upstream-read`, `advisory-read`, `policy-signals-read`), the wall
   clock input, and two register entries.
4. **Retry time in the comment** (A4), after the wait and retry. Scope L:
   `src/schema.ts`, `src/revalidation.ts`, `src/packet.ts`, research, the
   handoff, `src/reporting.ts` and `DecisionBriefInput`, and every
   packet-building fixture.

The user approved this split on 2026-11-21. Planning assigns issues and
orders them before B12.

### Amendment verification

- **Formula.** With test-only non-zero parameters, each computed share equals
  the formula, never exceeds its ceiling, and does not decrease when any one
  count grows. A one-member change gets a smaller share than R1's 93 records
  (92 members). A fractional product rounds up; a request share is never
  below 1, and a byte share never below the per-response cap or its ceiling.
- **Starting values.** With the register's starting entries, B11 leaves every
  existing budget, research, and pipeline test passing without a changed
  assertion.
- **Guard.** A fake GitHub reporting a falling `x-ratelimit-remaining` stops
  research GitHub requests at the reserve, gives `rate_limit` to the members
  not yet researched, and keeps completed members. OSV and npm requests in
  the same run still succeed. Freshness reads still run with the reserve
  intact. A reader stopped without waiting sends no more GitHub requests in
  its stage, and a later stage sends none while the estimate is at the
  reserve; once the reported reset passes, it sends them again. A refused
  request is not charged to its share. With some GitHub responses lacking
  headers, each request started since the last valid header still lowers
  the estimate. A fake npm or OSV response with `x-ratelimit-remaining: 0`,
  and a GitHub response whose `x-ratelimit-resource` is not `core`, change
  nothing.
- **Reserve.** With both post-research rechecks reading the comparison, a run
  whose research reaches the reserve still completes both rechecks.
- **Clock.** With `now` starting at 0 and a wall clock at a realistic Unix
  time, a reset 2 minutes ahead is accepted, a wait that fits is taken, and
  a reset 2 hours ahead is ignored.
- **Wait.** A retry time before the research deadline less one request
  timeout waits once and sends the request again. A later retry time ends
  `rate_limit` with no wait. A second rate-limit stop in the same reader ends
  `rate_limit` without a second wait. A retry that returns 404 ends `missing`,
  not `rate_limit`. An aborted run ends the wait.
- **Packet field.** T4 accepts `retryAfter` as `null` or a whole-second UTC
  timestamp, and rejects a packet without it, with a fractional or offset
  time, or with any other type. Every packet-building fixture sets it. A
  value research sets survives revalidation and reaches the renderer.
- **Retry time.** A run stopped by the GitHub quota with a known reset renders
  "Rerun CI after HH:MM UTC." with the latest time, zero-padded and rounded
  up; a time on a whole minute is kept, and a time after midnight renders as
  `00:MM`. A timeout-only gap in the same run shows the time. A run without a
  known time renders "Rerun CI later." A reset beyond the quota window is
  ignored.
- **R1 ceiling.** The register's research GitHub ceiling equals the sum of
  the upstream, advisory, and signals request ceilings, and the demand
  measurement reports research's GitHub requests against it.
- **Named mutations fail those checks:**
  - counting declaration (`basis`) records, sources, or findings as members;
  - flooring a byte share at 1 instead of the per-response cap;
  - charging a cache hit, or reading rate-limit headers from a cached
    response or from a host other than `api.github.com`;
  - charging a refused request to its share;
  - capping GitHub requests per stage only;
  - charging snapshot, session, or freshness reads to the guard, or letting
    research spend the reserve;
  - stopping non-GitHub requests when the guard refuses;
  - reporting a guard refusal as `budget`, `unknown`, or `malformed`;
  - recording no retry time for a guard refusal;
  - keeping the estimate across a reset;
  - comparing a Unix reset time with the monotonic `now`;
  - a reserve that covers only the final recheck;
  - waiting past the research deadline, or waiting more than once in one
    reader;
  - reporting a retried request's 404 or timeout as `rate_limit`;
  - resuming GitHub requests in a reader that stopped without waiting;
  - rendering the earliest retry time instead of the latest, or rounding it
    down;
  - accepting a packet without `retryAfter`, or projecting it to the model;
  - dropping `retryAfter` in revalidation;
  - passing the rendered time through text escaping, or moving a time that
    is already on a whole minute.

### Amendment boundaries

- **Always:** count only trusted units; keep the post-research reserve; keep
  completed results when the guard stops research; validate every header
  value before use.
- **Ask first:** any non-zero rate, a base below its ceiling, a new ceiling,
  scaling the collection registry share, or a change to `timeout-minutes`;
  what the reserve covers, the quota window, the number of waits per reader,
  and whether a secondary-limit `retry-after` is waited on.
- **Never:** extend the job to wait for a reset; read rate-limit headers from
  the cache or from a host other than `api.github.com`; show a retry time
  for a gap whose reasons do not all allow a rerun.

### Amendment out of scope

- Fitted parameters (B12) and applying them (B13).
- Capping snapshot, session, or freshness reads.
- Scaling the collection registry share.
- Reconstructing the missing #350 plan.

### Amendment open questions

- Resolved 2026-11-21: release subjects cannot be counted at the start of the
  upstream stage, so B11 counts members only (A1.2).
