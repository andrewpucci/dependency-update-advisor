import { expect, test } from 'vite-plus/test';
import { createNpmPublishTimeReader } from './npm-publish-times.js';
import { createPolicySignalReader } from './policy-signals-read.js';

const limits = {
  maxRequests: 4,
  maxResponseBytes: 10000,
  maxTotalBytes: 20000,
  maxJsonEntries: 1000,
  maxJsonDepth: 16,
  maxWork: 10000,
  maxRetainedBytes: 100000,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10000,
};
const readers = {
  publishTimes: {
    create: createNpmPublishTimeReader,
    query: {
      name: 'pkg',
      versions: ['1.0.0'],
      source: { kind: 'registry', identity: 'https://registry.npmjs.org' },
      evaluationTime: 0,
    },
  },
  policySignals: {
    create: createPolicySignalReader,
    query: {
      kind: 'pypi',
      name: 'pkg',
      version: '1.0.0',
      source: { kind: 'registry', identity: 'https://pypi.org/simple' },
    },
  },
};
const neverFetched = async (): Promise<Response> => {
  throw new Error('fetched');
};

test.each(Object.keys(readers) as (keyof typeof readers)[])(
  '%s reader rejects incomplete or inconsistent limits',
  (name) => {
    const { create } = readers[name];
    const deps = { now: () => 0, fetch: neverFetched };
    for (const value of [
      null,
      { ...limits, maxWork: 0 },
      { ...limits, maxJsonDepth: 1.5 },
      { ...limits, totalTimeoutMs: undefined },
      { ...limits, maxResponseBytes: limits.maxTotalBytes + 1 },
      { ...limits, requestTimeoutMs: limits.totalTimeoutMs + 1 },
      { ...limits, requestTimeoutMs: 2 ** 31, totalTimeoutMs: 2 ** 31 },
    ])
      expect(create(value, deps)).toEqual({ kind: 'invalid' });
    expect(create(limits, { now: () => NaN, fetch: neverFetched })).toEqual({ kind: 'invalid' });
    const ready = create({ ...limits, extra: 1 }, deps);
    if (ready.kind !== 'ready') throw new Error('reader');
    expect(ready.limits).toEqual(limits);
    ready.close();
  },
);
test.each(Object.keys(readers) as (keyof typeof readers)[])(
  '%s reader fails a backwards clock or spent total time before fetching',
  async (name) => {
    const { create, query } = readers[name];
    for (const [later, reason] of [
      [-1, 'unknown'],
      [limits.totalTimeoutMs, 'timeout'],
    ] as const) {
      let reads = 0;
      const r = create(limits, { now: () => (reads++ ? later : 0), fetch: neverFetched });
      if (r.kind !== 'ready') throw new Error('reader');
      expect(await r.read(query)).toEqual({ kind: 'unavailable', reason });
      r.close();
    }
  },
);
