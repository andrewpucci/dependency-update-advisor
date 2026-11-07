import { expect, test } from 'vite-plus/test';
import { compareUpstreamVersions, withinUpstreamRange } from './upstream-version.js';

test.each([
  ['npm', '1.9.0', '1.10.0', -1],
  ['npm', '2.0.0-rc.2', '2.0.0-rc.10', -1],
  ['npm', '2.0.0-rc.1', '2.0.0', -1],
  ['npm', '2.0.0+one', '2.0.0+two', 0],
  ['uv', '1!1.0', '2.0', 1],
  ['uv', '2.0.dev1', '2.0a1', -1],
  ['uv', '2.0rc1', '2.0', -1],
  ['uv', '2.0', '2.0.post1', -1],
  ['uv', '2.0+local.2', '2.0+local.10', -1],
  ['uv', '2.0', '2.0.0', 0],
] as const)('%s ordering preserves qualifiers: %s vs %s', (ecosystem, a, b, result) => {
  expect(compareUpstreamVersions(ecosystem, a, b)).toBe(result);
});
test.each(['latest', 'v1.2.3', '1.2', '1.2.3junk', ' 1.2.3', '1.2.3 || 4.0.0'])(
  'unsupported npm version %s is not coerced',
  (version) => {
    expect(compareUpstreamVersions('npm', version, '2.0.0')).toBeNull();
  },
);
test('intervals exclude the old endpoint, include the proposal, and reject non-upgrades', () => {
  expect(withinUpstreamRange('npm', '1.0.0', '1.0.0', '2.0.0')).toBe(false);
  expect(withinUpstreamRange('npm', '2.0.0', '1.0.0', '2.0.0')).toBe(true);
  expect(withinUpstreamRange('npm', '2.0.0', '2.0.0', '1.0.0')).toBeNull();
  expect(withinUpstreamRange('uv', '2.0', '2.0.0', '2.0')).toBeNull();
  expect(withinUpstreamRange('uv', '2.0rc1', '1.0', '2.0')).toBe(true);
  expect(withinUpstreamRange('uv', 'garbage', '1.0', '2.0')).toBeNull();
});
