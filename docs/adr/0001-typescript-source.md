# ADR 0001: TypeScript source and JavaScript action

Status: accepted, 2026-09-23.

## Context and Problem Statement

The reviewer passes structured data between configuration, evidence,
analysis, and reporting modules. These internal contracts need checks during
development. The GitHub Action needs a JavaScript entry point that runs on the
pinned Node.js 24 runtime.

## Considered Options

- ESM TypeScript source and tests, compiled into a committed JavaScript action.
- ESM JavaScript source and tests, without TypeScript checking of the internal
  contracts.

## Decision Outcome

Chosen option: ESM TypeScript source and tests, because strict static checks
can catch mismatches between the review modules while a packaged JavaScript
action remains runnable by consumer repositories.

- Write reviewer source and tests in ESM TypeScript.
- Check both with strict TypeScript and `noEmit` in `npm run check` and CI.
- Build and commit the JavaScript action bundle; have CI verify that a fresh
  build matches the committed bundle.
- Validate external inputs at runtime. TypeScript types cannot establish that
  GitHub responses, configuration, or model output are valid.

### Consequences

The repository needs a TypeScript configuration and a reproducible action
build. CI must catch drift between source and the committed bundle. Consumer
runners execute the packaged JavaScript without installing development tools.
