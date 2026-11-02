# Baseline Scenario Handoff

These scenarios identify what extraction must compare with the
[selected committed baseline](README.md). Public observations, mocked probes,
and required future behavior are distinguished below. No fixture here
contains private consumer evidence or raw model packets.

## Public Actions Comparison Omission: PR #302

Provenance: the approved [parity contract](../../docs/specs/SPEC-parity-cutover.md)
records [public PR #302](https://github.com/andrewpucci/andrewpucci.com/pull/302)
as an observed comparison omission. The source-local pilot note corroborates
four comparison changes for two actions versus three reviewer updates.

The public PR metadata and five workflow patches retrieved on 2026-10-03 name
base `35f21989610f27b2bc2cfd696119a7109c203616` and head
`90d1bb3a6d455befd743e65b9f24b063204a984b`. The updates are:

| Action                              | From   | To     |
| ----------------------------------- | ------ | ------ |
| `voidzero-dev/setup-vp`             | 1.18.0 | 1.21.0 |
| `github/codeql-action/upload-sarif` | 4.37.9 | 4.38.1 |
| `chromaui/action`                   | 18.7.2 | 18.9.4 |

Existing passing assertion:
[`inputs.test.ts:826`](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/inputs.test.ts#L826)
includes an Action from workflow evidence when comparison returns an empty
array. It uses synthetic action data, not an archived PR #302 API response.

A separate no-write probe used those public workflow `uses` diffs and the three
version descriptions, a synthetic comparison containing only the other two
actions, and mocked 404 upstream responses. The baseline returned all three
updates, including `github/codeql-action/upload-sarif`, as `direct:workflow`.
Command: `node .context/b1-actions-probe.mjs`, exit 0. This confirms the fallback
mechanism with public inputs; it is not a live comparison-endpoint replay.
The equivalent command is preserved under [Reproducing the Actions Probe](#reproducing-the-actions-probe).

Required shared behavior: reconcile comparison data with immutable workflow
evidence and account for updates, additions, removals, and coverage gaps. A
grouped or repeated workflow occurrence must not conceal an omitted action.

### Comparison Shape Observed 2026-11-01

Read-only public API requests reached the same five changed workflows. The
dependency comparison for the base and head above returned `removed`/`added`
records for `voidzero-dev/setup-vp` and `chromaui/action` in only one of those
workflows, with full-SHA `version` values, a `manifest` path, and no job or
step. It returned no CodeQL record. The repository's dependency-graph SBOM names
that action `github/codeql-action/upload-sarif`. A public `actions/setup-node`
SBOM lists an `actions/publish-action@v0.4.0` reference as version `0.4.0`.
These are current-state observations, not archived PR-time responses.

### X1 Synthetic Immutable Workflow Fixture

[The Actions inventory fixture](actions-inventory.ts) derives its three action
identities and omission shape from the documented scenario. Its repository,
five workflow names, eight occurrences, full-SHA ref strings, object data,
and API responses are synthetic. The files contain ref-only bumps without
step IDs, including repeated setup references and the CodeQL subpath action.

The fixture runs through the real D1 tree/blob reader, X1 collector, T4 packet
validator, and T5 partitioner. Both an empty comparison and a synthetic
comparison restricted to the preview workflow retain all eight paired
updates. No comparison record names CodeQL, and evidence in one workflow
cannot corroborate another. This verifies the omission fallback and occurrence
accounting; it does not replay the historical comparison payload, reproduce
all original PR contents, or certify live research, publication, or cutover.

## Public npm Unpaired Additions: PR #307

Provenance: the approved parity contract and source-local pilot note identify
[public PR #307](https://github.com/andrewpucci/andrewpucci.com/pull/307).
The pilot recorded 289 raw changes, 152 additions with 151 distinct added names,
and 131 paired reviewer updates: 22 direct and 109 transitive. The remaining
20 distinct additions had no corresponding removal and were not reviewed as
version updates.

Historical limitation: that pilot note does not bind the comparison payload
to an immutable base/head pair or retain the 20 names. Do not label currently
available PR files as that historical payload. Metadata retrieved on
2026-10-03 gives base `afaa300df0dead6733202fdab8879dff8fc1ec2e` and head
`e96f3c8f583a4e7d309f52db5598313b7645d00e`. Their public lockfile blobs are
`fc2421d40b4db3db93bd9326d2bd7a8802033059` and
`b7b8ccf2d1c83714107a427630f0437f10618ab8` respectively.

Inspection of those immutable lockfiles found 35 newly occupied installed
paths, 32 removed paths, 34 distinct names among the newly occupied paths,
and six names absent from every base installed path. The manifest changes
only `vite-plus` and `wrangler`. These path-level counts are not GitHub
comparison records and do not reproduce the pilot's 20-addition observation.

Baseline behavior: the committed
[`dependencyUpdates` filter](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/inputs.mjs#L228)
requires both `from` and `to`. Lockfile coverage classifies only supplied
updates; it does not independently inventory unpaired additions or removals.
A synthetic probe supplied exactly 20 added-only npm comparison records and
no manifest update pair. `collectReviewInput` returned `null`, confirming that
none of those additions formed a review packet.

Existing tests cover paired npm versions, direct classification, and
lockfile grouping. There is no existing focused assertion that retains 20
unpaired additions. The probe establishes a known defect, not a passing
shared-reviewer scenario.

Required shared behavior: keep every addition and removal in the inventory,
assess it or mark its coverage incomplete, and preserve change counts.
Use a clearly labeled synthetic 20-addition scenario during extraction;
the original historical API response is unavailable in this baseline record.

### N1 Synthetic Inventory Fixture

[The synthetic npm fixture](npm-inventory.ts) models 20 distinct transitive
additions alongside one paired anchor update, with unchanged direct manifest
declarations. Its package names and immutable API-shaped objects are synthetic;
it does not recreate the historical pilot response or its missing identities.
[The integration suite](../../src/evidence/npm.integration.test.ts) passes the
fixture through the real D1 session using mocked transport, then N1 inventory,
T4 validation, and T5 units. Every addition retains a null base side and its
own identity, including when the comparison is empty, omits additions, or
returns a permission, rate-limit, or unknown 403.

Additional variants cover declaration-only edits, mixed-ecosystem gaps, and
the combined 128/129-record boundary. They exercise inventory and unit handoff,
without claiming live transport, completed assessments, publication, or parity
with the full historical PR.

## Approved T4 Large-PR Limit

The [T4 packet contract](../../docs/specs/SPEC-review-packet.md) caps the complete
inventory at 128 changes across all ecosystems. The user approved hard rejection
above that bound, including a grouped PR like #307, as an intentional parity
difference. The isolated packet validator returns a `budget` failure with no
usable partial packet; it never trims the inventory to fit.

W2 must turn that failure into the existing failed current-head status while
leaving the prior managed comment unchanged. T4 tests cover exact 128-change
acceptance, 129-change rejection, and preservation of the synthetic 20 unpaired
additions within the limit. They do not verify W2 writes or certify the full
historical #307 inventory. Supporting larger packets requires a reviewed
contract change; adoption and cutover gates remain in force.

## T5 Conservative Grouping and Standalone Resolution

The [T5 contract](../../docs/specs/SPEC-decision-units.md) consumes T4's positive
relationship proofs rather than parsing the baseline's complete npm lockfile
graph. Its approved initial scope requires complete ecosystem inventory and
exactly one direct change per root, counting both revisions and all change
kinds. Unknown roles prevent grouping. Root-moving records cannot anchor or
enter a group; they remain standalone to preserve the single-root boundary.

The baseline could distinguish uniquely related members in a root with several
changed direct dependencies by walking its full graph. T5 leaves those members
standalone, because an omitted positive proof cannot establish that another
anchor is unreachable. This can increase decision-unit counts and provider
work; M2 must preserve every unit or report it unresolved, never drop members
to fit. [Follow-up #93](https://github.com/andrewpucci/dependency-update-advisor/issues/93)
tracks a reviewed collector/T4 extension for broader grouping and is not a
blocker of the initial T5 implementation.

Sharing with unchanged direct dependencies alone does not prevent grouping
with the one changed direct anchor. Grouping records a proven relationship,
without claiming causation, exclusive reachability, individual research, or
safety. Each member retains its own required evidence and findings; T5 does
not manufacture `group_backed` evidence from the anchor's lookups.

An ungroupable member remains unresolved until its own assessment is validated.
A complete standalone assessment and required evidence can resolve that unit,
with relationship uncertainty still visible. Concrete unanswered required
questions remain evidence gaps under C3. This explicitly separates the
baseline's standalone-unresolved grouping label from completed assessment.

Synthetic fixtures cover stable base/head-bound identities, both proof sides,
direct removals beside updates, root moves, duplicate names/variants,
member-specific gaps, verified holds with unavailable analysis, and packet-wide
gaps with zero known changes. A proven empty inventory has no merge verdict
or model assessment. These isolated tests do not certify collector graph
truth/completeness, M2 budgets/validation, O1 visibility, workflow publication,
consumer adoption, or cutover. The final parity review must assess the intended
differences above before retiring the old reviewer.

## Synthetic Unavailable Comparison

No private PR or uv input is included. A direct-collector probe returned a
mocked HTTP 403 with no fallback package pair. It produced `null`, not an
explicit unavailable-comparison record. This probe bypasses the request
governor: the full source flow also treats 403/429 as a request-limit signal.
It does not prove the complete runner's behavior or a uv implementation.

Existing passing assertions cover bounded GitHub request stopping and
per-unit incomplete coverage. They do not certify endpoint-permission failure
classification or uv inventory. The local excluded changes also protect an
older comment when any falsy packet follows a request limit.

Required shared behavior: an unavailable comparison must remain distinguishable
from a successful empty response. Immutable evidence supplies inventory where
possible; otherwise coverage is explicitly incomplete. An unavailable uv
endpoint is a future sanitized synthetic scenario, never evidence of zero
changes or vulnerabilities.

## Synthetic Introduced Vulnerability

Existing passing assertions include
[`inputs.test.ts:950`](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/inputs.test.ts#L950)
for nonempty vulnerability findings and
[`policy.test.ts:99`](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/policy.test.ts#L99)
for blocking high/critical findings. The
[`batches.test.ts:324`](https://github.com/andrewpucci/andrewpucci.com/blob/0f767f27c92f55fc5aecf1cc93cacb3897d6290b/.github/actions-scripts/dependabot-review/batches.test.ts#L324)
case preserves a deterministic blocker when one other model batch succeeds.

Gap: when every model batch is unavailable, the committed fallback discards
deterministic blockers. A separate synthetic probe with one policy blocker
returned `analysis_unavailable` and `blockers: []`. The excluded local
`batches` change addresses this case, but is not part of the selected SHA.

Required shared behavior: retain nonempty advisory findings and deterministic
blockers even when analysis is unavailable. The public pilot did not exercise
an introduced vulnerability. Collector-to-comment introduced-vulnerability
coverage remains a required synthetic extraction/parity scenario.

## Reproducing the Actions Probe

Run this equivalent no-write command from an isolated checkout of the
[selected baseline SHA](README.md). The workflow patches are the public
PR #302 `uses` diffs trimmed to changed action lines, and the three version
descriptions are copied from its public body. The four comparison records are
synthetic; all upstream requests return mocked 404 responses. No external
request or write occurs.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { collectReviewInput } from './.github/actions-scripts/dependabot-review/inputs.mjs';
const event = {
  "repository": "andrewpucci/andrewpucci.com",
  "pull_request": {
    "number": 302,
    "base": {
      "sha": "35f21989610f27b2bc2cfd696119a7109c203616"
    },
    "head": {
      "sha": "90d1bb3a6d455befd743e65b9f24b063204a984b"
    },
    "user": {
      "login": "dependabot[bot]"
    },
    "body": "Updates `voidzero-dev/setup-vp` from 1.18.0 to 1.21.0\nUpdates `github/codeql-action/upload-sarif` from 4.37.9 to 4.38.1\nUpdates `chromaui/action` from 18.7.2 to 18.9.4"
  },
  "files": [
    {
      "filename": ".github/workflows/ci.yml",
      "patch": "-        uses: voidzero-dev/setup-vp@1b32467adbe183473499fd9d5d372c3ed9641754 # v1.18.0\n+        uses: voidzero-dev/setup-vp@24d870228786dc83ae73482406bdd1e7befaec14 # v1.21.0"
    },
    {
      "filename": ".github/workflows/frontend.yml",
      "patch": "-        uses: voidzero-dev/setup-vp@1b32467adbe183473499fd9d5d372c3ed9641754 # v1.18.0\n+        uses: voidzero-dev/setup-vp@24d870228786dc83ae73482406bdd1e7befaec14 # v1.21.0"
    },
    {
      "filename": ".github/workflows/performance.yml",
      "patch": "-        uses: voidzero-dev/setup-vp@1b32467adbe183473499fd9d5d372c3ed9641754 # v1.18.0\n+        uses: voidzero-dev/setup-vp@24d870228786dc83ae73482406bdd1e7befaec14 # v1.21.0"
    },
    {
      "filename": ".github/workflows/scorecard.yml",
      "patch": "-        uses: github/codeql-action/upload-sarif@cdf488f595d80d6e07e03d4674febd5ab45fa938 # v4.37.9\n+        uses: github/codeql-action/upload-sarif@1c5b675653bb5c22dbe9b12b556ec555138e09fd # v4.38.1"
    },
    {
      "filename": ".github/workflows/visual-regression.yml",
      "patch": "-        uses: voidzero-dev/setup-vp@1b32467adbe183473499fd9d5d372c3ed9641754 # v1.18.0\n+        uses: voidzero-dev/setup-vp@24d870228786dc83ae73482406bdd1e7befaec14 # v1.21.0\n-        uses: chromaui/action@2a0b63f30233c48591844a46d451b9cf68128186 # latest (v18.1.0)\n+        uses: chromaui/action@bb3b582719a93c1828c5e520e62992b2937d7889 # latest (v18.1.0)"
    }
  ]
};
const changes = [
  {
    "ecosystem": "actions",
    "name": "voidzero-dev/setup-vp",
    "change_type": "removed",
    "version": "1.18.0",
    "manifest": ".github/workflows/example.yml",
    "vulnerabilities": []
  },
  {
    "ecosystem": "actions",
    "name": "voidzero-dev/setup-vp",
    "change_type": "added",
    "version": "1.21.0",
    "manifest": ".github/workflows/example.yml",
    "vulnerabilities": []
  },
  {
    "ecosystem": "actions",
    "name": "chromaui/action",
    "change_type": "removed",
    "version": "18.7.2",
    "manifest": ".github/workflows/example.yml",
    "vulnerabilities": []
  },
  {
    "ecosystem": "actions",
    "name": "chromaui/action",
    "change_type": "added",
    "version": "18.9.4",
    "manifest": ".github/workflows/example.yml",
    "vulnerabilities": []
  }
];
const input = await collectReviewInput(event, { fetchLike: async (url) => url.includes('/dependency-graph/compare/') ? new Response(JSON.stringify(changes)) : new Response('', { status: 404 }) });
assert.equal(input.packages.length, 3);
assert(input.packages.some(p => p.name === 'github/codeql-action/upload-sarif'));
console.log(JSON.stringify({scenario:'public-302-with-synthetic-omission',packages:input.packages.map(p => ({name:p.name,from:p.from,to:p.to,dependencyType:p.dependencyType}))}, null, 2));

JS
```

## Reproducing the Synthetic Gap Probes

The three synthetic gap probes ran together as
`node .context/b1-probes.mjs`, exit 0. All network and model functions were
substituted; no external request or write occurred. The following equivalent
command uses only the selected source's modules. Run it from an isolated
checkout of the baseline SHA, not from the shared repository:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { collectReviewInput } from './.github/actions-scripts/dependabot-review/inputs.mjs';
import { analyzeBatches } from './.github/actions-scripts/dependabot-review/batches.mjs';

const pull_request = {
  number: 42, base: { sha: 'synthetic-base' }, head: { sha: 'synthetic-head' },
  user: { login: 'dependabot[bot]' },
};
const event = { repository: 'example/baseline', pull_request, files: [] };
const additions = Array.from({ length: 20 }, (_, index) => ({
  change_type: 'added', manifest: 'package-lock.json', ecosystem: 'npm',
  name: `synthetic-added-${index + 1}`, version: '1.0.0', vulnerabilities: [],
}));
assert.equal(await collectReviewInput(event, {
  fetchLike: async () => new Response(JSON.stringify(additions)), collectCoverage: true,
}), null);
assert.equal(await collectReviewInput(event, {
  fetchLike: async () => new Response('', { status: 403 }), collectCoverage: true,
}), null);

const dependency = {
  name: 'synthetic-vulnerable', from: '1.0.0', to: '2.0.0',
  dependencyType: 'direct:development', license: null,
  evidence: { status: 'available', reason: null },
  context: { status: 'unavailable', facts: [] }, findings: [],
  sources: [{ kind: 'release-notes', url: 'https://example.com/release',
    title: 'Synthetic release', excerpt: 'Synthetic evidence.',
    range: { from: '1.0.0', to: '2.0.0' } }],
};
const result = await analyzeBatches({
  pullRequest: { number: 42, baseSha: 'synthetic-base', headSha: 'synthetic-head' },
  packages: [dependency],
  policy: { verdictCeiling: 'do_not_merge', findings: [{
    package: { name: dependency.name, from: dependency.from, to: dependency.to },
    findingId: 'synthetic:blocker', verdict: 'do_not_merge',
    reason: 'Synthetic critical vulnerability.', sourceUrl: dependency.sources[0].url,
    remediation: ['Update the package.'], validation: ['npm test'],
  }] },
}, { analyzeBatch: async () => ({ verdict: 'analysis_unavailable' }) });
assert.equal(result.verdict, 'analysis_unavailable');
assert.deepEqual(result.blockers, []);
console.log('Three known baseline gaps reproduced.');
JS
```

These assertions describe observed defects. Shared-reviewer acceptance must
assert the required corrected behavior, not copy these expected gaps.

## U1 Synthetic uv Metadata and Comparison Failures

[The uv fixture](uv-metadata.ts) invents a static manifest, four optional
extras, marker-split declarations, conditional and source/version-qualified
edges, two locked versions of the same normalized name, and an editable
project anchor. Its base is schema 1 revision 3; its head is schema 1
revision 5. The head records an empty extra table that the base omits.
All names, versions, repositories, commits, trees, and HTTP responses are
synthetic. The fixture preserves observed format structures; it copies no
private consumer metadata and is not a historical PR or API replay.

[`uv.integration.test.ts`](../../src/evidence/uv.integration.test.ts) drives
actual `createGithubReadSession` and `collectUvMetadata` exports over mocked
GitHub HTTP routes. Empty and uv-omitting comparisons, permission and ambiguous
403s, rate-limit 403/429s, and partial comparisons retain identical file-derived
snapshots and source membership. Comparison reasons stay separate. Missing,
malformed, and unsupported head companions preserve the supported base and head
manifest. A discovery permission failure still permits trusted-root reads,
while discovery remains explicitly incomplete.

U2 must consume manifest list positions, all locked variants and qualified
selectors, missing-versus-empty metadata, and every root/side/file/entry gap,
including failures with zero retained packages. The combination of enclosing
snapshot identity and package key identifies an immutable package occurrence.
These U1 fixtures produce no changes, direct/transitive classifications,
relationship proofs, or final T4 inventory coverage. A header revision or an
empty extra's serialization change alone is not a package or extra change.

Separate gates remain U2 reconciliation and PR-body corroboration, mixed
T4/T5 packet integration, security/upstream research, live transport and
numeric budgets, assessment/rendering, workflow/publication, adoption, and
cutover. These tests certify neither a live consumer run nor zero changes or
zero vulnerabilities. Keep the old reviewer active.
