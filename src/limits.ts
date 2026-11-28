export type LimitUnit = 'bytes' | 'code units' | 'milliseconds' | 'minutes' | 'count' | 'tokens';

/** Marks a field the migration has not filled yet; none may remain after phase 2. */
export const PENDING_AUDIT = 'pending: L7 audit';

/** How a probed platform figure is reproduced; it never names the probed repository. */
export type ExternalProbe = {
  /** `npm run <script>` alone: the arguments name the test repository. */
  command: string;
  /** Visibility and owner type, such as "private, user-owned, github.com". */
  repositoryType: string;
};

export type LimitBasis =
  | {
      kind: 'external';
      /** The page that states the figure, or the public probe record for a probed one. */
      url: string;
      /** `YYYY-MM-DD` (UTC) on which the page was read or the probe was run. */
      checked: string;
      platformValue: number;
      margin: string;
      probe?: ExternalProbe;
    }
  | {
      kind: 'derived';
      inputs: readonly string[];
      formula: (...values: number[]) => number;
      description: string;
      /** Set when the code's shape bounds the value; names the test that pins it. */
      structuralTest?: string;
    }
  | {
      kind: 'measured';
      command: string;
      corpus: string;
      statistic: string;
      headroom: string;
      measured: string;
    }
  | { kind: 'safety'; reason: string }
  | {
      /**
       * An adopter setting (SPEC-limit-register section 5): `value` is its default, today's value,
       * and `configurable` names the setting and the register entries that bound it.
       */
      kind: 'config';
      /** Who bears the trade-off, the first condition of section 5. */
      bears: string;
      /** The approval that admitted the setting, with its date and issue. */
      approved: string;
    }
  | { kind: 'unjustified'; note: string };

/**
 * The adopter setting a `config` entry stands for. The bounds are register ids, so a bound derived
 * from other entries moves with them; `limit()` gives the default, and the run-time value is the
 * adopter's setting once L12's parser reads it.
 */
export type LimitSetting = {
  /** The config key L12 adds; provisional until the parser lands. */
  setting: string;
  default: number;
  /** The entry whose value is the hard maximum; the parser rejects a larger setting. */
  maximum: string;
  /** The entry whose value is the hard minimum, when one exists; otherwise the minimum is 1. */
  minimum?: string;
  /**
   * Set when the hard maximum bounds the sum of every setting that names it, as the GitHub request
   * cap bounds its shares together.
   */
  joint?: boolean;
};

export type LimitDefinition = {
  id: string;
  /** Required unless the basis is derived; a derived value is computed, never written. */
  value?: number;
  unit: LimitUnit;
  protects: string;
  basis: LimitBasis;
  effect: string;
  /** `<test file> > <test title>`, or `none: <reason>`, or PENDING_AUDIT. */
  test: string;
  /** Set exactly when the basis is `config`. */
  configurable?: LimitSetting;
};

export type Limit = LimitDefinition & { value: number };

const BASIS_KINDS: readonly string[] = [
  'external',
  'derived',
  'measured',
  'safety',
  'config',
  'unjustified',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function entryProblems(entry: unknown, index: number): string[] {
  if (!isRecord(entry) || typeof entry.id !== 'string') {
    return [`entry #${index}: id missing or not a string`];
  }
  return basisProblems(entry, entry.id);
}

function basisProblems(entry: Record<string, unknown>, id: string): string[] {
  const kind = isRecord(entry.basis) ? entry.basis.kind : undefined;
  if (typeof kind !== 'string' || !BASIS_KINDS.includes(kind)) {
    return [`${id}: unknown basis kind ${JSON.stringify(kind)}`];
  }
  if (kind === 'derived') {
    return entry.value === undefined ? [] : [`${id}: derived entries must not set value`];
  }
  const hasValue = typeof entry.value === 'number' && Number.isFinite(entry.value);
  return [
    ...(hasValue ? [] : [`${id}: value must be a finite number`]),
    ...settingShapeProblems(entry, id, kind),
  ];
}

/** A `config` entry carries its setting, its default is its value, and no other entry has one. */
function settingShapeProblems(entry: Record<string, unknown>, id: string, kind: string): string[] {
  const setting = entry.configurable;
  if (kind !== 'config') {
    return setting === undefined ? [] : [`${id}: only a config entry may set configurable`];
  }
  if (!isRecord(setting) || typeof setting.setting !== 'string') {
    return [`${id}: a config entry needs configurable with its setting`];
  }
  return [
    ...(setting.default === entry.value ? [] : [`${id}: the setting default must equal value`]),
    ...(typeof setting.maximum === 'string' ? [] : [`${id}: the setting needs a hard maximum`]),
  ];
}

function settingBounds(entry: unknown): unknown[] {
  if (!isRecord(entry) || !isRecord(entry.configurable)) return [];
  const { maximum, minimum } = entry.configurable;
  return minimum === undefined ? [maximum] : [maximum, minimum];
}

function boundProblems(definitions: readonly unknown[], known: ReadonlySet<string>): string[] {
  return definitions.flatMap((entry) =>
    settingBounds(entry)
      .filter((bound) => typeof bound !== 'string' || !known.has(bound))
      .map(
        (bound) =>
          `${isRecord(entry) ? String(entry.id) : '?'}: setting bound ${JSON.stringify(bound)} is not defined`,
      ),
  );
}

function duplicateProblems(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
  }
  return problems;
}

function derivedInputs(entry: Record<string, unknown>): unknown[] {
  const basis = isRecord(entry.basis) ? entry.basis : {};
  return Array.isArray(basis.inputs) ? basis.inputs : [];
}

function isDerived(entry: unknown): entry is Record<string, unknown> & { id: string } {
  return (
    isRecord(entry) &&
    typeof entry.id === 'string' &&
    isRecord(entry.basis) &&
    entry.basis.kind === 'derived'
  );
}

function inputProblems(definitions: readonly unknown[], known: ReadonlySet<string>): string[] {
  return definitions.filter(isDerived).flatMap((entry) =>
    derivedInputs(entry)
      .filter((input) => typeof input !== 'string' || !known.has(input))
      .map((input) => `${entry.id}: derived input ${JSON.stringify(input)} is not defined`),
  );
}

function derivedGraph(definitions: readonly unknown[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const entry of definitions.filter(isDerived)) {
    const inputs = derivedInputs(entry).filter(
      (input): input is string => typeof input === 'string',
    );
    graph.set(entry.id, inputs);
  }
  return graph;
}

/** Every id reachable from `start` by following one or more derived-input edges. */
function reachable(graph: ReadonlyMap<string, readonly string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const pending = [...(graph.get(start) ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(graph.get(next) ?? []));
  }
  return seen;
}

function cycleProblems(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const reported = new Set<string>();
  const problems: string[] = [];
  for (const id of graph.keys()) {
    if (reported.has(id) || !reachable(graph, id).has(id)) continue;
    const members = [...reachable(graph, id)]
      .filter((other) => reachable(graph, other).has(id))
      .sort();
    for (const member of members) reported.add(member);
    problems.push(`derived cycle: ${members.join(' -> ')}`);
  }
  return problems;
}

export function checkRegister(definitions: readonly unknown[]): string[] {
  const ids = definitions.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : [],
  );
  const known = new Set(ids);
  return [
    ...definitions.flatMap((entry, index) => entryProblems(entry, index)),
    ...duplicateProblems(ids),
    ...inputProblems(definitions, known),
    ...boundProblems(definitions, known),
    ...cycleProblems(derivedGraph(definitions)),
  ];
}

function resolveValues(
  definitions: readonly LimitDefinition[],
  settings: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const values = new Map<string, number>();
  const valueOfId = (id: string): number => {
    const known = values.get(id);
    if (known !== undefined) return known;
    const definition = byId.get(id);
    if (definition === undefined) throw new Error(`unknown limit id: ${id}`);
    const { basis } = definition;
    const value =
      basis.kind === 'derived'
        ? basis.formula(...basis.inputs.map(valueOfId))
        : (settings.get(id) ?? definition.value);
    if (value === undefined) throw new Error(`limit ${id} has no value`);
    values.set(id, value);
    return value;
  };
  for (const definition of definitions) valueOfId(definition.id);
  return values;
}

/**
 * The register with each named adopter setting in place of its default. Derived entries follow
 * the settings they derive from (SPEC-limit-register section 5, approved 2026-11-27, #383), so
 * this is the value set a run with those settings uses. Only `config` entries may be set.
 */
export function buildRegister(
  definitions: readonly LimitDefinition[],
  settings: ReadonlyMap<string, number> = new Map(),
): ReadonlyMap<string, Limit> {
  const problems = checkRegister(definitions);
  for (const id of settings.keys()) {
    const definition = definitions.find((entry) => entry.id === id);
    if (definition?.basis.kind !== 'config') problems.push(`${id}: not an adopter setting`);
  }
  if (problems.length > 0) {
    throw new Error(`invalid limit register:\n${problems.join('\n')}`);
  }
  const values = resolveValues(definitions, settings);
  return new Map(
    definitions.map((definition): [string, Limit] => [
      definition.id,
      Object.freeze({ ...definition, value: values.get(definition.id) ?? Number.NaN }),
    ]),
  );
}

function inputsOf(definition: Limit): readonly string[] {
  return definition.basis.kind === 'derived' ? definition.basis.inputs : [];
}

export function dependents(register: ReadonlyMap<string, Limit>, id: string): string[] {
  const found = new Set<string>();
  const pending = [id];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const entry of register.values()) {
      if (inputsOf(entry).includes(current) && !found.has(entry.id)) {
        found.add(entry.id);
        pending.push(entry.id);
      }
    }
  }
  return [...found].sort();
}

function settingProblemsAt(register: ReadonlyMap<string, Limit>, where: string): string[] {
  const valueOf = (id: string | undefined) =>
    id === undefined ? 1 : (register.get(id)?.value ?? Number.NaN);
  const joint = new Map<string, Limit[]>();
  const problems: string[] = [];
  for (const entry of register.values()) {
    if (!Number.isFinite(entry.value)) problems.push(`${entry.id}: not finite ${where}`);
    const setting = entry.configurable;
    if (setting === undefined) continue;
    if (entry.value < valueOf(setting.minimum))
      problems.push(`${entry.id}: below its hard minimum ${where}`);
    if (setting.joint === true) {
      joint.set(setting.maximum, [...(joint.get(setting.maximum) ?? []), entry]);
    } else if (entry.value > valueOf(setting.maximum)) {
      problems.push(`${entry.id}: above its hard maximum ${where}`);
    }
  }
  for (const [maximum, members] of joint) {
    const total = members.reduce((sum, member) => sum + member.value, 0);
    if (total > valueOf(maximum))
      problems.push(`${maximum}: the settings it bounds sum past it ${where}`);
  }
  return problems;
}

/** Whether a setting's own bound holds in a register evaluated at the settings. */
function withinMaximum(register: ReadonlyMap<string, Limit>, id: string): boolean {
  const setting = register.get(id)?.configurable;
  if (setting === undefined) return true;
  const maximum = register.get(setting.maximum)?.value ?? Number.NaN;
  const value =
    setting.joint === true
      ? [...register.values()]
          .filter((other) => other.configurable?.maximum === setting.maximum)
          .reduce((sum, other) => sum + other.value, 0)
      : (register.get(id)?.value ?? Number.NaN);
  return value <= maximum;
}

/**
 * Checks every adopter setting at its default and at its hard maximum (SPEC-limit-register
 * section 5, approved 2026-11-27, #383): each setting stays within its bounds, a joint maximum
 * holds over the sum of its settings, and every derived value stays finite. A setting is raised
 * alone, with the others at their defaults; a joint setting is raised to what its maximum leaves
 * after the others' defaults. A maximum is read from the register evaluated at the settings, so
 * when it falls as its own setting rises (the response cap's heap maximum does, through the
 * off-heap buffers), the hard maximum is the largest setting that still holds, found by
 * bisection (approved 2026-11-28, #383).
 */
export function settingProblems(register: ReadonlyMap<string, Limit>): string[] {
  // A built register carries each derived entry's resolved value; a definition must not.
  const definitions = [...register.values()].map(({ value, ...entry }): LimitDefinition =>
    entry.basis.kind === 'derived' ? entry : { ...entry, value },
  );
  const defaults = buildRegister(definitions);
  const problems = settingProblemsAt(defaults, 'at the defaults');
  for (const entry of defaults.values()) {
    if (entry.configurable === undefined) continue;
    const highest = hardMaximum(defaults, entry.id);
    if (!Number.isFinite(highest)) {
      problems.push(`${entry.id}: no setting holds its hard maximum at the defaults`);
      continue;
    }
    const raised = buildRegister(definitions, new Map([[entry.id, highest]]));
    problems.push(...settingProblemsAt(raised, `with ${entry.id} at its hard maximum`));
  }
  return problems;
}

/** The largest value a setting may take, other settings at their defaults; see settingProblems. */
export function hardMaximum(register: ReadonlyMap<string, Limit>, id: string): number {
  const definitions = [...register.values()].map(({ value, ...entry }): LimitDefinition =>
    entry.basis.kind === 'derived' ? entry : { ...entry, value },
  );
  const entry = register.get(id);
  const setting = entry?.configurable;
  if (entry === undefined || setting === undefined) return Number.NaN;
  const at = (value: number) => buildRegister(definitions, new Map([[id, value]]));
  const others = [...register.values()]
    .filter(
      (other) =>
        setting.joint === true &&
        other.id !== id &&
        other.configurable?.maximum === setting.maximum,
    )
    .reduce((sum, other) => sum + other.value, 0);
  let highest = Math.floor((register.get(setting.maximum)?.value ?? Number.NaN) - others);
  if (withinMaximum(at(highest), id)) return highest;
  let low = entry.value;
  if (!withinMaximum(at(low), id)) return Number.NaN;
  while (highest - low > 1) {
    const middle = Math.floor((low + highest) / 2);
    if (withinMaximum(at(middle), id)) low = middle;
    else highest = middle;
  }
  return low;
}

const MiB = 1024 * 1024;
/**
 * Tags a package's target-release stage tries: `v<version>` and `<version>`, or one
 * `<name>@<version>` in a monorepo (`packageTags`, src/evidence/upstream-github.ts:508).
 */
export const UPSTREAM_TAG_CANDIDATES = 2;

/**
 * Structural maxima of the fixed strings T5 writes into decision units (src/units.ts) and of
 * the defaults a parsed config adds (src/config.ts). src/units.test.ts pins each one against the
 * code it comes from, so a new category, reason or action text fails that test until this
 * changes with it.
 */
export const UNIT_TEXT = Object.freeze({
  /** Evidence categories one change may carry: 3 required, installScript, 4 optional signals. */
  categories: 8,
  categoryBytes: 13,
  /** Evidence reasons (EVIDENCE_REASONS) and the longest of them. */
  reasons: 10,
  reasonBytes: 11,
  /** JSON.stringify of all ten reasons, the longest reason list a limit can carry. */
  reasonsJsonBytes: 115,
  statusBytes: 11,
  ecosystemBytes: 7,
  kindBytes: 12,
  groupingReasonBytes: 23,
  nextActionBytes: 110,
  /** The longest reachability outcome, or `missing` when none is recorded. */
  outcomeBytes: 11,
  sideBytes: 4,
  /** A UTF-16 code unit is at most 3 UTF-8 bytes; a JSON escape of `"` or `\\` is 2. */
  utf8BytesPerCodeUnit: 3,
  /** Number.MAX_SAFE_INTEGER has 16 digits. */
  safeIntegerDigits: 16,
  shaHexDigits: 40,
  /** String bytes and values a parsed config adds as defaults beyond its own text. */
  configDefaultBytes: 199,
  configDefaultEntries: 28,
});

/**
 * The most relationship limits T5 can write: a change not grouped with one of k changed direct
 * anchors gets one limit per other anchor and side (src/units.ts, excludeAnchor), at most
 * 2 (n − k)(k − 1) over n changes, which is largest with k in the middle of n.
 */
export const maxRelationshipLimits = (changes: number): number =>
  2 * Math.floor((changes - 1) / 2) * Math.ceil((changes - 1) / 2);

/**
 * String bytes T5 derives beyond copies of packet strings (src/units.ts): per member and
 * evidence category, the link and source ids, the member id, category, second status, reason
 * and signal, and the coverage limits written twice; per member, its id in members, memberIds
 * and the unit id; per unit, the unit id's fixed fields, ecosystem, kind, anchor and its
 * grouping text; every relationship limit; and the frame of every ambiguous-anchor limit.
 */
export function unitDerivedBytes(
  changes: number,
  relationships: number,
  idCodeUnits: number,
  identityBytes: number,
): number {
  const t = UNIT_TEXT;
  const id = Math.min(identityBytes, t.utf8BytesPerCodeUnit * idCodeUnits);
  const coverageLimit = id + t.categoryBytes + t.statusBytes + t.reasonBytes + 13;
  const perCategory =
    2 * (id + t.categoryBytes + 7) +
    id +
    2 * t.categoryBytes +
    t.statusBytes +
    t.reasonBytes +
    2 * t.reasons * coverageLimit;
  const perMember = 3 * id + t.ecosystemBytes + 3;
  const perUnit =
    2 * identityBytes +
    2 * id +
    2 * t.ecosystemBytes +
    2 * t.kindBytes +
    t.groupingReasonBytes +
    t.nextActionBytes +
    2 * t.safeIntegerDigits +
    2 * t.shaHexDigits +
    27;
  const relationshipLimit = 2 * id + t.sideBytes + t.outcomeBytes + t.reasonsJsonBytes + 29;
  const ambiguousFrame = 2 * id + 30;
  return (
    changes * (t.categories * perCategory + perMember + perUnit) +
    maxRelationshipLimits(changes) * relationshipLimit +
    relationships * ambiguousFrame
  );
}

/**
 * Values T5 derives beyond copies of packet values: per member and category, the link and
 * source records with their scalars and both coverage-limit lists; per member, its members
 * record and memberIds entry; per unit, the unit record and its fields; every proof and verdict
 * key; and every relationship and ambiguous-anchor limit.
 */
