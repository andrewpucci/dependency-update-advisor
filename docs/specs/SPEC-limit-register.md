# Spec: Limit Register

Status: approved for planning by the user on 2026-11-17; the user approved its
plan, tracked in
[#372](https://github.com/andrewpucci/dependency-update-advisor/issues/372),
for execution the same day.
Revised the same day to match the intent the user confirmed in an interview
(see Resolved). A cross-cutting supporting contract for
`shared-review` in [the capability map](README.md).

Limit citation amendment (L10,
[#382](https://github.com/andrewpucci/dependency-update-advisor/issues/382)):
the user approved this spec's change on 2026-11-26. It cites register
entries as `limit:<id>` instead of stating their values, with no value
change.

The user asked for this on 2026-11-17, and on the same day approved its
method: each limit gets exactly one stated basis, recorded in one register,
with its effect and its boundary test. This spec sets no new values.

## Objective

A **limit** here means any number the reviewer or its tooling enforces or
relies on, where someone could choose a different value. That includes
maxima and minima, ranges, defaults of bounded settings, timeouts, intervals,
reserves and allowances, concurrency, attempt and page counts, truncation
lengths, and thresholds. It covers CI workflow timeouts and tooling thresholds
as well as `src/`. These are not limits, and the enforcement allowlist names
each with a reason:

- **Format facts:** a 40-character SHA, HTTP status codes, character-code
  ranges, date-field ranges.
- **Structural invariants:** a value must be non-negative or positive.
- **Counter starting values.**

Changing a limit should mean editing one register entry, with no fresh
audit. That entry says what the limit protects, why it has its value, what
happens when it is reached, and which test pins that behavior. The people
who change limits are the maintainer, or an agent working for them, when a
real PR reaches one. Adopters set the few limits that guard their own
budgets.

Every limit must name a concrete harm it prevents or an outside constraint
it respects: a resource such as memory, CPU, time, or model cost; a platform
maximum; an adopter budget; or the packet the model reads. "It might grow
someday" is not a reason. A limit that cannot name one is deleted.

## Evidence

An audit on 2026-11-17 inventoried `src/`, `scripts/`, and
`.github/workflows/` at `0cccd45`, plus the uncommitted evidence-coverage work
(B4–B6). It found 227 numeric literals in limit-like positions. 52 of them
are not limits. Of the other 175:

| Basis                                                                   | Count |
| ----------------------------------------------------------------------- | ----: |
| Chosen: an approved spec or tool states the number but records no basis |    81 |
| Unrecorded: in code only, with no spec entry or reason                  |    58 |
| Duplicate: repeats another limit as a literal                           |    15 |
| Measured                                                                |     8 |
| Derived                                                                 |     7 |
| External                                                                |     6 |

The limits that bind real PRs are all chosen or unrecorded: packet bytes,
per-response bytes, research attempts, the research shares, and the comment
body. The review packet spec says its numbers "are not measured performance
or test-coverage thresholds." The research and collector parse limits equal
the integration-test fixture values, and no spec states them. Several limits
are written as literals in more than one place, among them the comment body,
the identity bounds, and config's source-root and excerpt-file counts. The
audit used pattern matching, so floors of 0 or 1 were reviewed by hand; the
enforcement check in section 4 replaces it. The audit's inventory, with each
limit's basis and effect, is local working material, not part of this
contract.

Platform figures checked on 2026-11-17:

- **Job length.** A job on a GitHub-hosted runner may run for up to 6 hours
  ([Actions limits](https://docs.github.com/en/actions/reference/limits)). The
  reviewer's job timeout,
  `limit:workflow.dependabotReview.review.timeoutMinutes`, is the shared
  workflow's own `timeout-minutes`.
- **REST rate limit.** `GITHUB_TOKEN` gets
  `limit:github.token.restRequestsPerHour` REST requests per hour per
  repository, or 15,000 for Enterprise Cloud resources
  ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- **Comment size.** GitHub's REST docs don't state a comment-body limit. API
  errors report 65,536 characters, and third-party sources disagree on whether
  that counts characters or bytes. The reviewer's cap was then a chosen
  margin under that figure. The L9 probe later measured the enforced limit;
  see the [External Citations Amendment](#external-citations-amendment).

## Contract

### 1. One register

One module, `src/limits.ts`, defines every limit. Each entry has:

- `id`: a stable name, such as `packet.bytes` or `research.upstream.requests`.
- `value` and `unit`: bytes, UTF-16 code units, milliseconds, a count, or
  tokens.
- `protects`: the concrete harm the limit prevents or the outside constraint
  it respects (see Objective).
- `basis`, the reason for the value, exactly one of:
  - `external`: a citation (URL and date checked), the platform value, and the
    stated margin below it;
  - `derived`: a formula over other entry ids, evaluated in code, never copied.
    A derived entry may be **structural**: the code's shape bounds the value,
    so no runtime check is needed. One example is signals attempts: at most
    `limit:signals.attemptsPerMember` per member, because they come from
    fixed call sites with no loop over untrusted data, multiplied by the
    `limit:packet.changes` packet limit. A structural entry names the test
    that pins it;
  - `measured`: the measurement command, the corpus, the statistic (such as
    p95 or max), the headroom, and the date measured;
  - `safety`: why this number protects the named resource. For a guard on
    untrusted input, that is the margin above the largest legitimate value
    observed and below the point where harm begins;
  - `config`: an adopter setting that section 5 admits. The value is its
    default, and the basis names who bears the trade-off and the approval
    that admitted it. The entry's `configurable` field holds the rest;
  - `unjustified`: an explicit, visible marker for a value with no basis yet,
    with a pending note. It exists only during migration, and none may
    remain after phase 2.
- `effect`: what happens when the limit is reached. This means the outcome and
  reason (for example `budget` on one member, a whole-stage `budget`, or a
  `render-size` failure), and whether partial results are kept.
- `test`: the test that pins the at-limit and over-limit behavior, or `none`
  with a reason.
- `configurable`: absent, or the adopter setting with its default and hard
  maximum (section 5). It is set exactly when the basis is `config`. The hard
  maximum, and a hard minimum where one exists, name register entries rather
  than numbers, so a bound derived from other entries moves with them. A
  joint maximum bounds the sum of every setting that names it.

Amended (L11): the `config` kind and the shape of `configurable` were
approved by the maintainer on 2026-11-27
([#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)),
with the configurable categories in section 5. L12
([#384](https://github.com/andrewpucci/dependency-update-advisor/issues/384))
adds each setting to the config contract, the published schema, and the
parser; until then a run uses the default.

Dependents come from the `derived` formulas, so the register can list every
entry that a change would move.

Existing export names (`PACKET_LIMITS`, `EVIDENCE_READ_ENVELOPE`,
`EVIDENCE_READ_ALLOCATION`, `W2_EVIDENCE_LIMITS`, `ANALYSIS_LIMITS`, and the
named constants) stay, as views over the register, so callers don't churn.
Once the scaled shares from the evidence-coverage spec land, their base, rate,
and limit parameters become register entries too.

### 2. No second copy

No limit value appears anywhere outside the register: not in code, and not
in specs.

- **Code.** Re-hardcoded identity bounds, the duplicated comment cap,
  and any cap that silently equals another (such as attempts and findings
  matching packet findings) become references or `derived` entries.
- **Specs.** Specs stop stating limit values. They cite the register entry
  as `` `limit:<id>` ``, for example `` `limit:packet.bytes` ``, so an old
  number can't compete with the register. Approved specs that now state
  values need these amendments, each with its own approval:
  - `SPEC-review-packet.md`
  - `SPEC-review-orchestration.md` (W2)
  - `SPEC-source-context.md`
  - `SPEC-mistral-transport.md`
  - `SPEC-analysis-batches.md`
  - `SPEC-decision-brief.md`
  - `SPEC-managed-comments.md`
  - `SPEC-config-parser.md`
  - `SPEC-dependabot-roots.md`
  - `SPEC-evidence-coverage.md`
  - `SPEC-comment-experience.md`

### 3. Documentation

The register file is the documentation for internal limits. Each entry is
readable in place, with its value, `protects`, basis, effect, and test
together. There is no rendered copy.

Adopters get a guide, `docs/budget-guide.md`, next to the
[policy guide](../policy-guide.md). For each configurable limit it explains
what the limit bounds, why an adopter might lower or raise it, and what
happens when a run reaches it. It links to the published config schema and
the register for defaults, hard maxima, and units, and does not copy them.

### 4. Enforcement

Deterministic checks run in CI. `vp lint` covers code; `npm run check:limits`
covers everything else. They fail when:

- **Code:** a numeric literal sits in a limit-like position in non-test
  `src/` or `scripts/` code outside `src/limits.ts`. Limit-like positions are
  comparisons, limit-named fields and constants, truncation lengths, and call
  arguments that bound a size. Two oxlint rules check this, both run by
  `vp lint`:
  - oxlint's built-in `no-magic-numbers`, which flags literals in
    comparisons, arguments, and object properties;
  - a small custom rule in a repository oxlint plugin, following
    `scripts/complexity/plugin.mjs`. It flags a numeric literal that
    initializes a named constant or field outside the register, which
    `no-magic-numbers` allows. That is how a second copy would otherwise
    slip in.

  An explicit allowlist covers the literals that the Objective says aren't
  limits, with a reason for each.

- **Workflows:** a workflow's `timeout-minutes` differs from its register
  entry. Workflow YAML can't import the register, so the check compares them.
- **Specs:** a spec in `docs/specs/` states a register entry's value, in any
  spelling (`3000`, `3,000`, or `3_000`). An allowlist names each line where
  that number means something else, with a reason. During migration, the
  allowlist also holds each approved spec's values as pending amendments.
  That part must be empty after phase 2.
- **Citations:** a spec cites a `limit:<id>` that doesn't exist.
- **Tests:** an entry names a test that doesn't exist.
- **Migration:** after phase 2, any entry is still `unjustified`.

**Register scope** (L11, Q5 and Q25; approved by the maintainer on
2026-11-27,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
Two kinds of value sit outside the register's basis rule, because no adopter
bears them and no outside constraint bounds them:

- repository tooling policy, such as this repository's own CI and probe
  timeouts and check:limits settings;
- an internal constant whose only rule is an invariant against a register
  entry, such as the pipeline's ownership watch interval, which must stay
  below every request timeout while the claim store has no production
  backend.

Each one stays a named constant beside the code that reads it, with a
lint exception that gives its reason and a test that pins its invariant.
Revisit the ownership watch interval when the claim store has a backend.

Small values such as 1, 2, and 15 also appear in specs with unrelated
meanings. The plan measures how many spec lines the check matches before
choosing how to scope it, so the allowlist stays reviewable.

### 5. Adopter configuration

A limit may be adopter configuration only when all of these hold:

- the adopter bears its trade-off (their model cost, rate limit, run time, or
  coverage);
- a hard maximum comes from an external limit or a stated invariant;
- the default equals today's value.

These are never configurable:

- parse-safety bounds on untrusted responses;
- schema and identity bounds shared with model projection;
- platform limits;
- freshness allowances.

**Adopter settings win.** These rules protect the budgets adopters set:

- An adopter's setting overrides the repository default.
- The reviewer never goes past an adopter's setting. When a run reaches it,
  the reviewer stops that work and reports `budget`, keeping completed
  results, as section 1's `effect` states. Lowering a setting never hides
  incomplete coverage.
- A change to a repository default reaches only adopters who left that
  setting unset. An adopter who set a value keeps it across re-pins, even
  when it equals the old default.
- Release notes name every change to a configurable limit's default.
- The parser rejects a value above the hard maximum, as it rejects any
  invalid config. It never clamps the value.

One limit is already adopter configuration: `policy.minimumReleaseAgeDays`,
an integer from 1 through `limit:config.maxReleaseAgeDays` that defaults
to 1. It becomes the first entry with `configurable` set. Its bounds, 1 and
`limit:config.maxReleaseAgeDays`, need a stated basis like any other limit.

Amended (L11, E18 and Q24(b); approved by the maintainer on 2026-11-27,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)):
the window has no policy maximum, so it is not a `configurable` entry. No
platform or Dependabot document gives a maximum (Dependabot's `cooldown` days
have none), and a chosen ceiling is not a basis.
`limit:config.maxReleaseAgeDays` is now a structural bound, not a policy cap:
the days ECMAScript time values span on each side of the epoch. A longer
window cannot end at any time a `Date` can represent, and within it the
window's milliseconds (at most 8.64 × 10^15) stay a safe integer, so the
recheck time is exact. The lower bound of 1 is a positivity check, not a
limit.

Configuration is read only from the trusted default-branch file, as today. The
v1 parser rejects unknown keys, so a new `limits` section needs a parser
change. Consumers pin the reviewer by SHA, so an older reviewer never sees the
field. The job budget is set in the shared reusable workflow, not the caller,
so making it adopter configuration also needs a workflow input. That is a
separate decision.

Under the review-config spec's boundaries, adding a configurable category is
Ask-first.

**Derived entries follow the settings they derive from** (L11, Q1; approved
by the maintainer on 2026-11-27,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
An entry derived from an adopter setting takes the value its formula gives
at the run's setting, not at the setting's hard maximum. The register shows
each derived value at the defaults. `npm run check:limits` evaluates the
register at the defaults and again with each setting at its hard maximum,
and fails when a setting leaves its bounds or a derived value is not finite.
A freshness allowance stays never configurable in its own right, but it may
follow a setting it derives from. L12 adds the run-time code path that
builds the register at the adopter's settings.

The user approved these as adopter configuration on 2026-11-17. Each keeps
today's value as its default, and each needs a cited hard maximum before
phase 3:

- **GitHub request cap:** the total research requests on the adopter's
  token. Hard maximum: the documented `GITHUB_TOKEN` rate limit
  (`limit:github.token.restRequestsPerHour` requests per hour per repository)
  less headroom.
- **Model analysis:** calls (`limit:analysis.maxCalls`), concurrency
  (`limit:analysis.maxConcurrentCalls`), and analysis time
  (`limit:analysis.maxAnalysisMs`). Hard maximum: the provider's documented
  limits and the job window.
  - Amended (L11, Q17(a); approved by the maintainer on 2026-11-27,
    [#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)):
    Mistral documents no call limit, so the call cap's hard maximum is
    structural, `limit:analysis.maxCallsMax`: the calls a run at
    `limit:packet.changes` units needs when every batch splits down to single
    units.
- **Completion tokens:** `limit:analysis.completionTokens`. Hard maximum: the
  provider's maximum output tokens.
- **Job budget and evidence deadline:** `limit:job.budget` and
  `limit:evidence.envelope.totalTimeoutMs`. Hard maximum: the
  `limit:github.hostedJobMaxMinutes` hosted-job limit for the job budget.
  This needs a new
  reusable-workflow
  input, because `timeout-minutes` lives in the shared workflow. The pipeline
  must derive its job window from that input.
  - Amended (L11, Q4(a); approved by the maintainer on 2026-11-27,
    [#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)):
    the evidence deadline's hard maximum is
    `limit:job.maxEvidenceDeadlineMs`, derived from the job window less what
    must follow evidence: the before-model recheck, one model call, the
    publication reserve, and the final freshness allowance. The hosted-job
    limit bounds it only through the job budget. So an adopter's deadline
    always leaves analysis time for one full model call.

These were approved as adopter configuration on 2026-11-27 (L11,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)),
each with today's value as its default and the hard maximum named here:

- **GitHub request cap, extended** (Q6(a)): the snapshot, session, and
  signals-upstream request shares join the research requests in the GitHub
  request cap. Tree reads grow with path depth, so these shares have no
  structural bound. Hard maximum, joint over every share in the cap:
  `limit:github.token.requestCapMax`, the documented `GITHUB_TOKEN` rate
  limit less the freshness reads every run makes. It counts GitHub reads
  only, so `limit:research.githubQuota.researchCeiling`, which sums every
  host, cannot serve as it.
- **Coverage bounds** (Q9(a)): limits that bound how much of a change the
  reviewer covers, where the adopter bears the coverage they give up and
  the quota and time a larger setting spends: `limit:w2.npm.maxRoots`,
  `limit:w2.uv.maxRoots`, `limit:w2.actions.maxWorkflows`,
  `limit:research.maxTagCandidates`, `limit:context.maxSourceFileBytes`, and
  `limit:context.maxTotalSourceReadBytes`. Each keeps today's value as its
  default; each register entry names its hard maximum. The npm and uv root
  counts are bounded by the roots Dependabot's file may name,
  `limit:dependabot.maxRoots`.
  - Amended (L11, item 4(a); approved by the maintainer on 2026-11-28,
    [#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)):
    `limit:advisory.discovery.spellingCeiling` joins the coverage bounds,
    with today's value as its default. Its hard maximum,
    `limit:advisory.discovery.spellingCeilingMax`, is the largest power of
    three whose spellings of the shortest name fit the advisory request
    share for both query kinds.
- **Units per model call** (Q16(a)): `limit:analysis.maxUnits`. The adopter
  bears the call count and cost a smaller batch spends, and the truncation
  risk of a larger one. Hard maximum: `limit:packet.changes`, since a unit
  holds at least one change. It was also the reply's row-count bound, a
  schema bound shared with model projection, which the list above bars; that
  bound is now structural instead: a reply may have no more rows than the
  units in its request.
- **Model request timeout** (Q18(a)): `limit:analysis.requestTimeoutMs`. The
  model is consumer configuration, so its speed is not a fixed platform
  property, and the adopter bears the run time of their chosen model. Hard
  maximum: `limit:job.maxAnalysisTimeMs`, the analysis time the job window
  leaves after the evidence deadline, the recheck, the publication reserve and
  the final freshness allowance.
- **Response cap** (Q3(a)): `limit:evidence.envelope.maxResponseBytes`. It
  is a parse-safety bound on untrusted responses, which the list above bars;
  this amendment admits it by name, because the cap binds legitimate
  responses (such as the compare page of
  [#472](https://github.com/andrewpucci/dependency-update-advisor/issues/472))
  and no constraint gives its value. Hard maximum: the runner heap divided
  by the responses in flight at once times their parse amplification, pinned
  by a structural test. The request timeout derives from the cap, not the
  reverse. Revisit this when #472 lands.
  - Amended (L11; approved by the maintainer on 2026-11-27,
    [#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)):
    the runner heap here is the evidence phase's share,
    `limit:runner.evidenceHeapBytes`, and the hard maximum is
    `limit:runner.maxEvidenceResponseBytes`: that share divided by
    `limit:evidence.readsInFlight` times the measured
    `limit:runner.heapBytesPerEvidenceByte`. A structural test pins the
    responses in flight.

#### Runner heap by phase

Amended (L11; approved by the maintainer on 2026-11-27,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
A review runs in two heap phases. Snapshot, collection and research make up
the evidence phase. Model analysis and rendering make up the analysis phase,
which starts only once research has returned. Research readers are locals of
research that close when it ends, and cached research bodies are byte arrays
outside the V8 heap. Each phase gets the whole of `limit:runner.heapBytes`
less what it holds, so the two phases' budgets are not added together.

- **Analysis phase:** the model replies in flight
  (`limit:analysis.replyHeapBytes`), the decision-unit expansion
  (`limit:runner.unitExpansionHeapBytes`), and the packet at its analysis rate
  (`limit:runner.heapBytesPerPacketByte`). That rate is measured on the
  densest valid packet shape. `limit:packet.bytes` is derived from this phase.
- **Evidence phase:** the packet at its evidence rate
  (`limit:runner.evidenceHeapBytesPerPacketByte`), which covers assembly,
  validation and revalidation, plus the responses being parsed and the
  evidence readers retain (`limit:runner.evidenceRetainedHeapBytes`).
  `limit:runner.evidenceHeapBytes` is what is left for responses in flight.
- **State that spans both phases** counts in each phase's budget. The
  pipeline releases the snapshot tree, the research cache and the npm
  inventory once research returns, before analysis starts, so they count in
  the evidence phase only.
- Each rate is measured with its own probe (`npm run measure:heap`), never
  borrowed from the other phase.

Amended (L11; approved by the maintainer on 2026-11-28, "Raise heap to
runner memory",
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
The heap is no longer V8's default. `limit:runner.heapBytes` is the smallest
runner's memory less what is not old generation:

- the young generation;
- the off-heap buffers the register bounds;
- the runtime baseline, measured with a recorded command;
- what the runner OS and agent keep.

The result is rounded down to whole MiB, because `--max-old-space-size` takes
whole MiB. The relaunch then sets exactly the heap the caps are sized for.

The action relaunches itself once with an old-generation size from the same
formula, using the memory of the runner it runs on: the cgroup limit when one
is set, otherwise physical memory. A relaunched process never relaunches
again.

The relaunch fails closed. The action stops with a fixed error message and
exit code 80, and never runs at V8's default heap, in each of these cases:

- the child process cannot be started;
- the runner's memory leaves no heap for the review;
- the process that runs the review has a V8 heap limit below
  `limit:runner.heapBytes` plus `limit:runner.youngGenerationBytes`. This
  covers both the relaunched child and a process started with its own
  old-generation size.

A runner therefore needs at least `limit:runner.memoryBytes` of memory, the
smallest supported runner's. A smaller runner stops with exit code 80. This
includes GitHub-hosted `macos-latest` (7 GB), which is not supported.

Amended (L11, item 11(b); approved by the maintainer on 2026-11-28,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
The raw event is state of neither phase. Startup parses it into a one-shot
holder that verification takes; the pipeline keeps only the bounded binding
verification returns, so the parsed event is unreachable before the first
tree read, and a test collects garbage there and checks that it is gone. Its
parse peak falls at startup, before either phase holds anything, inside
`limit:runner.heapBytes`, so `limit:startup.maxEventBytes` takes GitHub's
webhook payload cap as an `external` value. The read buffer, the cap plus one
probe byte, is outside the V8 heap and counts in `limit:runner.offHeapBytes`.

#### Projection caps

Amended (L11; approved by the maintainer on 2026-11-28,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
`limit:analysis.projectionBytes` and `limit:analysis.projectionEntries` are
derived, not chosen. They are the packet, its copies in the decision units,
the strings and values the unit expansion derives (fixed by the packet's
count caps), and the config. Every packet T4 accepts then passes the
projection. A structural test pins the fixed unit text sizes to the code that
writes them.

#### Hard maxima that move with their setting

Amended (L11; approved by the maintainer on 2026-11-28,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
A hard maximum is read from the register evaluated at the settings. When it
falls as its own setting rises, the hard maximum is the largest setting that
still holds. The response cap's maximum behaves this way, because a larger cap
adds off-heap buffers. `npm run check:limits` evaluates the register there.

#### Packet floor

Amended (L11, A1; approved by the maintainer on 2026-11-28,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
`limit:packet.floorBytes` is the smallest packet T4 accepts with
`limit:packet.changes` changes and no optional evidence. It is derived and
pinned by an offline test that builds and validates that packet. Below it, no
valid change at the change cap can produce any packet, so it is a structural
floor, not demand.

- A setting that spends heap has a hard maximum: the largest value at which
  `limit:packet.bytes` stays at or above `limit:packet.floorBytes`, with the
  other settings at their defaults. This replaces the Q14(a) text, which was
  never written.
- `limit:analysis.maxConcurrentCalls` and `limit:analysis.completionTokens`
  are adopter settings under this rule. Their hard maxima are
  `limit:analysis.maxConcurrentCallsMax`, which also stays at or below
  `limit:analysis.maxCalls`, and `limit:analysis.completionTokensMax`, which
  also stays at or below the Q14(a) bound.
- `limit:runner.maxEvidenceRetainedBytes` is sized beside a packet at the
  floor, not at today's packet cap.
- The settings share one heap, so a setting at its maximum leaves the packet
  cap at the floor. L12 must evaluate the register at the adopter's actual
  settings and require `limit:packet.bytes` at or above the floor.
  `npm run check:limits` already rejects a register that falls below it, at
  the defaults or with any setting at its hard maximum.

#### Retained evidence

Amended (L11, Q10(a); approved by the maintainer on 2026-11-27,
[#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)).
The evidence the readers keep after a parse is priced at its own measured
rate (`limit:runner.heapBytesPerRetainedByte`), not at the parse peak. Only the
responses in flight are priced at the parse peak
(`limit:runner.heapBytesPerEvidenceByte`).

- The thirteen byte shares and retained caps Q10 names are adopter settings.
  Their defaults are today's values, under one joint hard maximum
  (`limit:runner.maxEvidenceRetainedBytes`). The registry byte share and the
  signals upstream reader's byte share
  (`limit:evidence.allocation.signals.readers.upstream.maxTotalBytes`) have a
  hard minimum of the response cap, so one response at the cap always fits.
  The upstream share is the one exception to "default equals today's value":
  its default rises to the response cap (L11, Q11(a)).
- They are held beside `limit:research.maxRetainedBytes` and the trusted
  config for the whole evidence phase. Together these make up
  `limit:runner.evidenceRetainedHeapBytes`.
- `limit:packet.bytes` is the smaller of its analysis-phase and
  evidence-phase values. The evidence phase binds on the smallest runner, so
  the packet cap takes the heap the defaults leave. A setting raised above its
  default would lower the packet cap. The joint maximum and the response cap's
  hard maximum are therefore their defaults until the heap is shared out
  differently.
  - Amended (L11, A1; approved by the maintainer on 2026-11-28,
    [#383](https://github.com/andrewpucci/dependency-update-advisor/issues/383)):
    the joint maximum no longer equals the sum of the defaults. It is sized
    beside a packet at `limit:packet.floorBytes` (see
    [Packet floor](#packet-floor)), so a share may rise until the packet cap
    reaches the floor. The response cap's hard maximum still follows
    `limit:packet.bytes` through `limit:runner.evidenceHeapBytes`, so it stays
    its default.
- A demand measurement (`npm run measure:demand`) holds `limit:packet.bytes`
  at its production value. Its scaled read budget would otherwise spend the
  packet's heap.

### 6. Changing a limit

A change edits one register entry: its value and its basis together. The
register lists its dependents and states its effect. The named boundary test
shows the new edge. Changing an `external` or `safety` entry is Ask-first. A
`measured` entry records a new measurement, not just a new number. Specs
cite the id, so no spec changes with the value.

## Phases

1. **Register and enforcement, values unchanged.** Move every limit into the
   register with its current basis. Arbitrary values are marked `unjustified`.
   Existing tests prove behavior is preserved. Add the lint rules and
   `npm run check:limits`, with the approved specs' current values in its
   pending-amendment allowlist. This phase starts after the uncommitted B4–B7
   work is committed.
2. **Bases decided.**
   - Every entry states what it `protects`. Limits that can't name a harm or
     outside constraint are proposed for deletion.
   - Measure the reviewer's demand over this repository's Dependabot PRs with
     `npm run measure:demand`. This widens evidence-coverage B12 from research
     shares to every measurable limit, and B12's approval gate stays.
   - Cite external limits, including the comment-limit probe. Write safety
     rationales.
   - Amend the approved specs to cite register ids.

   Each value change, deletion, and spec amendment needs approval. The phase
   ends with no `unjustified` entry and an empty pending-amendment allowlist.

3. **Adopter configuration.** Add the approved configurable limits to the
   config contract, the published schema, and the parser, with the precedence
   rules in section 5. Write `docs/budget-guide.md`.

## Verification

- `vp lint` fails on a limit literal planted in code outside the register,
  and passes on the migrated tree. Mutations: add
  `if (files.length <= 3_000)` to a module, and add
  `const MAX_FILES = 3_000;` to a module.
- `npm run check:limits` fails on each of these and passes on the migrated
  tree:
  - a workflow `timeout-minutes` that differs from its entry;
  - a register value written into a spec line that is not allowlisted
    (mutation: add "at most 3,000 code units" to an approved spec);
  - a `limit:<id>` citation to an id that doesn't exist;
  - an entry that names a missing test;
  - after phase 2, an `unjustified` entry.
- Phase 1 changes no outcome. The full check set passes unchanged, including
  the existing boundary tests (exact comment-limit body, `limit:packet.changes`
  changes and one more, `limit:config.maxBytes` config,
  `limit:github.treeMaxFiles` file listing).
- Every register entry names an existing test, or says `none` with a reason.
- For each configurable limit:
  - a run with a setting below the default stops at the setting and reports
    `budget`, keeping completed results;
  - a value above the hard maximum is a config validation failure;
  - an explicit setting equal to the old default survives a default change in
    a test that changes the default.

## Boundaries

- **Always:** keep one basis per entry; name what each limit protects; keep
  values unchanged in phase 1; keep every `unjustified` marker visible in the
  register.
- **Ask first:** any value change; deleting a limit; any new configurable
  limit; amending an approved spec; changing the workflow's `timeout-minutes`.
- **Never:** invent a basis, record a measurement that wasn't run, keep a limit
  only to cap foreseeable growth, restate a register value in a spec, or let
  configuration raise a limit above its hard maximum or hide `budget`.

## Related work

- [Evidence coverage](SPEC-evidence-coverage.md): B11's scaled-share
  parameters and B12's fitted values become register entries.
  Checkpoint B's 92-member criterion depends on packet bytes, attempts, and
  shares.
- [Comment capacity](SPEC-comment-experience.md#comment-capacity-amendment):
  its acceptance cites `limit:comment.maxBodyCodeUnits`, which the
  [External Citations Amendment](#external-citations-amendment) derives from
  GitHub's measured limit.
- The signals packet check serializes its attempts, which are not packet
  content, against the packet byte limit. That inflates the measured size
  near the limit. Phase 2 should decide what that check measures.
- The audit also found that handoff keeps only the first 4 packet gaps
  (`src/handoff.ts`), and a fifth would be dropped without notice. Traced on
  2026-11-17: every producer emits exactly one gap. Packet assembly stops at
  the first failing collector or at packet validation, and rendering emits
  one `brief` gap. No code joins gap lists, so nothing is dropped today. The
  cap protects no named resource, so phase 2 proposes deleting it, or else
  rejecting a longer list rather than truncating it.

## Resolved

- Sequencing (user, 2026-11-17): evidence-coverage B7 goes ahead first,
  because its per-member rollback at packet limits doesn't depend on any
  limit's value. Then this register's work continues.

- Adopter configuration (user, 2026-11-17): the GitHub request cap, model
  calls, concurrency, and analysis time, completion tokens, and the job
  budget with the evidence deadline (section 5). The job budget will come
  from a new reusable-workflow input.

- Comment limit (user, 2026-11-17): raise it toward GitHub's real limit
  instead of keeping the chosen value. Done on 2026-11-22; see the
  [External Citations Amendment](#external-citations-amendment).
  - A live probe settles the unit first: does GitHub count characters,
    UTF-16 code units, or bytes? The probe posts comments, so it is
    Ask-first and runs in a test repository the user chooses.
  - The new value is an `external` entry, set just under the measured limit
    with a stated margin for the comment metadata.
  - Until the probe runs, the limit keeps its chosen value, marked
    `unjustified`.
  - Raising it changes the comment capacity amendment's acceptance (at most
    the chosen cap), so that amendment needs its own approval.

- Zod 4 for config validation (user, 2026-11-17): investigated and not
  adopted. Configurable limits stay in the hand-written parser in
  `src/config.ts` and the published draft-07 schema. Zod 4 can attach typed
  metadata to a schema and export JSON Schema, so it could hold a configurable
  limit's default, maximum, and basis in one place. It was rejected for these
  reasons:
  - **Small gain.** It would replace only the field validators, about 90
    lines. File loading, the `limit:config.maxBytes` read, strict UTF-8
    decoding, checkout containment, defaults, and override provenance stay
    hand-written either way.
  - **A runtime dependency in the privileged action.** The approved
    [config parser spec](SPEC-config-parser.md) makes a parser dependency
    Ask-first and allows only `ajv`, for tests.
  - **Diagnostics.** The parser spec forbids echoing an unknown key. Zod's
    unknown-key issues carry the supplied key names, so a translation layer
    would be needed and tested against hostile names.
  - **The published schema.** It would become generated and need its own
    drift check. Zod can't express custom refinements in JSON Schema, so a
    rule written as one would be missing from the editor schema.
  - **Little help for this register.** Most limits are not configuration;
    only the settings in section 5 are.

  Revisit this if the config grows well beyond v1, such as several versions
  or many more sections.

- Intent (user, 2026-11-17, confirmed in an interview):
  - Every limit names a concrete harm or outside constraint, or is deleted.
    Capping foreseeable growth is not enough, and `unjustified` is
    migration-only.
  - No rendered `docs/limits.md`. The register file documents internal
    limits; adopters get a guide that links to exact values instead of
    copying them.
  - Specs stop stating limit values and cite register ids, so old numbers
    can't compete. The CI check covers spec text.
  - Adopter settings override repository defaults; the reviewer never goes
    past them; default changes reach only adopters who left the setting
    unset.

- Code enforcement tool (user, 2026-11-17): oxlint's built-in
  `no-magic-numbers` plus a small custom rule (section 4), not a script
  using the TypeScript compiler API. The installed oxlint is 1.89, run by
  `vp lint`.
  - A trial with a scratch configuration over non-test `src/` and `scripts/`
    reported 967 hits. It caught the duplicated comment cap in
    `src/comments.ts` and `src/reporting.ts`. Many hits are not limits, so
    the allowlist must be sized in planning.
  - In that trial, the setting to ignore 0, 1, and −1 did not appear to
    apply. The plan confirms the rule's options before relying on them.

## Open questions

None.

## External Citations Amendment

**Status: approved for planning, 2026-11-22; implemented for #381 and merged
into `main` in
[PR #425](https://github.com/andrewpucci/dependency-update-advisor/pull/425),
2026-11-22.** The user invoked `as-plan` on the reviewed draft after a
fresh-context review whose 15 findings were all fixed. The user approved its
plan for execution (`as-build auto`) the same day. The live probe measured
GitHub's comment limit in UTF-8 bytes,
`limit:github.comment.maxBodyBytes` (recorded on #381), and the
comment cap is derived from it (A3). It refines phase
2's "cite external limits, including the comment-limit probe" for
[#381](https://github.com/andrewpucci/dependency-update-advisor/issues/381)
(task L9 under #372). The user chose its scope in an interview on
2026-11-22. Effort tier: L. It changes the `external` basis type in
`src/limits.ts`, adds a probe script, needs a result captured from live
GitHub responses, and may change the comment limit, which amends the
[comment capacity amendment](SPEC-comment-experience.md#comment-capacity-amendment).

Decisions confirmed on 2026-11-22:

- L9 cites the three entries the L7 audit left awaiting citation, runs the
  comment-limit probe, and adds `external` entries for the platform figures
  that section 5's configurable limits need as hard maxima. Phase 3 then
  starts with every hard maximum either cited or recorded on #381 as having
  no fixed public figure.
- L9 raises `limit:comment.maxBodyCodeUnits` to just under the probed limit,
  but only after the user approves the new value and the change to the
  comment capacity amendment's acceptance. Both land in L9's pull request.
  A3 adds the other approved specs that state the cap, so the raise leaves
  no spec stating the old value.
- The probe is a committed, re-runnable script, not a one-off run. The S1
  discovery probes were one-off, and their entries say no repository command
  reproduces them.
- A probe-based value stays an `external` entry. The `external` basis gains
  an optional `probe` field. There is no sixth basis kind.

### Scope

| Entry                                      | Unit       | Today                                           | Source to cite                                                    |
| ------------------------------------------ | ---------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `comment.maxBodyCodeUnits`                 | code units | `unjustified`, awaiting L9                      | the probe (GitHub's docs state no comment limit)                  |
| `github.pageSize`                          | count      | `unjustified`, awaiting L9                      | the REST docs for the pull-request files endpoint's `per_page`    |
| `github.treeMaxFiles`                      | count      | `unjustified`, awaiting L9                      | the REST docs for the pull-request files endpoint's file maximum  |
| new: `github.token.restRequestsPerHour`    | count      | absent; section 5's GitHub request cap          | the REST rate-limit docs for `GITHUB_TOKEN`                       |
| new: `github.hostedJobMaxMinutes`          | minutes    | absent; section 5's job budget                  | the Actions limits docs for GitHub-hosted runners                 |
| new: `analysis.provider.maxOutputTokens`   | tokens     | absent; section 5's completion tokens           | the provider's model docs, for this repository's configured model |
| new: `analysis.provider.requestsPerSecond` | count      | absent; section 5's model calls and concurrency | the provider's rate-limit docs                                    |

The config has no default model; each adopter names one. So the output-token
entry cites the model in this repository's `.github/dependabot-review.json`
and says that adopters' models may differ. L12 decides how a per-model
maximum applies (user, 2026-11-22).

`github.treeMaxFiles` bounds the pull-request files listing
(`src/github-read.ts`), not a tree. Its id keeps its name, because ids are
stable. Renaming it is out of scope.

A new entry's `test` is `none: <reason>`, the register's existing format,
until L12 makes it the hard maximum of a setting. For example:
`none: platform figure; L12 makes it the hard maximum of the GitHub request
cap`. Each new entry still names what it `protects`.

### A1. The `external` basis records its check

Every `external` entry keeps `url`, `checked`, `platformValue`, and `margin`.

- `url` is the page that states the figure. For a probed figure, it is the
  public probe record on #381.
- `checked` is the date, `YYYY-MM-DD`, on which someone read the page or
  ran the probe. It is never in the future.
- `margin` says how far the entry's value sits below `platformValue` and why,
  or `none:` with a reason.

The optional `probe` field holds:

- `command`: the script name alone, such as `npm run probe:comment-limit`.
  It never includes the arguments, because they name the test repository;
- `repositoryType`: the test repository's visibility and owner type, such
  as "private, user-owned, github.com". It never names the repository.

When a page states no fixed figure, as for limits that vary by account tier,
L9 adds no entry for it. Instead, the agent drafts a comment for #381 that
names the page, the date checked, and what the page says in place of a
figure. Posting it is Ask-first. Section 5's hard maximum for that setting
goes back to the user in L12. L9 never invents a figure.

### A2. The comment-limit probe

`npm run probe:comment-limit -- --repo <owner/name> --issue <number>` posts
and edits comments on one issue or pull request that the user names. It
refuses to run without both arguments. It reads the token from
`GITHUB_TOKEN`, as `npm run measure:demand` does, refuses to run without it,
and never prints it. It reads the repository first, and refuses when the
repository GitHub returns is this one, `andrewpucci/dependency-update-advisor`.
It compares the returned name, so a renamed or redirected name is caught too.

`src/` has no GitHub write adapter for the probe to reuse, so the probe makes
its own REST calls with the request shapes the reviewer's comment writes use:

- create: `POST /repos/{owner}/{repo}/issues/{number}/comments` with `body`;
- update: `PATCH /repos/{owner}/{repo}/issues/comments/{id}` with `body`;
- delete: `DELETE /repos/{owner}/{repo}/issues/comments/{id}`.

It measures the body in full, as the reviewer does, so any marker or
metadata in a body counts.

**Cleanup.** The probe keeps the id of every comment it creates and deletes
each one before it exits. That includes when a later step fails and when the
run is interrupted. A create whose answer is lost, for example to a timeout,
leaves no id. So the probe ends with a sweep: it lists the issue's comments
since the run started and deletes each one that the token's user wrote with
a body the probe sent. The result reports how many probe comments it could
not delete. A count above zero means the user must delete them by hand.
The sweep needs the token's user, so the probe refuses to start when it
cannot read it, as with an Actions installation token. A sweep that cannot
list the comments is reported as `failed`, and the run fails, because a lost
create may then be left behind unseen.

Each write has one of three outcomes:

- **Accepted:** create answers Created or update answers OK, and the comment
  GitHub returns has exactly the body sent. This is the test the reviewer
  applies to its own writes (`src/comments.ts`). A success whose returned
  body differs, for example because GitHub truncated or normalized it, is
  not acceptance.
- **Rejected:** GitHub answers 422, and its `errors` list has an item that
  says the body is too long: an object whose `field` is `body` and whose
  message says "too long", or any other string or object whose text says
  "body is too long". The result keeps that text. The live runs on 2026-11-22
  found GitHub sending "Body is too long (maximum is N characters)" without
  `field` `body`. The record of a 422 it cannot classify shows each error's
  `field` and `code`, so a new shape can be read from the result.
- **Anything else** makes the whole result `inconclusive`. That includes
  any other 422, such as GitHub's "submitted too quickly" content limit; a
  403 or 429 secondary rate limit; a 5xx; a network error; and a success
  whose returned body differs.

It finds the limit L as the longest ASCII body that create accepts: L is
accepted and L + 1 is rejected. The search is bounded:

1. It sends one ASCII body well above the figure the Evidence section
   reports, which GitHub should reject.
2. If the rejection's message states a maximum M, it tests M and M + 1
   only.
3. Otherwise, or if M and M + 1 don't give accept-then-reject, it searches
   by halving between an empty body and the first body's length.

A register entry caps the probe's writes per run, and another sets the pause
between writes, so it stays well under GitHub's content-creation limits.
Reaching the cap makes the result `inconclusive`. Both entries get their
values and bases when the script is written.

With k = ⌊L/2⌋, it then tells the three candidate units apart with bodies
built from one repeated character:

| Body                                | Code points | UTF-16 units | UTF-8 bytes |
| ----------------------------------- | ----------- | ------------ | ----------- |
| L ASCII characters                  | L           | L            | L           |
| k copies of U+1F600 (astral)        | k           | 2k ≤ L       | 4k          |
| k + 1 copies of U+1F600             | k + 1       | 2k + 2 > L   | 4k + 4      |
| L copies of U+00E9 (two-byte BMP)   | L           | L            | 2L          |
| L copies of U+3042 (three-byte BMP) | L           | L            | 3L          |

The two astral rows tell the units apart. The U+00E9 row is a cross-check:
it tells no unit apart from the astral rows, but a rejection there with the
astral rows accepted fits no single unit. The U+3042 row catches a second
cap: if GitHub counted code points but also capped bytes, the astral rows
would look like UTF-16, but this row would be rejected. The result names a
unit only when every outcome fits that unit alone, with no second cap.
Otherwise it is `inconclusive`. It repeats the boundary pair on update. A
limit that differs between create and update is reported, not resolved.

The reviewer's bodies are full of line breaks, and the probe's are not, so
one more body checks line endings: L units of ASCII in which every other
character is `\n`. Every unit accepts it unless GitHub counts a line break
as more than one unit, for example by normalizing LF to CRLF first. The
result records whether it was accepted.

It prints one JSON result: the date, `repositoryType`, the unit, L for
create and update, each body's HTTP status, and the count of comments it
could not delete. It has no links and no repository name. For a 422 it
cannot classify, the write's record keeps GitHub's validation messages, each
cut to `limit:probe.commentLimit.detailCodeUnits`, with no documentation
link. The runner replaces the repository, owner, and user names wherever they
appear in the stop reason and in each detail message, so GitHub's text cannot
leak them. It leaves keys and the probe's own values alone, so a name that is
also an output word cannot corrupt the result (user, 2026-11-22, after the
second live run met an unrecognized 422).

Running it is Ask-first: the user names the test repository and approves the
run. Posting the result on #381 is a separate Ask-first step.

### A3. Raising the comment limit

The raise goes ahead only when all of these hold: the unit is UTF-16 code
units or code points, create and update agree on L, and the line-break body
was accepted. The reviewer keeps measuring code units. A string never has
more code points than code units, so this never undercounts. The agent
proposes a value and a margin, and the user approves both before any change.
The entry then becomes `external`, with the probe as its source.

In every other case, L9 changes nothing about the comment limit. It stops
and returns the result to the user. The cases are:

- **Unit is bytes.** A code-unit cap set to L would undercount non-ASCII
  bodies, so it cannot simply take L. The derived path below applies instead.
  Changing what `src/comments.ts` and `src/reporting.ts` measure is its own
  change.
- **Create and update disagree,** or **the line-break body was rejected.**
  No margin can be stated from what the probe measured.
- **`inconclusive`.**

In the last two cases the entry keeps today's value and stays `unjustified`,
and its note links the probe record. The parent spec allows no `unjustified`
entry after phase 2, so L11 cannot close until the user decides this entry's
basis.

**Derived path for a byte limit** (user, 2026-11-22, after the live probe
measured bytes). When the unit is bytes, create and update agree, and the
line-break body was accepted:

- GitHub's limit becomes its own `external` entry,
  `github.comment.maxBodyBytes`, with the probe as its source and the #381
  record as its `url`.
- `comment.maxBodyCodeUnits` becomes `derived`: ⌊bytes / 3⌋. One UTF-16 code
  unit is at most three UTF-8 bytes (an astral pair is four bytes for two
  units, and a lone surrogate, if sent at all, becomes at most three), so
  a body within the derived cap never exceeds GitHub's byte limit, whatever
  its text.
- The reviewer keeps measuring code units, so no renderer changes. The
  formula is exact, so no further margin is stated.
- Using the full byte limit for ASCII-heavy bodies, by measuring bytes, is
  its own change.

The raise also changes every approved spec that states today's value. Today
the comment cap is written out in the comment capacity amendment, the
[decision brief](SPEC-decision-brief.md), the
[managed comments](SPEC-managed-comments.md) spec, and this spec. Once the
value changes, `npm run check:limits` reports each of those lines'
allowlist entries as stale. So, in L9's pull request, each of those specs
cites `limit:comment.maxBodyCodeUnits` instead of the number, its
allowlist entries are removed, and each spec's change has its own approval.
This takes those lines out of L10.

Raising the cap to the derived value does not make the R1 replay render
([#348](https://github.com/andrewpucci/dependency-update-advisor/issues/348)).
Its required body was longer than the derived cap. Measuring bytes might fit
it, because it was mostly ASCII; that belongs to the byte-measuring change
or the comment capacity amendment's own changes. No other gate moves:
publication, parity, and cutover stay separate.

### Amendment verification

- Unit tests over the probe's pure parts:
  - each body builder returns exactly the code points, UTF-16 units, and
    UTF-8 bytes in the A2 table;
  - the classifier maps each unit's expected outcomes to that unit, and maps
    a mixed set to `inconclusive`. Mutation: swap the code-point and
    code-unit hypotheses;
  - a 403, 429, or 5xx anywhere in the outcomes gives `inconclusive`.
    Mutation: treat any non-2xx status as a rejection;
  - a 422 without a too-long `body` error, such as "submitted too quickly",
    gives `inconclusive`. Mutation: treat any 422 as a rejection;
  - a Created or OK answer whose returned body differs from the one sent gives
    `inconclusive`. Mutation: accept on status alone;
  - code-point outcomes with a rejected U+3042 row give `inconclusive`,
    not UTF-16. Mutation: drop the U+3042 row from the classifier;
  - the k-copy bodies keep the A2 inequalities for both an even and an odd
    L.
- Probe tests with a fake GitHub client, which post nothing:
  - the script refuses to start without `--repo`, `--issue`, or
    `GITHUB_TOKEN`, and refuses when GitHub returns this repository's name,
    including under a different spelling passed in `--repo`. Mutation:
    compare the argument instead of the returned name;
  - every created comment is deleted when a later write throws. Mutation:
    drop the cleanup;
  - a create whose answer is lost is found and deleted by the end sweep,
    and a comment the sweep cannot delete is counted in the result.
    Mutation: drop the sweep;
  - the sweep never deletes a comment by another user or with a body the
    probe did not send;
  - reaching the write cap gives `inconclusive` and sends no further write;
  - a rejection message that states M leads to exactly the M and M + 1
    tests; one that states no maximum leads to the halving search;
  - the printed result has no repository name, URL, or token.
- A register test fails when an `external` entry lacks an `https` `url`, or
  has a `checked` that is not a real `YYYY-MM-DD` date or is after today's
  UTC date, or has a `probe` whose `command` is not `npm run <script>` for a
  `package.json` script, with no arguments.
  Both dates are UTC, so the result does not depend on the runner's time
  zone. The date check runs only in this test, never when the register
  loads.
- After L9, no entry in the scope table is `unjustified`, except the comment
  entry in one of A3's stop cases.
- After a raise, the existing exact-limit comment tests pass with the new
  value. Phase 1's boundary tests still pass. No spec states the old value,
  and `npm run check:limits` passes with those allowlist entries removed.
- `npm run check:limits`, `vp lint`, and the full check set pass.

### Amendment boundaries

- **Always:** record the date each source was checked; keep the probe
  repository's name and links out of this public repository; delete the
  probe's comments.
- **Ask first:** each probe run and its repository; posting the probe result
  on #381; the new comment value and margin; amending each spec that states
  the comment cap; the comment entry's basis after an A3 stop case.
- **Never:** run the probe against this repository or a consumer's;
  record a figure no source or probe states; shrink a margin without saying
  why; treat a probe result as covering a unit it did not test.

### Amendment out of scope

- Renaming `github.treeMaxFiles`, because ids are stable.
- Measuring comment bodies in bytes. If the probe finds bytes, that is its
  own change.
- Reproducing the S1 discovery probes as scripts. Their entries keep their
  approved notes.
- Making any limit configurable. That is phase 3.

### Amendment open questions

None.
