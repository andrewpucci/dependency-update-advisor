import { expect, test } from 'vite-plus/test';
import {
  collectorRoots,
  DEPENDABOT_ROOT_LIMITS,
  parseDependabotRoots,
} from './dependabot-roots.js';

const encode = (text: string) => new TextEncoder().encode(text);
const sentinel = 'SENTINEL-IGNORED-VALUE';

function update(ecosystem: string, directory: string | string[], extra = ''): string {
  const key = Array.isArray(directory)
    ? `    directories:\n${directory.map((item) => `      - "${item}"`).join('\n')}`
    : `    directory: "${directory}"`;
  return `  - package-ecosystem: "${ecosystem}"\n${key}\n${extra}`;
}

const file = (...updates: string[]) => `version: 2\nupdates:\n${updates.join('')}`;

test('returns sorted, deduplicated, canonical npm and uv roots from directory and directories', () => {
  const result = parseDependabotRoots(
    encode(
      file(
        update('npm', '/'),
        update('npm', ['/packages/b/', '/packages/a', '/packages/a']),
        update('uv', '/python/app'),
        update('uv', ['/']),
      ),
    ),
  );
  expect(result).toEqual({
    kind: 'roots',
    npm: { kind: 'roots', roots: ['.', 'packages/a', 'packages/b'] },
    uv: { kind: 'roots', roots: ['.', 'python/app'] },
  });
});

test('ignores github-actions, pip, and unknown ecosystems without failing the file', () => {
  const result = parseDependabotRoots(
    encode(
      file(
        update('github-actions', '/'),
        update('pip', '/py'),
        update('cargo', ['/x', '/y']),
        update('npm', '/web'),
      ),
    ),
  );
  expect(result).toEqual({
    kind: 'roots',
    npm: { kind: 'roots', roots: ['web'] },
    uv: { kind: 'roots', roots: [] },
  });
});

