import { expect, test } from 'vite-plus/test';
import { readWorkflow, type YamlLimits } from './actions-yaml.js';

const limits: YamlLimits = {
  maxFileBytes: 100_000,
  maxYamlNodes: 10_000,
  maxYamlDepth: 32,
  maxAliasExpansions: 100,
  maxOccurrences: 100,
};
function read(yaml: string, overrides: Partial<YamlLimits> = {}) {
  return readWorkflow(new TextEncoder().encode(yaml), { ...limits, ...overrides });
}
const ordinary = `on: [push]
jobs:
  build:
    steps:
      - run: echo uses:example/ignored@v1
      - id: setup
        uses: example/action/subpath@v2 # v9 is not the ref
  reuse:
    uses: example/repo/.github/workflows/build.yml@main
`;

test('reads exact step and job occurrences without comments or run bodies', () => {
  const result = read(ordinary);
  expect(result).toMatchObject({
    kind: 'parsed',
    gaps: [],
    jobs: [
      {
        jobId: 'build',
        steps: [
          { id: null, use: null },
          {
            id: 'setup',
            use: {
              kind: 'external',
              action: 'example/action/subpath',
              ref: 'v2',
              refKind: 'unknown',
            },
          },
        ],
      },
      {
        jobId: 'reuse',
        steps: null,
        use: { kind: 'external', action: 'example/repo/.github/workflows/build.yml', ref: 'main' },
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('ignored');
  expect(JSON.stringify(result)).not.toContain('v9');
});

test('expands anchored jobs, steps and refs into independent consuming locations', () => {
  const result = read(`jobs:
  a: &job
    steps:
      - &step
        uses: &ref example/action@v1
      - *step
      - uses: *ref
  b: *job
`);
  expect(result.kind).toBe('parsed');
  if (result.kind !== 'parsed') throw new Error('expected parsed');
  expect(result.jobs.map((j) => [j.jobId, j.steps?.length])).toEqual([
    ['a', 3],
    ['b', 3],
  ]);
  expect(result.gaps).toEqual([]);
  expect(read(`jobs: { a: &a { steps: *a } }`)).toEqual({
    kind: 'unavailable',
    reason: 'unsupported',
  });
  expect(read(`jobs: { a: &a { steps: [] }, b: *a }`, { maxAliasExpansions: 1 }).kind).toBe(
    'parsed',
  );
  expect(read(`jobs: { a: &a { steps: [] }, b: *a, c: *a }`, { maxAliasExpansions: 1 })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});

test.each([
  ['jobs: [', 'malformed'],
  ['jobs: {}\njobs: {}', 'malformed'],
  ['jobs: {}\n---\njobs: {}', 'malformed'],
  ['jobs: !custom {}', 'unsupported'],
  ['%YAML 1.1\n---\njobs: {}', 'unsupported'],
  ['jobs: { a: { <<: { steps: [] } } }', 'unsupported'],
  ['jobs: { [a, b]: {} }', 'malformed'],
] as const)('rejects unsafe or malformed documents with fixed diagnostics: %s', (yaml, reason) => {
  expect(read(yaml)).toEqual({ kind: 'unavailable', reason });
});

test('keeps independent jobs after an unsupported semantic use without retaining its text', () => {
  const result = read(`jobs:
  good:
    steps:
      - uses: example/action@${'A'.repeat(40)}
      - uses: ./local
  bad:
    steps:
      - uses: docker://secret.example/image:latest
      - uses: 42
      - uses: example/action@
      - uses: example/action@\${{ secrets.TOKEN }}
`);
  expect(result.kind === 'parsed' && result.jobs.filter((j) => j.jobId === 'good')).toMatchObject([
    {
      jobId: 'good',
      steps: [
        { use: { ref: 'A'.repeat(40), refKind: 'sha' } },
        { use: { kind: 'local', path: './local' } },
      ],
    },
  ]);
  expect(result.kind === 'parsed' && result.gaps.length).toBe(4);
  expect(JSON.stringify(result)).not.toContain('secret.example');
  expect(JSON.stringify(result)).not.toContain('TOKEN');
});

test('enforces byte, node, nesting and occurrence limits with fatal UTF-8 decoding', () => {
  const bytes = new TextEncoder().encode(ordinary);
  expect(read(ordinary, { maxFileBytes: bytes.byteLength }).kind).toBe('parsed');
  expect(read(ordinary, { maxFileBytes: bytes.byteLength - 1 })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(read(ordinary, { maxYamlNodes: 1 })).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(read(ordinary, { maxYamlDepth: 2 })).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(read(ordinary, { maxOccurrences: 1 })).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(readWorkflow(new Uint8Array([0xff]), limits)).toEqual({
    kind: 'unavailable',
    reason: 'malformed',
  });
});
