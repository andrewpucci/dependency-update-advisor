import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { parseReviewBinding, type ReviewBinding } from '../event.js';
import type { GithubReadSession } from '../github-read.js';
import type {
  EvidenceReason,
  InventoryCoverage,
  PacketChange,
  PacketSource,
  PacketRevision,
  NpmSide,
} from '../schema.js';

type ResolvedChange = Exclude<
  Extract<PacketChange, { ecosystem: 'npm' }>,
  { basis: 'declaration' }
>;
type Limits = Readonly<{
  maxFileBytes: number;
  maxJsonEntries: number;
  maxJsonDepth: number;
  maxRoots: number;
  maxRetainedBytes: number;
}>;
type Input = {
  binding: ReviewBinding;
  roots: string[];
  configRevision: PacketRevision;
  limits: Limits;
};
export type NpmGap = Readonly<{
  root: string;
  side: 'base' | 'head' | null;
  path: string | null;
  reason: EvidenceReason;
}>;
export type NpmNode = Readonly<{ instance: NpmSide; dependencies: Record<string, string> }>;
export type NpmRootSide = Readonly<{
  state: 'present' | 'absent' | 'unavailable';
  manifestId: string | null;
  lockId: string | null;
  packages: Record<string, NpmNode>;
  unresolvedPaths: readonly string[];
  declarations: Record<string, Record<string, string>> | null;
}>;
export type NpmRoot = Readonly<{ root: string; base: NpmRootSide; head: NpmRootSide }>;
export type NpmInventoryResult =
  | { readonly kind: 'invalid' | 'obsolete' }
  | { readonly kind: 'unavailable'; readonly reason: EvidenceReason }
  | {
      readonly kind: 'inventory';
      readonly binding: ReviewBinding;
      readonly changes: readonly PacketChange[];
      readonly sources: readonly PacketSource[];
      readonly roots: readonly NpmRoot[];
      readonly gaps: readonly NpmGap[];
      readonly coverage: Readonly<InventoryCoverage>;
    };
