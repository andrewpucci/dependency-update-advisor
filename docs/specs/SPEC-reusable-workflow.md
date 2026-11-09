# Spec: W1 Reusable Workflow

Status: approved for planning, 2026-11-08. The user reviewed the draft,
including two fresh-context Opus reviews, and invoked `as-plan`. The user
then approved the plan and the task split on 2026-11-08. Execution approval
is a separate gate.
Supporting contract for `shared-review` in [the capability map](README.md),
scoped to [W1 #25](https://github.com/andrewpucci/dependency-update-advisor/issues/25).
The approved [shared-review contract](SPEC-shared-review.md) (requirements 2–4
and 9), [ADR 0002](../adr/0002-privileged-review-boundary.md), and
[action package](SPEC-action-package.md) remain authoritative; this draft
amends none of them, but the W1 implementation PR carries the reviewed
amendments that its departures need (see [Amendments](#amendments-in-the-w1-pr)).
A1 #24 is closed, so the committed bundle and
`action.yml` exist on `main`. A1 declared no action inputs and left them to
W2; the user approved declaring them here (Requirement 12), which is the
"add action inputs" ask-first case in A1's boundaries.

## Objective

Publish `.github/workflows/dependabot-review.yml`, a `workflow_call` workflow
that a consumer's small `workflow_run` caller pins to a full commit SHA. The
privileged job resolves the reviewer action from that same commit, receives only
three named secrets and minimum token permissions, and declares no step, input,
or credential that reaches PR code, upstream artifacts, or caches. The workflow
file can show what it declares. That the bundle never calls the artifact or
cache APIs is W2's to prove; see the handoff.

W1 delivers the workflow file, the action's input declarations, and their
assertions. The action is still A1's fail-closed stub and does not read the
inputs, so a run exits non-zero; W2 wires orchestration and their use. No caller
references the workflow yet, and the old reviewer stays active.

## Assumptions to confirm

1. W1 is workflow-level only, matching #25's acceptance criteria and likely
   files. Other approved specs say "W1 must supply" bounded GitHub transport,
   complete pagination, App-to-bot identity, and byte-identical comment
   bodies. Those are code, not workflow YAML. Resolved 2026-11-08: the user
   assigned them to W2; see [Handoff](#handoff-not-delivered-by-w1).
2. The workflow takes one input, `ci_workflow`. The caller's `workflow_run`
   event is the `github` context inside the called workflow, so T1 reads the
   CI run from `GITHUB_EVENT_PATH`. T1 also needs a trusted expected CI
   workflow identity (ID and exact file path) that is not copied from the
   event, and the caller's `workflow_run.workflows` filter matches only by
   name, which is not unique. The caller therefore passes the workflow file
   path as `ci_workflow`, which the workflow hands to the action as its
   `ci-workflow` input; the action resolves its ID through the API. Resolved
   2026-11-08 after review: the user chose this over deriving it from
   `GITHUB_WORKFLOW_REF`.
3. The privileged job has no checkout, so its workspace is empty. Trusted
   config and PR files are read through the GitHub API by the action (W2).
4. `ubuntu-latest` supports `runs.using: node24` without `setup-node`. The
   planning spike confirms it.

## Workflow contract

Shape, with action SHAs resolved during planning:

```yaml
name: Dependabot review

on:
  workflow_call:
    inputs:
      ci_workflow:
        description: Repository-relative file path of the intended CI workflow.
        type: string
        required: true
    secrets:
      llm_api_key:
        required: true
      review_app_client_id:
        required: true
      review_app_private_key:
        required: true

permissions:
  actions: read
  contents: read
  pull-requests: read

jobs:
  review:
    name: Dependabot review
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - id: app-token
        uses: actions/create-github-app-token@<full SHA> # <version>
        with:
          client-id: ${{ secrets.review_app_client_id }}
          private-key: ${{ secrets.review_app_private_key }}
          permission-issues: write
          permission-statuses: write
      - uses: $/.github/actions/dependabot-review
        with:
          github-token: ${{ github.token }}
          app-token: ${{ steps.app-token.outputs.token }}
          llm-api-key: ${{ secrets.llm_api_key }}
          ci-workflow: ${{ inputs.ci_workflow }}
```

`action.yml` declares those four inputs, each with a description and
`required: true`, and no `default`, so the workflow passes every value
explicitly and nothing is read from ambient state. `runs` is unchanged.

- **Token permissions.** `contents: read` and `pull-requests: read` come from
  shared-review requirement 4. `actions: read` is the documented read that
  [T1](SPEC-event-verification.md) requires for workflow and run reads. The
  `GITHUB_TOKEN` never writes. Callers must grant at least these, because a
  called workflow cannot elevate its caller's token.
- **App token.** The official `actions/create-github-app-token` action,
  pinned to a full SHA, mints a short-lived token. With `owner` and
  `repositories` omitted, its README scopes the token to the current
  repository, which in a called workflow is the caller's. By default it
  inherits every permission the installation has, so both `permission-*`
  inputs are mandatory. Its post step revokes the token. The token step uses the
  `client-id` input. The older `app-id` input is deprecated (at `v3.3.0` its
  `action.yml` carries `deprecationMessage: "Use 'client-id' instead."`), and
  the user decided on 2026-11-08 not to build on a deprecated feature. So the
  secret is `review_app_client_id`, holding the App's Client ID, not the
  numeric App ID that the earlier approved name `review_app_id` implied; see
  [Amendments](#amendments-in-the-w1-pr). The action marks both inputs
  optional, so the exact `with` keys, not the action, guarantee `client-id`
  is passed.
- **Action resolution.** `$/.github/actions/dependabot-review` has no `@ref`.
  GitHub's [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
  says `$/` resolves to the file's own repository at the running commit, not
  the caller's, and is unavailable on GitHub Enterprise Server. A `./` path
  would resolve against the runner workspace and is forbidden.
- **Action inputs.** The reviewer receives its values as declared inputs,
  not step `env`. The declaration in `action.yml` is the contract that tests
  and W2 read, and GitHub warns when a workflow passes an input the action
  does not declare. `required: true` is documentation: GitHub does not
  enforce it at runtime, so explicit passing is guaranteed by the exact
  `with` keys, and an empty value by W2's fail-closed check. Inputs reach the
  process as `INPUT_*` variables, so the exposure is the same as env; the
  gain is an explicit, testable interface.
  `github-token` is the read-only `GITHUB_TOKEN`: the App token cannot read
  pulls, runs, or contents, and a JavaScript action does not receive the
  `GITHUB_TOKEN` by itself. Secrets reach only the two steps above, never job
  or workflow `env`. W2 adds behavior behind the inputs, not new ones, unless
  approved.
- **CI workflow identity.** `ci_workflow` reaches the action only as the
  `ci-workflow` input, never through a `run:` step or an `if`. The caller
  file sits on the trusted default branch. The action treats the value as
  untrusted text: T1 resolves it through the API to a workflow ID and exact
  path, and a value that does not resolve is a failed review.
- **Pinning.** `actions/create-github-app-token` is the only third-party
  action. Every `uses:` other than the `$/` self reference is a 40-hex SHA
  with a version comment, matching `ci.yml`.

## Commands

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
npm run build
git diff --exit-code
test -z "$(git status --porcelain --ignored --untracked-files=all | grep -v '^!! node_modules/')"
```

The last three are CI's drift check: the build must leave the committed bundle
and notices unchanged, with no untracked or ignored output. Run all of them on
the exact shared revision. No new script is needed.

## Project Structure

```text
.github/workflows/dependabot-review.yml → workflow_call entry point (new)
.github/actions/dependabot-review/action.yml → add four input declarations
tests/reusable-workflow.test.ts         → parsed-YAML assertions (new)
tests/action-package.test.ts            → replace the "no inputs" assertion
docs/specs/SPEC-reusable-workflow.md    → this contract
docs/specs/SPEC-*.md                    → amendments listed under Amendments
docs/specs/README.md, CONTEXT.md        → index and checkpoint
docs/pr-review.md                       → add the exact job shape to the "Workflow and publication" prompt
```

## Code Style

Parse with the existing `yaml` production dependency, using `parseDocument`
with `uniqueKeys: true`, and assert on the parsed tree, never on regular
expressions over file text. The test fails on any parse error, any anchor, alias,
or merge key, and any duplicate key, so a value cannot be hidden by reference.
The comparison is exact, not a denylist: the expected workflow and `action.yml`
are literal objects, and the parsed file must deep-equal them. Only the pinned
app-token SHA and the description strings may vary.

```ts
const doc = parseDocument(text, { uniqueKeys: true });
expect(doc.errors).toEqual([]);
const aliases: unknown[] = [];
visit(doc, { Alias: (_key, node) => void aliases.push(node) });
expect(aliases).toEqual([]);
expect(doc.toJS()).toEqual(expectedWorkflow);
```

The version comment is the one thing the tree drops, so a line-level check
requires `uses: actions/create-github-app-token@<40 hex> # v<digits>[.<digits>]*`.
Quote the YAML as `ci.yml` does and keep the file formatter-clean. `ci.yml`'s
test matches text because it pins an ordered step list; W1 does not.

## Requirements

Each requirement has its own test, named after it. A requirement's test must
not rely on the exact-shape test (Requirement 5) to catch its defect.

1. **Trigger.** `on` has exactly one key, `workflow_call`. So any other event,
   including `workflow_run`, `pull_request_target`, `workflow_dispatch`,
   `push`, or `schedule`, fails. The consumer caller owns `workflow_run`.
2. **Named secrets and one input.** `on.workflow_call.secrets` declares
   exactly `llm_api_key`, `review_app_client_id`, and
   `review_app_private_key`.
   `on.workflow_call.inputs` declares exactly one string input,
   `ci_workflow`, and no other. All three secrets and `ci_workflow` are
   `required: true`, so a caller that omits one fails loudly before any step
   runs. That writes no `dependabot-review` status for a missing
   `llm_api_key`, which departs from
   [SPEC-shared-review](SPEC-shared-review.md) requirements 5 and 7; the
   user accepted the departure on 2026-11-08, and the amendment lands in the
   W1 PR (see [Amendments](#amendments-in-the-w1-pr)). The second review
   reports GitHub's docs say a required secret is checked only for being
   passed, not for having a value, so an unset caller secret can arrive
   empty. The action must fail closed on an empty key (W2); planning
   confirms the doc.
3. **Minimum permissions.** Workflow-level `permissions` is exactly
   `actions: read`, `contents: read`, and `pull-requests: read`. No `permissions`
   key exists at job or step level, including `permissions: {}`.
4. **Called-commit resolution.** The reviewer step's `uses` equals
   `$/.github/actions/dependabot-review`, with no `@ref` and no `./` path.
5. **Exact shape; no PR checkout, artifact, or cache.** The parsed file
   deep-equals the expected workflow object, so every key not in it fails.
   Specifically: one job, `review`, whose keys are exactly `name`, `runs-on`
   (`ubuntu-latest`), `timeout-minutes`, and `steps`; two steps in order, the
   pinned app-token step (keys `id`, `uses`, `with`) then the reviewer step
   (keys `uses`, `with`). No `if`, `env`, `shell`, `working-directory`,
   `continue-on-error`, `needs`, `environment`, `strategy`, `container`,
   `services`, `defaults`, `concurrency`, or `outputs` key exists at any
   level. This closes pinned actions the denylist missed, such as
   `actions/github-script`, and any `run:` step, cache input, or `setup-*`.
6. **Pinned third-party code.** The one third-party `uses` is a full 40-hex SHA
   followed by a `# v<version>` comment, checked on the line. A static test
   cannot show that the SHA belongs to the official
   `actions/create-github-app-token` repository rather than a fork; that is a
   recorded planning check against the tag in the official repository.
7. **Secret placement.** `review_app_client_id` and `review_app_private_key` appear
   only under the app-token step's `with`. `llm_api_key` appears only under the
   review step's `with`, as `llm-api-key`. No other `secrets.*` reference
   exists anywhere in the tree, including keys, `name`, and descriptions. The
   review step receives the App token only through
   `steps.app-token.outputs.token`. No `env` key exists at any level. This
   keeps the long-lived App private key out of the process that runs the
   evidence collectors and the model adapter.
8. **App token scope.** The app-token step's `with` equals exactly
   `client-id`, `private-key`, `permission-issues: write`, and
   `permission-statuses: write`. So there is no other `permission-*`,
   `owner`, `repositories`, `skip-token-revoke` (the token would outlive the
   job), `enterprise`, or `github-api-url` (which would send the signed App
   JWT to another host). The token never reaches evidence collectors or the
   model adapter; W2 owns that in-process separation (see Handoff).
9. **No untrusted expressions.** The test walks the parsed tree and collects
   every `${{ ... }}` from every string scalar and every key, with its path.
   Bare `if` expressions need no `${{ }}`, so no `if` key may exist at all
   (Requirement 5). The collected set equals exactly these six, each at its
   stated path: `secrets.review_app_client_id` and
   `secrets.review_app_private_key` in the app-token step's `with`
   (`client-id` and `private-key`);
   `secrets.llm_api_key` in the reviewer step's `with.llm-api-key`;
   `steps.app-token.outputs.token` in `with.app-token`; `github.token` in
   `with.github-token`; `inputs.ci_workflow` in `with.ci-workflow`. A swap of
   two values, `toJSON(secrets)`, `secrets['x']`, or any `github.event.*`
   fails.
10. **Bounded execution.** The job sets `timeout-minutes: 15`. No
    `continue-on-error`, and no `concurrency` key, at workflow, job, or step
    level; W2's claim design owns serialization.
11. **Publication point.** The SHA callers pin is a commit whose push-to-`main`
    CI run passed (A1 requirement 5). The exact SHA, commands, and outcomes
    are recorded on #25. The workflow cannot contain its own SHA.
12. **Action inputs.** The parsed `action.yml` deep-equals the expected
    object: `name`, `description`, `inputs` of exactly `github-token`,
    `app-token`, `llm-api-key`, and `ci-workflow`, each with a description and
    `required: true` and no `default`, and `runs` equal to exactly
    `{ using: node24, main: dist/index.js }`, so `pre`, `post`, and their
    `-if` keys fail. The review step's `with` has exactly those four keys.
    Replace A1's regex assertions in `tests/action-package.test.ts` with
    this comparison. No bundle change is needed, because the stub does not
    read inputs, so the drift check stays clean. GitHub does not enforce
    `required: true` for action inputs at runtime, so the guarantee is the
    exact `with` keys here and W2's fail-closed check, not the declaration.
13. **Parse hygiene.** The workflow and `action.yml` parse without errors, and
    contain no anchor, alias, merge key, or duplicate key.

## Testing Strategy

`tests/reusable-workflow.test.ts`, run by `npm test -- --run`. Each
requirement above has a test named for it, except the evidence-only items
listed after the table.

A mutation proves a requirement's test only if that test fails when run alone:
apply the mutation, run
`npm test -- --run tests/reusable-workflow.test.ts -t "<test name>"`, and see
that test fail. A mutation that merely turns the suite red does not count,
because the exact-shape test would catch almost all of them. Record each
mutation, test name, and result on #25 before the task closes.

| Test                 | Mutations that must fail it                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 trigger           | add `workflow_run`, `pull_request_target`, `workflow_dispatch`, `push`, or `schedule`                                                                                                                                                                         |
| R2 secrets and input | rename a secret (including back to `review_app_id`), add a fourth, make one optional, add a second input, drop or optionalize `ci_workflow`                                                                                                                   |
| R3 permissions       | add `contents: write`; add job-level `permissions` or `permissions: {}`                                                                                                                                                                                       |
| R4 resolution        | use `./.github/actions/dependabot-review` or append `@main`                                                                                                                                                                                                   |
| R5 shape             | add `actions/checkout`, `download-artifact`, `cache`, `setup-node`, or a pinned `actions/github-script`; add a `run:` step, a second job, `strategy`, `environment`, `runs-on: self-hosted`, a step or job `if` (including `if: false`), or reorder the steps |
| R6 pinning           | pin to `@v3`; delete the comment; replace it with `# x`                                                                                                                                                                                                       |
| R7 placement         | put the App key or id in the reviewer `with`; pass `llm_api_key` to the token step; add a non-secret `env` block at any level; alias the private key into a step `name`                                                                                       |
| R8 token scope       | use the deprecated `app-id` in place of `client-id`; drop a `permission-*`; add `permission-contents`, `repositories`, `skip-token-revoke`, or `github-api-url`                                                                                               |
| R9 expressions       | swap `github-token` and `app-token` values; interpolate `github.event.workflow_run.head_branch`; use `toJSON(secrets)` or `secrets['x']`; add a bare `if: github.event.workflow_run.actor.login == 'x'`                                                       |
| R10 bounds           | remove `timeout-minutes`; add `continue-on-error: true` at job or step level; add `concurrency` at workflow or job level                                                                                                                                      |
| R12 action.yml       | add a fifth input; drop one; add a `default`; make one optional; add `runs.pre` or `runs.post`; add or rename a reviewer `with` key                                                                                                                           |
| R13 parse            | add an anchor or alias, a merge key, or a duplicate key                                                                                                                                                                                                       |

Evidence-only, not asserted in CI: Requirement 11 (publication point), the
empty-string secret caveat in Requirement 2, the in-process token separation in
Requirement 8 (W2), and the official-repository check on the pinned SHA in
Requirement 6.

A static test cannot prove that GitHub resolves `$/` to the called commit or
that the App token is scoped as documented. A one-time spike (Open Question 5)
observes both, and its result is recorded on #25 rather than asserted in CI.
The published file may not contain a `run:` step to observe them, so the spike
uses a scratch variant: the published file plus only added observation steps,
in a scratch repository with a throwaway App installed on it. It records the
diff against the published file, so a reviewer can see the token step and the
`$/` reference are identical. Called at SHA X while the scratch repository's
default branch holds different action files, the run log must show the action
downloaded at X. The token's reported repositories and permissions are
recorded. The spike also checks whether the Actions cache and artifact
services are reachable from the job and whether the workflow syntax offers a
way to disable them; no such key is assumed.

Per the verification policy, a fresh-context reviewer or the user confirms that
each new check rejects a plausible wrong implementation. The second Opus
review examined the wording; the confirmation still applies to the tests once
they exist.

## Boundaries

- **Always:** Keep the reviewer action on `$/`, secrets individually named and
  step-scoped, permissions minimal, and the job free of PR code, artifacts, and
  caches. Run the full command list on the exact revision and record it.
- **Ask first:** Add a secret, `input`, or App permission; add any step,
  job, or action (the exact-shape test changes with it); change the
  `workflow_call` trigger or the declared `action.yml` inputs or `runs`;
  change `ci.yml`; widen the
  `GITHUB_TOKEN`; add any job-level `if` that skips review.
- **Never:** Check out or execute PR content with credentials, use
  `secrets: inherit`, load the action from a moving ref, put a secret in
  workflow or job `env`, claim review orchestration, publication, adoption, or
  cutover, or add `dependabot-review` as a required check.

## Success Criteria

1. Every requirement's test passes on the workflow file, and each named
   mutation fails its own test when run alone, with the results recorded on
   #25.
2. Every command in [Commands](#commands) passes on one revision, including
   `npm ci`, with `git diff --exit-code` and the untracked-output check clean
   after the build.
3. The spike evidence on #25 shows the self-referenced action downloaded at
   the called commit and the token scoped to one repository, with `issues` and
   `statuses` write and no permission beyond those and the implicit
   `metadata: read`, if GitHub reports it.
4. #25 records the exact revision, commands, and outcomes, plus the
   [handoff](#handoff-not-delivered-by-w1) items now owned elsewhere.
5. The amendments below are in the same PR, and no approved spec still
   assigns a W2-owned obligation to W1 or contradicts the required secrets
   and declared inputs.

## Amendments in the W1 PR

Docs-only, L scope, approved by the user on 2026-11-08 and reviewed with the
implementation. Each edit is limited to the named passages:

- [SPEC-shared-review](SPEC-shared-review.md) requirements 4, 5, and 7: the
  three secrets are required, so a caller that omits `llm_api_key` fails the
  workflow with no status; the workflow declares the `ci_workflow` input; the
  App secret is `review_app_client_id`, not `review_app_id`.
- [SPEC-parity-cutover](SPEC-parity-cutover.md) (line naming the secrets):
  the same rename.
- [Review config](SPEC-review-config.md) (a missing credential is a
  configuration error with a failed status) and
  [analysis providers](SPEC-analysis-providers.md) (a missing credential
  fails current-head review execution): an omitted secret mapping now fails
  at workflow startup with no status, while an empty value at runtime is the
  configuration error W2 reports with a failed status.
- [SPEC-action-package](SPEC-action-package.md): its statements that A1
  declares no inputs and that W2 owns the workflow, to match Requirement 12
  and this contract. Its A1 status text is corrected too.
- T1, T2, T3, and D1 ([event verification](SPEC-event-verification.md),
  [execution status](SPEC-execution-status.md),
  [managed comments](SPEC-managed-comments.md),
  [GitHub reads](SPEC-github-read.md)), plus any other spec found by
  searching for "W1": move transport, pagination, identity, and claim
  obligations to W2. W1's own obligations (`actions: read`, the App token
  scope, trusted execution) stay.
- [Repo adoption](SPEC-repo-adoption.md): the caller passes `ci_workflow` as
  a literal workflow file path, never an expression. A value such as
  `${{ github.event.workflow_run.path }}` passes every W1 check but copies
  the event into T1's expected identity, which T1 forbids, and workflow names
  are not unique. Adoption fixtures assert the literal. The secret list there
  uses `review_app_client_id`.
- [SPEC-shared-review](SPEC-shared-review.md) project structure: workflow
  tests live in `tests/reusable-workflow.test.ts`, not `src/*.test.ts`.
- The capability map and `CONTEXT.md` status for A1 and W1.

## Handoff: not delivered by W1

Approved specs name these as W1 obligations. On 2026-11-08 the user decided
W2 owns the code ones, because they need the orchestrator to prove and W1
stays a small reviewable workflow diff. W2's plan breaks them into ordered
sub-issues. The approved specs that still say "W1" for these items are
corrected in the W1 PR (see [Amendments](#amendments-in-the-w1-pr)):

| Obligation (source)                                                                                                                                                                                                                                                                                                                                                     | Proposed owner                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Bounded request, byte, and time budgets; credentials, decompression, and cancellation for the real adapter ([D1](SPEC-github-read.md), [T2](SPEC-execution-status.md))                                                                                                                                                                                                  | W2                              |
| Complete, bounded comment pagination ([T3](SPEC-managed-comments.md))                                                                                                                                                                                                                                                                                                   | W2                              |
| App-to-bot identity from trusted App metadata, and byte-identical comment bodies ([T3](SPEC-managed-comments.md))                                                                                                                                                                                                                                                       | W2, or adoption for bodies      |
| Derive the numeric App ID and bot user ID that T3 needs from trusted metadata, because the secret now holds the Client ID: use the action's `app-slug` output and the public API; unverified ([T3](SPEC-managed-comments.md))                                                                                                                                           | W2                              |
| Exclusive durable claim and always-run failure step, which needs an approved amendment to the W1 exact-shape requirements 5, 9, and 12 and their tests, because W1 forbids `if`, a third step, and `runs.post` ([T1](SPEC-event-verification.md), [T2](SPEC-execution-status.md))                                                                                       | W2 (mechanism still unapproved) |
| Fail closed on an empty `llm_api_key`                                                                                                                                                                                                                                                                                                                                   | W2                              |
| The bundle never calls the artifact or cache APIs, and never uses the Actions runtime token for them                                                                                                                                                                                                                                                                    | W2                              |
| Keeping the App token and LLM key from collectors and the adapter                                                                                                                                                                                                                                                                                                       | W2                              |
| Read the four declared inputs; use `github-token` for reads, `app-token` only for publication, and fail closed on an empty value                                                                                                                                                                                                                                        | W2                              |
| Resolve the `ci-workflow` input to a workflow ID and exact path through the API, and reject a mismatch with the event ([T1](SPEC-event-verification.md)). The REST docs document the workflow file name for `workflow_id`, so check the `.github/workflows/` prefix, then pass the basename or list workflows and match `path`; whether a full path works is unverified | W2                              |
| Source T1's trusted expected repository identity (ID and owner/name) from the runner's repository context, not from the event; unverified that this context belongs to the caller inside a called workflow ([T1](SPEC-event-verification.md))                                                                                                                           | W2                              |
| Encode path segments on GitHub's fixed origin for comment targets ([T3](SPEC-managed-comments.md))                                                                                                                                                                                                                                                                      | W2                              |
| Carry bounded fallback diagnostics from S2 to later consumers rather than discarding them ([S2](SPEC-upstream-evidence.md))                                                                                                                                                                                                                                             | W2                              |
| Set `ci_workflow` in each caller to a literal CI file path, never an expression                                                                                                                                                                                                                                                                                         | `repo-adoption`                 |
| App status permission in each consumer                                                                                                                                                                                                                                                                                                                                  | `repo-adoption`                 |

W1 does not claim that a workflow `concurrency` group satisfies the durable
claim: GitHub keeps at most one pending run per group, which is not ownership.

## Open Questions

Questions 1–8 are resolved with the user's agreement, and so are the findings
of the 2026-11-08 Opus review. Approval of this spec is still a separate gate.

1. Resolved 2026-11-08: the user confirmed W1 stays workflow-level and W2
   owns the transport, pagination, identity, and claim obligations. After
   review, the user agreed the approved-spec amendments land in the W1 PR,
   not W2, per `docs/pr-review.md`.
2. Resolved 2026-11-08: the user chose `llm_api_key` required, failing loudly
   at the workflow level over a failed status, and accepted the departure from
   shared-review requirements 5 and 7. See Requirement 2.
3. Resolved 2026-11-08: the user chose `actions/create-github-app-token`,
   pinned by full SHA, over minting in the bundle with an App-JWT library.
   The planning spike resolves the SHA from a real release.
4. Resolved 2026-11-08: the user agreed there is no job-level `if` on actor
   or event. T1 stays the single place that verifies identity, so a
   non-Dependabot run reaches the action and is rejected there. Cost: those
   runs mint a token first. A caller's own `if` is adoption's choice.
5. Resolved 2026-11-08: the user agreed on a one-time scratch run, recorded
   on #25 and not committed, to observe `$/` resolution and the token scope.
   Dummy secrets may fail the mint step before the stub runs; the spike
   decides how to proceed without committing a rehearsal caller.
6. Resolved 2026-11-08: the user agreed on `timeout-minutes: 15` as a
   ceiling. It is not a measured threshold: CI uses 10 for a cheaper job, and
   no W2 budget exists yet. Revisit when W2 sets budgets.
7. Resolved 2026-11-08: the user agreed W1 sets no `concurrency` group. A
   group keyed per PR with `cancel-in-progress: false` is hygiene only, and a
   cancelled pending run leaves no failure status. Defer to the W2 claim
   design.
8. Resolved 2026-11-08: the user chose the long-term design over the
   smallest change: the reviewer takes four declared, required action inputs
   instead of step `env`, including an explicit `github-token`.
