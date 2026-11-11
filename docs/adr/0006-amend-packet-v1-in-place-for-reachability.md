# ADR 0006: Amend packet v1 in place for reachability evidence

Status: proposed, 2026-11-10.

## Context and Problem Statement

Multi-anchor grouping needs collectors to state, for each changed direct
candidate and changed member, whether a dependency path exists. The
[T4 packet](../specs/SPEC-review-packet.md) is version 1 with a closed field
set: it rejects unknown and missing fields. No consumer has adopted a packet,
and the old reviewer is still active. A packet must never be read as a complete
dependency graph merely because it lacks the new evidence. See the
[reachability evidence spec](../specs/SPEC-reachability-evidence.md).

## Considered Options

- Amend version 1 in place: add a required `reachability` array; an empty array
  means no absence evidence.
- Introduce version 2 and keep accepting version 1 as "no absence evidence".
- Introduce version 2 only and reject version 1 after migration.

## Decision Outcome

Chosen option: amend version 1 in place, because nothing has adopted the packet
and a second version would add a dual-read path to validate and test for no
consumer. A packet without the field is rejected, so it cannot be misread as a
complete graph. Absence evidence is asserted by the trusted collector over
immutable files; T4 validates structure only and does not certify traversal
exhaustiveness.

### Consequences

The T4 validator, every collector, and every packet-building fixture change in
one commit. "Version 1" now means the amended shape, so reconsider this choice
and introduce a new version before any external consumer adopts a packet. Every
missing or dropped record degrades toward standalone units, never groups;
mutation-checked fixtures confirm that.
