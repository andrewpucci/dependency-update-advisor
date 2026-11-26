/**
 * Runs the batching equivalence probe (#389, C2 of the batching track) with the user's token; the
 * comparisons are in `probe.ts`.
 * Usage: GITHUB_TOKEN=... npm run probe:batching
 * Optional: MEASURE_TARGETS_IN (a C1 targets file under `.context/`, from `MEASURE_TARGETS_OUT`),
 * PROBE_OUT (write the JSON report to this path). The fixed seeds always run.
 * The report is written even when the run stops early, with what it measured and why it stopped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vite-plus/test';
import type { SettledTarget, TagCandidate } from '../../src/measurement/targets.js';
import { runProbe, type ProbeInput } from './probe.js';

const env = process.env;
const contextDir = fileURLToPath(new URL('../../.context/', import.meta.url));

function contextPath(value: string): string {
  const path = resolve(value);
  if (!path.startsWith(contextDir.endsWith(sep) ? contextDir : contextDir + sep))
    throw new Error('MEASURE_TARGETS_IN must be a path under .context/');
  return path;
}

function loadInput(): ProbeInput {
  if (!env.MEASURE_TARGETS_IN) return { targets: [], tags: [] };
  const file = JSON.parse(readFileSync(contextPath(env.MEASURE_TARGETS_IN), 'utf8')) as {
    targets?: SettledTarget[];
    tagCandidates?: TagCandidate[];
  };
  const targets = (file.targets ?? []).map(({ ecosystem, name, version, type }) => ({
    ecosystem,
    name,
    version,
    type,
  }));
  return { targets, tags: file.tagCandidates ?? [] };
}

test('probe batching equivalence', async () => {
  const token = env.GITHUB_TOKEN ?? '';
  if (!token) throw new Error('GITHUB_TOKEN required');
  const report = await runProbe({ token, fetch, input: loadInput() });
  const text = JSON.stringify(report, null, 2);
  if (env.PROBE_OUT) writeFileSync(env.PROBE_OUT, text + '\n');
  console.log(text);
  if (report.stopped === 'error')
    throw new Error('the probe stopped on an error; the report above holds what it measured');
});
