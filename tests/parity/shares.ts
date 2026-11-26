import { RESEARCH_SHARE_PARAMETERS, type ResearchShareParameters } from '../../src/budget.js';
import { REGISTER } from '../../src/limits.js';

type ShareParameters = ResearchShareParameters['upstream'];
type ShareDimension = ShareParameters['requests'];

const atCeiling = (dimension: ShareDimension): ShareDimension => ({
  base: dimension.ceiling,
  ceiling: dimension.ceiling,
  rates: Object.fromEntries(Object.keys(dimension.rates).map((unit) => [unit, 0])),
});
const shareAtCeiling = (share: ShareParameters): ShareParameters => ({
  requests: atCeiling(share.requests),
  bytes: atCeiling(share.bytes),
});

/**
 * Every research share at its ceiling, as before the B12 fit. For runs the fit does not size,
 * such as an unbatched advisory baseline over a large npm group, whose per-target lookups take
 * more requests per transitive member than the fitted rate allows.
 */
export const CEILING_SHARES: ResearchShareParameters = {
  upstream: shareAtCeiling(RESEARCH_SHARE_PARAMETERS.upstream),
  advisory: shareAtCeiling(RESEARCH_SHARE_PARAMETERS.advisory),
  signals: Object.fromEntries(
    Object.entries(RESEARCH_SHARE_PARAMETERS.signals).map(([reader, share]) => [
      reader,
      shareAtCeiling(share),
    ]),
  ) as ResearchShareParameters['signals'],
};

/** The register's value for an id, read from the register rather than a production constant. */
export function registered(id: string): number {
  const entry = REGISTER.get(id);
  if (entry === undefined) throw new Error(`no register entry ${id}`);
  return entry.value;
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
