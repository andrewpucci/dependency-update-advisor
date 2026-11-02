import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { parseReviewBinding, type ReviewBinding } from '../event.js';
import { PACKET_LIMITS, type EvidenceReason } from '../schema.js';
import { isEvidencePath, isPlainObject, byCodeUnit } from './common.js';
import type { UvMetadata, UvMetadataResult, UvFileSnapshot } from './uv.js';
import type { UvLock, UvPackage, UvSelector, UvSource } from './uv-lock.js';
import type { UvManifest } from './uv-manifest.js';

export const uvReasons: readonly EvidenceReason[] = [
  'permission',
  'rate_limit',
  'timeout',
  'missing',
  'malformed',
  'unsupported',
  'truncated',
  'budget',
  'conflict',
  'unknown',
];
export class UvGraphFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
export function need(value: unknown): asserts value {
  if (!value) throw new Error('invalid uv handoff');
}
export type GraphWork = {
  spend: (count?: number) => void;
  id: (kind: string, value: unknown) => string;
};
export type UvGraphLimits = { maxGraphWork: number; maxRetainedBytes: number };
const sha = (v: unknown) => typeof v === 'string' && /^[a-f\d]{40}$/u.test(v);
const safe = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(v);
const name = (v: unknown) => typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(v);
const path = (v: unknown) => v === '.' || isEvidencePath(v);
function keys(value: object, fields: string[]) {
  need(isPlainObject(value));
  need(Object.keys(value).length === fields.length);
  need(fields.every((k) => Object.hasOwn(value, k)));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function graphWork(max: number): GraphWork {
  let left = max;
  const identities = new Map<string, string>();
  return {
    spend: (count = 1) => {
      left -= count;
      if (left < 0) throw new UvGraphFailure('budget');
    },
    id: (kind, value) => {
      const text = JSON.stringify(canonical(value));
      const id = `uv:${kind}:${createHash('sha256').update(text).digest('hex')}`;
      if (identities.has(id) && identities.get(id) !== text) throw new UvGraphFailure('conflict');
      identities.set(id, text);
      return id;
    },
  };
}
type GraphFrame = { value: unknown; exit?: boolean };
function queueProperties(value: object, stack: GraphFrame[]) {
  const arr = Array.isArray(value);
  need(arr || isPlainObject(value));
  if (arr) need(Object.getPrototypeOf(value) === Array.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(descriptors);
  if (arr) need(keys.length === value.length + 1);
  let bytes = 0;
  for (const key of keys) {
    if (arr && key === 'length') continue;
    need(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key));
    const d = descriptors[key];
    need('value' in d && d.enumerable);
    if (arr) need(/^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < value.length);
    bytes += Buffer.byteLength(key);
    stack.push({ value: d.value });
  }
  return bytes;
}
/** Revisit aliases for work accounting, but reject cycles before JSON serialization. */
export function checkGraphData(value: unknown, work: GraphWork, maxBytes: number) {
  const stack: GraphFrame[] = [{ value }],
    active = new Set<object>();
  let bytes = 0;
  while (stack.length) {
    work.spend();
    const { value: next, exit } = stack.pop()!;
    if (exit) {
      active.delete(next as object);
      continue;
    }
    if (typeof next === 'string') bytes += Buffer.byteLength(next);
    if (bytes > maxBytes) throw new UvGraphFailure('budget');
    if (next === null || ['string', 'boolean'].includes(typeof next)) continue;
    if (typeof next === 'number') {
      need(Number.isFinite(next));
      continue;
    }
    need(next && typeof next === 'object' && !types.isProxy(next));
    need(!active.has(next));
    active.add(next);
    stack.push({ value: next, exit: true });
    bytes += queueProperties(next, stack);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new UvGraphFailure('budget');
}
function origin(s: UvSource) {
  need(s && typeof s === 'object');
  if (s.kind === 'editable') {
    need(s.path === '.' && Object.keys(s).length === 2);
    return;
  }
  need(s.kind === 'registry' && safe(s.url) && Object.keys(s).length === 2);
  const u = new URL(s.url);
  need(
    u.protocol === 'https:' &&
      !!u.hostname &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      !/[\\\s]/u.test(s.url),
  );
}
function strings(value: unknown, normalized = false) {
  need(Array.isArray(value));
  need(value.every(normalized ? name : safe));
  need(new Set(value).size === value.length);
}
function requirement(d: {
  name: string;
  specifier: string | null;
  marker: string | null;
  extras: string[] | null;
}) {
  need(name(d.name));
  need(d.specifier === null || safe(d.specifier));
  need(d.marker === null || safe(d.marker));
  if (d.extras !== null) strings(d.extras, true);
}
function selector(s: UvSelector) {
  keys(s, ['name', 'version', 'source', 'marker', 'extra', 'list', 'position']);
  need(name(s.name) && safe(s.list) && Number.isSafeInteger(s.position) && s.position >= 0);
  need(s.version === null || safe(s.version));
  if (s.source !== null) origin(s.source);
  need(s.marker === null || safe(s.marker));
  if (s.extra !== null) strings(s.extra, true);
}
function packageData(p: UvPackage) {
  keys(p, [
    'key',
    'name',
    'version',
    'source',
    'external',
    'resolutionMarkers',
    'dependencies',
    'optionalDependencies',
    'metadata',
  ]);
  need(name(p.name));
  origin(p.source);
  need(p.external === (p.source.kind === 'registry'));
  need(
    p.version === null
      ? !p.external
      : safe(p.version) && /^[A-Za-z0-9][A-Za-z0-9.!+_-]*$/u.test(p.version),
  );
  const source =
    p.source.kind === 'registry'
      ? { kind: 'registry', url: p.source.url }
      : { kind: 'editable', path: '.' };
  need(p.key === JSON.stringify([p.name, p.version, source]));
  if (p.resolutionMarkers !== null) strings(p.resolutionMarkers);
  if (p.dependencies !== null) {
    need(Array.isArray(p.dependencies));
    p.dependencies.forEach(selector);
  }
  if (p.optionalDependencies !== null) {
    need(Array.isArray(p.optionalDependencies));
    strings(
      p.optionalDependencies.map((e) => e.extra),
      true,
    );
    for (const e of p.optionalDependencies) {
      keys(e, ['extra', 'declarations']);
      need(Array.isArray(e.declarations));
      e.declarations.forEach(selector);
    }
  }
  if (p.metadata !== null) {
    keys(p.metadata, ['requiresDist', 'providesExtras']);
    if (p.metadata.requiresDist !== null) {
      need(Array.isArray(p.metadata.requiresDist));
      p.metadata.requiresDist.forEach(requirement);
    }
    if (p.metadata.providesExtras !== null) strings(p.metadata.providesExtras, true);
  }
}
function manifestData(m: UvManifest) {
  keys(m, ['name', 'requiresPython', 'dependencies', 'optionalDependencies', 'fields']);
  keys(m.fields, ['dependencies', 'optionalDependencies']);
  need(name(m.name) && (m.requiresPython === null || safe(m.requiresPython)));
  need(['absent', 'present', 'dynamic', 'invalid'].includes(m.fields.dependencies));
  need(['absent', 'present', 'dynamic', 'invalid'].includes(m.fields.optionalDependencies));
  const declaration = (d: UvManifest['dependencies'][number]) => {
    keys(d, ['text', 'name', 'extras', 'specifier', 'marker', 'list', 'position']);
    requirement(d);
    need(safe(d.text) && safe(d.list) && Number.isSafeInteger(d.position) && d.position >= 0);
  };
  need(Array.isArray(m.dependencies));
  m.dependencies.forEach(declaration);
  need(Array.isArray(m.optionalDependencies));
  strings(
    m.optionalDependencies.map((e) => e.extra),
    true,
  );
  for (const e of m.optionalDependencies) {
    keys(e, ['extra', 'declarations']);
    need(Array.isArray(e.declarations));
    e.declarations.forEach(declaration);
  }
}
function lockData(l: UvLock) {
  keys(l, ['version', 'revision', 'requiresPython', 'resolutionMarkers', 'packages']);
  need(l.version === 1 && [3, 5].includes(l.revision));
  need(l.requiresPython === null || safe(l.requiresPython));
  if (l.resolutionMarkers !== null) strings(l.resolutionMarkers);
  need(Array.isArray(l.packages));
  l.packages.forEach(packageData);
  need(new Set(l.packages.map((p) => p.key)).size === l.packages.length);
}
function fileSource(file: UvFileSnapshot<UvManifest | UvLock>, m: UvMetadata) {
  if (file.sourceId !== null) {
    const source = m.sources.find((s) => s.id === file.sourceId);
    need(source);
    for (const key of ['side', 'path', 'repository', 'commitSha', 'blobSha', 'treeSha'] as const)
      need(isDeepStrictEqual(source[key], file[key]));
    need(source.kind === (file.state === 'absent' ? 'absence' : 'file'));
    need(
      source.status ===
        (file.state === 'present' || file.state === 'absent'
          ? 'available'
          : file.state === 'partial'
            ? 'partial'
            : 'unavailable'),
    );
  } else need(file.state === 'unavailable');
}
function fileData(
  file: UvFileSnapshot<UvManifest | UvLock>,
  m: UvMetadata,
  root: string,
  side: 'base' | 'head',
  filename: string,
) {
  keys(file, [
    'id',
    'sourceId',
    'state',
    'side',
    'path',
    'repository',
    'commitSha',
    'blobSha',
    'treeSha',
    'data',
  ]);
  need(file.side === side && file.path === (root === '.' ? filename : `${root}/${filename}`));
  need(file.commitSha === (side === 'base' ? m.binding.baseSha : m.binding.headSha));
  need(
    isDeepStrictEqual(
      file.repository,
      side === 'base' ? m.binding.repository : m.binding.headRepository,
    ),
  );
  need(safe(file.id) && ['present', 'partial', 'absent', 'unavailable'].includes(file.state));
  fileSource(file, m);
  if (file.state === 'present' || file.state === 'partial') {
    need(sha(file.blobSha) && file.treeSha === null && file.data !== null);
    if (filename === 'uv.lock') lockData(file.data as UvLock);
    else manifestData(file.data as UvManifest);
  } else {
    need(file.data === null);
    if (file.state === 'absent') need(sha(file.treeSha) && file.blobSha === null);
  }
}
function rootData(r: UvMetadata['roots'][number], m: UvMetadata) {
  keys(r, ['id', 'root', 'configured', 'base', 'head']);
  need(path(r.root) && typeof r.configured === 'boolean');
  for (const side of ['base', 'head'] as const) {
    keys(r[side], ['state', 'manifest', 'lock']);
    need(['present', 'partial', 'absent', 'unavailable'].includes(r[side].state));
    fileData(r[side].manifest, m, r.root, side, 'pyproject.toml');
    fileData(r[side].lock, m, r.root, side, 'uv.lock');
    const a = r[side].manifest.state,
      b = r[side].lock.state;
    need(
      r[side].state ===
        (a === b && ['present', 'absent', 'unavailable'].includes(a) ? a : 'partial'),
    );
  }
}
function metadataData(m: UvMetadata, binding: ReviewBinding) {
  keys(m, [
    'kind',
    'binding',
    'configRevision',
    'roots',
    'sources',
    'gaps',
    'discovery',
    'comparison',
  ]);
  need(isDeepStrictEqual(m.binding, binding) && sha(m.configRevision.sha));
  need(isDeepStrictEqual(m.configRevision.repository, binding.repository));
  need(Array.isArray(m.roots) && Array.isArray(m.sources) && Array.isArray(m.gaps));
  need(new Set(m.sources.map((s) => s.id)).size === m.sources.length);
  need(new Set(m.roots.map((r) => r.root)).size === m.roots.length);
  for (const s of m.sources) {
    keys(s, [
      'id',
      'kind',
      'side',
      'path',
      'repository',
      'commitSha',
      'blobSha',
      'treeSha',
      'status',
      'reasons',
    ]);
    need(safe(s.id) && Array.isArray(s.reasons));
    need(s.reasons.every((r) => uvReasons.includes(r)));
    need((s.status === 'available') === (s.reasons.length === 0));
  }
  for (const g of m.gaps) {
    keys(g, ['root', 'side', 'path', 'entry', 'reason']);
    need(g.root === null || path(g.root));
    need(g.side === null || g.side === 'base' || g.side === 'head');
    need(g.path === null || isEvidencePath(g.path));
    need(g.entry === null || safe(g.entry));
    need(uvReasons.includes(g.reason));
  }
  for (const root of m.roots) rootData(root, m);
  const files = m.roots.flatMap((r) => [
    r.base.manifest,
    r.base.lock,
    r.head.manifest,
    r.head.lock,
  ]);
  need(m.sources.every((s) => files.some((f) => f.sourceId === s.id)));
  for (const x of [m.discovery, m.comparison]) {
    need(['available', 'partial', 'unavailable'].includes(x.status));
    need(Array.isArray(x.reasons) && x.reasons.every((r) => uvReasons.includes(r)));
  }
  need(typeof m.discovery.complete === 'boolean' && typeof m.discovery.applicable === 'boolean');
  need(
    !m.discovery.complete || (m.discovery.status === 'available' && !m.discovery.reasons.length),
  );
}
function graphEnvelope(value: unknown) {
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
        typeof k === 'string' && ['binding', 'metadata', 'limits', 'corroboration'].includes(k),
    ),
  );
  for (const key of ['binding', 'metadata', 'limits'])
    need(descriptors[key] && 'value' in descriptors[key] && descriptors[key].enumerable);
  const c = descriptors.corroboration;
  return {
    core: {
      binding: descriptors.binding.value,
      metadata: descriptors.metadata.value,
      limits: descriptors.limits.value,
    },
    corroboration: c ? ('value' in c && c.enumerable ? c.value : null) : undefined,
  };
}
export function parseGraphInput(value: unknown) {
  const extracted = graphEnvelope(value);
  value = extracted.core;
  need(isPlainObject(value) && isPlainObject(value.limits));
  const limits = value.limits as UvGraphLimits;
  need(
    [limits.maxGraphWork, limits.maxRetainedBytes].every((n) => Number.isSafeInteger(n) && n > 0),
  );
  const work = graphWork(limits.maxGraphWork);
  checkGraphData(value, work, limits.maxRetainedBytes);
  const binding = parseReviewBinding(value.binding);
  need(binding);
  const metadata = value.metadata as UvMetadataResult;
  need(metadata && typeof metadata === 'object');
  if (metadata.kind === 'metadata') metadataData(metadata as UvMetadata, binding);
  else {
    need(['invalid', 'obsolete', 'unavailable'].includes(metadata.kind));
    keys(metadata, metadata.kind === 'unavailable' ? ['kind', 'reason'] : ['kind']);
    if (metadata.kind === 'unavailable') need(uvReasons.includes(metadata.reason));
  }
  return {
    binding,
    metadata: structuredClone(metadata) as UvMetadataResult,
    limits,
    work,
    corroboration: extracted.corroboration,
  };
}
export function boundedIdentity(s: string) {
  return Buffer.byteLength(s) <= PACKET_LIMITS.identityBytes;
}
