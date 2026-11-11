# Spec: Trusted Dependabot Roots

Status: approved for planning, 2026-11-08, when the user invoked `as-plan` on
the reviewed draft. Plan and execution approval remain separate gates.
Module: `review-config` in [the capability map](README.md); consumed by
[W2 review orchestration](SPEC-review-orchestration.md). Contract ID: C4,
confirmed 2026-11-08.

## Objective

Give the npm (N1) and uv (U2) collectors the trusted configured roots their
approved contracts require. [N1](SPEC-npm-inventory.md) receives "canonical
exact roots" and leaves the caller to interpret the consumer's Dependabot
configuration. [U2](SPEC-uv-metadata.md) treats a changed root without a
configured one as an `unsupported` gap. No code or contract reads that
configuration today. Without it, W2 can never produce a `complete` review for
npm or uv changes.

This contract reads the consumer's existing `.github/dependabot.yml` from W2's
trusted default-branch snapshot. It extracts only each update entry's
ecosystem and directories, and hands W2 exact roots plus provenance. It does
not change what Dependabot updates, and it repeats no consumer setting in this
repository.

Success means one of three outcomes, each attributable to the snapshot's
`contextRevision`:

- exact npm and uv roots with provenance;
- confirmed absence of the file;
- an explicit failure reason, never an empty root list.

## Tech Stack

Node.js 24 ESM and strict TypeScript, with the existing `yaml` dependency
already used by [the Actions workflow reader](../../src/evidence/actions-yaml.ts).
There is no new dependency, and nothing is executed, installed or fetched
beyond W2's bounded snapshot reads.

## Commands

```text
Focused: npm test -- --run src/dependabot-roots.test.ts src/snapshot.test.ts
Full:    npm run lint && npm run format:check && npm run check && npm test -- --run
Build:   npm run build
Diff:    git diff --check
```

## Project Structure

```text
src/dependabot-roots.ts       → bounded parser and root canonicalization
src/dependabot-roots.test.ts  → synthetic fixtures only
src/snapshot.ts               → reads the file at the pinned SHA; exposes the result
src/packet.ts or coordinator  → passes roots and configRevision to N1/U2
```

## Requirements

1. **Trusted source.** Read only `.github/dependabot.yml` and
   `.github/dependabot.yaml`, the two names
   [GitHub accepts on the default branch](https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file)
   (checked 2026-11-08), through the W2 snapshot, pinned to the same
   commit as C1 and C2. Never read PR-head files, PR text, or a moving ref.
   The result's provenance is the snapshot `contextRevision`.
2. **Presence.** Both names absent is confirmed absence. Both present, a
   symlink, a directory, a submodule, or a non-regular file is `unsupported`.
   A missing tree listing, failed blob read, size mismatch, cancellation, or
   exhausted budget is `unavailable` with the transport's reason.
