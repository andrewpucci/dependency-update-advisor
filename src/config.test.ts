import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { loadTrustedReviewConfig, parseReviewConfig } from './config.js';

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

const checkoutFixtures: string[] = [];
async function checkout(text?: string | Uint8Array): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-config-test-'));
  checkoutFixtures.push(root);
  if (text !== undefined) {
    await fs.mkdir(join(root, '.github'));
    await fs.writeFile(join(root, '.github/dependabot-review.json'), text);
  }
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    checkoutFixtures.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('trusted configuration loading', () => {
  test('confirmed missing directory and file retain secure defaults', async () => {
    const root = await checkout();
    for (const createParent of [false, true]) {
      if (createParent) await fs.mkdir(join(root, '.github'));
      const result = await loadTrustedReviewConfig(root);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected missing defaults');
      expect(result.origin).toBe('missing');
      expect(result.config.analysis).toBeUndefined();
      expect(result.config.context).toEqual({
        sourceRoots: ['src'],
        sendSourceExcerptsToModel: false,
        excerptFiles: [],
      });
      expect(result.config.policy.verdicts).toEqual(defaults);
      expect(result.overrides).toEqual({});
    }
  });

  test('loads a present file and a contained file link', async () => {
    const root = await checkout('{"version":1}');
    expect(await loadTrustedReviewConfig(root)).toEqual(parseReviewConfig('{"version":1}'));
    await fs.rename(join(root, '.github/dependabot-review.json'), join(root, 'config.json'));
    await fs.symlink('../config.json', join(root, '.github/dependabot-review.json'));
    expect(await loadTrustedReviewConfig(root)).toEqual(parseReviewConfig('{"version":1}'));
  });

  test.each(['parent', 'file'])('rejects an escaping %s link', async (kind) => {
    const root = await checkout();
    const outside = await checkout('{"version":1}');
    if (kind === 'parent') {
      await fs.symlink(join(outside, '.github'), join(root, '.github'));
    } else {
      await fs.mkdir(join(root, '.github'));
      await fs.symlink(
        join(outside, '.github/dependabot-review.json'),
        join(root, '.github/dependabot-review.json'),
      );
    }
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'path' },
    });
  });

  test.each(['parent', 'file'])(
    'rejects a dangling %s link instead of defaulting',
    async (kind) => {
      const root = await checkout();
      if (kind === 'file') await fs.mkdir(join(root, '.github'));
      await fs.symlink(
        'absent',
        join(root, kind === 'parent' ? '.github' : '.github/dependabot-review.json'),
      );
      expect(await loadTrustedReviewConfig(root)).toMatchObject({
        ok: false,
        error: { category: 'path' },
      });
    },
  );

  test('rejects missing checkout, invalid parent and config directories', async () => {
    const root = await checkout();
    expect(await loadTrustedReviewConfig(join(root, 'absent'))).toMatchObject({
      ok: false,
      error: { category: 'read' },
    });
    await fs.writeFile(join(root, '.github'), 'synthetic');
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'path' },
    });
    await fs.unlink(join(root, '.github'));
    await fs.mkdir(join(root, '.github/dependabot-review.json'), { recursive: true });
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'path' },
    });
  });

  test('read denial fails without echoing the OS error', async () => {
    const root = await checkout('{"version":1}');
    vi.spyOn(fs, 'open').mockRejectedValue(
      Object.assign(new Error('synthetic-private-value'), { code: 'EACCES' }),
    );
    const result = await loadTrustedReviewConfig(root);
    expect(result).toEqual({
      ok: false,
      error: { file: '.github/dependabot-review.json', category: 'read', field: '$' },
    });
  });

  test('rejects malformed UTF-8 before parsing', async () => {
    const root = await checkout(Buffer.from([0x7b, 0x80, 0x7d]));
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'encoding' },
    });
  });

  test('accepts the exact byte limit and rejects overflow', async () => {
    const minimal = '{"version":1}';
    const root = await checkout(minimal.padEnd(16_384));
    expect(await loadTrustedReviewConfig(root)).toEqual(parseReviewConfig(minimal));
    await fs.appendFile(join(root, '.github/dependabot-review.json'), ' ');
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'size' },
    });
  });
});

