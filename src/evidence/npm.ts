import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { parseReviewBinding, type ReviewBinding } from '../event.js';
import type { GithubReadSession, GithubComparison } from '../github-read.js';
import type {
  EvidenceReason,
  InventoryCoverage,
  PacketChange,
  PacketSource,
  PacketRevision,
  NpmSide,
  PackageSource,
} from '../schema.js';
import {
  byCodeUnit,
  freeze,
  isEvidencePath,
  isPlainObject,
  longestFittingPrefix,
} from './common.js';

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
export type NpmNode = Readonly<{
  instance: NpmSide | null;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  integrity: string | null;
  hasInstallScript: boolean | null;
  link: string | null;
}>;
export type NpmRootSide = Readonly<{
  state: 'present' | 'absent' | 'unavailable';
  manifestId: string | null;
  lockId: string | null;
  packages: Record<string, NpmNode>;
  unresolvedPaths: readonly string[];
  declarations: Record<string, Record<string, string>> | null;
}>;
export type NpmRoot = Readonly<{ root: string; base: NpmRootSide; head: NpmRootSide }>;
export type NpmComparison = Readonly<{
  status: 'available' | 'partial' | 'unavailable';
  reasons: readonly EvidenceReason[];
  recordCount: number;
  sourceIds: readonly string[];
}>;
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
      readonly comparison: NpmComparison;
    };