export function unitDerivedEntries(
  changes: number,
  relationships: number,
  reachability: number,
): number {
  const t = UNIT_TEXT;
  const perCategory = 13 + 2 * t.reasons;
  const perMember = 7;
  const perUnit = 18;
  return (
    changes * (t.categories * perCategory + perMember + perUnit) +
    relationships +
    reachability +
    maxRelationshipLimits(changes) +
    relationships
  );
}
const sum = (...values: number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * The largest reply body a completion budget allows: each completion token at most
 * `limit:analysis.maxTokenEscapedBytes` of JSON-escaped content, plus the envelope allowance.
 * `limit:analysis.responseBytes` derives from it, and preparation checks caller limits against
 * it (src/analysis/projection.ts), so the formula is written once.
 */
export const replyBytesFor = (
  completionTokens: number,
  maxTokenEscapedBytes: number,
  responseEnvelopeBytes: number,
): number => completionTokens * maxTokenEscapedBytes + responseEnvelopeBytes;

/**
 * The old-generation heap a runner with `memory` bytes leaves the reviewer: its memory less the
 * young generation, the off-heap buffers, the runtime baseline and what the runner OS and agent
 * keep. `limit:runner.heapBytes` applies it to the smallest runner; the action's relaunch
 * (src/relaunch.ts) applies it to the runner it is on, so the formula is written once.
 */
export const heapBytesFor = (
  memory: number,
  youngGeneration: number,
  offHeap: number,
  baseline: number,
  reserved: number,
): number => memory - youngGeneration - offHeap - baseline - reserved;

const copy = (value: number): number => value;

/** What the audit (L7) found for an entry; a field it has not filled stays PENDING_AUDIT. */
type Audit = Readonly<{ protects?: string; effect?: string; test?: string; note?: string }>;

/** A hand-picked value with no recorded basis yet; `note` says what would supply one. */
function unjustified<const Id extends string>(
  id: Id,
  value: number,
  unit: LimitUnit,
  audit: Audit = {},
) {
  return {
    id,
    value,
    unit,
    protects: audit.protects ?? PENDING_AUDIT,
    effect: audit.effect ?? PENDING_AUDIT,
    basis: { kind: 'unjustified', note: audit.note ?? PENDING_AUDIT },
    test: audit.test ?? PENDING_AUDIT,
  } as const;
}

/** A workflow job's `timeout-minutes`; the workflow file is checked by check:limits, not by a test. */
function unjustifiedWorkflow<const Id extends string>(id: Id, value: number, audit: Audit = {}) {
  return {
    id,
    value,
    unit: 'minutes',
    protects: audit.protects ?? PENDING_AUDIT,
    effect: audit.effect ?? PENDING_AUDIT,
    basis: { kind: 'unjustified', note: audit.note ?? PENDING_AUDIT },
    test: audit.test ?? 'none: checked against the workflow file by check:limits (L6)',
  } as const;
}

/** A value computed from other entries; `description` states the relation in words. */
function derived<const Id extends string>(
  id: Id,
  unit: LimitUnit,
  inputs: readonly string[],
  formula: (...values: number[]) => number,
  description: string,
  audit: Audit = {},
) {
  return {
    id,
    unit,
    protects: audit.protects ?? PENDING_AUDIT,
    effect: audit.effect ?? PENDING_AUDIT,
    basis: { kind: 'derived', inputs, formula, description },
    test: audit.test ?? PENDING_AUDIT,
  } as const;
}

/** The 2026-11-27 approval of the L11 recommendations (#383), which admitted these settings. */
const L11_APPROVAL = 'approved by the maintainer on 2026-11-27 (L11, #383)';

/**
 * An adopter setting (SPEC-limit-register section 5): `value` is its default, today's value, and
 * the bounds name register entries. L12 (#384) adds the setting to the config contract, the
 * schema and the parser; until then every run uses the default.
 */
function configured<const Id extends string>(
  id: Id,
  value: number,
  unit: LimitUnit,
  setting: Omit<LimitSetting, 'default'>,
  bears: string,
  audit: Required<Omit<Audit, 'note'>>,
) {
  return {
    id,
    value,
    unit,
    protects: audit.protects,
    effect: audit.effect,
    basis: { kind: 'config', bears, approved: L11_APPROVAL },
    configurable: { ...setting, default: value },
    test: audit.test,
  } as const;
}

/** Research shares that scale with the change; each maps to the allocation entry that caps it. */
const SCALED_SHARES = {
  upstream: 'evidence.allocation.upstream',
  advisory: 'evidence.allocation.advisory',
  'signals.malware': 'evidence.allocation.signals.readers.malware',
  'signals.publishTimes': 'evidence.allocation.signals.readers.publishTimes',
  'signals.registry': 'evidence.allocation.signals.readers.registry',
  'signals.metadata': 'evidence.allocation.signals.readers.metadata',
  'signals.upstream': 'evidence.allocation.signals.readers.upstream',
} as const;
type ScaledShare = keyof typeof SCALED_SHARES;
const SHARE_DIMENSIONS = { requests: 'maxRequests', bytes: 'maxTotalBytes' } as const;
type ShareDimension = keyof typeof SHARE_DIMENSIONS;
/** Member-role units every scaled share takes a rate for; signals readers also rate `eligible`. */
const ROLE_UNITS = ['direct', 'transitive', 'added', 'removed'] as const;
type ShareUnit = (typeof ROLE_UNITS)[number] | 'eligible';

const SHARE_FORMULA_TEST =
  'src/budget.test.ts > a share is its base plus each rate times its count, rounded up, under its ceiling';
const SHARE_CEILING_TEST =
  'src/budget.test.ts > shares the fit keeps at their ceilings stay there for any change';
const SHARE_FIT_TEST =
  'src/budget.test.ts > the fitted values give a one-member change a smaller share than R1 #276';
const SHARE_SIZED_TEST =
  'src/budget.test.ts > the upstream byte and PyPI metadata shares grow with uv members up to their ceilings';

/** The B12 demand fit, approved by the user on 2026-11-26 (#370 comment 7197038235). */
const B12_FIT = {
  command: 'npm run measure:demand (MEASURE_SCALE=10)',
  corpus: "this repository's Dependabot PRs at 66a21f8, C10 remeasure (#397)",
  headroom: '1.25× measured demand on every uncensored PR',
  measured: '2026-11-26',
} as const;
const FIT_NOTE =
  'the B12 fit approved 2026-11-26 (#370) keeps this dimension at its ceiling with every rate at 0';
const FIT_BASE_STATISTIC =
  '1.25 × the highest measured demand among the one-to-three-member PRs (#123 and #172), rounded up';
const FIT_RATE_STATISTIC =
  'the smallest rate giving every uncensored PR 1.25 × its measured demand, rounded up to the next 0.1; upstream gives direct and transitive the same rate';
const FIT_ZERO_STATISTIC = {
  role: 'the fit sets this rate to 0: every member is direct or transitive, so those rates carry the scaling and added and removed add nothing',
  signals:
    'the fit sets this rate to 0: a signals reader scales with its own eligible members, and malware also with its direct members',
} as const;

type FittedShare = Readonly<{ base: number; rates: Readonly<Partial<Record<ShareUnit, number>>> }>;

/**
 * The B12 fit's request bases and non-zero rates. A fitted share's other rates are 0. Every share
 * and dimension not listed keeps its base at its ceiling with every rate at 0. The advisory and
 * malware rates are sized from request costs instead (`COST_SIZED`).
 */
const FITTED_REQUESTS: Readonly<Partial<Record<ScaledShare, FittedShare>>> = {
  upstream: { base: 9, rates: { direct: 5.9, transitive: 5.9 } },
  advisory: { base: 3, rates: { direct: 3, transitive: 2 } },
  'signals.malware': { base: 2, rates: { direct: 2, eligible: 1 } },
  'signals.publishTimes': { base: 2, rates: { eligible: 1.2 } },
};

type MeasuredBasis = Readonly<{
  command: string;
  corpus: string;
  statistic: string;
  headroom: string;
  measured: string;
}>;

const COSTS_TEST = 'npx vp test run src/evidence/advisory-read.costs.test.ts';
const PER_TARGET =
  'per-target lookup in src/evidence/advisory-read.ts (`query`: OSV for pip reviewed, else `discover` for non-npm targets, then `versioned`)';

/**
 * Advisory and malware rates sized from the unbatched per-target request cost rather than fitted
 * from the corpus, so a change whose batches fail, or are not used, still fits its share. Approved
 * by the user on 2026-11-26 in the B12 thread (#370). An incomplete batch settles nothing, so its
 * targets fall back to these per-target lookups (`settle`, `discoveryBatch`); pip reviewed lookups
 * always go to OSV one target at a time. Actions and pip members are direct.
 */
const COST_SIZED: Readonly<
  Partial<Record<ScaledShare, Partial<Record<ShareUnit, Omit<MeasuredBasis, 'measured'>>>>>
> = {
  advisory: {
    direct: {
      command: COSTS_TEST,
      corpus: `one Actions update (base and head) in the costs test, read through the ${PER_TARGET}, whose discovery reads base and head share; S1's Group capacity statement`,
      statistic:
        'an Actions reviewed lookup takes 3 requests per update: one stored-name discovery, then a versioned query for each of base and head',
      headroom: 'none beyond the per-update cost',
    },
    transitive: {
      command: COSTS_TEST,
      corpus: `one npm and one pip update (base and head) in the costs test, read through the ${PER_TARGET}`,
      statistic:
        'an unbatched npm or pip reviewed lookup takes 2 requests per member: one versioned GitHub query or one OSV query for each of base and head',
      headroom: 'none beyond the per-member cost; a paged response takes more',
    },
  },
  'signals.malware': {
    direct: {
      command: COSTS_TEST,
      corpus: `one Actions update in the costs test, read through the ${PER_TARGET}, which reads the proposed side only; Actions malware is never batched`,
      statistic:
        'an Actions or pip malware lookup takes 2 requests: one stored-name discovery, then the versioned query',
      headroom: 'none beyond the per-member cost; the eligible rate adds to it',
    },
    eligible: {
      command: COSTS_TEST,
      corpus: `one npm update in the costs test, read through the ${PER_TARGET}, which reads the proposed side only`,
      statistic:
        'an unbatched npm malware lookup takes 1 request per member: the versioned query for the proposed side; the direct rate covers the second request of an Actions or pip lookup',
      headroom: 'none beyond the per-member cost; a paged response takes more',
    },
  },
};

/** The #462 measurement of four real uv changes, which sized the #467 values. */
const UV_MEASURE = {
  command: 'npm run measure:demand (MEASURE_SCALE=10, with research.maxJsonEntries scaled)',
  corpus:
    "four uv Dependabot PRs with 29–34 uv members each, from one of the maintainer's own projects (#462 measurement comment); approved by the maintainer on 2026-11-27, #467",
  measured: '2026-11-27',
} as const;
/** A base kept from the former flat share: it has no basis of its own yet. */
const UV_KEPT_BASE = {
  note: 'the former flat share, kept as the base for a change with no uv members (approved by the maintainer on 2026-11-27, #467); the eligible rate adds the per-member demand. Awaiting L8 measurement (#380)',
} as const;
const UV_ZERO = {
  role: {
    statistic: FIT_ZERO_STATISTIC.role,
    headroom: 'none: this rate adds nothing',
  },
  signals: {
    statistic:
      'the rate is 0: the PyPI metadata reader scales with its eligible (uv) members alone',
    headroom: 'none: this rate adds nothing',
  },
} as const;

type SizedValue = Readonly<{ value: number; basis: Omit<MeasuredBasis, keyof typeof UV_MEASURE> }>;
/** A sized base is measured, derived from other entries, or a kept value marked `unjustified`. */
type SizedBase =
  | SizedValue
  | Readonly<{ value: number; basis: Readonly<{ note: string }> }>
  | Readonly<{
      inputs: readonly string[];
      formula: (...values: number[]) => number;
      description: string;
    }>;
type SizedShare = Readonly<{
  base: SizedBase;
  rates: Readonly<Partial<Record<ShareUnit, SizedValue>>>;
  zero: Omit<MeasuredBasis, keyof typeof UV_MEASURE>;
}>;

/**
 * Share dimensions sized for uv changes from the #462 measurement, approved by the maintainer on
 * 2026-11-27 (#467). A sized dimension's other rates are 0. Its ceiling is the allocation entry.
 */
const UV_SIZED: Readonly<Partial<Record<`${ScaledShare}.${ShareDimension}`, SizedShare>>> = {
  'upstream.bytes': {
    base: {
      inputs: ['research.maxTagDepth', 'evidence.envelope.maxResponseBytes'],
      formula: (depth, response) => (1 + UPSTREAM_TAG_CANDIDATES * (depth + 4)) * response,
      description:
        "The most GitHub reads one member's target-release stage can make, each a full response: 1 repository read, then for each of the 2 candidate tags (src/evidence/upstream-github.ts:508) 1 ref, up to limit:research.maxTagDepth annotated-tag reads, 1 contents, 1 release, and 1 recheck ref (src/evidence/upstream-github.ts:252-296). With the register's tag depth that is 29 reads × limit:evidence.envelope.maxResponseBytes, about 29 MiB, so a one-member change can always finish its release stage. It covers those GitHub reads only. A member's base and head metadata reads (src/evidence/upstream.ts:839-842) are charged to the shared PyPI metadata reader for uv, but to this share for npm on a collection-cache miss, or for uv when the metadata reader failed to open. Approved by the maintainer on 2026-11-27, #467.",
    },
    rates: Object.fromEntries(
      (['direct', 'transitive'] as const).map((unit) => [
        unit,
        {
          value: 750_000,
          basis: {
            statistic:
              'about 0.6 MB of upstream reads per uv member: 17.9–19.9 MB over 29–34 members; 1.25 × 600,000 = 750,000. Direct and transitive take the same rate, the members the upstream request share rates',
            headroom: '1.25× the measured per-member demand, the margin the fitted shares carry',
          },
        },
      ]),
    ),
    zero: UV_ZERO.role,
  },
  'signals.metadata.requests': {
    base: { value: 16, basis: UV_KEPT_BASE },
    rates: {
      eligible: {
        value: 2.5,
        basis: {
          statistic:
            'about 1.94 PyPI requests per uv member: 56–66 requests over 29–34 members; 1.25 × 1.94 = 2.425, rounded up to the next 0.1',
          headroom: '1.25× the measured per-member demand',
        },
      },
    },
    zero: UV_ZERO.signals,
  },
  'signals.metadata.bytes': {
    base: { value: 0.5 * MiB, basis: UV_KEPT_BASE },
    rates: {
      eligible: {
        value: 70_000,
        basis: {
          statistic:
            'about 54 KB of PyPI metadata per uv member: 1.43–1.84 MB over 29–34 members; 1.25 × 54,000 = 67,500, rounded up to 70,000',
          headroom: '1.25× the measured per-member demand',
        },
      },
    },
    zero: UV_ZERO.signals,
  },
};

type FittedAudit = Readonly<{ protects: string; effect: string; test: string }>;

/** A value fitted to the B12 demand corpus, or sized with it; `basis` says how this one was. */
function fitted<const Id extends string>(
  id: Id,
  value: number,
  unit: LimitUnit,
  basis: string | MeasuredBasis,
  audit: FittedAudit,
) {
  return {
    id,
    value,
    unit,
    protects: audit.protects,
    effect: audit.effect,
    basis:
      typeof basis === 'string'
        ? ({ kind: 'measured', ...B12_FIT, statistic: basis } as const)
        : ({ kind: 'measured', ...basis } as const),
    test: audit.test,
  } as const;
}

/** Why a fitted share's rate has its value: its request cost, the measured rate, or why it is 0. */
function rateBasis(share: ScaledShare, unit: ShareUnit, rate: number): string | MeasuredBasis {
  const cost = COST_SIZED[share]?.[unit];
  if (cost) return { ...cost, measured: B12_FIT.measured };
  if (rate > 0) return FIT_RATE_STATISTIC;
  return share.startsWith('signals.') ? FIT_ZERO_STATISTIC.signals : FIT_ZERO_STATISTIC.role;
}

const rateAudit = (share: ScaledShare, dimension: ShareDimension, unit: ShareUnit) => ({
  protects: `Grows the ${share} ${dimension} share with each ${unit} member, so a larger change gets more and a small one fails faster.`,
  effect:
    'Adds rate times the count to the share, rounded up and capped at the ceiling; zero leaves the share at its base.',
});

/** A sized base as its register entry: derived, kept (`unjustified`), or measured. */
function sizedBase<const Id extends string>(
  id: Id,
  base: SizedBase,
  unit: LimitUnit,
  audit: FittedAudit,
): LimitDefinition & { id: Id } {
  if ('inputs' in base)
    return derived(id, unit, base.inputs, base.formula, base.description, audit);
  if ('note' in base.basis)
    return unjustified(id, base.value, unit, { ...audit, note: base.basis.note });
  return fitted(id, base.value, unit, { ...UV_MEASURE, ...base.basis }, audit);
}

/** A scaled share's base or rate entry for one dimension. */
type ShareEntry<S extends ScaledShare, D extends ShareDimension> = LimitDefinition & {
  id: `research.share.${S}.${D}.base` | `research.share.${S}.${D}.rate.${ShareUnit}`;
};

/** A #467 sized dimension's base and rate entries: `measured` entries citing #462, or a kept base. */
function sizedShareEntries<const S extends ScaledShare, const D extends ShareDimension>(
  share: S,
  dimension: D,
  sized: SizedShare,
  unit: LimitUnit,
  units: readonly ShareUnit[],
): ShareEntry<S, D>[] {
  const baseId = `research.share.${share}.${dimension}.base` as `research.share.${S}.${D}.base`;
  const baseAudit = {
    protects:
      'Sets the share a change of no counted members gets, before any per-member rate is added.',
    effect:
      'The computed share starts here; each rate adds to it, rounded up and capped at the ceiling.',
    test: SHARE_SIZED_TEST,
  };
  const base: ShareEntry<S, D> = sizedBase(baseId, sized.base, unit, baseAudit);
  const rates = units.map((rateUnit) => {
    const id =
      `research.share.${share}.${dimension}.rate.${rateUnit}` as `research.share.${S}.${D}.rate.${ShareUnit}`;
    const rate = sized.rates[rateUnit];
    return fitted(
      id,
      rate?.value ?? 0,
      unit,
      { ...UV_MEASURE, ...(rate?.basis ?? sized.zero) },
      {
        ...rateAudit(share, dimension, rateUnit),
        test: rate ? SHARE_SIZED_TEST : SHARE_FORMULA_TEST,
      },
    );
  });
  return [base, ...rates];
}

/** One scaled share's base and rate entries for one dimension; its ceiling is the allocation entry. */
function scaledShareEntries<const S extends ScaledShare, const D extends ShareDimension>(
  share: S,
  dimension: D,
): ShareEntry<S, D>[] {
  const ceiling = `${SCALED_SHARES[share]}.${SHARE_DIMENSIONS[dimension]}`;
  const unit: LimitUnit = dimension === 'bytes' ? 'bytes' : 'count';
  const units: readonly ShareUnit[] = share.startsWith('signals.')
    ? [...ROLE_UNITS, 'eligible']
    : ROLE_UNITS;
  const baseId = `research.share.${share}.${dimension}.base` as `research.share.${S}.${D}.base`;
  const sized = UV_SIZED[`${share}.${dimension}`];
  if (sized) return sizedShareEntries(share, dimension, sized, unit, units);
  const fit = dimension === 'requests' ? FITTED_REQUESTS[share] : undefined;
  const baseAudit = {
    protects:
      'Sets the share a change of no counted members gets, before any per-member rate is added.',
    effect: fit
      ? 'The computed share starts here; each rate adds to it, rounded up and capped at the ceiling.'
      : 'The computed share starts here; with every rate at zero it equals the ceiling.',
    test: fit ? SHARE_FIT_TEST : SHARE_CEILING_TEST,
  };
  const base = fit
    ? fitted(baseId, fit.base, unit, FIT_BASE_STATISTIC, baseAudit)
    : derived(
        baseId,
        unit,
        [ceiling],
        copy,
        `The B12 fit (approved 2026-11-26, #370) keeps the ${share} ${dimension} share at its ceiling.`,
        baseAudit,
      );
  const rates = units.map((rateUnit) => {
    const id =
      `research.share.${share}.${dimension}.rate.${rateUnit}` as `research.share.${S}.${D}.rate.${ShareUnit}`;
    const rate = fit?.rates[rateUnit] ?? 0;
    const audit = {
      ...rateAudit(share, dimension, rateUnit),
      test: rate > 0 ? SHARE_FIT_TEST : SHARE_FORMULA_TEST,
    };
    return fit
      ? fitted(id, rate, unit, rateBasis(share, rateUnit, rate), audit)
      : unjustified(id, 0, unit, { ...audit, note: FIT_NOTE });
  });
  return [base, ...rates];
}

/** Base and rate entries for every scaled research share and dimension. */
function allScaledShareEntries() {
  return (Object.keys(SCALED_SHARES) as ScaledShare[]).flatMap((share) =>
    (Object.keys(SHARE_DIMENSIONS) as ShareDimension[]).flatMap((dimension) =>
      scaledShareEntries(share, dimension),
    ),
  );
}

/**
 * The evidence the readers keep in the evidence phase (Q10, #383): the thirteen byte shares and
 * retained caps Q10 makes configuration, the research readers' retained cap, and the trusted
 * config.
 */
export const Q10_RETAINED_INPUTS = [
  'evidence.allocation.transport.snapshot.maxTotalBytes',
  'evidence.allocation.session.maxTotalBytes',
  'evidence.allocation.registry.maxTotalBytes',
  'evidence.allocation.advisory.maxTotalBytes',
  'evidence.allocation.signals.readers.malware.maxTotalBytes',
  'evidence.allocation.signals.readers.publishTimes.maxTotalBytes',
  'evidence.allocation.signals.readers.registry.maxTotalBytes',
  'evidence.allocation.signals.readers.upstream.maxTotalBytes',
  'w2.session.maxRetainedBytes',
  'w2.npm.maxRetainedBytes',
  'w2.actions.maxRetainedBytes',
  'w2.uv.maxRetainedBytes',
  'w2.graph.maxRetainedBytes',
  'research.maxRetainedBytes',
  'config.maxBytes',
] as const;

const DEFINITIONS = [
  {
    id: 'packet.bytes',
    unit: 'bytes',
    protects:
      'An untrusted review packet of unbounded size would make validation and the analysis projection unbounded in memory and CPU; the serialized size is measured and rejected above the cap.',
    effect:
      'The whole packet is rejected with category budget on field packet, and no partial packet is returned. Optional evidence is dropped first so the assembled packet can fit.',
    basis: {
      kind: 'derived',
      inputs: [
        'runner.heapBytes',
        'analysis.replyHeapBytes',
        'runner.unitExpansionHeapBytes',
        'runner.heapBytesPerPacketByte',
      ],
      formula: (heap, replies, expansion, perByte) =>
        Math.floor((heap - replies - expansion) / perByte),
      description:
        'The largest packet whose analysis-phase heap fits: (limit:runner.heapBytes − limit:analysis.replyHeapBytes − limit:runner.unitExpansionHeapBytes) ÷ limit:runner.heapBytesPerPacketByte, rounded down. The concurrent model replies and the decision-unit expansion at its structural maximum come off first; the snapshot tree, research cache and npm inventory are released before analysis (src/pipeline.ts), so no evidence state is held beside them. The packet is never sent to the model whole, so runner heap is its only real limit. Approved by the maintainer on 2026-11-27 (L11, #383); the expansion and the released state on 2026-11-28.',
    },
    test: 'src/schema.test.ts > enforces the exact serialized packet budget including multibyte text',
  },
  {
    id: 'runner.heapBytesPerPacketByte',
    value: 19,
    unit: 'bytes',
    protects:
      'States how much heap a serialized packet byte costs at peak, through validation, revalidation, the analysis projection and render, on the densest valid packet shape, so limit:packet.bytes can be sized from runner heap.',
    basis: {
      kind: 'measured',
      command: 'npm run measure:heap',
      corpus:
        'the invented large-inventory npm packet (93 members plus 2 same-named nested copies) in its value-dense shape, every 64-hex id shortened to the shortest distinct hex string (731,507 bytes), and the same packet with its member records repeated 4 times (2,939,271 bytes), on Node 24.22.3 (V8 13.6) with a 1 MiB semi space. The plain shape, with 64-hex ids, gives 15.71 in the same run (1,043,616 to 4,179,981 bytes, 31 to 78 MiB)',
      statistic:
        'the growth in the smallest --max-old-space-size at which validation, revalidation, analysis with a stub model and render complete (29 MiB to 68 MiB), plus 1 MiB of bisection resolution, divided by the growth in serialized packet bytes (2,207,764): 18.998, rounded up to 19.00. The larger of the two shapes is kept. The sampled peak heapUsed is not used: it moves with garbage-collection timing',
      headroom:
        'none: a platform property, not a demand; the added 1 MiB makes it an upper bound, and the margin lies in limit:analysis.replyHeapBytes, which assumes every reply in flight is a hostile body of the full reply cap',
      measured: '2026-11-28',
    },
    effect:
      'Not enforced. limit:packet.bytes divides the heap left beside the model replies and the unit expansion by it; a larger value lowers the packet cap.',
    test: 'src/limits.test.ts > the heap inputs of packet.bytes keep their sources and formula',
  },
  {
    id: 'runner.unitExpansionHeapBytes',
    value: 108_351_425,
    unit: 'bytes',
    protects:
      'States the heap the decision-unit expansion (src/units.ts) takes at its structural maximum, beyond what the packet costs per byte, so limit:packet.bytes can set it aside.',
    basis: {
      kind: 'measured',
      command: 'npm run measure:heap',
      corpus:
        'the largest-expansion packet the parity builders reach (tests/parity/heap-shapes.ts): the large-inventory scenario at limit:packet.changes changes (124 npm members plus 4 others, 2,889,936 bytes), 63 of the npm transitive updates made direct anchors and the other 61 each proving a path from one, every anchor scope verdict failed for all ten reasons, every evidence entry partial for all ten reasons and every change id padded to limit:packet.idCodeUnits with a three-byte character: 7,564 relationship limits of the structural 8,064, through validation, revalidation, analysis with a stub model (16 calls) and render, first with the projection caps lifted and again within the derived caps, where it also completes at 161 MiB; on Node 24.22.3 (V8 13.6) with a 1 MiB semi space',
      statistic:
        'the smallest --max-old-space-size at which it completes (161 MiB) less that of the large plain packet (31 MiB), plus 1 MiB of bisection resolution, less the growth in packet bytes (1,846,320) at the plain rate of 15.71: 108,351,424.08 bytes, rounded up. The projection-findings estimate on branch -l11-packet was about 106 MB ±20%',
      headroom:
        'none: a platform property, not a demand. The packet reaches 7,564 of the 8,064 relationship limits the counts allow (its four non-npm changes cannot be anchors), so the structural maximum is about 7% above it in that term',
      measured: '2026-11-28',
    },
    effect:
      'Not enforced. limit:packet.bytes subtracts it from the analysis-phase heap; a larger value lowers the packet cap.',
    test: 'src/limits.test.ts > packet.bytes is the packet that fits the runner heap beside the model replies',
  },
  {
    id: 'runner.heapBytesPerEvidenceByte',
    value: 59,
    unit: 'bytes',
    protects:
      'States how much heap one evidence response byte costs at peak while a reader decodes, parses and copies it, so the evidence-phase heap can bound the response cap.',
    basis: {
      kind: 'measured',
      command: 'npm run measure:heap',
      corpus:
        'one invented response body of exactly limit:evidence.envelope.maxResponseBytes (1,048,576 bytes), opening with a CJK string so the decoded text is two-byte, in three shapes (empty arrays, empty objects, arrays nested to limit:research.maxJsonDepth), through the real read path of six readers with a stub fetch: the GitHub transport (src/runtime.ts), the W2 GitHub read session (src/github-read.ts), the GitHub advisory and OSV queries (src/evidence/advisory-read.ts), PyPI JSON metadata (src/evidence/policy-signals-read.ts) and npm registry documents (src/evidence/npm-registry.ts); on Node 24.22.3 (V8 13.6) with a 1 MiB semi space',
      statistic:
        'per reader, the smallest --max-old-space-size at which the read completes for the worst shape less that for a two-element body, plus 1 MiB of bisection resolution, divided by the body bytes; the largest reader is kept: OSV, nested arrays, 71 − 13 + 1 = 59 MiB per MiB (transport 32, session 33, GitHub advisories 57, PyPI 58, npm 41). The advisory and signal readers copy the parsed value (copyAdvisoryData), which roughly doubles the parse heap',
      headroom:
        'none: a platform property, not a demand; the added 1 MiB makes it an upper bound of the bisection, not a midpoint',
      measured: '2026-11-28',
    },
    effect:
      'Not enforced. limit:runner.maxEvidenceResponseBytes and the evidence-phase heap divide by it; a larger value lowers the response cap maximum.',
    test: 'src/limits.test.ts > the evidence-phase heap inputs keep their sources and formula',
  },
  {
    id: 'runner.evidenceHeapBytesPerPacketByte',
    value: 14.7,
    unit: 'bytes',
    protects:
      "States how much heap a serialized packet byte costs at peak in the evidence phase, through assembly's serialization, T4 validation and research's revalidation, with no analysis.",
    basis: {
      kind: 'measured',
      command: 'npm run measure:heap',
      corpus:
        'the invented large-inventory npm packet (93 members plus 2 same-named nested copies, 1,043,616 bytes) and the same packet with its member records repeated 16 times (16,737,105 bytes), run by measure.ts with PHASE=evidence, on Node 24.22.3 (V8 13.6) with a 1 MiB semi space',
      statistic:
        'the growth in the smallest --max-old-space-size at which the evidence-phase path completes (30 MiB to 249 MiB), plus 1 MiB of bisection resolution, divided by the growth in serialized packet bytes (15,693,489): 14.6995, rounded up to 14.70. Revalidation builds a second packet beside the validated one, so the evidence phase holds two packets, not the 2.62 an earlier trace estimated',
      headroom: 'none: a platform property, not a demand; the added 1 MiB makes it an upper bound',
      measured: '2026-11-28',
    },
    effect:
      'Not enforced. limit:runner.evidenceHeapBytes subtracts the packet at this rate; a larger value lowers the evidence-phase heap.',
    test: 'src/limits.test.ts > the evidence-phase heap inputs keep their sources and formula',
  },
  {
    id: 'runner.evidenceHeapBytes',
    unit: 'bytes',
    protects:
      'Bounds the heap the evidence phase may give to responses in flight and retained evidence, after the packet and the state that stays reachable into analysis.',
    effect:
      'Not enforced: limit:runner.maxEvidenceResponseBytes divides it; it is the budget the byte shares and retained caps must fit once they are configuration (Q10).',
    basis: {
      kind: 'derived',
      inputs: [
        'runner.heapBytes',
        'packet.bytes',
        'runner.evidenceHeapBytesPerPacketByte',
        'config.maxBytes',
        'evidence.allocation.transport.snapshot.maxTotalBytes',
        'w2.npm.maxRetainedBytes',
        'runner.heapBytesPerEvidenceByte',
      ],
      formula: (heap, packet, perPacketByte, config, snapshot, npm, perEvidenceByte) =>
        Math.floor(heap - packet * perPacketByte - (config + snapshot + npm) * perEvidenceByte),
      description:
        "The evidence phase's share of the heap. Evidence and research run before analysis, and research readers are locals of runResearch, closed in its finally (src/research.ts:452-459), so the heap is shared by phase. The packet is held at its evidence-phase rate (limit:runner.evidenceHeapBytesPerPacketByte × limit:packet.bytes). The trusted config (src/pipeline.ts, at most limit:config.maxBytes), the snapshot tree (src/snapshot.ts, parsed from at most limit:evidence.allocation.transport.snapshot.maxTotalBytes) and the npm inventory (src/pipeline.ts, at most limit:w2.npm.maxRetainedBytes) are held through the whole phase, each at limit:runner.heapBytesPerEvidenceByte; the tree and inventory are released before analysis. Approved by the maintainer on 2026-11-27 (L11, Q3(a), #383).",
    },
    test: 'src/limits.test.ts > the evidence-phase heap inputs keep their sources and formula',
  },
  {
    id: 'runner.maxEvidenceResponseBytes',
    unit: 'bytes',
    protects:
      'Keeps an adopter setting of the response cap from letting the responses in flight exhaust the evidence-phase heap.',
    effect:
      'Not enforced by the reviewer yet: L12 makes the config parser reject a larger response cap. check:limits evaluates the register at this value.',
    basis: {
      kind: 'derived',
      inputs: [
        'runner.evidenceHeapBytes',
        'evidence.readsInFlight',
        'runner.heapBytesPerEvidenceByte',
      ],
      formula: (heap, inFlight, perByte) => Math.floor(heap / (inFlight * perByte)),
      description:
        'The hard maximum of limit:evidence.envelope.maxResponseBytes: limit:runner.evidenceHeapBytes ÷ (limit:evidence.readsInFlight × limit:runner.heapBytesPerEvidenceByte), rounded down. It does not yet reserve heap for the evidence the other readers retain, which the Q10 joint maximum is to bound. Approved by the maintainer on 2026-11-27 (L11, Q3(a), #383).',
    },
    test: 'none: the hard maximum of an adopter setting the parser does not read yet (L12, #384); src/limits.test.ts pins its formula',
  },
  {
    id: 'runner.heapBytesPerRetainedByte',
    value: 27.47,
    unit: 'bytes',
    protects:
      'States how much heap one retained evidence byte holds after its parse, as readers charge it (the UTF-8 length of its JSON), so the evidence the readers keep can be sized from runner heap apart from the transient parse peak of the response in flight.',
    basis: {
      kind: 'measured',
      command: 'npm run measure:heap',
      corpus:
        'values of exactly 1 MiB of retained JSON bytes each (Buffer.byteLength(JSON.stringify(value)), as src/evidence/npm.ts and src/evidence/policy-signals-read.ts charge them), each parsed from its own text, structured-cloned and deeply frozen as src/evidence/npm-graph.ts keeps its result, with the text and the parsed original dropped (scripts/measure-heap/retained.ts), in three shapes (empty arrays, empty objects, arrays nested to limit:research.maxJsonDepth); on Node 24.22.3 (V8 13.6) with a 1 MiB semi space',
      statistic:
        'per shape, the growth in the smallest --max-old-space-size from one value held to 16 held at once, plus 1 MiB of bisection resolution, divided by the 15 MiB of added retained bytes; the largest shape is kept: nested arrays, (476 − 65 + 1) ÷ 15 = 27.467, rounded up to 27.47 (empty arrays 13.4, empty objects 21.4). The difference leaves out the parse peak of the last value, which limit:runner.heapBytesPerEvidenceByte covers',
      headroom:
        'none: a platform property, not a demand; the added 1 MiB makes it an upper bound. A reader keeps a typed result, not arbitrary JSON, so a structural bound per reader could be lower',
      measured: '2026-11-28',
    },
    effect:
      'Not enforced. limit:runner.evidenceRetainedHeapBytes multiplies the retained state by it; a larger value leaves less evidence-phase heap.',
    test: 'src/limits.test.ts > the evidence retained state is sized at the retained rate',
  },
  {
    id: 'runner.evidenceRetainedHeapBytes',
    unit: 'bytes',
    protects:
      'States the heap the evidence the readers keep may hold at once in the evidence phase, at the Q10 defaults, so the joint maximum of those caps can be checked against runner heap.',
    effect:
      'Not enforced yet: the Q10 joint maximum is to keep it, one response at its parse peak and the packet at its evidence-phase rate within limit:runner.heapBytes. At the placeholder limit:runner.systemReservedBytes it exceeds the heap, so limit:packet.bytes does not take the evidence-phase bound until the reserve is measured.',
    basis: {
      kind: 'derived',
      inputs: [...Q10_RETAINED_INPUTS, 'runner.heapBytesPerRetainedByte'],
      formula: (...values) => {
        const rate = values.at(-1) ?? 0;
        return Math.ceil(values.slice(0, -1).reduce((sum, value) => sum + value, 0) * rate);
      },
      description:
        'The retained state at limit:runner.heapBytesPerRetainedByte: the thirteen Q10 byte shares and retained caps (the snapshot, session, registry and advisory byte shares, the malware, publish-time, registry and upstream signal-reader shares, and the session, npm, actions, uv and graph retained caps), limit:research.maxRetainedBytes, and the trusted config (limit:config.maxBytes), held through the whole phase. The byte shares stand for what their readers keep from the bytes they read; the research shares are also inside limit:research.maxRetainedBytes, so the sum is an upper bound. Q10(a) approved by the maintainer on 2026-11-27, #383.',
    },
    test: 'src/limits.test.ts > the evidence retained state is sized at the retained rate',
  },
  {
    id: 'runner.memoryBytes',
    value: 8_000_000_000,
    unit: 'bytes',
    protects:
      'Records the memory of the smallest runner the reviewer supports: the standard GitHub-hosted Linux runner for private repositories (ubuntu-latest, 2 CPUs and 8 GB).',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/actions/reference/runners/github-hosted-runners',
      checked: '2026-11-27',
      platformValue: 8_000_000_000,
      margin:
        'none, and 8 GB is read as decimal gigabytes, the smaller of its two readings. The action sizes its heap from the memory of the runner it is on (src/relaunch.ts); this entry fixes the caps every runner must honour',
    },
    effect:
      'Not enforced: limit:runner.heapBytes is derived from it, and through it every cap sized from runner heap.',
    test: 'src/limits.test.ts > the runner heap derives from runner memory less what is not old generation',
  },
  {
    id: 'runner.youngGenerationBytes',
    value: 201_326_592,
    unit: 'bytes',
    protects:
      "Records the young generation V8 reserves beside the old generation, which the runner's memory must also hold.",
    basis: {
      kind: 'external',
      url: 'https://github.com/nodejs/node/blob/v24.22.3/deps/v8/src/heap/heap.cc#L317-L320',
      checked: '2026-11-28',
      platformValue: 201_326_592,
      margin:
        'none. The young generation is (2 semispaces + 1 new large-object space) × the semispace (heap.cc#L314-L320, kNewLargeObjectSpaceToSemiSpaceRatio = 1 at heap.h#L317). With only --max-old-space-size given, the semispace is DefaultMaxSemiSpaceSize (heap.cc#L4949-L4951): scavenger_max_new_space_capacity_mb (32, flag-definitions.h#L923) × MB × kPointerMultiplier, which is kTaggedSize / 4 = 2 without pointer compression (heap.h#L303), so 64 MiB, and 3 × 64 MiB = 201,326,592 bytes',
    },
    effect: 'Not enforced: limit:runner.heapBytes subtracts it.',
    test: 'src/limits.test.ts > the runner heap derives from runner memory less what is not old generation',
  },
  {
    id: 'runner.offHeapBytes',
    unit: 'bytes',
    protects:
      'Counts the buffers the reviewer keeps outside the V8 heap, which take runner memory but not old generation.',
    effect: 'Not enforced: limit:runner.heapBytes subtracts it.',
    basis: {
      kind: 'derived',
      inputs: [
        'research.cache.maxTotalBytes',
        'evidence.readsInFlight',
        'evidence.envelope.maxResponseBytes',
        'snapshot.maxBlobBytes',
        'w2.session.maxFileBytes',
        'context.maxSourceFileBytes',
        'analysis.maxConcurrentCalls',
        'analysis.responseBytes',
      ],
      formula: (cache, inFlight, response, blob, file, source, calls, reply) =>
        cache + inFlight * 2 * (response + Math.max(blob, file, source)) + calls * 2 * reply,
      description:
        'Every off-heap buffer the register bounds, summed over both phases because an ArrayBuffer is freed only by a later collection: the research cache bodies (limit:research.cache.maxTotalBytes, Uint8Array, src/evidence/research-cache.ts:106); for each evidence read in flight (limit:evidence.readsInFlight), its body chunks and their concatenation (2 × limit:evidence.envelope.maxResponseBytes, for example src/github-read.ts:412) and the largest decoded file with its copy (2 × the largest of limit:snapshot.maxBlobBytes, src/snapshot.ts:119; limit:w2.session.maxFileBytes; limit:context.maxSourceFileBytes, src/context.ts:494); and for each model call in flight, its reply chunks and their concatenation (2 × limit:analysis.responseBytes, src/analysis/mistral.ts:199-211). Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    test: 'src/limits.test.ts > the runner heap derives from runner memory less what is not old generation',
  },
  {
    id: 'runner.baselineBytes',
    value: 178_040_832,
    unit: 'bytes',
    protects:
      "Records the memory the reviewer's two Node processes take beyond their heaps: the relaunching parent and the action's code, isolate and native runtime.",
    basis: {
      kind: 'measured',
      command: 'npm run probe:runtime-baseline',
      corpus:
        '5 runs of the built action bundle with no workflow environment, so it relaunches, runs its startup self-check and fetch, and exits 78 at the missing runtime inputs; Node 24.22.3 on Linux x64',
      statistic:
        'the largest parent plus child peak resident set (process.resourceUsage().maxRSS) over the runs: 89,210,880 + 88,829,952 = 178,040,832 bytes (the 5 runs span 177.0 to 178.0 MB). Each process counts its whole resident set, including the few MB of heap the self-check uses',
      headroom:
        'none: a platform property, not a demand; counting each whole resident set overstates what lies outside the heap',
      measured: '2026-11-28',
    },
    effect: 'Not enforced: limit:runner.heapBytes subtracts it.',
    test: 'tests/probe-runtime-baseline/core.test.ts > the baseline is the largest parent plus child peak resident set',
  },
  unjustified('runner.systemReservedBytes', 5_300_094_976, 'bytes', {
    protects:
      "Reserves the runner memory the runner's OS, services and runner agent keep, which the reviewer cannot use.",
    effect: 'Not enforced: limit:runner.heapBytes subtracts it.',
    note: "a placeholder, not a measurement: it holds limit:runner.heapBytes at limit:runner.oldGenerationBytes, the old generation V8 already gives the smallest runner, so no cap moves until the reserve is measured. Awaiting a run on a GitHub-hosted ubuntu-latest runner in a private repository that records MemTotal − MemAvailable at job start and the runner agent's resident set (CONTRIBUTING.md, Runner memory)",
    test: 'src/limits.test.ts > the runner heap derives from runner memory less what is not old generation',
  }),
  {
    id: 'runner.heapBytes',
    unit: 'bytes',
    protects:
      'Bounds the old-generation heap the reviewer may plan for on the smallest runner; past it the process aborts out of memory and the job fails with no comment update.',
    effect:
      'The action relaunches itself with --max-old-space-size from the same formula and the memory of the runner it is on (src/relaunch.ts), so on the smallest runner the heap is this value. Every cap sized from runner heap is derived from it, by phase.',
    basis: {
      kind: 'derived',
      inputs: [
        'runner.memoryBytes',
        'runner.youngGenerationBytes',
        'runner.offHeapBytes',
        'runner.baselineBytes',
        'runner.systemReservedBytes',
      ],
      formula: heapBytesFor,
      description:
        'The smallest runner\'s memory (limit:runner.memoryBytes) less what is not old generation: the young generation (limit:runner.youngGenerationBytes), the off-heap buffers (limit:runner.offHeapBytes), the runtime baseline (limit:runner.baselineBytes) and what the runner OS and agent keep (limit:runner.systemReservedBytes). Approved by the maintainer on 2026-11-28 ("Raise heap to runner memory", L11, #383).',
    },
    test: 'src/relaunch.test.ts > relaunches once with the derived old-generation size and passes the exit code through',
  },
  {
    id: 'runner.oldGenerationBytes',
    value: 2_147_483_648,
    unit: 'bytes',
    protects:
      "Records the old-generation heap V8 gives the reviewer's Node 24 process on the smallest supported runner (8 GB); past it the process aborts out of memory and the review job fails with no comment update.",
    basis: {
      kind: 'external',
      url: 'https://github.com/nodejs/node/blob/v24.22.3/deps/v8/src/heap/heap.cc#L229-L310',
      checked: '2026-11-27',
      platformValue: 2_147_483_648,
      margin:
        'none: it is the ceiling limit:packet.bytes is derived under. HeapSizeFromPhysicalMemory (heap.cc#L229-L243) takes a quarter of physical memory times kHeapLimitMultiplier, capped at MaxOldGenerationSize (heap.cc#L291-L310), which is V8HeapTrait::kMaxSize = 1024 MB × kHeapLimitMultiplier (deps/v8/src/heap/heap-controller.h#L18) and doubles only at 15 GB or more of physical memory. kHeapLimitMultiplier is kSystemPointerSize / 4 = 2 on 64-bit Linux (deps/v8/src/heap/heap.h#L307), so an 8 GB runner gets min(4 GiB, 2 GiB) = 2 GiB. The same lines are unchanged in v24.11.0, the oldest Node the package supports. Checked against the V8 source and in cgroups by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      'Not enforced by the reviewer. The action now sets its own old generation (limit:runner.heapBytes); this default stays only as the figure the placeholder limit:runner.systemReservedBytes holds that heap at, until the runner reserve is measured.',
    test: 'src/limits.test.ts > the runner heap derives from runner memory less what is not old generation',
  },
  {
    id: 'packet.changes',
    value: 128,
    unit: 'count',
    protects:
      'A PR with more changes than the reviewer can inventory would be reviewed partly; trimming would present a partial inventory as complete, so the packet is rejected instead.',
    effect:
      'The packet is rejected with budget on changes, counted before reference resolution, and no usable packet is returned.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/units.test.ts > keeps the entire accepted 128-change inventory; T4 overflow has no usable packet',
  },
  {
    id: 'packet.sources',
    value: 1_024,
    unit: 'count',
    protects:
      'Source record count comes from untrusted input; an unbounded list would let validation and linking work grow without limit.',
    effect:
      'Overflow rejects the whole packet with budget on sources; counts include duplicates and nothing is sliced to fit.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/schema.test.ts > accepts 1024 source records and rejects the overflow record',
  },
  {
    id: 'packet.findings',
    value: 512,
    unit: 'count',
    protects:
      'Finding count comes from untrusted input; an unbounded list would let validation and linking work grow without limit.',
    effect:
      'Overflow rejects the whole packet with budget on findings; findings are never deleted to fit.',
    basis: {
      kind: 'safety',
      reason:
        'The largest legitimate use measured is 192 findings for the 105 members of #276 (https://github.com/andrewpucci/dependency-update-advisor/issues/350#issuecomment-6940522903); scaled to limit:packet.changes members that is about 234, so 512 leaves about 2× headroom. Above the cap, schema validation and finding-to-change linking work grow with the count of untrusted records, and limit:research.maxFindings copies this value, so a larger cap also lets one advisory reader retain and return more findings before it stops with budget. Approved by the maintainer on 2026-11-27, #383.',
    },
    test: 'src/schema.test.ts > accepts 512 findings and rejects the overflow record',
  },
  {
    id: 'packet.relationships',
    unit: 'count',
    protects:
      'Relationship proofs come from collector output and their linking work grows with their count; an unbounded set would grow the proof graph without limit.',
    effect:
      'Overflow rejects the packet with budget on relationships. The assembler drops optional proofs before this check runs.',
    basis: {
      kind: 'derived',
      inputs: ['packet.changes'],
      formula: (changes) => 2 * changes,
      description:
        'At most two proofs per member, the claimed anchor and one more to evidence ambiguity (docs/specs/SPEC-reachability-evidence.md, Bounds), over at most limit:packet.changes members, so twice the change cap holds every proof the collectors emit. Approved by the maintainer on 2026-11-27, #383.',
    },
    test: 'src/schema.test.ts > accepts 256 distinct proofs and rejects the overflow proof',
  },
  {
    id: 'packet.reachability',
    value: 1_024,
    unit: 'count',
    protects:
      'Reachability verdicts come from collector output and an unbounded set would grow the verdict list without limit; overflow must reject rather than trim, so no record is silently lost.',
    effect:
      'Overflow rejects the packet with budget on reachability; the list is never trimmed. The assembler drops optional verdicts first.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/schema.test.ts > accepts exactly 1,024 verdicts and rejects one beyond without trimming',
  },
  {
    id: 'packet.pathInstances',
    value: 32,
    unit: 'count',
    protects:
      "A relationship path's instance count comes from untrusted input; an unbounded path would make path walks grow without limit.",
    effect:
      'A path over 32 instances rejects the packet with budget on relationships. The graph collectors separately stop with path_limit and do not expand the path.',
    basis: {
      kind: 'safety',
      reason:
        "The largest legitimate path observed is 7 instances: the shortest path from a direct dependency to each installed package, counting both ends, over every package in each of the 6 committed versions of this repository's package-lock.json (346 to 360 packages, resolved by nearest node_modules lookup, 2026-11-27). That is npm only and one repository; no uv lock is committed and the demand corpus records no path lengths. 32 is more than 4× that. Above the cap, schema validation and the unit-forming path walk grow with each proof's length, and every instance record counts against limit:packet.bytes: limit:packet.relationships proofs of 32 instances are already 8,192 instance records. A longer path is not lost silently: the npm and uv collectors stop with path_limit and leave the member standalone with that reason. Approved by the maintainer on 2026-11-27, #383.",
    },
    test: 'src/schema.test.ts > enforces the 32-instance path ceiling',
  },
  {
    id: 'packet.idCodeUnits',
    value: 256,
    unit: 'code units',
    protects:
      'IDs and package names come from untrusted registry and repository input; an oversized ID would inflate every record that repeats it and the packet bytes budget.',
    effect:
      'An over-long ID rejects the packet with budget on the field; the code-unit count is checked inside text().',
    basis: {
      kind: 'safety',
      reason:
        'npm documents a package name maximum of 214 characters, including the scope (https://docs.npmjs.com/cli/v11/configuring-npm/package-json, checked 2026-11-27), and synthetic ids are a short kind prefix plus a 64-character SHA-256 hex digest, under 100 code units (for example src/evidence/npm.ts and src/evidence/actions.ts). 256 sits above both. Above it, one oversized id is repeated in every record that cites it, inflating the packet against limit:packet.bytes; limit:context.maxIdCodeUnits copies this value. Approved by the maintainer on 2026-11-27, #383.',
    },
    test: 'src/schema.test.ts > enforces 256-code-unit IDs and 1024-byte identity strings',
  },
  {
    id: 'packet.identityBytes',
    value: 1_024,
    unit: 'bytes',
    protects:
      'Other identity strings such as versions, refs and paths come from untrusted input; an oversized byte length would inflate records and the packet bytes budget.',
    effect: 'An identity string over the byte cap rejects the packet with budget on the field.',
    basis: {
      kind: 'safety',
      reason:
        'node-semver rejects a version string longer than MAX_LENGTH, 256 (https://raw.githubusercontent.com/npm/node-semver/main/internal/constants.js, checked 2026-11-27), so 1,024 bytes is 4× the longest version npm accepts. Git refs and lockfile and repository paths have no documented maximum below Linux PATH_MAX (4,096 bytes), so for them the cap is a sanity bound, not a platform figure. Above it, one identity string repeated in records inflates the packet against limit:packet.bytes; limit:context.maxPathBytes and limit:dependabot.maxPathBytes copy this value. The same cap also bounds versioned advisory URLs (src/evidence/advisory-read.ts), where a long URL can reach it and the target is reported unsupported; for URLs it can bind, and moving that use to its own entry is left to a separate change. Approved by the maintainer on 2026-11-27, #383.',
    },
    test: 'src/schema.test.ts > enforces 256-code-unit IDs and 1024-byte identity strings',
  },
  {
    id: 'packet.textBytes',
    unit: 'bytes',
    protects:
      'Rationale, title and upstream excerpt text come from untrusted advisory and registry input; unbounded text would dominate the packet bytes budget and the comment.',
    effect:
      'Over-long text rejects the packet with budget on the field. Upstream and policy readers stop adding text at the cap before the packet check.',
    basis: {
      kind: 'derived',
      inputs: ['analysis.unitBytes', 'packet.listEntries'],
      formula: (unitBytes, listEntries) => Math.floor(unitBytes / listEntries),
      description:
        "A list of limit:packet.listEntries text fields, each at this cap, fits one unit's attributable byte budget, limit:analysis.unitBytes, so one unit's longest list of excerpts cannot alone exceed the unit cap. Approved by the maintainer on 2026-11-27, #383.",
    },
    test: 'src/schema.test.ts > enforces text and reference-list bounds independently of the packet size',
  },
  {
    id: 'packet.listEntries',
    value: 32,
    unit: 'count',
    protects:
      'Reference, reason and member lists come from untrusted input; an unbounded list multiplies per-entry checks and the packet bytes budget.',
    effect:
      'A list over 32 entries rejects the packet with budget on that field. The npm and Actions readers split larger member lists into several sources instead.',
    basis: {
      kind: 'safety',
      reason:
        'Splitting means no legitimate member is dropped at any value: the npm, Actions and uv readers split a longer member list into several sources (src/evidence/npm.ts, src/evidence/actions.ts, src/evidence/uv-output.ts). Other lists stop at the cap visibly, with budget or a truncated flag, and never silently. Above it, every list multiplies per-entry checks and its entries count against limit:packet.bytes. Approved by the maintainer on 2026-11-27, #383.',
    },
    test: 'src/schema.test.ts > enforces text and reference-list bounds independently of the packet size',
  },
  {
    id: 'packet.contextBytes',
    unit: 'bytes',
    protects:
      'Source context is serialized into every packet and read from repository files; an unbounded context would grow the packet and the analysis input without limit.',
    effect:
      'A context over the byte cap rejects the packet with budget on context; no partial context is kept.',
    basis: {
      kind: 'derived',
      inputs: ['analysis.unitBytes'],
      formula: copy,
      description:
        "The whole source context is sent with the analysis input, so it must fit one unit's attributable byte budget, limit:analysis.unitBytes. Approved by the maintainer on 2026-11-27, #383.",
    },
    test: 'src/schema.test.ts > enforces exactly 65536 serialized context bytes across 128 dependencies',
  },
  {
    id: 'packet.excerptCodeUnits',
    value: 500,
    unit: 'code units',
    protects:
      'Repository excerpts are untrusted text that is passed to the analysis model; an unbounded excerpt would grow the model input and the packet.',
    effect:
      'An over-long excerpt rejects the context with budget on context. Policy signals mark an over-long known value as truncated and drop it.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/schema.test.ts > enforces C2 excerpt code-unit bounds without losing immutable facts',
  },
  {
    id: 'packet.facts',
    value: 20,
    unit: 'count',
    protects:
      'Facts per dependency come from repository scanning; an unbounded count multiplies the context bytes and the excerpt checks.',
    effect: 'More than 20 facts for one dependency rejects the context with budget on context.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/schema.test.ts > enforces the context fact count independently of excerpt and packet bounds',
  },
  // Workflow timeouts, copied from the YAML `timeout-minutes` of each job.
  unjustifiedWorkflow('workflow.dependabotReview.review.timeoutMinutes', 15, {
    protects:
      "The runner kills the review job at its timeout-minutes, so the pipeline's deadlines must finish inside that wall-clock limit.",
    effect:
      'The runner cancels the job when the timeout passes; the pipeline derives its job budget from this value, so its deadlines are set to end before it.',
    note: 'awaiting L8 measurement',
  }),
  unjustifiedWorkflow('workflow.ci.quality.timeoutMinutes', 10, {
    protects:
      'The runner kills a hung CI quality job at this timeout, so one stuck job cannot hold a runner indefinitely.',
    effect: 'The runner cancels the job at the timeout; no application code reads this value.',
    note: 'awaiting L8 measurement',
  }),
  unjustifiedWorkflow('workflow.complexity.report.timeoutMinutes', 10, {
    protects:
      'The runner kills the complexity report job at this timeout, bounding a hung report run.',
    effect: 'The runner cancels the job at the timeout; no application code reads this value.',
    note: 'awaiting L8 measurement',
  }),
  unjustifiedWorkflow('workflow.complexity.comment.timeoutMinutes', 5, {
    protects:
      'The runner kills the complexity comment job at this timeout, bounding a hung comment run.',
    effect: 'The runner cancels the job at the timeout; no application code reads this value.',
    note: 'awaiting L8 measurement',
  }),
  // Job timing, from budget.ts.
  derived(
    'job.budget',
    'milliseconds',
    ['workflow.dependabotReview.review.timeoutMinutes'],
    (minutes) => minutes * 60_000,
    "The runner's wall-clock limit is the reusable workflow's timeout-minutes, in milliseconds.",
    {
      protects:
        "The runner's wall-clock limit for the review job; every pipeline deadline is measured against it.",
      effect:
        "Not reached directly; it is the input to job.window, which sets the pipeline's deadlines.",
      test: 'none: derived into job.window; no code compares against job.budget itself. JOB_BUDGET_MS (src/budget.ts:4) is read only by budget.test.ts, and job.window (src/budget.ts:15) is compared in src/runtime.ts:187 (now - started >= window) and used as the analysis deadline in src/pipeline.ts:500',
    },
  ),
  unjustified('job.preStartupAllowance', 60_000, 'milliseconds', {
    protects:
      "The pipeline clock starts at runStartup, after the runner has spent time on the app-token step, action download, Node load and self-check; this allowance keeps the window inside the runner's timeout.",
    effect:
      'Shortens the job window by 60,000 ms, so the analysis and freshness deadlines move earlier; it converts no outcome to success.',
    note: 'awaiting L8 measurement',
    test: 'none: subtracted only inside job.window (src/budget.ts:9 and :15); the window is enforced by src/runtime.ts:187, covered by the existing test in src/runtime.test.ts:267, and the analysis deadline at src/pipeline.ts:500 is pinned by the existing deadline tests',
  }),
  derived(
    'job.window',
    'milliseconds',
    ['job.budget', 'job.preStartupAllowance'],
    (budget, preStartup) => budget - preStartup,
    'The job window is the runner budget less the time spent before startup.',
    {
      protects:
        "Marks the end of the time the pipeline may use for reads and analysis, measured from job start and kept before the runner's timeout.",
      effect:
        'A freshness read started at or after the window is refused with budget and no request is sent; one still in flight is cut off with timeout.',
      test: 'src/runtime.test.ts > refuses a freshness read after the job window without a request',
    },
  ),
  unjustified('job.freshnessAllowance', 45_000, 'milliseconds', {
    protects:
      "Reserves time at the end of the job window for the three sequential freshness reads, so the final re-verification finishes before the runner's timeout.",
    effect:
      'Analysis must end 45,000 ms before the window end, since the analysis deadline is started + JOB_WINDOW_MS - FRESHNESS_ALLOWANCE_MS.',
    note: 'awaiting L8 measurement',
    test: 'src/pipeline.test.ts > ends analysis job.freshnessAllowance before the job window closes',
  }),
  derived(
    'freshness.readsPerCheck',
    'count',
    [],
    () => 3,
    'A freshness recheck reads the workflow run, the pull request and the base-to-head comparison, one after another, from fixed call sites (reverifyReviewBinding, src/event.ts). Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        "Counts the GitHub reads of one freshness recheck, so the freshness share and the evidence deadline's hard maximum reserve them.",
      effect:
        'Not enforced: it sizes limit:evidence.allocation.transport.freshness.maxRequests and limit:job.maxEvidenceDeadlineMs.',
      test: 'src/event.test.ts > a freshness recheck makes exactly freshness.readsPerCheck GitHub reads',
    },
  ),
  derived(
    'freshness.startupReads',
    'count',
    [],
    () => 1,
    'Startup reads the workflow file once to resolve the workflow identity (resolveWorkflow, src/runtime.ts), a fixed call site. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects: 'Counts the freshness reads startup makes, so the freshness share reserves them.',
      effect: 'Not enforced: it sizes limit:evidence.allocation.transport.freshness.maxRequests.',
      test: 'src/runtime.test.ts > startup resolves its workflow with exactly freshness.startupReads freshness reads',
    },
  ),
  derived(
    'freshness.entryReads',
    'count',
    [],
    () => 4,
    'Event verification reads the workflow, the run, the pull request and the base-to-head comparison once each (verifyCiEvent, src/event.ts); its replay read goes to the claim store, not GitHub. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Counts the GitHub reads of event verification, so the freshness share reserves them.',
      effect: 'Not enforced: it sizes limit:evidence.allocation.transport.freshness.maxRequests.',
      test: 'src/event.test.ts > entry verification makes exactly freshness.entryReads GitHub reads',
    },
  ),
  derived(
    'freshness.checksPerRun',
    'count',
    [],
    () => 4,
    'The pipeline rechecks freshness at entry, before research, before the model and before the handoff (src/pipeline.ts), fixed call sites with no loop. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Counts the freshness rechecks one run makes, so the freshness share reserves their reads.',
      effect: 'Not enforced: it sizes limit:evidence.allocation.transport.freshness.maxRequests.',
      test: 'src/pipeline.test.ts > a full run makes freshness.checksPerRun freshness checks',
    },
  ),
  derived(
    'evidence.readsInFlight',
    'count',
    [],
    () => 1,
    'Evidence responses one run holds in flight at once. Every evidence read is awaited before the next starts: the collectors run in turn (src/packet.ts:97-99), the research stages in turn (src/research.ts:395-421), each reader refuses a second read while one is pending (for example src/github-read.ts:534-538 and src/evidence/advisory-read.ts:783-792), and no evidence code calls Promise.all; only analysis batches run concurrently (src/analysis/batches.ts). Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Counts the response bodies the evidence phase parses at once, so the per-response heap bound multiplies by it.',
      effect:
        'Not enforced: it divides the evidence-phase heap for limit:runner.maxEvidenceResponseBytes.',
      test: 'src/pipeline.test.ts > a full run has at most evidence.readsInFlight evidence responses in flight',
    },
  ),
  // Evidence read envelope and its reader shares, from budget.ts.
  derived(
    'evidence.envelope.maxRequests',
    'count',
    [
      'evidence.allocation.transport.maxRequests',
      'evidence.allocation.session.maxRequests',
      'evidence.allocation.registry.maxRequests',
      'evidence.allocation.upstream.maxRequests',
      'evidence.allocation.advisory.maxRequests',
      'evidence.allocation.signals.maxRequests',
    ],
    sum,
    "The envelope's request cap is the sum of the six reader shares.",
    {
      protects:
        'Caps total GitHub and registry requests across all pre-analysis evidence reads, since GitHub requests share one rate limit and the evidence time is bounded.',
      effect:
        'No single check enforces this total; each reader is capped by its share, so the total is reached only when every share is spent and each then returns budget.',
      test: 'none: sum of the six reader shares (src/budget.ts:24, built from src/budget.ts:39-90); each reader stops at its own share (for example src/github-read.ts:396), and only budget.test.ts:53-54 and research.test.ts:414 read the total',
    },
  ),
  configured(
    'evidence.envelope.maxResponseBytes',
    MiB,
    'bytes',
    { setting: 'limits.evidenceResponseBytes', maximum: 'runner.maxEvidenceResponseBytes' },
    'The adopter: a larger cap reads larger legitimate responses (such as the compare page of #472) and spends more runner heap per read and a longer request timeout. Section 5 admitted the response cap as configuration on 2026-11-27 (L11, Q3(a), #383).',
    {
      protects:
        'A response body is buffered before its size is checked, so one oversized response could exhaust runner memory; the cap bounds each response.',
      effect:
        'A response over the cap fails only its own read with budget and its body is cancelled; other reads continue.',
      test: 'src/evidence/npm-registry.test.ts > a response exactly at the envelope per-response cap reads; one byte more fails only that read',
    },
  ),
  derived(
    'evidence.envelope.maxTotalBytes',
    'bytes',
    [
      'evidence.allocation.transport.maxTotalBytes',
      'evidence.allocation.session.maxTotalBytes',
      'evidence.allocation.registry.maxTotalBytes',
      'evidence.allocation.upstream.maxTotalBytes',
      'evidence.allocation.advisory.maxTotalBytes',
      'evidence.allocation.signals.maxTotalBytes',
    ],
    sum,
    "The envelope's byte cap is the sum of the six reader shares' byte caps.",
    {
      protects:
        'Caps total response bytes across all pre-analysis evidence reads, so buffered responses cannot exhaust runner memory in aggregate.',
      effect:
        "Reached only when every share's byte cap is spent; each reader then returns budget, and no reader borrows from another.",
      test: "none: derived sum of the six share byte caps (src/budget.ts:23-29); no code compares against the envelope's maxTotalBytes itself (src/budget.ts:26 defines it, src/research.ts:99 uses each share's maxTotalBytes, and each share is enforced by its reader, e.g. src/evidence/npm-registry.ts:247).",
    },
  ),
  derived(
    'evidence.envelope.requestTimeoutMs',
    'milliseconds',
    [
      'github.processingTimeoutMs',
      'evidence.envelope.maxResponseBytes',
      'upstream.throughputBytesPerSecond',
    ],
    (processingMs, responseBytes, throughput) =>
      processingMs + Math.ceil((responseBytes * 1000) / throughput),
    "GitHub's processing timeout, limit:github.processingTimeoutMs, plus the time to read a body at the response cap, limit:evidence.envelope.maxResponseBytes, at the measured upstream throughput, limit:upstream.throughputBytesPerSecond, rounded up to the millisecond. A request that GitHub still processes is never cut off, and its largest admissible body has time to arrive. npm, OSV and PyPI document no server timeout, so their reads share GitHub's figure. The cap is the input, so the timeout follows it (L11, Q3(a)). Approved by the maintainer on 2026-11-27 (L11, #383).",
    {
      protects:
        'One stalled request must not hold the job until the runner kills it; the timeout frees the time for the reads that follow, including freshness reads.',
      effect:
        'The request is aborted with the fixed timeout reason and its reader stops with that reason, keeping the evidence it already collected.',
      test: 'src/runtime.test.ts > times a freshness read made %s out at the smaller of the request timeout and the time left',
    },
  ),
  configured(
    'evidence.envelope.totalTimeoutMs',
    240_000,
    'milliseconds',
    { setting: 'limits.evidenceDeadlineMs', maximum: 'job.maxEvidenceDeadlineMs' },
    'The adopter: a longer deadline buys research coverage with run time, and a shorter one fails research sooner. Section 5 admitted the evidence deadline as configuration on 2026-11-17, with the job budget.',
    {
      protects:
        "The shared evidence deadline keeps every pre-analysis read inside the job window, so analysis and the final freshness check keep their time before the runner's timeout.",
      effect:
        "Once the time is spent, a reader's next request is refused with budget or cut off with timeout, and the evidence already collected is kept.",
      test: 'src/runtime.test.ts > limits a late request to the time left in the total deadline',
    },
  ),
  derived(
    'job.maxEvidenceDeadlineMs',
    'milliseconds',
    [
      'job.window',
      'freshness.readsPerCheck',
      'github.requestTimeoutMs',
      'analysis.requestTimeoutMs',
      'analysis.publicationReserveMs',
      'job.freshnessAllowance',
    ],
    (window, recheckReads, requestMs, modelCallMs, publicationMs, freshnessMs) =>
      window - recheckReads * requestMs - modelCallMs - publicationMs - freshnessMs,
    'The latest the evidence deadline may fall so one full model call still fits: limit:job.window less what must follow evidence, which is the before-model recheck (limit:freshness.readsPerCheck sequential reads of limit:github.requestTimeoutMs, exempt from the evidence deadline), one model call (limit:analysis.requestTimeoutMs), the publication reserve (limit:analysis.publicationReserveMs) and the final freshness allowance (limit:job.freshnessAllowance). Approved by the maintainer on 2026-11-27 (L11, Q4(a), #383).',
    {
      protects:
        'Keeps an adopter setting of the evidence deadline from taking the time analysis needs for one model call, the recheck before it, publication, and the final freshness check.',
      effect:
        'Not enforced by the reviewer yet: L12 makes the config parser reject a larger evidence deadline. check:limits evaluates the register at this value.',
      test: 'none: the hard maximum of an adopter setting the parser does not read yet (L12, #384); src/limits.test.ts pins its formula',
    },
  ),
  derived(
    'evidence.allocation.transport.maxRequests',
    'count',
    [
      'evidence.allocation.transport.snapshot.maxRequests',
      'evidence.allocation.transport.freshness.maxRequests',
    ],
    sum,
    'The transport share is the snapshot requests plus the reserved freshness requests.',
    {
      protects:
        'Caps GitHub snapshot and freshness requests together against the shared GitHub rate limit.',
      effect:
        'Each part is capped separately; the transport total is reached only when both are spent, and then each read returns budget.',
      test: 'none: sum of the snapshot and freshness shares; runtime.ts compares each share separately (src/runtime.ts:186 ++spent.requests > limits.maxRequests, with limits = W2_GITHUB_LIMITS.snapshot or .freshness, runtime.ts:16-21), and budget.test.ts:62-64 only asserts the sum',
    },
  ),
  derived(
    'evidence.allocation.transport.maxTotalBytes',
    'bytes',
    [
      'evidence.allocation.transport.snapshot.maxTotalBytes',
      'evidence.allocation.transport.freshness.maxTotalBytes',
    ],
    sum,
    'The transport byte share is the snapshot bytes plus the reserved freshness bytes.',
    {
      protects:
        'Caps GitHub snapshot and freshness response bytes together against runner memory and transfer.',
      effect:
        'Each part is capped separately; the transport byte total is reached only when both are spent, and then the next read returns budget.',
      test: 'none: sum of the snapshot and freshness byte shares; runtime.ts caps each share separately (src/runtime.ts:211 uses limits.maxTotalBytes of the share), and budget.test.ts:65-67 only asserts the sum',
    },
  ),
  configured(
    'evidence.allocation.transport.snapshot.maxRequests',
    200,
    'count',
    {
      setting: 'limits.githubRequests.snapshot',
      maximum: 'github.token.requestCapMax',
      joint: true,
    },
    "The adopter: snapshot reads spend the adopter's GITHUB_TOKEN quota, and tree reads grow with path depth (src/snapshot.ts), so no structural bound exists. It extends section 5's GitHub request cap (L11, Q6(a)).",
    {
      protects:
        'Caps snapshot reads (repository, commit, trees, blobs) so a heavy snapshot cannot use the freshness share or the GitHub rate limit.',
      effect: 'The read past the share is refused with budget before any request is sent.',
      test: 'src/runtime.test.ts > an exhausted snapshot share cannot starve freshness reads, and the reverse',
    },
  ),
  unjustified('evidence.allocation.transport.snapshot.maxTotalBytes', 9 * MiB, 'bytes', {
    protects:
      'Caps snapshot response bytes so a heavy snapshot cannot use the freshness bytes or runner memory.',
    effect:
      "A read that would pass the share's remaining bytes returns budget and is not returned as available; the freshness share is unaffected.",
    test: "src/runtime.test.ts > stops a %s read at that share's byte limit and leaves the other share alone",
    note: 'awaiting L8 measurement',
  }),
  derived(
    'evidence.allocation.transport.freshness.maxRequests',
    'count',
    [
      'freshness.startupReads',
      'freshness.entryReads',
      'freshness.checksPerRun',
      'freshness.readsPerCheck',
    ],
    (startup, entry, checks, perCheck) => startup + entry + checks * perCheck,
    'Every freshness read one run makes: limit:freshness.startupReads at startup, limit:freshness.entryReads to verify the event, and limit:freshness.checksPerRun rechecks of limit:freshness.readsPerCheck reads each. A failed freshness read is an internal failure, never a stale head, so the share lets every one of them run. Each count comes from fixed call sites and is pinned by a test. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Reserves requests for freshness checks (workflow, run, PR, comparison) so a heavy snapshot cannot prevent the checks that keep a finished review valid.',
      effect:
        'The request past the share is refused with budget and no request is sent; a failed freshness read is an internal failure, never a stale head.',
      test: 'src/runtime.test.ts > an exhausted snapshot share cannot starve freshness reads, and the reverse',
    },
  ),
  derived(
    'evidence.allocation.transport.freshness.maxTotalBytes',
    'bytes',
    ['evidence.allocation.transport.freshness.maxRequests', 'github.maxResponseBytes'],
    (requests, responseBytes) => requests * responseBytes,
    'Every freshness read may return a response at the cap, limit:github.maxResponseBytes, and a freshness read that runs out fails the job closed, so the share holds limit:evidence.allocation.transport.freshness.maxRequests full responses. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Reserves response bytes for freshness checks so a heavy snapshot cannot starve the checks that keep a finished review valid.',
      effect:
        "A read that would pass the share's remaining bytes returns budget; the snapshot share is unaffected.",
      test: "src/runtime.test.ts > stops a %s read at that share's byte limit and leaves the other share alone",
    },
  ),
  configured(
    'evidence.allocation.session.maxRequests',
    160,
    'count',
    {
      setting: 'limits.githubRequests.session',
      maximum: 'github.token.requestCapMax',
      joint: true,
    },
    "The adopter: session reads spend the adopter's GITHUB_TOKEN quota, and each file read costs a commit, one tree per path segment and a blob (src/github-read.ts), so no structural bound exists. It extends section 5's GitHub request cap (L11, Q6(a)) and must leave room for limit:w2.session.maxPages file-list pages.",
    {
      protects:
        'Caps requests of the GitHub evidence session reader so one review cannot exceed the GitHub rate limit or the evidence time.',
      effect:
        'The request past the cap returns budget and no request is sent; other readers are not borrowed from.',
      test: 'src/github-read.test.ts > the session stops at exactly evidence.allocation.session.maxRequests requests',
    },
  ),
  unjustified('evidence.allocation.session.maxTotalBytes', 12 * MiB, 'bytes', {
    protects: 'Caps response bytes of the GitHub evidence session reader against runner memory.',
    effect:
      "A response past the share's remaining bytes returns budget and the reader stops; other shares are unaffected.",
    note: 'awaiting L8 measurement',
    test: 'src/github-read.test.ts > the session refuses the read that passes evidence.allocation.session.maxTotalBytes',
  }),
  {
    id: 'evidence.allocation.registry.maxRequests',
    value: 640,
    unit: 'count',
    protects:
      'Caps npm registry detail requests for one review so a large dependency set cannot spend the shared evidence time on registry reads. These go to registry.npmjs.org, never to the GitHub quota.',
    basis: {
      kind: 'measured',
      ...B12_FIT,
      statistic:
        'the ×10 value of the former fixed share, under which every collected corpus PR completed; the largest used 216 reads',
      headroom: 'about 3× the largest measured demand',
    },
    effect:
      'The ceiling of the scaled collection registry share; the request past the computed share returns budget and no request is sent.',
    test: 'src/evidence/npm-registry.test.ts > the registry request share allows exactly its count and refuses the next read unsent',
  },
  fitted(
    'collection.share.registry.requests.base',
    5,
    'count',
    '1.25 × the highest demand among the one-to-three-member PRs (4 reads on #172), rounded up',
    {
      protects:
        'Sets the collection registry share a change with no npm members gets, before the per-member rate is added.',
      effect:
        'The share starts here; the npm member rate adds to it, rounded up and capped at limit:evidence.allocation.registry.maxRequests.',
      test: 'src/budget.test.ts > the collection registry share scales with npm members and stops at its ceiling',
    },
  ),
  fitted(
    'collection.share.registry.requests.rate.npm',
    2.5,
    'count',
    '1.25 × the highest measured demand per npm member: 1.6 to 2.0 reads per member across the corpus',
    {
      protects:
        'Grows the collection registry share with each npm member, so a large lockfile change keeps its install-script and vulnerability coverage and a small one fails faster.',
      effect:
        'Adds rate times the npm member count to the share, rounded up and capped at the ceiling.',
      test: 'src/budget.test.ts > the collection registry share scales with npm members and stops at its ceiling',
    },
  ),
  unjustified('evidence.allocation.registry.maxTotalBytes', 4 * MiB, 'bytes', {
    protects:
      'Caps response bytes of npm registry detail reads so they cannot exhaust runner memory or the envelope.',
    effect:
      "A response past the share's remaining bytes returns budget and the reader stops; other shares are unaffected.",
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm-registry.test.ts > the registry byte share allows exactly its total and refuses the read that exceeds it',
  }),
  unjustified('evidence.allocation.upstream.maxRequests', 240, 'count', {
    protects:
      'Caps upstream research requests (GitHub and registry lookups) that scale with the changed group, so a large group cannot take the shared evidence time or the GitHub rate limit.',
    effect:
      'The upstream reader stops with budget at the cap, and the stage keeps the evidence already gathered.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/upstream-read.test.ts > upstream reader spends exactly its request share and refuses the request past it',
  }),
  derived(
    'evidence.allocation.upstream.maxTotalBytes',
    'bytes',
    ['evidence.envelope.totalTimeoutMs', 'upstream.throughputBytesPerSecond'],
    (totalMs, throughput) => Math.floor(((totalMs / 1000) * throughput) / 2),
    'Half of what the upstream reader can read in the evidence window at the measured upstream throughput (limit:upstream.throughputBytesPerSecond, 640,000 bytes/s on the #462 uv PRs, reproduced by npm run probe:upstream-throughput): limit:evidence.envelope.totalTimeoutMs ÷ 1,000 × 640,000 ÷ 2 = 240 × 640,000 ÷ 2 = 76,800,000 bytes, rounded down, about 120 s of upstream reads; the halving leaves a margin for slower responses. Research runs upstream, then advisories, then signals, one after another, on the one limit:evidence.envelope.totalTimeoutMs deadline: this ceiling and the advisory ceiling (limit:evidence.allocation.advisory.maxRequests) each take half the window at the measured throughput and latency, so together they use the whole window at worst, and signals relies on neither reaching its ceiling. With the derived base of about 29 MiB, the per-member rate reaches it at 62 members ((76,800,000 − 30,408,704) ÷ 750,000 ≈ 61.9). Approved by the maintainer on 2026-11-27, #467; derived rather than written as a value on review of #468; the throughput became a register input with its probe command on 2026-11-27 (L11, #383). It follows the evidence deadline setting (L11, Q1).',
    {
      protects:
        'Caps response bytes of upstream research reads, the ceiling of the per-member upstream byte share, so they cannot take more of the evidence time or runner memory than the evidence window can read.',
      effect:
        "The ceiling of the scaled upstream byte share; a response past the share's remaining bytes is refused with budget and the upstream reader stops.",
      test: 'src/evidence/upstream-read.test.ts > upstream reader accepts a byte share exactly and refuses the byte past it',
    },
  ),
  derived(
    'evidence.allocation.advisory.maxRequests',
    'count',
    ['evidence.envelope.totalTimeoutMs', 'osv.slowestResponseMs'],
    (totalMs, slowest) => Math.floor(totalMs / slowest / 2),
    'The evidence window, limit:evidence.envelope.totalTimeoutMs, divided by the slowest measured OSV response (limit:osv.slowestResponseMs, 541 ms, reproduced by npm run probe:osv-latency), halved for margin and rounded down: 240,000 ÷ 541 = 443.6, halved 221.8, so 221 sequential lookups fit in half the window, about 120 s of OSV. Research runs upstream, then advisories, then signals, one after another, on the one limit:evidence.envelope.totalTimeoutMs deadline: this ceiling and the upstream byte ceiling (limit:evidence.allocation.upstream.maxTotalBytes) each take half the window at the measured throughput and latency, so together they use the whole window at worst, and signals relies on neither reaching its ceiling. Approved by the maintainer on 2026-11-27, #467; the latency became a register input with its probe command on 2026-11-27 (L11, #383). It follows the evidence deadline setting (L11, Q1).',
    {
      protects:
        'Caps advisory lookups, the ceiling of the per-member advisory share, so a large group cannot take more of the shared evidence time than its lookups can use.',
      effect:
        'The ceiling of the scaled advisory request share; requests past the share return budget, and the stage keeps the advisory evidence already read.',
      test: 'src/evidence/advisory-read.test.ts > advisory reader spends exactly its request share and refuses the lookup past it',
    },
  ),
  unjustified('evidence.allocation.advisory.maxTotalBytes', 5 * MiB, 'bytes', {
    protects: 'Caps response bytes of advisory reads so they cannot exhaust runner memory.',
    effect:
      "A response past the share's remaining bytes is refused with budget and the advisory reader stops.",
    note: 'awaiting L8 measurement',
    test: 'src/evidence/advisory-read.test.ts > advisory reader accepts a byte share exactly and refuses the byte past it',
  }),
  derived(
    'evidence.allocation.signals.maxRequests',
    'count',
    [
      'evidence.allocation.signals.readers.malware.maxRequests',
      'evidence.allocation.signals.readers.publishTimes.maxRequests',
      'evidence.allocation.signals.readers.registry.maxRequests',
      'evidence.allocation.signals.readers.metadata.maxRequests',
      'evidence.allocation.signals.readers.upstream.maxRequests',
    ],
    sum,
    "The signals share is the sum of its five readers' request caps.",
    {
      protects:
        "Caps the signals stage's total requests across its five readers so the stage stays inside the envelope.",
      effect: 'Reached only when all five readers are spent; each then returns budget.',
      test: 'none: sum of the five signal reader shares (src/budget.ts:70); the signals stage passes it to enrichPolicySignals (src/research.ts:275), which reads only maxAttempts (src/evidence/policy-signals.ts:171-172), and each reader stops at its own share (for example src/evidence/policy-signals-read.ts:228)',
    },
  ),
  derived(
    'evidence.allocation.signals.maxTotalBytes',
    'bytes',
    [
      'evidence.allocation.signals.readers.malware.maxTotalBytes',
      'evidence.allocation.signals.readers.publishTimes.maxTotalBytes',
      'evidence.allocation.signals.readers.registry.maxTotalBytes',
      'evidence.allocation.signals.readers.metadata.maxTotalBytes',
      'evidence.allocation.signals.readers.upstream.maxTotalBytes',
    ],
    sum,
    "The signals byte share is the sum of its five readers' byte caps.",
    {
      protects:
        "Caps the signals stage's total response bytes across its five readers against runner memory.",
      effect: "Reached only when all five readers' byte caps are spent; each then returns budget.",
      test: 'none: sum of the five signal reader byte shares (src/budget.ts:71); the signals stage passes it to enrichPolicySignals (src/research.ts:275), which reads only maxFindings and maxRetainedBytes (src/evidence/policy-signals-evidence.ts:192-194), and each reader stops at its own byte share',
    },
  ),
  derived(
    'evidence.allocation.signals.readers.malware.maxRequests',
    'count',
    ['packet.changes'],
    (changes) => 2 * changes,
    'An unpaginated, single-URL malware lookup takes 2 requests per change (an Actions or pip stored-name discovery, then the versioned query; npm takes 1), for at most limit:packet.changes changes: 2 × 128 = 256. A long pip spelling set that overflows the discovery URL cap, or a lookup that paginates, can take more; the fitted malware share binds long before this ceiling. Approved by the maintainer on 2026-11-27, #467.',
    {
      protects:
        'Caps malware-signal lookups, the ceiling of the per-member malware share, so the signals stage cannot exhaust the envelope.',
      effect:
        'The ceiling of the scaled malware request share; the lookup past the share returns budget and the malware reader stops, keeping results already read.',
      test: 'src/evidence/advisory-read.test.ts > malware reader spends exactly its request share and refuses the lookup past it',
    },
  ),
  unjustified('evidence.allocation.signals.readers.malware.maxTotalBytes', 1.5 * MiB, 'bytes', {
    protects: 'Caps malware-signal response bytes so they cannot exhaust runner memory.',
    effect: "A response past the share's remaining bytes returns budget and the reader stops.",
    note: 'awaiting L8 measurement',
    test: 'src/evidence/advisory-read.test.ts > malware reader accepts a byte share exactly and refuses the byte past it',
  }),
  unjustified('advisory.discovery.pageSize', 50, 'count', {
    protects:
      'A stored-name discovery page of heavily advised packages fits the 1 MiB per-response cap (a 100-record pillow page did not).',
    effect:
      'Discovery asks for this many records per page and follows every page under the cursor rules.',
    note: "approved 2026-11-20 from GitHub probes recorded in S1's Package Name Form Amendment; no repository command reproduces them",
    test: 'src/evidence/advisory-read.name-forms.test.ts > a long name splits discovery so every spelling is sent once with cursor headroom',
  }),
  unjustified('advisory.discovery.urlBytes', 4096, 'bytes', {
    protects:
      'Discovery URLs stay under the length GitHub accepted (414 at 8,259 bytes). Batch URLs reuse it through limit:advisory.batch.urlBytes.',
    effect:
      'Spellings split across as many discovery requests as the cap requires; a continuation URL over it is budget.',
    note: "approved 2026-11-20 from GitHub probes recorded in S1's Package Name Form Amendment; no repository command reproduces them",
    test: 'src/evidence/advisory-read.name-forms.test.ts > a continuation URL of exactly 4,096 bytes is followed; one byte longer is budget',
  }),
  unjustified('advisory.discovery.cursorHeadroomBytes', 256, 'bytes', {
    protects:
      "Each discovery request's first URL leaves room under the URL cap for GitHub's `after` cursor.",
    effect: 'A first discovery URL is filled to at most the URL cap minus this headroom.',
    note: "approved 2026-11-20 from GitHub probes recorded in S1's Package Name Form Amendment; no repository command reproduces them",
    test: 'src/evidence/advisory-read.name-forms.test.ts > discovery fills a request up to exactly 256 bytes under the cap',
  }),
  unjustified('advisory.discovery.spellingCeiling', 243, 'count', {
    protects:
      'A pip name with many separators cannot fan out into an unbounded number of discovery requests.',
    effect:
      'A name with more spellings (more than 5 separators) is unsupported before any request.',
    note: "approved 2026-11-20 from GitHub probes recorded in S1's Package Name Form Amendment; no repository command reproduces them",
    test: 'src/evidence/advisory-read.name-forms.test.ts > a name over the spelling ceiling sends no request',
  }),
  // Request batching values, approved by the user on 2026-11-26 from the C3 probe run (#390).
  {
    id: 'advisory.batch.maxTargets',
    value: 1_000,
    unit: 'count',
    protects:
      'A versioned advisory batch never lists more targets than GitHub documents for one `affects` filter.',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/security-advisories/global-advisories',
      checked: '2026-11-26',
      platformValue: 1_000,
      margin:
        'none: the documented maximum is the ceiling; on real targets the URL cap (limit:advisory.batch.urlBytes) binds long before this count',
    },
    effect:
      'A batch holds at most this many targets; the next target starts another batch, and a batch is never refused for its count.',
    test: 'src/evidence/batches.test.ts > a batch holds exactly the register maximum of targets, and one more starts another batch',
  },
  derived(
    'advisory.batch.urlBytes',
    'bytes',
    ['advisory.discovery.urlBytes'],
    copy,
    'Batch URLs reuse the discovery URL cap (user-approved 2026-11-26). The C3 probe (`npm run probe:batching`, L8 corpus targets) saw npm batch URLs answered 200 up to 5,694 bytes and 414 from 8,893 bytes; the discovery probe saw 200 at 4,371 and 414 at 8,259.',
    {
      protects:
        'Batch URLs stay below the shortest URL GitHub rejected as too long on any advisory query (8,259 bytes, on discovery; npm batches from 8,893), with margin.',
      effect:
        "A batch's first URL is filled to at most this cap less limit:advisory.batch.cursorHeadroomBytes, and the next target starts another batch; a target that cannot fit alone is left to its singleton query. In the batching probe, which fits URLs at the longer per_page=100 form and so can measure one target fewer than production fits, a sweep batch's first URL and the batch at the proposed maximum stay within the same bound, and only a 414 to a batch size whose URL is over this cap leaves the verdict unaffected (tests/measure-batching/probe.test.ts > a URL of exactly the cap is inside it and one byte longer is over it; > the sweep fits each first URL at the longest page size, leaving the cursor headroom; > sizes GitHub rejects as too long are reported as rejected and do not block complete).",
      test: 'src/evidence/batches.test.ts > a batch first URL of exactly the cap less the cursor headroom fits; one byte longer does not',
    },
  ),
  derived(
    'advisory.batch.cursorHeadroomBytes',
    'bytes',
    ['advisory.discovery.cursorHeadroomBytes'],
    copy,
    "Batches reuse discovery's first-URL cursor headroom (user-approved 2026-11-26).",
    {
      protects:
        "Each batch's first URL leaves room under the URL cap for GitHub's `after` cursor on later pages.",
      effect: "A batch's first URL is at most limit:advisory.batch.urlBytes less this headroom.",
      test: 'src/evidence/batches.test.ts > a batch first URL of exactly the cap less the cursor headroom fits; one byte longer does not',
    },
  ),
  derived(
    'advisory.batch.pageSize',
    'count',
    ['advisory.discovery.pageSize'],
    copy,
    "Batches reuse discovery's page size (user-approved 2026-11-26). The C3 probe's largest npm batch page was 121,579 bytes at per_page=100; the size reuses discovery's, whose 100-record pillow discovery page (1,009,662 bytes) shows how heavily advised record sets approach limit:evidence.envelope.maxResponseBytes.",
    {
      protects: 'A batch page of heavily advised packages fits the per-response byte cap.',
      effect: 'A batch asks for this many records per page and follows every page.',
      test: 'src/evidence/batches.test.ts > a batch URL asks for the register page size',
    },
  ),
  {
    id: 'upstream.tagExistence.maxCandidatesPerQuery',
    value: 100,
    unit: 'count',
    protects:
      'One GraphQL tag existence query stays far below GraphQL node and size limits and costs one point.',
    basis: {
      kind: 'measured',
      command: 'npm run probe:batching',
      corpus: 'the 241 tag candidates recorded from the L8 corpus by `npm run measure:demand`',
      statistic:
        'max: every query size up to 100 candidates answered 200 at cost 1; the 100-candidate response was 7,139 bytes',
      headroom:
        'none at the measured top size; GitHub documents 500,000 nodes per call, and 100 candidates request a few hundred',
      measured: '2026-11-26',
    },
    effect:
      'Candidates are split into queries of at most this many; the next candidate starts another query.',
    test: 'src/evidence/batches.test.ts > a tag query holds exactly the register maximum of candidates, and one more starts another',
  },
  unjustified('evidence.allocation.signals.readers.publishTimes.maxRequests', 40, 'count', {
    protects:
      'Caps npm publish-time lookups at one per extra changed package, so the signals stage stays inside its share.',
    effect: 'The lookup past the cap is refused with budget and no request is sent.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm-publish-times.test.ts > the publish-time request share allows exactly its count and refuses the next lookup unsent',
  }),
  unjustified(
    'evidence.allocation.signals.readers.publishTimes.maxTotalBytes',
    1.5 * MiB,
    'bytes',
    {
      protects: 'Caps npm publish-time response bytes so they cannot exhaust runner memory.',
      effect: "A response past the share's remaining bytes returns budget and the reader stops.",
      note: 'awaiting L8 measurement',
      test: 'src/evidence/npm-publish-times.test.ts > the publish-time byte share allows exactly its total and refuses the read that exceeds it',
    },
  ),
  unjustified('evidence.allocation.signals.readers.registry.maxRequests', 64, 'count', {
    protects:
      'Caps npm registry policy requests in the signals stage, separate from the W2 registry share, so the stage stays inside the envelope.',
    effect: 'The request past the cap returns budget and no request is sent.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm-registry.test.ts > the signals registry request share allows exactly its count and refuses the next read unsent',
  }),
  unjustified('evidence.allocation.signals.readers.registry.maxTotalBytes', 2 * MiB, 'bytes', {
    protects: 'Caps npm registry policy response bytes so they cannot exhaust runner memory.',
    effect: "A response past the share's remaining bytes returns budget and the reader stops.",
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm-registry.test.ts > the signals registry byte share allows exactly its total and refuses the read that exceeds it',
  }),
  derived(
    'evidence.allocation.signals.readers.metadata.maxRequests',
    'count',
    ['packet.changes'],
    (changes) => 2 * changes,
    'Two PyPI reads (base and head) per change, for at most limit:packet.changes changes: 2 × 128 = 256. Approved by the maintainer on 2026-11-27, #467.',
    {
      protects:
        'Caps PyPI metadata requests in the signals stage, the ceiling of the per-member metadata share, so the stage stays inside the envelope.',
      effect:
        'The ceiling of the scaled metadata request share; the request past the share returns budget and the metadata reader stops.',
      test: 'src/evidence/policy-signals-read.test.ts > metadata reader spends exactly its request share and refuses the request past it',
    },
  ),
  derived(
    'evidence.allocation.signals.readers.metadata.maxTotalBytes',
    'bytes',
    [
      'research.share.signals.metadata.bytes.base',
      'research.share.signals.metadata.bytes.rate.eligible',
      'packet.changes',
    ],
    (base, rate, changes) => base + rate * changes,
    'The largest share the metadata byte formula gives: its base plus its eligible rate for limit:packet.changes uv members, 524,288 + 70,000 × 128 = 9,484,288 bytes. Approved by the maintainer on 2026-11-27, #467.',
    {
      protects:
        'Caps PyPI metadata response bytes, the ceiling of the per-member metadata byte share, so they cannot exhaust runner memory.',
      effect:
        "The ceiling of the scaled metadata byte share; a response past the share's remaining bytes returns budget and the reader stops.",
      test: 'src/evidence/policy-signals-read.test.ts > metadata reader accepts a byte share exactly and refuses the byte past it',
    },
  ),
  unjustified('evidence.allocation.signals.readers.upstream.maxRequests', 16, 'count', {
    protects:
      'Caps GitHub Actions upstream requests in the signals stage so the stage stays inside the envelope.',
    effect: 'The request past the cap returns budget and the upstream reader stops.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/upstream-read.test.ts > signals upstream reader spends exactly its request share and refuses the request past it',
  }),
  unjustified('evidence.allocation.signals.readers.upstream.maxTotalBytes', 0.5 * MiB, 'bytes', {
    protects: 'Caps GitHub Actions upstream response bytes so they cannot exhaust runner memory.',
    effect:
      "A response past the share's remaining bytes is refused with budget and the upstream reader stops.",
    note: 'awaiting L8 measurement',
    test: 'src/evidence/upstream-read.test.ts > signals upstream reader accepts a byte share exactly and refuses the byte past it',
  }),
  // Research cache, from budget.ts.
  derived(
    'research.cache.maxEntryBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "A cached entry is at most one response, so it is capped at the envelope's response cap.",
    {
      protects:
        "One cached response cannot exceed the envelope's response cap, so a single body cannot fill the run's research cache (memory).",
      effect:
        'A response over the cap is not stored, but the caller still receives all of its bytes.',
      test: 'src/evidence/research-cache.test.ts > stores an entry of exactly the register entry cap and passes one byte more through',
    },
  ),
  derived(
    'research.cache.maxTotalBytes',
    'bytes',
    [
      'evidence.allocation.registry.maxTotalBytes',
      'evidence.allocation.upstream.maxTotalBytes',
      'evidence.allocation.advisory.maxTotalBytes',
      'evidence.allocation.signals.maxTotalBytes',
    ],
    sum,
    'The cache holds at most the registry, upstream, advisory, and signals byte shares.',
    {
      protects:
        "Total cache bytes are bounded by the byte shares that fill the cache, so repeated fetches cannot grow the run's memory without limit (memory).",
      effect:
        'An entry that would push the cache past its total is not stored, but the response is still returned.',
      test: 'src/evidence/research-cache.test.ts > stores entries up to exactly the register total and passes the next byte through',
    },
  ),
  // W2 evidence readers, from collection.ts.
  derived(
    'w2.session.maxRequests',
    'count',
    ['evidence.allocation.session.maxRequests'],
    copy,
    "The session reader's request cap is its allocation share's request cap.",
    {
      protects:
        "Bounds the GitHub API requests one review session may dispatch, so PR-driven reads cannot run past the session's share of the evidence envelope; the spec requires explicit request budgets.",
      effect:
        'At the cap the next dispatch throws a budget failure before any fetch, the session stops for later operations, and results already read are kept.',
      test: 'src/github-read.test.ts > requires final metadata to complete discovery within %s requests',
    },
  ),
  derived(
    'w2.session.maxPages',
    'count',
    ['github.treeMaxFiles', 'github.pageSize'],
    (files, pageSize) => Math.ceil(files / pageSize),
    'Enough pages for every row GitHub lists: limit:github.treeMaxFiles files at limit:github.pageSize per page, rounded up. GitHub stops the list there, so a further page can never hold a row. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        "Bounds PR-file listing requests to the pages GitHub's file list can fill, so a PR's file list cannot drive unbounded paging.",
      effect:
        'Requesting a page beyond the cap throws budget before dispatch, discovery is partial with reason budget, and rows already read are kept.',
      test: 'src/github-read.test.ts > discovery reads exactly w2.session.maxPages pages and keeps the rows it read',
    },
  ),
  derived(
    'w2.session.maxFiles',
    'count',
    ['github.treeMaxFiles'],
    copy,
    'The rows GitHub lists for a pull request, limit:github.treeMaxFiles; a longer list is already truncated by GitHub, and the reader marks it so. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Caps PR-file rows examined per session, so an oversized file list cannot make the reader parse and retain unbounded rows.',
      effect:
        'Examining one row beyond the cap throws budget, discovery is partial with reason budget, and the earlier rows are retained.',
      test: 'src/github-read.test.ts > accepts exact file entry count and rejects one beyond %s',
    },
  ),
  unjustified('w2.session.maxJsonEntries', 200_000, 'count', {
    protects:
      'Caps JSON properties and array elements across examined GitHub responses, so a hostile or very large response cannot make the reader walk unbounded structure (memory and CPU).',
    effect:
      'Crossing the cumulative count throws budget and marks the session stopped, so the current read fails and later reads are refused.',
    test: 'src/github-read.test.ts > accepts exact cumulative JSON-entry boundary at %s',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'w2.session.maxResponseBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "The session reader's response cap is the envelope's response cap.",
    {
      protects:
        'Caps the streamed bytes of one GitHub response, error bodies included, so one PR-driven response cannot exhaust memory.',
      effect:
        'The body stream is aborted and the read throws budget on the first chunk that crosses the cap, with the session marked stopped.',
      test: 'src/github-read.test.ts > counts UTF-8 streamed bytes at exact %s boundary',
    },
  ),
  unjustified('w2.session.maxFileBytes', 500_000, 'bytes', {
    protects:
      "Caps the decoded bytes of one immutable file the session returns, so a PR's lockfile or workflow blob cannot make the reader decode and retain unbounded content.",
    effect:
      'A blob whose decoded size exceeds the cap throws budget before the content is decoded, and the session is marked stopped.',
    test: 'src/github-read.test.ts > accepts exact decoded file budget and rejects overflow at %s bytes',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'w2.session.maxTotalBytes',
    'bytes',
    ['evidence.allocation.session.maxTotalBytes'],
    copy,
    "The session reader's byte cap is its allocation share's byte cap.",
    {
      protects:
        "Caps streamed response bytes plus decoded file bytes for the session, so PR-driven reads cannot exceed the session's share of the evidence envelope.",
      effect:
        'The read that crosses the cap throws budget in readBody or blobBytes, the session is marked stopped, and later reads fail with budget.',
      test: 'src/github-read.test.ts > counts UTF-8 streamed bytes at exact %s boundary',
    },
  ),
  unjustified('w2.session.maxRetainedBytes', 2_000_000, 'bytes', {
    protects:
      'Caps cumulative UTF-8 bytes of results the session keeps in memory, so repeated or large results cannot grow retained memory without bound.',
    effect:
      'A single retained result that does not fit throws budget and marks the session stopped; a collection that overflows keeps the prefix that fits and reports budget.',
    test: 'src/github-read.test.ts > retained results share a cumulative byte budget with exact UTF-8 accounting',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'w2.session.requestTimeoutMs',
    'milliseconds',
    ['evidence.envelope.requestTimeoutMs'],
    copy,
    "The session reader's request timeout is the envelope's request timeout.",
    {
      protects:
        "Bounds one GitHub request and its body to the envelope's request timeout, so a stalled PR-driven read cannot hold the job past its time.",
      effect:
        'The request is aborted at the smaller of this value and the time left; the result is unavailable with reason timeout, and a late success is rejected.',
      test: 'src/github-read.test.ts > aborts an in-flight request at its deadline and rejects late success',
    },
  ),
  derived(
    'w2.npm.maxFileBytes',
    'bytes',
    ['w2.session.maxFileBytes'],
    copy,
    'A package-lock.json may be as large as any file the session reader returns, as a uv.lock may (#462). Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Caps the decoded bytes of one PR-controlled package-lock.json before JSON parsing, so a huge lockfile cannot make the npm reader parse unbounded data (memory and CPU).',
      effect:
        'A file over the cap is refused with budget before parsing, so the inventory is not claimed complete.',
      test: 'src/evidence/npm.test.ts > the file byte cap admits a lockfile of exactly the registered size and refuses one byte more',
    },
  ),
  {
    id: 'w2.npm.maxJsonDepth',
    value: 32,
    unit: 'count',
    protects:
      'Caps nesting depth of PR-controlled package-lock.json input, so deeply nested JSON cannot exhaust the stack or CPU in the depth walk and parser.',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: package-lock.json v3 nests five levels (packages, a package path, a field such as dependencies, and its entries); the npm/cli lockfile read on 2026-11-27 nests five. Harm: the reader walks the parsed value and serializes what it keeps, and JSON.stringify overflows the call stack at about 4,166 levels of nested arrays (measured on 2026-11-27 under Node 22). The cap sits far between the two. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      'Depth over the cap throws budget: the input envelope is reported invalid with no reads, and a parsed file yields a budget gap.',
    test: 'src/evidence/npm.test.ts > counts the input envelope as depth 1 like parsed files',
  },
  unjustified('w2.npm.maxJsonEntries', 100_000, 'count', {
    protects:
      'Caps cumulative JSON entries across PR-controlled lockfiles, so many or wide objects cannot drive unbounded parse and walk work.',
    effect:
      'Crossing the cumulative count throws budget, and the file yields a budget gap so inventory is not claimed complete.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm.test.ts > the cumulative JSON entry cap admits exactly the registered count and refuses one more',
  }),
  configured(
    'w2.npm.maxRoots',
    10,
    'count',
    { setting: 'limits.coverage.npmRoots', maximum: 'dependabot.maxRoots' },
    "The adopter: each changed npm root costs lockfile reads on both sides from the session's GitHub requests, so a larger setting buys coverage of more package directories with quota and time. Coverage bound category (L11, Q9(a)); its hard maximum is the roots dependabot.yml may name.",
    {
      protects:
        'Caps the number of changed npm roots read in one run, so a PR touching many package directories cannot multiply lockfile reads beyond the session budget.',
      effect:
        'Roots past the cap are not read; a budget gap is recorded for the whole inventory and the first sorted roots are kept.',
      test: 'src/evidence/npm.test.ts > the changed npm root cap reads exactly the registered number of roots and records a budget gap for the rest',
    },
  ),
  unjustified('w2.npm.maxRetainedBytes', 2_000_000, 'bytes', {
    protects:
      'Caps the serialized npm inventory bytes kept in memory and handed to the graph stage.',
    effect:
      'The inventory is trimmed to the longest prefix that fits with a budget gap; if no prefix fits the result is unavailable with reason budget.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm.test.ts > the retained inventory cap keeps a whole inventory at its exact serialized size and trims one byte under it',
  }),
  {
    id: 'w2.actions.maxFileBytes',
    value: 500_000,
    unit: 'bytes',
    protects:
      'Caps the bytes of one PR-controlled workflow file before YAML parsing, so a huge workflow cannot make the YAML parser run unbounded (memory and CPU).',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/actions/reference/limits',
      checked: '2026-11-27',
      platformValue: 500_000,
      margin:
        'none: "Workflow file size: 500 KB per file; larger files won\'t start runs." GitHub writes KB, so this reads it as the smaller 500,000 bytes, the safe reading; a workflow larger than GitHub runs is not a legitimate input. It must stay at most limit:w2.session.maxFileBytes, which src/limits.test.ts checks. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      'The workflow read returns unavailable with reason budget before decoding, so no jobs from that file are parsed.',
    test: 'src/evidence/actions-yaml.test.ts > enforces byte, node, nesting and occurrence limits with fatal UTF-8 decoding',
  },
  unjustified('w2.actions.maxWorkflows', 20, 'count', {
    protects:
      'Caps workflow files read per run, so a PR touching many workflows cannot multiply session reads beyond the request and time budgets.',
    effect:
      'Files past the cap are not read, are recorded as skipped, and add a budget gap; changes from files already read are kept.',
    test: 'src/evidence/actions.test.ts > workflow limits and later read failures retain earlier changes',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.actions.maxYamlNodes', 100_000, 'count', {
    protects:
      'Caps YAML nodes per PR-controlled workflow, so a node-amplifying document cannot make composition unbounded (memory and CPU).',
    effect:
      'Debiting past the cap throws budget and the workflow read is unavailable with reason budget.',
    test: 'src/evidence/actions-yaml.test.ts > counts cumulative nodes and UTF-8 bytes at exact boundaries and bounds deeply nested flow input before composition',
    note: 'awaiting L8 measurement',
  }),
  {
    id: 'w2.actions.maxYamlDepth',
    value: 32,
    unit: 'count',
    protects:
      'Caps YAML nesting depth before composition, so deeply nested input cannot exhaust the recursion stack or CPU in the composer.',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: a workflow nests about six levels (jobs.<id>.steps[].with.<input>); four large public workflows read on 2026-11-27 (microsoft/vscode pr.yml, nodejs/node test-linux.yml, pytorch/pytorch pull.yml, home-assistant/core ci.yaml) nest five or six. Harm: composition recurses at least once per level, and the yaml library overflows the call stack at about 1,024 levels of nested flow collections (measured on 2026-11-27 under Node 22). The cap is checked before composition and sits far between the two. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      'Exceeding the depth throws budget and the workflow read is unavailable with reason budget.',
    test: 'src/evidence/actions-yaml.test.ts > counts cumulative nodes and UTF-8 bytes at exact boundaries and bounds deeply nested flow input before composition',
  },
  unjustified('w2.actions.maxAliasExpansions', 100, 'count', {
    protects:
      'Caps alias expansions in one YAML document, so anchors and aliases cannot amplify the composed graph beyond the node budget.',
    effect:
      'The alias that exceeds the cap throws budget and the workflow read is unavailable with reason budget.',
    test: 'src/evidence/actions-yaml.test.ts > expands anchored jobs, steps and refs into independent consuming locations',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.actions.maxOccurrences', 1_000, 'count', {
    protects:
      'Caps action-use occurrences across read workflows, so a workflow with unbounded uses entries cannot make identity parsing and retained output unbounded (memory and CPU).',
    effect:
      'Debiting past the cap throws budget for that workflow read; the shared budget also accumulates across base and head files.',
    test: 'src/evidence/actions.test.ts > occurrence and alias budgets accumulate across base/head files',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.actions.maxRetainedBytes', 2_000_000, 'bytes', {
    protects: 'Caps the serialized actions inventory bytes kept in memory.',
    effect:
      'The inventory is trimmed to the longest prefix that fits with a budget gap; if no prefix fits the result is unavailable with reason budget.',
    test: 'src/evidence/actions.test.ts > retention bounds preserve explicit incompleteness, valid packet references and a detached immutable result',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'w2.uv.maxFileBytes',
    'bytes',
    ['w2.session.maxFileBytes'],
    copy,
    'A uv.lock or pyproject.toml may be as large as any file the session reader returns, as a package-lock.json may (approved by the maintainer on 2026-11-27, #462).',
    {
      protects:
        'Caps bytes of one PR-controlled uv.lock or pyproject.toml before fatal UTF-8 decoding and TOML parsing.',
      effect:
        'A file over the cap throws budget before decoding, and the side yields a budget gap for that file.',
      test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
    },
  ),
  {
    id: 'w2.uv.maxTomlDepth',
    value: 32,
    unit: 'count',
    protects:
      'Caps TOML nesting depth in PR-controlled files, so recursive inline parsing cannot exhaust the stack.',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: a uv.lock nests eight levels of tables and arrays (package, its wheels or dependencies, an entry, its fields); four public uv.lock files read on 2026-11-27 (astral-sh/uv, pydantic/pydantic, fastapi/fastapi, apache/airflow) nest eight. Harm: TOML parsing recurses per level, and smol-toml overflows the call stack at about 3,328 levels of nested inline arrays when its own depth guard is off (measured on 2026-11-27 under Node 22); the cap is also the depth guard the parser is given. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect: 'Exceeding the depth throws budget for that file and the side yields a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
  },
  unjustified('w2.uv.maxTomlEntries', 100_000, 'count', {
    protects:
      'Caps cumulative TOML object properties and array elements across all uv files, so ignored fields cannot drive unbounded parse work.',
    effect: 'Debiting past the cap throws budget and the file yields a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'w2.uv.maxPackages',
    'count',
    ['w2.uv.maxRoots', 'w2.uv.maxFileBytes', 'uv.minRecordBytes'],
    (roots, fileBytes, recordBytes) => Math.floor((2 * roots * fileBytes) / recordBytes),
    'As many package entries as the uv.lock files one run reads can hold: 2 sides (base and head) × limit:w2.uv.maxRoots lockfiles of at most limit:w2.uv.maxFileBytes, over the smallest array element the parser counts, limit:uv.minRecordBytes, rounded down. The count is cumulative across files and sides, so a fixed number bound legitimate PRs (one 600-package uv.lock read on base and head passes 1,000); bytes bound the input first. It follows the uv root setting (L11, Q1(a)). Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Caps cumulative attempted package entries across uv.lock files, so a very large lock cannot drive unbounded parse and graph work.',
      effect: 'Debiting past the cap throws budget and the file yields a budget gap.',
      test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    },
  ),
  derived(
    'w2.uv.maxDeclarations',
    'count',
    ['w2.uv.maxRoots', 'w2.uv.maxFileBytes', 'uv.minRecordBytes'],
    (roots, fileBytes, recordBytes) => Math.floor((2 * 2 * roots * fileBytes) / recordBytes),
    'As many requirement declarations as the files one run reads can hold: 2 sides (base and head) × limit:w2.uv.maxRoots roots × 2 files (pyproject.toml and the uv.lock requires-dist lists) of at most limit:w2.uv.maxFileBytes, over the smallest array element the parser counts, limit:uv.minRecordBytes, rounded down. The count is cumulative, so bytes bound the input first. It follows the uv root setting (L11, Q1(a)). Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Caps cumulative requirement declarations from manifests and lock requires-dist items, bounding requirement parsing work.',
      effect: 'Debiting past the cap throws budget and the side yields a budget gap.',
      test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    },
  ),
  derived(
    'w2.uv.maxEdges',
    'count',
    ['w2.uv.maxRoots', 'w2.uv.maxFileBytes', 'uv.minRecordBytes'],
    (roots, fileBytes, recordBytes) => Math.floor((2 * roots * fileBytes) / recordBytes),
    'As many dependency edges as the uv.lock files one run reads can hold: 2 sides (base and head) × limit:w2.uv.maxRoots lockfiles of at most limit:w2.uv.maxFileBytes, over the smallest array element the parser counts, limit:uv.minRecordBytes, rounded down. The count is cumulative, so bytes bound the input first. It follows the uv root setting (L11, Q1(a)). Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects: 'Caps cumulative dependency edges parsed from uv.lock, bounding graph input size.',
      effect: 'Debiting past the cap throws budget and the head side yields a budget gap.',
      test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
    },
  ),
  derived(
    'uv.minRecordBytes',
    'bytes',
    [],
    () => Buffer.byteLength('1,'),
    'The fewest bytes one counted record can take in a uv file: the uv parsers debit every element of a package, dependency or requires-dist array before they check it (src/evidence/uv-lock.ts, src/evidence/uv-manifest.ts), and the shortest TOML array element is a one-digit value and its comma. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'Sizes the uv package, declaration and edge counts from the file bytes, so the count bounds never sit below what the bytes admit.',
      effect:
        'Not enforced: it is the divisor of limit:w2.uv.maxPackages, limit:w2.uv.maxDeclarations and limit:w2.uv.maxEdges.',
      test: 'src/evidence/uv-lock.test.ts > every array element counts as one record, so a record can be as small as uv.minRecordBytes',
    },
  ),
  {
    id: 'w2.uv.maxStringBytes',
    value: 4_096,
    unit: 'bytes',
    protects:
      'Caps each TOML key or string value and requirement text, so one very long string cannot drive unbounded decode and identity work.',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: requirement, marker and artifact URL strings run to hundreds of bytes; the longest string in four public uv.lock files read on 2026-11-27 is 463 bytes (a resolution marker). Harm: each string is decoded, normalized and, for a requirement, tokenized and kept, so without a per-string cap one string could be the whole file (limit:w2.uv.maxFileBytes) and multiply that work for every entry that names it. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect: 'A string over the cap throws budget for that entry, which becomes a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
  },
  {
    id: 'w2.uv.maxRequirementTokens',
    value: 200,
    unit: 'count',
    protects:
      'Caps lexical tokens per requirement, so one pathological requirement string cannot drive unbounded tokenization.',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: the longest requirement in four public uv.lock files read on 2026-11-27, a dependency with a four-way platform marker, needs 71 tokens, and the longest requires-dist entry 23. Harm: tokenizing and parsing a requirement is linear in its tokens, and without this cap a string at limit:w2.uv.maxStringBytes would yield up to about 2,000 tokens, each parsed again for every side and root that reads it. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      'Exceeding the token cap throws budget for that requirement, which becomes a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
  },
  {
    id: 'w2.uv.maxMarkerDepth',
    value: 16,
    unit: 'count',
    protects:
      'Caps parenthesis nesting in requirement environment markers, so nested markers cannot drive unbounded recursion.',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: uv writes markers as a disjunction of conjunctions, one level of parentheses; across the 1,546 requires-dist entries and 378 dependency markers of four public uv.lock files read on 2026-11-27 the deepest nests one. Harm: the marker parser recurses once per parenthesis, and plain recursion overflows the call stack at about 9,640 frames (measured on 2026-11-27 under Node 22). Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      'Exceeding the nesting depth throws budget for that requirement, which becomes a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
  },
  configured(
    'w2.uv.maxRoots',
    20,
    'count',
    { setting: 'limits.coverage.uvRoots', maximum: 'dependabot.maxRoots' },
    "The adopter: each selected uv root costs pyproject.toml and uv.lock reads on both sides from the session's GitHub requests, so a larger setting buys coverage of more Python projects with quota and time. Coverage bound category (L11, Q9(a)); its hard maximum is the roots dependabot.yml may name.",
    {
      protects:
        'Caps the number of selected uv roots read, so many changed directories cannot multiply file reads beyond the session budget.',
      effect:
        'Configured roots above the cap make the input invalid (src/evidence/uv.ts:173); discovered roots past the cap are not read and each adds a budget gap.',
      test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
    },
  ),
  unjustified('w2.uv.maxRetainedBytes', 1_000_000, 'bytes', {
    protects: 'Caps serialized uv metadata bytes kept in memory and handed to the graph stage.',
    effect:
      'The metadata is trimmed to the longest fitting root prefix with explicit budget gaps; if no prefix fits the result is unavailable with reason budget.',
    test: 'src/evidence/uv.test.ts > retention keeps a deterministic root prefix and every omitted file scope visible',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.graph.maxGraphWork', 500_000, 'count', {
    protects:
      'Caps structural inspection and proof-search steps in the npm and uv graph stages, so PR-controlled dependency graphs cannot drive unbounded CPU time.',
    effect:
      'Exhaustion throws budget: the uv graph result is unavailable with reason budget, while the uv core inventory with budget observations is kept at the minimum passing work; npm proofs past the cut are truncated with budget reasons.',
    test: 'src/evidence/uv-paths.test.ts > optional proof-work exhaustion retains the entire usable inventory and an explicit limit',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.graph.maxRetainedBytes', 2_000_000, 'bytes', {
    protects:
      "Caps serialized bytes of the graph stage's input and output, so inventories and proofs cannot grow retained memory without bound.",
    effect:
      'Input over the cap throws budget; an output that cannot fit is unavailable with reason budget; optional proofs are dropped first and scope records kept.',
    test: 'src/evidence/npm-graph.test.ts > second proofs are dropped after pair verdicts, and core overflow still fails the result',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'w2.registry.maxRequests',
    'count',
    ['evidence.allocation.registry.maxRequests'],
    copy,
    "The registry reader's request ceiling is its allocation share's request cap; the reader gets the share scaled from the npm inventory's members, capped here.",
    {
      protects:
        'Caps uncached registry requests per session, so the credential-free registry fetch cannot run past the registry share of the envelope.',
      effect:
        'The next uncached request throws budget before dispatch, and later uncached reads return unavailable with reason budget.',
      test: 'src/evidence/npm-registry.test.ts > a request budget stops subsequent uncached reads',
    },
  ),
  derived(
    'w2.registry.maxResponseBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "The registry reader's response cap is the envelope's response cap.",
    {
      protects:
        'Caps one registry response, so a single oversized registry document cannot exhaust memory.',
      effect:
        'An oversized response fails only its own read with reason budget; later reads still run.',
      test: 'src/evidence/npm-registry.test.ts > an oversized response fails only its own read',
    },
  ),
  derived(
    'w2.registry.maxTotalBytes',
    'bytes',
    ['evidence.allocation.registry.maxTotalBytes'],
    copy,
    "The registry reader's byte cap is its allocation share's byte cap.",
    {
      protects:
        'Caps cumulative registry response bytes per session, so many registry reads cannot exceed the registry allocation.',
      effect:
        'The read whose bytes would exceed the cap fails with reason budget, and later reads also return budget.',
      test: 'src/evidence/npm-registry.test.ts > total deadlines and byte exhaustion stop later requests',
    },
  ),
  unjustified('w2.registry.maxJsonEntries', 100_000, 'count', {
    protects:
      'Caps cumulative JSON entries in registry documents, so a very large registry document cannot drive unbounded parse work.',
    effect: 'Crossing the cap throws budget and the read is unavailable with reason budget.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm-registry.test.ts > registry JSON entries at the cap parse and one more entry is a budget failure',
  }),
  {
    id: 'w2.registry.maxJsonDepth',
    value: 32,
    unit: 'count',
    protects:
      'Caps nesting depth in registry documents, so deep JSON cannot exhaust the stack or CPU in the walker.',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: an npm version document nests about four levels; the next, typescript, react, @babel/core and eslint version documents read from registry.npmjs.org on 2026-11-27 nest four. Harm: the reader walks the parsed value and serializes what it keeps, and JSON.stringify overflows the call stack at about 4,166 levels of nested arrays (measured on 2026-11-27 under Node 22). The cap sits far between the two. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect: 'Exceeding the depth throws budget and the read is unavailable with reason budget.',
    test: 'src/evidence/npm-registry.test.ts > registry JSON nesting at the depth cap parses and one level deeper is a budget failure',
  },
  derived(
    'w2.registry.requestTimeoutMs',
    'milliseconds',
    ['evidence.envelope.requestTimeoutMs'],
    copy,
    "The registry reader's request timeout is the envelope's request timeout.",
    {
      protects:
        'Bounds one registry request and its stalled body, so a hung registry response cannot hold the job.',
      effect:
        'The request is aborted at the smaller of this value and the time left, and the result is unavailable with reason timeout.',
      test: 'src/evidence/npm-registry.test.ts > request deadlines bound a fetch and stalled body even when transport ignores abort',
    },
  ),
  derived(
    'w2.totalTimeoutMs',
    'milliseconds',
    ['evidence.envelope.totalTimeoutMs'],
    copy,
    "The W2 total timeout is the envelope's total timeout.",
    {
      protects:
        "Caps the W2 read's total time at the job envelope, so analysis stops before the runner's job timeout kills the run.",
      effect:
        'Each reader gets the smaller of this value and the time left before the deadline; when the envelope runs out, reads stop with reason timeout and partial evidence is kept.',
      test: 'src/collection.test.ts > limits the session to %s',
    },
  ),
  // Research readers, from research.ts.
  {
    id: 'research.maxJsonEntries',
    value: 1_000_000,
    unit: 'count',
    protects:
      'Untrusted upstream JSON cannot make a research reader parse an unbounded number of entries (CPU and memory).',
    basis: {
      kind: 'safety',
      reason:
        'The largest legitimate use is limit:packet.changes members at the highest cumulative upstream entries per member measured on the #462 uv PRs. Those PRs used, in PR order, 251,223 entries for 34 members, 246,140 for 32, 240,318 for 31, and 225,529 for 29; the highest per member is 7,777 (the 29-member PR), so 128 × 7,777 = 995,456, under the cap. In practice the upstream byte ceiling stops reading at about 62 members, about 482,000 entries at 7,777 per member, so the practical margin is about 2×. Harm begins near 18 million: a bench on the development Mac on 2026-11-27 (#467) measured JSON copying at 33 ms per 100,000 entries, and with a 10× allowance for a slower runner, 18 million entries would spend a quarter of limit:evidence.envelope.totalTimeoutMs on JSON copy alone. The cap sits above the first and far below the second. The same value also caps TOML entries in upstream pyproject reads (src/evidence/upstream-github.ts:175) and license expression tokens (src/evidence/policy-signals-licenses.ts:64); there the per-response byte caps bound the input first. Approved by the maintainer on 2026-11-27, #467.',
    },
    effect:
      "Exceeding the cap fails that reader's read with reason budget; the stage stops and is recorded unavailable with its reason.",
    test: 'src/research.test.ts > the npm registry reader counts exactly research.maxJsonEntries entries and refuses one more',
  },
  unjustified('research.maxJsonDepth', 32, 'count', {
    protects:
      'Untrusted upstream JSON cannot nest deeper than the cap, so parsing cannot exhaust the stack or CPU.',
    effect:
      "Input nested deeper than the cap fails that reader's read with reason budget; the stage is recorded unavailable.",
    note: 'no recorded reason',
    test: 'src/evidence/advisory-read.test.ts > advisory JSON depth accepts the register depth exactly and refuses one level deeper',
  }),
  derived(
    'research.maxRetainedBytes',
    'bytes',
    ['research.cache.maxTotalBytes'],
    copy,
    "A research reader may keep what research may read: the registry, upstream, advisory, and signals byte shares that bound the run's research cache. That is about 102 MB of raw cached bodies; parsed copies and V8 object overhead make the worst-case heap a few hundred MB to about 1 GB, still within the default Node heap on the smallest standard GitHub-hosted Linux runner (2 CPUs and 8 GB for private repositories, https://docs.github.com/en/actions/reference/runners/github-hosted-runners, checked 2026-11-27). Approved by the maintainer on 2026-11-27, #467.",
    {
      protects:
        'Bytes a research stage keeps from untrusted responses are bounded, so retained evidence cannot exhaust memory.',
      effect:
        'Exceeding the cap sets the stage stop to budget; the stage stops, keeps the members it already retained, and records the stop.',
      test: 'src/research.test.ts > the npm registry reader retains exactly research.maxRetainedBytes and refuses one byte more',
    },
  ),
  // Policy signals, from policy-signals-evidence.ts.
  {
    id: 'signals.attemptsPerMember',
    unit: 'count',
    protects:
      'Optional signal attempts per member come only from fixed call sites, so the per-member attempt count is structurally bounded and cannot grow with untrusted data.',
    effect:
      'No runtime cap: the constant is exported and read by no runtime code. An attempt count above 15 would be a code defect, not a trimmed result.',
    basis: {
      kind: 'derived',
      inputs: [],
      formula: () => 15,
      description:
        'Each member gets at most 15 signal attempts, one per fixed call site over its sides and the optional categories; no loop runs over untrusted data.',
      structuralTest:
        'src/evidence/policy-signals.test.ts > optional attempt exhaustion keeps a bounded explained result and known deprecation findings',
    },
    test: 'src/evidence/policy-signals.test.ts > optional attempt exhaustion keeps a bounded explained result and known deprecation findings',
  },
  // Snapshot reads, from snapshot.ts.
  unjustified('snapshot.maxBlobBytes', MiB, 'bytes', {
    protects:
      'A repository blob larger than the cap is refused before it is fetched, so one file cannot make the snapshot read unbounded bytes (memory and network).',
    effect:
      'The blob is refused before fetching with reason budget; the snapshot read is reported unusable with that reason.',
    note: 'awaiting L8 measurement',
    test: 'src/snapshot.test.ts > a link target at snapshot.maxBlobBytes is read and one byte more is refused unfetched',
  }),
  derived(
    'snapshot.maxTreeEntries',
    'count',
    ['evidence.allocation.transport.snapshot.maxTotalBytes', 'snapshot.minTreeEntryBytes'],
    (bytes, entryBytes) => Math.floor(bytes / entryBytes),
    'As many tree entries as the snapshot byte share, limit:evidence.allocation.transport.snapshot.maxTotalBytes, can carry at the smallest entry the snapshot accepts, limit:snapshot.minTreeEntryBytes, rounded down. GitHub documents no entry limit for a non-recursive tree, and the bytes bound the listing first, so the count never cuts a listing the share admits. It follows the snapshot byte setting (L11, Q1(a)). Approved by the maintainer on 2026-11-27 (L11, Q7(a), #383).',
    {
      protects:
        'The total number of tree entries listed from GitHub is bounded, so a very large repository cannot make the snapshot listing unbounded (memory and requests).',
      effect:
        'Once the running count exceeds the cap, the listing throws Unavailable with the default reason unknown, and the snapshot is reported unusable.',
      test: 'src/snapshot.test.ts > a listing at snapshot.maxTreeEntries is read and one more entry is refused',
    },
  ),
  derived(
    'snapshot.minTreeEntryBytes',
    'bytes',
    [],
    () =>
      Buffer.byteLength(
        JSON.stringify({ path: 'a', mode: '040000', type: 'tree', sha: '0'.repeat(40) }),
      ) + 1,
    'The serialized size of the smallest tree entry the snapshot accepts (classifyEntry, src/snapshot.ts): a one-character path, a six-character mode, the four-character type tree, a 40-character sha and no optional field, plus the comma that separates it from the next entry. Approved by the maintainer on 2026-11-27 (L11, Q7(a), #383).',
    {
      protects:
        'Sizes limit:snapshot.maxTreeEntries from the snapshot byte share, so the count bound never sits below what the bytes admit.',
      effect: 'Not enforced: it is the divisor of limit:snapshot.maxTreeEntries.',
      test: 'src/snapshot.test.ts > the smallest tree entry the snapshot accepts serializes to snapshot.minTreeEntryBytes',
    },
  ),
  // GitHub reads, from runtime.ts. Each mirrors the evidence share it is read from.
  derived(
    'github.snapshot.maxRequests',
    'count',
    ['evidence.allocation.transport.snapshot.maxRequests'],
    copy,
    "The GitHub snapshot share's request cap mirrors the transport snapshot allocation.",
    {
      protects:
        'Snapshot reads have their own request share, so a heavy snapshot cannot use up the requests that freshness checks need after a slow model run (time and API quota).',
      effect:
        'The transport refuses the next snapshot read with reason budget; freshness reads are unaffected.',
      test: 'src/runtime.test.ts > refuses a %s read after its own request share',
    },
  ),
  derived(
    'github.snapshot.maxTotalBytes',
    'bytes',
    ['evidence.allocation.transport.snapshot.maxTotalBytes'],
    copy,
    "The GitHub snapshot share's byte cap mirrors the transport snapshot allocation.",
    {
      protects:
        'Snapshot reads have a byte share, so one large snapshot cannot exhaust the response bytes that other reads depend on (memory and quota).',
      effect:
        "Once the share's bytes are spent, the next snapshot read returns budget; the freshness share is untouched.",
      test: "src/runtime.test.ts > stops a %s read at that share's byte limit and leaves the other share alone",
    },
  ),
  derived(
    'github.freshness.maxRequests',
    'count',
    ['evidence.allocation.transport.freshness.maxRequests'],
    copy,
    "The GitHub freshness share's request cap mirrors the transport freshness allocation.",
    {
      protects:
        'Freshness reads keep a reserved request share, so a finished review can still be checked after a slow model run (time and API quota).',
      effect:
        'The transport refuses the next freshness read with reason budget; snapshot reads are unaffected.',
      test: 'src/runtime.test.ts > refuses a %s read after its own request share',
    },
  ),
  derived(
    'github.freshness.maxTotalBytes',
    'bytes',
    ['evidence.allocation.transport.freshness.maxTotalBytes'],
    copy,
    "The GitHub freshness share's byte cap mirrors the transport freshness allocation.",
    {
      protects:
        'Freshness reads keep a reserved byte share, so snapshot traffic cannot starve the checks that run after a slow model (memory and quota).',
      effect:
        "Once the freshness share's bytes are spent, the next freshness read returns budget; the snapshot share is untouched.",
      test: "src/runtime.test.ts > stops a %s read at that share's byte limit and leaves the other share alone",
    },
  ),
  derived(
    'github.maxResponseBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "The GitHub response cap mirrors the evidence envelope's response cap.",
    {
      protects:
        'A GitHub response body larger than the cap is not read in full, so one response cannot exhaust memory (memory).',
      effect:
        'Reading stops once the cap is exceeded, the body is cancelled, and the read returns budget.',
      test: 'src/runtime.test.ts > stops reading an HTTP %i body once it exceeds the per-response bound',
    },
  ),
  derived(
    'github.requestTimeoutMs',
    'milliseconds',
    ['evidence.envelope.requestTimeoutMs'],
    copy,
    "The GitHub request timeout mirrors the evidence envelope's request timeout.",
    {
      protects:
        'A GitHub request cannot run longer than the cap, so a stalled connection cannot hold the job past its window (time).',
      effect: 'The request times out at the cap with reason timeout, and its body is cancelled.',
      test: 'src/runtime.test.ts > times out and cancels an error body that never finishes',
    },
  ),
  derived(
    'github.totalTimeoutMs',
    'milliseconds',
    ['evidence.envelope.totalTimeoutMs'],
    copy,
    "The GitHub total timeout mirrors the evidence envelope's total timeout.",
    {
      protects:
        'The GitHub evidence reads share one deadline, so the reads cannot outlive the job window (time).',
      effect:
        'A late request is limited to the time left before the deadline and returns timeout when that time runs out.',
      test: 'src/runtime.test.ts > limits a late request to the time left in the total deadline',
    },
  ),
  // Source context, from context.ts. Packet copies mirror the packet entry they bound.
  derived(
    'context.maxDependencies',
    'count',
    ['packet.changes'],
    copy,
    "The context dependency cap mirrors the packet's change cap.",
    {
      protects:
        "The packet validator rejects a context with more than 128 dependency entries (the packet's change cap), so a longer list cannot be sent in a packet.",
      effect:
        'More than 128 dependency identities fail the whole source context (category input) before any enumeration or content read; no partial result is kept.',
      test: 'src/context.test.ts > dependency identities are bounded and cannot share IDs',
    },
  ),
  derived(
    'context.maxIdCodeUnits',
    'code units',
    ['packet.idCodeUnits'],
    copy,
    "The context identifier cap mirrors the packet's identifier cap.",
    {
      protects:
        'Packet identifiers are capped at 256 code units, so a longer dependency id or name would fail packet validation.',
      effect:
        'An id or name over 256 code units fails the whole source context (category input) before any read; no partial result.',
      test: 'src/context.test.ts > dependency identities are bounded and cannot share IDs',
    },
  ),
  derived(
    'context.maxPathBytes',
    'bytes',
    ['packet.identityBytes'],
    copy,
    "The context path cap mirrors the packet's identity byte cap that bounds every path.",
    {
      protects:
        'Paths are refused above 1,024 UTF-8 bytes before any filesystem call, matching the packet identity cap that bounds every path.',
      effect:
        'A configured path over 1,024 bytes fails the source context with category path, with no lstat. An over-long tracked path also fails the context with category path. No partial result.',
      test: 'src/context.test.ts > UTF-8 path budget accepts 1,024 bytes and rejects 1,025 before stat',
    },
  ),
  derived(
    'context.maxSourceContextBytes',
    'bytes',
    ['packet.contextBytes'],
    copy,
    "The serialized source-context cap mirrors the packet's context byte cap.",
    {
      protects:
        'The packet rejects a context whose serialized JSON exceeds 65,536 bytes (budget), so the collector must stop before that point.',
      effect:
        'An empty context over the cap fails with category budget (src/context.ts:312). During collection the fact that would overflow is dropped with reason context-byte-limit and collection stops, keeping facts already added (partial).',
      test: 'src/context.test.ts > the serialized context cap admits the exact reserved size and refuses one byte more',
    },
  ),
  derived(
    'context.maxSourceExcerptCodeUnits',
    'code units',
    ['packet.excerptCodeUnits'],
    copy,
    "The excerpt cap mirrors the packet's excerpt code-unit cap.",
    {
      protects:
        'The packet caps each excerpt at 500 code units, so the collector must cut excerpts to that length before building facts.',
      effect:
        'Excerpts are cut to 500 code units with excerptTruncated set. A match whose name falls past the cut is dropped with reason excerpt-limit. Other facts and partial status are kept.',
      test: 'src/context.test.ts > exact 500-unit excerpts and multibyte file-byte boundaries are enforced',
    },
  ),
  derived(
    'context.maxSourceFactsPerDependency',
    'count',
    ['packet.facts'],
    copy,
    "The fact cap per dependency mirrors the packet's fact cap.",
    {
      protects:
        'The packet caps facts per dependency at 20, so the collector must stop adding facts at that count.',
      effect:
        'The 21st fact for a dependency is not added. Reason fact-limit is recorded, status is partial, and the first 20 facts are kept.',
      test: 'src/context.test.ts > line and fact caps retain identity, complete characters, and visible limits',
    },
  ),
  unjustified('context.maxSourceRoots', 16, 'count', {
    protects:
      'Each configured root is walked with lstat and matched against the inventory, so an unbounded root list would make config validation and path checks unbounded.',
    effect:
      'A config with more than 16 sourceRoots fails validation (field context.sourceRoots, category config), so the config is rejected.',
    note: 'no recorded reason',
    test: 'src/config.test.ts > the source root cap admits exactly the registered count and rejects one more',
  }),
  unjustified('context.maxSourceCandidates', 128, 'count', {
    protects:
      'Each excerpt file is stat-checked and matched against the tracked inventory, so the number of excerpt files is capped.',
    effect:
      'More than 128 excerptFiles fails config validation. The runtime candidate-limit (src/context.ts:586-590) would stop scanning with reason candidate-limit, but validated config keeps the selected set at 128 or fewer, so that branch cannot trigger.',
    note: 'awaiting L8 measurement',
    test: 'src/config.test.ts > the excerpt file cap admits exactly the registered count and rejects one more',
  }),
  unjustified('context.maxTrackedPathEntries', 10_000, 'count', {
    protects:
      'The tracked-file inventory is streamed one entry at a time, and the cap stops the scan on an arbitrarily large repository.',
    effect:
      'On the 10,001st inventory entry the scan stops with reason inventory-limit and the iterator is closed. Facts already found and partial status are kept.',
    test: 'src/context.test.ts > inventory budget bounds %i records including duplicates',
    note: 'awaiting L8 measurement',
  }),
  unjustified('context.maxSourceFileBytes', 65_536, 'bytes', {
    protects:
      'A source file is read into memory, so each read is capped at 65,536 bytes plus one probe byte.',
    effect:
      'A file over the cap is not used: reason file-byte-limit is recorded, no facts come from it, status is partial, and other files are still scanned.',
    test: 'src/context.test.ts > file cap distinguishes complete exact-boundary content from an overflow',
    note: 'awaiting L8 measurement',
  }),
  unjustified('context.maxTotalSourceReadBytes', MiB, 'bytes', {
    protects:
      'Total content read per run is capped, so many medium files cannot together read an unbounded amount.',
    effect:
      'When the 1 MiB budget is spent, later files are not read. Reason total-read-limit is recorded and collection stops; facts already found are kept (partial).',
    test: 'src/context.test.ts > total returned bytes, including overflow probes, never exceed one MiB',
    note: 'awaiting L8 measurement',
  }),
  unjustified('context.generatedMarkerScanLines', 20, 'count', {
    protects:
      "Limits generated-file detection to a file's head, where generators write their markers, so a marker deep in a source file does not exclude it.",
    effect: 'A generated marker after line 20 is ignored, and the file stays eligible.',
    note: 'no recorded reason',
    test: 'src/context.test.ts > the generated-marker window covers exactly the registered number of leading lines',
  }),
  // Dependabot roots, from dependabot-roots.ts.
  unjustified('dependabot.maxFileBytes', 65_536, 'bytes', {
    protects:
      'The Dependabot config is parsed in memory, so its size is capped before any YAML parsing.',
    effect:
      'A file over 65,536 bytes is not parsed. The whole file is unavailable with reason budget, and no roots are kept.',
    test: 'src/dependabot-roots.test.ts > accepts values exactly at each limit',
    note: 'awaiting L8 measurement',
  }),
  unjustified('dependabot.maxYamlNodes', 20_000, 'count', {
    protects:
      'The count of YAML nodes is capped before composition, so untrusted config cannot force unbounded parser work.',
    effect: 'Exceeding 20,000 nodes fails the whole file with budget, and no roots are read.',
    note: 'awaiting L8 measurement',
    test: 'src/dependabot-roots.test.ts > the YAML node cap admits exactly the registered node count and refuses one node more',
  }),
  unjustified('dependabot.maxYamlDepth', 16, 'count', {
    protects:
      'YAML nesting is capped, so the parse and compose cannot recurse without bound on untrusted input.',
    effect: 'Nesting deeper than 16 fails the whole file with budget, and no roots are read.',
    test: 'src/dependabot-roots.test.ts > reports exceeding the limit on %s as budget',
    note: 'no recorded reason',
  }),
  unjustified('dependabot.maxAliasExpansions', 0, 'count', {
    protects:
      'YAML aliases are refused, so untrusted input cannot expand shared nodes into a much larger structure.',
    effect: 'Any alias fails the whole file with budget, and no roots are read.',
    test: 'src/dependabot-roots.test.ts > reports exceeding the limit on %s as budget',
    note: 'no recorded reason',
  }),
  unjustified('dependabot.maxUpdates', 256, 'count', {
    protects:
      'Each update entry is a Dependabot job definition, and the count is capped so the root scan stays bounded.',
    effect:
      'More than 256 update entries fail the whole file with budget before any entry is read.',
    test: 'src/dependabot-roots.test.ts > accepts values exactly at each limit',
    note: 'awaiting L8 measurement',
  }),
  unjustified('dependabot.maxRoots', 256, 'count', {
    protects:
      'Distinct roots per ecosystem are capped, so the root list handed to collectors stays bounded.',
    effect:
      'More than 256 distinct roots for one ecosystem makes only that ecosystem unavailable with reason budget. The other ecosystem is unaffected, and no partial list is returned.',
    test: 'src/dependabot-roots.test.ts > limits the roots per ecosystem after deduplication',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'dependabot.maxPathBytes',
    'bytes',
    ['packet.identityBytes'],
    copy,
    "The Dependabot path cap mirrors the packet's identity byte cap that bounds every path.",
    {
      protects:
        'Dependabot paths are capped at the packet identity byte cap (1,024), so a path the packet cannot carry is refused.',
      effect:
        'A path over 1,024 bytes marks only its ecosystem malformed. The other ecosystem stays usable, and no truncated path enters roots.',
      test: 'src/dependabot-roots.test.ts > accepts values exactly at each limit',
    },
  ),
  // Event file, from startup.ts.
  unjustified('startup.maxEventBytes', MiB, 'bytes', {
    protects:
      'The event file is read whole into a buffer before validation; an oversized file would allocate unbounded memory at startup.',
    effect:
      "A file over the cap throws 'event too large' and startup fails; no partial text is returned.",
    test: 'src/startup.test.ts > reads an event file of %s as bounded text only when it is valid',
    note: 'awaiting L8 measurement',
  }),
  // Configuration file and validator bounds, from config.ts.
  unjustified('config.maxBytes', 16_384, 'bytes', {
    protects:
      'The configuration file is read from the checked-out repository, which can be large or hostile; reading it without a cap allocates unbounded memory before parsing.',
    effect:
      'A file over the cap fails with category size before parsing; no default configuration is substituted.',
    test: 'src/config.test.ts > accepts the exact byte limit and rejects overflow',
    note: 'awaiting L8 measurement',
  }),
  unjustified('config.maxModelCodeUnits', 128, 'code units', {
    protects:
      'The configured model ID is passed to the analysis provider request; an unbounded string could flow into it, and the cap with the ASCII pattern keeps it a valid identifier.',
    effect:
      'A model over 128 code units, or one that fails the pattern, fails the config with field analysis.model.',
    note: 'no recorded reason',
    test: 'src/config.test.ts > the model cap admits exactly the registered code units and rejects one more',
  }),
  unjustified('config.maxReleaseAgeDays', 30, 'count', {
    protects:
      "A mistyped release-age window (say 365) would hold every update as too new for a year; the range keeps an adopter's setting to plausible windows.",
    effect:
      'A window below 1 or above 30 fails the config with field policy.minimumReleaseAgeDays.',
    test: 'src/config.test.ts > rejects window $value in parser and schema',
    note: 'no recorded reason',
  }),
  // Comment bodies, from comments.ts.
  {
    id: 'github.comment.maxBodyBytes',
    value: 262_144,
    unit: 'bytes',
    protects:
      "Records GitHub's real limit on an issue or pull-request comment body, which the reviewer's comment cap must stay under.",
    basis: {
      kind: 'external',
      url: 'https://github.com/andrewpucci/dependency-update-advisor/issues/381#issuecomment-7083984132',
      checked: '2026-11-22',
      platformValue: 262_144,
      margin:
        "none: comment.maxBodyCodeUnits derives from it with a worst-case bound. GitHub's 422 says 'maximum is 65536 characters', but the probe found 262,144 UTF-8 bytes enforced on create and update.",
      probe: {
        command: 'npm run probe:comment-limit',
        repositoryType: 'private, user-owned, github.com',
      },
    },
    effect:
      'A longer body is refused by GitHub with a 422; the reviewer never sends one, because its cap derives from this.',
    test: "src/limits.test.ts > the comment cap is derived from GitHub's byte limit so any body within it fits",
  },
  derived(
    'comment.maxBodyCodeUnits',
    'code units',
    ['github.comment.maxBodyBytes'],
    (bytes) => Math.floor(bytes / 3),
    "GitHub's byte limit divided by three, rounded down: one UTF-16 code unit is at most three UTF-8 bytes, so a body within this many code units never exceeds GitHub's limit, whatever its text.",
    {
      protects:
        "The comment body must fit GitHub's comment limit before the write; the renderer rejects oversize bodies instead of truncating them.",
      effect:
        'Oversize publication input fails with category input and no write. The renderer omits optional sections, then fails with size.',
      test: 'src/comments.test.ts > enforces the exact body ceiling and optional digest agreement',
    },
  ),
  // Analysis contract, from analysis/contract.ts, batches.ts, and mistral.ts.
  unjustified('analysis.maxUnits', 8, 'count', {
    protects:
      "A batch's units share one request and one reply. The reviewed batch size (2 to 8 units) was measured against the completion budget, so a larger batch risks length truncation.",
    effect:
      'Batches are packed to at most 8 units; the rest become separate batches. A prepared batch with more units is refused, and a reply with more rows is refused.',
    note: 'awaiting L8 measurement',
    test: 'src/analysis/batches.test.ts > a batch packs exactly the registered unit count and the next unit starts a new batch',
  }),
  unjustified('analysis.sourceBytes', 2_048, 'bytes', {
    protects:
      'The upstream excerpt sent to the model is cut to a byte cap, so one source cannot inflate the request.',
    effect:
      'An excerpt over the cap is shortened and flagged excerptTruncated. The unit is kept and nothing fails.',
    test: 'src/analysis/projection.test.ts > enforces the final escaped UTF-8 request boundary, and truncates only source text',
    note: 'awaiting L8 measurement',
  }),
  unjustified('analysis.unitBytes', 65_536, 'bytes', {
    protects:
      "One unit's attributable JSON is capped, so a single unit cannot push the request over its byte cap.",
    effect:
      'A unit over the cap is refused with budget. Alone it is reported budget with no call; in a batch the batch is split first. No partial unit record is sent.',
    test: 'src/analysis/bounds.test.ts > exact attributable unit bytes retain every required record or reject the whole unit',
    note: 'awaiting L8 measurement',
  }),
  unjustified('analysis.requestBytes', 262_144, 'bytes', {
    protects:
      'The serialized request body is capped before dispatch, so an oversized body is never sent.',
    effect:
      'A body over the cap is refused with budget at preparation (invalid, not attempted) and again before fetch (failed, not attempted). No call is made.',
    test: 'src/analysis/projection.test.ts > enforces the final escaped UTF-8 request boundary, and truncates only source text',
    note: 'awaiting L8 measurement',
  }),
  unjustified('analysis.completionTokens', 16_384, 'tokens', {
    protects:
      'max_tokens caps the output one call may produce, which bounds output cost per call and sizes the reply-byte formula. The spec records that reasoning tokens count against this budget.',
    effect:
      'A reply that reaches the cap ends with finish_reason length and is reported truncated. The batch splits toward single units, and results from other batches are kept.',
    test: 'src/analysis/mistral.test.ts > admits a valid stop at the full token-byte, escaping and envelope allowance, but rejects one extra observed byte',
    note: 'awaiting L8 measurement',
  }),
  unjustified('analysis.requestTimeoutMs', 240_000, 'milliseconds', {
    protects:
      'Each Mistral call is stopped at 240 s, so one hung request cannot consume the analysis window. Live replies took 58 to 101 s.',
    effect:
      'The call is aborted at the earlier of 240 s and the remaining analysis time. It is reported failed with category deadline and yields no assessments.',
    test: 'src/analysis/mistral.test.ts > clips the per-request limit independently of the caller deadline',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'analysis.responseBytes',
    'bytes',
    [
      'analysis.completionTokens',
      'analysis.maxTokenEscapedBytes',
      'analysis.responseEnvelopeBytes',
    ],
    replyBytesFor,
    'The largest legal reply: limit:analysis.completionTokens tokens of at most limit:analysis.maxTokenEscapedBytes JSON-escaped bytes each, plus limit:analysis.responseEnvelopeBytes for the envelope. The reader counts the raw UTF-8 body, in which the content is one JSON string, so the token bound is already in escaped bytes and no escape multiplier applies.',
    {
      protects:
        'The reply body read is capped so a runaway or hostile response cannot exhaust memory. The cap is sized to hold the largest legal reply.',
      effect:
        'A reply body over the cap fails the whole call as response-size. No assessments are kept.',
      test: 'src/analysis/mistral.test.ts > admits a valid stop at the full token-byte, escaping and envelope allowance, but rejects one extra observed byte',
    },
  ),
  {
    id: 'runner.heapBytesPerReplyByte',
    value: 41.44,
    unit: 'bytes',
    protects:
      'States how much heap one reply byte in flight can cost at peak, while the reply is read, parsed and copied, so the heap left for the packet can be computed.',
    basis: {
      kind: 'measured',
      command: 'npm run measure:heap',
      corpus:
        'crafted reply bodies of limit:analysis.responseBytes (16,842,752 bytes) of empty arrays, empty objects and arrays nested 32 deep, for both calls of an invented 12-member npm packet (255,932 bytes, two batches, limit:analysis.maxConcurrentCalls in flight), on Node 24.22.3 (V8 13.6) with a 1 MiB semi space',
      statistic:
        'the smallest --max-old-space-size at which the review completes with the worst shape (nested arrays, 1,335 MiB; flat 895, objects 1,152), less that packet at limit:runner.heapBytesPerPacketByte, divided by the reply bytes in flight (2 × 16,842,718): 41.435, rounded up to 41.44. The process baseline stays in it. At the former 12,648,448-byte cap the same shape needed 1,016 MiB, 41.95 per byte',
      headroom:
        'none at the measured shape; every reply in flight is assumed to be a hostile body of the full reply cap, which no valid reply reaches',
      measured: '2026-11-27',
    },
    effect:
      'Not enforced. limit:analysis.replyHeapBytes multiplies it by the reply bytes in flight.',
    test: 'src/limits.test.ts > the heap inputs of packet.bytes keep their sources and formula',
  },
  derived(
    'analysis.replyHeapBytes',
    'bytes',
    ['analysis.maxConcurrentCalls', 'analysis.responseBytes', 'runner.heapBytesPerReplyByte'],
    (calls, bytes, perByte) => Math.ceil(calls * bytes * perByte),
    'The heap the model replies can hold at peak: limit:analysis.maxConcurrentCalls replies of limit:analysis.responseBytes in flight at once, at limit:runner.heapBytesPerReplyByte each, rounded up. Its measurement includes the process baseline, so limit:packet.bytes needs no separate term for it.',
    {
      protects:
        'Reserves the runner heap the concurrent model replies can take, so the packet cap leaves room for them.',
      effect: 'Not enforced. limit:packet.bytes subtracts it from limit:runner.oldGenerationBytes.',
      test: 'src/limits.test.ts > the heap inputs of packet.bytes keep their sources and formula',
    },
  ),
  unjustified('analysis.textBytes', 1_024, 'bytes', {
    protects:
      'Each model text field (reason, impact, action, rationale) is capped at 1,024 UTF-8 bytes, which the spec states as concise per-unit advice. This is a design choice; the downstream comment body is separately checked.',
    effect:
      'A field over the cap fails validation of the whole reply (category schema), and no assessment is kept.',
    test: 'src/analysis/bounds.test.ts > reason text counts UTF-8 bytes at the exact boundary for %j',
    note: 'no recorded reason',
  }),
  unjustified('analysis.featureBytes', 512, 'bytes', {
    protects:
      'Each capability feature label is capped at 512 bytes, which the spec states as at most one capability per unit.',
    effect:
      'An over-cap feature fails validation of the whole reply (category schema), and no assessment is kept.',
    test: 'src/analysis/bounds.test.ts > capability feature, action and rationale use their own byte ceilings',
    note: 'no recorded reason',
  }),
  unjustified('analysis.followupBytes', 280, 'bytes', {
    protects:
      "Follow-up descriptions are capped at 280 bytes, which the spec says does not expand the baseline's 280-character bound.",
    effect:
      'An over-cap description fails validation of the whole reply (category schema), and no assessment is kept.',
    test: 'src/analysis/bounds.test.ts > follow-up descriptions and list lengths accept the byte ceiling and reject overflow',
    note: 'no recorded reason',
  }),
  unjustified('analysis.steps', 8, 'count', {
    protects:
      'Remediation, validation and follow-up lists are capped at 8 entries, which the spec states as concrete bounded lists. The list length bounds the output each assessment carries.',
    effect:
      'A ninth entry fails validation of the whole reply (category schema), and no assessment is kept.',
    test: 'src/analysis/bounds.test.ts > blocker text, evidence claims and remediation/validation lists preserve their exact limits',
    note: 'no recorded reason',
  }),
  unjustified('analysis.references', 32, 'count', {
    protects:
      'Evidence and reference lists per claim are capped at 32 entries, the count the prompt states, so one claim cannot carry unbounded references.',
    effect:
      'A 33rd evidence entry fails validation of the whole reply (category schema), and no assessment is kept.',
    test: 'src/analysis/bounds.test.ts > blocker text, evidence claims and remediation/validation lists preserve their exact limits',
    note: 'no recorded reason',
  }),
  unjustified('analysis.maxCalls', 32, 'count', {
    protects:
      'Each analysis call is a paid external request with a cost the spec records, so the number of calls per run is capped at the approved 32.',
    effect:
      'Once 32 calls are dispatched no more are sent. The remaining units are recorded unattempted with category call_budget, and earlier assessments are kept.',
    test: 'src/analysis/batches.test.ts > request cap leaves split children explicit and retains earlier work',
    note: 'awaiting L8 measurement',
  }),
  unjustified('analysis.maxConcurrentCalls', 2, 'count', {
    protects:
      'Provider calls in flight are capped at two per run, the concurrency the spec reserves. No provider or platform limit is cited, so the harm is not established.',
    effect:
      'No new call starts while two are in flight. Final records do not depend on completion order.',
    test: 'src/analysis/batches.test.ts > completion order does not change dispatched batches, concurrency, or final states',
    note: 'no recorded reason',
  }),
  unjustified('analysis.maxAnalysisMs', 600_000, 'milliseconds', {
    protects:
      "Analysis time is capped at the spec's 600 s maximum, so the stage cannot outlast the job's time budget.",
    effect:
      'The effective deadline is the earlier of the caller deadline minus the reserve and start plus 600 s. No call dispatches at or after it; in-flight calls end with deadline.',
    note: 'awaiting L8 measurement',
    test: 'src/analysis/batches.test.ts > no call dispatches at or after the registered analysis time cap from the start',
  }),
  unjustified('analysis.publicationReserveMs', 60_000, 'milliseconds', {
    protects:
      'Publication needs time after analysis. Without a reserve, a call could consume the whole deadline and leave nothing to publish.',
    effect:
      'Analysis calls are cut at the caller deadline minus 60 s, which leaves the reserve for publication.',
    test: 'src/analysis/batches.test.ts > a call ended by the deadline timer records the elapsed time at the cutoff',
    note: 'awaiting L8 measurement',
  }),
  unjustified('analysis.maxContentChunks', 64, 'count', {
    protects:
      "A reply's content array is capped at 64 chunks, so chunk iteration over untrusted provider output stays bounded.",
    effect:
      'More than 64 chunks fails the call as envelope. No text is read and no assessment is kept.',
    test: 'src/analysis/mistral.test.ts > rejects %s',
    note: 'no recorded reason',
  }),
  // Complexity report, from scripts/complexity/report.mjs.
  unjustified('complexity.threshold', 15, 'count', {
    protects:
      "Flags new or worsened functions too complex to review reliably, the advisory gate the maintainer's review rules name.",
    effect:
      'Functions above the threshold that are new or worse are listed as advisory; nothing fails.',
    test: 'scripts/complexity/report.test.mjs > reports only new or worse functions above 15, matching duplicates by rank',
    note: 'no recorded reason',
  }),
  unjustified('complexity.gitMaxBufferBytes', 32 * MiB, 'bytes', {
    protects:
      "git output is buffered in memory by execFileSync; without a cap a large ls-tree or show would grow the script's memory without limit.",
    effect:
      'Output over the cap makes execFileSync throw, so the run fails and produces no report for that revision.',
    note: 'awaiting L8 measurement',
    test: 'none: the buffer for git output in the advisory complexity report; a run over it fails the report job, which never gates a merge',
  }),
  unjustified('complexity.cellInputCodeUnits', 160, 'code units', {
    protects:
      'Function names and paths come from the reviewed PR; unbounded cells would inflate the comment past its body ceiling.',
    effect:
      'Each value is cut to the input cap before escaping, so a long name shows truncated with no error.',
    note: 'no recorded reason',
    test: 'none: a display truncation in the advisory complexity report table, which never gates a merge',
  }),
  unjustified('complexity.cellOutputCodeUnits', 200, 'code units', {
    protects:
      'Escaped cell text can grow well past its input length, so an output cap keeps each cell bounded in the comment.',
    effect:
      'Escaped text is cut to the output cap, then a trailing partial entity is removed, so no broken entity is shown.',
    note: 'no recorded reason',
    test: 'none: a display truncation in the advisory complexity report table, which never gates a merge',
  }),
  unjustified('complexity.maxListedFindings', 100, 'count', {
    protects:
      'The regression table lists at most this many rows so the comment stays within its body ceiling; the total count is still reported.',
    effect:
      "The table shows the first 100 rows and the line 'Showing the first 100 of N findings'.",
    note: 'no recorded reason',
    test: 'none: a display cap in the advisory complexity report, which says how many findings it omitted and never gates a merge',
  }),
  {
    id: 'tests.largeInventoryRenderTimeoutMs',
    value: 30_000,
    unit: 'milliseconds',
    protects:
      'Keeps the large-inventory reporting and parity tests, and the schema test that fills a packet to limit:packet.bytes, from failing by chance on a slow CI runner, while still ending a build or render that hangs.',
    basis: {
      kind: 'safety',
      reason:
        "The heaviest of these tests take about 2 s locally and timed out at vitest's 5 s default on CI runners about three times slower (PR #424 for reporting; main at 99131b3 and PR #425 for the parity test that builds the inventory twice); 30 s leaves several times that headroom and still stops a hung test well inside the CI job's timeout.",
    },
    effect:
      "A reporting or parity test past the allowance fails under vitest's timeout behavior, as any timed-out test does.",
    test: 'none: a test-runner allowance for src/reporting.test.ts, tests/parity/large-inventory.test.ts and the exact packet budget test in src/schema.test.ts, which no application code reads',
  },
  {
    id: 'tests.largeInventoryPacketHeadroomBytes',
    value: 4_096,
    unit: 'bytes',
    protects:
      'Real packets this close to `limit:packet.bytes` would lose members to `budget` gaps; this fails the large-inventory parity test when a source-text change leaves its packet less than this far under the cap.',
    basis: {
      kind: 'measured',
      command:
        'npx vp test --run tests/parity/large-inventory.test.ts -t "builds 93", reading Buffer.byteLength(JSON.stringify(packet)) of the scenario packet',
      corpus:
        'the synthetic large inventory: 93 npm members plus 2 same-named nested copies, with C6 and C7 batched source text',
      statistic:
        'exact packet bytes: 1,043,616, unchanged since 2026-11-26, now about 45.8 MB under the heap-derived limit:packet.bytes',
      headroom:
        'the 4,096-byte floor set under the former 1 MiB cap, kept: with the cap derived from heap the floor no longer binds, and the test now fails only if the scenario packet grows to within it of the cap',
      measured: '2026-11-27',
    },
    effect:
      'The large-inventory parity test fails when that packet comes within this many bytes of the packet cap.',
    test: 'tests/parity/large-inventory.test.ts > builds 93 members plus two same-named nested copies as standalone npm units',
  },
  // The demand measurement runs one whole review per test, from scripts/measure-demand.
  unjustified('measureDemand.testTimeoutMs', 900_000, 'milliseconds', {
    protects:
      'A hung review run inside the demand measurement would otherwise run indefinitely; the timeout ends that test. It equals the 15-minute review job limit.',
    effect:
      "A test past the timeout fails under vitest's timeout behavior, which is not read in this repo.",
    note: 'awaiting L8 measurement',
    test: 'none: the timeout of the manual demand measurement, which needs a live token and is not part of npm test',
  }),
  {
    id: 'measureDemand.quotaTraceValueUnits',
    value: 32,
    unit: 'code units',
    protects:
      'Keeps the opt-in quota trace to short rate-limit header values, so an unexpected or oversized header value never reaches a report the maintainer shares.',
    basis: {
      kind: 'safety',
      reason:
        'GitHub rate-limit headers are a short resource name or a whole number (Unix-second resets have 10 digits); 32 code units keeps every expected value with room to spare while rejecting free text.',
    },
    effect:
      "A trace header value that is longer, or is not lowercase letters, digits, and underscores, is reported as 'invalid'.",
    test: 'src/measurement/demand.test.ts > a quota trace reports an unexpected header value as invalid',
  },
  // Limits moved from call sites by the L5 register sweep (issue #377).
  unjustified('signals.reasonCodeUnits', 350, 'code units', {
    protects:
      "Registry deprecation text is untrusted; an unbounded reason would bloat the packet's text and the comment.",
    effect:
      "Longer text is cut at the cap without splitting a surrogate pair and marked '[reason truncated]'.",
    test: 'src/evidence/policy-signals-npm.test.ts > a long deprecation reason never splits a surrogate pair',
    note: 'no recorded reason',
  }),
  unjustified('signals.npmMaxMaintainers', 32, 'count', {
    protects:
      'A registry response can list an unbounded number of maintainers; the cap stops an oversized list from entering the publisher facts.',
    effect:
      'Above 32 maintainers, the maintainers check fails with budget and that observation is recorded as unchecked.',
    note: 'no recorded reason',
    test: 'src/evidence/policy-signals-npm.test.ts > a maintainer list at the registered cap is kept and one more is unchecked for budget',
  }),
  unjustified('research.maxTagCandidates', 100, 'count', {
    protects:
      'Release and tag candidates from untrusted upstream data are bounded, so tag matching cannot grow requests or CPU without limit (requests and CPU).',
    effect:
      'The candidate past the cap fails with reason budget; the upstream stage stops with that reason.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/upstream-range.test.ts > range release candidates are counted up to the register cap and refused one past it',
  }),
  unjustified('research.maxTagDepth', 10, 'count', {
    protects:
      'The annotated-tag chain followed from an untrusted GitHub ref is bounded, so peeling cannot loop or cost unbounded requests (requests).',
    effect: 'A chain deeper than the cap fails with reason budget.',
    note: 'no recorded reason',
    test: 'src/evidence/upstream-github.test.ts > annotated tag chains resolve up to the register depth and fail one tag deeper',
  }),
  unjustified('research.maxWork', 5_000_000, 'count', {
    protects:
      'The work a research reader does on untrusted data is bounded, so one stage cannot consume unbounded CPU (CPU).',
    effect:
      'Spending past the cap sets the stop to budget and throws; the stage stops and its stop is recorded as unavailable.',
    note: 'awaiting L8 measurement',
    test: 'src/research.test.ts > the upstream reader spends exactly research.maxWork units and refuses the next one',
  }),
  unjustified('research.maxAttempts', 512, 'count', {
    protects:
      'The number of attempt records one enrichment can carry is bounded, so the output built from them stays within memory and output size (memory).',
    effect: 'Output with more attempts than the cap fails the enrichment with reason budget.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/upstream.test.ts > upstream bounds keep exactly research.maxAttempts attempts and refuse one more',
  }),
  derived(
    'research.maxFindings',
    'count',
    ['packet.findings'],
    copy,
    "The research finding cap mirrors the packet's finding cap, since research findings land in the packet.",
    {
      protects:
        'Research findings land in the packet, so the research finding cap mirrors the packet findings cap and bounds packet size (packet size).',
      effect: 'Advisory findings past the cap fail the reader with reason budget.',
      test: 'src/evidence/advisory-read.test.ts > advisory findings accept the register cap exactly and refuse the finding past it',
    },
  ),
  derived(
    'analysis.unitDerivedBytes',
    'bytes',
    ['packet.changes', 'packet.relationships', 'packet.idCodeUnits', 'packet.identityBytes'],
    unitDerivedBytes,
    'The string bytes the T5 unit expansion can add beyond copies of packet strings, fixed by the count caps: unitDerivedBytes in src/limits.ts, whose fixed text sizes (UNIT_TEXT) src/units.test.ts pins against src/units.ts, src/schema.ts and src/config.ts. Each id counts at most min(limit:packet.identityBytes, 3 × limit:packet.idCodeUnits) bytes, JSON-escaped or not; the relationship limits number at most 2 (n − k)(k − 1) for n = limit:packet.changes. Approved by the maintainer on 2026-11-28 (L11, #383).',
    {
      protects:
        'Bounds what the decision-unit expansion adds to the snapshot input, so the projection caps can be derived from it.',
      effect: 'Not enforced: limit:analysis.projectionBytes adds it.',
      test: 'src/units.test.ts > the unit expansion of the largest-expansion packet stays inside its structural bound',
    },
  ),
  derived(
    'analysis.unitDerivedEntries',
    'count',
    ['packet.changes', 'packet.relationships', 'packet.reachability'],
    unitDerivedEntries,
    'The values the T5 unit expansion can add beyond copies of packet values, fixed by the count caps: unitDerivedEntries in src/limits.ts. Approved by the maintainer on 2026-11-28 (L11, #383).',
    {
      protects:
        'Bounds what the decision-unit expansion adds to the values the snapshot visits, so the entry cap can be derived from it.',
      effect: 'Not enforced: limit:analysis.projectionEntries adds it.',
      test: 'src/units.test.ts > the unit expansion of the largest-expansion packet stays inside its structural bound',
    },
  ),
  derived(
    'analysis.projectionBytes',
    'bytes',
    ['packet.bytes', 'analysis.unitDerivedBytes', 'config.maxBytes'],
    (packet, units, config) => 3 * packet + units + config + UNIT_TEXT.configDefaultBytes,
    "The string bytes one run input can hold (src/analysis/projection.ts:154; src/analysis/batches.ts:62): the packet's own strings (at most limit:packet.bytes), their copies in the units, at most limit:packet.bytes again plus once more for proof keys JSON-escaped inside ambiguous-anchor limits, so 3 × limit:packet.bytes; the derived unit strings (limit:analysis.unitDerivedBytes); and the config, whose strings come from at most limit:config.maxBytes of text plus its defaults (UNIT_TEXT.configDefaultBytes). Approved by the maintainer on 2026-11-28 (L11, #383).",
    {
      protects:
        'Input work during snapshot (the run input: the accepted packet, its T5 unit expansion and the config, and their detached copy) is capped in string bytes, so crafted input cannot allocate without bound.',
      effect:
        'Exceeding the byte budget throws a budget error and no snapshot or batch is produced. Nothing partial is kept. Every packet T4 accepts fits under it.',
      test: 'src/analysis/projection.test.ts > a packet near its caps with the largest unit expansion passes the projection',
    },
  ),
  derived(
    'analysis.projectionEntries',
    'count',
    ['packet.bytes', 'analysis.unitDerivedEntries', 'config.maxBytes'],
    (packet, units, config) =>
      packet + units + Math.ceil(config / 2) + UNIT_TEXT.configDefaultEntries,
    'The values one run input can hold: every packet value takes at least 2 serialized bytes with its separator, so the packet and its copies in the units hold at most limit:packet.bytes values together; the derived unit values (limit:analysis.unitDerivedEntries); and the config, at most half its limit:config.maxBytes of text plus its defaults (UNIT_TEXT.configDefaultEntries). Approved by the maintainer on 2026-11-28 (L11, #383).',
    {
      protects:
        'Input work during snapshot is capped in values visited (strings, numbers, arrays and objects), so crafted input cannot make the detached copy visit an unbounded number of values.',
      effect:
        'Exceeding the entry budget, or an array or object with more entries than remain, throws a budget error and no snapshot or batch is produced. Nothing partial is kept. Every packet T4 accepts fits under it.',
      test: 'src/analysis/projection.test.ts > a packet near its caps with the largest unit expansion passes the projection',
    },
  ),
  unjustified('analysis.maxProjectionDepth', 64, 'count', {
    protects:
      'Snapshot recursion depth is capped at 64, so deeply nested input cannot exhaust the call stack.',
    effect: 'Input deeper than 64 levels throws a budget error and no snapshot is taken.',
    note: 'no recorded reason',
    test: 'src/analysis/projection.test.ts > the snapshot depth cap admits a leaf at the registered depth and refuses one level deeper',
  }),
  {
    id: 'analysis.maxTokenEscapedBytes',
    value: 1_024,
    unit: 'bytes',
    protects:
      'Bounds the reply bytes one completion token can add: the longest vocabulary token of the models `mistral-large-latest` may point to, measured after JSON string escaping, so the reply byte cap covers the largest legal reply.',
    basis: {
      kind: 'external',
      url: 'https://huggingface.co/mistralai/Mistral-Large-4-1T-A52B/blob/6c0166e17ab8a3d504ff1553804abec9fb0993dc/tekken.json',
      checked: '2026-11-27',
      platformValue: 1_024,
      margin:
        "none: the larger of the two tokenizers the undocumented alias may name. Mistral Large 4 (tekken.json v15 at 6c0166e17ab8a3d504ff1553804abec9fb0993dc, 203,800 vocab tokens) has a 1,024-byte token of 1,024 spaces (rank 128398): 1,024 bytes raw, 1,024 UTF-16 code units, 1,024 bytes JSON-escaped. Mistral Large 3 (mistralai/Mistral-Large-3-675B-Instruct-2512, tekken.json v13 at 51330c9da67945183568346369a07be224e5e1b0, 130,072 vocab tokens) tops out at 76 (rank 98679, 76 '-'). Special tokens, measured from token_str, reach 18 bytes. Escaped bytes are UTF-8 bytes of JSON.stringify of the decoded token, so a provider that writes non-ASCII as \\u escapes could exceed this; the probe also reports that form.",
      probe: {
        command: 'npm run probe:token-length',
        repositoryType:
          'public, organization-owned, huggingface.co model repositories; the file path is the argument',
      },
    },
    effect:
      'Caller limits whose responseBytes is below the reply formula fail preparation as budget (src/analysis/projection.ts). A reply over limit:analysis.responseBytes fails as response-size at runtime.',
    test: 'src/analysis/bounds.test.ts > every declared resource limit rejects larger, unsafe, fractional and incompatible values before a usable handle',
  },
  unjustified('analysis.responseEnvelopeBytes', 65_536, 'bytes', {
    protects:
      "Allowance for the reply's JSON envelope on top of the token text, so a maximal valid reply is not rejected as oversize.",
    effect:
      'Caller limits whose responseBytes is below the formula fail preparation as budget (projection.ts:132-137). A reply over responseBytes fails as response-size at runtime (mistral.ts:350).',
    test: 'src/analysis/bounds.test.ts > every declared resource limit rejects larger, unsafe, fractional and incompatible values before a usable handle',
    note: 'awaiting L8 measurement',
  }),
  derived(
    'advisories.maxLookups',
    'count',
    ['packet.changes'],
    (changes) => 2 * changes,
    'The advisory lookup cap is one identity per side of each packet change.',
    {
      protects:
        'Public identity and action-version lookups sent to advisory sources are bounded to one per side of each packet change, so lookup requests cannot grow past the change count (outbound requests).',
      effect:
        "An input with more lookups than the cap fails validation before any lookup is sent, with reason malformed by advisoryCheck's default.",
      test: 'src/evidence/advisories.test.ts > accepts exactly advisories.maxLookups public identities and refuses one more',
    },
  ),
  {
    id: 'npm.maxIntegrityCodeUnits',
    value: 1_024,
    unit: 'code units',
    protects:
      'The integrity string from the untrusted npm registry is bounded before the hash parser splits and matches it, so the parse cannot do unbounded work (CPU).',
    basis: {
      kind: 'safety',
      reason:
        'Largest legitimate use: an SRI string is the algorithm prefix and a base64 digest, 95 code units for sha512 and about 140 with a second hash; the longest of the npm/cli lockfile read on 2026-11-27 is 95. Harm: the hash parser splits and matches the untrusted string, and without this cap the string could be a whole registry response (limit:w2.registry.maxResponseBytes). Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      "A longer integrity string fails the registry document with reason malformed, so the package's registry evidence is unavailable.",
    test: 'src/evidence/npm-registry.test.ts > an integrity string at the code-unit cap binds and one more code unit is malformed',
  },
  {
    id: 'github.compareMaxFiles',
    value: 300,
    unit: 'count',
    protects:
      'A compare response with the cap or more changed files may be incomplete, so the list is marked truncated instead of being treated as complete (evidence completeness).',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/commits/commits#compare-two-commits',
      checked: '2026-11-27',
      platformValue: 300,
      margin:
        'none: the response "includes up to 300 changed files for the entire comparison", so a list of that length may be cut and is marked truncated. Approved by the maintainer on 2026-11-27 (L11, #383).',
    },
    effect:
      'At or above the cap, filesComplete is false and the reason truncated is recorded; the patches already read are kept.',
    test: 'src/evidence/upstream-github.test.ts > a comparison keeps its file list complete below the register file cap and truncates at it',
  },
  {
    id: 'github.processingTimeoutMs',
    value: 10_000,
    unit: 'milliseconds',
    protects:
      'Records how long GitHub processes one REST request before it terminates it with a timeout response, the floor below which the reviewer would cut off a request GitHub still answers.',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#timeouts',
      checked: '2026-11-27',
      platformValue: 10_000,
      margin:
        'none: "If GitHub takes more than 10 seconds to process an API request, GitHub will terminate the request and you will receive a timeout response." GitHub reserves the right to change the window. The GraphQL API documents the same 10-second processing timeout. It covers processing before the response, not the body transfer, which limit:evidence.envelope.requestTimeoutMs adds.',
    },
    effect:
      'Not enforced by the reviewer; limit:evidence.envelope.requestTimeoutMs derives from it.',
    test: 'none: platform figure; src/limits.test.ts pins how limit:evidence.envelope.requestTimeoutMs derives from it',
  },
  {
    id: 'upstream.throughputBytesPerSecond',
    value: 640_000,
    unit: 'bytes',
    protects:
      'Records the read throughput of upstream research reads (GitHub releases and PyPI JSON), so the request timeout and the upstream byte ceiling can be sized in time.',
    basis: {
      kind: 'external',
      url: 'https://github.com/andrewpucci/dependency-update-advisor/pull/468',
      checked: '2026-11-27',
      platformValue: 640_000,
      margin:
        'none: a measured platform property, not demand (L11, E4, approved 2026-11-27). Bytes per second over the upstream reads of the #462 uv PRs, measured for #467 and stated in #468 as 0.64 MB/s. npm run probe:upstream-throughput reproduces it: it reads each named GitHub releases page and PyPI project one after another and reports the total body bytes over the total wall time, rounded down. The derived ceilings carry their own margin (the upstream byte ceiling takes half the window).',
      probe: {
        command: 'npm run probe:upstream-throughput',
        repositoryType:
          'public, organization- and user-owned, github.com and pypi.org; the arguments name the upstream projects of the #462 uv members',
      },
    },
    effect:
      'Not enforced; limit:evidence.envelope.requestTimeoutMs and limit:evidence.allocation.upstream.maxTotalBytes derive from it. A lower figure gives a longer timeout and a smaller upstream byte ceiling.',
    test: 'tests/probe-research-timing/core.test.ts > throughput is the successful bytes over their summed wall time, rounded down',
  },
  {
    id: 'osv.slowestResponseMs',
    value: 541,
    unit: 'milliseconds',
    protects:
      'Records the slowest OSV v1/query response, so the advisory request ceiling can be sized in time.',
    basis: {
      kind: 'external',
      url: 'https://github.com/andrewpucci/dependency-update-advisor/pull/468',
      checked: '2026-11-27',
      platformValue: 541,
      margin:
        'none: a measured platform property, not demand (L11, E4, approved 2026-11-27). The slowest OSV response measured for #467 and stated in #468. npm run probe:osv-latency reproduces it: it queries each named package version one after another and reports the slowest successful response, rounded up. The advisory ceiling carries its own margin (it takes half the window).',
      probe: {
        command: 'npm run probe:osv-latency',
        repositoryType:
          'public, api.osv.dev; the arguments name the package versions of the #462 uv members',
      },
    },
    effect:
      'Not enforced; limit:evidence.allocation.advisory.maxRequests derives from it. A slower figure gives fewer advisory lookups.',
    test: 'tests/probe-research-timing/core.test.ts > the slowest response is the longest successful read, rounded up',
  },
  {
    id: 'github.pageSize',
    value: 100,
    unit: 'count',
    protects:
      'GitHub returns at most 100 entries per page, so the reader requests 100 and treats a longer page as malformed (outside platform limit).',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files',
      checked: '2026-11-22',
      platformValue: 100,
      margin:
        "none: the reader asks for the endpoint's documented per_page maximum, and a longer page is malformed",
    },
    effect:
      'A page longer than 100 fails the read as malformed (src/github-read.ts:581); a Link URL with a different per_page is a conflict (src/github-read.ts:280); a short page ends pagination (src/github-read.ts:589).',
    test: 'src/github-read.test.ts > a page of exactly github.pageSize rows is accepted and a longer page is malformed',
  },
  {
    id: 'github.treeMaxFiles',
    value: 3_000,
    unit: 'count',
    protects:
      "GitHub's pull-request files endpoint stops at 3,000 files, so a list at that size is incomplete and must be marked truncated (outside platform limit).",
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files',
      checked: '2026-11-22',
      platformValue: 3_000,
      margin:
        'none: a list that reaches the documented maximum may be incomplete, so the value is the maximum itself',
    },
    effect:
      'At 3000 files the discovery stops with reason truncated and keeps the files already read.',
    test: 'src/github-read.test.ts > exactly 3000 files remains partial at the endpoint cap',
  },
  {
    id: 'github.token.restRequestsPerHour',
    value: 1_000,
    unit: 'count',
    protects:
      "Records GitHub's REST quota for the workflow's GITHUB_TOKEN, so the adopter's GitHub request cap can never be set above what the token can spend in an hour.",
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github_token-in-github-actions',
      checked: '2026-11-22',
      platformValue: 1_000,
      margin:
        'none: this is the platform figure itself. Resources owned by a GitHub Enterprise Cloud account get a higher limit (15,000 per hour per repository); this entry records the lower one, which every adopter has. L12 states the headroom below it.',
    },
    effect:
      'Not enforced yet; L12 makes it the hard maximum of the GitHub request cap. Research already follows the quota GitHub reports at run time.',
    test: 'none: platform figure; L12 makes it the hard maximum of the GitHub request cap',
  },
  derived(
    'github.token.requestCapMax',
    'count',
    ['github.token.restRequestsPerHour', 'evidence.allocation.transport.freshness.maxRequests'],
    (perHour, freshness) => perHour - freshness,
    "The joint hard maximum of the GitHub request cap's settings: the documented GITHUB_TOKEN quota, limit:github.token.restRequestsPerHour, less the freshness reads every run makes, limit:evidence.allocation.transport.freshness.maxRequests, so the settings together never spend the reads a review needs to stay valid. It bounds only GitHub reads: limit:research.githubQuota.researchCeiling also counts other hosts, so it cannot serve. Approved by the maintainer on 2026-11-27 (L11, Q6(a), #383).",
    {
      protects:
        "Keeps the adopter's GitHub request settings, together, inside one hour of the GITHUB_TOKEN quota with the freshness reads reserved.",
      effect:
        'Not enforced by the reviewer yet: L12 makes the config parser reject settings whose sum is larger. check:limits checks the defaults against it.',
      test: 'none: the joint hard maximum of adopter settings the parser does not read yet (L12, #384); src/limits.test.ts pins its formula',
    },
  ),
  {
    id: 'github.hostedJobMaxMinutes',
    value: 360,
    unit: 'minutes',
    protects:
      "Records GitHub's job length on a hosted runner, so the adopter's job budget can never be set past the point where GitHub terminates the job.",
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/actions/reference/limits#existing-system-limits',
      checked: '2026-11-22',
      platformValue: 360,
      margin:
        'none: this is the platform figure itself (6 hours); a job that reaches it is terminated and fails. L12 and L13 state the headroom below it.',
    },
    effect:
      'Not enforced yet; L13 makes it the hard maximum of the job budget input. Each workflow sets its own timeout-minutes far below it.',
    test: 'none: platform figure; L12 and L13 make it the hard maximum of the job budget',
  },
  derived(
    'upstream.releasePageSize',
    'count',
    ['github.pageSize'],
    copy,
    'The release ladder starts at GitHub\'s per_page maximum for listing releases, limit:github.pageSize (https://docs.github.com/en/rest/releases/releases#list-releases, "max 100"), as the compare ladder does (#471), so releases that fit read in the fewest pages. Approved by the maintainer on 2026-11-27 (L11, #383).',
    {
      protects:
        'The start size of the release page-size ladder is bounded, so a release page that does not fit the response cap is halved and retried instead of failing outright (response size and memory).',
      effect:
        'A page that does not fit halves and is retried at the same offset; a single release over the cap fails with reason budget.',
      test: 'src/evidence/upstream-releases.test.ts > halves the page until it fits and keeps reading from the same release',
    },
  ),
  derived(
    'upstream.comparePageSize',
    'count',
    ['github.pageSize'],
    copy,
    "The compare ladder starts at GitHub's per_page maximum, limit:github.pageSize, the size the compare read asked for before it had a ladder, so a comparison that fits reads in the fewest pages.",
    {
      protects:
        'The start size of the compare page-size ladder is bounded, so a compare page that does not fit the response cap is halved and retried instead of failing outright (response size and memory).',
      effect:
        'A compare page that does not fit is retried at the next smaller size of a divisor chain from this value down to 1, and each later page returns to the largest size whose boundary falls on the commits already read; a page of one commit over the cap fails the comparison with reason budget. Each retry is an ordinary request against the upstream share.',
      test: 'src/evidence/upstream-github.test.ts > a compare page over the response cap is halved until it fits',
    },
  ),
  unjustified('uv.maxCorroborationCodeUnits', 4_096, 'code units', {
    protects:
      'Lines over the cap are skipped before the claim regex runs, so untrusted changelog text cannot make the matcher do unbounded work (CPU).',
    effect: 'A longer line is skipped and yields no claim; the remaining lines are still read.',
    note: 'no recorded reason',
    test: 'src/evidence/uv-corroboration.test.ts > a changelog line at the registered code-unit cap is read and one code unit longer is skipped',
  }),
  unjustified('uv.corroborationWorkPerEntry', 64, 'count', {
    protects:
      'Each corroborated entry reserves a fixed work cost before any contradiction is learned, so corroboration cannot run past the work budget (CPU).',
    effect:
      'Work that exceeds the graph budget stops corroboration with reason budget, while the validated inventory is kept.',
    note: 'awaiting L8 measurement',
    test: 'none: a multiplier inside the corroboration reservation at src/evidence/uv-corroboration.ts:326; the sum is spent against the graph work budget, which graphWork enforces (src/evidence/uv-input.ts:59-61, left < 0 throws budget) with the limit w2.graph.maxGraphWork (src/collection.ts:60)',
  }),
  unjustified('handoff.maxTraces', 32, 'count', {
    protects:
      'The rehearsal sink is a local, bounded record of runs; an unbounded trace list would grow memory with each run.',
    effect:
      'The 33rd record is refused: record returns false and no trace is kept; existing traces are kept.',
    test: 'src/handoff.test.ts > bounds the rehearsal trace at 32 records and refuses the next',
    note: 'no recorded reason',
  }),
  unjustified('startup.maxReportedDurationMs', 999_999, 'milliseconds', {
    protects:
      'Keeps the one-line stderr timing summary bounded: an injected or faulty clock cannot lengthen the line, since each call prints at most six digits.',
    effect:
      'A duration above the cap prints as the cap in the stderr timing line; the carried timing data is not clamped.',
    test: 'src/startup.test.ts > prints bounded timing for %s',
    note: 'reason stated in SPEC-review-orchestration.md (Bounds): the largest six-digit value, above the 600,000 ms analysis maximum',
  }),
  // Spec values at or below this floor are not checked by check:limits, from scripts/limits/check.ts.
  unjustified('checkLimits.specValueFloor', 64, 'count', {
    protects:
      'Keeps the spec allowlist reviewable: register values of 64 or less match about 800 unrelated spec lines, so check:limits checks only larger values.',
    effect:
      'Spec lines with register values at or below 64 are not checked; larger values must be allowlisted by trimmed text.',
    note: 'no recorded reason',
    test: 'tests/limits/check-limits.test.ts > a register value at the spec floor, or a non-whole number, is not a problem',
  }),
  derived(
    'research.githubQuota.researchCeiling',
    'count',
    [
      'evidence.allocation.upstream.maxRequests',
      'evidence.allocation.advisory.maxRequests',
      'evidence.allocation.signals.maxRequests',
    ],
    sum,
    "The requests research may make on every host, the three research stages' request ceilings together, including the PyPI metadata and npm registry readers' requests: a loose upper bound on research's GitHub requests, not a count of GitHub requests alone.",
    {
      protects:
        "States the approved ceiling for research's GitHub requests that the R1 demand measurement is judged against, so a measured run that exceeds its shares is visible.",
      effect:
        'No runtime check: the demand measurement reports research GitHub requests beside it; each stage is still capped by its own share and the quota guard.',
      test: 'src/measurement/demand.test.ts > the R1 ceiling is the sum of the research request ceilings and scales with them',
    },
  ),
  {
    id: 'research.githubQuota.reserve',
    unit: 'count',
    protects:
      'Keeps GitHub quota for the freshness rechecks that run after research, so a heavy research run cannot leave the final head check without requests.',
    effect:
      'Research GitHub requests are refused once the estimated remaining quota would fall below this; refused members are unavailable with rate_limit and the rechecks still run.',
    basis: {
      kind: 'derived',
      inputs: [],
      formula: () => 6,
      description:
        'Two freshness rechecks run after research (before the model and the final check), each reading the run, the pull request, and the comparison when the base moved.',
      structuralTest:
        'src/pipeline.test.ts > the research quota reserve covers every GitHub read after research',
    },
    test: 'src/pipeline.test.ts > the research quota reserve covers every GitHub read after research',
  },
  {
    id: 'research.githubQuota.retryMarginMs',
    value: 1000,
    unit: 'milliseconds',
    protects:
      "Keeps a resend from reaching GitHub just before its quota resets when the runner's clock runs slightly ahead of GitHub's, which would waste the reader's only wait.",
    basis: {
      kind: 'safety',
      reason:
        'GitHub reports reset times in whole seconds, so the true reset can fall up to a second after the reported one; a second also covers ordinary clock skew between a synced runner and GitHub, while costing research little of its time.',
    },
    effect:
      'A reader waits this long past the retry time before resending, and a wait fits only if the retry time, this margin, and one request timeout fit the time left.',
    test: 'src/evidence/github-quota.test.ts > waits past the retry time by the margin, so a skewed clock does not resend too early',
  },
  {
    id: 'research.githubQuota.waitsPerReader',
    value: 1,
    unit: 'count',
    protects:
      "Bounds how much of research's time one reader can spend idle waiting for a GitHub rate-limit reset, so one stalled reader cannot hold the rest of research back.",
    basis: {
      kind: 'safety',
      reason:
        'One wait covers the common secondary-limit retry-after; a reader rate-limited again after waiting is under sustained pressure, where another wait would mostly spend time the deadline cannot spare.',
    },
    effect:
      "After this many waits, a reader's next rate-limit stop ends its members rate_limit at once and records the retry time.",
    test: 'src/evidence/upstream-read.test.ts > a second stop after a wait ends rate_limit without waiting again',
  },
  {
    id: 'research.githubQuota.windowMs',
    value: 3_600_000,
    unit: 'milliseconds',
    protects:
      'Rejects a reported GitHub quota reset that is not plausible for the hourly limit, so a bad header cannot make research wait or stop for longer than the quota really lasts.',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
      checked: '2026-11-21',
      platformValue: 3_600_000,
      margin: "none: the window is the platform's hourly quota period",
    },
    effect:
      'A reset time more than this far ahead is ignored: the estimate is unchanged and no wait or retry time uses it.',
    test: 'src/evidence/github-quota.test.ts > judges a reset on the wall clock: past or beyond the window is ignored',
  },
  // The comment-limit probe (scripts/probe-comment-limit), run by hand in a test repository.
  {
    id: 'probe.commentLimit.writeIntervalMs',
    value: 1_000,
    unit: 'milliseconds',
    protects:
      "Keeps the probe's comment writes and deletes under GitHub's secondary rate limits, so a run is not cut short or flagged as abuse.",
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#pause-between-mutative-requests',
      checked: '2026-11-22',
      platformValue: 1_000,
      margin:
        "none: GitHub's guidance is to wait at least one second between POST, PATCH, PUT, or DELETE requests, and the probe waits exactly that",
    },
    effect:
      'The probe waits this long before every create, update, or delete after its first, and sends them one at a time.',
    test: 'tests/probe-comment-limit/run.test.ts > mutative requests wait for the full pause and never overlap',
  },
  {
    id: 'probe.commentLimit.maxWrites',
    value: 32,
    unit: 'count',
    protects:
      "Bounds the comments one probe run can create or edit in the user's test repository, far below GitHub's content-creation limit of 80 a minute and 500 an hour.",
    basis: {
      kind: 'safety',
      reason:
        'The longest run, a wrongly stated maximum followed by a halving search from the first body, needs 1 + 2 + 20 + 4 unit bodies + 1 seed + 2 updates + 1 line-break body = 31 writes from a one-MiB first body; 32 covers it, and with as many deletes a run stays under GitHub content-creation limits.',
    },
    effect:
      'At the cap the next write is not sent; the result is inconclusive, and cleanup still deletes every comment made.',
    test: 'tests/probe-comment-limit/run.test.ts > reaching the write cap gives inconclusive and sends no further write',
  },
  {
    id: 'probe.commentLimit.firstBodyCodeUnits',
    value: 1_048_576,
    unit: 'code units',
    protects:
      "Starts the probe's search above GitHub's comment limit, so the first body is rejected and the search has an upper bound.",
    basis: {
      kind: 'safety',
      reason:
        "The first live run (2026-11-22, #381) had a 131,072-unit body accepted unchanged, so the limit is above that and above the 65,536 figure in this spec's Evidence. One MiB of ASCII is eight times that, still one ordinary request, and keeps the longest run within probe.commentLimit.maxWrites. A larger real limit makes the first body accepted and the result inconclusive, never wrong.",
    },
    effect:
      'The first create sends this many ASCII code units; if GitHub accepts it, the probe stops inconclusive.',
    test: 'tests/probe-comment-limit/run.test.ts > the register write cap covers the longest run from the register first body',
  },
  {
    id: 'probe.commentLimit.detailCodeUnits',
    value: 256,
    unit: 'code units',
    protects:
      "Bounds each GitHub validation message the probe prints for a 422 it cannot classify, so untrusted response text cannot flood the user's terminal or the public probe record.",
    basis: {
      kind: 'safety',
      reason:
        "GitHub's validation messages are one short sentence; its too-long message is about 50 units. 256 keeps any such message whole while bounding untrusted text (user-approved 2026-11-22).",
    },
    effect:
      'Each message is cut to this many code units; the run is still inconclusive and nothing else changes.',
    test: 'tests/probe-comment-limit/core.test.ts > an unclassified 422 keeps GitHub validation messages, capped, without links',
  },
  // The batching equivalence probe (scripts/measure-batching), run by hand with the user's token.
  {
    id: 'probe.batching.maxRequests',
    value: 1_500,
    unit: 'count',
    protects:
      "Bounds the REST and GraphQL requests one probe run sends with the user's token, so a run cannot spend that token's hourly quota.",
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
      checked: '2026-11-26',
      platformValue: 5_000,
      margin:
        "3,500 requests, 70% of the hour's quota: the probe runs with the user's personal token, whose 5,000 REST requests per hour every other tool using that token shares. Each GraphQL query is one request here and costs at least one point of the separate 5,000-point GraphQL user quota (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api, checked 2026-11-26), so that quota keeps the same margin. A workflow GITHUB_TOKEN (1,000 per hour per repository) is not a supported token for this probe.",
    },
    effect:
      'At the cap the next request is not sent; the probe stops, its report says the budget ran out and keeps every section it reached, and the verdict is incomplete.',
    test: 'tests/measure-batching/probe.test.ts > at the register request cap the next request is not sent and the report keeps what was measured',
  },
  {
    id: 'probe.batching.maxBatchTargets',
    value: 1_000,
    unit: 'count',
    protects:
      'Sets the largest versioned npm batch the probe sends, at the `affects` maximum GitHub documents, so the probe also tries one more to record what GitHub does above it.',
    basis: {
      kind: 'external',
      url: 'https://docs.github.com/en/rest/security-advisories/global-advisories',
      checked: '2026-11-26',
      platformValue: 1_000,
      margin:
        "none: GitHub's documented `affects` maximum bounds the sizes the probe measures, and the one batch above it records what GitHub does there. The proposed maximum the verification requires (S1 Batched Lookup Amendment) is the largest positive-last batch at or below this value whose first URL fits limit:advisory.batch.urlBytes less limit:advisory.batch.cursorHeadroomBytes; the URL cap, not this value, sets it on real targets",
    },
    effect:
      'Batch sizes halve down from this value to one as measurement, and the probe also sends one batch of this many plus one, which the verdict ignores. The batch at the proposed maximum (`maxFitTargets`) and every sweep batch hold at most this many, with a first URL within the URL cap less the cursor headroom; the proposed-maximum batch must complete for the verdict to.',
    test: 'tests/measure-batching/probe.test.ts > npm batches reach the register maximum and one more, and the sweep splits a larger group at the maximum',
  },
  {
    id: 'probe.batching.maxTagsPerQuery',
    value: 100,
    unit: 'count',
    protects:
      'Bounds the tag candidates in one GraphQL existence query the probe sends, so a query stays far below GraphQL node and size limits.',
    basis: {
      kind: 'safety',
      reason:
        "GitHub documents no alias, field, or query-size limit for GraphQL; its documented bounds are 500,000 nodes per call, a 10-second processing timeout, and per-hour and per-minute point limits (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api, checked 2026-11-26). Each candidate selects one repository, one ref, and its target, with no connection, so 100 candidates request a few hundred nodes, under a thousandth of the node limit, in one query of a few tens of KB. 100 is the top of the probe's measured sizes; the production value, limit:upstream.tagExistence.maxCandidatesPerQuery, was approved at the same size from this probe's cost and bytes (2026-11-26). A size GitHub rejects is recorded as an unanswered query, never as a disagreement.",
    },
    effect:
      'Agreement queries carry at most this many candidates each, and the cost sweep halves down from this value to one.',
    test: 'tests/measure-batching/probe.test.ts > tag queries carry at most the register maximum, and one more candidate starts a second query',
  },
  // The probe's runner is a single vitest test (scripts/measure-batching/vitest.config.mjs).
  unjustified('probe.batching.testTimeoutMs', 900_000, 'milliseconds', {
    protects:
      'A hung GitHub request inside the batching probe would otherwise run indefinitely, since the probe sets no per-request timeout; the timeout ends that test.',
    effect:
      "A run past the timeout fails under vitest's timeout behavior and writes no report; the measured part is lost.",
    note: 'kept at the demand measurement value it reused before #440; awaiting the C3 probe run (#390), whose duration would give a measured basis',
    test: 'none: the timeout of the manual batching probe, which needs a live token and is not part of npm test',
  }),
  ...allScaledShareEntries(),
] as const satisfies readonly LimitDefinition[];

export type LimitId = (typeof DEFINITIONS)[number]['id'];

export const REGISTER = buildRegister(DEFINITIONS);

export function limitEntry(id: LimitId): Limit {
  const entry = REGISTER.get(id);
  if (entry === undefined) throw new Error(`unknown limit id: ${id}`);
  return entry;
}

export function limit(id: LimitId): number {
  return limitEntry(id).value;
}
