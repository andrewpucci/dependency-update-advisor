# Spec: Shared Dependabot Review Configuration

Status: draft for human review. Module: `review-config` in
`CAPABILITY-MAP-shared-dependabot-review.md`.

## Objective

Let the four consuming repositories choose bounded review context and override
default advisory review rules through one versioned, declarative file. The
shared reviewer owns parsing, defaults, and validation. A repository's existing
`.github/dependabot.yml` remains the authority for which ecosystems and
directories Dependabot updates; review configuration does not repeat schedules
or package roots.

Each consumer chooses a supported LLM provider and model for analysis and
decides whether bounded excerpts of trusted source files are sent to that
provider. The configuration contract must preserve the current review
behavior during extraction and support new uv evidence. Local policy may change
recommendations, while evidence collection, coverage reporting, and trust
boundaries remain accurate.

The repository configuration selects context, provider, and advisory policy;
it does not select an evidence collector. In v1, the shared reviewer calls
GitHub's dependency review REST API where available, preserves manifest and
workflow diff fallbacks, and adds independent uv evidence. An API error cannot
be interpreted as an empty vulnerability result or complete coverage.
When the comparison API omits a package or is unavailable, the reviewer uses
the shared bounded advisory lookup and reports unresolved vulnerability
coverage. A uv consumer can keep its `uv` Dependabot entry and `uv.lock`;
adopting this reviewer does not require a pip migration or a second committed
Python lockfile. The official dependency review action is not required by
this configuration contract.

## Assumptions

