import type { ResearchObservation, ResearchStage } from '../research.js';

export type DemandPhase = ResearchStage | 'pre-research' | 'post-research';
export type DemandUnits = Readonly<Record<string, number>>;
export type DemandRow = {
  requests: number;
  bytes: number;
  maxMs: number;
  statuses: Record<string, number>;
};
export type DemandReport = {
  totalRequests: number;
  /** Requests whose full URL (including query string) was already requested earlier in this run. */
  repeatedUrlRequests: number;
  /** Key: `${phase} ${host}`. */
  byPhaseHost: Record<string, DemandRow>;
  stages: {
    stage: ResearchStage;
    outcome: 'enriched' | 'unavailable';
    reason: string | null;
    ms: number;
  }[];
  units: DemandUnits;
};

type Sample = {
  phase: DemandPhase;
  host: string;
  url: string;
  status: string;
  bytes: number;
  ms: number;
};

export function createDemandRecorder(now: () => number): {
  observe(observation: ResearchObservation): void;
  wrap(
    fetch: (url: string, init: RequestInit) => Promise<Response>,
  ): (url: string, init: RequestInit) => Promise<Response>;
  report(units: DemandUnits): DemandReport;
} {
  let phase: DemandPhase = 'pre-research';
  let stageStartedAt = 0;
  const samples: Sample[] = [];
  const stages: DemandReport['stages'] = [];

  const observe = (observation: ResearchObservation) => {
    if (observation.kind === 'stage-start') {
      phase = observation.stage;
      stageStartedAt = now();
      return;
    }
    stages.push({
      stage: observation.stage,
      outcome: observation.outcome,
      reason: observation.reason,
      ms: Math.round(now() - stageStartedAt),
    });
    phase = 'post-research';
  };

  const wrap = (fetch: (url: string, init: RequestInit) => Promise<Response>) => {
    return async (url: string, init: RequestInit): Promise<Response> => {
      const sampleBase = { phase, host: new URL(url).host, url };
      const startedAt = now();
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        samples.push({ ...sampleBase, status: 'error', bytes: 0, ms: now() - startedAt });
        throw error;
      }
      const ms = now() - startedAt;
      const bytes = (await response.clone().arrayBuffer()).byteLength;
      samples.push({ ...sampleBase, status: String(response.status), bytes, ms });
      return response;
    };
  };

  const report = (units: DemandUnits): DemandReport => {
    const byPhaseHost: Record<string, DemandRow> = {};
    const seenUrls = new Set<string>();
    let repeatedUrlRequests = 0;

    for (const sample of samples) {
      if (seenUrls.has(sample.url)) repeatedUrlRequests += 1;
      seenUrls.add(sample.url);

      const key = `${sample.phase} ${sample.host}`;
      const row = (byPhaseHost[key] ??= { requests: 0, bytes: 0, maxMs: 0, statuses: {} });
      row.requests += 1;
      row.bytes += sample.bytes;
      row.maxMs = Math.max(row.maxMs, sample.ms);
      row.statuses[sample.status] = (row.statuses[sample.status] ?? 0) + 1;
    }

    for (const row of Object.values(byPhaseHost)) row.maxMs = Math.round(row.maxMs);

    return {
      totalRequests: samples.length,
      repeatedUrlRequests,
      byPhaseHost,
      stages: stages.map((stage) => ({ ...stage })),
      units,
    };
  };

  return { observe, wrap, report };
}
