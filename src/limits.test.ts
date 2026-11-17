import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import { PACKET_LIMITS } from './schema.js';
import {
  PENDING_AUDIT,
  REGISTER,
  buildRegister,
  checkRegister,
  dependents,
  limit,
  limitEntry,
  type LimitDefinition,
  type LimitId,
} from './limits.js';

const unjustified = (id: string, value: number): LimitDefinition => ({
  id,
  value,
  unit: 'count',
  protects: PENDING_AUDIT,
  effect: PENDING_AUDIT,
  basis: { kind: 'unjustified', note: PENDING_AUDIT },
  test: PENDING_AUDIT,
});

const derived = (
  id: string,
  inputs: string[],
  formula: (...values: number[]) => number,
): LimitDefinition => ({
  id,
  unit: 'count',
  protects: PENDING_AUDIT,
  effect: PENDING_AUDIT,
  basis: { kind: 'derived', inputs, formula, description: 'test formula' },
  test: PENDING_AUDIT,
});

test('PACKET_LIMITS is a frozen view of the register with the same values and keys', () => {
  const keys = Object.keys(PACKET_LIMITS) as (keyof typeof PACKET_LIMITS)[];
  for (const key of keys) {
    expect(PACKET_LIMITS[key]).toBe(limit(`packet.${key}`));
  }
  expect(Object.isFrozen(PACKET_LIMITS)).toBe(true);
  const packetIds = [...REGISTER.keys()].filter((id) => id.startsWith('packet.')).sort();
  expect(packetIds).toEqual(keys.map((key) => `packet.${key}`).sort());
  expect(packetIds).toHaveLength(14);
});

test('checkRegister names an entry whose basis kind is not one of the five', () => {
  const guessed = { ...unjustified('guessed', 1), basis: { kind: 'guess', note: 'x' } };
  expect(checkRegister([guessed])).toEqual([expect.stringMatching(/guessed/)]);
  expect(checkRegister([{ ...guessed, basis: { kind: 'safety', reason: 'x' } }])).toEqual([]);
});

test('a derived input that names no entry is reported with both ids and blocks the build', () => {
  const orphan = derived('orphan', ['missing'], (m) => m);
  const problems = checkRegister([orphan]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/orphan/);
  expect(problems[0]).toMatch(/missing/);
  expect(() => buildRegister([orphan])).toThrow(/orphan[\s\S]*missing/);
});

test('derived values resolve in any definition order and dependents follow transitive reads', () => {
  const register = buildRegister([derived('b', ['a'], (a) => a * 3), unjustified('a', 4)]);
  expect(register.get('b')?.value).toBe(12);
  expect(dependents(register, 'a')).toEqual(['b']);

  const chain = buildRegister([
    derived('c', ['b'], (b) => b + 1),
    derived('b', ['a'], (a) => a * 3),
    unjustified('a', 4),
  ]);
  expect(chain.get('c')?.value).toBe(13);
  expect(dependents(chain, 'a')).toEqual(['b', 'c']);
});

test('checkRegister reports duplicate ids, missing values, stray values, and cycles', () => {
  expect(checkRegister([unjustified('a', 1), unjustified('a', 2)])).toEqual([
    expect.stringMatching(/a: duplicate id/),
  ]);
  expect(checkRegister([{ ...unjustified('a', 1), value: undefined }])).toEqual([
    expect.stringMatching(/a: value/),
  ]);
  expect(
    checkRegister([{ ...derived('b', ['a'], (a) => a), value: 3 }, unjustified('a', 1)]),
  ).toEqual([expect.stringMatching(/b: .*value/)]);
  expect(checkRegister([derived('x', ['y'], (y) => y), derived('y', ['x'], (x) => x)])).toEqual([
    expect.stringMatching(/cycle/),
  ]);
});

test('derived limits are wired to the entries they sum or copy', () => {
  expect(dependents(REGISTER, 'evidence.allocation.signals.readers.malware.maxRequests')).toEqual(
    expect.arrayContaining([
      'evidence.allocation.signals.maxRequests',
      'evidence.envelope.maxRequests',
    ]),
  );
  expect(dependents(REGISTER, 'evidence.allocation.registry.maxTotalBytes')).toEqual(
    expect.arrayContaining(['evidence.envelope.maxTotalBytes', 'research.cache.maxTotalBytes']),
  );
  expect(dependents(REGISTER, 'job.budget')).toEqual(['job.window']);
});

/** Each copy of a packet limit, paired with the packet entry whose value it mirrors. */
const PACKET_COPIES: readonly [LimitId, LimitId][] = [
  ['context.maxDependencies', 'packet.changes'],
  ['context.maxIdCodeUnits', 'packet.idCodeUnits'],
  ['context.maxPathBytes', 'packet.identityBytes'],
  ['context.maxSourceContextBytes', 'packet.contextBytes'],
  ['context.maxSourceExcerptCodeUnits', 'packet.excerptCodeUnits'],
  ['context.maxSourceFactsPerDependency', 'packet.facts'],
  ['dependabot.maxPathBytes', 'packet.identityBytes'],
];

test('copies wired: a packet copy is a derived mirror of its packet entry', () => {
  for (const [copy, source] of PACKET_COPIES) {
    expect(limitEntry(copy).basis, copy).toMatchObject({ kind: 'derived', inputs: [source] });
    expect(dependents(REGISTER, source), copy).toContain(copy);
    expect(limit(copy), copy).toBe(limit(source));
  }
});

test('copies wired: the source-root and candidate bounds are one entry each, read by config and context', () => {
  expect(limit('context.maxSourceRoots')).toBe(16);
  expect(limit('context.maxSourceCandidates')).toBe(128);
  expect(dependents(REGISTER, 'context.maxSourceRoots')).toEqual([]);
  expect(dependents(REGISTER, 'context.maxSourceCandidates')).toEqual([]);
  for (const file of ['src/config.ts', 'src/context.ts']) {
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    expect(source, file).toContain("limit('context.maxSourceRoots')");
    expect(source, file).toContain("limit('context.maxSourceCandidates')");
  }
});

test('every real test field names an existing test title, or is a documented placeholder', () => {
  for (const entry of REGISTER.values()) {
    const tests = [entry.test];
    if (entry.basis.kind === 'derived' && entry.basis.structuralTest !== undefined) {
      tests.push(entry.basis.structuralTest);
    }
    for (const test of tests) {
      if (test === PENDING_AUDIT || test.startsWith('none:')) continue;
      const separator = ' > ';
      const at = test.indexOf(separator);
      const file = test.slice(0, at);
      const title = test.slice(at + separator.length);
      expect(file, entry.id).toMatch(/^src\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts$/);
      const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
      expect(source, entry.id).toContain(`test('${title}'`);
    }
  }
});
