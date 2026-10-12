import fs from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ConfigResult, ReviewConfig } from './config.js';

const MAX_CONTEXT_DEPENDENCIES = 128;
const MAX_CONTEXT_ID_CODE_UNITS = 256;
const MAX_CONTEXT_PATH_BYTES = 1_024;
const MAX_SOURCE_ROOTS = 16;
const MAX_SOURCE_CONTEXT_BYTES = 65_536;
const MAX_TRACKED_PATH_ENTRIES = 10_000;
const MAX_SOURCE_CANDIDATES = 128;
const MAX_SOURCE_FILE_BYTES = 65_536;
const MAX_TOTAL_SOURCE_READ_BYTES = 1_048_576;
const MAX_SOURCE_EXCERPT_CODE_UNITS = 500;
const MAX_SOURCE_FACTS_PER_DEPENDENCY = 20;
const GENERATED_MARKER_SCAN_LINES = 20;
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

function canonicalPath(path: string, allowHidden = false, allowGlob = false): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= MAX_CONTEXT_PATH_BYTES &&
    Buffer.byteLength(path, 'utf8') <= MAX_CONTEXT_PATH_BYTES &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes('\\') &&
    (allowGlob || !/[*?[\]{}]/u.test(path)) &&
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

function validDependencies(dependencies: readonly DependencyIdentity[]): boolean {
  if (
    !Array.isArray(dependencies) ||
    dependencies.length > MAX_CONTEXT_DEPENDENCIES ||
    Array.from(dependencies).some(
      (dependency) =>
        !dependency ||
        typeof dependency !== 'object' ||
        [dependency.id, dependency.name].some(
          (value) =>
            typeof value !== 'string' ||
            !value.length ||
            value.length > MAX_CONTEXT_ID_CODE_UNITS ||
            Array.from(value).some(control),
        ),
    ) ||
    new Set(dependencies.map(({ id }) => id)).size !== dependencies.length
  )
    return false;
  return true;
}

function validateContextConfig(
  context: ReviewConfig['context'],
  visibility: unknown,
): SourceContextFailure | { ok: true; roots: string[]; files: string[] } {
  if (!Array.isArray(context.sourceRoots) || context.sourceRoots.length > MAX_SOURCE_ROOTS)
    return failure('config', 'context.sourceRoots');
  if (
    !Array.isArray(context.excerptFiles) ||
    context.excerptFiles.length > MAX_SOURCE_CANDIDATES ||
    new Set(context.excerptFiles).size !== context.excerptFiles.length
  )
    return failure('config', 'context.excerptFiles');
  if (typeof context.sendSourceExcerptsToModel !== 'boolean')
    return failure('config', 'context.sendSourceExcerptsToModel');
  const roots = [...context.sourceRoots];
  const files = [...context.excerptFiles];
  if (roots.some((path) => !canonicalPath(path) || credentialPath(path)))
    return failure('path', 'context.sourceRoots');
  if (files.some((path) => !canonicalPath(path))) return failure('path', 'context.excerptFiles');
  if (context.sendSourceExcerptsToModel && visibility === 'private' && !files.length)
    return failure('config', 'context.excerptFiles');
  return { ok: true, roots, files };
}

async function checkConfiguredPaths(
  checkoutRoot: string,
  roots: string[],
  files: string[],
): Promise<
  | SourceContextFailure
  | { ok: true; existingRoots: string[]; existingFiles: string[]; reasons: ContextReason[] }
> {
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
  return { ok: true, existingRoots, existingFiles, reasons };
}

