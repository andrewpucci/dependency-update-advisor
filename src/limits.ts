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

const MiB = 1024 * 1024;

const sum = (...values: number[]): number => values.reduce((total, value) => total + value, 0);
const copy = (value: number): number => value;

/** A hand-picked value whose basis, protected behavior, and test are not audited yet. */
function unjustified<const Id extends string>(id: Id, value: number, unit: LimitUnit) {
  return {
    id,
    value,
    unit,
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: PENDING_AUDIT,
  } as const;
}

/** A value computed from other entries; `description` states the relation in words. */
function derived<const Id extends string>(
  id: Id,
  unit: LimitUnit,
  inputs: readonly string[],
  formula: (...values: number[]) => number,
  description: string,
) {
  return {
    id,
    unit,
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'derived', inputs, formula, description },
    test: PENDING_AUDIT,
  } as const;
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
  // Job timing, from budget.ts.
  unjustified('job.budget', 15 * 60 * 1_000, 'milliseconds'),
  unjustified('job.preStartupAllowance', 60_000, 'milliseconds'),
  derived(
    'job.window',
    'milliseconds',
    ['job.budget', 'job.preStartupAllowance'],
    (budget, preStartup) => budget - preStartup,
    'The job window is the runner budget less the time spent before startup.',
  ),
  unjustified('job.freshnessAllowance', 45_000, 'milliseconds'),
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
  ),
  unjustified('evidence.envelope.maxResponseBytes', MiB, 'bytes'),
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
  ),
  unjustified('evidence.envelope.requestTimeoutMs', 15_000, 'milliseconds'),
  unjustified('evidence.envelope.totalTimeoutMs', 240_000, 'milliseconds'),
  derived(
    'evidence.allocation.transport.maxRequests',
    'count',
    [
      'evidence.allocation.transport.snapshot.maxRequests',
      'evidence.allocation.transport.freshness.maxRequests',
    ],
    sum,
    'The transport share is the snapshot requests plus the reserved freshness requests.',
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
  ),
  unjustified('evidence.allocation.transport.snapshot.maxRequests', 200, 'count'),
  unjustified('evidence.allocation.transport.snapshot.maxTotalBytes', 9 * MiB, 'bytes'),
  unjustified('evidence.allocation.transport.freshness.maxRequests', 24, 'count'),
  unjustified('evidence.allocation.transport.freshness.maxTotalBytes', 3 * MiB, 'bytes'),
  unjustified('evidence.allocation.session.maxRequests', 160, 'count'),
  unjustified('evidence.allocation.session.maxTotalBytes', 12 * MiB, 'bytes'),
  unjustified('evidence.allocation.registry.maxRequests', 64, 'count'),
  unjustified('evidence.allocation.registry.maxTotalBytes', 4 * MiB, 'bytes'),
  unjustified('evidence.allocation.upstream.maxRequests', 240, 'count'),
  unjustified('evidence.allocation.upstream.maxTotalBytes', 15 * MiB, 'bytes'),
  unjustified('evidence.allocation.advisory.maxRequests', 80, 'count'),
  unjustified('evidence.allocation.advisory.maxTotalBytes', 5 * MiB, 'bytes'),
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
  ),
  unjustified('evidence.allocation.signals.readers.malware.maxRequests', 40, 'count'),
  unjustified('evidence.allocation.signals.readers.malware.maxTotalBytes', 1.5 * MiB, 'bytes'),
  unjustified('evidence.allocation.signals.readers.publishTimes.maxRequests', 40, 'count'),
  unjustified('evidence.allocation.signals.readers.publishTimes.maxTotalBytes', 1.5 * MiB, 'bytes'),
  unjustified('evidence.allocation.signals.readers.registry.maxRequests', 64, 'count'),
  unjustified('evidence.allocation.signals.readers.registry.maxTotalBytes', 2 * MiB, 'bytes'),
  unjustified('evidence.allocation.signals.readers.metadata.maxRequests', 16, 'count'),
  unjustified('evidence.allocation.signals.readers.metadata.maxTotalBytes', 0.5 * MiB, 'bytes'),
  unjustified('evidence.allocation.signals.readers.upstream.maxRequests', 16, 'count'),
  unjustified('evidence.allocation.signals.readers.upstream.maxTotalBytes', 0.5 * MiB, 'bytes'),
  // Research cache, from budget.ts.
  derived(
    'research.cache.maxEntryBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "A cached entry is at most one response, so it is capped at the envelope's response cap.",
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
  ),
  // W2 evidence readers, from collection.ts.
  derived(
    'w2.session.maxRequests',
    'count',
    ['evidence.allocation.session.maxRequests'],
    copy,
    "The session reader's request cap is its allocation share's request cap.",
  ),
  unjustified('w2.session.maxPages', 10, 'count'),
  unjustified('w2.session.maxFiles', 1_000, 'count'),
  unjustified('w2.session.maxJsonEntries', 200_000, 'count'),
  derived(
    'w2.session.maxResponseBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "The session reader's response cap is the envelope's response cap.",
  ),
  unjustified('w2.session.maxFileBytes', 500_000, 'bytes'),
  derived(
    'w2.session.maxTotalBytes',
    'bytes',
    ['evidence.allocation.session.maxTotalBytes'],
    copy,
    "The session reader's byte cap is its allocation share's byte cap.",
  ),
  unjustified('w2.session.maxRetainedBytes', 2_000_000, 'bytes'),
  derived(
    'w2.session.requestTimeoutMs',
    'milliseconds',
    ['evidence.envelope.requestTimeoutMs'],
    copy,
    "The session reader's request timeout is the envelope's request timeout.",
  ),
  unjustified('w2.npm.maxFileBytes', 500_000, 'bytes'),
  unjustified('w2.npm.maxJsonDepth', 32, 'count'),
  unjustified('w2.npm.maxJsonEntries', 100_000, 'count'),
  unjustified('w2.npm.maxRoots', 10, 'count'),
  unjustified('w2.npm.maxRetainedBytes', 2_000_000, 'bytes'),
  unjustified('w2.actions.maxFileBytes', 100_000, 'bytes'),
  unjustified('w2.actions.maxWorkflows', 20, 'count'),
  unjustified('w2.actions.maxYamlNodes', 100_000, 'count'),
  unjustified('w2.actions.maxYamlDepth', 32, 'count'),
  unjustified('w2.actions.maxAliasExpansions', 100, 'count'),
  unjustified('w2.actions.maxOccurrences', 1_000, 'count'),
  unjustified('w2.actions.maxRetainedBytes', 2_000_000, 'bytes'),
  unjustified('w2.uv.maxFileBytes', 100_000, 'bytes'),
  unjustified('w2.uv.maxTomlDepth', 32, 'count'),
  unjustified('w2.uv.maxTomlEntries', 100_000, 'count'),
  unjustified('w2.uv.maxPackages', 1_000, 'count'),
  unjustified('w2.uv.maxDeclarations', 1_000, 'count'),
  unjustified('w2.uv.maxEdges', 1_000, 'count'),
  unjustified('w2.uv.maxStringBytes', 4_096, 'bytes'),
  unjustified('w2.uv.maxRequirementTokens', 200, 'count'),
  unjustified('w2.uv.maxMarkerDepth', 16, 'count'),
  unjustified('w2.uv.maxRoots', 20, 'count'),
  unjustified('w2.uv.maxRetainedBytes', 1_000_000, 'bytes'),
  unjustified('w2.graph.maxGraphWork', 500_000, 'count'),
  unjustified('w2.graph.maxRetainedBytes', 2_000_000, 'bytes'),
  derived(
    'w2.registry.maxRequests',
    'count',
    ['evidence.allocation.registry.maxRequests'],
    copy,
    "The registry reader's request cap is its allocation share's request cap.",
  ),
  derived(
    'w2.registry.maxResponseBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "The registry reader's response cap is the envelope's response cap.",
  ),
  derived(
    'w2.registry.maxTotalBytes',
    'bytes',
    ['evidence.allocation.registry.maxTotalBytes'],
    copy,
    "The registry reader's byte cap is its allocation share's byte cap.",
  ),
  unjustified('w2.registry.maxJsonEntries', 100_000, 'count'),
  unjustified('w2.registry.maxJsonDepth', 32, 'count'),
  derived(
    'w2.registry.requestTimeoutMs',
    'milliseconds',
    ['evidence.envelope.requestTimeoutMs'],
    copy,
    "The registry reader's request timeout is the envelope's request timeout.",
  ),
  derived(
    'w2.totalTimeoutMs',
    'milliseconds',
    ['evidence.envelope.totalTimeoutMs'],
    copy,
    "The W2 total timeout is the envelope's total timeout.",
  ),
  // Research readers, from research.ts.
  unjustified('research.maxJsonEntries', 200_000, 'count'),
  unjustified('research.maxJsonDepth', 32, 'count'),
  unjustified('research.maxRetainedBytes', 2_000_000, 'bytes'),
  // Policy signals, from policy-signals-evidence.ts.
  {
    id: 'signals.attemptsPerMember',
    unit: 'count',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
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
