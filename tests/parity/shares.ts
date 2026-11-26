import { RESEARCH_SHARE_PARAMETERS, type ResearchShareParameters } from '../../src/budget.js';

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
 * Every research share at its ceiling, as before the B12 fit. For runs whose fixtures the fit
 * does not size: an unbatched advisory baseline, and the mixed-ecosystem fixtures, whose Actions
 * and pip lookups take more requests per member than the fitted rates allow.
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
