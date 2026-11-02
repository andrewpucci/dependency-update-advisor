import { PACKET_LIMITS } from '../schema.js';
import { byCodeUnit } from './common.js';
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

export type UvRequirement = {
  text: string;
  name: string;
  extras: string[];
  specifier: string | null;
  marker: string | null;
};
export type UvDeclaration = UvRequirement & { list: string; position: number };
export type UvExtra<T> = { extra: string; declarations: T[] };
type FieldState = 'absent' | 'present' | 'dynamic' | 'invalid';
export type UvManifest = {
  name: string;
  requiresPython: string | null;
  dependencies: UvDeclaration[];
  optionalDependencies: UvExtra<UvDeclaration>[];
  fields: { dependencies: FieldState; optionalDependencies: FieldState };
};
export function normalizeName(value: unknown): string {
  const name = text(value);
  need(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(name));
  const normalized = name.toLowerCase().replace(/[-_.]+/gu, '-');
  need(Buffer.byteLength(normalized) <= PACKET_LIMITS.identityBytes, 'unsupported');
  return normalized;
}
class Cursor {
  position = 0;
  tokens = 0;
  constructor(
    readonly source: string,
    readonly limits: UvParseLimits,
  ) {}
  space() {
    while (this.source[this.position] === ' ') this.position++;
  }
  take(pattern: RegExp): string | null {
    this.space();
    const found = pattern.exec(this.source.slice(this.position));
    if (!found) return null;
    need(++this.tokens <= this.limits.maxRequirementTokens, 'budget');
    this.position += found[0].length;
    return found[0];
  }
  expect(pattern: RegExp) {
    const value = this.take(pattern);
    need(value !== null);
    return value;
  }
  rest() {
    this.space();
    return this.source.slice(this.position);
  }
}
function extras(cursor: Cursor) {
  const out: string[] = [];
  if (!cursor.take(/^\[/u)) return out;
  need(!cursor.rest().startsWith(']'), 'unsupported');
  do {
    out.push(normalizeName(cursor.expect(/^[A-Za-z0-9._-]+/u)));
  } while (cursor.take(/^,/u));
  cursor.expect(/^\]/u);
  need(new Set(out).size === out.length, 'conflict');
  return out.sort(byCodeUnit);
}
function specifier(cursor: Cursor): string | null {
  cursor.space();
  const start = cursor.position;
  const parens = cursor.take(/^\(/u);
  if (!parens && !/^[<>=!~]/u.test(cursor.rest())) return null;
  do {
    const operator = cursor.expect(/^(?:===|~=|==|!=|<=|>=|<|>)/u);
    const version = cursor.expect(/^[A-Za-z0-9.*+!_-]+/u);
    need(operator !== '===', 'unsupported');
    // This is a lexical subset, not a Python version resolver.
    need(/^(?:[0-9]+!)?[vV]?[0-9][A-Za-z0-9.*+!_-]*$/u.test(version), 'unsupported');
    need(
      !version.includes('*') ||
        ((operator === '==' || operator === '!=') && /^\d+(?:\.\d+)*\.\*$/u.test(version)),
    );
    if (cursor.rest().startsWith(',')) need(!/^, *(?:\)|;|$)/u.test(cursor.rest()), 'unsupported');
  } while (cursor.take(/^,/u));
  if (parens) cursor.expect(/^\)/u);
  return cursor.source.slice(start, cursor.position).trim();
}
const variables = new Set([
  'python_version',
  'python_full_version',
  'os_name',
  'sys_platform',
  'platform_release',
  'platform_system',
  'platform_version',
  'platform_machine',
  'platform_python_implementation',
  'implementation_name',
  'implementation_version',
  'extra',
]);
function markerValue(cursor: Cursor) {
  const literal = cursor.take(/^(?:"[^"]*"|'[^']*')/u);
  if (literal !== null) {
    need(!/[^ -~]|\\/u.test(literal));
    return;
  }
  const variable = cursor.expect(/^[a-z_]+/u);
  need(!['extras', 'dependency_groups'].includes(variable), 'unsupported');
  need(variables.has(variable));
}
function markerOperator(cursor: Cursor) {
  const before = cursor.position,
    operator = cursor.expect(/^(?:===|~=|==|!=|<=|>=|<|>|not +in\b|in\b)/u);
  if (operator === 'in' || operator.startsWith('not'))
    need(cursor.position - before > operator.length && cursor.source[cursor.position] === ' ');
}
function marker(cursor: Cursor): string | null {
  if (!cursor.take(/^;/u)) return null;
  cursor.space();
  const start = cursor.position;
  let depth = 0,
    operand = true;
  while (cursor.rest()) {
    if (operand) {
      if (cursor.take(/^\(/u)) {
        need(++depth <= cursor.limits.maxMarkerDepth, 'budget');
        continue;
      }
      markerValue(cursor);
      markerOperator(cursor);
      markerValue(cursor);
      operand = false;
    } else if (cursor.take(/^\)/u)) {
      need(depth > 0);
      depth--;
    } else {
      cursor.expect(/^(?:and|or)\b/u);
      operand = true;
    }
  }
  need(!operand && depth === 0);
  return cursor.source.slice(start).trim();
}

/** Tested name-based PyPA syntax only; no URL resolution, marker evaluation or version solving. */
export function parseRequirement(value: unknown, limits: UvParseLimits): UvRequirement {
  const raw = text(value);
  need(Buffer.byteLength(raw) <= limits.maxStringBytes, 'budget');
  const cursor = new Cursor(raw, limits);
  const name = normalizeName(cursor.expect(/^[A-Za-z0-9._-]+/u));
  const requested = extras(cursor);
  need(!cursor.rest().startsWith('@'), 'unsupported');
  const range = specifier(cursor),
    condition = marker(cursor);
  need(!cursor.rest());
  return { text: raw, name, extras: requested, specifier: range, marker: condition };
}
export function optionalTable<T>(
  raw: unknown,
  gaps: UvEntryGap[],
  read: (value: unknown, list: string) => T[],
): UvExtra<T>[] {
  const entries = Object.entries(table(raw)).sort(([a], [b]) => byCodeUnit(a, b));
  const grouped = new Map<string, unknown[]>();
  for (const [key, value] of entries) {
    try {
      const name = normalizeName(key);
      grouped.set(name, [...(grouped.get(name) ?? []), value]);
    } catch (error) {
      gaps.push({ entry: null, reason: reason(error) });
    }
  }
  const result: UvExtra<T>[] = [];
  for (const [extra, values] of [...grouped].sort(([a], [b]) => byCodeUnit(a, b))) {
    const entry = `optional:${extra}`;
    if (values.length > 1) {
      gaps.push({ entry, reason: 'conflict' });
      continue;
    }
    try {
      result.push({ extra, declarations: read(values[0], entry) });
    } catch (error) {
      gaps.push({ entry, reason: reason(error) });
    }
  }
  return result;
}
function declarations(
  raw: unknown,
  list: string,
  limits: UvParseLimits,
  budget: UvBudget,
  gaps: UvEntryGap[],
) {
  need(Array.isArray(raw));
  const out: UvDeclaration[] = [];
  for (let position = 0; position < raw.length; position++) {
    const entry = `${list}:${position}`;
    // Only the cumulative counter ends the list; per-requirement limits skip one entry.
    try {
      debit(budget, 'declarations', limits.maxDeclarations);
    } catch (error) {
      gaps.push({ entry, reason: reason(error) });
      break;
    }
    try {
      out.push({ ...parseRequirement(raw[position], limits), list, position });
    } catch (error) {
      gaps.push({ entry, reason: reason(error) });
    }
  }
  return out;
}
function dynamicFields(project: Record<string, unknown>, gaps: UvEntryGap[]): Set<string> | null {
  if (project.dynamic === undefined) return new Set<string>();
  try {
    need(Array.isArray(project.dynamic));
    const fields = project.dynamic.map(text);
    for (const field of fields.filter((f) => ['dependencies', 'optional-dependencies'].includes(f)))
      gaps.push({ entry: field, reason: 'unsupported' });
    return new Set(fields);
  } catch (error) {
    gaps.push({ entry: 'dynamic', reason: reason(error) });
    return null;
  }
}
function resolutionGaps(
  raw: Record<string, unknown>,
  project: Record<string, unknown>,
  gaps: UvEntryGap[],
) {
  const allowed = new Set([
    'name',
    'version',
    'description',
    'readme',
    'requires-python',
    'license',
    'license-files',
    'authors',
    'maintainers',
    'keywords',
    'classifiers',
    'urls',
    'scripts',
    'gui-scripts',
    'entry-points',
    'dependencies',
    'optional-dependencies',
    'dynamic',
  ]);
  if (Object.keys(project).some((key) => !allowed.has(key)))
    gaps.push({ entry: 'project', reason: 'unsupported' });
  if (Object.keys(raw).some((key) => !['project', 'build-system', 'tool'].includes(key)))
    gaps.push({ entry: null, reason: 'unsupported' });
  if (raw.tool !== undefined) {
    try {
      const tool = table(raw.tool);
      if (tool.uv !== undefined && Object.keys(table(tool.uv)).length)
        gaps.push({ entry: 'tool.uv', reason: 'unsupported' });
    } catch (error) {
      gaps.push({ entry: 'tool.uv', reason: reason(error) });
    }
  }
}
function readManifestField(
  project: Record<string, unknown>,
  field: string,
  key: keyof UvManifest['fields'],
  value: UvManifest,
  dynamic: Set<string> | null,
  gaps: UvEntryGap[],
  read: (v: unknown, list: string) => UvDeclaration[],
) {
  const state =
    dynamic === null
      ? 'invalid'
      : dynamic.has(field)
        ? 'dynamic'
        : project[field] === undefined
          ? 'absent'
          : 'present';
  value.fields[key] = state;
  if (project[field] === undefined) return;
  // PyPA forbids listing a field in `dynamic` while also giving it statically.
  if (state === 'dynamic') {
    value.fields[key] = 'invalid';
    gaps.push({ entry: field, reason: 'conflict' });
    return;
  }
  try {
    if (key === 'dependencies') value.dependencies = read(project[field], field);
    else value.optionalDependencies = optionalTable(project[field], gaps, read);
  } catch (error) {
    value.fields[key] = 'invalid';
    gaps.push({ entry: field, reason: reason(error) });
  }
}
function extract(
  raw: Record<string, unknown>,
  limits: UvParseLimits,
  budget: UvBudget,
): UvRead<UvManifest> {
  const project = table(raw.project),
    gaps: UvEntryGap[] = [];
  resolutionGaps(raw, project, gaps);
  const name = normalizeName(project.name),
    dynamic = dynamicFields(project, gaps);
  const value: UvManifest = {
    name,
    requiresPython: null,
    dependencies: [],
    optionalDependencies: [],
    fields: { dependencies: 'absent', optionalDependencies: 'absent' },
  };
  try {
    if (project['requires-python'] !== undefined)
      value.requiresPython = text(project['requires-python']);
  } catch (error) {
    gaps.push({ entry: 'requires-python', reason: reason(error) });
  }
  const read = (v: unknown, list: string) => declarations(v, list, limits, budget, gaps);
  readManifestField(project, 'dependencies', 'dependencies', value, dynamic, gaps, read);
  readManifestField(
    project,
    'optional-dependencies',
    'optionalDependencies',
    value,
    dynamic,
    gaps,
    read,
  );
  return { kind: 'parsed', value, gaps };
}
export function readManifest(
  bytes: Uint8Array,
  limits: UvParseLimits,
  budget = newBudget(),
): UvRead<UvManifest> {
  const parsed = readToml(bytes, limits, budget);
  if (parsed.kind === 'unavailable') return parsed;
  try {
    return extract(parsed.value, limits, budget);
  } catch (error) {
    return { kind: 'unavailable', reason: reason(error) };
  }
}
