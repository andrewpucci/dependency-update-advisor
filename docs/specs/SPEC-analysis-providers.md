# Spec: Analysis Providers

Status: approved for planning, 2026-09-23. Module: `analysis-providers` in
[the capability map](README.md).

## Objective

Give the shared reviewer one provider-neutral analysis contract while shipping
one tested Mistral adapter in v1. The model explains validated dependency
evidence and trusted repository context for a maintainer; it cannot create
evidence, remove deterministic findings, or turn an incomplete decision into
a merge recommendation. A failure for one grouped decision unit must not
discard valid assessments for the others.

The [source reviewer's analysis contract](https://github.com/andrewpucci/andrewpucci.com/blob/main/SPEC-analysis-contract.md)
and [decision-coverage contract](https://github.com/andrewpucci/andrewpucci.com/blob/main/SPEC-dependabot-decision-coverage.md)
are the fidelity baseline. The shared contract uses decision units so a
proven direct-update group is not described as individual research for every
transitive member.

## Tech Stack

The adapter uses Node.js 24 ESM with strict TypeScript source, the validated
shared review packet, and bounded `fetch` calls to the
[Mistral chat-completions API](https://docs.mistral.ai/api). Mistral's
`json_object` mode produces JSON, but [does not enforce this reviewer's
schema](https://docs.mistral.ai/resources/known-limitations); local validation
remains mandatory. The provider credential enters through the named
`llm_api_key` workflow secret, never through repository JSON.

## Commands

After implementation, this repository must provide:

```sh
npm ci
npm test -- --run
npm run lint
npm run check
npm run build
```

Until extraction, use the source repository's focused analysis, schema, and
batch tests as a comparison baseline; their runner and file set must be
verified in that checkout before use.

## Project Structure

```text
shared repo: src/analysis/contract.ts     → provider-neutral packet and result validation
shared repo: src/analysis/mistral.ts      → fixed-endpoint Mistral transport
shared repo: src/analysis/batches.ts      → bounded unit scheduling and aggregation
shared repo: src/analysis/*.test.ts        → transport, schema, and failure fixtures
consumer: .github/dependabot-review.json   → explicit provider and model selection
```

## Code Style and Analysis Contract

Use stable decision-unit IDs tied to the validated ecosystem, package or
group identity, and reviewed head. Project only bounded fields into model
requests. Keep `provider` selection outside the common packet and adapter
code. A provider result is untrusted until its decision-unit IDs, findings,
references, and verdict have been checked against the exact projected input.

```ts
if (!packet.units.some((unit) => unit.id === assessment.unitId))
  throw new TypeError('analysis references an unknown decision unit');
```

The common result carries one assessment per attempted decision unit, with a
short reason, allowed evidence references, an action when needed, and a
verdict constrained by deterministic policy. It also carries explicit
`unavailable` or `unattempted` records. The renderer receives only this
validated result, never raw provider text.

## Requirements

1. Accept only a packet already validated by the shared reviewer: exact PR
   head, ordered decision units, provenance-bearing upstream sources, trusted
   context, coverage limits, and deterministic policy findings. Source text,
   Dependabot text, and model responses are data, not instructions.
2. Select a provider only from trusted configuration. V1 accepts `mistral`
   with a bounded model ID; an unknown provider, missing model, or missing
   credential is an unavailable analysis result and makes current-head review
   execution fail. Never silently choose another provider or model.
3. Fix the Mistral HTTPS endpoint in the adapter. Send the secret only to
   that endpoint. Validate response status, content type, body size, choice
   count, finish reason, JSON shape, and all review-specific fields. Do not
   log request bodies, responses, source excerpts, or credentials.
4. Bound source excerpts, packages, decision units, total serialized packet,
   request count, concurrency, and wall-clock time. Projection may shorten
   text with an explicit truncation signal, but cannot change identity,
   findings, evidence status, source URLs, or policy ceilings. Stop launching
   work before the shared workflow deadline is exhausted.
5. Analyze grouped PRs in stable, bounded batches. Require exactly one
   validated assessment for each unit in a successful batch and reject
   duplicates, omissions, unknown units, unsupported source URLs or paths,
   invented findings, and verdicts more permissive than policy allows.
6. A length-truncated multi-unit response may be retried only by splitting
   that batch into smaller nonempty batches. A truncated single-unit response
   is unavailable. Malformed JSON, schema violations, transport errors,
   HTTP failures, and timeouts do not trigger a model retry; preserve valid
   results from independent batches.
7. Aggregate without a final model call. A verified `do_not_merge` blocker
   remains visible. Otherwise, any unavailable or unattempted decision unit
   yields `decision_incomplete`, with no merge recommendation; only complete
   validated units may yield `merge_with_followups` or `merge` under policy.
8. Permit `use_now` only with both a vetted upstream source and a trusted
   repository-context fact that supports a concrete action. Other capability
   classifications retain their cited source and rationale. Model prose
   cannot become a vulnerability, compatibility, or provenance finding.
9. Emit bounded diagnostics with provider ID, model ID, reviewed head,
   decision-unit counts, and failure category. The shared workflow owns the
   current-head status and comment handoff in `SPEC-shared-review.md`.

## Testing Strategy

Use mocked transport and sanitized packets. Cover provider selection and
credential routing; absent provider and credential; schema and reference
rejection; policy ceilings; malicious source instructions; source-excerpt
opt-out; packet and deadline boundaries; successful grouped batches;
cross-batch references; recursive length splitting; one-unit truncation;
malformed, HTTP, and timeout failures; and a verified blocker alongside an
unavailable unit. Assert that each unit appears once in the aggregate and
that no raw provider data reaches logs or comments.

## Boundaries

- **Always:** Validate after model response, keep deterministic policy
  authoritative, preserve successful units, and name unavailable units.
- **Ask first:** Add a provider or data category, change the model request
  budget or workflow deadline, or loosen reference validation.
- **Never:** Treat JSON mode as schema validation, follow instructions from
  evidence text, execute model-suggested commands, or publish an unvalidated
  model verdict.

## Success Criteria

1. The v1 Mistral adapter passes the same decision-unit fixtures as the
   provider-neutral contract, including a grouped update with one failed
   unit and one independent verified blocker.
2. Every changed decision unit is assessed once or explicitly marked
   unavailable or unattempted; a failed batch cannot erase other results.
3. No provider error, absent credential, or incomplete unit produces a merge
   recommendation or successful current-head execution status.
4. A later provider can implement the common packet and result validation
   without changing evidence collectors, policy, or comment rendering.

## Open Questions

None for the v1 behavior. Initial byte, count, concurrency, and time budgets
are selected during planning from the workflow deadline and locked by tests.
