# Spec: C1 Trusted v1 Configuration Parser

Status: approved for C1 execution, 2026-10-11. Supporting contract for `review-config`
in [the capability map](README.md), scoped to
[issue #5: C1](https://github.com/andrewpucci/dependency-update-advisor/issues/5).
Approval: this specification was approved for planning on 2026-10-11. The
C1 implementation plan was approved for execution on the same date, including
draft-07 and test-only `ajv@8.20.0`. The approved
[configuration module](SPEC-review-config.md) remains authoritative.

Amendment approved 2026-10-11:

- Accept the overridable `compatibilityUncertainty`, `supplyChainChange`,
  `licenseChange`, `recentRelease`, and `deprecatedRelease` rules, each
  defaulting to `merge_with_followups`.
- Accept `policy.minimumReleaseAgeDays`, an integer from 1 through 30 that
  defaults to 1.
- Treat `maliciousPackage` as a fixed hold, not a configurable rule.

The [C3 policy contract](SPEC-advisory-policy.md) defines applicability, and
issue #49 implements the parser and schema amendment under parent #7.
C1 now accepts all ten rules and the release-age field.

## Objective

Give reviewer contributors one bounded parser and a matching published JSON
Schema for `.github/dependabot-review.json`. Only validated trusted
configuration may select analysis, context, or advisory policy. A confirmed
missing file retains secure defaults; an unreadable or invalid file fails
without returning usable configuration.

C1 implements file loading, JSON validation, defaults, and safe diagnostics.
[C2](https://github.com/andrewpucci/dependency-update-advisor/issues/6) owns
filesystem containment and excerpt eligibility, collection, and disclosure.
[C3](https://github.com/andrewpucci/dependency-update-advisor/issues/7) owns
policy evaluation and finding precedence. Workflow integration owns default-
branch checkout verification, credentials, current-head status, and comments.
Passing C1 validation alone does not authorize excerpt transmission or prove
complete review coverage.

## Known Inputs and Assumptions

- The attached issue and live issue agree. B2 is closed as completed; its
  [issue evidence](https://github.com/andrewpucci/dependency-update-advisor/issues/3#issuecomment-6116292296)
  records its validation.
  [Contributor checks](../../CONTRIBUTING.md#checks) document the commands.
- Drafting starts at `f81f2372894c9fe74a3ee2a7dd49d09a7f2cda05` on `issue-5`
  with a clean working tree. There is no `src/` or `schemas/` implementation.
- The caller supplies an already trusted default-branch checkout. C1 does
  not accept a caller-selected config filename or load PR-head configuration.
  The privileged workflow must establish that trust before calling the loader.
- No config means no provider, no model request, and no source excerpts.
  Default policy values come from the source reviewer's
  [approved policy contract](https://github.com/andrewpucci/andrewpucci.com/blob/main/SPEC-review-policy.md),
  inspected at file blob `fe7ef40642e667046efe55b1d33903ae8c6c5368`.
- The model-ID bound and lexical path rules below are approved C1 refinements.

## Tech Stack

Use the existing Node.js range `>=24.11.0 <25`, ESM, strict TypeScript,
Node built-ins, and source-adjacent tests importing from `vite-plus/test`.
Preserve the installed toolchain pins and lockfile. Do not introduce a
runtime parser dependency without explicit approval.

Publish a JSON Schema for editor validation. Choose its dialect and a
compatible test validator during planning, recording any proposed dependency
for approval. Schema defaults describe runtime behavior; validation must not
coerce values, delete unknown fields, or mutate input to make it valid.

## Commands

The repository already provides these executable commands:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

For this documentation draft:

```sh
npm run lint:md
npm run format:check
git diff --check
```

No build command exists yet. Action packaging remains A1. The implementation
verification must run all four quality commands on the same exact revision;
record installation separately when validating a clean checkout.

## Project Structure

```text
src/config.ts                       → trusted file loading, validation, defaults, errors
src/config.test.ts                  → parser, loader, default, and schema agreement tests
schemas/review-config-v1.json        → published declarative v1 JSON contract
docs/specs/SPEC-config-parser.md     → this C1 supporting contract
```

Use synthetic inline or temporary-checkout fixtures. Keep private consumer
configurations and exact file allowlists in their consumer repositories.

## Configuration Contract

### Trusted loading and JSON limits

1. Load only `.github/dependabot-review.json` beneath the supplied trusted
   checkout. Do not execute configuration or resolve imports or remote refs.
   The config file itself must not resolve outside that checkout.
2. Read at most 16,384 bytes plus one overflow-detection byte. Reject a file
   exceeding 16,384 bytes before parsing, including whitespace. Test exact
   byte boundaries with both ASCII and multibyte UTF-8 input.
3. Decode valid UTF-8 and parse ordinary JSON. Reject malformed encoding,
   empty files, invalid JSON, comments, and trailing commas. The document
   must be an object, not `null`, an array, or another JSON primitive.
4. Only a confirmed absent file uses defaults. Permission errors, I/O errors,
   an existing directory at the file path, and unresolved or escaping links
   are failures. Do not catch all errors and substitute defaults.
5. Validate the entire document before exposing any effective configuration.
   Reject unknown properties at every object level, including prototype-like
   keys. No type coercion or partial result is permitted.

### Fields and defaults

All object sections and their fields are optional except where stated below.
An optional field supplied as `null` is invalid, not equivalent to omission.

| Field                               | Present-file contract                                                  | Runtime default when omitted                                                    |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `version`                           | Required numeric value `1`; no string coercion                         | Missing file uses internal v1 defaults; a present file still requires `version` |
| `analysis`                          | Object containing both `provider` and `model`                          | No selected provider or model                                                   |
| `analysis.provider`                 | Exactly `mistral`                                                      | No implicit provider                                                            |
| `analysis.model`                    | Nonempty bounded provider model ID                                     | No implicit model                                                               |
| `context`                           | Object with only the three fields below                                | Secure context defaults                                                         |
| `context.sourceRoots`               | Array of at most 16 relative path strings                              | `["src"]`                                                                       |
| `context.sendSourceExcerptsToModel` | Boolean                                                                | `false`                                                                         |
| `context.excerptFiles`              | Array of at most 128 distinct exact relative path strings              | Empty allowlist                                                                 |
| `policy`                            | Object containing only optional `verdicts` and `minimumReleaseAgeDays` | Shared policy defaults                                                          |
| `policy.verdicts`                   | Object with only the ten named rules below                             | Shared default for each omitted rule                                            |
| `policy.minimumReleaseAgeDays`      | Integer from 1 through 30                                              | `1`                                                                             |

An empty `analysis` object is invalid. Empty `context`, `policy`, and
`policy.verdicts` objects retain their respective defaults. Empty source-root
and excerpt-file arrays select no paths; they do not restore omitted-field
defaults. Explicit `false` and explicit verdict overrides must survive parsing.

Each named verdict accepts only `merge`, `merge_with_followups`, or
`do_not_merge`. Preserve which rules were explicitly overridden so C3 can
distinguish local choices from defaults, including an override equal to the
default.

| Rule                          | Shared default                                            |
| ----------------------------- | --------------------------------------------------------- |
| `incompleteEvidence`          | `merge_with_followups`                                    |
| `highOrCriticalVulnerability` | `do_not_merge`                                            |
| `moderateOrLowVulnerability`  | `merge_with_followups`                                    |
| `incompatibleMigration`       | `do_not_merge` for proven trusted-context incompatibility |
| `applicableCodemod`           | `merge_with_followups`                                    |
| `compatibilityUncertainty`    | `merge_with_followups`                                    |
| `supplyChainChange`           | `merge_with_followups`                                    |
| `licenseChange`               | `merge_with_followups`                                    |
| `recentRelease`               | `merge_with_followups`                                    |
| `deprecatedRelease`           | `merge_with_followups`                                    |

C1 does not decide when a rule applies. Compatibility uncertainty is not
automatically proven incompatibility.
No configured value may alter findings, coverage, or execution status.

### Model and path syntax

A model ID contains 1–128 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._-]*`. Reject whitespace, URLs, slash-separated paths,
and control characters without trimming or rewriting. This accepts the
approved `mistral-medium-latest` example. It is syntactic validation, not a
network lookup or a guarantee that the credential can access that model.
Provider endpoints and credentials are never configuration fields.

Use canonical slash-separated relative paths with nonempty segments:
reject absolute POSIX and Windows paths, backslashes, empty strings, trailing
or repeated separators, `.` and `..` segments, hidden segments, and control
characters. Reject ambiguous input instead of normalizing traversal away.
Exact excerpt paths cannot be glob patterns. C2 must additionally enforce
credential-path exclusions, symlink containment, root membership, shared file
types, and content exclusions before collecting any excerpt. C1's lexical
acceptance is not an eligibility guarantee.

Private-repository visibility is trusted runtime metadata, not a JSON field.
C2 must reject private opt-in without a nonempty exact `excerptFiles` list
before collection. Missing credentials are also runtime errors outside this
JSON parser. Neither condition belongs in the published document schema.

### Results and diagnostics

Return an explicit success with normalized defaults and config provenance
(missing-file defaults versus trusted file), or an explicit failure with no
usable config. Preserve explicit override provenance and do not let callers
mutate one parsed result in a way that changes later default results.

Diagnostics identify `.github/dependabot-review.json`, a stable error category,
and a known schema field or `$` for file/document errors. For unknown keys,
report the nearest known parent field without echoing the supplied key. Do
not include config values, raw JSON parser messages with input excerpts,
absolute checkout paths, secrets, or full payloads. Test this with synthetic
sensitive-looking values and hostile property names.

The caller must stop on failure before requests or comment mutation. Failed
current-head status publication and preserving the existing comment remain
workflow integration requirements; C1 does not implement GitHub writes.

## Code Style

Use camelCase fields, explicit string unions, small boundary validators, and
`unknown` for parsed JSON until validated. Use existing single-quote formatting
and explicit test imports. The intended test style is:

```ts
import { expect, test } from 'vite-plus/test';
import { parseReviewConfig } from './config.js';

test('retains secure defaults for a minimal present config', () => {
  const result = parseReviewConfig('{"version":1}');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected valid configuration');
  expect(result.config.analysis).toBeUndefined();
  expect(result.config.context.sendSourceExcerptsToModel).toBe(false);
});
```

The snippet illustrates behavior and style; exact function signatures and
error category names are selected during planning. Keep file loading separate
from pure document validation so parser cases need no GitHub or model services.

## Testing Strategy

Use table-driven source-adjacent Vitest tests and temporary trusted checkouts.
Required fixture groups:

- Confirmed missing file, unreadable file, directory, malformed UTF-8, malformed
  JSON, empty file, and primitive or array document roots.
- The minimal present file, all optional fields, omitted sections, explicit
  empty arrays, `false`, and each default verdict. Default results remain
  independent across calls.
- Missing, wrong-type, and unsupported versions; unknown fields at every
  nesting level; prototype-like names; invalid object and scalar types.
- File sizes at and beyond 16,384 bytes, including multibyte text; roots at
  16 and 17 entries; excerpt files at 128 and 129 entries and duplicates.
- Supported and unsupported providers; missing provider or model; model IDs
  at proposed syntax/length boundaries; no fallback provider or model.
- Lexical path rejection, config-file containment, and an exact excerpt path
  versus a wildcard. C2 adds source-file symlink and disclosure fixtures.
- Each allowed rule and verdict, both override directions, explicit overrides
  equal to defaults, and rejection of unknown rules or verdicts. Finding
  precedence and execution-state behavior are C3's tests.
- Safe diagnostics for all failure classes without leaking synthetic values,
  hostile keys, absolute paths, or raw parser excerpts.

Validate the same decoded document fixtures independently with the parser and
the published schema and require identical accept/reject results for document
structure, enum, count, model, and lexical path rules. Do not implement a
second hand-written schema interpreter solely for tests. Compare runtime
defaults against the declared schema defaults separately.

The raw-byte cap, decoding, file read state, filesystem containment, private
repository visibility, and credential availability are outside JSON Schema
document validation. Test them at their owning runtime boundaries; schema
acceptance must not be presented as proof that these checks passed.

For implementation evidence, record the full shared commit SHA, actual Node/npm
versions, exact commands, exit codes, and test counts in the verification
record. Distinguish working-tree checks from committed-revision checks and
record CI's tested merge SHA separately from the PR head when applicable.
Do not claim C2, C3, workflow integration, or reviewer parity from C1 tests.

## Boundaries

- **Always:** Validate before exposing values; retain secure defaults only
  for confirmed absence; keep parser/schema fixtures aligned; preserve explicit
  override provenance; sanitize diagnostics; use synthetic public fixtures.
- **Ask first:** Add a parser or schema-validator dependency, change approved
  model/path constraints, expand provider IDs or rule names, change shared
  defaults, or extend C1 into excerpt collection or policy evaluation.
- **Never:** Execute config, read PR-head config as trusted input, accept
  credentials or custom endpoints, silently recover from invalid config,
  publish private consumer details, or claim unimplemented integration checks.

## Success Criteria

1. A confirmed missing file and a minimal valid present file yield no selected
   provider, no enabled excerpts, and the documented shared defaults.
2. Every invalid or unreadable present file fails with no usable partial result
   and a safe field-level diagnostic; oversize data is rejected before parsing.
3. The parser and published schema agree on all document-contract fixtures,
   including unknown nested fields and the exact accepted counts and syntax.
4. Valid explicit choices and override provenance reach C2/C3 without enabling
   a request, collecting an excerpt, evaluating findings, or writing to GitHub.
5. The required quality commands pass on the same exact implemented revision,
   with outcomes and test counts recorded without broader parity claims.

## Approved Scope

Approved C1 scope includes the model-ID bound, canonical path rules, empty-array
behavior, default verdict mapping, and C1/C2/C3 split. C2 retains final
filesystem and disclosure validation.

The C1 implementation plan's draft-07 dialect and test-only `ajv@8.20.0`
dependency are approved for execution. No C1 implementation choice remains open.

Record revision-specific validation and regression probes in
[issue #5](https://github.com/andrewpucci/dependency-update-advisor/issues/5#issuecomment-6116293460)
or its PR.
C1 validation covers the parser and schema; C2/C3 disclosure and policy
behavior, workflow integration, and reviewer parity remain separate gates.