test('reads only ecosystem and directories, retaining no other value', () => {
  const extra = `    schedule:\n      interval: "${sentinel}"\n    labels: ["${sentinel}"]\n`;
  const result = parseDependabotRoots(
    encode(
      `version: 2\nregistries:\n  r:\n    token: ${sentinel}\n${'updates:\n'}${update('npm', '/a', extra)}`,
    ),
  );
  expect(result).toEqual({
    kind: 'roots',
    npm: { kind: 'roots', roots: ['a'] },
    uv: { kind: 'roots', roots: [] },
  });
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('reports a glob as unsupported for its ecosystem while the other ecosystem stays usable', () => {
  const result = parseDependabotRoots(
    encode(file(update('npm', ['/packages/*', '/app']), update('uv', '/py'))),
  );
  expect(result).toEqual({
    kind: 'roots',
    npm: { kind: 'unavailable', reason: 'unsupported' },
    uv: { kind: 'roots', roots: ['py'] },
  });
});

test.each(['/a?b', '/a[b]', '/a{b,c}'])(
  'treats the glob character in %s as unsupported',
  (path) => {
    expect(parseDependabotRoots(encode(file(update('uv', path))))).toMatchObject({
      kind: 'roots',
      uv: { kind: 'unavailable', reason: 'unsupported' },
    });
  },
);

test.each([
  ['a parent segment', '/a/../b'],
  ['a dot segment', '/a/./b'],
  ['an empty segment', '/a//b'],
  ['a backslash', '/a\\\\b'],
  ['an empty path', ''],
  ['a control character', '/a\\u0007b'],
  ['an over-long path', `/${'a'.repeat(1_025)}`],
])('reports %s as malformed for its ecosystem only', (_label, path) => {
  expect(parseDependabotRoots(encode(file(update('npm', path), update('uv', '/ok'))))).toEqual({
    kind: 'roots',
    npm: { kind: 'unavailable', reason: 'malformed' },
    uv: { kind: 'roots', roots: ['ok'] },
  });
});

test('reports a malformed path ahead of an unsupported glob in the same ecosystem', () => {
  expect(
    parseDependabotRoots(encode(file(update('npm', ['/packages/*', '/a/../b'])))),
  ).toMatchObject({ npm: { kind: 'unavailable', reason: 'malformed' } });
});

test.each([
  [
    'invalid UTF-8 inside an otherwise valid file',
    new Uint8Array([...encode(`${file(update('npm', '/'))}# `), 0xff, ...encode('\n')]),
  ],
  ['invalid YAML', encode('version: 2\nupdates: [')],
  ['a wrong version', encode(file(update('npm', '/')).replace('version: 2', 'version: 1'))],
  ['a missing version', encode(file(update('npm', '/')).replace('version: 2\n', ''))],
  ['a non-sequence updates', encode('version: 2\nupdates: {}\n')],
  ['a missing updates key', encode('version: 2\n')],
  ['a missing ecosystem', encode('version: 2\nupdates:\n  - directory: "/"\n')],
  [
    'a non-string ecosystem',
    encode('version: 2\nupdates:\n  - package-ecosystem: 5\n    directory: "/"\n'),
  ],
  [
    'an npm entry without a directory',
    encode('version: 2\nupdates:\n  - package-ecosystem: npm\n'),
  ],
  [
    'an entry with both directory and directories',
    encode(
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: "/"\n    directories: ["/a"]\n',
    ),
  ],
  [
    'a non-string directories item',
    encode('version: 2\nupdates:\n  - package-ecosystem: uv\n    directories: [1]\n'),
  ],
  ['a duplicate key', encode('version: 2\nversion: 2\nupdates: []\n')],
  ['multiple documents', encode('version: 2\nupdates: []\n---\nversion: 2\n')],
])('reports %s as malformed without echoing input', (_label, bytes) => {
  const result = parseDependabotRoots(bytes);
  expect(result).toEqual({ kind: 'unavailable', reason: 'malformed' });
});

test('does not fail an ignored ecosystem entry whose directory is mistyped', () => {
  const result = parseDependabotRoots(
    encode('version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: 5\n'),
  );
  expect(result).toMatchObject({ kind: 'roots' });
});

test.each([
  [
    'bytes',
    encode(`version: 2\nupdates: []\n#${'x'.repeat(DEPENDABOT_ROOT_LIMITS.maxFileBytes)}\n`),
  ],
  [
    'an alias',
    encode('version: 2\nx: &a ["/"]\nupdates:\n  - package-ecosystem: npm\n    directories: *a\n'),
  ],
  [
    'YAML nodes in an ignored key',
    encode(`${file(update('npm', '/'))}x: [${'1,'.repeat(20_001)}]\n`),
  ],
  [
    'YAML depth',
    encode(
      `version: 2\nupdates: ${'['.repeat(DEPENDABOT_ROOT_LIMITS.maxYamlDepth + 1)}${']'.repeat(DEPENDABOT_ROOT_LIMITS.maxYamlDepth + 1)}\n`,
    ),
  ],
  [
    'update entries',
    encode(
      file(
        ...Array.from({ length: DEPENDABOT_ROOT_LIMITS.maxUpdates + 1 }, () =>
          update('cargo', '/'),
        ),
      ),
    ),
  ],
])('reports exceeding the limit on %s as budget', (_label, bytes) => {
  expect(parseDependabotRoots(bytes)).toEqual({ kind: 'unavailable', reason: 'budget' });
});

test('limits the roots per ecosystem after deduplication', () => {
  const many = Array.from(
    { length: DEPENDABOT_ROOT_LIMITS.maxRoots + 1 },
    (_, index) => `/p${index}`,
  );
  expect(
    parseDependabotRoots(encode(file(update('npm', many), update('uv', ['/a', '/a'])))),
  ).toEqual({
    kind: 'roots',
    npm: { kind: 'unavailable', reason: 'budget' },
    uv: { kind: 'roots', roots: ['a'] },
  });
  expect(
    parseDependabotRoots(
      encode(file(update('npm', many.slice(0, DEPENDABOT_ROOT_LIMITS.maxRoots)))),
    ),
  ).toMatchObject({ npm: { kind: 'roots' } });
});

test('returns a deeply frozen result', () => {
  const result = parseDependabotRoots(encode(file(update('npm', '/a'))));
  if (result.kind !== 'roots' || result.npm.kind !== 'roots') throw new Error('fixture must parse');
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.npm)).toBe(true);
  expect(Object.isFrozen(result.npm.roots)).toBe(true);
});

