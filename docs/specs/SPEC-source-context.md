# Spec: C2 Bounded Roots and Source Excerpts

Status: approved for C2 execution, 2026-10-11. Supporting contract for
`review-config` in [the capability map](README.md), scoped to
[issue #6: C2](https://github.com/andrewpucci/dependency-update-advisor/issues/6).
Approval: this specification and the C2 implementation plan are approved for
execution, 2026-10-11. Approved scope includes exact-file selection for both
visibilities, the interface, predicates, and resource ceilings below. The approved
[configuration module](SPEC-review-config.md) remains authoritative.

## Objective

Give reviewer contributors one filesystem and disclosure boundary between
C1's parsed configuration and model-ready repository context. Consumer roots
and exact file lists may narrow eligible source, but cannot expand the shared
file classes, exclusions, or excerpt limits. Missing-file defaults and explicit
opt-out collect no source lines and yield no source excerpts for a model.

C2 owns source-root validation, eligibility, collection, safe diagnostics,
and a bounded context result. It does not implement provider transport,
dependency inventory, advisory policy, GitHub writes, or workflow packaging.
An empty context result is not evidence that a dependency has no usages.

## Inputs and Assumptions

- [C1](SPEC-config-parser.md) supplies validated configuration and provenance.
  Its implementation is complete; passing its parser does not authorize
  disclosure. C2 does not introduce JSON fields or alter secure defaults.
- The caller supplies a verified default-branch checkout, repository visibility,
  dependency identities, and a checked-in file inventory tied to that same
  trusted revision. Visibility and inventory are runtime inputs, not config.
  Workflow integration must establish their trust and keep the checkout
  unchanged throughout collection. C2 does not attest to checkout trust or
  protect a concurrently replaced checkout.
- Source-path symlinks, including contained links, are ineligible under
  [ADR 0004](../adr/0004-reject-source-symlinks.md). This applies to roots,
  intervening directories, and excerpt files. C1's config-file link behavior
  stays unchanged.
- The [selected B1 baseline](../../tests/parity/README.md) supplies the existing
  source suffix family, 500-character excerpt cap, and 20-fact cap per
  dependency. Its manifest and workflow context are not source-file opt-in;
  evidence collectors retain ownership of those data under their own specs.
- C2 retains that source suffix family rather than adding Python or
  another file class. A uv dependency can have no eligible source context;
  that limit must remain visible rather than inventing usage evidence.

## Tech Stack

Use the existing Node.js range `>=24.11.0 <25`, ESM, strict TypeScript,
Node filesystem/path built-ins, and source-adjacent `vite-plus/test` tests.
Preserve the pinned toolchain and lockfile. No runtime dependency, repository
execution, or network access is needed for C2.

## Commands

The repository provides these commands for implementation verification:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

For documentation changes:

```sh
npm run lint:md
npm run format:check
git diff --check
```

Run the focused context tests with:

```sh
npm test -- --run src/context.test.ts
```

Run all four quality commands on the same exact implemented revision. Record
installation separately. No build script or runnable shared reviewer exists;
action packaging remains A1.

## Project Structure

```text
src/config.ts                    → existing C1 parser and trusted config loader
src/config.test.ts               → C1 regressions if its boundary changes
src/context.ts                   → C2 path eligibility and bounded source context
src/context.test.ts              → synthetic filesystem and disclosure fixtures
docs/specs/SPEC-source-context.md → this supporting contract
```

Keep filesystem validation in C2 rather than making the JSON parser perform
I/O or require visibility. The document schema cannot prove file eligibility.
Use inline fixtures or temporary checkouts; private allowlists and disclosure
records remain in consumer repositories.

## Requirements

### Opt-in and exact-file selection

1. Accept only C1 success as configuration input. An upstream config failure
   has no usable C2 result. Validate runtime visibility and the configured
   path boundary before exposing eligible context; unknown visibility cannot
   be treated as public.
2. Missing-file defaults and explicit `sendSourceExcerptsToModel: false`
   return an explicit disabled result with zero excerpts. Do not enumerate
   source candidates or open their contents in this state. Path-validation
   metadata operations are permitted; opt-out is not permission to ignore
   an invalid configured boundary. Dependency metadata and upstream evidence
   remain available through their owning collectors.
3. A private repository opting in requires a nonempty exact `excerptFiles`
   list. Missing or empty lists fail configuration validation before reading
   source contents, even when roots are empty. A nonempty list is permission
   to consider those files, not a guarantee of eligible content.
4. For either visibility, a nonempty exact-file list narrows selection to its
   intersection with configured roots, checked-in inventory, shared file
   classes, and exclusions. Preserve C1's empty-list
   behavior for both visibilities: a public opt-in with an omitted or empty
   list yields no excerpts and unavailable context; private opt-in without a
   nonempty list remains an error. No automatic discovery replaces an exact
   list. Empty roots select no files and never restore `src`.
5. Only files in the trusted default-branch inventory are candidates. Untracked
   files and PR-head additions or edits cannot supply source lines. A private
   newly added file stays ineligible until its trusted exact list includes it.
   Do not substitute changed-file paths or PR content for trusted source.

### Filesystem containment and shared eligibility

6. Preserve C1's canonical relative-path rules. Treat roots as literal
   directories; reject glob syntax rather than interpreting root patterns.
   Never normalize an absolute path, traversal, hidden segment, or ambiguous
   separator into an acceptable input.
7. Resolve the supplied checkout root, verify it is a directory, and enforce
   component-aware containment beneath it. A sibling with a common path
   prefix is outside. Inspect every component below the checkout with link
   metadata; reject symlinks in configured roots and exact-file paths, even
   if their targets stay inside. Do not follow discovered source symlinks.
8. An existing root must be a directory, and an eligible file must be regular.
   Reject directories, devices, sockets, and other nonregular excerpt targets
   before content reads. A missing ordinary root or listed file contributes
   no context and a visible availability limit; a dangling link, permission
   error, or uncertain filesystem state is a failure, not an empty success.
9. Reject credential-like configured roots. Exclude hidden or credential-like
   source paths at every component, including `secrets`, `credentials`,
   `private-keys`, and conventional environment or key files. The shared
   exclusion predicates apply to literal paths before reading, not just to
   file extensions.
10. Eligible suffixes are the baseline family matching
    `\.(?:[cm]?[jt]sx?|svelte)$`. Config cannot add extensions or override a
    rejection. Tests, fixtures, snapshots, generated or vendored assets,
    declarations, configuration files, credentials, runtime media, and user
    content remain excluded even when located beneath an otherwise valid root
    or named in `excerptFiles`.
11. Use the approved concrete case-insensitive path and
    filename predicates for those exclusion categories, including nested
    directories and test/config filename suffixes. Test both excluded names
    and nearby eligible names. Do not claim that the suffix allowlist alone
    identifies source safe to disclose.

### Line collection and bounded results

12. Associate excerpts only with supplied dependency identities. For each
    dependency/file pair, select at most one eligible line containing the
    dependency name. Emit its canonical relative path and at most 500 UTF-16
    code units, preserving complete characters; never adjacent lines or a
    whole file. If shortening removes the dependency name, omit that excerpt.
    Use deterministic ordering and deduplicate overlapping roots and repeated
    matches.
13. Reject a suspicious entire line before truncation or model projection.
    Shared checks must cover credential-like assignments, authorization
    headers, recognizable token/key formats, private-key material, URL
    credentials, and sensitive-value fields. A suspicious value beyond
    character 500 still disqualifies the line. Do not redact the value and
    send the remaining line. A later independently safe matching line may
    supply the sole excerpt for that dependency/file pair. Lines inside a
    detected multiline credential block remain ineligible even when that
    individual line has no credential marker.
14. Use the approved suspicious-line predicates and synthetic positive and
    negative fixtures below. If the entire line cannot be inspected
    within its read budget, omit it; a checked prefix cannot establish safety
    for the unseen tail. These checks reduce disclosure and do not prove the
    absence of every private value. Adoption-time no-send inspection remains
    required by the parent contract for private opt-in.
15. Retain at most 20 source facts per dependency, with visible partial status
    when eligible facts or lines are truncated. Bound candidate enumeration,
    per-file bytes, total read bytes, and the serialized context result with
    named constants locked by boundary tests. The approved resource ceilings
    below apply to every consumer.
    Neither roots nor exact-file lists may override any bound.
16. Report disabled, unavailable, partial, and available context distinctly.
    Dropped suspicious/excluded candidates and exhausted limits cannot prove
    complete source usage. No match means unavailable usage evidence, not
    proof of non-use. Source-context status cannot rewrite dependency inventory,
    vulnerability coverage, policy findings, or review execution status.
17. Failures expose no usable partial excerpt collection. Diagnostics use
    stable categories and known config fields where relevant; never echo
    supplied values, offending paths or lines, absolute checkout paths, raw
    operating-system messages, credentials, or model payloads.

### Integration handoff

18. Return only validated, bounded context and non-sensitive status metadata.
    No provider request occurs in C2. The future analysis projection must
    preserve disabled/failed results and cannot recover rejected lines from
    raw files or auxiliary fields. Its opt-out transport test must assert no
    source line in the actual request; C2's result tests do not establish that
    unimplemented integration check.
19. Workflow integration must stop on C2 configuration/containment failure
    before model requests or comment mutation, preserve the existing comment,
    and publish the parent's failed current-head status. C2 supplies the
    error; it does not implement or claim verification of GitHub writes.

## Approved C2 Interface and Limits

### Interface

Use `src/context.ts` and source-adjacent tests. Keep two small functions:

- `validateSourceContextInput` provides the complete zero-read path: C1 success,
  known visibility, canonical configured paths, root/file metadata validation,
  private opt-in requirements, and a disabled-or-ready outcome. A ready result
  contains only internal selection metadata and is not model-ready context.
- `collectSourceContext` consumes that boundary and returns only bounded source
  facts or a failure without usable partial facts. It never takes a provider,
  credential, arbitrary reader URL, PR ref, or repository-selected limit.

Inputs: C1 `ConfigResult`, checkout root, trusted `public`/`private` visibility,
dependency identities `{ id, name }`, and a lazy `AsyncIterable<string>` of
checked-in paths from the same trusted revision. The caller owns provenance
and stable inventory order. C2 performs no git subprocess or filesystem walk.
Opt-out must not advance the inventory iterator. Tests may mock Node I/O;
do not add a production filesystem interface or injectable arbitrary reader.
For enabled exact selection, keep only bounded membership matches rather than
materializing the full inventory; stop once every eligible exact path is found.

Validate dependency IDs/names as nonempty strings of at most 256 UTF-16 code
units without control characters; IDs must be unique. Do not invent an
ecosystem parser here. C2's bounded input check supplements the future shared
packet validation without deciding dependency coverage.

Public result contract:

- Failure: `{ ok: false, error: { file, category, field } }`, with the fixed
  config filename, a category from `config`, `input`, `path`, `read`, or
  `budget`, and a known context field or `$`. No facts or raw errors survive.
- Success: `{ ok: true, status, dependencies, reasons }`. `status` is
  `disabled`, `unavailable`, `partial`, or `available`; reasons are fixed enums.
  Disabled results have an empty dependency-context array and no source reads.
  Every enabled dependency identity has one context entry, even with no match.
- Each entry carries `id`, `name`, `status`, fixed reason enums, and `facts`.
  A fact is `{ kind: 'package-usage', path, excerpt, excerptTruncated }`.
  No file buffers, absolute paths, neighboring lines, or rejected text are
  exposed. Evidence collectors supply workflow/manifest context separately.

Use fixed reasons for no match, missing source, excluded source, suspicious
line, unsupported type, out-of-scope selection, and each reached resource
ceiling. An error discards all collected facts. An ordinary omission or ceiling
is a visible availability limit, never proof of non-use or complete review.

### Exact-File Selection

Exact-file selection applies to public and private repositories. Empty lists
select no files; omission does not authorize automatic discovery. No new C1
field or provenance distinction is needed. Consumer-local lists must be
updated when a newly added file should contribute usage context.

| Visibility and choice                               | Result before source reads                                            |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| Either visibility, opt-out/default                  | Disabled, no enumeration or content reads                             |
| Private, opt-in with an empty effective list        | Configuration failure, no content reads                               |
| Public, opt-in with an empty effective list         | Unavailable context, no enumeration or content reads                  |
| Either visibility, opt-in with exact files          | Intersect list with roots, trusted inventory, shared types/exclusions |
| Either visibility, empty roots with a nonempty list | Unavailable context, no source reads; roots do not fall back          |

No automatic discovery or new C1 field is proposed. The inventory establishes
checked-in membership only; it cannot nominate a file absent from the list.
Validate configured path metadata first, so opt-out/empty selection cannot hide
a source symlink or another invalid configured boundary.

### Resource Ceilings

These are approved bounded-work ceilings, not measured performance targets.
Existing C1 and baseline bounds remain unchanged. Raising a ceiling requires
review; no consumer can configure it.

| Constant                          | Approved value | Behavior at the boundary                                                   |
| --------------------------------- | -------------- | -------------------------------------------------------------------------- |
| `MAX_CONTEXT_DEPENDENCIES`        | 128            | Reject excess input before enumeration or content reads                    |
| `MAX_CONTEXT_ID_CODE_UNITS`       | 256            | Bound each dependency ID and name; reject invalid input                    |
| `MAX_CONTEXT_PATH_BYTES`          | 1,024          | Reject oversized configured/inventory paths before filesystem operations   |
| `MAX_TRACKED_PATH_ENTRIES`        | 10,000         | Count duplicates too; stop with partial status on one overflow record      |
| `MAX_SOURCE_CANDIDATES`           | 128            | Deduplicate eligible paths; stop with partial status on overflow           |
| `MAX_SOURCE_FILE_BYTES`           | 65,536         | Read at most cap plus one probe byte; omit an incomplete or oversized file |
| `MAX_TOTAL_SOURCE_READ_BYTES`     | 1,048,576      | Count all returned bytes including probes; stop content reads at the cap   |
| `MAX_SOURCE_EXCERPT_CODE_UNITS`   | 500            | Existing cap; preserve complete characters and the dependency name         |
| `MAX_SOURCE_FACTS_PER_DEPENDENCY` | 20             | Existing cap; expose partial status if further safe matches exist          |
| `MAX_SOURCE_CONTEXT_BYTES`        | 65,536         | UTF-8 bytes of the complete serialized public result, including metadata   |

Check string length before computing UTF-8 path size so a hostile oversized
path cannot cause unbounded inspection. Do not read an overflowing inventory
record's target. Stop the iterator and close its resources on limits/failure.
Deduplicate bounded candidates, then sort paths by deterministic code-unit
order; retain the caller's dependency order.

Read files serially with bounded Node file handles. Check every path component
with `lstat`, never follow a source link, verify a regular descriptor, and close
handles in `finally`. Do not use unbounded `readFile` or `Promise.all` reads.
If the total byte budget prevents a complete file read, omit the entire file;
do not emit a checked prefix whose tail was never inspected. Decode UTF-8
strictly. I/O/encoding uncertainty fails the result without partial facts.

Inspect complete bounded files/lines before choosing one safe match per
dependency/file pair. Check the unshortened line, then trim leading whitespace
and cap its excerpt at 500 code units without splitting a surrogate pair.
Recognize LF, CRLF, CR, and Unicode line/paragraph separators as line boundaries;
none may survive inside an emitted source-line excerpt.
If the retained prefix omits the dependency name, omit the fact and mark the
limit. Preserve `excerptTruncated` and partial status for a shortened safe line.

Measure `Buffer.byteLength(JSON.stringify(result), 'utf8')` before retaining
each fact. Reserve mandatory identity/status metadata first; if that alone
exceeds the output budget, return a small budget failure without source reads.
Reservation includes every possible fixed reason and the widest status value
for every identity, so final omission metadata cannot overflow the packet.
Account for final reason/status changes and JSON escaping. Never remove an
identity or an unavailable entry to make the serialized result fit.

### Shared Path Exclusions

Use case-insensitive comparisons for exclusions, with slash-separated path
components. Literal configured roots containing hidden or credential names
fail validation. Other excluded roots/files narrow collection to no eligible
facts; exact selection cannot override a rejection. The source suffix match
remains the case-sensitive baseline `\.(?:[cm]?[jt]sx?|svelte)$`.

| Category               | Concrete predicate                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden                 | Any component beginning with `.`                                                                                                                                                                                                                                                                    |
| Credentials            | Component/stem normalized by removing `-` and `_` equals `secret`, `secrets`, `credential`, `credentials`, `privatekey`, `privatekeys`, `apikey`, or `apikeys`; environment/key names and `.pem`, `.key`, `.p12`, `.pfx` files                                                                      |
| Tests and fixtures     | Components `test`, `tests`, `spec`, `specs`, `__tests__`, `fixture`, `fixtures`, `__fixtures__`, `mock`, `mocks`, `__mocks__`, `snapshot`, `snapshots`, `__snapshots__`, `e2e`, `integration`; basename tokens `test`, `spec`, `fixture`, `mock`, `snapshot` bounded by start/end, `.`, `-`, or `_` |
| Generated and vendored | Components `node_modules`, `vendor`, `vendors`, `dist`, `build`, `out`, `coverage`, `generated`, `__generated__`; basename tokens `generated`, `gen`, `min`; generated markers in the first bounded source lines also exclude the file                                                              |
| Declarations           | Basename ending in `.d.ts`, `.d.mts`, `.d.cts`, or `.d.tsx`                                                                                                                                                                                                                                         |
| Configuration          | Components `config`, `configs`, `configuration`, `settings`; basename tokens `config`, `configuration`, `settings`; basename beginning with `tsconfig`, `jsconfig`, `eslint`, or `prettier` followed by `.`                                                                                         |
| Media and user content | Components `public`, `static`, `assets`, `media`, `upload`, `uploads`, `content`, `user-content`, `userdata`, `user-data`, `data`                                                                                                                                                                   |

Generated content markers: in the first 20 complete lines, case-insensitive
`@generated`, `auto-generated`, `autogenerated`, or `generated file`.
Inspecting those markers is permitted only after path/type eligibility;
path-excluded files must never be opened. The reserved names intentionally
exclude some ordinary code; expand eligibility only through review.

Fixtures must pair `src/test.ts` with `src/tester.ts`, `src/client.config.ts`
with `src/configure.ts`, and `src/generated/client.ts` with an ordinary checked-in
module. Arbitrarily renamed generated/user/config content cannot be identified
perfectly by filenames; these are explicit heuristic limits, not a secrecy
guarantee. Private adoption still requires exact-list and no-send inspection.

### Suspicious-Content Predicates

All line checks are case-insensitive where meaningful and run before trimming
or truncation. Rejection drops content; it never redacts then sends the rest.

| Trigger                    | Approved rule                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sensitive assignments      | A field/identifier immediately followed by optional closing quote and `:` or `=`; normalize camelCase, `-`, and `_`, then match `password`, `passwd`, `pwd`, `secret`, `secrets`, `token`, `accessToken`, `refreshToken`, `idToken`, `apiKey`, `clientSecret`, `credential`, `credentials`, `authorization`, `privateKey`, `sessionKey`, `signingKey`, `cookie`, `connectionString`, `dsn`, `email`, `phone`, or `address` |
| Authorization values       | `Bearer` or `Basic` followed by whitespace and a nonempty token, or an authorization header/assignment                                                                                                                                                                                                                                                                                                                     |
| Recognizable key strings   | `gh[pousr]_` plus at least 20 alphanumeric characters; `github_pat_` plus at least 20 alphanumeric/underscore characters; `AKIA`/`ASIA` plus 16 uppercase alphanumeric characters; `sk-` plus at least 16 alphanumeric/underscore/hyphen characters                                                                                                                                                                        |
| URL credentials            | A URI containing `://`, nonempty user-info, and `@` before the next slash/whitespace/quote                                                                                                                                                                                                                                                                                                                                 |
| Private values             | A conventional email literal, or a literal local home path beginning `/Users/`, `/home/`, or a Windows drive plus `Users`                                                                                                                                                                                                                                                                                                  |
| Private-key blocks         | Any `-----BEGIN ...PRIVATE KEY-----` marker disqualifies the whole file, including lines without markers                                                                                                                                                                                                                                                                                                                   |
| Multiline sensitive values | A sensitive assignment with a value starting a brace, bracket, or template literal, or an unclosed quoted value, disqualifies the whole file rather than implementing language-specific block parsing                                                                                                                                                                                                                      |

Ordinary import statements and scoped package names must have safe negative
fixtures; a function/variable merely named `tokenizer` is not a sensitive
assignment. A suspicious inline line may be skipped in favor of a later safe
matching line. Reject NUL/control-bearing source lines; permit tabs as source
whitespace. Whole-file private-key/multiline rejection is intentionally stricter.
Other unrecognized sensitive literals remain an acknowledged disclosure limit.
Source comments or strings that instruct a model are data, never instructions.

## Code Style

Follow C1's single quotes, explicit unions, camelCase fields, small boundary
functions, and explicit test imports. Keep collection separate from transport.
The intended assertion style is:

```ts
import { expect, test } from 'vite-plus/test';
import { parseReviewConfig } from './config.js';

test('preserves explicit opt-out before context collection', () => {
  const result = parseReviewConfig('{"version":1,"context":{"sendSourceExcerptsToModel":false}}');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected valid configuration');
  expect(result.config.context.sendSourceExcerptsToModel).toBe(false);
});
```

This executable C1 example establishes style, not C2 verification. C2 tests
must additionally assert zero content reads and an empty excerpt result.
Choose C2 function signatures and result types during planning without adding
raw source buffers to the public result.

## Testing Strategy

Use source-adjacent `vite-plus/test` tests, temporary trusted-checkout fixtures,
and mocked content readers where read counts or overflow bounds matter.
No GitHub or model network calls are needed. Keep existing C1/schema tests.

Required fixture groups:

- Secure defaults and explicit opt-out: zero source-content reads and zero
  excerpts despite a dependency match; analysis metadata remains independent.
- Public/private explicit opt-in, unknown visibility, empty roots, absent or
  empty private lists, exact-list intersection, duplicate roots, checked-in
  versus untracked source, and trusted versus PR-head content.
- Absolute POSIX/Windows paths, traversal, glob roots, hidden/credential paths,
  prefix siblings, missing entries, read errors, nonregular files, and both
  escaping and contained symlinks in roots, parents, and files. Assert excluded
  targets are never opened, including links discovered during enumeration.
- Every file-class/path exclusion beneath allowed roots and explicitly named
  in a file list, with nearby eligible counterexamples. Naming a file cannot
  override its exclusion; unsupported Python does not yield usage facts.
- Credential-like and private-value lines, including a suspicious tail beyond
  character 500, multiline private-key material, ordinary safe imports,
  matches beyond the retained prefix, and a safe match after a rejected line.
- Exact 500-character and 20-fact boundaries, multibyte text, duplicate matches,
  deterministic ordering, and each selected read/count/serialized-byte budget
  at and beyond its limit. Prove limits stop work instead of slicing an
  unbounded read after collection.
- Failure with no partial excerpts, safe diagnostics, and correct disabled,
  unavailable, partial, and available context without changing other evidence.

Record the full implemented SHA, Node/npm versions, commands, exit codes,
test counts, and limitations in issue #6 or its PR. Distinguish working-tree
checks from committed-revision checks and CI's tested merge SHA from the PR
head. Do not claim provider transport, workflow status, or parity from C2 tests.

## Boundaries

- **Always:** Intersect local selections with shared eligibility; reject source
  symlinks; check complete lines before shortening; bound reads and outputs;
  preserve secure defaults and truthful availability; use sanitized fixtures.
- **Ask first:** Expand source classes or disclosure shape, loosen exclusions
  or limits, permit source symlinks, add dependencies, alter C1's schema/defaults,
  or extend this scope into workflow, provider, or policy behavior.
- **Never:** Read PR source as trusted context, execute repository files, read
  excluded contents, let an exact list bypass shared rules, send an opt-out
  source line, log sensitive content, or publish private consumer records.

## Success Criteria

1. Configured roots and exact files cannot escape the trusted checkout or
   expand the shared allowlist; contained source symlinks are also rejected.
2. Defaults and explicit opt-out perform zero source-content reads and return
   zero source excerpts. Private opt-in without an exact list fails before
   content collection; valid opt-in returns only eligible trusted source.
3. Each excerpt contains the dependency name, at most one source line, and
   at most 500 UTF-16 code units. Excluded and suspicious content never reaches
   the result, including sensitive values after the retained prefix.
4. Bounds stop enumeration/reads, cap facts and serialized context, and expose
   availability/truncation honestly. A failure has no usable partial context.
5. Required fixtures and all four repository quality commands pass on the same
   implemented revision, with evidence recorded in issue #6 or its PR.

## Open Questions

None for the approved C2 scope. Adding Python source excerpts would expand the
baseline file classes and requires a separate disclosure decision. Checkout
attestation, provider transport, workflow status/comment writes, and adoption
inspection remain integration handoffs rather than C2 verification claims.
