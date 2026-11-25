import { expect, test } from 'vite-plus/test';
import {
  advisoryBatchCovers,
  advisoryNames,
  BudgetSpent,
  halvingSizes,
  requestBudget,
  countBy,
  discoveryBatchCovers,
  graphqlAnswers,
  strayRecords,
  tagAnswersAgree,
  type AdvisoryNames,
} from './batching.js';

const record = (id: string, ...packages: [string, string][]): AdvisoryNames => ({
  id,
  packages: packages.map(([ecosystem, name]) => ({ ecosystem, name })),
});

test('reads the id and named packages of a raw advisory', () => {
  expect(
    advisoryNames({
      ghsa_id: 'GHSA-aaaa-bbbb-cccc',
      vulnerabilities: [
        { package: { ecosystem: 'npm', name: 'lodash' }, vulnerable_version_range: '<4.17.21' },
        { package: { ecosystem: 'rubygems', name: 'lodash-rails' } },
      ],
    }),
  ).toEqual(record('GHSA-aaaa-bbbb-cccc', ['npm', 'lodash'], ['rubygems', 'lodash-rails']));
  for (const value of [
    null,
    { vulnerabilities: [] },
    { ghsa_id: 'GHSA-x', vulnerabilities: [{ package: { ecosystem: 'npm' } }] },
    { ghsa_id: 'GHSA-x', vulnerabilities: [null] },
    { ghsa_id: 'GHSA-x' },
  ])
    expect(advisoryNames(value), JSON.stringify(value)).toBeNull();
});

test('a batch covers singleton matches it returns naming the target', () => {
  const batch = [
    record('GHSA-1', ['npm', 'lodash'], ['rubygems', 'lodash-rails']),
    record('GHSA-2', ['npm', '@babel/traverse']),
  ];
  expect(
    advisoryBatchCovers(
      'npm',
      [
        { name: 'lodash', ids: ['GHSA-1'] },
        { name: '@babel/traverse', ids: ['GHSA-2'] },
        { name: 'left-pad', ids: [] },
      ],
      batch,
    ),
  ).toEqual([]);
});

test('reports a singleton match the batch did not return', () => {
  expect(
    advisoryBatchCovers(
      'npm',
      [{ name: 'lodash', ids: ['GHSA-1', 'GHSA-9'] }],
      [record('GHSA-1', ['npm', 'lodash'])],
    ),
  ).toEqual([{ target: 'lodash', item: 'GHSA-9', kind: 'absent' }]);
});

test('a record naming the package only in another ecosystem does not cover it', () => {
  expect(
    advisoryBatchCovers(
      'npm',
      [{ name: 'lodash', ids: ['GHSA-1'] }],
      [record('GHSA-1', ['rubygems', 'lodash'])],
    ),
  ).toEqual([{ target: 'lodash', item: 'GHSA-1', kind: 'unnamed' }]);
});

test('npm names are compared exactly', () => {
  expect(
    advisoryBatchCovers(
      'npm',
      [{ name: 'lodash', ids: ['GHSA-1'] }],
      [record('GHSA-1', ['npm', 'Lodash'])],
    ),
  ).toEqual([{ target: 'lodash', item: 'GHSA-1', kind: 'unnamed' }]);
});

test('a discovery batch covers every stored form, matched to its target canonically', () => {
  const batch = [
    record('GHSA-1', ['pip', 'Jupyter_Server']),
    record('GHSA-2', ['pip', 'jupyter-server'], ['npm', 'jupyter-server']),
    record('GHSA-3', ['actions', 'TJ-Actions/Changed-Files']),
  ];
  expect(
    discoveryBatchCovers(
      'pip',
      [{ name: 'jupyter-server', forms: ['Jupyter_Server', 'jupyter-server'] }],
      batch,
    ),
  ).toEqual([]);
  expect(
    discoveryBatchCovers(
      'actions',
      [{ name: 'tj-actions/changed-files', forms: ['TJ-Actions/Changed-Files'] }],
      batch,
    ),
  ).toEqual([]);
});

