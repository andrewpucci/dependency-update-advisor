import { expect, test } from 'vite-plus/test';
import { createGithubReadSession } from '../github-read.js';
import { collectUvMetadata } from './uv.js';
import { uvMetadataScenario, type UvComparisonMode } from '../../tests/parity/uv-metadata.js';
async function collect(
  mode: UvComparisonMode,
  options: Parameters<typeof uvMetadataScenario>[1] = {},
) {
  const fixture = uvMetadataScenario(mode, options);
  const opened = await createGithubReadSession(
    { binding: fixture.input.binding, limits: fixture.readLimits },
    { fetch: fixture.fetch, now: () => performance.now() },
  );
  expect(opened.kind).toBe('ready');
  if (opened.kind !== 'ready') throw new Error('expected real D1 session');
  try {
    const result = await collectUvMetadata(fixture.input, { session: opened.session });
    expect(result.kind).toBe('metadata');
    if (result.kind !== 'metadata') throw new Error('expected U1 metadata');
    return { result, requests: fixture.requests };
  } finally {
    opened.session.close();
  }
}
test.each([
  'empty',
  'omission',
  'permission403',
  'unknown403',
  'rate403',
  'rate429',
  'partial',
] as const)('real D1/U1 preserves invented file evidence through %s comparison', async (mode) => {
  const baseline = (await collect('empty')).result,
    { result, requests } = await collect(mode);
  expect(result.roots).toEqual(baseline.roots);
  expect(result.sources).toEqual(baseline.sources);
  expect(result.gaps).toEqual([]);
  expect(result.roots[0].base.lock.data?.revision).toBe(3);
  expect(result.roots[0].head.lock.data?.revision).toBe(5);
  const manifest = result.roots[0].head.manifest.data!,
    lock = result.roots[0].head.lock.data!;
  expect(manifest.optionalDependencies.map((x) => x.extra)).toEqual([
    'cli',
    'docs',
    'empty',
    'web',
  ]);
  expect(manifest.dependencies.map((x) => [x.name, x.position])).toEqual([
    ['orbit-core', 0],
    ['orbit-core', 1],
  ]);
  expect(lock.packages.filter((p) => p.name === 'orbit-core').map((p) => p.version)).toEqual([
    '1.0',
    '2.0',
  ]);
  expect(lock.packages.find((p) => !p.external)?.dependencies?.[0]).toMatchObject({
    version: '1.0',
    marker: "python_version < '3.13'",
  });
  expect(
    lock.packages.find((p) => !p.external)?.optionalDependencies?.find((x) => x.extra === 'empty')
      ?.declarations,
  ).toEqual([]);
  expect(
    result.roots[0].base.lock.data?.packages
      .find((p) => !p.external)
      ?.optionalDependencies?.some((x) => x.extra === 'empty'),
  ).toBe(false);
  const status = {
    empty: 'available',
    omission: 'available',
    permission403: 'unavailable',
    unknown403: 'unavailable',
    rate403: 'unavailable',
    rate429: 'unavailable',
    partial: 'partial',
  }[mode];
  const reasons = {
    empty: [],
    omission: [],
    permission403: ['permission'],
    unknown403: ['unknown'],
    rate403: ['rate_limit'],
    rate429: ['rate_limit'],
    partial: ['malformed'],
  }[mode];
  expect(result.comparison).toEqual({ status, reasons });
  expect(JSON.stringify(result)).not.toContain('vulnerabilities');
  expect(requests.some((url) => url.includes('/dependency-graph/compare/'))).toBe(true);
  expect(
    requests.every((url) => url.startsWith('https://api.github.com/repos/example/consumer/')),
  ).toBe(true);
});
test.each(['missing', 'malformed', 'unsupported'] as const)(
  'real D1/U1 retains supported base and head manifest with %s head companion',
  async (headLock) => {
    const { result } = await collect('permission403', { headLock });
    expect(result.roots[0].base.state).toBe('present');
    expect(result.roots[0].head.manifest.state).toBe('present');
    expect(result.roots[0].head.state).toBe('partial');
    expect(result.gaps).toContainEqual({
      root: '.',
      side: 'head',
      path: 'uv.lock',
      entry: null,
      reason: headLock === 'missing' ? 'missing' : headLock,
    });
    expect(result.comparison).toEqual({ status: 'unavailable', reasons: ['permission'] });
  },
);
test('actual discovery permission failure preserves trusted-root snapshots and independent comparison limits', async () => {
  const { result } = await collect('unknown403', { discoveryFailure: true });
  expect(result.discovery).toMatchObject({
    status: 'unavailable',
    complete: false,
    applicable: true,
    reasons: ['permission'],
  });
  expect(result.roots[0].head.state).toBe('present');
  expect(result.gaps).toContainEqual({
    root: null,
    side: null,
    path: null,
    entry: null,
    reason: 'permission',
  });
  expect(result.comparison).toEqual({ status: 'unavailable', reasons: ['unknown'] });
});
