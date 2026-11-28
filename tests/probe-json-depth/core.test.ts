import { expect, test } from 'vite-plus/test';
import {
  jsonDepth,
  nestedArrays,
  overflowDepth,
  summarizeDepths,
} from '../../scripts/probe-json-depth/core.js';

test('depth counts the root as 0 and each array element or object value one level deeper', () => {
  expect(jsonDepth('x')).toBe(0);
  expect(jsonDepth({})).toBe(0);
  expect(jsonDepth({ a: 1 })).toBe(1);
  expect(jsonDepth({ a: [{ b: null }], c: 'x' })).toBe(3);
  expect(jsonDepth(nestedArrays(5))).toBe(5);
});

test('a summary gives the count and the deepest nesting, never a name', () => {
  expect(summarizeDepths([])).toEqual({ documents: 0, deepest: 0 });
  expect(summarizeDepths([2, 9, 3])).toEqual({ documents: 3, deepest: 9 });
});

test('the overflow depth is the smallest nesting the call cannot complete', () => {
  // A call that fails from depth 40 on reports exactly 40.
  const limited = (value: unknown) => {
    if (jsonDepth(value) >= 40) throw new RangeError('Maximum call stack size exceeded');
  };
  expect(overflowDepth(limited, 1_000)).toBe(40);
  expect(overflowDepth(() => undefined, 1_000)).toBeNull();
  expect(() =>
    overflowDepth(() => {
      throw new TypeError('not a stack overflow');
    }, 10),
  ).toThrow(TypeError);
});