test('reports a stored form the discovery batch did not return or did not give the target', () => {
  expect(
    discoveryBatchCovers(
      'pip',
      [{ name: 'flo-pro-adk', forms: ['flo_pro_adk', 'Flo.Pro.Adk'] }],
      [record('GHSA-1', ['pip', 'flo_pro_adk']), record('GHSA-2', ['npm', 'Flo.Pro.Adk'])],
    ),
  ).toEqual([{ target: 'flo-pro-adk', item: 'Flo.Pro.Adk', kind: 'absent' }]);
});

test('finds batch records that name no batched target', () => {
  const batch = [
    record('GHSA-1', ['pip', 'Jupyter_Server']),
    record('GHSA-2', ['npm', 'jupyter-server']),
    record('GHSA-3', ['pip', 'other']),
  ];
  expect(strayRecords('pip', ['jupyter-server'], batch)).toEqual(['GHSA-2', 'GHSA-3']);
});

const aliases = [
  { alias: 'c0', repository: 'vitejs/vite' },
  { alias: 'c1', repository: 'vitest-dev/vitest' },
  { alias: 'c2', repository: 'gone/repo' },
  { alias: 'c3', repository: 'old/name' },
];

test('reads each alias: a tag found, a null ref, an erroring alias, and a renamed repository', () => {
  const answers = graphqlAnswers(
    {
      data: {
        c0: { nameWithOwner: 'ViteJS/Vite', ref: { target: { oid: 'abc' } } },
        c1: { nameWithOwner: 'vitest-dev/vitest', ref: null },
        c2: null,
        c3: { nameWithOwner: 'new/name', ref: null },
        rateLimit: { cost: 1 },
      },
      errors: [{ path: ['c2'], type: 'NOT_FOUND' }],
    },
    aliases,
  );
  expect(Object.fromEntries(answers)).toEqual({
    c0: 'found',
    c1: 'null',
    c2: 'error',
    c3: 'error',
  });
});

test('an error naming an alias is never read as null, even with a null ref', () => {
  const answers = graphqlAnswers(
    {
      data: { c1: { nameWithOwner: 'vitest-dev/vitest', ref: null } },
      errors: [{ path: ['c1', 'ref'] }],
    },
    [aliases[1]],
  );
  expect(answers.get('c1')).toBe('error');
});

test('a null or missing repository with no error is still an error, not a missing tag', () => {
  const answers = graphqlAnswers({ data: { c2: null } }, [aliases[2], aliases[3]]);
  expect(Object.fromEntries(answers)).toEqual({ c2: 'error', c3: 'error' });
});

test('an error without a path, or no data, makes every alias an error', () => {
  const data = { c1: { nameWithOwner: 'vitest-dev/vitest', ref: null } };
  for (const response of [{ data, errors: [{ message: 'boom' }] }, { errors: [] }, null, {}])
    expect([...graphqlAnswers(response, [aliases[1]]).values()], JSON.stringify(response)).toEqual([
      'error',
    ]);
});

test('REST and GraphQL agree only on found/found and 404/null', () => {
  expect(tagAnswersAgree('200', 'found')).toBe('agree');
  expect(tagAnswersAgree('404', 'null')).toBe('agree');
  expect(tagAnswersAgree('200', 'null')).toBe('rest-found-graphql-null');
  expect(tagAnswersAgree('404', 'found')).toBe('rest-missing-graphql-found');
  expect(tagAnswersAgree('404', 'error')).toBe('graphql-error');
  expect(tagAnswersAgree('500', 'null')).toBe('rest-other');
  expect(tagAnswersAgree('error', 'found')).toBe('rest-other');
});

test('counts by key', () => {
  expect(countBy(['agree', 'agree', 'graphql-error'], (v) => v)).toEqual({
    agree: 2,
    'graphql-error': 1,
  });
});

test('batch sizes halve from the maximum down to one', () => {
  expect(halvingSizes(1000)).toEqual([1000, 500, 250, 125, 62, 31, 15, 7, 3, 1]);
  expect(halvingSizes(100)).toEqual([100, 50, 25, 12, 6, 3, 1]);
  expect(halvingSizes(1)).toEqual([1]);
});

test('a request budget refuses the request past its cap', () => {
  const budget = requestBudget(2);
  budget.spend();
  budget.spend();
  expect(() => budget.spend()).toThrow(BudgetSpent);
  expect(budget.used()).toBe(2);
});