type State = {
  input: Input;
  session: GithubReadSession;
  gaps: NpmGap[];
  sources: PacketSource[];
  changes: PacketChange[];
  roots: NpmRoot[];
  entries: number;
  comparison: NpmComparison;
};
const sections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const roles = ['production', 'development', 'peer', 'optional'] as const;
const npmFile = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/u;
const comparedFile = /(?:^|\/)(?:package-lock\.json|package\.json)$/u;
/** Reads only own keys so hostile names such as `toString` cannot resolve inherited members. */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
function rootOf(file: string) {
  return file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
}
class InventoryError extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
function need(condition: unknown, reason: EvidenceReason = 'malformed'): asserts condition {
  if (!condition) throw new InventoryError(reason);
}
function object(value: unknown): Record<string, unknown> {
  need(isPlainObject(value));
  return value;
}
function characters(value: string) {
  return [...value].every((c) => {
    const n = c.codePointAt(0)!;
    return n >= 32 && (n < 127 || n > 159) && !(n >= 0xd800 && n <= 0xdfff);
  });
}
function path(value: unknown, root = false): value is string {
  return (root && value === '.') || isEvidencePath(value);
}
function safeText(value: unknown, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    Buffer.byteLength(value) <= 1024 &&
    characters(value) &&
    !/\/\/(?!git@[^/\s@]*(?:[/\s]|$))[^/\s]*@|[?&](?:token|key|password|secret|auth)=/iu.test(value)
  );
}
function inspect(value: unknown, limits: Limits, depth = 1, counter = { entries: 0 }) {
  if (!value || typeof value !== 'object') return;
  need(depth <= limits.maxJsonDepth, 'budget');
  need(!types.isProxy(value));
  const array = Array.isArray(value);
  if (!array) object(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter((k) => k !== 'length' || !array);
  counter.entries += keys.length;
  need(counter.entries <= limits.maxJsonEntries, 'budget');
  if (array)
    need(
      Object.getPrototypeOf(value) === Array.prototype &&
        keys.length === value.length &&
        keys.every(
          (k) => typeof k === 'string' && /^(?:0|[1-9]\d*)$/u.test(k) && Number(k) < value.length,
        ),
    );
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
    for (const [name, specifier] of Object.entries(stringMap(value[section]))) {
      if (!Object.hasOwn(result, name)) result[name] = {};
      result[name][section] = specifier;
    }
  }
  return result;
}
function reason(error: unknown): EvidenceReason {
  return error instanceof InventoryError
    ? error.reason
    : error instanceof SyntaxError || error instanceof TypeError
      ? 'malformed'
      : 'unknown';
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
function packageSource(value: unknown): PackageSource {
  need(safeText(value), 'unsupported');
  for (const [prefix, kind] of [
    ['file:', 'path'],
    ['workspace:', 'workspace'],
  ] as const) {
    if (!value.startsWith(prefix)) continue;
    const identity = value.slice(prefix.length);
    need(path(identity, true), 'unsupported');
    return { kind, identity };
  }
  const git = value.startsWith('git+https:');
  const url = new URL(git ? value.slice(4) : value);
  need(url.protocol === 'https:' && !url.username && !url.password, 'unsupported');
  return {
    kind: git ? 'git' : url.hostname === 'registry.npmjs.org' ? 'registry' : 'url',
    identity: url.href,
  };
}
function slotName(lockPath: string) {
  return /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(lockPath)?.[1] ?? null;
}
function metadata(r: Record<string, unknown>) {
  need(r.integrity === undefined || safeText(r.integrity));
  need(r.hasInstallScript === undefined || typeof r.hasInstallScript === 'boolean');
  need(r.link === undefined || typeof r.link === 'boolean');
  const link = r.link === true ? r.resolved : null;
  need(link === null || path(link, true), 'unsupported');
  return {
    dependencies: r.dependencies === undefined ? {} : stringMap(r.dependencies),
    optionalDependencies:
      r.optionalDependencies === undefined ? {} : stringMap(r.optionalDependencies),
    peerDependencies: r.peerDependencies === undefined ? {} : stringMap(r.peerDependencies),
    integrity: r.integrity === undefined ? null : (r.integrity as string),
    hasInstallScript: r.hasInstallScript === undefined ? null : (r.hasInstallScript as boolean),
    link,
  };
}
function packageNode(root: string, lockPath: string, value: unknown, sourceId: string): NpmNode {
  need(path(lockPath));
  const r = object(value),
    facts = metadata(r);
  if (facts.link) return { instance: null, ...facts };
  const slot = slotName(lockPath);
  need(slot, 'unsupported');
  const name = r.name ?? slot;
  need(
    safeText(name) &&
      name.length <= 256 &&
      safeText(r.version) &&
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/iu.test(
        r.version,
      ),
    'unsupported',
  );
  return {
    instance: {
      root,
      name,
      lockPath,
      version: r.version,
      source: packageSource(r.resolved),
      sourceId,
    },
    ...facts,
  };
}
function validateLockRoot(
  value: unknown,
  manifest: Record<string, unknown> | null,
  declared: NpmRootSide['declarations'],
) {
  const own = object(value);
  for (const key of ['name', 'version'])
    if (manifest && manifest[key] !== undefined && own[key] !== undefined)
      need(manifest[key] === own[key], 'conflict');
  if (declared !== null) need(isDeepStrictEqual(declared, declarations(own)), 'conflict');
}
function lockPackages(
  state: State,
  root: string,
  side: 'base' | 'head',
  data: Record<string, unknown>,
  id: string,
  manifest: Record<string, unknown> | null,
  result: {
    packages: Record<string, NpmNode>;
    unresolvedPaths: string[];
    declarations: NpmRootSide['declarations'];
  },
) {
  need(data.lockfileVersion === 3, 'unsupported');
  const packages = object(data.packages),
    file = (root === '.' ? '' : root + '/') + 'package-lock.json';
  try {
    validateLockRoot(packages[''], manifest, result.declarations);
  } catch (error) {
    gap(state, root, side, file, reason(error));
  }
  for (const key of Object.keys(packages).sort()) {
    if (!key) continue;
    try {
      const node = packageNode(root, key, packages[key], id);
      result.packages[key] = node;
      need(node.instance, 'unsupported');
    } catch (error) {
      if (path(key)) result.unresolvedPaths.push(key);
      gap(state, root, side, file, reason(error));
    }
  }
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
    if (manifest.data) {
      result.declarations = declarations(manifest.data);
      if (
        [
          'workspaces',
          'overrides',
          'peerDependenciesMeta',
          'bundleDependencies',
          'bundledDependencies',
        ].some((k) => manifest.data![k] !== undefined)
      )
        gap(state, root, side, prefix + 'package.json', 'unsupported');
    }
  } catch (error) {
    gap(state, root, side, prefix + 'package.json', reason(error));
  }
  if (!lock.data) return result;
  try {
    lockPackages(state, root, side, lock.data, lock.id, manifest.data, result);
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
function classify(state: State, root: NpmRoot, instance: NpmSide, side: 'base' | 'head') {
  const manifest = root[side].declarations;
  if (!manifest) return { role: 'unknown' as const };
  const slot = slotName(instance.lockPath),
    membership = slot ? own(manifest, slot) : undefined;
  if (!slot || !membership || instance.lockPath !== `node_modules/${slot}`)
    return { role: 'transitive' as const };
  const effective =
    membership.optionalDependencies ??
    membership.dependencies ??
    membership.devDependencies ??
    membership.peerDependencies;
  const actual = effective?.startsWith('npm:')
    ? /^npm:((?:@[^/]+\/)?[^@/]+)(?:@.*)?$/u.exec(effective)?.[1]
    : slot;
  if (actual !== instance.name) {
    gap(state, root.root, side, null, 'conflict');
    return { role: 'unknown' as const };
  }
  return {
    role: 'direct' as const,
    directRoles: sections.flatMap((section, i) =>
      membership[section] === undefined ? [] : [roles[i]],
    ),
  };
}
/** A direct dependency that stops being direct (or the reverse) must not vanish from either side's candidates. */
function roleOf(state: State, root: NpmRoot, from: NpmSide | null, to: NpmSide | null) {
  const head = classify(state, root, to ?? from!, to ? 'head' : 'base');
  if (!from || !to) return head;
  const base = classify(state, root, from, 'base');
  if (base.role === 'unknown' || head.role === 'unknown' || base.role === head.role) return head;
  gap(state, root.root, null, null, 'conflict');
  return { role: 'unknown' as const };
}
function emitResolved(state: State, root: NpmRoot, from: NpmSide | null, to: NpmSide | null) {
  state.changes.push({
    id: changeId(state, 'resolved', from, to),
    ecosystem: 'npm',
    kind: from ? (to ? 'update' : 'removal') : 'addition',
    from,
    to,
    ...roleOf(state, root, from, to),
    evidence: research(),
  });
}
function sameInstance(from: NpmSide | null, to: NpmSide | null) {
  return from && to && isDeepStrictEqual({ ...from, sourceId: '' }, { ...to, sourceId: '' });
}
function resolved(state: State, root: NpmRoot) {
  if (root.base.state === 'unavailable' || root.head.state === 'unavailable') return;
  const keys = [
    ...new Set([...Object.keys(root.base.packages), ...Object.keys(root.head.packages)]),
  ].sort();
  const unresolved = new Set([...root.base.unresolvedPaths, ...root.head.unresolvedPaths]);
  for (const key of keys) {
    if (unresolved.has(key)) continue;
    const before = own(root.base.packages, key),
      after = own(root.head.packages, key);
    const from = before?.instance ?? null,
      to = after?.instance ?? null;
    if (sameInstance(from, to)) {
      if (!isDeepStrictEqual({ ...before, instance: null }, { ...after, instance: null }))
        gap(state, root.root, null, null, 'unsupported');
      continue;
    }
    if (from && to && from.name !== to.name) {
      emitResolved(state, root, from, null);
      emitResolved(state, root, null, to);
    } else if (from || to) emitResolved(state, root, from, to);
  }
}
function declared(state: State, root: NpmRoot) {
  const before = root.base.declarations,
    after = root.head.declarations;
  if (before === null || after === null) return;
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const name of names) {
    const was = own(before, name),
      now = own(after, name);
    if (isDeepStrictEqual(was, now)) continue;
    const from = was
      ? { root: root.root, name, specifiers: was, sourceId: root.base.manifestId! }
      : null;
    const to = now
      ? { root: root.root, name, specifiers: now, sourceId: root.head.manifestId! }
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
function comparisonIdentity(state: State, result: GithubComparison) {
  const b = state.input.binding;
  need(
    isDeepStrictEqual(result.repository, b.repository) &&
      isDeepStrictEqual(result.headRepository, b.headRepository) &&
      result.baseSha === b.baseSha &&
      result.headSha === b.headSha &&
      result.mergeBaseSha === b.mergeBaseSha,
    'conflict',
  );
}
function comparisonMatch(state: State, row: Readonly<Record<string, unknown>>) {
  need(safeText(row.manifest) && path(row.manifest) && safeText(row.name) && safeText(row.version));
  need(row.change_type === 'added' || row.change_type === 'removed', 'unsupported');
  need(comparedFile.test(row.manifest), 'unsupported');
  const root = rootOf(row.manifest);
  const revision = row.change_type === 'added' ? 'head' : 'base';
  const side = revision === 'head' ? 'to' : 'from';
  const matches = state.changes.filter(
    (c) =>
      c.ecosystem === 'npm' &&
      !('basis' in c) &&
      c[side]?.root === root &&
      c[side]?.name === row.name &&
      c[side]?.version === row.version,
  );
  // GitHub reports one row per name@version, so duplicate installs leave the row unattributable.
  if (matches.length > 1) return null;
  need(matches.length === 1, 'conflict');
  const c = matches[0],
    instance = c[side]!;
  need('source' in instance && instance.source.kind === 'registry', 'unsupported');
  if (row.package_url !== undefined) {
    need(safeText(row.package_url));
    need(decodeURIComponent(row.package_url) === `pkg:npm/${row.name}@${row.version}`, 'conflict');
  }
  const id = 'npm:comparison:' + hash([c.id, revision]);
  if (!state.sources.some((s) => s.id === id))
    state.sources.push({
      id,
      kind: 'comparison',
      ecosystems: ['npm'],
      memberIds: [c.id],
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'upstream',
        url: `https://api.github.com/repos/${encodeURIComponent(state.input.binding.repository.owner)}/${encodeURIComponent(state.input.binding.repository.name)}/dependency-graph/compare/${state.input.binding.baseSha}...${state.input.binding.headSha}`,
        title: 'GitHub npm dependency comparison',
        excerpt: 'The comparison lists this exact package version.',
        excerptTruncated: false,
        subjects: [{ memberId: c.id, side: revision, value: row.version }],
        range: null,
      },
    });
  return id;
}
/** Scopes a comparison discrepancy to its manifest root when that path is safe to retain. */
function comparisonRoot(row: Readonly<Record<string, unknown>>) {
  return path(row.manifest) && comparedFile.test(row.manifest) ? rootOf(row.manifest) : '.';
}
async function reconcileComparison(state: State) {
  try {
    const result = await state.session.readComparison();
    comparisonIdentity(state, result);
    const reasons = new Set<EvidenceReason>(result.reasons),
      sourceIds: string[] = [];
    const rows = result.records.filter((r) => r.ecosystem === 'npm');
    for (const row of rows) {
      try {
        const id = comparisonMatch(state, row);
        if (id) sourceIds.push(id);
        else reasons.add('conflict');
      } catch (error) {
        const why = reason(error);
        reasons.add(why);
        gap(state, comparisonRoot(row), null, null, why);
      }
    }
    state.comparison = {
      status: result.kind === 'available' && reasons.size ? 'partial' : result.kind,
      reasons: [...reasons].sort(),
      recordCount: rows.length,
      sourceIds: [...new Set(sourceIds)].sort(),
    };
  } catch (error) {
    state.comparison = {
      status: 'unavailable',
      reasons: [reason(error)],
      recordCount: 0,
      sourceIds: [],
    };
  }
  if (state.comparison.status === 'unavailable')
    state.sources.push({
      id: 'npm:comparison:unavailable',
      kind: 'comparison',
      ecosystems: ['npm'],
      memberIds: [],
      status: 'unavailable',
      reasons: [...state.comparison.reasons],
      provenance: { kind: 'unavailable' },
    });
}
function corroboratingSource(state: State, source: PacketSource): PacketSource[] {
  if (source.provenance.kind === 'unavailable') return [source];
  const memberIds = source.memberIds.filter((id) => state.changes.some((c) => c.id === id));
  if (!memberIds.length || source.provenance.kind !== 'upstream') return [];
  return [
    {
      ...source,
      memberIds,
      provenance: {
        ...source.provenance,
        subjects: source.provenance.subjects.filter((t) => memberIds.includes(t.memberId)),
      },
    },
  ];
}
function fileScopes(state: State, source: PacketSource): PacketSource[] {
  const members = state.changes
    .filter(
      (c) =>
        [c.from?.sourceId, c.to?.sourceId].includes(source.id) ||
        citesManifest(state, c, source.id),
    )
    .map((c) => c.id)
    .sort();
  if (!members.length) return [source];
  const sources: PacketSource[] = [];
  for (let i = 0; i < members.length; i += 32) {
    const group = members.slice(i, i + 32),
      ids = new Set(group),
      id = i === 0 ? source.id : source.id + ':' + i / 32;
    sources.push({ ...source, id, memberIds: group });
    for (const c of state.changes.filter((c) => ids.has(c.id)))
      for (const side of [c.from, c.to]) if (side?.sourceId === source.id) side.sourceId = id;
  }
  return sources;
}
function sourceMembers(state: State) {
  return state.sources.flatMap((source) =>
    source.kind === 'file' ? fileScopes(state, source) : corroboratingSource(state, source),
  );
}
function assemble(state: State, complete: boolean, applicable: boolean, snapshots = true) {
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
  const owned = { ...state, changes: structuredClone(state.changes) };
  const sources = sourceMembers(owned);
  const result = {
    kind: 'inventory' as const,
    binding: state.input.binding,
    changes: owned.changes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    sources: [
      source,
      ...sources
        .filter((s) => snapshots || s.memberIds.length > 0)
        .sort((a, b) => byCodeUnit(a.id, b.id)),
    ],
    roots: snapshots ? state.roots : [],
    gaps: [...state.gaps].sort((a, b) =>
      byCodeUnit(
        JSON.stringify([a.root, a.side, a.path, a.reason]),
        JSON.stringify([b.root, b.side, b.path, b.reason]),
      ),
    ),
    comparison: {
      ...state.comparison,
      sourceIds: state.comparison.sourceIds.filter((id) => sources.some((s) => s.id === id)),
    },
    coverage: { status, reasons, sourceIds: ['npm:inventory'] },
  };
  return result;
}
function finish(state: State, complete: boolean, applicable: boolean): NpmInventoryResult {
  const fits = (result: ReturnType<typeof assemble>) =>
    Buffer.byteLength(JSON.stringify(result)) <= state.input.limits.maxRetainedBytes;
  const full = assemble(state, complete, applicable);
  if (fits(full)) return freeze(full);
  gap(state, '.', null, null, 'budget');
  const ordered = [...state.changes].sort((a, b) => byCodeUnit(a.id, b.id));
  const prefix = (count: number) => {
    state.changes = ordered.slice(0, count);
    return assemble(state, false, applicable, false);
  };
  const trimmed = longestFittingPrefix(ordered.length, prefix, fits);
  return trimmed ? freeze(trimmed) : { kind: 'unavailable', reason: 'budget' };
}
function candidateRoots(
  state: State,
  files: readonly { path: string; previousPath: string | null }[],
) {
  const candidates = new Set<string>();
  for (const f of files)
    for (const value of [f.path, f.previousPath]) {
      if (!value || !npmFile.test(value)) continue;
      if (!path(value)) {
        gap(state, '.', null, null, 'malformed');
        continue;
      }
      const root = rootOf(value);
      if (value.endsWith('npm-shrinkwrap.json')) gap(state, root, null, value, 'unsupported');
      candidates.add(root);
    }
  return [...candidates].sort();
}
async function collectRoot(state: State, root: string) {
  if (!state.input.roots.includes(root)) gap(state, root, null, null, 'conflict');
  const snapshot = {
    root,
    base: await rootSide(state, root, 'base'),
    head: await rootSide(state, root, 'head'),
  };
  state.roots.push(snapshot);
  resolved(state, snapshot);
  declared(state, snapshot);
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
    comparison: { status: 'unavailable', reasons: ['missing'], recordCount: 0, sourceIds: [] },
  };
  try {
    const discovery = await session.discoverFiles();
    if (discovery.kind === 'obsolete') return { kind: 'obsolete' };
    need(isDeepStrictEqual(discovery.binding, parsed.binding), 'conflict');
    if (!discovery.complete)
      for (const why of discovery.reasons.length ? discovery.reasons : ['unknown' as const])
        gap(state, '.', null, null, why);
    const roots = candidateRoots(state, discovery.files);
    for (const root of roots.slice(0, parsed.limits.maxRoots)) await collectRoot(state, root);
    if (roots.length > parsed.limits.maxRoots) gap(state, '.', null, null, 'budget');
    await reconcileComparison(state);
    return finish(state, discovery.complete, roots.length > 0);
  } catch (error) {
    return { kind: 'unavailable', reason: reason(error) };
  }
}
