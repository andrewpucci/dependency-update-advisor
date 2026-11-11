import { expect, test } from 'vite-plus/test';
import { Parser } from 'yaml';
import { preflight, readWorkflow, type YamlLimits } from './actions-yaml.js';

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

test('counts cumulative nodes and UTF-8 bytes at exact boundaries and bounds deeply nested flow input before composition', () => {
  const bytes = new TextEncoder().encode(ordinary),
    budget = { nodes: 0, aliases: 0, occurrences: 0 };
  expect(readWorkflow(bytes, limits, budget).kind).toBe('parsed');
  const nodes = budget.nodes;
  expect(readWorkflow(bytes, { ...limits, maxYamlNodes: nodes }).kind).toBe('parsed');
  expect(readWorkflow(bytes, { ...limits, maxYamlNodes: nodes - 1 })).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  expect(readWorkflow(bytes, { ...limits, maxYamlNodes: nodes }, budget)).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
  const text = 'jobs: { build: { steps: [{ uses: example/action@réf }] } }';
  const size = Buffer.byteLength(text);
  expect(read(text, { maxFileBytes: size, maxYamlDepth: 5 }).kind).toBe('parsed');
  expect(read(text, { maxFileBytes: size - 1 })).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(read(text, { maxYamlDepth: 4 })).toEqual({ kind: 'unavailable', reason: 'budget' });
  expect(
    read(`extra: ${'['.repeat(4000)}0${']'.repeat(4000)}\njobs: {}`, { maxYamlDepth: 5 }),
  ).toEqual({ kind: 'unavailable', reason: 'budget' });
});

test('expanded scalar alias entries consume node budget before the graph can amplify', () => {
  const yaml = `extras: &list [${Array(100).fill('value').join(',')}]\ncopies: [${Array(100).fill('*list').join(',')}]\njobs: {}`;
  expect(read(yaml, { maxYamlNodes: 1500 })).toEqual({ kind: 'unavailable', reason: 'budget' });
});

function newBudget() {
  return { nodes: 0, aliases: 0, occurrences: 0 };
}
function preflightNodes(yaml: string) {
  const budget = newBudget();
  for (const token of new Parser().parse(yaml)) preflight(token, limits, budget);
  return budget.nodes;
}
function readNodes(yaml: string, budget = newBudget()) {
  const result = read(yaml, { maxYamlNodes: 100_000 });
  readWorkflow(new TextEncoder().encode(yaml), limits, budget);
  return { result, nodes: budget.nodes };
}

const commented = `# leading comment

on: [push] # trailing comment
jobs:
  # comment between keys

  build:${' '.repeat(3)}
    steps:
      # comment before an item
      - run: echo uses:example/ignored@v1
      - id: setup
        uses: example/action/subpath@v2 # v9 is not the ref
    # dedented trailing comment inside a nested collection
  reuse:
    uses: example/repo/.github/workflows/build.yml@main

# trailing comment
`;

test('comments, blank lines and trailing spaces do not change the node count', () => {
  const plain = readNodes(ordinary);
  const withComments = readNodes(commented);
  expect(withComments.result).toEqual(plain.result);
  expect(withComments.nodes).toBe(plain.nodes);
  expect(preflightNodes(commented)).toBe(preflightNodes(ordinary));
});

test('the node boundary is the same with and without comments', () => {
  const nodes = readNodes(ordinary).nodes;
  for (const yaml of [ordinary, commented]) {
    expect(read(yaml, { maxYamlNodes: nodes }).kind).toBe('parsed');
    expect(read(yaml, { maxYamlNodes: nodes - 1 })).toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
  }
});

test('a second read through one budget does not depend on the first read’s comments', () => {
  const nodes = readNodes(ordinary).nodes;
  const encode = (yaml: string) => new TextEncoder().encode(yaml);
  for (const first of [ordinary, commented]) {
    const budget = newBudget();
    const tight = { ...limits, maxYamlNodes: nodes * 2 };
    expect(readWorkflow(encode(first), tight, budget).kind).toBe('parsed');
    expect(readWorkflow(encode(ordinary), tight, budget).kind).toBe('parsed');
    expect(readWorkflow(encode(ordinary), tight, budget)).toEqual({
      kind: 'unavailable',
      reason: 'budget',
    });
  }
});

test('pins the structural count for a minimal workflow at both levels', () => {
  expect(preflightNodes('jobs: {}')).toBe(3);
  expect(readNodes('jobs: {}').nodes).toBe(5);
});

test('charges each structural token kind once and nothing else', () => {
  const kinds = `a: plain # comment
b: 'single'
c: "double"
d: |
  block
e: &anchor [x]
f: *anchor
`;
  // block-map + 6 keys + plain, single, double, block scalars + flow-collection + x + alias
  expect(preflightNodes(kinds)).toBe(1 + 6 + 4 + 1 + 1 + 1);
  expect(preflightNodes(`${kinds}\n\n# trailing\n`)).toBe(preflightNodes(kinds));
});
