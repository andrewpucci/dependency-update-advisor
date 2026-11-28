import { expect, test } from 'vite-plus/test';
import {
  indexNames,
  separators,
  summarizeSeparators,
} from '../../scripts/probe-name-separators/core.js';

test('a run of separators counts once, as PEP 503 normalization collapses it', () => {
  expect(separators('requests')).toBe(0);
  expect(separators('a-b_c.d')).toBe(3);
  expect(separators('a--b__c.-_d')).toBe(3);
});

test('the summary counts names by separators and never holds a name', () => {
  const summary = summarizeSeparators(['a', 'b-c', 'd_e', 'f-g-h-i-j-k-l']);
  expect(summary).toEqual({ names: 4, bySeparators: { 0: 1, 1: 2, 6: 1 }, most: 6 });
  expect(JSON.stringify(summary)).not.toMatch(/[a-l]-/u);
  expect(summarizeSeparators([])).toEqual({ names: 0, bySeparators: {}, most: 0 });
});

test('the index names are read from a PEP 691 JSON simple index', () => {
  expect(indexNames({ meta: {}, projects: [{ name: 'a-b' }, { name: 'c' }] })).toEqual([
    'a-b',
    'c',
  ]);
  expect(() => indexNames({ projects: [{}] })).toThrow();
  expect(() => indexNames([])).toThrow();
});
