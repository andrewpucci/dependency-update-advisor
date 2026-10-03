# Pull request review

Use this guide to review changes to Dependency Update Advisor itself. The
generated Dependabot comment has its own
[comment-experience contract](specs/SPEC-comment-experience.md).

Authors fill in the [PR body template](../.github/pull_request_template.md).
Reviewers read the diff, [context](../CONTEXT.md),
[capability map](specs/README.md), and affected spec sections, then apply the
checks below. Before selecting a review action, account for every changed
file and affected spec criterion with evidence, an explained exclusion, or
an unresolved review gap. Record those gaps in the summary; approval applies
only to the scope supported by evidence.

Copy the summary below into GitHub's review submission. GitHub auto-fills PR
bodies from a template on the default branch; this reviewer summary is manual.

## Review summary template

Replace each prompt with evidence. Keep the decision and next action first.
Use GitHub's matching review action: **Approve**, **Request changes**, or
**Comment** for an incomplete review or discussion. A partial review must
identify its limits; it must not imply the whole PR is approved.

```markdown
## Review decision

Decision: Approve / Request changes / Comment (choose one)
Next action: <concrete author or maintainer action>
Reviewed head: <full PR head SHA>
Scope: <files/modules and spec sections reviewed; exclusions or gaps>

## Blocking findings

- <file:line or spec section — failure scenario and impact; evidence;
  requested fix and how to validate it. State "None found" if accurate.>

## Validation and contract checks

- <exact command, revision, and result; distinguish checks run personally
  from author/CI evidence inspected; name checks not run and why>
- <applicable boundaries below: evidence or remaining gap; use N/A with
  a reason where useful, without copying every check>

## Non-blocking feedback

- <Suggestion or Nit: location, reason, and optional improvement.
  Omit this section if empty.>
```

Recheck changes to the reviewed head before carrying an approval forward.
Put line-specific findings on the diff and reference them in the summary.
State the concrete failure and its impact before proposing a fix. Separate
verified defects from questions and optional preferences; avoid duplicating
formatter output. An unverified area remains a review gap.

## Checks for every change

- Confirm the change has one clear purpose and follows the affected spec's
  recorded approval state. Treat drafts as proposals. Identify requested
  contract changes and update specs, their map, or ADRs when applicable.
- Check behavior, edge cases, useful regression tests, readability, and
  unnecessary complexity. For spec-only changes, check observable acceptance
  criteria and consistency with the other contracts; do not claim runtime
  behavior has been verified.
- Inspect the diff for private consumer links, exact source paths, excerpt
  allowlists, credentials, raw model payloads, and unsanitized fixtures.
  Evidence that must stay private remains in the consumer repository.
- Follow [contribution checks](../CONTRIBUTING.md#checks) and the affected
  spec's validation requirements. Inspect [available scripts](../package.json)
  before running commands. Record the exact revision, working-tree changes,
  commands, results, and checks not run with reasons. Distinguish checks run
  personally from author or CI evidence inspected.

## Checks by affected contract

Apply only the relevant groups. These prompts direct attention to existing
contracts; the linked specs own the complete requirements and test cases.

- **Workflow and publication:** Verify the intended CI run, repository,
  Dependabot PR, and current head, including a head recheck before writes.
  Privileged execution uses trusted code and config, full-SHA pins, named
  secrets, and minimum permissions; it never executes PR-head code or
  consumes untrusted artifacts or caches. Obsolete or duplicate events
  cannot overwrite a newer review. Check failed status and comment-write
  paths, not just success. See [shared review](specs/SPEC-shared-review.md)
  and [ADR 0002](adr/0002-privileged-review-boundary.md).
- **Evidence collectors:** Check immutable base/head inputs, updates,
  additions, removals, and direct/transitive classification where applicable.
  API omissions, empty responses, permission failures, malformed input, and
  exhausted bounds retain explicit gaps. One ecosystem's complete evidence
  cannot hide another's incomplete coverage. Include affected scenarios such
  as omitted Actions updates, unpaired npm additions, unavailable uv
  comparison, and introduced vulnerabilities. See
  [npm](specs/SPEC-npm-evidence.md),
  [Actions](specs/SPEC-actions-evidence.md),
  [uv](specs/SPEC-uv-evidence.md), and
  [ADR 0003](adr/0003-immutable-files-for-dependency-inventory.md).
- **Configuration and model analysis:** Verify trusted, bounded config and
  runtime validation of external data. No provider or source excerpts are
  selected by default; opt-in and consumer policy remain local. Overrides
  cannot hide findings or coverage gaps. Check bounded requests and model
  output validation, unavailable analysis, and that tokens, excerpts, and
  raw payloads stay out of logs. Mistral is the only tested v1 adapter. See
  [configuration](specs/SPEC-review-config.md) and
  [analysis providers](specs/SPEC-analysis-providers.md).
- **Status and comment experience:** Distinguish completed execution from
  the advisory recommendation: a completed `do_not_merge` can have a success
  status; an incomplete review cannot. The v1 status remains advisory.
  Failures preserve the prior comment with a failed current-head status;
  obsolete runs cannot publish for a new head. Check App-owned comment
  identity, decision and next action first, visible coverage limits and
  reviewed head, escaped untrusted text, and vetted links. See
  [shared review](specs/SPEC-shared-review.md) and
  [comment experience](specs/SPEC-comment-experience.md).
- **Action packaging:** Once implemented, verify strict TypeScript and
  runtime validation, and that the documented build reproduces the committed
  JavaScript bundle without drift. See
  [ADR 0001](adr/0001-typescript-source.md).
- **Adoption and cutover:** Verify each consumer's explicit local config,
  SHA-pinned caller, current-head success and invalid-config failure, parity
  evidence, and reversible rollback. Keep the old reviewer active until all
  adoption and parity gates pass. Public summaries must omit private records.
  See [adoption](specs/SPEC-repo-adoption.md) and
  [parity and cutover](specs/SPEC-parity-cutover.md).

## Research behind this format

The following primary guidance informed this template, researched 2026-10-03:

- [GitHub's template documentation](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository)
  explains template placement and automatic PR-body population. A short
  author template supplies purpose, contract references, and validation.
- [Google's review checklist](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
  covers design, behavior, complexity, tests, documentation, and review
  scope. Conditional prompts here focus those concerns on the affected
  module rather than requiring every author to fill every checklist.
- [Google's review-comment guidance](https://google.github.io/eng-practices/review/reviewer/comments.html)
  calls for clear rationale and labeled optional comments. The summary
  separates blockers from suggestions and asks for impact and validation.
- [GitHub's review actions](https://docs.github.com/en/pull-requests/reference/pull-request-reviews)
  distinguish approval, requested changes, and comments. The summary pairs
  a decision with a reviewed head and explicit limits.

The repo-specific prompts come from approved specs and accepted ADRs. This
guide adds no new product gates, approval states, or quality thresholds.