describe('bounded descriptor lifecycle', () => {
  test('continues after short reads and closes the handle', async () => {
    const root = await checkout('{"version":1}');
    const handle = await fs.open(join(root, '.github/dependabot-review.json'), 'r');
    const read = handle.read.bind(handle);
    const spy = vi
      .spyOn(handle, 'read')
      .mockImplementation(async (options) =>
        read({ ...options, length: Math.min(options?.length ?? 0, 2) }),
      );
    const close = vi.spyOn(handle, 'close');
    vi.spyOn(fs, 'open').mockResolvedValue(handle);
    expect(await loadTrustedReviewConfig(root)).toEqual(parseReviewConfig('{"version":1}'));
    expect(spy.mock.calls.length).toBeGreaterThan(2);
    expect(close).toHaveBeenCalledOnce();
  });

  test.each(['read', 'stat', 'encoding', 'json', 'size'])(
    'closes the handle after %s failure',
    async (kind) => {
      const content =
        kind === 'size'
          ? Buffer.alloc(16_385, 32)
          : kind === 'encoding'
            ? Buffer.from([0x80])
            : Buffer.from('{');
      const root = await checkout(content);
      const handle = await fs.open(join(root, '.github/dependabot-review.json'), 'r');
      const close = vi.spyOn(handle, 'close');
      vi.spyOn(fs, 'open').mockResolvedValue(handle);
      if (kind === 'read')
        vi.spyOn(handle, 'read').mockRejectedValue(new Error('synthetic read error'));
      if (kind === 'stat')
        vi.spyOn(handle, 'stat').mockRejectedValue(new Error('synthetic stat error'));
      expect(await loadTrustedReviewConfig(root)).toMatchObject({
        ok: false,
        error: { category: kind === 'stat' ? 'read' : kind },
      });
      expect(close).toHaveBeenCalledOnce();
    },
  );
});

