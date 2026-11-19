// Runs the read-demand measurement as a single vitest file; not part of `npm test`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import { limit } from '../../src/limits.ts';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['scripts/measure-demand/run.demand.ts'],
    testTimeout: limit('measureDemand.testTimeoutMs'),
  },
});
