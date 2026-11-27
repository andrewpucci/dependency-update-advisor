import type { ResearchShareParameters } from '../../src/budget.js';
import { REGISTER } from '../../src/limits.js';

/** The register's value for an id, read from the register rather than a production constant. */
export function registered(id: string): number {
  const entry = REGISTER.get(id);
  if (entry === undefined) throw new Error(`no register entry ${id}`);
  return entry.value;
}

/** Every leaf of a limits object, as `prefix.path` and its value. */
export function leaves(value: unknown, prefix: string): [string, unknown][] {
  if (typeof value !== 'object' || value === null) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, `${prefix}.${key}`));
}

const READERS = ['malware', 'publishTimes', 'registry', 'metadata', 'upstream'] as const;
const ROLES = ['direct', 'transitive', 'added', 'removed'] as const;

/**
 * The scaled-share parameters as the register states them, built from register ids without
 * budget.ts, so a test can compare the production parameters and shares against them.
 */
export function registerShareParameters(): ResearchShareParameters {
  const dimension = (share: string, name: 'requests' | 'bytes', ceilingId: string) => ({
    base: registered(`research.share.${share}.${name}.base`),
    ceiling: registered(ceilingId),
    rates: Object.fromEntries(
      [...ROLES, ...(share.startsWith('signals.') ? ['eligible'] : [])].map((unit) => [
        unit,
        registered(`research.share.${share}.${name}.rate.${unit}`),
      ]),
    ),
  });
  const parameters = (share: string, allocation: string) => ({
    requests: dimension(share, 'requests', `evidence.allocation.${allocation}.maxRequests`),
    bytes: dimension(share, 'bytes', `evidence.allocation.${allocation}.maxTotalBytes`),
  });
  return {
    upstream: parameters('upstream', 'upstream'),
    advisory: parameters('advisory', 'advisory'),
    signals: Object.fromEntries(
      READERS.map((reader) => [
        reader,
        parameters(`signals.${reader}`, `signals.readers.${reader}`),
      ]),
    ) as ResearchShareParameters['signals'],
  };
}
