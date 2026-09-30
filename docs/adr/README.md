# Architecture decision records

This repository uses MADR 4.0.0's
[minimal format](https://github.com/adr/madr/blob/4.0.0/template/adr-template-minimal.md),
with a status line and the existing `docs/adr/` location. The format is kept
here so writing an ADR does not require installing a tool.

An ADR explains one significant architectural choice so a future maintainer
can understand why it was made and when to reconsider it. Write one for a
lasting choice about structure, interfaces, dependencies, security boundaries,
or construction techniques. Keep feature requirements in the
[module specs](../specs/README.md) and work items in issues or plans. Do not
create ADRs for tentative ideas or session history.

Use `docs/adr/NNNN-short-title.md`, with the next four-digit number. Give the
file and heading a title that names the decision. Keep the record short; add
detail only when it helps explain a real tradeoff.

## What to write

- **Context and Problem Statement:** State the problem and the constraints that
  made the choice consequential.
- **Considered Options:** Name the chosen option and the real alternatives that
  informed the decision. Keep the list short.
- **Decision Outcome:** Name the chosen option and explain why it meets the
  constraints better than the alternatives.
- **Consequences:** Record the expected benefit and the cost, limitation, or
  follow-up obligation. State how to confirm the choice when that is useful;
  do not claim unmeasured results.

Use `proposed` while seeking review. Change to `accepted` and record the date
only after explicit approval. If a later decision replaces an accepted ADR,
write a new one, link the two, and mark the old one `superseded`. Keep the old
record so its rationale remains available. Correct typos in place; do not
silently rewrite an accepted decision.

Copy this skeleton only when a specific decision is ready to record:

```markdown
# ADR NNNN: <decision>

Status: proposed, YYYY-MM-DD.

## Context and Problem Statement

<Problem and decision-driving constraints.>

## Considered Options

- <Chosen option>
- <Real alternative>

## Decision Outcome

Chosen option: <option>, because <reason>.

### Consequences

<Benefit and cost or limitation.>
```