/** Caller owns checkout provenance and immutability; ready metadata is not model-ready context. */
export async function validateSourceContextInput(
  input: SourceContextInput,
): Promise<SourceContextValidation> {
  if (!input.config.ok) return failure('config');
  if (input.visibility !== 'public' && input.visibility !== 'private') return failure('input');
  const dependencies = input.dependencies;
  if (!validDependencies(dependencies)) return failure('input');
  const identities = dependencies.map(({ id, name }) => ({ id, name }));
  const context = input.config.config.context;
  const validatedConfig = validateContextConfig(context, input.visibility);
  if (!validatedConfig.ok) return validatedConfig;
  const { roots, files } = validatedConfig;
  let checkoutRoot: string;
  try {
    checkoutRoot = await fs.realpath(input.checkoutRoot);
    if (!(await fs.stat(checkoutRoot)).isDirectory()) return failure('path');
  } catch {
    return failure('read');
  }
  // Missing-file defaults configure no boundary, so only an existing file's paths are checked.
  if (input.config.origin === 'missing') return { ok: true, state: 'disabled' };
  const checked = await checkConfiguredPaths(checkoutRoot, roots, files);
  if (!checked.ok) return checked;
  const { existingRoots, existingFiles, reasons } = checked;
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

function pathExclusion(path: string): ContextReason | undefined {
  const parts = path.toLowerCase().split('/');
  const filename = parts.at(-1)!;
  const excluded = [
    'test',
    'tests',
    'spec',
    'specs',
    '__tests__',
    'fixture',
    'fixtures',
    '__fixtures__',
    'mock',
    'mocks',
    '__mocks__',
    'snapshot',
    'snapshots',
    '__snapshots__',
    'e2e',
    'integration',
    'node_modules',
    'vendor',
    'vendors',
    'dist',
    'build',
    'out',
    'coverage',
    'generated',
    '__generated__',
    'config',
    'configs',
    'configuration',
    'settings',
    'public',
    'static',
    'assets',
    'media',
    'upload',
    'uploads',
    'content',
    'user-content',
    'userdata',
    'user-data',
    'data',
  ];
  if (
    credentialPath(path) ||
    parts.some((part) => part.startsWith('.') || excluded.includes(part)) ||
    /(^|[._-])(?:test|spec|fixture|mock|snapshot|generated|gen|min|config|configuration|settings)(?=$|[._-])/.test(
      filename,
    ) ||
    /\.d\.(?:ts|mts|cts|tsx)$/.test(filename) ||
    /^(?:tsconfig|jsconfig|eslint|prettier)\./.test(filename)
  )
    return 'excluded-source';
  if (!/\.(?:[cm]?[jt]sx?|svelte)$/.test(path)) return 'unsupported-type';
  return undefined;
}

function sensitiveAssignments(line: string): string[] {
  const fields = [
    'password',
    'passwd',
    'pwd',
    'secret',
    'secrets',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'apikey',
    'clientsecret',
    'credential',
    'credentials',
    'authorization',
    'privatekey',
    'sessionkey',
    'signingkey',
    'cookie',
    'connectionstring',
    'dsn',
    'accesskey',
    'secretkey',
    'email',
    'phone',
    'address',
  ];
  return Array.from(line.matchAll(/\b([A-Za-z][A-Za-z0-9_-]{0,255})["']?\s*[:=]\s*/g))
    .filter((match) => {
      const words = match[1]
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_-]+/)
        .map((word) => word.toLowerCase());
      // A compound name ends in its head noun: NPM_TOKEN and db_password qualify,
      // while tokenizer and maxTokens do not.
      return words.some((_, start) => fields.includes(words.slice(start).join('')));
    })
    .map((match) => line.slice(match.index + match[0].length));
}

function packageNamePattern(name: string): RegExp {
  // Reject longer names (react-dom, preact, @scope/react, ./react, lodash.merge) but keep
  // subpath imports such as react/jsx-runtime.
  return new RegExp(
    `(?<![A-Za-z0-9_$@/.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$-]|\\.[A-Za-z0-9_$-])`,
  );
}

function suspiciousLine(line: string): boolean {
  return (
    sensitiveAssignments(line).length > 0 ||
    Array.from(line).some((character) => character !== '\t' && control(character)) ||
    /\b(?:Bearer|Basic)\s+\S+/i.test(line) ||
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{16,})/.test(
      line,
    ) ||
    /:\/\/[^\s/"']+@/.test(line) ||
    /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/.test(line) ||
    /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/i.test(line)
  );
}

function blockedFile(lines: string[]): ContextReason | undefined {
  if (
    lines
      .slice(0, GENERATED_MARKER_SCAN_LINES)
      .some((line) => /@generated|auto-generated|autogenerated|generated file/i.test(line))
  )
    return 'excluded-source';
  if (
    lines.some(
      (line) =>
        /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(line) ||
        sensitiveAssignments(line).some(
          (value) =>
            (!value && line.trimEnd().endsWith('=')) ||
            ['{', '[', '`'].includes(value[0]) ||
            ((value.startsWith('"') || value.startsWith("'")) &&
              !new RegExp(`(?<!\\\\)${value[0]}`).test(value.slice(1))),
        ),
    )
  )
    return 'suspicious-line';
  return undefined;
}

async function readSource(
  root: string,
  path: string,
  remaining: number,
): Promise<
  | SourceContextFailure
  | {
      ok: true;
      bytes: number;
      text: string;
    }
  | { ok: true; bytes: number; reason: ContextReason }
> {
  if (remaining === 0) return { ok: true, bytes: 0, reason: 'total-read-limit' };
  const checked = await checkPath(root, path, false, 'context.excerptFiles');
  if (!checked.ok) return checked;
  if (!checked.exists) return { ok: true, bytes: 0, reason: 'missing-source' };
  try {
    const handle = await fs.open(join(root, path), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return failure('path', 'context.excerptFiles');
      const bytes = Buffer.alloc(Math.min(MAX_SOURCE_FILE_BYTES + 1, remaining));
      let count = 0;
      while (count < bytes.length && count < stat.size) {
        const { bytesRead } = await handle.read({
          buffer: bytes,
          offset: count,
          length: bytes.length - count,
          position: null,
        });
        if (!bytesRead) return failure('read', 'context.excerptFiles');
        count += bytesRead;
      }
      if (count > MAX_SOURCE_FILE_BYTES)
        return { ok: true, bytes: count, reason: 'file-byte-limit' };
      if (count < stat.size) return { ok: true, bytes: count, reason: 'total-read-limit' };
      if (count !== stat.size) return failure('read', 'context.excerptFiles');
      return {
        ok: true,
        bytes: count,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return failure('read', 'context.excerptFiles');
  }
}

function addReason(result: SourceContextSuccess, reason: ContextReason, entry?: DependencyContext) {
  if (!result.reasons.includes(reason)) result.reasons.push(reason);
  for (const target of entry ? [entry] : result.dependencies) {
    if (!target.reasons.includes(reason)) target.reasons.push(reason);
  }
}

function finishContext(result: SourceContextSuccess): SourceContextSuccess {
  for (const entry of result.dependencies) {
    if (entry.reasons.length) entry.status = 'partial';
    else if (entry.facts.length) entry.status = 'available';
    else {
      entry.status = 'unavailable';
      entry.reasons.push('no-match');
    }
  }
  result.status =
    result.dependencies.some((entry) => entry.status === 'partial') ||
    (result.dependencies.some((entry) => entry.status === 'available') &&
      result.dependencies.some((entry) => entry.status === 'unavailable'))
      ? 'partial'
      : result.dependencies.some((entry) => entry.facts.length)
        ? 'available'
        : 'unavailable';
  return result;
}

function selectSourceFiles(
  files: string[],
  roots: string[],
  result: SourceContextSuccess,
): Set<string> {
  const selected = new Set<string>();
  for (const path of files) {
    if (!roots.some((root) => path.startsWith(`${root}/`))) {
      addReason(result, 'out-of-scope');
      continue;
    }
    const exclusion = pathExclusion(path);
    if (exclusion) addReason(result, exclusion);
    else selected.add(path);
  }
  return selected;
}

async function trackedCandidates(
  trackedFiles: AsyncIterable<string>,
  selected: Set<string>,
  result: SourceContextSuccess,
): Promise<SourceContextFailure | { ok: true; paths: string[] }> {
  const candidates = new Set<string>();
  if (!selected.size) return { ok: true, paths: [] };
  let entries = 0;
  try {
    for await (const path of trackedFiles) {
      if (++entries > MAX_TRACKED_PATH_ENTRIES) {
        addReason(result, 'inventory-limit');
        break;
      }
      // Framework routes such as `app/[id]/page.tsx` are valid tracked paths that can
      // never equal a configured literal path, so they are skipped rather than fatal.
      if (!canonicalPath(path, true, true)) return failure('path');
      if (!selected.has(path) || candidates.has(path)) continue;
      if (candidates.size >= MAX_SOURCE_CANDIDATES) {
        addReason(result, 'candidate-limit');
        break;
      }
      candidates.add(path);
      if (candidates.size === selected.size) break;
    }
  } catch {
    return failure('read');
  }
  if (candidates.size < selected.size) addReason(result, 'missing-source');
  return { ok: true, paths: [...candidates].sort() };
}

function sourceExcerpt(trimmed: string): string {
  let excerpt = trimmed.slice(0, MAX_SOURCE_EXCERPT_CODE_UNITS);
  const last = excerpt.charCodeAt(excerpt.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) excerpt = excerpt.slice(0, -1);
  return excerpt;
}

function findSourceFact(
  path: string,
  lines: string[],
  entry: DependencyContext,
  result: SourceContextSuccess,
): SourceFact | undefined {
  const name = packageNamePattern(entry.name);
  for (const line of lines) {
    if (!line.includes(entry.name) || !name.test(line)) continue;
    if (suspiciousLine(line)) {
      addReason(result, 'suspicious-line', entry);
      continue;
    }
    const trimmed = line.trimStart();
    const excerpt = sourceExcerpt(trimmed);
    // Judge the name against the whole line so a cut inside a longer name cannot pass.
    const found = name.exec(trimmed);
    if (!found || found.index + entry.name.length > excerpt.length) {
      addReason(result, 'excerpt-limit', entry);
      continue;
    }
    if (entry.facts.length >= MAX_SOURCE_FACTS_PER_DEPENDENCY) {
      addReason(result, 'fact-limit', entry);
      break;
    }
    return {
      kind: 'package-usage',
      path,
      excerpt,
      excerptTruncated: excerpt.length < trimmed.length,
    };
  }
  return undefined;
}

// False stops collection immediately when the serialized context budget is exhausted.
function collectFileFacts(path: string, lines: string[], result: SourceContextSuccess): boolean {
  for (const entry of result.dependencies) {
    const fact = findSourceFact(path, lines, entry, result);
    if (!fact) continue;
    entry.facts.push(fact);
    if (!fitsContextBudget(result)) {
      entry.facts.pop();
      addReason(result, 'context-byte-limit');
      return false;
    }
    if (fact.excerptTruncated) addReason(result, 'excerpt-limit', entry);
  }
  return true;
}

/** Returns only validated source facts. The caller owns trusted revision/inventory provenance. */
export async function collectSourceContext(
  input: SourceContextInput,
): Promise<SourceContextResult> {
  const validated = await validateSourceContextInput(input);
  if (!validated.ok) return validated;
  if (validated.state === 'disabled')
    return { ok: true, status: 'disabled', dependencies: [], reasons: [] };
  const result = emptyContext(validated.dependencies, validated.reasons);
  if (validated.state === 'unavailable') return result;
  const selected = selectSourceFiles(validated.files, validated.roots, result);
  const candidates = await trackedCandidates(input.trackedFiles, selected, result);
  if (!candidates.ok) return candidates;
  let bytesRead = 0;
  for (const path of candidates.paths) {
    const source = await readSource(
      validated.checkoutRoot,
      path,
      MAX_TOTAL_SOURCE_READ_BYTES - bytesRead,
    );
    if (!source.ok) return source;
    bytesRead += source.bytes;
    if ('reason' in source) {
      addReason(result, source.reason);
      if (source.reason === 'total-read-limit') break;
      continue;
    }
    const lines = source.text.split(/\r\n|[\n\r\u2028\u2029]/u);
    const fileRejection = blockedFile(lines);
    if (fileRejection) {
      addReason(result, fileRejection);
      continue;
    }
    if (!collectFileFacts(path, lines, result)) return finishContext(result);
  }
  return finishContext(result);
}
