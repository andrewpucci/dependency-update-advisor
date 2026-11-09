import { expect, test } from 'vite-plus/test';
import { assessReviewPacket } from './assessment.js';

test('refuses an absent model credential before analysis input is constructed', async () => {
  const result = await assessReviewPacket({
    packet: {} as never,
    config: {
      ok: true,
      config: {} as never,
      origin: 'missing',
      overrides: {},
      minimumReleaseAgeDaysExplicit: false,
    },
    apiKey: null,
    evaluatedAt: 0,
    deadlineMs: 1,
  });
  expect(result).toEqual({ kind: 'model-unavailable' });
});

test('invalid config stays status-only without invoking model analysis', async () => {
  const result = await assessReviewPacket({
    packet: {} as never,
    config: {
      ok: false,
      error: { file: '.github/dependabot-review.json', category: 'json', field: '$' },
    },
    apiKey: 'sentinel-model-key',
    evaluatedAt: 0,
    deadlineMs: 1,
  });
  expect(result).toEqual({ kind: 'internal-failure' });
  expect(JSON.stringify(result)).not.toContain('sentinel-model-key');
});
