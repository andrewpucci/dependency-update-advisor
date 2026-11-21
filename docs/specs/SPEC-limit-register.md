# Spec: Limit Register

Status: approved for planning by the user on 2026-11-17; the user approved its
[plan](../../tasks/plan-limit-register.md) for execution the same day.
Revised the same day to match the intent the user confirmed in an interview
(see Resolved). A cross-cutting supporting contract for
`shared-review` in [the capability map](README.md).

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
  reviewer's 15 minutes is the shared workflow's own `timeout-minutes`.
- **REST rate limit.** `GITHUB_TOKEN` gets 1,000 REST requests per hour per
  repository, or 15,000 for Enterprise Cloud resources
  ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- **Comment size.** GitHub's REST docs don't state a comment-body limit. API
  errors report 65,536 characters, and third-party sources disagree on whether
  that counts characters or bytes. The reviewer's 50,000 code units is a chosen
  margin under an observed, undocumented limit.

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
    15 per member, because they come from fixed call sites with no loop over
    untrusted data, multiplied by the 128-change packet limit. A structural
    entry names the test that pins it;
  - `measured`: the measurement command, the corpus, the statistic (such as
    p95 or max), the headroom, and the date measured;
  - `safety`: why this number protects the named resource. For a guard on
    untrusted input, that is the margin above the largest legitimate value
    observed and below the point where harm begins;
  - `unjustified`: an explicit, visible marker for a value with no basis yet,
    with a pending note. It exists only during migration, and none may
    remain after phase 2.
- `effect`: what happens when the limit is reached. This means the outcome and
  reason (for example `budget` on one member, a whole-stage `budget`, or a
  `render-size` failure), and whether partial results are kept.
- `test`: the test that pins the at-limit and over-limit behavior, or `none`
  with a reason.
- `configurable`: absent, or the adopter setting with its default and hard
  maximum (section 5).

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

- **Code.** Re-hardcoded identity bounds, the duplicated 50,000 comment cap,
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
  spelling (`50000`, `50,000`, or `50_000`). An allowlist names each line where
  that number means something else, with a reason. During migration, the
  allowlist also holds each approved spec's values as pending amendments.
  That part must be empty after phase 2.
- **Citations:** a spec cites a `limit:<id>` that doesn't exist.
- **Tests:** an entry names a test that doesn't exist.
- **Migration:** after phase 2, any entry is still `unjustified`.

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
an integer from 1 through 30 that defaults to 1. It becomes the first entry
with `configurable` set. Its bounds, 1 and 30, need a stated basis like any
other limit.

Configuration is read only from the trusted default-branch file, as today. The
v1 parser rejects unknown keys, so a new `limits` section needs a parser
change. Consumers pin the reviewer by SHA, so an older reviewer never sees the
field. The job budget is set in the shared reusable workflow, not the caller,
so making it adopter configuration also needs a workflow input. That is a
separate decision.

Under the review-config spec's boundaries, adding a configurable category is
Ask-first.

The user approved these as adopter configuration on 2026-11-17. Each keeps
today's value as its default, and each needs a cited hard maximum before
phase 3:

- **GitHub request cap:** the total research requests on the adopter's
  token. Hard maximum: the documented `GITHUB_TOKEN` rate limit (1,000
  requests per hour per repository) less headroom.
- **Model analysis:** calls (32), concurrency (2), and analysis time
  (600,000 ms). Hard maximum: the provider's documented limits and the job
  window.
- **Completion tokens:** 16,384. Hard maximum: the provider's maximum output
  tokens.
- **Job budget and evidence deadline:** 15 minutes and 240,000 ms. Hard
  maximum: the 6-hour hosted-job limit. This needs a new reusable-workflow
  input, because `timeout-minutes` lives in the shared workflow. The pipeline
  must derive its job window from that input.

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
  `if (body.length <= 50_000)` to a module, and add
  `const MAX_BODY = 50_000;` to a module.
- `npm run check:limits` fails on each of these and passes on the migrated
  tree:
  - a workflow `timeout-minutes` that differs from its entry;
  - a register value written into a spec line that is not allowlisted
    (mutation: add "at most 50,000 code units" to an approved spec);
  - a `limit:<id>` citation to an id that doesn't exist;
  - an entry that names a missing test;
  - after phase 2, an `unjustified` entry.
- Phase 1 changes no outcome. The full check set passes unchanged, including
  the existing boundary tests (exact 50,000 body, 128/129 changes, 16,384-byte
  config, 3,000-file listing).
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
  its at-most-50,000 acceptance depends on the comment limit, which is chosen.
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
  instead of keeping 50,000.
  - A live probe settles the unit first: does GitHub count characters,
    UTF-16 code units, or bytes? The probe posts comments, so it is
    Ask-first and runs in a test repository the user chooses.
  - The new value is an `external` entry, set just under the measured limit
    with a stated margin for the comment metadata.
  - Until the probe runs, the limit stays at 50,000, marked `unjustified`.
  - Raising it changes the comment capacity amendment's acceptance (at most
    50,000 code units), so that amendment needs its own approval.

- Zod 4 for config validation (user, 2026-11-17): investigated and not
  adopted. Configurable limits stay in the hand-written parser in
  `src/config.ts` and the published draft-07 schema. Zod 4 can attach typed
  metadata to a schema and export JSON Schema, so it could hold a configurable
  limit's default, maximum, and basis in one place. It was rejected for these
  reasons:
  - **Small gain.** It would replace only the field validators, about 90
    lines. File loading, the 16,384-byte read, strict UTF-8 decoding,
    checkout containment, defaults, and override provenance stay
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
