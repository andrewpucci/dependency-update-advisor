# ADR 0004: Reject symlinks in source excerpt paths

Status: accepted, 2026-10-11.

## Context and Problem Statement

C2 allows consumers to narrow source disclosure through roots and exact file
lists. A symlink can make a listed source path refer to a different file class
or scope, so lexical path validation alone does not establish eligibility.
The source boundary must be easy to audit before any content is read.

## Considered Options

- Reject every symlink below the trusted checkout in roots, intervening
  directories, and excerpt files.
- Permit contained symlinks after validating both the listed path and target
  against containment, trusted inventory, source classes, and exclusions.

## Decision Outcome

Chosen option: reject every source-path symlink, as required by the approved
[C2 source-context contract](../specs/SPEC-source-context.md#filesystem-containment-and-shared-eligibility).
Checking each component with link
metadata gives the source boundary one rule and avoids target aliasing through
otherwise eligible paths.

### Consequences

Legitimate contained source links cannot contribute excerpts. Consumers must
select eligible regular checked-in files instead. C1's config-file link policy
is separate and unchanged. The caller must still supply a verified checkout
and keep it immutable throughout collection; component checks do not protect
a concurrently replaced checkout. C2 tests must refuse contained, escaping,
and dangling links in every source-path position before content reads.
