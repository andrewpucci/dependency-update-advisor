import { valid as semverValid, compare as semverCompare } from 'semver';
import { valid as pythonValid, compare as pythonCompare } from '@renovatebot/pep440';
import { upstreamText } from './upstream-read.js';

/** Ordering never rewrites inventory identity; equal precedence is not a version mapping. */
export function compareUpstreamVersions(
  ecosystem: 'npm' | 'uv',
  left: unknown,
  right: unknown,
): number | null {
  if (!upstreamText(left) || !upstreamText(right) || /\s/u.test(left + right)) return null;
  const values = [left, right];
  if (ecosystem === 'npm') {
    if (!values.every((v) => /^\d/u.test(v) && semverValid(v) !== null)) return null;
    return Math.sign(semverCompare(left, right));
  }
  if (!values.every((v) => pythonValid(v) !== null)) return null;
  return Math.sign(pythonCompare(left, right));
}
export function withinUpstreamRange(
  ecosystem: 'npm' | 'uv',
  candidate: unknown,
  from: unknown,
  to: unknown,
): boolean | null {
  const direction = compareUpstreamVersions(ecosystem, from, to);
  if (direction !== -1) return null;
  const lower = compareUpstreamVersions(ecosystem, from, candidate);
  const upper = compareUpstreamVersions(ecosystem, candidate, to);
  if (lower === null || upper === null) return null;
  return lower < 0 && upper <= 0;
}