test('exposes the parsing limits', () => {
  expect(DEPENDABOT_ROOT_LIMITS).toEqual({
    maxFileBytes: 65_536,
    maxYamlNodes: 20_000,
    maxYamlDepth: 16,
    maxAliasExpansions: 0,
    maxUpdates: 256,
    maxRoots: 256,
  });
});

const revision = { repository: { id: 1, owner: 'example', name: 'consumer' }, sha: 'a'.repeat(40) };

test('hands exact roots and the snapshot revision to a collector', () => {
  const outcome = {
    kind: 'roots',
    revision,
    npm: { kind: 'roots', roots: ['web'] },
    uv: { kind: 'roots', roots: ['.'] },
  } as const;
  expect(collectorRoots(outcome, 'npm')).toEqual({
    kind: 'roots',
    roots: ['web'],
    configRevision: revision,
  });
  expect(collectorRoots(outcome, 'uv')).toEqual({
    kind: 'roots',
    roots: ['.'],
    configRevision: revision,
  });
});

test('passes no configured roots when the file is absent or the ecosystem is unconfigured', () => {
  expect(collectorRoots({ kind: 'absent', revision }, 'npm')).toEqual({
    kind: 'roots',
    roots: [],
    configRevision: revision,
  });
  expect(
    collectorRoots(
      {
        kind: 'roots',
        revision,
        npm: { kind: 'roots', roots: [] },
        uv: { kind: 'roots', roots: [] },
      },
      'uv',
    ),
  ).toEqual({ kind: 'roots', roots: [], configRevision: revision });
});

test('reports unavailable coverage instead of an empty root list for a failed ecosystem or file', () => {
  expect(
    collectorRoots(
      {
        kind: 'roots',
        revision,
        npm: { kind: 'unavailable', reason: 'unsupported' },
        uv: { kind: 'roots', roots: ['py'] },
      },
      'npm',
    ),
  ).toEqual({ kind: 'unavailable', reason: 'unsupported' });
  expect(collectorRoots({ kind: 'unavailable', reason: 'rate_limit' }, 'uv')).toEqual({
    kind: 'unavailable',
    reason: 'rate_limit',
  });
});

test('accepts values exactly at each limit', () => {
  const longest = `/${'a'.repeat(1_024)}`;
  expect(parseDependabotRoots(encode(file(update('npm', longest))))).toMatchObject({
    npm: { kind: 'roots', roots: [longest.slice(1)] },
  });
  const entries = Array.from({ length: DEPENDABOT_ROOT_LIMITS.maxUpdates }, () =>
    update('cargo', '/'),
  );
  expect(parseDependabotRoots(encode(file(...entries)))).toMatchObject({ kind: 'roots' });
  const padding = `#${'x'.repeat(DEPENDABOT_ROOT_LIMITS.maxFileBytes - 'version: 2\nupdates: []\n#\n'.length)}\n`;
  const atLimit = encode(`version: 2\nupdates: []\n${padding}`);
  expect(atLimit.byteLength).toBe(DEPENDABOT_ROOT_LIMITS.maxFileBytes);
  expect(parseDependabotRoots(atLimit)).toMatchObject({ kind: 'roots' });
  expect(parseDependabotRoots(new Uint8Array([...atLimit, 10]))).toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});

test('puts no ignored value in a failure result', () => {
  for (const bytes of [
    encode(`version: 1\nsecret: ${sentinel}\nupdates: []\n`),
    encode(`${file(update('npm', '/a/../b', `    token: ${sentinel}\n`))}`),
    encode(`version: 2\nsecret: ${sentinel}\nupdates: {`),
  ])
    expect(JSON.stringify(parseDependabotRoots(bytes))).not.toContain(sentinel);
});

test('does not charge comments or blank lines against the node cap', () => {
  const comments = '#\n'.repeat(30_000);
  expect(comments.length).toBeLessThan(DEPENDABOT_ROOT_LIMITS.maxFileBytes);
  expect(parseDependabotRoots(encode(`${file(update('npm', '/'))}${comments}`))).toMatchObject({
    kind: 'roots',
    npm: { kind: 'roots', roots: ['.'] },
  });
});

test('reports an unsupported tag as unsupported, not malformed', () => {
  expect(parseDependabotRoots(encode(`${file(update('npm', '/'))}x: !custom 1\n`))).toEqual({
    kind: 'unavailable',
    reason: 'unsupported',
  });
});