1. This public repository can be called by the initial consumers' workflows.
2. The current deterministic policy in the
   [source repository's review-policy spec](https://github.com/andrewpucci/andrewpucci.com/blob/main/SPEC-review-policy.md)
   supplies the shared defaults. A local config may replace named default
   verdict rules with either more or less restrictive advisory verdicts.
3. Missing optional configuration uses conservative defaults, including no
   LLM provider selection and no source-excerpt collection or transmission.
   Invalid or unsupported configuration stops the review with a clear
   diagnostic, publishes a failed review status for the current PR head, and
   leaves any existing managed comment unchanged. The status is advisory in
   v1; no branch rule is required to pass it.
4. When enabled, source excerpts sent to the selected provider come only from
   the trusted default-branch checkout, never from the Dependabot pull-request
   head.
5. The first shared release supports Mistral, the integration that can be
   tested with an available credential. Additional providers require their own
   tested adapters in later releases, without changing the review input or
   output contract. Provider API endpoints are fixed in adapters, not supplied
   by repository configuration.

The source repository's review-policy and related specs define the v1 default
verdicts and the fidelity baseline. Approval of this spec supersedes their
unconditional verdict thresholds only where a repository explicitly configures
an override. The older specs must be updated during implementation to express
that relationship. Parity checks compare the shared reviewer using defaults
against the current reviewer; an intentional local override is reported as a
policy difference, not a regression.

## Tech Stack

Node.js 24 ESM, JSON, the existing review schemas and policy engine, and a
strict configuration parser in the shared reviewer. Use the existing
`.github/dependabot.yml` as read-only data when locating configured ecosystems
and directories. No executable configuration or repository-local plugin code.

## Commands

This repository must provide these commands after implementation:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
```

Until extraction, the source repository's config-focused regression command is:

```sh
vp test run .github/actions-scripts/dependabot-review/config.test.ts
```

## Project Structure

```text
shared repo: src/config.mjs                → parse, default, and validate review config
shared repo: src/config.test.ts            → contract and security boundary tests
shared repo: schemas/review-config-v1.json → published JSON Schema for editors
consumer: .github/dependabot-review.json  → optional repository-local choices
consumer: .github/dependabot.yml          → existing Dependabot ecosystems and directories
```

## Code Style and Configuration Contract

Use ESM, small pure parsers, camelCase JSON fields, explicit enums, and one
validation pass at the file boundary. The v1 file has this shape; all top-level
fields except `version` are optional:

```json
{
  "version": 1,
  "analysis": {
    "provider": "mistral",
    "model": "mistral-medium-latest"
  },
  "context": {
    "sourceRoots": ["src"],
    "sendSourceExcerptsToModel": true
  },
  "policy": {
    "verdicts": {
      "incompleteEvidence": "do_not_merge",
      "highOrCriticalVulnerability": "merge_with_followups"
    }
  }
}
```

The example shows the contract, not an approved consumer policy. `analysis` is
required for model-backed review. When present, both `provider` and `model`
are required. The first release accepts only the provider ID `mistral`; the
model is a bounded, nonempty model ID for that provider. The repository caller
passes one provider credential through a generic reusable-workflow secret
named `llm_api_key`. The shared reviewer sends it only to the selected
provider's fixed HTTPS endpoint. The file never contains a credential or
custom endpoint. An absent `analysis` section makes no model request and
reports analysis as unavailable, without implying that the dependency review
was complete. An unknown provider or missing credential is a configuration
error and never falls back to Mistral or another provider.

Every named rule is optional and falls back to the shared default when absent.
Supported rule names are `incompleteEvidence`, `highOrCriticalVulnerability`,
`moderateOrLowVulnerability`, `incompatibleMigration`, and `applicableCodemod`.
Each accepts `merge`, `merge_with_followups`, or `do_not_merge`. The configured
verdict for a rule replaces its default; independent findings still combine
using the most restrictive applicable verdict. The comment identifies when a
local override changed the default recommendation and still displays the
underlying evidence and coverage status.

`sendSourceExcerptsToModel` defaults to `false`. A repository must set it to
`true` on its trusted default branch to enable bounded source-excerpt
collection and transmission to the selected provider. Setting it to `false`
opts a repository out without disabling dependency metadata, release evidence,
or the review itself.
Each adoption must explicitly choose whether excerpts are enabled. A consumer
that relied on excerpts in the previous reviewer must either enable them or
record a justified, reviewed fidelity change.

For a private consumer, this opt-in authorizes only dependency-relevant,
bounded excerpts from checked-in default-branch source files under its
configured roots. The reviewer may send the relative path and at most one
500-character source line containing the dependency name;
it does not send adjacent lines or whole files. It excludes tests, fixtures,
generated assets, configuration and credential files, runtime media, user
content, and any line that appears to contain a credential or private value.
The private consumer must list each eligible file by exact relative path in
`context.excerptFiles`; newly added files are ineligible until that trusted
list is reviewed and updated. The list cannot override the exclusions.
It sends dependency names, versions, and cited public upstream evidence as
ordinary review metadata when analysis is enabled. The destination in v1 is
the configured Mistral model. Before a private consumer enables excerpts, adoption
review must inspect representative no-send payloads and the exact effective
file allowlist. These bounds reduce disclosure; they do not prove that a
source line contains no sensitive value, and GitHub log redaction must not be
used as the protection for payloads; [GitHub does not guarantee that redaction](https://docs.github.com/en/actions/concepts/security/secrets).

## Requirements

1. Read `.github/dependabot-review.json` only from the checked-out default
   branch in the privileged reviewer. A PR change to this file has no effect
   until merged.
2. Parse at most 16 KiB of JSON. Require `version: 1` and reject unknown
   fields, unsupported enum values, invalid types, and excessive entries.
   Publish the same contract as JSON Schema and exercise it in tests.
3. Default an absent file to the current shared verdict rules,
   `sourceRoots: ["src"]`, `sendSourceExcerptsToModel: false`, and no selected
   LLM provider. Report analysis as unavailable until the repository selects
   one; do not claim complete model-backed coverage. Each adopter may opt in
   to excerpts independently. Only a confirmed missing file uses defaults;
   a read error or invalid present file must not silently fall back.
4. Allow at most 16 source roots. Roots must be normalized relative paths
   inside the trusted checkout; reject absolute paths, traversal,
   hidden or credential-like paths, and symlinks escaping the checkout. Config
   cannot expand the shared allowlist of source file types or remove excerpt
   and packet size limits. An optional `context.excerptFiles` array contains at
   most 128 distinct exact relative paths and is intersected with the roots
   and shared type and content exclusions. A private repository with
   `sendSourceExcerptsToModel: true` must provide a nonempty `excerptFiles`
   list; otherwise it sends no excerpts and fails configuration validation.
5. Allow local overrides of only the five named advisory verdict rules above.
   Apply an override before combining independent findings. Local policy can
   be more or less restrictive than the default, but cannot delete findings,
   change evidence statuses, or claim that incomplete coverage is complete.
   Record the effective policy and override source in the review metadata and
   explain changed defaults in the advisory comment. An override cannot turn
   an unavailable or incomplete review execution status into success.
6. Detect package roots from the existing Dependabot configuration and changed
   manifest/lockfile paths. If they conflict or cannot be resolved, report
   coverage as incomplete instead of reviewing a different project root. No
   config field may disable a supported evidence collector, suppress an
   unassessed added or removed dependency, or mark incomplete evidence as
   complete. A 403 from GitHub's dependency review API remains an unavailable
   evidence source; local policy can change the recommendation but cannot
   conceal that coverage status.
7. Accept only supported provider IDs and bounded model IDs. Do not place
   tokens, API keys, workflow trigger names, GitHub permissions, arbitrary
   commands, or network endpoints in this file. The caller passes the selected
   provider's credential as `llm_api_key`; the shared adapter fixes the API
   endpoint and validates the response against the common analysis schema.
8. A config error produces a non-sensitive workflow diagnostic before any
   LLM request or comment mutation. Include the file path and field name,
   not the full config content. Keep the existing comment intact and publish a
   failed `dependabot-review` commit status on the verified current PR head,
   with a short description that the older comment does not cover that head
   and a link to the failed run. This status reports review execution, not the
   advisory verdict. It is not a required branch check in v1, so it does not
   itself prevent a merge. If the status cannot be published, fail the
   privileged job and never claim a current successful review. An uncertain
   config state must never enable source-excerpt transmission, send a credential
   to a different provider, or relax policy.
9. For a private repository that opts into source excerpts, require an
   adoption-time disclosure record identifying allowed file types, path scope,
   excerpt shape and size, excluded content, provider destination, and the
   result of a no-send payload inspection. Reject suspicious excerpts before
   transmission rather than relying on GitHub's best-effort secret redaction.

## Testing Strategy

Use source-adjacent Vitest tests with temporary trusted checkout fixtures.
Cover confirmed missing, read-error, valid, malformed, oversized,
unknown-version, and unknown-field files; path traversal and symlink escape;
both stricter and less restrictive overrides; independent-finding precedence;
bounded source excerpts; supported and unsupported provider IDs; valid and
invalid model IDs; absent provider and missing credential; a missing-file
default and explicit opt-out that collect and transmit no source excerpts;
explicit opt-in that transmits only bounded trusted excerpts; and a
Dependabot PR that changes the config while the default branch does not.
Cover empty, duplicate, oversized, escaping, newly added, and excluded
`excerptFiles` entries for a private repository.
Check each initial consumer's example configuration against the same parser. Keep
GitHub and LLM API calls mocked, and assert requests and credentials reach
only the selected provider. Test that invalid config leaves the managed comment
unchanged and publishes a failed status on the current head, that a stale head
cannot receive a current status, and that a status publishing failure fails
the job. Private-consumer fixtures must include a dependency name on a line with a
credential-like value and prove the line is dropped before model projection.

## Boundaries

- **Always:** Validate once at the config boundary, apply shared defaults where
  no override exists, read trusted default-branch files only, and report
  incomplete package-root detection honestly.
- **Ask first:** Add a new overridable rule category, expand source file
  classes, send new data to an LLM provider, introduce a parser dependency,
  or change the current review comment's meaning.
- **Never:** Execute repo-supplied configuration, read PR-head config in the
  privileged job, let a policy override erase findings or hide incomplete
  coverage, read secret files, or print full config/model payloads to logs.

## Success Criteria

1. All initial consumers can use the same parser and schema; nested npm
   projects and root uv projects are identified without duplicating
   Dependabot schedules or directories in review config, changing its package
   manager, or committing a generated `requirements.txt`.
2. Local rules can change a default advisory verdict in either direction. A
   changed verdict does not alter the underlying evidence, coverage status, or
   any independent finding, and the comment names the override.
3. With no config, a repository sends no source excerpts to an LLM provider.
   Explicit provider and model selection enables model-backed analysis. An
   explicit `true` enables bounded default-branch excerpts; an explicit
   `false` disables them while retaining the dependency review. The
   adoption configs can enable excerpts without changing this secure default.
4. The v1 Mistral adapter preserves current analysis fidelity. Provider
   selection stays explicit, so a later tested adapter can be added without
   changing the reviewer contract. A missing provider never silently selects
   Mistral; an unsupported provider, missing credential, or invalid model
   never sends a request or mutates a managed comment.
5. Invalid config fails before analysis and leaves the existing managed
   comment untouched, while the current PR head receives a failed advisory
   status; tests prove no PR-head config influences the run.
6. The config parser, schema, and example files agree in focused tests.
7. A private consumer's excerpt opt-in has a reviewed disclosure record and no-send
   payload sample. Its model packet contains only the allowed source-line
   shape and never includes excluded or suspicious content.

## Open Questions

- Whether the first implementation should parse Dependabot YAML with a
  bundled parser or use a narrow, separately validated reader. This is an
  implementation choice for the plan; the behavior above is required.
