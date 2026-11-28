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
    'evidence.allocation.signals.readers.upstream.maxRequests',
    'evidence.allocation.upstream.maxTotalBytes',
    'evidence.envelope.totalTimeoutMs',
    'evidence.envelope.maxResponseBytes',
    'research.maxJsonEntries',
  ])
    expect(valueAt(10, id), id).toBe(10 * (REGISTER.get(id)?.value ?? 0));
  // The attempt cap is derived from the change cap and the tag candidates (L11, item 5): no run
  // can record more, so it stays.
  expect(valueAt(10, 'research.maxAttempts')).toBe(REGISTER.get('research.maxAttempts')?.value);
});

test('scales the fitted share bases and rates with their ceilings, without binary noise', () => {
  for (const id of [
    'research.share.upstream.requests.base',
    'research.share.upstream.requests.rate.direct',
    'research.share.signals.malware.requests.rate.eligible',
    'collection.share.registry.requests.base',
    'collection.share.registry.requests.rate.npm',
    'research.share.upstream.bytes.rate.direct',
    'research.share.signals.metadata.bytes.rate.eligible',
  ])
    expect(valueAt(10, id), id).toBe(10 * (REGISTER.get(id)?.value ?? 0));
  // 1.2 × 3 is 3.5999999999999996 in binary floating point; the scaled rate stays 3.6.
  expect(valueAt(3, 'research.share.signals.publishTimes.requests.rate.eligible')).toBe(3.6);
  // A base the fit kept at its ceiling is derived, so it follows the scaled ceiling.
  expect(valueAt(10, 'research.share.advisory.bytes.base')).toBe(
    10 * (REGISTER.get('evidence.allocation.advisory.maxTotalBytes')?.value ?? 0),
  );
  // The metadata bases are one uv member's two PyPI reads (L11, #383): the request count is
  // structural and stays, and the byte base follows the scaled response cap.
  expect(valueAt(10, 'research.share.signals.metadata.requests.base')).toBe(2);
  expect(valueAt(10, 'research.share.signals.metadata.bytes.base')).toBe(
    2 * 10 * (REGISTER.get('evidence.envelope.maxResponseBytes')?.value ?? 0),
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
  // The freshness reads are a structural count of fixed call sites, which no run exceeds, so only
  // the snapshot share scales in the transport total.
  expect(valueAt(10, 'evidence.allocation.transport.maxRequests')).toBe(
    10 * (REGISTER.get('evidence.allocation.transport.snapshot.maxRequests')?.value ?? 0) +
      (REGISTER.get('evidence.allocation.transport.freshness.maxRequests')?.value ?? 0),
  );
  for (const id of [
    'evidence.allocation.transport.maxTotalBytes',
    'evidence.allocation.signals.maxTotalBytes',
    'evidence.envelope.maxTotalBytes',
    // The retained-byte cap copies the research cache total (#467), so it scales through it.
    'research.maxRetainedBytes',
    'w2.session.maxRequests',
    'w2.session.maxTotalBytes',
    'research.maxJsonEntries',
  ])
    expect(valueAt(10, id), id).toBe(10 * (REGISTER.get(id)?.value ?? 0));
});

test('the advisory ceiling follows the scaled evidence deadline', () => {
  // It is floor(deadline ÷ slowest OSV response ÷ 2) (#467), so it grows with the deadline and,
  // rounded down from the scaled deadline, is at least ten times the production ceiling.
  const id = 'evidence.allocation.advisory.maxRequests';
  const production = REGISTER.get(id)?.value ?? 0;
  expect(valueAt(10, id)).toBeGreaterThanOrEqual(10 * production);
  expect(valueAt(10, id)).toBeLessThan(10 * (production + 1));
});

test('leaves limits outside the read budget unchanged', () => {
  for (const id of [
    'packet.bytes',
    'w2.npm.maxFileBytes',
    'research.maxWork',
    'job.budget',
    'runner.heapBytesPerPacketByte',
    'runner.unitExpansionHeapBytes',
    'analysis.replyHeapBytes',
  ])
    expect(valueAt(10, id), id).toBe(REGISTER.get(id)?.value);
});

test('the packet byte limit stays at its production value while the heap terms scale', () => {
  // The off-heap buffers and the retained evidence grow with the read budget, which would lower
  // the packet cap; a demand run holds it, so it admits every packet production admits.
  const scaled = buildRegister(scaledDefinitions(REGISTER, 10));
  const at = (id: string) => scaled.get(id)?.value ?? 0;
  for (const id of ['runner.offHeapBytes', 'runner.evidenceRetainedHeapBytes'])
    expect(at(id), id).toBeGreaterThan(REGISTER.get(id)?.value ?? 0);
  expect(at('packet.bytes')).toBe(REGISTER.get('packet.bytes')?.value);
  expect(at('analysis.projectionBytes')).toBe(REGISTER.get('analysis.projectionBytes')?.value);
  // The config cap, a parse bound held beside the packet, stays too, though the blob one scaled
  // response carries grows.
  expect(at('snapshot.maxReadableBlobBytes')).toBeGreaterThan(
    REGISTER.get('snapshot.maxReadableBlobBytes')?.value ?? 0,
  );
  expect(at('config.maxBytes')).toBe(REGISTER.get('config.maxBytes')?.value);
});

test('rejects a scale that is not a positive integer', () => {
  for (const factor of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => scaledDefinitions(REGISTER, factor), String(factor)).toThrow(/positive integer/);
});
