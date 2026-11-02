# Spec: X1 GitHub Actions Reference Inventory

Status: X1 #16 and #142–#149 implemented on `issue-16`, pending merge.
Approved for execution, 2026-11-01. Supporting contract for
`actions-evidence` in [the capability map](README.md), scoped to
[issue #16: X1](https://github.com/andrewpucci/dependency-update-advisor/issues/16).
Approval: the user invoked `as-plan` on the reviewed, revised specification
on 2026-11-01, explicitly requesting sub-issues and project mapping. This
approves the specification for planning; plan and execution approval remain
separate. This refines the inventory slice of
[Actions evidence](SPEC-actions-evidence.md); it adds no module,
dependency direction, or packet-schema amendment.

Amendment approved 2026-11-01:

- An unsupported reference anywhere in a selected workflow, including an
  unchanged Docker or dynamic reference, prevents complete Actions coverage.
- A comparison record for a selected workflow side that was never read, because
  of the workflow limit or a failed read, keeps that read reason instead of a
  `conflict` gap.

## Objective and Scope

Give maintainers an immutable, occurrence-level inventory of external Actions
and reusable-workflow references changed by a Dependabot PR. Preserve exact
refs and workflow locations even when GitHub's dependency comparison omits an
action. Keep an Actions gap visible in a mixed npm/Actions/uv review.

X1 owns workflow selection, bounded YAML parsing, before/after occurrence
reconciliation, provenance, and Actions inventory coverage. It consumes
[D1](SPEC-github-read.md) and produces inputs for
[T4](SPEC-review-packet.md). Upstream releases, advisory applicability,
malware research, model assessment, rendering, workflow orchestration,
publication, adoption, and parity/cutover remain downstream gates. Complete
inventory does not establish complete research or a successful review.

## Inputs and Immutable Reads

1. Accept a runtime-validated T1 binding, a D1 read session for that binding,
   and explicit trusted parsing/retention limits. Reject invalid identities
   or limits before dependent work. No configuration or PR text may exclude
   a changed workflow in the supported directory.
2. Use D1's `discoverFiles()`, `readFile({ side, path })`, and
   `readComparison()`; do not introduce another GitHub client. Validate result
   repository/revision identities against the binding. An obsolete attempt
   returns no usable inventory and must not be retargeted.
3. Select immediate `.github/workflows/*.yml` and `*.yaml` files from both
   current and previous changed paths. Include additions, removals, renames,
   and moves into or out of that directory. For a rename within it, read the
   previous path at base and current path at head. A move across the
   directory boundary reads only its workflow side; T4 accepts only immediate
   workflow paths, so its occurrences are additions or removals with the
   outside side `null`. Preserve each side's repository, commit SHA, workflow
   path, and resolved blob identity in the collector handoff. Map file
   citations to T4's existing provenance shape.
4. Dependabot's Actions updater can also edit `action.yml` or `action.yaml`
   files, such as a root action or composite actions under `.github/actions/`.
   X1 does not inventory them. A changed path with either basename on either
   side is an `unsupported` Actions gap that prevents `complete` and
   `not_applicable`; do not read or traverse it.
5. Read complete immutable files, never reconstruct YAML from patch text.
   D1's affirmative absence and established add/remove path semantics can
   establish a missing side. A generic 404, failed read, unsupported object,
   or malformed workflow cannot prove that a reference was added or removed.
6. Preserve incomplete discovery, including base/merge-base divergence,
   pagination failure, and budgets. Readable known files do not prove that
   every changed workflow was found. Completed discovery with no changed
   workflow or action-definition paths can support `not_applicable`; empty
   comparison data cannot.
7. Prefer inventory reads before optional comparison corroboration. Respect
   D1's sequential dispatch, cancellation, and cumulative budgets. No retries,
   alternate credentials, checkout, or full-tree fallback are added by X1.

## YAML and Reference Contract

Parse untrusted UTF-8 YAML without executing expressions, tags, actions, or
consumer code. Validate the structure used for `jobs`, job mappings, `steps`,
and `uses`. A workflow is one YAML document with string mapping keys; duplicate
keys, invalid UTF-8, malformed YAML, and incompatible used-field shapes remain
explicit gaps. Do not coerce a non-string `uses` value into a reference or let
YAML boolean coercion reinterpret the ordinary `on` key.

Approved v1 construct support includes finite YAML anchors and aliases.
[GitHub documents aliases of whole jobs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations),
so inventory each effective occurrence at its consuming job/step location.
Bound aliases and expansion before materializing or walking the expanded
graph. Cyclic aliases, unsupported custom tags, merge keys, or constructs the
chosen reader cannot interpret safely leave explicit incomplete coverage;
never silently skip an alias containing `uses` and claim completeness.
This construct support is included in the planning approval above.

The approved plan selects exact runtime `yaml@2.9.1`, with bounded CST
inspection before composition and bounded effective AST traversal. No regex
YAML reader or unrestricted JS conversion is used. Reject unsupported input
explicitly when the reader cannot enforce a required bound.

Require positive safe-integer caller limits for file bytes, workflow count,
parsed nodes/entries, nesting depth, alias expansion, occurrences, and retained
result bytes. Check byte bounds before decoding/parsing and structural bounds
before unbounded traversal or expansion. Limit exhaustion retains only
bounded, attributable evidence with `budget`; it never silently trims a
complete inventory. D1's network budgets and T4's combined 128-change ceiling
remain independent and unchanged.

Inventory these locations, retaining zero-based step indexes:

| Workflow location                                                                          | Reference inventory                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs[jobId].steps[index].uses`                                                            | External repository action, including repository subpaths.                                                                                |
| `jobs[jobId].uses`                                                                         | External repository reusable workflow, with `stepIndex: null`.                                                                            |
| Local `./` reference                                                                       | Recognized local reference; no external dependency record. Transitions to/from an external reference still account for the external side. |
| Docker, dynamic, missing-ref, or otherwise uninterpretable reference, changed or unchanged | Explicit scoped `unsupported` or `malformed` gap; no fabricated repository/ref.                                                           |

Do not traverse local action definitions, reusable-workflow dependencies, or
Docker registries. An unsupported reference anywhere in a selected workflow
prevents a completeness claim, even when unchanged.
Ignore `uses` text inside comments, `run` scripts, names, or arbitrary mappings.
Preserve independently valid occurrences when another job is unsupported;
do not salvage references from syntactically broken YAML using regexes.

For an interpretable external reference, separate `owner/repository[/subpath]`
from its exact YAML string ref. Preserve spelling, case, and ref text without
trimming, version coercion, or removing a leading `v`. A comment suggesting a
release version is not ref identity; X1 retains no YAML comments. A full
40-hex commit ref can be `sha`; use `unknown` for other refs unless their
tag/branch kind is attributable. `v1` and `main` alone do not prove tag or
branch existence. Do not resolve refs or invent a semantic version during X1
collection. Preserve original ref text in the collector snapshot if T4
normalizes SHA casing. Reject unsafe control characters, credentials, and
invalid repository/path forms with a safe fixed gap rather than copying them
into diagnostics.

## Occurrence Reconciliation and Determinism

1. Preserve distinct workflow/job/step occurrences of the same action.
   One exact base occurrence and one exact head occurrence can each belong
   to at most one change. Never collapse by action name or ref alone.
2. Pair only when workflow correspondence, job, and step correspondence are
   established. A validated D1 rename can establish workflow correspondence;
   job correspondence requires the same job ID. A job-level `uses` pairs on
   workflow and job correspondence alone. A step `id` unique within the
   job on both sides establishes step correspondence. Otherwise, steps
   correspond by index only when the job has the same step count on both
   sides and every index has the same action identity, or no `uses`, on both
   sides; refs, comments, and other step fields are ignored. A ref-only
   Dependabot bump therefore pairs as `update`. Index alone after an
   insertion/removal/reorder, display name, or identical action name in
   different jobs cannot establish pairing.
3. A paired same-action ref change is `update`, with exact old/new locations
   and refs. A changed action identity is a removal plus addition. An
   established one-sided external occurrence is `addition` or `removal` with
   the opposite side exactly `null`. External/local transitions account for
   the external removal/addition without inventing a local package identity.
4. Unchanged action/ref pairs produce no dependency change merely because
   unrelated workflow settings changed. A proven location-only move can stay
   unchanged while retaining its before/after snapshot locations. If a rename
   or reorder prevents reliable correspondence, retain identifiable sides as
   removal/addition records with an explicit pairing gap; do not label them
   a verified version update. Missing unreadable sides remain snapshot
   evidence and gaps, never falsely proven additions/removals.
5. Return normalized occurrence snapshots as well as changes so a readable
   side is not lost when its counterpart cannot be interpreted. Unsupported
   identities that T4 cannot represent remain scoped gaps outside `changes`;
   do not weaken T4 to manufacture a packet record.
6. Stable IDs use an unambiguous encoding of bound review identity and
   semantic occurrence sides. If hashing, detect collisions. Sort using
   locale-independent code-unit order. Changing discovery, comparison, or
   job-map iteration order must not change IDs, counts, or source attribution;
   changing the actual ordered step sequence may change location identity.

## Comparison, Coverage, and Packet Handoff

Treat D1 comparison records as untrusted corroboration. GitHub's Actions records
carry the workflow `manifest`, the action `name` including any subpath, a
`version`, and an `added` or `removed` change type; they carry no job or step.
Dependency-graph versions can be full SHAs or refs with a leading `v` removed,
so they are not exact ref identity. Match a record to the set of occurrences
with the same workflow, action/subpath, and side (`removed` is base, `added` is
head). It corroborates a ref that equals `version`, equals it after removing one
leading `v`, or, for a 40-hex ref, equals it ignoring case. One record
corroborates every occurrence in that set, so repeated occurrences are not
ambiguous, and it corroborates no other workflow. Comparison-only records cannot
create verified file-backed changes. Do not duplicate occurrences or overwrite
file refs with version descriptions. X1 accepts no Dependabot PR text and adds
no PR-body fetch or provider call.

An available empty comparison, omitted action or workflow, permission 403,
ambiguous 403, rate limit, or partial comparison cannot erase workflow
changes. Retain comparison availability and fixed reasons independently.
Comparison failure or omission alone does not make an otherwise proven
workflow inventory incomplete; actual file/discovery failures still do. A
record whose workflow, action/subpath, and side match no file-backed
occurrence is a `conflict` gap that prevents `complete`, unless that workflow
side was selected but never read; it then keeps the read reason. A matched record
whose `version` corroborates none of the set's refs stays a visible
comparison discrepancy without lowering inventory coverage.

Return detached readonly binding, changes, sources, occurrence snapshots,
scoped gaps, Actions inventory coverage, and comparison availability. Gaps
name workflow, side, job/step when known, and a T4 fixed reason. Preserve D1
reasons without raw YAML, PR text, exceptions, or response bodies. Use T4's
existing `complete`, `partial`, `unavailable`, and evidence-backed
`not_applicable` meanings. `complete`, including zero changes, requires
completed discovery and readable base/head files for every relevant workflow;
it does not require an available dependency comparison. Preserve known
changes with incomplete coverage.

Use existing `ActionsSide` fields and explicit change kinds; these references
are direct workflow dependencies, not npm graph nodes. For example, the
existing packet shape retains a job-level location without an invented index:

```ts
const side: ActionsSide = {
  workflow: '.github/workflows/example.yml',
  jobId: 'review',
  stepIndex: null,
  action: 'example/automation/.github/workflows/review.yml',
  ref: 'v2',
  refKind: 'unknown',
  sourceId: 'head-workflow',
};
```

Each non-null side cites the correct immutable file source. Required
`upstream`, `vulnerability`, and `malware` evidence records remain explicit;
unperformed research is `unavailable` with `missing`, not zero findings.
Optional unchecked signals remain optional. X1 emits no researched security
finding or relationship proof. Exercise T4 validation with minimally completed
packet envelopes and preserve T5 standalone handling. Packet validity grants
neither a fresh head nor authority for T2/T3 writes. An npm-complete result
cannot hide an Actions gap, including a zero-change Actions failure.

## Tech Stack, Project Structure, and Code Style

Use the existing Node.js `>=24.11.0 <25`, ESM, strict TypeScript, and Vite+
stack. Follow adjacent collectors: `unknown` at external boundaries,
discriminated results, camelCase, single quotes, small pure parsers, and
injected D1 sessions for tests. The code example above uses the existing
schema; public function/type names and helper boundaries are planning choices.

| Location                        | Responsibility                                           |
| ------------------------------- | -------------------------------------------------------- |
| `src/evidence/actions.ts`       | X1 immutable occurrence inventory and coverage.          |
| `src/evidence/actions.test.ts`  | Parsing, reconciliation, D1 handoff, and T4/T5 fixtures. |
| `tests/parity/`                 | Sanitized omission scenario and provenance limits.       |
| `src/schema.ts`, `src/units.ts` | Existing T4/T5 consumers; no contract change proposed.   |
| `docs/specs/`                   | Inventory contract and approval index.                   |

## Commands and Testing Strategy

For this documentation change:

```sh
npm run lint:md
npm run format:check
git diff --check
```

Implementation verification uses the existing repository commands:

```sh
npm ci
npm run lint
npm run format:check
npm run check
npm test -- --run
```

No build command exists; packaging remains A1. Record the exact shared
revision, working-tree edits, environment, commands, outcomes, and unrun
checks in the relevant issue/PR. Unit fixtures do not certify live transport,
permissions, research, disclosure, publication, adoption, or cutover.

Use synthetic YAML and mocked D1 results, including a collector-to-T4/T5
handoff. Tests must check actual locations, refs, counts, source membership,
and independent coverage rather than only matching snapshots.

| Fixture                                                                                                   | Required result                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Step action; reusable workflow; repository subpath; duplicate occurrences                                 | Exact distinct locations and refs, once per changed occurrence.                                                        |
| Quoted/unquoted refs, SHA/tag-like/branch-like text, misleading version comments                          | Preserve refs; unsupported classification stays unknown.                                                               |
| Add/remove workflow, job, step, or action; identity replacement; local transition                         | Correct explicit kinds and null sides; no name-based invented update.                                                  |
| Ref-only bump in steps without IDs or a job-level reusable workflow; step ID kept across an inserted step | Paired `update` with exact old/new sides; `stepIndex: null` for job-level `uses`.                                      |
| Rename, move into/out of workflows, inserted/reordered steps, repeated names                              | Side locations kept; cross-directory moves null-sided; correspondence or pairing gap.                                  |
| Changed root or composite `action.yml`/`action.yaml`, alone or with workflows                             | `unsupported` Actions gap; never `complete` or `not_applicable`.                                                       |
| Unchanged action in edited workflow; comments and `run` text containing `uses`                            | No phantom external change.                                                                                            |
| Anchored job/step/ref; repeated aliases; cycle; excessive expansion                                       | Each effective occurrence counted; invalid/bounded failures visible.                                                   |
| Malformed YAML/UTF-8, duplicate keys, non-string `uses`, unsupported tags/merge keys                      | Fixed scoped gaps; no regex recovery or false empty success.                                                           |
| Dynamic/Docker reference; failed/missing/truncated side; incomplete discovery                             | Retain known evidence; no false absence or complete coverage.                                                          |
| Empty/omitted comparison, 403, rate limit, including a `run`-only workflow edit                           | File inventory survives; complete files give `complete` Actions coverage, even with zero changes; limits stay visible. |
| One record for repeated occurrences; `v`-stripped version; unmatched record                               | Set corroborated; version discrepancy visible; unmatched record is a `conflict` gap.                                   |
| Mixed npm/Actions/uv packet, including zero Actions changes with a gap                                    | T4/T5 preserve per-ecosystem gaps and distinct repeated occurrences.                                                   |
| Each parsing/retention limit at and above boundary; reordered input maps                                  | Bounded results with explicit exhaustion; deterministic IDs and output.                                                |
| More than 128 combined packet changes; mutated returned data                                              | Existing packet rejection preserved; no silent trimming or shared mutation.                                            |

The [PR #302 baseline handoff](../../tests/parity/scenarios.md#public-actions-comparison-omission-pr-302)
records workflow-derived evidence for `voidzero-dev/setup-vp`,
`github/codeql-action/upload-sarif`, and `chromaui/action`, and its
[comparison shape](../../tests/parity/scenarios.md#comparison-shape-observed-2026-11-01).
Create a
sanitized immutable base/head workflow fixture derived from that documented
scenario, with synthetic repository identities, SHA refs, ref-only bumps, and
clearly stated provenance. Run it with an empty comparison and with a
synthetic comparison of the observed shape: records for only some workflows
and none for the CodeQL subpath action. Assert that every changed occurrence
in every workflow, including that action, is a paired `update` with exact
refs and locations, and that a record in one workflow corroborates no other
workflow. Document that these are synthetic comparison responses, not an
archived historical API replay or full-PR parity.
Do not fetch new live fixtures or publish raw consumer workflow contents as
part of this specification change.

## Boundaries and Success Criteria

- **Always:** Use immutable D1 evidence, preserve exact refs and occurrences,
  enforce trusted bounds, validate packet handoffs, retain scoped uncertainty,
  and keep comparison and research availability distinct from inventory.
- **Ask first:** Add/select a YAML dependency, change the proposed YAML subset,
  expand workflow directories, inventory `action.yml` files, amend T4/T5,
  add research providers, or claim security applicability for unresolved
  refs. The selected `yaml@2.9.1` dependency is authorized by the approved
  execution plan; changing it requires a new decision.
- **Never:** Execute PR/action code, evaluate expressions, follow untrusted
  URLs, invent SHA versions, expose credentials/raw payloads, suppress gaps
  behind another ecosystem, or infer zero dependencies/vulnerabilities from
  unavailable comparison evidence. Keep the old reviewer active.

X1 is complete when the fixtures establish exact occurrence inventory and
honest failure coverage, the omission scenario retains the missing action,
T4/T5 retain separate Actions coverage in mixed packets, and all four
implementation checks pass on one recorded shared revision. Research,
orchestration, rendering, publication, consumer adoption, and cutover gates
remain explicit.

## Open Questions and Approval

No new module boundary or packet amendment is proposed. The approved X1
contract includes bounded anchors/aliases and conservative pairing.
The approved plan selects `yaml@2.9.1` and its bounded CST/AST controls.
Numeric live budgets remain trusted orchestration choices.

The parent spec's Dependabot PR-body corroboration (requirement 4) has no
assigned issue, and X1 neither fetches nor accepts PR text. Assign it before
S2 #20 planning or amend the parent spec; until then, SHA-pinned refs have no
version hint beyond attributable upstream research.

Dependabot can also read workflow YAML in any directory configured for its
`github-actions` ecosystem, not only `action.yml` files. X1 does not detect
such configured directories, so a PR changing only one can still look
`not_applicable`. Expanding directories remains an Ask-first decision.

Spec approval, plan approval, and execution authorization remain separate.

The proposed eight-task plan is tracked as ordered sub-issues #142–#149 of
[#16](https://github.com/andrewpucci/dependency-update-advisor/issues/16),
with native dependencies in the implementation project.
The gitignored `tasks/plan.md` holds the working handoff and checkpoints.
Plan approval: the user explicitly answered `approved` on 2026-11-01 and
invoked `as-build auto`, authorizing all eight tasks, the exact `yaml@2.9.1`
runtime dependency, per-task commits, and one PR covering #16 and #142–#149.
This single approval replaces manual stops between the plan checkpoints;
each checkpoint still requires its verification. Merge, adoption, and cutover
remain separate gates.

## Implemented Handoff and Remaining Gates

`src/evidence/actions.ts` exports
`collectActionsInventory({ binding, limits }, { session })`. It accepts unknown
input and returns `invalid`, `obsolete`, fixed `unavailable`, or an immutable
`inventory` with changes, sources, workflow snapshots, scoped gaps, Actions
coverage, and independent comparison availability. It adds no caller roots
or PR-text input. `ActionsLimits` names required byte/workflow/node/depth/
alias/occurrence/retention bounds; count accounting spans both revisions.

The reader lives in `src/evidence/actions-yaml.ts`. Snapshots retain exact
safe reference and location data with immutable file identities, without raw
YAML, comments, or scripts. File/comparison source scopes split at T4's
existing member bound. Retention overflow produces explicit budget coverage
and a fitting attributable prefix, or a fixed unavailable envelope; it does
not enlarge or silently satisfy the packet ceiling.

[Verification #149](https://github.com/andrewpucci/dependency-update-advisor/issues/149)
records exact revisions, checks, independent review, mutation checks, and
resolved finding disposition. The sanitized fixture covers omission fallback
through D1/X1/T4/T5; it does not certify all source-PR parity or live operation.
PR-body ownership before S2 #20, nonstandard configured directories, numeric
live budgets/transport, S2/S3 research, M2/O1, W1/W2 publication, adoption, and
cutover remain separate. Keep the old reviewer active.
