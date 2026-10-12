import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vite-plus/test';
import { parseReviewConfig } from './config.js';

const schema = JSON.parse(
  readFileSync(new URL('../schemas/review-config-v1.json', import.meta.url), 'utf8'),
);
const validateSchema = new Ajv({ strict: true, ownProperties: true }).compile(schema);
const defaults = {
  incompleteEvidence: 'merge_with_followups',
  highOrCriticalVulnerability: 'do_not_merge',
  moderateOrLowVulnerability: 'merge_with_followups',
  incompatibleMigration: 'do_not_merge',
  applicableCodemod: 'merge_with_followups',
};

const documents: { name: string; value: unknown; valid: boolean }[] = [
  { name: 'minimal', value: { version: 1 }, valid: true },
  { name: 'empty sections', value: { version: 1, context: {}, policy: {} }, valid: true },
  {
    name: 'explicit choices',
    value: {
      version: 1,
      analysis: { provider: 'mistral', model: 'mistral-medium-latest' },
      context: { sourceRoots: [], sendSourceExcerptsToModel: false, excerptFiles: [] },
      policy: { verdicts: { incompleteEvidence: 'merge', incompatibleMigration: 'do_not_merge' } },
    },
    valid: true,
  },
  { name: 'missing version', value: {}, valid: false },
  { name: 'string version', value: { version: '1' }, valid: false },
  { name: 'unsupported version', value: { version: 2 }, valid: false },
  { name: 'null', value: null, valid: false },
  { name: 'array', value: [], valid: false },
  { name: 'unknown root key', value: { version: 1, endpoint: 'synthetic' }, valid: false },
  {
    name: 'missing analysis model',
    value: { version: 1, analysis: { provider: 'mistral' } },
    valid: false,
  },
  {
    name: 'unsupported provider',
    value: { version: 1, analysis: { provider: 'other', model: 'model' } },
    valid: false,
  },
  {
    name: 'nonboolean opt-in',
    value: { version: 1, context: { sendSourceExcerptsToModel: 'true' } },
    valid: false,
  },
  {
    name: 'unknown rule',
    value: { version: 1, policy: { verdicts: { license: 'merge' } } },
    valid: false,
  },
  {
    name: 'unknown verdict',
    value: { version: 1, policy: { verdicts: { incompleteEvidence: 'success' } } },
    valid: false,
  },
  {
    name: 'path traversal',
    value: { version: 1, context: { sourceRoots: ['src/../private'] } },
    valid: false,
  },
  {
    name: 'excerpt glob',
    value: { version: 1, context: { excerptFiles: ['src/*.ts'] } },
    valid: false,
  },
  {
    name: 'duplicate excerpts',
    value: { version: 1, context: { excerptFiles: ['src/a.ts', 'src/a.ts'] } },
    valid: false,
  },
];

describe('v1 document contract', () => {
  test.each(documents)('$name', ({ value, valid }) => {
    const before = JSON.stringify(value);
    const result = parseReviewConfig(before);
    expect(result.ok).toBe(valid);
    expect(validateSchema(value)).toBe(valid);
    expect(JSON.stringify(value)).toBe(before);
    if (!valid) expect(result).not.toHaveProperty('config');
  });

  test('defaults agree with schema annotations and remain independent', () => {
    const first = parseReviewConfig('{"version":1}');
    const second = parseReviewConfig('{"version":1}');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('expected valid config');
    expect(first.origin).toBe('file');
    expect(first.config.analysis).toBeUndefined();
    expect(first.config.context).toEqual({
      sourceRoots: ['src'],
      sendSourceExcerptsToModel: false,
      excerptFiles: [],
    });
    expect(first.config.policy.verdicts).toEqual(defaults);
    expect(first.overrides).toEqual({});
    expect(schema.properties.context.default).toEqual(first.config.context);
    expect(schema.properties.policy.default).toEqual(first.config.policy);
    first.config.context.sourceRoots.push('changed');
    first.config.policy.verdicts.incompleteEvidence = 'merge';
    expect(second.config.context.sourceRoots).toEqual(['src']);
    expect(second.config.policy.verdicts).toEqual(defaults);
  });

  test('preserves explicit empty arrays, opt-out, and equal-to-default overrides', () => {
    const result = parseReviewConfig(JSON.stringify(documents[2].value));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid config');
    expect(result.config.context).toEqual({
      sourceRoots: [],
      sendSourceExcerptsToModel: false,
      excerptFiles: [],
    });
    expect(result.overrides).toEqual({
      incompleteEvidence: 'merge',
      incompatibleMigration: 'do_not_merge',
    });
    expect(result.config.analysis).toEqual({ provider: 'mistral', model: 'mistral-medium-latest' });
  });

  test.each(['', '{', '{"version":1,}', '// comment\n{"version":1}'])(
    'rejects malformed JSON %j',
    (text) => {
      expect(parseReviewConfig(text)).toEqual({
        ok: false,
        error: { file: '.github/dependabot-review.json', category: 'json', field: '$' },
      });
    },
  );

  test('rejects oversize text before parsing', () => {
    expect(parseReviewConfig('x'.repeat(16_385))).toMatchObject({
      ok: false,
      error: { category: 'size' },
    });
  });
});
