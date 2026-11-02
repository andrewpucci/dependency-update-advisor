# Spec: U1 Tested uv Metadata

Status: approved for implementation, 2026-11-01.
Supporting contract for `uv-evidence` in
[the capability map](README.md), scoped to
[issue #17: U1](https://github.com/andrewpucci/dependency-update-advisor/issues/17).
The [approved uv contract](SPEC-uv-evidence.md) remains authoritative.
No new module or T4/T5 amendment is proposed. Spec, plan, and execution
approval remain separate gates.

Approval: after reviewing and revising this draft, the user invoked `as-plan`
on 2026-11-01 and explicitly requested sub-issues on the implementation
project. This approves the revised specification, including schema 1
revisions 3 and 5, for planning. The user then explicitly approved the
eight-task plan and invoked `as-build auto`, authorizing implementation,
exact `smol-toml@1.9.1`, the bounded name-based requirement subset, per-task
commits, and one PR closing the U1 issues on merge. Auto progression replaces
the intermediate human checkpoints; their verification remains required.

Confirmed consumer decision, 2026-11-01: the user explicitly answered
`Yes, use Videmory` after a read-only inspection of its committed metadata.
Its committed lock uses `version = 1`, `revision = 3`. On 2026-11-01 the
user also approved `revision = 5` as a tested pair: Dependabot bundles uv
0.13.5, which writes revision 5 whenever it re-resolves a lock, and the
latest inspected consumer Dependabot head predates that uv update.
Consumer and format choices are confirmed; implementation authorization
is recorded above.
Private consumer paths, raw files, and revision-specific inspection records
do not belong in this public specification.

## Objective and Scope

Give U2 an attributable metadata snapshot of each immutable base/head
`pyproject.toml` and `uv.lock` pair. Validate the tested format, retain
declarations and distinct locked variants, and expose unavailable or
unsupported evidence without substituting an empty successful result.
The eventual users are maintainers reviewing uv Dependabot PRs; U1's
immediate consumer is the change reconciler.

U1 owns candidate-root discovery, bounded TOML and consumed-field validation,
per-side metadata, provenance, and scoped parsing gaps through
[D1](SPEC-github-read.md). It does not pair changes, establish direct or
transitive roles, prove graph reachability, or certify final uv inventory.
[U2 #18](https://github.com/andrewpucci/dependency-update-advisor/issues/18)
owns those decisions, extras/marker interpretation, source reconciliation,
and the T4/T5 change/relationship handoff.

Advisory/upstream research, PR-body reconciliation, model assessment,
rendering, publication, adoption, and cutover remain separate. U2 planning
must assign the parent contract's PR-body corroboration requirement before
claiming full uv reconciliation; U1 adds no PR-text input or fetch.

## Immutable Inputs and Root Selection

1. Accept a runtime-validated T1 binding, its D1 session, trusted configured
   uv roots with configuration provenance, and explicit parsing/retention
   limits. External values enter as `unknown`; validate them before reads.
   Canonical roots are repository-relative directories, with `.` for the
   repository root. Do not accept a consumer filesystem path or PR-supplied
   configuration as authority.
2. Use D1's `discoverFiles()`, `readFile({ side, path })`, and
   `readComparison()` sequentially under that session's budgets. Check the
   binding, repository, commit, path, and side of every returned input.
   An obsolete attempt returns no usable metadata. Do not create another
   client, retry with alternate credentials, or read mutable branch refs.
3. Reconcile both current and previous changed paths with trusted roots.
   Select directories containing changed `pyproject.toml` or `uv.lock`
   inputs, including independent nested projects. A configured root cannot
   hide a changed uv input outside it. Workspace/shared-lock ownership that
   cannot be established leaves an `unsupported` gap, not guessed roots.
4. Read both companion files at each selected side, even when one did not
   change. For renames, retain old and new locations independently; a move
   does not itself prove project or package correspondence. D1's proven
   absence is distinct from failed reads or generic HTTP 404s. Two absent
   files can establish an absent side; one absent required companion on a
   present side is `missing`.
5. Preserve incomplete discovery, including base/merge-base divergence.
   Successful parsing of known roots cannot prove that all roots were found.
   Completed discovery with no relevant input can report that selection is
   inapplicable; U1 does not publish a T4 `not_applicable` inventory claim.

## Tested Format and Parser Boundary

The initial support target is exactly numeric lock `version = 1` with
`revision = 3` or `revision = 5`, a static project manifest, registry
packages, and an editable self-project entry. The inspected consumer
exercises optional extras, top-level and per-package resolution markers,
conditional edges, and multiple versions of one normalized package name.
Synthetic fixtures must preserve these structures with invented names and
versions.
This is observed consumer structure, not evidence that a U1 parser exists.

uv documents separate
[schema versions and backward-compatible revisions](https://docs.astral.sh/uv/concepts/resolution/#lockfile-versioning).
U1 deliberately supports only its tested pairs. Reject a missing version
or a nonnumeric, nonintegral, or otherwise invalid header shape as
`malformed`; another well-formed version/revision pair is `unsupported`,
even if uv itself can read it. uv reads a missing `revision` as revision 0,
so a well-formed version without one is `unsupported`, not `malformed`.
No missing-revision default or automatic newer-revision acceptance exists.
Adding a tested pair requires an explicit scope decision and fixtures.

Validate each side's header independently. A Dependabot PR can move a
revision 3 base to a revision 5 head; each supported side keeps its
snapshot, and an unsupported side cannot discard the other. A revision
difference is not itself a package change. Revision 4 and later can record
empty extra or group entries that revision 3 omits; U1 retains empty
entries as recorded, and U2 must not treat their appearance or absence
across revisions alone as an added or removed extra.
Fields that revision 5 adds for default groups or group metadata fall
under the dependency-group gap below. A lock whose packages omit
declaration metadata, which uv writes only under a preview setting, is
`unsupported` for the affected packages; absent `requires-dist` or
`provides-extras` is never an empty declaration set.

Use a maintained TOML reader selected and pinned during planning after
approval of the new dependency. No TOML parser dependency currently exists
in this repository. Do not approximate TOML using line splitting or regexes,
or invoke Python/uv subprocesses in the production collector.
Validate strict UTF-8, TOML syntax, duplicate/redefined keys, and consumed
field shapes. Syntactically broken documents yield no salvaged metadata.
A valid document with an invalid entry can retain independently validated
entries, with the affected scope incomplete.

Trusted limits must cover file bytes before decoding/parsing, parser nesting
and structural entries, roots, packages, declarations, dependency edges,
string bytes, and cumulative retained result bytes across both sides.
Require positive safe integers and reject inconsistent limits before work.
The plan must show how the reader enforces nesting/work bounds during parsing;
post-parse checks alone do not bound a recursive parser. Exhaustion produces
`budget` and a deterministic attributable prefix or fixed unavailable result,
never silent trimming with a successful completeness claim. D1's read budgets
remain independently enforced; U1 sets no new repository quality threshold.

## Manifest and Lock Metadata

Validate the metadata used for inventory rather than claiming to certify
every packaging/build field in a `pyproject.toml`. The
[PyPA manifest contract](https://packaging.python.org/en/latest/specifications/pyproject-toml/)
defines dependency strings and optional-extra tables; uv also supports
[groups and source settings](https://docs.astral.sh/uv/concepts/projects/dependencies/).

- Retain project identity, `requires-python`, static `project.dependencies`,
  and every `project.optional-dependencies` entry, including empty extras.
  Retain exact requirement text and validated structural fields needed by U2:
  package name, requested extras, specifier or direct source, and marker.
  Validate against a documented dependency-specifier grammar or tested subset;
  unsupported valid forms remain gaps rather than guessed names or versions.
  A range is a declaration, not a resolved version.
- An absent static dependency field can be an empty declaration set only
  when it is not dynamic. Dynamic dependencies/optional dependencies,
  dependency groups, legacy dev dependencies, workspace membership, source
  overrides, constraints, or other resolution-affecting settings outside
  the tested subset leave scoped `unsupported` gaps. Retain independently
  readable static declarations. Do not reject unrelated tool configuration
  merely because it is unfamiliar or execute a build backend to fill gaps.
- Retain lock-level `requires-python` and resolution-marker lists. For each
  package retain normalized name, exact version, credential-free source
  identity, package resolution markers, dependencies, optional-dependency
  tables, and consumed metadata such as `requires-dist` and `provides-extras`.
  Preserve edge selectors including name, version, source, marker, and
  requested `extra` when present; selectors are not yet proven graph edges.
- Apply [PyPA name normalization](https://packaging.python.org/en/latest/specifications/name-normalization/):
  lowercase names and collapse runs of `.`, `_`, and `-` to `-` after name
  validation; extra names use the same normalization. Keep equal names with
  distinct version/source/marker selectors distinct. Declaration keys are
  normalized extra names in `project.optional-dependencies` and lock
  optional-dependency tables. Requirement strings are list items identified
  by list and position, so same-name requirements such as marker-split pins
  remain separate declarations rather than conflicts. Reject extras whose
  names normalize equally, or duplicate exact package identities (normalized
  name, version when present, and source), with `conflict` rather than
  overwriting them.
- Support tested registry identities and the editable `.` self-project
  anchor. The self-project is metadata for associating declarations, not an
  external dependency. Other source forms remain distinct scoped
  `unsupported` data; never infer PyPI from an absent source. Unsafe URLs,
  credentials, control characters, or unrepresentable identities produce
  fixed gaps without retaining their raw values or merging sanitized sources.
- Parse and validate artifact-table shapes encountered in the tested schemas,
  but do not download wheels/sdists or treat artifact lists as new packages.
  Preserve enough resolution metadata for U2; unknown resolution-affecting
  fields cannot silently become supported. The plan must enumerate consumed,
  safely ignored descriptive/artifact fields, and unsupported fields in tests.

Markers, versions, and selectors retain their exact safe text; do not
evaluate one local Python environment, simplify Boolean expressions,
resolve ranges, or infer extra activation. A universal lock can have several
applicable variants. Multiple possible edge targets remain distinguishable
for U2 instead of becoming a name-only map.

## Output, Coverage, and Comparison

Return detached readonly binding, selected root/side snapshots, normalized
declarations and packages, immutable source identities, discovery state,
scoped gaps, and independent comparison availability. Each snapshot
distinguishes present validated data, proven absence, partial parse, and
unavailable data. Gaps name the root, side, file, and safe entry identity
when known, using T4's fixed reason vocabulary. Never expose raw TOML,
parser exceptions, comparison payloads, or private credentials in diagnostics.

Stable snapshot/source identities bind repository, commit/blob SHA, path,
side, and semantic package selectors. Ordering and IDs must not depend on
TOML table order, discovery order, or comparison records. Sort unordered
collections by code-unit order; preserve declaration and edge ordering where
meaningful. Detect identity collisions and prevent caller mutation from
changing another result or input.

Parsing availability is not T4 inventory completeness. U1 emits no
`PacketChange`, direct/transitive role, relationship proof, or final uv
`InventoryCoverage`. U2 must consume every gap, including failures with zero
retained packages, and establish coverage after reconciliation. Existing
T4 source/provenance shapes and packet ceilings remain constraints on that
handoff; U1 does not enlarge them or manufacture placeholder changes.

Retain D1 comparison availability/reasons separately. An available empty
comparison, omitted uv records, endpoint permission 403, ambiguous 403,
rate limit, or partial response cannot erase valid file snapshots or make
their parser status fail. Preserve D1's reason classification. U1 does not
interpret comparison records as package identity or infer zero changes or
zero vulnerabilities. Required security research remains unperformed, not
successfully empty. Final coverage policy remains U2/T4's responsibility.

## Tech Stack, Structure, and Code Style

Use the existing Node.js `>=24.11.0 <25`, ESM, strict TypeScript, and Vite+
test stack. Follow adjacent collectors: camelCase, single quotes, pure
parsers, discriminated results, and injected D1 sessions. Public function
names and helper boundaries are planning choices. Existing fixed read
failures illustrate the style:

```ts
const unavailable = {
  kind: 'unavailable',
  reason: 'unsupported',
} as const;
```

| Location                        | Responsibility                                     |
| ------------------------------- | -------------------------------------------------- |
| `src/evidence/uv.ts`            | U1 read boundary, metadata snapshots, and gaps.    |
| `src/evidence/uv.test.ts`       | Parser, bounded-failure, and D1 integration tests. |
| `tests/parity/`                 | Synthetic scenario and explicit provenance limits. |
| `src/schema.ts`, `src/units.ts` | Existing T4/T5 contracts; no U1 amendment.         |
| `docs/specs/`                   | Supporting contract and approval index.            |

## Commands and Testing Strategy

For this documentation change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

Implementation verification uses the existing repository checks:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

No build command exists; packaging remains A1. Record the exact shared
revision, working-tree edits, environment, commands, outcomes, and unrun
checks in the relevant issue/PR. Consumer inspection and synthetic fixtures
do not certify a live reader, full uv inventory, publication, or cutover.

Use synthetic TOML and mocked D1 sessions. Assert fields, variant counts,
source membership, and scoped failures directly; snapshots alone are
insufficient. Required fixtures:

| Case                                                                                        | Required result                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Schema 1, revision 3 and revision 5; static manifest; editable root; registry packages      | Valid attributable per-side snapshots; no external self-project.        |
| Revision 3 base with revision 5 head; supported side beside unsupported side; empty entries | Per-side results; no header-only change, added extra, or lost side.     |
| Package entries without declaration metadata                                                | Scoped `unsupported`; absent metadata is not an empty declaration set.  |
| Four extras; empty extra; conditional edges; resolution markers; same-name versions         | Every declaration, selector, and variant retained for U2.               |
| Missing/wrong-type/invalid header; other version or revision; omitted revision              | `malformed` shapes; other/omitted revision `unsupported`; no guessing.  |
| Broken TOML, duplicate keys, malformed UTF-8, wrong consumed-field shape                    | Fixed scoped gaps; broken documents yield no regex salvage.             |
| Name/extra punctuation and case; duplicate exact package or extra; marker-split pins        | Correct normalization; `conflict`, not overwrite; split pins retained.  |
| Dynamic metadata, groups, workspace/source settings, unsupported requirement form           | Retain independent evidence; affected metadata remains incomplete.      |
| Credential-bearing or unsafe sources; unexpected artifact/metadata fields                   | Fixed safe gaps; no secret retention or ignored resolution semantics.   |
| Missing companion, proven absent root side, generic 404, failed/truncated read              | Absence distinct from unavailable data; no inferred addition/removal.   |
| Nested roots, manifest-only change, rename, incomplete discovery, obsolete binding          | Companions and side identities preserved; no false full-root claim.     |
| Complete files plus empty/omitted comparison or comparison permission/ambiguous 403/429     | Identical file metadata; independent comparison limits remain visible.  |
| One bad side/entry/root beside valid data; zero retained packages with failures             | Preserve validated evidence and every affected scope; no empty success. |
| Each limit at/above its boundary, reordered tables, mutation attempts                       | Bounded deterministic results; explicit exhaustion; detached outputs.   |

The synthetic 403 scenario must pass through D1 and U1, not only call a pure
parser with a hand-written flag. Assert unchanged file-derived snapshots and
the unavailable comparison record. Document its invented provenance; it is
not an archived replay of a private PR. U2/T4 integration must later prove
that uv gaps survive in mixed-ecosystem packets and zero-change failures.

## Boundaries and Success Criteria

- **Always:** Read immutable metadata through D1, validate the tested format,
  preserve variant/selector identity and independent availability, enforce
  trusted limits, and keep unsupported evidence visible for U2.
- **Ask first:** Add/select a TOML or dependency-specifier parser dependency,
  support another schema pair/source/layout, amend T4/T5, or add a data
  category sent outside GitHub. Consumer selection is already confirmed.
- **Never:** Execute PR code or build backends, run uv, install consumer
  dependencies, evaluate markers against the runner, follow metadata URLs,
  publish private fixtures, infer graph truth from names, or turn unavailable
  comparison/security evidence into zero findings. Keep the old reviewer active.

U1 is complete when the tested schemas and manifest structures produce
attributable bounded snapshots, every required failure leaves an explicit
gap, comparison 403 preserves file evidence, the documented U2 handoff loses
no required selectors, and all four implementation checks pass on one
recorded shared revision. U2, research, transport, publication, adoption,
and cutover remain separate gates.

## Open Decisions and Approval

Consumer selection is confirmed. Before implementation, planning must select
the exact TOML reader and dependency-specifier strategy, prove their bound
controls, enumerate supported/ignored fields for schema 1 revisions 3 and 5, and
obtain approval for any new dependency. Numeric live limits remain trusted
orchestration choices; no values are invented here.

The specification and eight-task plan are approved for implementation by
the user's explicit approval and `as-build auto` invocation on 2026-11-01.

The eight-task proposal is tracked as ordered sub-issues
[#152–#159 under #17](https://github.com/andrewpucci/dependency-update-advisor/issues/17)
in the implementation project, Status `Todo`, with native prerequisites.
The gitignored `tasks/plan.md` holds decisions and review checkpoints.
It selects approved `smol-toml@1.9.1` with explicit parser depth controls and
a bounded name-based requirement subset. Merge, adoption, and cutover are
separate from this implementation authorization.
