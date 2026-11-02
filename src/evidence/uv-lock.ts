import { PACKET_LIMITS } from '../schema.js';
import { byCodeUnit } from './common.js';
import { normalizeName, optionalTable, parseRequirement, type UvExtra } from './uv-manifest.js';
import {
  debit,
  need,
  newBudget,
  readToml,
  reason,
  table,
  text,
  type UvBudget,
  type UvEntryGap,
  type UvParseLimits,
  type UvRead,
} from './uv-toml.js';
export type UvSource = { kind: 'registry'; url: string } | { kind: 'editable'; path: '.' };
export type UvSelector = {
  name: string;
  version: string | null;
  source: UvSource | null;
  marker: string | null;
  extra: string[] | null;
  list: string;
  position: number;
};
export type UvLockRequirement = {
  name: string;
  specifier: string | null;
  extras: string[] | null;
  marker: string | null;
  position: number;
};
export type UvLockMetadata = {
  requiresDist: UvLockRequirement[] | null;
  providesExtras: string[] | null;
};
export type UvPackage = {
  key: string;
  name: string;
  version: string | null;
  source: UvSource;
  external: boolean;
  resolutionMarkers: string[] | null;
  dependencies: UvSelector[] | null;
  optionalDependencies: UvExtra<UvSelector>[] | null;
  metadata: UvLockMetadata | null;
};
export type UvLock = {
  version: 1;
  revision: 3 | 5;
  requiresPython: string | null;
  resolutionMarkers: string[] | null;
  packages: UvPackage[];
};
function url(value: unknown): string {
  const raw = text(value);
  need(Buffer.byteLength(raw) <= PACKET_LIMITS.identityBytes, 'unsupported');
  const parsed = new URL(raw);
  need(
    !/[\\\s]/u.test(raw) &&
      parsed.protocol === 'https:' &&
      !!parsed.hostname &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash,
  );
  return raw;
}
function source(value: unknown): UvSource {
  const raw = table(value),
    keys = Object.keys(raw);
  need(keys.length === 1, 'unsupported');
  if (keys[0] === 'registry') return { kind: 'registry', url: url(raw.registry) };
  need(keys[0] === 'editable' && raw.editable === '.', 'unsupported');
  return { kind: 'editable', path: '.' };
}
function version(value: unknown): string {
  const raw = text(value);
  need(Buffer.byteLength(raw) <= PACKET_LIMITS.identityBytes, 'unsupported');
  need(/^[A-Za-z0-9][A-Za-z0-9.!+_-]*$/u.test(raw));
  return raw;
}
function strings(raw: unknown, normalize = false): string[] {
  need(Array.isArray(raw));
  const values = raw.map(normalize ? normalizeName : text);
  if (normalize) need(new Set(values).size === values.length, 'conflict');
  return values.sort(byCodeUnit);
}
function nullableStrings(raw: unknown) {
  return raw === undefined ? null : strings(raw);
}
function selector(raw: unknown, list: string, position: number): UvSelector {
  const r = table(raw);
  need(
    Object.keys(r).every((k) => ['name', 'version', 'source', 'marker', 'extra'].includes(k)),
    'unsupported',
  );
  return {
    name: normalizeName(r.name),
    version: r.version === undefined ? null : version(r.version),
    source: r.source === undefined ? null : source(r.source),
    marker: r.marker === undefined ? null : text(r.marker),
    extra: r.extra === undefined ? null : strings(r.extra, true),
    list,
    position,
  };
}
function edges(
  raw: unknown,
  list: string,
  limits: UvParseLimits,
  budget: UvBudget,
  gaps: UvEntryGap[],
  key: string,
): UvSelector[] {
  need(Array.isArray(raw));
  const result: UvSelector[] = [];
  for (let position = 0; position < raw.length; position++) {
    try {
      debit(budget, 'edges', limits.maxEdges);
      result.push(selector(raw[position], list, position));
    } catch (error) {
      const why = reason(error);
      gaps.push({ entry: `${key}:${list}:${position}`, reason: why });
      if (why === 'budget') break;
    }
  }
  return result;
}
function packageIdentity(raw: Record<string, unknown>) {
  const name = normalizeName(raw.name),
    origin = source(raw.source);
  const resolved = raw.version === undefined ? null : version(raw.version);
  need(resolved !== null || origin.kind === 'editable');
  return { name, version: resolved, source: origin, key: JSON.stringify([name, resolved, origin]) };
}
function unknownFields(
  raw: Record<string, unknown>,
  allowed: string[],
  gaps: UvEntryGap[],
  entry: string | null,
) {
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    gaps.push({ entry, reason: 'unsupported' });
}
function requirement(raw: unknown, position: number, limits: UvParseLimits): UvLockRequirement {
  const r = table(raw);
  need(
    Object.keys(r).every((k) => ['name', 'specifier', 'extras', 'marker'].includes(k)),
    'unsupported',
  );
  const name = normalizeName(r.name),
    range = r.specifier === undefined ? null : text(r.specifier),
    marker = r.marker === undefined ? null : text(r.marker);
  parseRequirement(`${name}${range ?? ''}${marker === null ? '' : `; ${marker}`}`, limits);
  return {
    name,
    specifier: range,
    marker,
    extras: r.extras === undefined ? null : strings(r.extras, true),
    position,
  };
}
function requirements(
  raw: unknown,
  limits: UvParseLimits,
  budget: UvBudget,
  gaps: UvEntryGap[],
  key: string,
) {
  need(Array.isArray(raw));
  const result: UvLockRequirement[] = [];
  for (let position = 0; position < raw.length; position++) {
    const entry = `${key}:requires-dist:${position}`;
    // Only the cumulative counter ends the list; per-requirement limits skip one entry.
    try {
      debit(budget, 'declarations', limits.maxDeclarations);
    } catch (error) {
      gaps.push({ entry, reason: reason(error) });
      break;
    }
    try {
      result.push(requirement(raw[position], position, limits));
    } catch (error) {
      gaps.push({ entry, reason: reason(error) });
    }
  }
  return result;
}
function metadata(
  raw: unknown,
  project: boolean,
  limits: UvParseLimits,
  budget: UvBudget,
  gaps: UvEntryGap[],
  key: string,
): UvLockMetadata | null {
  // uv omits empty metadata lists, and the whole table for a project with neither.
  if (raw === undefined) return project ? { requiresDist: [], providesExtras: [] } : null;
  const r = table(raw),
    value: UvLockMetadata = { requiresDist: null, providesExtras: null };
  unknownFields(r, ['requires-dist', 'provides-extras'], gaps, `${key}:metadata`);
  try {
    value.requiresDist =
      r['requires-dist'] === undefined
        ? []
        : requirements(r['requires-dist'], limits, budget, gaps, key);
  } catch (error) {
    gaps.push({ entry: `${key}:requires-dist`, reason: reason(error) });
  }
  try {
    value.providesExtras =
      r['provides-extras'] === undefined ? [] : strings(r['provides-extras'], true);
  } catch (error) {
    gaps.push({ entry: `${key}:provides-extras`, reason: reason(error) });
  }
  return value;
}
function artifact(raw: unknown) {
  const r = table(raw);
  need(
    Object.keys(r).every((k) => ['url', 'hash', 'size', 'upload-time'].includes(k)),
    'unsupported',
  );
  url(r.url);
  if (r.hash !== undefined)
    need(
      /^(?:sha256:[a-f\d]{64}|sha384:[a-f\d]{96}|sha512:[a-f\d]{128}|md5:[a-f\d]{32})$/iu.test(
        text(r.hash),
      ),
    );
  if (r.size !== undefined) integer(r.size, Number.MAX_SAFE_INTEGER);
  if (r['upload-time'] !== undefined) {
    const date = r['upload-time'];
    need(
      (date instanceof Date && Number.isFinite(date.getTime())) ||
        (typeof date === 'string' &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(date) &&
          Number.isFinite(Date.parse(date))),
    );
  }
}
function artifacts(raw: Record<string, unknown>, gaps: UvEntryGap[], key: string) {
  try {
    if (raw.sdist !== undefined) artifact(raw.sdist);
    if (raw.wheels !== undefined) {
      need(Array.isArray(raw.wheels));
      for (const wheel of raw.wheels) artifact(wheel);
    }
  } catch (error) {
    gaps.push({ entry: `${key}:artifacts`, reason: reason(error) });
  }
}
function readPackage(
  raw: Record<string, unknown>,
  limits: UvParseLimits,
  budget: UvBudget,
  gaps: UvEntryGap[],
): UvPackage {
  const identity = packageIdentity(raw);
  const value: UvPackage = {
    ...identity,
    external: identity.source.kind !== 'editable',
    resolutionMarkers: null,
    dependencies: null,
    optionalDependencies: null,
    metadata: null,
  };
  try {
    value.resolutionMarkers = nullableStrings(raw['resolution-markers']);
  } catch (error) {
    gaps.push({ entry: `${value.key}:resolution-markers`, reason: reason(error) });
  }
  const read = (v: unknown, list: string) => edges(v, list, limits, budget, gaps, value.key);
  try {
    if (raw.dependencies !== undefined) value.dependencies = read(raw.dependencies, 'dependencies');
  } catch (error) {
    gaps.push({ entry: `${value.key}:dependencies`, reason: reason(error) });
  }
  try {
    if (raw['optional-dependencies'] !== undefined) {
      const local: UvEntryGap[] = [];
      value.optionalDependencies = optionalTable(raw['optional-dependencies'], local, read);
      gaps.push(
        ...local.map((g) => ({
          ...g,
          entry: g.entry === null ? value.key : `${value.key}:${g.entry}`,
        })),
      );
    }
  } catch (error) {
    gaps.push({ entry: `${value.key}:optional-dependencies`, reason: reason(error) });
  }
  unknownFields(
    raw,
    [
      'name',
      'version',
      'source',
      'resolution-markers',
      'dependencies',
      'optional-dependencies',
      'metadata',
      'sdist',
      'wheels',
    ],
    gaps,
    value.key,
  );
  artifacts(raw, gaps, value.key);
  try {
    value.metadata = metadata(raw.metadata, !value.external, limits, budget, gaps, value.key);
  } catch (error) {
    gaps.push({ entry: `${value.key}:metadata`, reason: reason(error) });
  }
  return value;
}
function sortKey(value: unknown): string {
  try {
    return packageIdentity(table(value)).key;
  } catch {
    return '';
  }
}
function packages(raw: unknown, limits: UvParseLimits, budget: UvBudget, gaps: UvEntryGap[]) {
  need(Array.isArray(raw));
  const values = new Map<string, UvPackage>(),
    conflicts = new Set<string>();
  const ordered = raw
    .map((item) => ({ item, key: sortKey(item) }))
    .sort((a, b) => byCodeUnit(a.key, b.key));
  for (const { item } of ordered) {
    try {
      debit(budget, 'packages', limits.maxPackages);
      const value = readPackage(table(item), limits, budget, gaps);
      if (values.has(value.key) || conflicts.has(value.key)) {
        values.delete(value.key);
        conflicts.add(value.key);
        gaps.push({ entry: value.key, reason: 'conflict' });
      } else values.set(value.key, value);
    } catch (error) {
      const why = reason(error);
      gaps.push({ entry: null, reason: why });
      if (why === 'budget') break;
    }
  }
  return [...values.values()].sort((a, b) => byCodeUnit(a.key, b.key));
}
function integer(value: unknown, max = 2 ** 32 - 1): number {
  need(typeof value === 'bigint' && value >= 0n && value <= BigInt(max));
  return Number(value);
}
function extract(
  raw: Record<string, unknown>,
  limits: UvParseLimits,
  budget: UvBudget,
): UvRead<UvLock> {
  const schema = integer(raw.version),
    revision = raw.revision === undefined ? 0 : integer(raw.revision);
  need(schema === 1 && (revision === 3 || revision === 5), 'unsupported');
  const gaps: UvEntryGap[] = [];
  const value: UvLock = {
    version: 1,
    revision,
    requiresPython: null,
    resolutionMarkers: null,
    packages: [],
  };
  unknownFields(
    raw,
    ['version', 'revision', 'requires-python', 'resolution-markers', 'package'],
    gaps,
    null,
  );
  try {
    value.requiresPython = text(raw['requires-python']);
  } catch (error) {
    gaps.push({ entry: 'requires-python', reason: reason(error) });
  }
  try {
    value.resolutionMarkers = nullableStrings(raw['resolution-markers']);
  } catch (error) {
    gaps.push({ entry: 'resolution-markers', reason: reason(error) });
  }
  try {
    value.packages = packages(raw.package, limits, budget, gaps);
  } catch (error) {
    gaps.push({ entry: 'package', reason: reason(error) });
  }
  return { kind: 'parsed', value, gaps };
}
export function readLock(
  bytes: Uint8Array,
  limits: UvParseLimits,
  budget = newBudget(),
): UvRead<UvLock> {
  const parsed = readToml(bytes, limits, budget);
  if (parsed.kind === 'unavailable') return parsed;
  try {
    return extract(parsed.value, limits, budget);
  } catch (error) {
    return { kind: 'unavailable', reason: reason(error) };
  }
}
