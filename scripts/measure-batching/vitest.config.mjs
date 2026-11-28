// Runs the batching equivalence probe as a single vitest file; not part of `npm test`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

/**
 * A hung GitHub request would otherwise hold the probe forever, since its requests set no timeout.
 * Repository tooling policy outside the limit register (SPEC-limit-register section 4, register
 * scope, L11 Q25(a), approved 2026-11-27, #383): no adopter runs the probe.
 */
// oxlint-disable-next-line limits/no-literal-limit -- repository tooling policy outside the register (see above)
const PROBE_TEST_TIMEOUT_MS = 900_000;

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['scripts/measure-batching/run.batching.ts'],
    testTimeout: PROBE_TEST_TIMEOUT_MS,
  },
});
