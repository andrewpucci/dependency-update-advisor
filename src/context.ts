import fs from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ConfigResult } from './config.js';

const MAX_CONTEXT_DEPENDENCIES = 128;
const MAX_CONTEXT_ID_CODE_UNITS = 256;
const MAX_CONTEXT_PATH_BYTES = 1_024;
const MAX_SOURCE_CONTEXT_BYTES = 65_536;
const REASONS = [
  'no-match',
  'missing-source',
  'excluded-source',
  'suspicious-line',
  'unsupported-type',
  'out-of-scope',
  'inventory-limit',
  'candidate-limit',
  'file-byte-limit',
  'total-read-limit',
  'excerpt-limit',
  'fact-limit',
  'context-byte-limit',
] as const;

type ContextReason = (typeof REASONS)[number];
type ContextStatus = 'unavailable' | 'partial' | 'available';
type DependencyIdentity = { id: string; name: string };
type SourceFact = {
  kind: 'package-usage';
  path: string;
  excerpt: string;
  excerptTruncated: boolean;
};
type DependencyContext = DependencyIdentity & {
  status: ContextStatus;
  reasons: ContextReason[];
  facts: SourceFact[];
};
type SourceContextSuccess = {
  ok: true;
  status: ContextStatus | 'disabled';
  dependencies: DependencyContext[];
  reasons: ContextReason[];
};
type SourceContextFailure = {
  ok: false;
  error: {
    file: '.github/dependabot-review.json';
    category: 'config' | 'input' | 'path' | 'read' | 'budget';
    field: string;
  };
};
export type SourceContextResult = SourceContextSuccess | SourceContextFailure;
export type SourceContextInput = {
  config: ConfigResult;
  checkoutRoot: string;
  visibility: unknown;
  dependencies: readonly DependencyIdentity[];
  trackedFiles: AsyncIterable<string>;
};
type SourceContextValidation =
  | SourceContextFailure
  | { ok: true; state: 'disabled' }
  | {
      ok: true;
      state: 'ready' | 'unavailable';
      checkoutRoot: string;
      roots: string[];
      files: string[];
      dependencies: DependencyIdentity[];
      reasons: ContextReason[];
    };

function failure(
  category: SourceContextFailure['error']['category'],
  field = '$',
): SourceContextFailure {
  return { ok: false, error: { file: '.github/dependabot-review.json', category, field } };
}

function control(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159);
}

function canonicalPath(path: string, allowHidden = false): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= MAX_CONTEXT_PATH_BYTES &&
    Buffer.byteLength(path, 'utf8') <= MAX_CONTEXT_PATH_BYTES &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes('\\') &&
    !/[*?[\]{}]/u.test(path) &&
    !Array.from(path).some(control) &&
    path
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part !== '.' &&
          part !== '..' &&
          (allowHidden || !part.startsWith('.')),
      )
  );
}

function credentialPath(path: string): boolean {
  return path.split('/').some((part) => {
    const name = part.toLowerCase();
    const stem = name.split('.')[0].replace(/[-_]/g, '');
    return (
      [
        'secret',
        'secrets',
        'credential',
        'credentials',
        'privatekey',
        'privatekeys',
        'apikey',
        'apikeys',
        'idrsa',
        'iddsa',
        'idecdsa',
        'ided25519',
      ].includes(stem) ||
      /^\.env(?:\.|$)/.test(name) ||
      /\.(?:pem|key|p12|pfx)$/.test(name)
    );
  });
}

function within(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

async function checkPath(
  root: string,
  path: string,
  directory: boolean,
  field: string,
): Promise<SourceContextFailure | { ok: true; exists: boolean }> {
  if (!canonicalPath(path) || !within(root, join(root, path))) return failure('path', field);
  const parts = path.split('/');
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = join(target, part);
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return { ok: true, exists: false };
      return failure('read', field);
    }
    if (stat.isSymbolicLink()) return failure('path', field);
    const expectedDirectory = index < parts.length - 1 || directory;
    if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) return failure('path', field);
  }
  return { ok: true, exists: true };
}

function emptyContext(
  dependencies: readonly DependencyIdentity[],
  reasons: ContextReason[] = [],
): SourceContextSuccess {
  return {
    ok: true,
    status: 'unavailable',
    reasons: [...reasons],
    dependencies: dependencies.map((dependency) => ({
      ...dependency,
      status: 'unavailable',
      reasons: [...reasons],
      facts: [],
    })),
  };
}

function fitsContextBudget(result: SourceContextSuccess): boolean {
  // Reserve the widest final status/reason metadata before accepting source text.
  const reserved = {
    ...result,
    status: 'unavailable',
    reasons: REASONS,
    dependencies: result.dependencies.map((entry) => ({
      ...entry,
      status: 'unavailable',
      reasons: REASONS,
    })),
  };
  return Buffer.byteLength(JSON.stringify(reserved), 'utf8') <= MAX_SOURCE_CONTEXT_BYTES;
}

/** Caller owns checkout provenance and immutability; ready metadata is not model-ready context. */
export async function validateSourceContextInput(
  input: SourceContextInput,
): Promise<SourceContextValidation> {
  if (!input.config.ok) return failure('config');
  if (input.visibility !== 'public' && input.visibility !== 'private') return failure('input');
  const dependencies = input.dependencies;
  if (
    !Array.isArray(dependencies) ||
    dependencies.length > MAX_CONTEXT_DEPENDENCIES ||
    dependencies.some(({ id, name }) =>
      [id, name].some(
        (value) =>
          typeof value !== 'string' ||
          !value.length ||
          value.length > MAX_CONTEXT_ID_CODE_UNITS ||
          Array.from(value).some(control),
      ),
    ) ||
    new Set(dependencies.map(({ id }) => id)).size !== dependencies.length
  )
    return failure('input');
  const identities = dependencies.map(({ id, name }) => ({ id, name }));
  const context = input.config.config.context;
  const roots = [...context.sourceRoots];
  const files = [...context.excerptFiles];
  if (roots.some((path) => !canonicalPath(path) || credentialPath(path)))
    return failure('path', 'context.sourceRoots');
  if (files.some((path) => !canonicalPath(path))) return failure('path', 'context.excerptFiles');
  if (context.sendSourceExcerptsToModel && input.visibility === 'private' && !files.length)
    return failure('config', 'context.excerptFiles');
  let checkoutRoot: string;
  try {
    checkoutRoot = await fs.realpath(input.checkoutRoot);
    if (!(await fs.stat(checkoutRoot)).isDirectory()) return failure('path');
  } catch {
    return failure('read');
  }
  const existingRoots: string[] = [],
    existingFiles: string[] = [];
  const reasons: ContextReason[] = [];
  for (const [paths, directory, field, existing] of [
    [roots, true, 'context.sourceRoots', existingRoots],
    [files, false, 'context.excerptFiles', existingFiles],
  ] as const) {
    for (const path of paths) {
      const checked = await checkPath(checkoutRoot, path, directory, field);
      if (!checked.ok) return checked;
      if (checked.exists) existing.push(path);
      else if (!reasons.includes('missing-source')) reasons.push('missing-source');
    }
  }
  if (!context.sendSourceExcerptsToModel) return { ok: true, state: 'disabled' };
  if (!fitsContextBudget(emptyContext(identities))) return failure('budget');
  return {
    ok: true,
    state:
      existingRoots.length && existingFiles.length && identities.length ? 'ready' : 'unavailable',
    checkoutRoot,
    roots: existingRoots,
    files: existingFiles,
    dependencies: identities,
    reasons,
  };
}