3. **Bounded parsing.** Enforce limits before and during parsing: a byte cap,
   a YAML node cap, a depth cap, zero alias expansions, and a cap on update
   entries. An oversized file is detected from the tree entry size and is not
   fetched. Any limit breach is `budget`. Invalid UTF-8 or YAML is
   `malformed`.

   Limits approved 2026-11-08: 65,536 bytes, 20,000 YAML nodes, depth 16, 0
   alias expansions, 256 update entries, and 256 roots per ecosystem.

   The node cap counts structure (collections, scalars, aliases), not
   formatting; see the
   [YAML node budget amendment](SPEC-actions-inventory.md#yaml-node-budget-amendment).
   Commas, indicators, and entries are free, and the byte cap still bounds work.

4. **Narrow extraction.** Require `version: 2` and an `updates` sequence. From
   each entry, read only `package-ecosystem` and either `directory` (string)
   or `directories` (string list). Other keys may be present but are neither
   interpreted nor retained. An entry whose required fields are missing or
   mistyped makes the whole file `malformed`.
5. **Ecosystem mapping.**
   - `npm` supplies N1 roots and `uv` supplies U2 roots. A `pip` entry never
     supplies uv roots, even when its directory holds a `uv.lock`.
   - `github-actions` is recognized and ignored, because X1 takes no caller
     roots.
   - Other ecosystems are ignored.
   - Ignored entries never fail the file.
6. **Canonical roots.**
   - Convert each Dependabot directory to a repository-relative path: strip
     one leading `/`, and map the repository root to `.`.
   - Reject `..`, `.` segments, empty segments, backslashes, control
     characters, and paths over 1,024 UTF-8 bytes.
   - Sort and deduplicate per ecosystem.
   - Any glob character (`*`, `?`, `[`, `{`) makes that ecosystem
     `unsupported`, because exact roots can't be established without
     expanding a pattern.
   - Any invalid directory makes that ecosystem `malformed`.
   - A failed ecosystem leaves the other ecosystem's roots usable.
7. **Result shape.** Return a detached, frozen result:
   - `{ kind: 'roots', revision, npm, uv }`, where each ecosystem is
     `{ kind: 'roots', roots }` or `{ kind: 'unavailable', reason }`;
   - `{ kind: 'absent', revision }`;
   - `{ kind: 'unavailable', reason }`.

   Each reason is an existing `EvidenceReason`. No raw YAML, consumer values
   outside the extracted roots, or error text appears in any result or
   diagnostic.

8. **W2 handoff.**
   - With exact roots, pass them and the snapshot `contextRevision` as the
     collector's `roots` and `configRevision`.
   - With `absent` or a configured ecosystem that lacks roots, pass no
     configured roots. N1 and U2 then report their existing ownership gaps,
     so the ecosystem cannot be complete.
   - With `unavailable`, record that ecosystem's coverage as unavailable with
     the reason instead of invoking its collector with an empty list.
   - The review then ends as `incomplete-evidence`, not `invalid-config`. The
     approved [review-config](SPEC-review-config.md) requirement 6 says
     unresolved roots are incomplete coverage.
9. **No PR override.** A changed Dependabot file in the PR has no effect. A
   configured root cannot hide a changed manifest or lockfile outside it;
   N1 and U2 still reconcile changed paths.

## Code Style

Follow [W2's code style](SPEC-review-orchestration.md#code-style): unknown
input, explicit tagged outcomes, immutable copies, and injected reads.

```ts
const roots = await snapshot.dependabotRoots();
if (roots.kind === 'unavailable') return unavailableCoverage('npm', roots.reason);
const npm = roots.kind === 'roots' && roots.npm.kind === 'roots' ? roots.npm.roots : [];
return collectNpmInventory(
  { binding, roots: npm, configRevision: snapshot.contextRevision, limits },
  { session },
);
```

## Testing Strategy

Use source-adjacent `vite-plus/test` tests with synthetic fixtures. Every
failure path asserts that its result and diagnostics omit a sentinel string
placed in an ignored key.

| Scenario                                                      | Required assertion                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm` and `uv` entries with `directory` and `directories`     | Sorted, deduplicated, canonical roots; provenance equals the snapshot SHA |
| `/` and `/packages/a/`                                        | `.` and `packages/a`                                                      |
| Both file names absent                                        | `absent`; no blob read                                                    |
| Both names present, symlink, or directory                     | `unsupported`; no flattened target                                        |
| Failed listing or blob read, size mismatch, cancellation      | `unavailable` with reason; never `absent` or empty roots                  |
| Over byte cap (by tree size), node cap, depth cap, any alias  | `budget`; oversized file not fetched                                      |
| Invalid UTF-8 or YAML, wrong `version`, mistyped required key | `malformed`                                                               |
| Glob in an `npm` directory with valid `uv` roots              | npm `unsupported`; uv roots still usable                                  |
| `..`, backslash, control character, or 1,025-byte directory   | That ecosystem `malformed`                                                |
| Unknown ecosystems and ignored keys containing a sentinel     | Ignored; sentinel absent from result                                      |
| PR head changes the Dependabot file                           | Roots still come from the default-branch snapshot                         |
| W2 with `unavailable`                                         | Collector not called with `[]`; outcome `incomplete-evidence`             |

The suite must reject these mutations:

- one that maps a failed read to `absent`;
- one that maps `unavailable` to empty roots;
- one that expands or drops a glob instead of reporting `unsupported`;
- one that reads the PR head's file.

## Boundaries

- **Always:**
  - Pin reads to the snapshot SHA and enforce the limits before parsing.
  - Keep failure distinct from absence.
  - Keep fixtures synthetic.
- **Ask first:**
  - Change the limits after approval.
  - Interpret any Dependabot key beyond those in requirement 4.
  - Expand globs.
  - Read any file other than the two named paths.
  - Change N1, U2 or X1 inputs.
- **Never:**
  - Execute or install anything.
  - Trust PR content.
  - Retain or log raw configuration.
  - Copy consumer paths or settings into this public repository.
  - Turn an unresolved root into a guessed repository root.

## Success Criteria

1. Approved fixtures produce the outcomes in the testing table, including the
   four named mutation rejections.
2. A W2 review of an npm or uv change with configured exact roots can reach
   `complete`. Absent, unsupported, or unavailable roots cannot.
3. Roots, C1 config, and C2 context share one `contextRevision`.
4. The Commands sequence passes on the exact implementation revision. Its
   results are recorded in the PR.

## Open Questions

None. Decisions confirmed 2026-11-08: the limits in requirement 3, contract ID
C4, both documented file names, and `pip` entries never counting as uv roots.