describe('adversarial document agreement', () => {
  const cases: { name: string; value: unknown; valid: boolean }[] = [];
  const add = (name: string, value: unknown, valid = false) => cases.push({ name, value, valid });
  for (const value of [false, 1, 'text', null, []]) add(`root ${JSON.stringify(value)}`, value);
  for (const section of ['analysis', 'context', 'policy']) {
    for (const value of [false, 1, 'text', null, []])
      add(`${section} ${JSON.stringify(value)}`, { version: 1, [section]: value });
  }
  for (const value of [false, 1, 'text', null, []])
    add(`verdicts ${JSON.stringify(value)}`, { version: 1, policy: { verdicts: value } });
  for (const key of ['constructor', '__proto__', 'prototype', 'synthetic-private-key']) {
    add(`unknown root ${key}`, JSON.parse(`{"version":1,"${key}":"synthetic-private-value"}`));
    add(`unknown analysis ${key}`, {
      version: 1,
      analysis: { provider: 'mistral', model: 'model', [key]: 'synthetic-private-value' },
    });
    add(`unknown context ${key}`, { version: 1, context: { [key]: 'synthetic-private-value' } });
    add(`unknown policy ${key}`, { version: 1, policy: { [key]: 'synthetic-private-value' } });
    add(`unknown rule ${key}`, {
      version: 1,
      policy: { verdicts: { [key]: 'synthetic-private-value' } },
    });
  }
  for (const model of [
    '',
    '_model',
    '-model',
    'model ',
    ' model',
    'model\n',
    'model\r',
    'a/b',
    'https://example.invalid',
    'é',
    'a'.repeat(129),
  ]) {
    add(`invalid model ${JSON.stringify(model)}`, {
      version: 1,
      analysis: { provider: 'mistral', model },
    });
  }
  for (const model of ['a', 'a'.repeat(128), '9-model.v1', 'mistral-medium-latest']) {
    add(
      `valid model ${model.length}`,
      { version: 1, analysis: { provider: 'mistral', model } },
      true,
    );
  }
  for (const analysis of [
    {},
    { model: 'model' },
    { provider: null, model: 'model' },
    { provider: 'MISTRAL', model: 'model' },
    { provider: 'mistral', model: 42 },
  ])
    add(`invalid analysis ${JSON.stringify(analysis)}`, { version: 1, analysis });
  const badPaths = [
    '',
    '.',
    '..',
    'src/../file',
    'src/./file',
    '/src',
    '//host/share',
    'C:/src',
    'C:src',
    '\\src',
    'src\\file',
    'src//file',
    'src/',
    '.hidden',
    'src/.hidden',
    'src/line\n',
    'src/nul\0',
    'src/\u001f',
    'src/\u007f',
    'src/\u009f',
  ];
  for (const path of badPaths) {
    for (const field of ['sourceRoots', 'excerptFiles'])
      add(`${field} invalid path ${JSON.stringify(path)}`, {
        version: 1,
        context: { [field]: [path] },
      });
  }
  for (const path of ['src/a.ts', 'lib/nested/file.ts', 'source/é.ts', 'src/a b.ts'])
    add(
      `exact path ${path}`,
      { version: 1, context: { sourceRoots: ['src'], excerptFiles: [path] } },
      true,
    );
  for (const path of ['src/*.ts', 'src/a?.ts', 'src/[ab].ts', 'src/{a,b}.ts'])
    add(`glob ${path}`, { version: 1, context: { excerptFiles: [path] } });
  for (const field of ['sourceRoots', 'excerptFiles']) {
    for (const value of [null, false, 'src', {}, [1], [null]])
      add(`${field} invalid type ${JSON.stringify(value)}`, {
        version: 1,
        context: { [field]: value },
      });
    const limit = field === 'sourceRoots' ? 16 : 128;
    add(
      `${field} exact count`,
      {
        version: 1,
        context: { [field]: Array.from({ length: limit }, (_, index) => `src/file-${index}.ts`) },
      },
      true,
    );
    add(`${field} count overflow`, {
      version: 1,
      context: { [field]: Array.from({ length: limit + 1 }, (_, index) => `src/file-${index}.ts`) },
    });
  }
  add(
    'duplicate roots remain literal roots',
    { version: 1, context: { sourceRoots: ['src', 'src'] } },
    true,
  );
  add(
    'private opt-in shape awaits C2 metadata validation',
    { version: 1, context: { sendSourceExcerptsToModel: true } },
    true,
  );
  add('empty verdict object', { version: 1, policy: { verdicts: {} } }, true);
  for (const rule of Object.keys(defaults)) {
    for (const verdict of ['merge', 'merge_with_followups', 'do_not_merge'])
      add(`${rule} ${verdict}`, { version: 1, policy: { verdicts: { [rule]: verdict } } }, true);
    for (const verdict of [null, false, 1, {}, []])
      add(`${rule} wrong type ${JSON.stringify(verdict)}`, {
        version: 1,
        policy: { verdicts: { [rule]: verdict } },
      });
  }
  for (const value of [null, false, 0, 1.1, '1', [], {}])
    add(`version ${JSON.stringify(value)}`, { version: value });

  test.each(cases)('$name', ({ value, valid }) => {
    const text = JSON.stringify(value);
    const result = parseReviewConfig(text);
    expect(result.ok).toBe(valid);
    expect(validateSchema(value)).toBe(valid);
    expect(JSON.stringify(value)).toBe(text);
    if (!valid) {
      expect(result).not.toHaveProperty('config');
      expect(JSON.stringify(result)).not.toContain('synthetic-private');
    }
  });

  test('each individual default annotation matches its runtime value', () => {
    for (const [rule, verdict] of Object.entries(defaults))
      expect(schema.properties.policy.properties.verdicts.properties[rule].default).toBe(verdict);
    for (const [field, value] of Object.entries(schema.properties.context.default))
      expect(schema.properties.context.properties[field].default).toEqual(value);
  });

  test('explicit overrides are separate from the effective policy', () => {
    const result = parseReviewConfig(
      '{"version":1,"policy":{"verdicts":{"incompleteEvidence":"merge"}}}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid config');
    expect(result.config.policy.verdicts).toEqual({ ...defaults, incompleteEvidence: 'merge' });
    result.overrides.incompleteEvidence = 'do_not_merge';
    expect(result.config.policy.verdicts.incompleteEvidence).toBe('merge');
  });

  test.each([
    [
      'analysis',
      {
        analysis: {
          provider: 'mistral',
          model: 'model',
          'synthetic-private-key': 'synthetic-private-value',
        },
      },
    ],
    ['context', { context: { 'synthetic-private-key': 'synthetic-private-value' } }],
    ['policy', { policy: { 'synthetic-private-key': 'synthetic-private-value' } }],
    [
      'policy.verdicts',
      { policy: { verdicts: { 'synthetic-private-key': 'synthetic-private-value' } } },
    ],
  ])('unknown keys identify only known parent %s', (field, section) => {
    expect(parseReviewConfig(JSON.stringify({ version: 1, ...section }))).toEqual({
      ok: false,
      error: { file: '.github/dependabot-review.json', category: 'validation', field },
    });
  });

  test('raw parser diagnostics cannot echo malformed sensitive-looking input', () => {
    expect(parseReviewConfig('{"synthetic-private-value')).toEqual({
      ok: false,
      error: { file: '.github/dependabot-review.json', category: 'json', field: '$' },
    });
  });

  test('multibyte UTF-8 size counts bytes rather than characters', async () => {
    const unicodeJson = '{"version":1,"context":{"sourceRoots":["é"]}}';
    const exact = unicodeJson.padEnd(16_384 - 1);
    expect(Buffer.byteLength(exact)).toBe(16_384);
    expect(parseReviewConfig(exact).ok).toBe(true);
    const root = await checkout(exact);
    expect((await loadTrustedReviewConfig(root)).ok).toBe(true);
    await fs.appendFile(join(root, '.github/dependabot-review.json'), ' ');
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'size' },
    });
    expect(parseReviewConfig(exact + ' ')).toMatchObject({
      ok: false,
      error: { category: 'size' },
    });
  });
});

