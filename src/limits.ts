export type LimitUnit = 'bytes' | 'code units' | 'milliseconds' | 'count' | 'tokens';

/** Marks a field the migration has not filled yet; none may remain after phase 2. */
export const PENDING_AUDIT = 'pending: L7 audit';

export type LimitBasis =
  | { kind: 'external'; url: string; checked: string; platformValue: number; margin: string }
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
  | { kind: 'unjustified'; note: string };

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
  configurable?: { setting: string; default: number; maximum: number };
};

export type Limit = LimitDefinition & { value: number };

const BASIS_KINDS: readonly string[] = ['external', 'derived', 'measured', 'safety', 'unjustified'];

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
  return hasValue ? [] : [`${id}: value must be a finite number`];
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
    ...cycleProblems(derivedGraph(definitions)),
  ];
}

function resolveValues(definitions: readonly LimitDefinition[]): Map<string, number> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const values = new Map<string, number>();
  const valueOfId = (id: string): number => {
    const known = values.get(id);
    if (known !== undefined) return known;
    const definition = byId.get(id);
    if (definition === undefined) throw new Error(`unknown limit id: ${id}`);
    const { basis } = definition;
    const value =
      basis.kind === 'derived' ? basis.formula(...basis.inputs.map(valueOfId)) : definition.value;
    if (value === undefined) throw new Error(`limit ${id} has no value`);
    values.set(id, value);
    return value;
  };
  for (const definition of definitions) valueOfId(definition.id);
  return values;
}

export function buildRegister(definitions: readonly LimitDefinition[]): ReadonlyMap<string, Limit> {
  const problems = checkRegister(definitions);
  if (problems.length > 0) {
    throw new Error(`invalid limit register:\n${problems.join('\n')}`);
  }
  const values = resolveValues(definitions);
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

const DEFINITIONS = [
  {
    id: 'packet.bytes',
    value: 1_048_576,
    unit: 'bytes',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces the exact serialized packet budget including multibyte text',
  },
  {
    id: 'packet.changes',
    value: 128,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/units.test.ts > keeps the entire accepted 128-change inventory; T4 overflow has no usable packet',
  },
  {
    id: 'packet.sources',
    value: 1_024,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > accepts 1024 source records and rejects the overflow record',
  },
  {
    id: 'packet.findings',
    value: 512,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > accepts 512 findings and rejects the overflow record',
  },
  {
    id: 'packet.relationships',
    value: 256,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > accepts 256 distinct proofs and rejects the overflow proof',
  },
  {
    id: 'packet.reachability',
    value: 1_024,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > accepts exactly 1,024 verdicts and rejects one beyond without trimming',
  },
  {
    id: 'packet.pathInstances',
    value: 32,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces the 32-instance path ceiling',
  },
  {
    id: 'packet.idCodeUnits',
    value: 256,
    unit: 'code units',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces 256-code-unit IDs and 1024-byte identity strings',
  },
  {
    id: 'packet.identityBytes',
    value: 1_024,
    unit: 'bytes',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces 256-code-unit IDs and 1024-byte identity strings',
  },
  {
    id: 'packet.textBytes',
    value: 2_048,
    unit: 'bytes',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces text and reference-list bounds independently of the packet size',
  },
  {
    id: 'packet.listEntries',
    value: 32,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces text and reference-list bounds independently of the packet size',
  },
  {
    id: 'packet.contextBytes',
    value: 65_536,
    unit: 'bytes',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces exactly 65536 serialized context bytes across 128 dependencies',
  },
  {
    id: 'packet.excerptCodeUnits',
    value: 500,
    unit: 'code units',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces C2 excerpt code-unit bounds without losing immutable facts',
  },
  {
    id: 'packet.facts',
    value: 20,
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'src/schema.test.ts > enforces the context fact count independently of excerpt and packet bounds',
  },
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
