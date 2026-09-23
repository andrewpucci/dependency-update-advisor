# Spec: Shared Reviewer Parity and Cutover

Status: draft for human review. Module: `parity-cutover` in
`CAPABILITY-MAP-shared-dependabot-review.md`.

## Objective

Adopt the shared Dependabot reviewer in four initial consumers, then retire
the source repository's current reviewer only after the shared flow has demonstrated comparable review
fidelity and visible current-head failure behavior. A repository with no
explicit analysis configuration is not cut over by default.

## Tech Stack

SHA-pinned reusable GitHub Actions workflow callers, repository-local
`.github/dependabot-review.json` files, named workflow secrets, a GitHub App
installation for managed comments and commit statuses, and read-only dry-run
comparison fixtures. The shared reviewer remains advisory; its status is not
a required branch check in v1.

## Commands

In each consumer repository, run its documented lint, type-check, and test
commands before changing its caller. In the shared repository run:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
```

In the public source repository, run the existing no-write comparison on representative
Dependabot PRs before removing the local implementation:

```sh
npm run dependabot:review:dry-run -- 307 --preflight
npm run dependabot:review:dry-run -- 302 --preflight
npm run dependabot:review:dry-run -- 305 --preflight
```

## Project Structure

```text
shared repo: tests/parity/                    → sanitized comparison fixtures
consumer: .github/dependabot-review.json     → explicit provider, policy, and excerpts
consumer: .github/workflows/                 → SHA-pinned shared-flow caller
source repo: .github/actions-scripts/dependabot-review/ → retiring baseline
```

## Code Style and Rollout Contract

Keep each caller small and explicit. Map only named `llm_api_key`,
`review_app_id`, and `review_app_private_key` secrets and pin the shared
workflow to a full commit SHA. Record the exact revision and test evidence
used to cut over each repository. The shared workflow's own reviewer action
resolves at the called workflow's commit; callers do not select a moving tag.

## Requirements

1. Before adoption in **each** initial consumer, merge a validated
   local config that explicitly selects a supported provider and model,
   states `sendSourceExcerptsToModel` as `true` or `false`, and records local
   advisory policy overrides or the decision to use shared defaults. Verify
   the named provider credential and App credentials exist in that
   repository. An absent config or provider remains a secure runtime default,
   but cannot satisfy this cutover gate because analysis would be unavailable.
2. For a private uv consumer, keep the `uv` Dependabot entry and `uv.lock`.
   Before enabling source excerpts, review the exact `context.excerptFiles` allowlist and a
   no-send model-packet sample. Record the allowed Python, JavaScript, and
   Svelte source-line shape, 500-character bound, exclusions, Mistral
   destination, and residual risk that a checked-in line can contain a
   sensitive value despite screening. Do not rely on GitHub log redaction,
   which [GitHub says is not guaranteed](https://docs.github.com/en/actions/concepts/security/secrets).
3. Verify each repository can run the SHA-pinned shared workflow with minimum
   token permissions and only named secrets. Confirm the App can publish a
   `dependabot-review` commit status on the current PR head and manage only
   its own comment. Confirm an invalid config produces a failed head status
   while leaving the older comment untouched. The status is advisory and is
   not added to required branch checks in v1.
4. Compare grouped npm, GitHub Actions, security, and uv updates against the
   current reviewer or a reviewed scenario fixture. Preserve or improve
   package inventory, direct/transitive classification, vulnerability
   findings, upstream sources, repository context, provenance, policy
   overrides, per-package availability, aggregate verdict, and managed
   comment identity. Record every intentional difference and its reason.
5. Include the observed failure cases: public source PR #302's omitted
   `github/codeql-action/upload-sarif` action in the comparison API, PR
   #307's 20 unpaired npm additions, and a sanitized private uv scenario with
   an unavailable dependency comparison endpoint. An introduced-vulnerability fixture must
   verify nonempty advisory findings, since the public action pilot did not
   exercise that case.
6. If any required evidence source fails or a package cannot be classified,
   publish explicit incomplete coverage. A private-repo 403 or empty uv graph
   cannot become an unqualified zero-change or zero-vulnerability review.
   Intentional local verdict overrides may change the advisory recommendation
   but not erase the underlying finding or coverage status.
7. Adopt one repository at a time. Keep a reversible caller SHA and the
   previous implementation available until current-head success and failure
   paths pass in that repository. Retire the source repository's local workflow and
   scripts only after all four adoption records and the parity matrix pass.
   A failed cutover restores the prior caller or local workflow without
   rewriting Git history.

## Testing Strategy

Run shared unit and workflow tests with mocked APIs, then no-write dry runs
over representative PRs. Exercise one current-head successful review and one
invalid-config failure in each consumer using a controlled PR. Compare
structured outputs and comments, not merely exit codes. Verify no PR-head
checkout, cache, or artifact enters the privileged job, and no source excerpt
is sent from a repository that opted out. Keep the existing reviewer active
until the parity matrix is reviewed.

## Boundaries

- **Always:** Verify explicit config, credentials, excerpt choice, SHA pin,
  current-head status, and parity in every repository before retirement.
- **Ask first:** Change advisory status to a required check, add an LLM
  provider, broaden a private consumer's data egress, or accept a documented fidelity
  regression.
- **Never:** Cut over from the missing-config default, infer that a private
  403 means zero vulnerabilities, or delete the old reviewer before parity
  passes.

## Success Criteria

1. All initial consumers have reviewed, explicit config and named credentials;
   their callers use a full shared-workflow SHA.
2. Every adopter proves a current-head success and a visible failed advisory
   status for an invalid config, with the older comment preserved.
3. The parity matrix covers all four ecosystems and the observed API gaps,
   with every package change assessed or explicitly marked incomplete.
4. The current reviewer is retired from the source repository only after all
   adoption and parity gates pass; rollback remains documented and tested.

## Open Questions

None for the gate. Exact controlled PRs and rollback SHAs are selected during
adoption and recorded in the relevant consumer repositories.
