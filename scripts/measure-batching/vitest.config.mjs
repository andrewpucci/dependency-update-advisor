// Runs the batching equivalence probe as a single vitest file; not part of `npm test`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import { limit } from '../../src/limits.ts';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['scripts/measure-batching/run.batching.ts'],
    testTimeout: limit('measureDemand.testTimeoutMs'),
  },
});
