import { expect, test } from 'vite-plus/test';
import {
  parseOsvTargets,
  parseUpstreamTargets,
  slowestResponseMs,
  throughputBytesPerSecond,
} from '../../scripts/probe-research-timing/core.js';

test('OSV targets name an ecosystem, a package and a version, scoped npm names included', () => {
  expect(parseOsvTargets(['PyPI:requests@2.0.0', 'npm:@types/node@20.1.0'])).toEqual([
    { kind: 'osv', ecosystem: 'PyPI', name: 'requests', version: '2.0.0' },
    { kind: 'osv', ecosystem: 'npm', name: '@types/node', version: '20.1.0' },
  ]);
  expect(parseOsvTargets(['requests'])).toEqual({ error: expect.stringMatching(/requests/) });
  expect(parseOsvTargets([])).toEqual({ error: 'needs at least one target' });
});

test('upstream targets are a GitHub repository or a PyPI project', () => {
  expect(parseUpstreamTargets(['github:astral-sh/uv', 'pypi:requests'])).toEqual([
    { kind: 'github', owner: 'astral-sh', repo: 'uv' },
    { kind: 'pypi', name: 'requests' },
  ]);
  expect(parseUpstreamTargets(['astral-sh/uv'])).toEqual({ error: expect.stringMatching(/uv/) });
});

test('the slowest response is the longest successful read, rounded up', () => {
  const reads = [
    { status: 200, bytes: 10, elapsedMs: 120.2 },
    { status: 200, bytes: 10, elapsedMs: 540.1 },
    { status: 500, bytes: 10, elapsedMs: 9_000 },
    { status: 0, bytes: 0, elapsedMs: 9_000 },
  ];
  expect(slowestResponseMs(reads)).toBe(541);
  expect(slowestResponseMs([{ status: 404, bytes: 0, elapsedMs: 1 }])).toBeNull();
});

test('throughput is the successful bytes over their summed wall time, rounded down', () => {
  const reads = [
    { status: 200, bytes: 1_000_000, elapsedMs: 1_000 },
    { status: 200, bytes: 600_000, elapsedMs: 1_500 },
    { status: 0, bytes: 5, elapsedMs: 10_000 },
  ];
  expect(throughputBytesPerSecond(reads)).toBe(640_000);
  expect(throughputBytesPerSecond([])).toBeNull();
});