type State = {
  input: Input;
  session: GithubReadSession;
  gaps: NpmGap[];
  sources: PacketSource[];
  changes: PacketChange[];
  roots: NpmRoot[];
  entries: number;
};
const sections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const roles = ['production', 'development', 'peer', 'optional'] as const;
class InventoryError extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
function need(condition: unknown, reason: EvidenceReason = 'malformed'): asserts condition {
  if (!condition) throw new InventoryError(reason);
}
function object(value: unknown): Record<string, unknown> {
  need(
    value &&
      typeof value === 'object' &&
      !types.isProxy(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  need(
    Reflect.ownKeys(descriptors).every(
      (k) =>
        typeof k === 'string' &&
        !['__proto__', 'constructor', 'prototype'].includes(k) &&
        'value' in descriptors[k],
    ),
  );
  return value as Record<string, unknown>;
}
function characters(value: string) {
  return [...value].every((c) => {
    const n = c.codePointAt(0)!;
    return n >= 32 && (n < 127 || n > 159) && !(n >= 0xd800 && n <= 0xdfff);
  });
}
function path(value: unknown, root = false): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 1024 &&
    ((root && value === '.') ||
      (value.length > 0 &&
        !/[\\:]/u.test(value) &&
        characters(value) &&
        value.split('/').every((p) => p && p !== '.' && p !== '..')))
  );
}
function safeText(value: unknown, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    Buffer.byteLength(value) <= 1024 &&
    characters(value) &&
    !/\/\/[^/\s]*@|[?&](?:token|key|password|secret|auth)=/iu.test(value)
  );
}
function inspect(value: unknown, limits: Limits, depth = 0, counter = { entries: 0 }) {
  if (!value || typeof value !== 'object') return;
  need(depth <= limits.maxJsonDepth, 'budget');
  need(!types.isProxy(value));
  const array = Array.isArray(value);
  if (!array) object(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter((k) => k !== 'length' || !array);
  counter.entries += keys.length;
  need(counter.entries <= limits.maxJsonEntries, 'budget');
  if (array) need(keys.length === value.length);
  for (const key of keys) {
    const d = descriptors[key as string];
    need(typeof key === 'string' && 'value' in d);
    inspect(d.value, limits, depth + 1, counter);
  }
}
function input(value: unknown): Input {
  const r = object(value),
    limits = object(r.limits);
  const keys = [
    'maxFileBytes',
    'maxJsonEntries',
    'maxJsonDepth',
    'maxRoots',
    'maxRetainedBytes',
  ] as const;
  need(keys.every((k) => Number.isSafeInteger(limits[k]) && (limits[k] as number) > 0));
  inspect(value, limits as unknown as Limits);
  const binding = parseReviewBinding(r.binding);
  need(binding);
  const config = object(r.configRevision),
    repository = object(config.repository);
  need(
    isDeepStrictEqual(repository, binding.repository) &&
      typeof config.sha === 'string' &&
      /^[a-f\d]{40}$/iu.test(config.sha),
  );
  need(
    Array.isArray(r.roots) &&
      !types.isProxy(r.roots) &&
      r.roots.length <= (limits.maxRoots as number),
  );
  const roots = r.roots.map((v) => {
    need(path(v, true));
    return v;
  });
  need(new Set(roots).size === roots.length);
  return {
    binding,
    configRevision: { repository: binding.repository, sha: config.sha.toLowerCase() },
    roots: roots.sort(),
    limits: Object.fromEntries(keys.map((k) => [k, limits[k]])) as Limits,
  };
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function gap(
  state: State,
  root: string,
  side: NpmGap['side'],
  file: string | null,
  reason: EvidenceReason,
) {
  const item = { root, side, path: file, reason };
  if (!state.gaps.some((g) => isDeepStrictEqual(g, item))) state.gaps.push(item);
}
function json(bytes: Uint8Array, state: State): Record<string, unknown> {
  need(bytes.byteLength <= state.input.limits.maxFileBytes, 'budget');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let quoted = false,
    escaped = false,
    depth = 0;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') {
      depth++;
      need(depth <= state.input.limits.maxJsonDepth, 'budget');
    } else if (c === '}' || c === ']') depth--;
  }
  const parsed: unknown = JSON.parse(text);
  const count = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const entries = Object.entries(v);
    state.entries += entries.length;
    need(state.entries <= state.input.limits.maxJsonEntries, 'budget');
    for (const [key, child] of entries) {
      need(!['__proto__', 'constructor', 'prototype'].includes(key));
      count(child);
    }
  };
  count(parsed);
  return object(parsed);
}
function stringMap(value: unknown): Record<string, string> {
  const r = object(value),
    result: Record<string, string> = {};
  for (const [k, v] of Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    need(safeText(k) && k.length <= 256 && safeText(v, true));
    result[k] = v;
  }
  return result;
}
function declarations(value: Record<string, unknown>) {
  const result: Record<string, Record<string, string>> = {};
  for (const section of sections) {
    if (value[section] === undefined) continue;
    for (const [name, specifier] of Object.entries(stringMap(value[section])))
      (result[name] ??= {})[section] = specifier;
  }
  return result;
}
function reason(error: unknown): EvidenceReason {
  return error instanceof InventoryError ? error.reason : 'malformed';
}
function fileId(state: State, side: 'base' | 'head', file: string) {
  return (
    'npm:file:' +
    hash([
      state.input.binding.repository.id,
      side,
      side === 'base' ? state.input.binding.baseSha : state.input.binding.headSha,
      file,
    ])
  );
}
async function read(state: State, root: string, side: 'base' | 'head', file: string) {
  const id = fileId(state, side, file);
  try {
    const result = await state.session.readFile({ side, path: file });
    need(result.kind !== 'invalid', 'conflict');
    const b = state.input.binding,
      repository = side === 'base' ? b.repository : b.headRepository;
    need(
      result.side === side &&
        result.path === file &&
        result.commitSha === (side === 'base' ? b.baseSha : b.headSha) &&
        isDeepStrictEqual(result.repository, repository),
      'conflict',
    );
    if (result.kind === 'absent') return { kind: 'absent' as const, id, data: null };
    need(result.kind === 'available', result.kind === 'unavailable' ? result.reason : 'unknown');
    const data = json(result.bytes, state);
    state.sources.push({
      id,
      kind: 'file',
      ecosystems: ['npm'],
      memberIds: [],
      status: 'available',
      reasons: [],
      provenance: { kind: 'file', revision: side, repository, sha: result.commitSha, path: file },
    });
    return { kind: 'present' as const, id, data };
  } catch (error) {
    const why = reason(error);
    gap(state, root, side, file, why);
    state.sources.push({
      id,
      kind: 'file',
      ecosystems: ['npm'],
      memberIds: [],
      status: 'unavailable',
      reasons: [why],
      provenance: { kind: 'unavailable' },
    });
    return { kind: 'unavailable' as const, id, data: null };
  }
}
function packageNode(root: string, lockPath: string, value: unknown, sourceId: string): NpmNode {
  need(path(lockPath));
  const r = object(value);
  need(!r.link, 'unsupported');
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(lockPath);
  need(match, 'unsupported');
  const name = r.name ?? match[1];
  need(
    safeText(name) && name.length <= 256 && safeText(r.version) && safeText(r.resolved),
    'unsupported',
  );
  const source = new URL(r.resolved);
  need(source.protocol === 'https:' && !source.username && !source.password, 'unsupported');
  return {
    instance: {
      root,
      name,
      lockPath,
      version: r.version,
      source: {
        kind: source.hostname === 'registry.npmjs.org' ? 'registry' : 'url',
        identity: source.href,
      },
      sourceId,
    },
    dependencies: r.dependencies === undefined ? {} : stringMap(r.dependencies),
  };
}
async function rootSide(state: State, root: string, side: 'base' | 'head'): Promise<NpmRootSide> {
  const prefix = root === '.' ? '' : root + '/';
  const manifest = await read(state, root, side, prefix + 'package.json');
  const lock = await read(state, root, side, prefix + 'package-lock.json');
  const result: {
    state: NpmRootSide['state'];
    manifestId: string | null;
    lockId: string | null;
    packages: Record<string, NpmNode>;
    unresolvedPaths: string[];
    declarations: Record<string, Record<string, string>> | null;
  } = {
    state: 'unavailable',
    manifestId: manifest.kind === 'present' ? manifest.id : null,
    lockId: lock.kind === 'present' ? lock.id : null,
    packages: {},
    unresolvedPaths: [],
    declarations: null,
  };
  if (manifest.kind === 'absent' && lock.kind === 'absent')
    return { ...result, state: 'absent', declarations: {} };
  if (manifest.kind === 'absent' || lock.kind === 'absent')
    gap(
      state,
      root,
      side,
      prefix + (manifest.kind === 'absent' ? 'package.json' : 'package-lock.json'),
      'missing',
    );
  try {
    if (manifest.data) result.declarations = declarations(manifest.data);
  } catch (error) {
    gap(state, root, side, prefix + 'package.json', reason(error));
  }
  if (!lock.data) return result;
  try {
    need(lock.data.lockfileVersion === 3, 'unsupported');
    const packages = object(lock.data.packages),
      own = object(packages['']);
    if (result.declarations && !isDeepStrictEqual(result.declarations, declarations(own)))
      gap(state, root, side, prefix + 'package-lock.json', 'conflict');
    for (const [key, value] of Object.entries(packages).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (!key) continue;
      try {
        result.packages[key] = packageNode(root, key, value, lock.id);
      } catch (error) {
        result.unresolvedPaths.push(key);
        gap(state, root, side, prefix + 'package-lock.json', reason(error));
      }
    }
    result.state = 'present';
  } catch (error) {
    gap(state, root, side, prefix + 'package-lock.json', reason(error));
  }
  return result;
}
function changeId(state: State, basis: string, from: unknown, to: unknown) {
  return (
    'npm:' +
    basis +
    ':' +
    hash([
      state.input.binding.repository.id,
      state.input.binding.baseSha,
      state.input.binding.headSha,
      from,
      to,
    ])
  );
}
function research() {
  return Object.fromEntries(
    ['upstream', 'vulnerability', 'malware', 'installScript'].map((k) => [
      k,
      { status: 'unavailable' as const, reasons: ['missing' as const], sourceIds: [] },
    ]),
  );
}
function resolved(state: State, root: NpmRoot) {
  if (root.base.state === 'unavailable' || root.head.state === 'unavailable') return;
  const keys = [
    ...new Set([...Object.keys(root.base.packages), ...Object.keys(root.head.packages)]),
  ].sort();
  for (const key of keys) {
    if (root.base.unresolvedPaths.includes(key) || root.head.unresolvedPaths.includes(key))
      continue;
    const from = root.base.packages[key]?.instance ?? null,
      to = root.head.packages[key]?.instance ?? null;
    if (from && to && isDeepStrictEqual({ ...from, sourceId: '' }, { ...to, sourceId: '' }))
      continue;
    const instance = to ?? from!;
    const manifest = (to ? root.head : root.base).declarations;
    const membership = manifest?.[instance.name];
    const direct = key === `node_modules/${instance.name}` && membership;
    const c: ResolvedChange = {
      id: changeId(state, 'resolved', from, to),
      ecosystem: 'npm',
      kind: from ? (to ? 'update' : 'removal') : 'addition',
      from,
      to,
      role: direct ? 'direct' : manifest ? 'transitive' : 'unknown',
      evidence: research(),
    };
    if (direct)
      c.directRoles = sections.flatMap((section, i) =>
        membership[section] === undefined ? [] : [roles[i]],
      );
    state.changes.push(c);
  }
}
function declared(state: State, root: NpmRoot) {
  const before = root.base.declarations,
    after = root.head.declarations;
  if (before === null || after === null) return;
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const name of names) {
    if (isDeepStrictEqual(before[name], after[name])) continue;
    const from = before[name]
      ? { root: root.root, name, specifiers: before[name], sourceId: root.base.manifestId! }
      : null;
    const to = after[name]
      ? { root: root.root, name, specifiers: after[name], sourceId: root.head.manifestId! }
      : null;
    state.changes.push({
      id: changeId(state, 'declaration', from, to),
      ecosystem: 'npm',
      basis: 'declaration',
      kind: from ? (to ? 'update' : 'removal') : 'addition',
      from,
      to,
      role: 'direct',
      evidence: {},
    });
  }
}
function citesManifest(state: State, c: PacketChange, id: string) {
  if (c.ecosystem !== 'npm' || 'basis' in c || c.role !== 'direct') return false;
  return state.roots.some((root) =>
    (
      [
        ['base', c.from],
        ['head', c.to],
      ] as const
    ).some(([revision, side]) => side?.root === root.root && root[revision].manifestId === id),
  );
}
function sourceMembers(state: State) {
  const sources: PacketSource[] = [];
  for (const s of state.sources) {
    const members = state.changes
      .filter(
        (c) => [c.from?.sourceId, c.to?.sourceId].includes(s.id) || citesManifest(state, c, s.id),
      )
      .map((c) => c.id)
      .sort();
    if (!members.length) {
      sources.push(s);
      continue;
    }
    for (let i = 0; i < members.length; i += 32) {
      const group = members.slice(i, i + 32),
        id = i === 0 ? s.id : s.id + ':' + i / 32;
      sources.push({ ...s, id, memberIds: group });
      for (const c of state.changes.filter((c) => group.includes(c.id)))
        for (const side of [c.from, c.to]) if (side?.sourceId === s.id) side.sourceId = id;
    }
  }
  return sources;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function finish(state: State, complete: boolean, applicable: boolean): NpmInventoryResult {
  const reasons = [...new Set(state.gaps.map((g) => g.reason))].sort();
  const status: InventoryCoverage['status'] = reasons.length
    ? 'partial'
    : applicable
      ? 'complete'
      : 'not_applicable';
  const source: PacketSource = {
    id: 'npm:inventory',
    kind: 'file-list',
    ecosystems: ['npm'],
    memberIds: [],
    status: complete && !reasons.length ? 'available' : 'partial',
    reasons,
    provenance: {
      kind: 'inventory',
      repository: state.input.binding.repository,
      baseSha: state.input.binding.baseSha,
      headSha: state.input.binding.headSha,
      absentEcosystems: status === 'not_applicable' ? ['npm'] : [],
    },
  };
  const result = {
    kind: 'inventory' as const,
    binding: state.input.binding,
    changes: state.changes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    sources: [source, ...sourceMembers(state)],
    roots: state.roots,
    gaps: state.gaps,
    coverage: { status, reasons, sourceIds: ['npm:inventory'] },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > state.input.limits.maxRetainedBytes)
    return { kind: 'unavailable', reason: 'budget' };
  return freeze(result);
}
/** Reads only through the bound D1 session. No filesystem, install, research, or writes occur. */
export async function collectNpmInventory(
  value: unknown,
  { session }: { session: GithubReadSession },
): Promise<NpmInventoryResult> {
  let parsed: Input;
  try {
    parsed = input(value);
  } catch {
    return { kind: 'invalid' };
  }
  const state: State = {
    input: parsed,
    session,
    gaps: [],
    sources: [],
    changes: [],
    roots: [],
    entries: 0,
  };
  try {
    const discovery = await session.discoverFiles();
    if (discovery.kind === 'obsolete') return { kind: 'obsolete' };
    need(isDeepStrictEqual(discovery.binding, parsed.binding), 'conflict');
    if (!discovery.complete)
      for (const why of discovery.reasons.length ? discovery.reasons : ['unknown' as const])
        gap(state, '.', null, null, why);
    const relevant = discovery.files.filter((f) =>
      /^(?:package.json|package-lock.json)$/u.test(f.path),
    );
    if (relevant.length) {
      const root = {
        root: '.',
        base: await rootSide(state, '.', 'base'),
        head: await rootSide(state, '.', 'head'),
      };
      state.roots.push(root);
      resolved(state, root);
      declared(state, root);
      if (!parsed.roots.includes('.')) gap(state, '.', null, null, 'conflict');
    }
    for (const f of discovery.files)
      if (/\/(?:package.json|package-lock.json)$/u.test(f.path))
        gap(state, '.', null, f.path, 'unsupported');
    return finish(state, discovery.complete, relevant.length > 0);
  } catch (error) {
    return { kind: 'unavailable', reason: reason(error) };
  }
}
