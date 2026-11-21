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

test('scales the hand-set evidence shares, envelope values, and attempt cap', () => {
  for (const id of [
    'evidence.allocation.signals.readers.malware.maxRequests',
    'evidence.allocation.upstream.maxTotalBytes',
    'evidence.envelope.totalTimeoutMs',
    'evidence.envelope.maxResponseBytes',
    'research.maxAttempts',
  ])
    expect(valueAt(10, id), id).toBe(10 * (REGISTER.get(id)?.value ?? 0));
});

test('recomputes derived entries from the scaled inputs', () => {
  for (const id of [
    'evidence.allocation.signals.maxRequests',
    'evidence.envelope.maxRequests',
    'w2.session.maxRequests',
    'w2.session.maxTotalBytes',
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
