import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import { parseDocument } from 'yaml';

const callerPath = new URL('../../.github/workflows/dependabot-review-caller.yml', import.meta.url);
const ciPath = new URL('../../.github/workflows/ci.yml', import.meta.url);

type LocatedExpression = { path: string; value: string };

function expressionsIn(value: unknown, path: string[] = []): LocatedExpression[] {
  if (typeof value === 'string')
    return [...value.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => ({
      path: path.join('.'),
      value: match[1]!,
    }));
  if (Array.isArray(value))
    return value.flatMap((entry, index) => expressionsIn(entry, [...path, String(index)]));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, entry]) => expressionsIn(entry, [...path, key]));
  return [];
}

test('R1 caller permits only the approved pinned workflow_run shape', () => {
  const document = parseDocument(readFileSync(callerPath, 'utf8'), { uniqueKeys: true });
  const caller = document.toJS();
  const ciDocument = parseDocument(readFileSync(ciPath, 'utf8'), { uniqueKeys: true });
  const ci = ciDocument.toJS() as { name?: unknown };

  expect(document.errors).toEqual([]);
  expect(ciDocument.errors).toEqual([]);
  expect(ci.name).toBe('CI');
  expect(caller).toEqual({
    name: 'Dependabot review caller',
    on: { workflow_run: { workflows: ['CI'], types: ['completed'] } },
    permissions: {
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    },
    jobs: {
      review: {
        uses: 'andrewpucci/dependency-update-advisor/.github/workflows/dependabot-review.yml@351cc6e125afc415195a974ca881223e00453b09',
        with: { ci_workflow: '.github/workflows/ci.yml' },
        secrets: {
          llm_api_key: '${{ secrets.llm_api_key }}',
          review_app_client_id: '${{ secrets.review_app_client_id }}',
          review_app_private_key: '${{ secrets.review_app_private_key }}',
        },
      },
    },
  });
  expect(expressionsIn(caller)).toEqual([
    { path: 'jobs.review.secrets.llm_api_key', value: 'secrets.llm_api_key' },
    {
      path: 'jobs.review.secrets.review_app_client_id',
      value: 'secrets.review_app_client_id',
    },
    {
      path: 'jobs.review.secrets.review_app_private_key',
      value: 'secrets.review_app_private_key',
    },
  ]);
});
