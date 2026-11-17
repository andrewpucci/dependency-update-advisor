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
  type LimitDefinition,
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

test('every real test field names an existing test title, or is a documented placeholder', () => {
  for (const entry of REGISTER.values()) {
    if (entry.test === PENDING_AUDIT || entry.test.startsWith('none:')) continue;
    const separator = ' > ';
    const at = entry.test.indexOf(separator);
    const file = entry.test.slice(0, at);
    const title = entry.test.slice(at + separator.length);
    expect(file, entry.id).toMatch(/^src\/[\w.-]+\.test\.ts$/);
    const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
    expect(source, entry.id).toContain(`test('${title}'`);
  }
});
