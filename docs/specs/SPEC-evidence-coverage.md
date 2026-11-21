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
