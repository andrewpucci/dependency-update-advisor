# Spec: Dependabot Review Comment Experience

Status: approved for planning, 2026-09-23. This spec describes the
maintainer-facing comment; the shared workflow spec owns when a comment is
published and how its current-head status is reported.

## Objective

Help the maintainer decide what to do with a Dependabot pull request after one
quick scan. The comment must lead with its advisory recommendation, the next
action, and any uncertainty that changes the decision. A reader who continues
should find the relevant package evidence and sources without reading a
release-note dump.

The reader is a maintainer reviewing a single or grouped Dependabot PR, often
on GitHub's mobile view. The comment is a decision brief, not a CI report or a
substitute for required branch checks.

## Tech Stack

Deterministic Markdown rendering from validated review data in strict
TypeScript for Node.js 24 ESM, with source-adjacent Vitest tests. Use GitHub's
native Markdown, links, and controlled `<details>` sections for low-priority
material. The renderer requires no client-side code, new dependency, or
external publishing service.

## Commands

After implementation provides the test, check, and build scripts, validate
the shared repository with:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
npm run build
```

Until extraction, the source repository's focused renderer command is
`vp test run .github/actions-scripts/dependabot-review/reporting.test.ts`.

## Project Structure

```text
docs/specs/SPEC-comment-experience.md                 → maintainer-facing comment contract
src/reporting.ts                                     → proposed deterministic renderer
src/reporting.test.ts                                 → proposed renderer tests
source repo: .github/actions-scripts/dependabot-review/ → current parity baseline
```

## Code Style

Render from structured, validated fields. Keep headings plain, sentences
short, and links descriptive. Escape untrusted text and link targets before
interpolating them into Markdown.

```ts
lines.push(`**Next action:** ${escape(action)}`);
```

Preserve the managed-comment marker, review digest when present, and full
reviewed head SHA in machine-readable metadata.

## Requirements

### 1. Lead with the decision

1. The first visible screen must answer, in this order: what the advisory
   recommendation is, what the maintainer should do next, and whether evidence
   is complete. Never build toward a conclusion after package details.
2. State `decision_incomplete` and `analysis_unavailable` as **no merge
   recommendation**. State `do_not_merge` as a hold with its concrete blocker.
   A completed review may recommend `merge` or `merge_with_followups`, subject
   to policy. Avoid approval language for an incomplete review.
3. Place a verified blocker immediately after the opening. If both a blocker
   and unresolved evidence exist, show the blocker first, then the decision
   queue. The verdict must not hide either condition.
4. Do not restate GitHub CI status or imply that an advisory recommendation is
   a required branch check. The separate `dependabot-review` commit status
   reports review execution, not the merge verdict.

### 2. Give the reader a route through the evidence

1. Follow the opening with only the sections that apply, in this order:
   **Reasons not to merge**, **Decision queue**, **Decision coverage**,
   **Package assessments**, **Non-blocking follow-ups**, **New capabilities to
   adopt now**, and lower-priority detail. This is priority order, not package
   or collection order.
2. Each decision-queue item names the affected package or direct-update
   group, the changed-update count, the evidence gap, and one concrete action.
   Never substitute a generic "manual review required" or "and N others" for
   unresolved decision units.
   When evidence is partial but the decision unit is assessed, name the
   affected package and its exact next action in **Non-blocking follow-ups**.
3. Summarize coverage near the top: changed updates, completed decision units,
   and unresolved decision units. Explain when a group was assessed as one unit
   rather than claiming each transitive member was separately researched.
4. Keep each package or grouped decision-unit assessment compact: package and
   version change, direct or transitive role when known, evidence status,
   policy result, and a short reason with a vetted source link. Label
   repository context separately from upstream evidence. Do not ask the reader
   to infer the meaning of an uncaptioned count or status.
5. Show only concrete **Use now** actions with their supporting context and
   upstream source. Put **Consider later** after decision-relevant material.
   Preserve **Not relevant** rationale and source in a collapsed `<details>`
   section. Avoid duplicate feature descriptions and release-note summaries.
6. Give a copyable remediation prompt or external-research handoff only where
   it helps resolve a blocker or decision-queue item. Keep such material below
   the main decision brief and collapsed when it is long. For each blocker,
   retain its impact, supporting evidence, remediation, and validation step.

### 3. Use restrained, consistent formatting

1. Use one heading level for peer sections, short paragraphs, and bullets for
   distinct actions or findings. Use bold only for the verdict, next action,
   and short labels within lists. Do not combine bold, italics, and decorative
   symbols on the same point; never underline non-links or use decorative
   color, emoji, borders, or filler images.
2. Make links say what they lead to, such as a package release or advisory,
   rather than repeating "source" for every link. Render only vetted URLs.
3. Every table or count, if one is ever used, must state what it measures.
   Prefer a short sentence to a dense table in the PR timeline.
4. If the comment approaches GitHub's size limit, keep the opening,
   blockers, every unresolved decision-queue item, coverage limits, and
   concrete next actions. Omit lower-priority detail with an explicit note.
   If required decision content cannot fit, fail comment generation rather
   than publish a misleading partial recommendation.
5. Escape Markdown structure, HTML, code fences, and links supplied by
   external evidence so a package name or model string cannot alter headings,
   hide a warning, or add an unvetted destination.

### 4. Make the review's scope and age visible

1. The title must identify the document as a Dependabot review and include
   the repository and PR context. Show the generated date in UTC and a visible
   link to the reviewed head near the opening. Retain the full SHA in the
   managed marker or adjacent metadata for exact matching.
2. A rerun updates the same managed comment. The displayed head and date must
   change with the reviewed result. If a later run fails before it can safely
   update the comment, the older comment remains unchanged and the current
   PR-head `dependabot-review` status fails with a run link. The older comment
   must not be described as a review of the new head.
3. Preserve the established managed-comment identity and upsert behavior;
   do not post duplicate comments for one PR.

## Testing Strategy

Use focused renderer assertions, not snapshots. Cover all verdicts, an
incomplete grouped PR, a blocker plus unresolved evidence, empty and populated
optional sections, escaping, validated links, and the size boundary. Assert
the first-screen order, complete decision queue, heading consistency, visible
head/date, managed marker, and that an older comment remains attributable to
its old head after a failed current-head run.

Review one rendered comment in GitHub's desktop and narrow mobile layouts.
Within the opening, the maintainer should be able to state the recommendation,
next action, and coverage limit without expanding details. Use the existing
grouped-PR dry-run fixture and the parity matrix from the shared-review
cutover spec to compare content with the current reviewer.

## Comment Capacity Amendment

**Status: approved for planning, 2026-11-16.** The user explicitly approved
the reviewed draft (merged in PR #351) after a fresh-context review whose
blocking findings were resolved. Plan and execution approval remain separate
gates. Scoped to
[#348](https://github.com/andrewpucci/dependency-update-advisor/issues/348).
Effort tier: L. It amends this contract and
[O1 decision brief rendering](SPEC-decision-brief.md) requirements 3, 4, and
7, and changes the deterministic renderer and its behavior checks. It does not
authorize publication, a production claim backend, a new action permission,
a change to M1 model validation, or a live rerun.

### Decision for review

Render each repeated deterministic finding and evidence gap once, naming
every affected package, instead of once per decision unit. Group unresolved
units only when their reason, action, and gaps are identical apart from
package identity, and name each unit in the group. Render the
[evidence coverage spec's](SPEC-evidence-coverage.md#4-reader-facing-evidence-states)
three evidence states. Required text is never shortened. A valid lockfile
fan-out whose distinct required content fits must render rather than return
`render-size`. This does not make a review complete or authorize
publication.

### Evidence

The R1 no-write rehearsal on Dependabot PR #276 (head `657f221`) ended
`render-size` after 12 calls at split depth 0. A local no-write replay of
that run's recorded GitHub, registry, and model responses reproduced the
same result. The recording stays outside the repository because it holds raw
model payloads. Its sanitized measurements:

- 93 standalone decision units: 2 direct and 91 transitive updates, with no
  direct-update group. 72 were assessed (71 `merge_with_followups`, 1
  `merge`); 21 were rejected in three whole batches, all category `reference`.
- 93 units have only 91 distinct package names: `vite-plus` and
  `@oxc-project/types` each appear twice.
- The required body, excluding the already optional Package assessments
  (38,999 code units), is 105,413 code units:

  | Section                 | Code units | Content                                                               |
  | ----------------------- | ---------: | --------------------------------------------------------------------- |
  | Non-blocking follow-ups |     51,974 | 253 evidence-gap lines and 71 model follow-ups (10,558 of model text) |
  | Finding lines           |     35,489 | 183 informational findings, each one of two fixed sentences           |
  | Decision queue          |     17,134 | 21 rejected units carrying 83 gap texts                               |
  | Header and coverage     |        816 |                                                                       |

- 276 of the 336 gaps are three repeated conditions: malware, upstream, and
  vulnerability evidence unavailable for 92 units.

Model prose is about one tenth of the required body. Without it, the
renderer's own text is about 95,000 code units, so bounding model output
cannot fit this PR. Repetition across units can: the escaped list of all 93
package names is about 2,700 code units. A simulation of items 1 and 2 on the
recorded sections gives a required body of 29,513 code units: Decision queue
2,218, finding lines 5,879, Non-blocking follow-ups 20,600, and header and
coverage 816. The simulation is not the implementation; the replay check
below must confirm the implemented result before any re-pin.

### Proposed contract

1. **Merge identical deterministic records.** Findings with identical kind,
   rationale, applicability, severity, and rendered citations render as one
   line that names every affected package. Assessed-unit evidence gaps with
   the same category, status, and reasons render in Non-blocking follow-ups as
   one line that names every affected package and states the action once.
   This is the normal form, not a size fallback. A merged line names each
   member; it never substitutes a count or "and N others". Members that share
   a name are distinguished with the qualifier that Unchecked signals already
   uses (ecosystem, location, and version).
2. **Group unresolved units only when identical.** Decision-queue units whose
   reason, recovery action, changed-update count, and complete gap set
   (each gap's category, status, and reasons) are identical, apart from
   package identity, may share one item. An unresolved unit's gaps stay in
   its queue item, not in Non-blocking follow-ups. The item names each unit
   with its changed-update count, and states the shared gap and one concrete
   action. Units that differ in any of those fields stay separate. O1
   requirement 4 is amended to permit this; it still forbids replacing units
   with an aggregate.
3. **Render the evidence states.** This amendment owns rendering of the
   states that the evidence coverage spec defines:
   - **Found:** each finding renders by its existing rule: a blocker for a
     hold, otherwise a merged finding line. A category that is `partial` and
     also has a finding renders both the finding and its coverage gap.
   - **Checked, none found:** one required line per category, placed in
     Decision coverage after its counts, that names every package whose
     category is `available` with no finding. The line has no action. It
     survives size pressure like a coverage limit. This amends §2.1 of this
     contract and O1 requirement 3, which place it, and §3.4 of this contract
     and O1 requirement 7, which add it to the content preserved when the
     body is too large.
   - **Not checked:** the merged gap lines of item 1 and the queue items of
     item 2. Each states the action that the evidence coverage spec assigns
     to its reasons. A gap says to rerun CI only when that spec's action for
     every one of its reasons allows it.
4. **Keep model text per unit.** Model follow-ups, blocker text, and
   assessment reasons are not merged, deduplicated across units, shortened,
   or reordered. The renderer adds no model text to merged deterministic
   lines.
5. **Fallback and `render-size`.** If the merged body exceeds 50,000 code
   units, the renderer omits optional sections in the existing priority order
   with the existing notice. If the required body still exceeds the limit, it
   returns `size`. W2 reports `render-size`, a fail-closed outcome with the
   existing `brief`/`budget` gap; the trace and stderr stay redacted as W2
   specifies. No required text is shortened or truncated.
6. **No new disclosure channel.** Merged lines add no raw response, source
   excerpt, error text, credential, URL, or CI result to the comment, trace,
   or stderr. Package names stay escaped and autolink-neutralized.

The plan chooses the exact merged-line and state-line wording. Those choices
must satisfy the verification below.

### Required verification

- **Committed synthetic fixture** shaped like the R1 measurements: 93
  standalone units, including two pairs of same-named members; two shared
  informational findings per unit; three or four shared unavailable gaps per
  unit, with reasons `budget`, `missing`, and `unsupported`; 21 unresolved
  units across at least two distinct gap sets; and 71 model follow-ups of
  about 150 characters. It renders at or below 50,000 code units. Every
  member, including each same-named member, appears in each merged record
  that applies to it, and every unresolved unit, follow-up, action, and
  required citation is visible. It also includes an assessed `merge` unit
  with no evidence category, gap, finding, or follow-up, and asserts that the
  unit is counted in coverage.
- **Checked-state fixture:** the same 93 units with every required category
  `available` and no finding, except one `partial` category with a finding,
  renders at or below 50,000 code units. It shows one "checked, none found"
  line per category naming each member, and shows both the finding and the
  gap for the partial category. A variant with optional sections large
  enough to force omission still shows every checked line in Decision
  coverage.
- **Reason-specific actions:** a merged `budget`, `missing`, or `unsupported`
  gap never says to rerun CI; a gap whose only reasons are `rate_limit` or
  `timeout` does.
- **Named mutations fail those checks:** merging records that differ in any
  rendered field or citation; dropping one member from a merged line;
  collapsing same-named members; replacing names with a count; grouping
  unresolved units with different actions or gaps; moving an unresolved unit's
  gaps into Non-blocking follow-ups; merging, shortening, or dropping model
  text; rendering a `partial` category with a finding as found only; listing
  an unchecked package as checked; omitting a checked line under size
  pressure; and saying to rerun CI for a `budget` gap.
- **Irreducible boundary:** a fixture whose distinct required records cannot
  fit after merging still returns `size`, and W2 still reports
  `internal-failure` with reason `render-size` and the `brief`/`budget` gap.
- **Preserved checks:** existing escaping, autolink, priority-order,
  exact-50,000 boundary, and optional-omission checks continue to pass. Full
  repository checks and the reproducible action-bundle check run on the
  implementation revision.
- **Local R1 replay before re-pin:** replaying the recorded R1 responses
  against the implementation renders a body at or below 50,000 code units
  that names every member with a required record (92 of the 93), all 21
  unresolved units, and all 71 follow-ups. The one assessed `merge` unit has
  no evidence category, gap, finding, or follow-up, so it appears only in the
  optional Package assessments, as O1 requirement 7 already allows. The
  sanitized result is recorded on #348. The R1 caller is re-pinned only after
  this passes.

### Amendment boundaries

- **Always:** account for every required decision-bearing record, name every
  affected member, preserve trusted links and escaped output, keep the
  50,000-code-unit bound, and leave the no-write and publication boundary
  unchanged.
- **Ask first:** change which records are required, merge or shorten
  model-authored text, change the size limit, the managed-comment identity,
  status semantics, workflow permissions, or M1 validation.
- **Never:** replace named members or units with a count, omit or shorten a
  blocker, gap, or action, show an unchecked category as checked, expose a raw
  model response or other sensitive input, or treat a comment as completed
  publication.

### Out of scope

- M1 validation is unchanged. The 21 `reference` rejections, each failing a
  whole batch, need their own issue.
- Evidence availability and reason-to-action mapping are owned by the
  [evidence coverage spec](SPEC-evidence-coverage.md). Upstream, malware, and
  vulnerability evidence was unavailable for 92 of 93 units because research
  stages stopped on their limits and discarded completed work, not because
  checks found nothing.

## Retry Time Amendment

**Status: approved for planning and execution, 2026-11-21, with the
amendment it comes from; implemented on branch
`claude/dependency-update-advisor-spec-965015` for #421, pending review and
merge.** From A4 of the
[scaled-share function amendment](SPEC-evidence-coverage.md#a4-retry-time-in-the-review)
to the evidence coverage spec. When a gap's action is "Rerun CI later" and
the packet's `retryAfter`, passed to the renderer as
`DecisionBriefInput.retryAfter`, is set, the action reads "Rerun CI after
HH:MM UTC.": 24-hour, zero-padded UTC time, rounded up to the next whole
minute. The text is built from the validated timestamp, not escaped
untrusted text. Every other action, and the rule that a gap with a
non-transient reason never says to rerun CI, is unchanged.

## Boundaries

- **Always:** Put decision and next action first; name incomplete evidence;
  cite vetted upstream claims; keep the reviewed head and date visible.
- **Ask first:** Change the managed-comment identity, add reactions or reviews,
  post additional comments, or make the advisory status a required check.
- **Never:** Present unavailable evidence as verified, hide an unresolved
  decision unit to fit the size limit, reproduce CI status, or render external
  HTML beyond the controlled `<details>` structure.

## Success Criteria

1. The opening lets a maintainer identify the advisory recommendation, next
   action, evidence completeness, and reviewed head without scrolling through
   package detail.
2. Every unresolved decision unit has a specific visible action; every
   `do_not_merge` blocker remains visible even when other evidence is missing.
3. Each package assessment distinguishes vetted upstream evidence from local
   context and identifies any unknown role or evidence status.
4. Lower-priority capabilities never displace a blocker, coverage limit, or
   actionable item, including at the comment-size boundary.
5. The managed comment and current-head execution status cannot make an old
   recommendation appear current after a failed new review.

## Open Questions

None for the comment hierarchy. Exact wording and the future shared renderer
path can be settled during implementation without changing these reader-facing
requirements.
