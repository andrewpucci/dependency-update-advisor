# ADR 0005: Use batch-local aliases with owned analysis snapshots

Status: accepted, 2026-11-07, through the approved
[M1 specification and plan](../specs/SPEC-mistral-transport.md).

## Context and Problem Statement

T5 unit and member identities contain exact repository/revision relationships.
Asking a model to reproduce those long identities or a binding digest spends
the bounded completion budget on references and creates avoidable echo failures.
Short aliases reduce that cost, but the same aliases recur in different batches.

## Considered Options

- Short deterministic aliases, detached immutable snapshots, and local ownership
  binding around each adapter's request/response closure.
- Require exact original identities and a digest in every model response.
- Accept short aliases against any caller-supplied map.

## Decision Outcome

Chosen option: use deterministic batch-local aliases and locally owned snapshots.
Compute a canonical versioned SHA-256 binding over the original identities,
trusted config/policy/time/limits, and projected request. Keep it local. Only
authentic prepared handles resolve to their immutable snapshot; an opaque
received reply belongs to exactly that handle. Native Mistral transport captures
the handle for its own response and common validation restores original IDs.

The user approved this choice during specification review and automatic-build
approval. M2 must retain the expected binding when combining independent results.

### Consequences

Output references stay short and model text cannot replace a policy ceiling or
invent a source/member/context relationship. The common contract stays separate
from provider envelope handling. Preparation must retain bounded local mappings,
and the adapter must preserve response ownership across concurrent calls.

A digest is not provider authentication: arbitrary raw JSON has no independent
proof of its request. Correct trusted adapter closure ownership remains necessary;
equal alias strings cannot establish provenance. Tests therefore cover wrong
bound replies and independent in-flight requests, as well as exact references.
