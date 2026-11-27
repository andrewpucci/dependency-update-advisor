import { expect, test } from 'vite-plus/test';
import { buildRegister, REGISTER } from '../limits.js';
import { scaledDefinitions } from './scale.js';

const valueAt = (factor: number, id: string) =>
  buildRegister(scaledDefinitions(REGISTER, factor)).get(id)?.value;

test('scale 1 leaves every register value unchanged', () => {
  const scaled = buildRegister(scaledDefinitions(REGISTER, 1));
  expect([...scaled].map(([id, entry]) => [id, entry.value])).toEqual(
    [...REGISTER].map(([id, entry]) => [id, entry.value]),
  );
});

test('scales the hand-set evidence shares, envelope values, and research caps', () => {
  for (const id of [
    'evidence.allocation.signals.readers.malware.maxRequests',
    'evidence.allocation.upstream.maxTotalBytes',
    'evidence.envelope.totalTimeoutMs',
    'evidence.envelope.maxResponseBytes',
    'research.maxAttempts',
    'research.maxRetainedBytes',
  ])
    expect(valueAt(10, id), id).toBe(10 * (REGISTER.get(id)?.value ?? 0));
});

test('scales the fitted share bases and rates with their ceilings, without binary noise', () => {
  for (const id of [
    'research.share.upstream.requests.base',
    'research.share.upstream.requests.rate.direct',
    'research.share.signals.malware.requests.rate.eligible',
    'collection.share.registry.requests.base',
    'collection.share.registry.requests.rate.npm',
    'research.share.upstream.bytes.rate.direct',
    'research.share.signals.metadata.requests.base',
    'research.share.signals.metadata.bytes.rate.eligible',
  ])
    expect(valueAt(10, id), id).toBe(10 * (REGISTER.get(id)?.value ?? 0));
  // 1.2 × 3 is 3.5999999999999996 in binary floating point; the scaled rate stays 3.6.
  expect(valueAt(3, 'research.share.signals.publishTimes.requests.rate.eligible')).toBe(3.6);
  // A base the fit kept at its ceiling is derived, so it follows the scaled ceiling.
  expect(valueAt(10, 'research.share.advisory.bytes.base')).toBe(
    10 * (REGISTER.get('evidence.allocation.advisory.maxTotalBytes')?.value ?? 0),
  );
  // 2.5 × 3 stays 7.5.
  expect(valueAt(3, 'research.share.signals.metadata.requests.rate.eligible')).toBe(7.5);
});

test('derives the PyPI metadata ceilings from the packet change limit, scaled only through the share', () => {
  // Two reads per change is a structural bound, so the request ceiling does not scale; the byte
  // ceiling is the base and eligible rate for every change, so it scales with them.
  const requests = 'evidence.allocation.signals.readers.metadata.maxRequests';
  const bytes = 'evidence.allocation.signals.readers.metadata.maxTotalBytes';
  expect(valueAt(10, requests)).toBe(REGISTER.get(requests)?.value);
  expect(valueAt(10, bytes)).toBe(10 * (REGISTER.get(bytes)?.value ?? 0));
});

test('recomputes derived entries from the scaled inputs', () => {
  for (const id of [
    'evidence.allocation.transport.maxRequests',
    'evidence.allocation.signals.maxTotalBytes',
    'evidence.envelope.maxTotalBytes',
    'w2.session.maxRequests',
    'w2.session.maxTotalBytes',
    'research.maxJsonEntries',
  ])
    expect(valueAt(10, id), id).toBe(10 * (REGISTER.get(id)?.value ?? 0));
});

test('leaves limits outside the read budget unchanged', () => {
  for (const id of ['packet.bytes', 'w2.npm.maxFileBytes', 'research.maxWork', 'job.budget'])
    expect(valueAt(10, id), id).toBe(REGISTER.get(id)?.value);
});

test('rejects a scale that is not a positive integer', () => {
  for (const factor of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => scaledDefinitions(REGISTER, factor), String(factor)).toThrow(/positive integer/);
});
