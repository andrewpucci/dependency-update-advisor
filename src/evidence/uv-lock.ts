import { byCodeUnit } from './common.js';
import { normalizeName, optionalTable, type UvExtra } from './uv-manifest.js';
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
export type UvPackage = {
  key: string;
  name: string;
  version: string | null;
  source: UvSource;
  external: boolean;
  resolutionMarkers: string[] | null;
  dependencies: UvSelector[] | null;
  optionalDependencies: UvExtra<UvSelector>[] | null;
};
export type UvLock = {
  version: 1;
  revision: 3 | 5;
  requiresPython: string;
  resolutionMarkers: string[] | null;
  packages: UvPackage[];
};
function url(value: unknown): string {
  const raw = text(value),
    parsed = new URL(raw);
  need(
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
  need(/^[A-Za-z0-9][A-Za-z0-9.!+_-]*$/u.test(raw));
  return raw;
}
function strings(raw: unknown, normalize = false): string[] {
  need(Array.isArray(raw));
  const values = raw.map(normalize ? normalizeName : text);
  if (normalize) need(new Set(values).size === values.length, 'conflict');
  return normalize ? values.sort(byCodeUnit) : values;
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
  return value;
}
function sortKey(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const r = value as Record<string, unknown>;
  return JSON.stringify([r.name ?? null, r.version ?? null, r.source ?? null]);
}
function packages(raw: unknown, limits: UvParseLimits, budget: UvBudget, gaps: UvEntryGap[]) {
  need(Array.isArray(raw));
  const values = new Map<string, UvPackage>(),
    conflicts = new Set<string>();
  for (const item of [...raw].sort((a, b) => byCodeUnit(sortKey(a), sortKey(b)))) {
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
function extract(
  raw: Record<string, unknown>,
  limits: UvParseLimits,
  budget: UvBudget,
): UvRead<UvLock> {
  need(Number.isSafeInteger(raw.version) && (raw.version as number) > 0);
  const revision = raw.revision === undefined ? 0 : raw.revision;
  need(Number.isSafeInteger(revision) && (revision as number) >= 0);
  need(raw.version === 1 && (revision === 3 || revision === 5), 'unsupported');
  const gaps: UvEntryGap[] = [];
  const value: UvLock = {
    version: 1,
    revision,
    requiresPython: text(raw['requires-python']),
    resolutionMarkers: null,
    packages: [],
  };
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
