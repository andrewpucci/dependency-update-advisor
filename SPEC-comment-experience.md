# Spec: Dependabot review comment experience — 2026-09-23

**Status:** Draft revision for the shared reviewer. This spec describes the
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

Deterministic Markdown rendering from validated review data in Node.js ESM,
with source-adjacent Vitest tests. Use GitHub's native Markdown, links, and
controlled `<details>` sections for low-priority material. No client-side code,
new dependency, or external publishing service is required.

## Commands

```sh
npm ci
npm test -- --run
npm run lint
npm run check
```

Until extraction, the source repository's focused renderer command is
`vp test run .github/actions-scripts/dependabot-review/reporting.test.ts`.

## Project Structure

```text
SPEC-comment-experience.md                            → maintainer-facing comment contract
src/reporting.mjs                                     → proposed deterministic renderer
src/reporting.test.ts                                 → proposed renderer tests
source repo: .github/actions-scripts/dependabot-review/ → current parity baseline
```

## Code Style

Render from structured, validated fields. Keep headings plain, sentences
short, and links descriptive. Escape untrusted text and link targets before
interpolating them into Markdown.

```js
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
