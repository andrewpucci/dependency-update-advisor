import { basename } from 'node:path';
import { expect, test } from 'vite-plus/test';

test('runs TypeScript with Node built-ins and no DOM', () => {
  const fixturePath: string = 'tests/parity/README.md';
  expect(basename(fixturePath)).toBe('README.md');
  expect(globalThis).not.toHaveProperty('document');
});