describe('loader refusal and read budgets', () => {
  test('overflow reads consume only the detection byte and close', async () => {
    const root = await checkout(Buffer.alloc(30_000, 32));
    const handle = await fs.open(join(root, '.github/dependabot-review.json'), 'r');
    const read = vi.spyOn(handle, 'read');
    const close = vi.spyOn(handle, 'close');
    vi.spyOn(fs, 'open').mockResolvedValue(handle);
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'size' },
    });
    expect(read.mock.calls.reduce((total, [options]) => total + (options?.length ?? 0), 0)).toBe(
      16_385,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  test('rejects a nonregular descriptor without reading and closes it', async () => {
    const root = await checkout('{"version":1}');
    const handle = await fs.open(join(root, '.github/dependabot-review.json'), 'r');
    const stats = await handle.stat();
    vi.spyOn(stats, 'isFile').mockReturnValue(false);
    vi.spyOn(handle, 'stat').mockResolvedValue(stats);
    const read = vi.spyOn(handle, 'read');
    const close = vi.spyOn(handle, 'close');
    vi.spyOn(fs, 'open').mockResolvedValue(handle);
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'path' },
    });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test('close failure invalidates an otherwise successful result', async () => {
    const root = await checkout('{"version":1}');
    const handle = await fs.open(join(root, '.github/dependabot-review.json'), 'r');
    const close = handle.close.bind(handle);
    vi.spyOn(fs, 'open').mockResolvedValue(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      throw new Error('synthetic-private-close-error');
    });
    expect(await loadTrustedReviewConfig(root)).toEqual({
      ok: false,
      error: { file: '.github/dependabot-review.json', category: 'read', field: '$' },
    });
  });

  test('a symlink loop cannot become missing defaults', async () => {
    const root = await checkout();
    await fs.symlink('.github', join(root, '.github'));
    expect(await loadTrustedReviewConfig(root)).toMatchObject({
      ok: false,
      error: { category: 'path' },
    });
  });

  test('only the selected checkout supplies configuration', async () => {
    const trusted = await checkout('{"version":1}');
    const other = await checkout(
      '{"version":1,"analysis":{"provider":"mistral","model":"model"},"context":{"sendSourceExcerptsToModel":true}}',
    );
    expect((await loadTrustedReviewConfig(other)).ok).toBe(true);
    expect(await loadTrustedReviewConfig(trusted)).toEqual(parseReviewConfig('{"version":1}'));
  });
});
