import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { expect, test } from 'vite-plus/test';

import { parseReviewConfig } from '../../src/config.js';

const configPath = new URL('../../.github/dependabot-review.json', import.meta.url);
const schema = JSON.parse(
  readFileSync(new URL('../../schemas/review-config-v1.json', import.meta.url), 'utf8'),
);
const validateSchema = new Ajv({ strict: true, ownProperties: true }).compile(schema);

test('R1 config explicitly selects the approved no-excerpt review settings', () => {
  const text = readFileSync(configPath, 'utf8');
  const config: unknown = JSON.parse(text);

  expect(config).toEqual({
    version: 1,
    analysis: { provider: 'mistral', model: 'mistral-large-latest' },
    context: { sourceRoots: ['src'], sendSourceExcerptsToModel: false },
  });
  expect(parseReviewConfig(text).ok).toBe(true);
  expect(validateSchema(config)).toBe(true);
});
