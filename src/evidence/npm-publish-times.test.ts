import { expect, test } from 'vite-plus/test';
import { createNpmPublishTimeReader } from './npm-publish-times.js';
import { enrichPolicySignals } from './policy-signals.js';
import { createMalwareReader } from './advisory-read.js';
import { createUpstreamReader } from './upstream-read.js';
import { enrichUpstream } from './upstream.js';
import { upstreamScenario, upstreamTestLimits } from '../../tests/parity/upstream.js';

const limits = {
  maxRequests: 10,
  maxResponseBytes: 2_000_000,
  maxTotalBytes: 4_000_000,
  maxJsonEntries: 10,
  maxJsonDepth: 20,
  maxWork: 2_000_000,
  maxRetainedBytes: 4096,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10000,
};
const target = {
  name: '@fixture/pkg',
  source: { kind: 'registry', identity: 'https://registry.npmjs.org' },
  versions: ['1.0.0', '2.0.0'],
  evaluationTime: Date.parse('2026-11-07T00:00:00Z'),
};
test('npm optional timestamp failure cannot erase completed malware coverage', async () => {
  const f = await upstreamScenario();
  const upstreamReader = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  if (upstreamReader.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(f.input, upstreamReader);
  upstreamReader.reader.close();
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  const malware = createMalwareReader(f.advisoryLimits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  const times = createNpmPublishTimeReader(limits, {
    now: () => 0,
    fetch: async () => Response.json({}, { status: 403 }),
  });
  if (malware.kind !== 'ready' || times.kind !== 'ready') throw new Error('reader');
  const out = await enrichPolicySignals(
    {
      ...upstream,
      evaluationTime: target.evaluationTime,
      limits: { ...f.advisoryLimits, maxAttempts: 1000 },
    },
    { malwareReader: malware, publishTimeReader: times },
  );
  malware.close();
  times.close();
  if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
  expect(
    out.changes
      .filter((c) => c.ecosystem === 'npm')
      .every(
        (c) =>
          c.evidence.malware.status === 'available' &&
          c.evidence.publishTime.status === 'unavailable' &&
          c.evidence.publishTime.reasons[0] === 'permission',
      ),
  ).toBe(true);
});
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  let position = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (position === bytes.length) c.close();
        else {
          const end = Math.min(bytes.length, position + 17);
          c.enqueue(bytes.slice(position, end));
          position = end;
        }
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
test('streams full metadata retaining two timestamps despite many skipped entries and split UTF-8', async () => {
  const text = JSON.stringify({
    name: target.name,
    description: '🪼'.repeat(5000),
    versions: { ignored: { readme: 'x'.repeat(10000) } },
    time: {
      ...Object.fromEntries(
        Array.from({ length: 10000 }, (_, i) => ['old-' + i, '2020-01-01T00:00:00Z']),
      ),
      '1.0.0': '2026-10-01T00:00:00Z',
      '2.0.0': '2026-11-01T00:00:00Z',
    },
  });
  let calls = 0;
  const r = createNpmPublishTimeReader(limits, {
    now: () => 0,
    fetch: async (url, init) => {
      calls++;
      expect(new URL(url).origin).toBe('https://registry.npmjs.org');
      expect(init.credentials).toBe('omit');
      return response(text);
    },
  });
  if (r.kind !== 'ready') throw new Error('reader');
  const out = await r.read(target);
  expect(out).toMatchObject({
    kind: 'times',
    times: {
      '1.0.0': Date.parse('2026-10-01T00:00:00Z'),
      '2.0.0': Date.parse('2026-11-01T00:00:00Z'),
    },
  });
  expect(JSON.stringify(out).length).toBeLessThan(limits.maxRetainedBytes);
  expect(await r.read(target)).toEqual(out);
  expect(calls).toBe(1);
  r.close();
});
test.each([
  [
    'duplicate',
    '{"name":"@fixture/pkg","time":{"1.0.0":"2026-01-01T00:00:00Z","1.0.0":"2026-01-02T00:00:00Z"}}',
    'conflict',
  ],
  ['trailing', '{"name":"@fixture/pkg","time":{}} garbage', 'malformed'],
  ['identity', '{"name":"other","time":{}}', 'conflict'],
  ['wrong type', '{"name":"@fixture/pkg","time":[]}', 'malformed'],
  ['truncated', '{"name":"@fixture/pkg","time":', 'malformed'],
])('rejects %s instead of retaining misleading times', async (_name, text, reason) => {
  const r = createNpmPublishTimeReader(limits, { now: () => 0, fetch: async () => response(text) });
  if (r.kind !== 'ready') throw new Error('reader');
  expect(await r.read(target)).toMatchObject({ kind: 'unavailable', reason });
  r.close();
});
test('a future or missing side is unknown without erasing the valid opposite timestamp', async () => {
  const r = createNpmPublishTimeReader(limits, {
    now: () => 0,
    fetch: async () =>
      response(
        JSON.stringify({
          name: target.name,
          time: { '1.0.0': '2026-01-01T00:00:00Z', '2.0.0': '2099-01-01T00:00:00Z' },
        }),
      ),
  });
  if (r.kind !== 'ready') throw new Error('reader');
  expect(await r.read(target)).toMatchObject({
    kind: 'times',
    times: { '1.0.0': Date.parse('2026-01-01T00:00:00Z') },
    reasons: { '2.0.0': 'conflict' },
  });
  r.close();
});
test.each(['maxResponseBytes', 'maxWork', 'maxJsonDepth'] as const)(
  'optional %s exhaustion and invalid/private targets never become success',
  async (field) => {
    let calls = 0;
    const r = createNpmPublishTimeReader(
      { ...limits, [field]: 1 },
      {
        now: () => 0,
        fetch: async () => {
          calls++;
          return response(JSON.stringify({ name: target.name, time: {} }));
        },
      },
    );
    if (r.kind !== 'ready') throw new Error('reader');
    expect(
      await r.read({
        ...target,
        source: { kind: 'registry', identity: 'https://private.example' },
      }),
    ).toMatchObject({ kind: 'unavailable', reason: 'unsupported' });
    expect(calls).toBe(0);
    expect(await r.read(target)).toMatchObject({ kind: 'unavailable', reason: 'budget' });
    r.close();
  },
);
