import { expect, test } from 'vite-plus/test';
import {
  advisoryBatchCovers,
  advisoryBatchExtras,
  advisoryNames,
  discoveryBatchExtras,
  distinctTags,
  graphqlAnswered,
  sweepChunks,
  tagAgreement,
  versionInRange,
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
  for (const response of [
    { data, errors: [{ message: 'boom' }] },
    { data, errors: [null] },
    { errors: [] },
    null,
    {},
  ])
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

test('reports batch records the singletons lacked, by whether they would be attributed', () => {
  const batch = [
    record('GHSA-1', ['npm', 'lodash']),
    record('GHSA-2', ['npm', 'lodash'], ['npm', 'left-pad']),
    record('GHSA-3', ['npm', 'lodash'], ['rubygems', 'left-pad']),
    record('GHSA-4', ['npm', 'dua-probe-filler-0']),
  ];
  expect(
    advisoryBatchExtras(
      'npm',
      [
        { name: 'lodash', ids: ['GHSA-1'] },
        { name: 'left-pad', ids: [] },
        { name: 'dua-probe-filler-0', ids: [] },
      ],
      batch,
    ),
  ).toEqual([
    { target: 'lodash', item: 'GHSA-2', kind: 'shared' },
    { target: 'left-pad', item: 'GHSA-2', kind: 'shared' },
    { target: 'lodash', item: 'GHSA-3', kind: 'attributable' },
    { target: 'dua-probe-filler-0', item: 'GHSA-4', kind: 'attributable' },
  ]);
});

test('a package is judged on all its batched versions, and not at all when one is unknown', () => {
  const batch = [
    record('GHSA-1', ['npm', 'lodash']),
    record('GHSA-2', ['npm', 'left-pad']),
    record('GHSA-3', ['npm', 'right-pad']),
  ];
  expect(
    advisoryBatchExtras(
      'npm',
      [
        { name: 'lodash', ids: ['GHSA-1'] },
        { name: 'lodash', ids: [] },
        { name: 'left-pad', ids: [] },
        { name: 'left-pad', ids: null },
        { name: 'right-pad', ids: null },
        { name: 'right-pad', ids: [] },
      ],
      batch,
    ),
  ).toEqual([]);
  // npm names are compared exactly, as the clearing rule does.
  expect(
    advisoryBatchExtras(
      'npm',
      [{ name: 'lodash', ids: [] }],
      [record('GHSA-1', ['npm', 'Lodash'])],
    ),
  ).toEqual([]);
});

test('reports a stored form the discovery batch gives a target that per-target discovery lacked', () => {
  const batch = [
    record('GHSA-1', ['pip', 'flo_pro_adk']),
    record('GHSA-2', ['pip', 'Flo.Pro.Adk']),
    record('GHSA-3', ['npm', 'flo-pro-adk']),
  ];
  expect(
    discoveryBatchExtras('pip', [{ name: 'flo-pro-adk', forms: ['flo_pro_adk'] }], batch),
  ).toEqual([{ target: 'flo-pro-adk', item: 'Flo.Pro.Adk', kind: 'form' }]);
});

test('a GraphQL response is answered only with a data object and a path on every error', () => {
  expect(graphqlAnswered({ data: {} })).toBe(true);
  expect(graphqlAnswered({ data: {}, errors: [{ path: ['c0'] }] })).toBe(true);
  for (const response of [null, {}, { data: null }, { data: {}, errors: [{ message: 'x' }] }])
    expect(graphqlAnswered(response), JSON.stringify(response)).toBe(false);
});

test('keeps every distinct REST status of one tag, and reports two as a conflict', () => {
  const tags = distinctTags([
    { repository: 'a/b', tag: 'v1', status: '404' },
    { repository: 'a/b', tag: 'v1', status: '404' },
    { repository: 'a/b', tag: 'v1', status: '200' },
    { repository: 'a/b', tag: 'v2', status: '200' },
  ]);
  expect(tags).toEqual([
    { repository: 'a/b', tag: 'v1', statuses: ['404', '200'] },
    { repository: 'a/b', tag: 'v2', statuses: ['200'] },
  ]);
  expect(tagAgreement(tags[0].statuses, 'null')).toBe('rest-conflict');
  expect(tagAgreement(tags[0].statuses, 'found')).toBe('rest-conflict');
  expect(tagAgreement(tags[1].statuses, 'found')).toBe('agree');
  // Only 200 and 404 decide: another status beside one of them is ignored, and alone it is other.
  expect(tagAgreement(['404', '502'], 'null')).toBe('agree');
  expect(tagAgreement(['502', '200'], 'null')).toBe('rest-found-graphql-null');
  expect(tagAgreement(['502', '403'], 'null')).toBe('rest-other');
});

test('chooses a version inside a GitHub range, or none', () => {
  expect(versionInRange('>= 1.0.0, < 1.2.0')).toBe('1.0.0');
  expect(versionInRange('< 2.0.0')).toBe('0.0.0');
  expect(versionInRange('> 1.0.0')).toBe('1.0.1');
  expect(versionInRange('= 1.0.4')).toBe('1.0.4');
  expect(versionInRange('>= 0')).toBe('0.0.0');
  for (const range of ['', 'garbage', '>= 2.0.0, < 1.0.0'])
    expect(versionInRange(range), range).toBeNull();
});

test('sweep batches hold every target, at most the maximum each, with positives spread and last', () => {
  const rest = ['r0', 'r1', 'r2', 'r3', 'r4'];
  expect(sweepChunks(rest, ['p0', 'p1', 'p2'], 3).chunks).toEqual([
    ['r0', 'r1', 'p0'],
    ['r2', 'r3', 'p1'],
    ['r4', 'p2'],
  ]);
  expect(sweepChunks([], ['p0', 'p1', 'p2'], 2).chunks).toEqual([['p0', 'p2'], ['p1']]);
  expect(sweepChunks(rest, ['p0'], 10)).toEqual({ chunks: [[...rest, 'p0']], skipped: [] });
  expect(sweepChunks([], [], 10)).toEqual({ chunks: [], skipped: [] });
});

test('sweep batches also fit a length check, with positives still spread and last', () => {
  // A batch fits when its entries, joined, are at most 8 characters: four two-character entries.
  const fits = (chunk: readonly string[]) => chunk.join('').length <= 8;
  const rest = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
  const { chunks, skipped } = sweepChunks(rest, ['p0', 'p1', 'p2'], 10, fits);
  expect(chunks).toEqual([
    ['r0', 'r1', 'r2', 'p0'],
    ['r3', 'r4', 'r5', 'p1'],
    ['r6', 'p2'],
  ]);
  expect(skipped).toEqual([]);
  // Five positives cannot share one batch; the split adds a batch instead.
  const tight = sweepChunks(['r0', 'r1', 'r2'], ['p0', 'p1', 'p2', 'p3', 'p4'], 10, fits);
  expect(tight.chunks).toEqual([
    ['r0', 'p0', 'p2', 'p4'],
    ['r1', 'r2', 'p1', 'p3'],
  ]);
});

test('positives that cannot share one batch are split even with no other target', () => {
  const fits = (chunk: readonly string[]) => chunk.join('').length <= 8;
  expect(sweepChunks([], ['pppp', 'qqqq', 'rrrr'], 10, fits).chunks).toEqual([
    ['pppp', 'rrrr'],
    ['qqqq'],
  ]);
});

test('a target too long for a batch on its own is skipped, not carried', () => {
  const fits = (chunk: readonly string[]) => chunk.join('').length <= 4;
  expect(sweepChunks(['r0', 'long-r'], ['p0', 'long-p'], 10, fits)).toEqual({
    chunks: [['r0', 'p0']],
    skipped: ['long-r', 'long-p'],
  });
});
