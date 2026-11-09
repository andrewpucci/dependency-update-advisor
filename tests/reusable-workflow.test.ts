import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import { isScalar, parseDocument, visit } from 'yaml';

const workflowPath = new URL('../.github/workflows/dependabot-review.yml', import.meta.url);

function parseWorkflow() {
  return parseDocument(readFileSync(workflowPath, 'utf8'), { uniqueKeys: true });
}

type LocatedText = { path: string; value: string };

function stringsIn(value: unknown, path: string[] = []): LocatedText[] {
  if (typeof value === 'string') return [{ path: path.join('.'), value }];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => stringsIn(entry, [...path, String(index)]));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [
      { path: [...path, '<key>'].join('.'), value: key },
      ...stringsIn(entry, [...path, key]),
    ]);
  }
  return [];
}

function expressionsIn(value: unknown): LocatedText[] {
  return stringsIn(value).flatMap(({ path, value: text }) =>
    [...text.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => ({
      path,
      value: match[1]!,
    })),
  );
}

function keysNamed(value: unknown, name: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => keysNamed(entry, name));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [
      ...(key === name ? [key] : []),
      ...keysNamed(entry, name),
    ]);
  }
  return [];
}

test('R1 trigger permits only workflow_call', () => {
  const workflow = parseWorkflow().toJS() as { on: unknown };
  expect(workflow.on).toEqual({ workflow_call: expect.any(Object) });
});

test('R2 names exactly the required secrets and ci_workflow input', () => {
  const workflow = parseWorkflow().toJS() as {
    on: { workflow_call: { inputs: unknown; secrets: unknown } };
  };
  expect(workflow.on.workflow_call.inputs).toEqual({
    ci_workflow: {
      description: 'Repository-relative file path of the intended CI workflow.',
      type: 'string',
      required: true,
    },
  });
  expect(workflow.on.workflow_call.secrets).toEqual({
    llm_api_key: { required: true },
    review_app_client_id: { required: true },
    review_app_private_key: { required: true },
  });
});

test('R3 grants only minimum workflow permissions', () => {
  const workflow = parseWorkflow().toJS() as {
    jobs: { review: { permissions?: unknown; steps: Array<{ permissions?: unknown }> } };
    permissions: unknown;
  };
  expect(workflow.permissions).toEqual({
    actions: 'read',
    contents: 'read',
    'pull-requests': 'read',
  });
  expect(workflow.jobs.review.permissions).toBeUndefined();
  for (const step of workflow.jobs.review.steps) expect(step.permissions).toBeUndefined();
});

test('R4 resolves the reviewer action from the called commit', () => {
  const workflow = parseWorkflow().toJS() as {
    jobs: { review: { steps: Array<{ uses?: unknown }> } };
  };
  expect(workflow.jobs.review.steps[1]?.uses).toBe('$/.github/actions/dependabot-review');
});

test('R5 uses the exact privileged review job shape', () => {
  expect(parseWorkflow().toJS()).toEqual({
    name: 'Dependabot review',
    on: {
      workflow_call: {
        inputs: {
          ci_workflow: {
            description: 'Repository-relative file path of the intended CI workflow.',
            type: 'string',
            required: true,
          },
        },
        secrets: {
          llm_api_key: { required: true },
          review_app_client_id: { required: true },
          review_app_private_key: { required: true },
        },
      },
    },
    permissions: {
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    },
    jobs: {
      review: {
        name: 'Dependabot review',
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 15,
        steps: [
          {
            id: 'app-token',
            uses: 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510',
            with: {
              'client-id': '${{ secrets.review_app_client_id }}',
              'private-key': '${{ secrets.review_app_private_key }}',
              'permission-issues': 'write',
              'permission-statuses': 'write',
            },
          },
          {
            uses: '$/.github/actions/dependabot-review',
            with: {
              'github-token': '${{ github.token }}',
              'app-token': '${{ steps.app-token.outputs.token }}',
              'llm-api-key': '${{ secrets.llm_api_key }}',
              'ci-workflow': '${{ inputs.ci_workflow }}',
            },
          },
        ],
      },
    },
  });
});

test('R10 bounds execution without concurrency or ignored failures', () => {
  const workflow = parseWorkflow().toJS() as {
    concurrency?: unknown;
    jobs: {
      review: {
        concurrency?: unknown;
        'continue-on-error'?: unknown;
        'timeout-minutes'?: unknown;
        steps: Array<{ concurrency?: unknown; 'continue-on-error'?: unknown }>;
      };
    };
  };
  const review = workflow.jobs.review;
  expect(review['timeout-minutes']).toBe(15);
  expect(workflow.concurrency).toBeUndefined();
  expect(review.concurrency).toBeUndefined();
  expect(review['continue-on-error']).toBeUndefined();
  for (const step of review.steps) {
    expect(step.concurrency).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
  }
});

test('R6 pins the GitHub App-token action with a version comment', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  expect(workflow).toMatch(
    /^        uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d+(?:\.\d+)*$/m,
  );
});

test('R7 scopes every named secret to its one allowed action input', () => {
  const workflow = parseWorkflow().toJS();
  expect(keysNamed(workflow, 'env')).toEqual([]);
  expect(stringsIn(workflow).filter(({ value }) => /secrets(?:\.|\[)/.test(value))).toEqual([
    {
      path: 'jobs.review.steps.0.with.client-id',
      value: '${{ secrets.review_app_client_id }}',
    },
    {
      path: 'jobs.review.steps.0.with.private-key',
      value: '${{ secrets.review_app_private_key }}',
    },
    {
      path: 'jobs.review.steps.1.with.llm-api-key',
      value: '${{ secrets.llm_api_key }}',
    },
  ]);
});

test('R8 mints the App token with exactly its two required permissions', () => {
  const workflow = parseWorkflow().toJS() as {
    jobs: { review: { steps: Array<{ with?: unknown }> } };
  };
  expect(workflow.jobs.review.steps[0]?.with).toEqual({
    'client-id': '${{ secrets.review_app_client_id }}',
    'private-key': '${{ secrets.review_app_private_key }}',
    'permission-issues': 'write',
    'permission-statuses': 'write',
  });
});

test('R9 permits only the six declared expressions and no if key', () => {
  const workflow = parseWorkflow().toJS();
  expect(expressionsIn(workflow)).toEqual([
    { path: 'jobs.review.steps.0.with.client-id', value: 'secrets.review_app_client_id' },
    { path: 'jobs.review.steps.0.with.private-key', value: 'secrets.review_app_private_key' },
    { path: 'jobs.review.steps.1.with.github-token', value: 'github.token' },
    { path: 'jobs.review.steps.1.with.app-token', value: 'steps.app-token.outputs.token' },
    { path: 'jobs.review.steps.1.with.llm-api-key', value: 'secrets.llm_api_key' },
    { path: 'jobs.review.steps.1.with.ci-workflow', value: 'inputs.ci_workflow' },
  ]);
  expect(keysNamed(workflow, 'if')).toEqual([]);
});

test('R13 rejects malformed, duplicate, aliased, and merged YAML', () => {
  const document = parseWorkflow();
  const anchors: unknown[] = [];
  const aliases: unknown[] = [];
  const mergeKeys: unknown[] = [];
  visit(document, {
    Alias: (_key, node) => void aliases.push(node),
    Node: (_key, node) => {
      if ('anchor' in node && node.anchor) anchors.push(node);
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === '<<') mergeKeys.push(pair);
    },
  });
  expect(document.errors).toEqual([]);
  expect(anchors).toEqual([]);
  expect(aliases).toEqual([]);
  expect(mergeKeys).toEqual([]);
});
