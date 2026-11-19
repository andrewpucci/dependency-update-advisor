export type LimitUnit = 'bytes' | 'code units' | 'milliseconds' | 'minutes' | 'count' | 'tokens';

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

/** A workflow job's `timeout-minutes`; the workflow file is checked by check:limits, not by a test. */
function unjustifiedWorkflow<const Id extends string>(id: Id, value: number) {
  return {
    id,
    value,
    unit: 'minutes',
    protects: PENDING_AUDIT,
    effect: PENDING_AUDIT,
    basis: { kind: 'unjustified', note: PENDING_AUDIT },
    test: 'none: checked against the workflow file by check:limits (L6)',
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
  // Workflow timeouts, copied from the YAML `timeout-minutes` of each job.
  unjustifiedWorkflow('workflow.dependabotReview.review.timeoutMinutes', 15),
  unjustifiedWorkflow('workflow.ci.quality.timeoutMinutes', 10),
  unjustifiedWorkflow('workflow.complexity.report.timeoutMinutes', 10),
  unjustifiedWorkflow('workflow.complexity.comment.timeoutMinutes', 5),
  // Job timing, from budget.ts.
  derived(
    'job.budget',
    'milliseconds',
    ['workflow.dependabotReview.review.timeoutMinutes'],
    (minutes) => minutes * 60_000,
    "The runner's wall-clock limit is the reusable workflow's timeout-minutes, in milliseconds.",
  ),
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
  // Snapshot reads, from snapshot.ts.
  unjustified('snapshot.maxBlobBytes', MiB, 'bytes'),
  unjustified('snapshot.maxTreeEntries', 10_000, 'count'),
  // GitHub reads, from runtime.ts. Each mirrors the evidence share it is read from.
  derived(
    'github.snapshot.maxRequests',
    'count',
    ['evidence.allocation.transport.snapshot.maxRequests'],
    copy,
    "The GitHub snapshot share's request cap mirrors the transport snapshot allocation.",
  ),
  derived(
    'github.snapshot.maxTotalBytes',
    'bytes',
    ['evidence.allocation.transport.snapshot.maxTotalBytes'],
    copy,
    "The GitHub snapshot share's byte cap mirrors the transport snapshot allocation.",
  ),
  derived(
    'github.freshness.maxRequests',
    'count',
    ['evidence.allocation.transport.freshness.maxRequests'],
    copy,
    "The GitHub freshness share's request cap mirrors the transport freshness allocation.",
  ),
  derived(
    'github.freshness.maxTotalBytes',
    'bytes',
    ['evidence.allocation.transport.freshness.maxTotalBytes'],
    copy,
    "The GitHub freshness share's byte cap mirrors the transport freshness allocation.",
  ),
  derived(
    'github.maxResponseBytes',
    'bytes',
    ['evidence.envelope.maxResponseBytes'],
    copy,
    "The GitHub response cap mirrors the evidence envelope's response cap.",
  ),
  derived(
    'github.requestTimeoutMs',
    'milliseconds',
    ['evidence.envelope.requestTimeoutMs'],
    copy,
    "The GitHub request timeout mirrors the evidence envelope's request timeout.",
  ),
  derived(
    'github.totalTimeoutMs',
    'milliseconds',
    ['evidence.envelope.totalTimeoutMs'],
    copy,
    "The GitHub total timeout mirrors the evidence envelope's total timeout.",
  ),
  // Source context, from context.ts. Packet copies mirror the packet entry they bound.
  derived(
    'context.maxDependencies',
    'count',
    ['packet.changes'],
    copy,
    "The context dependency cap mirrors the packet's change cap.",
  ),
  derived(
    'context.maxIdCodeUnits',
    'code units',
    ['packet.idCodeUnits'],
    copy,
    "The context identifier cap mirrors the packet's identifier cap.",
  ),
  derived(
    'context.maxPathBytes',
    'bytes',
    ['packet.identityBytes'],
    copy,
    "The context path cap mirrors the packet's identity byte cap that bounds every path.",
  ),
  derived(
    'context.maxSourceContextBytes',
    'bytes',
    ['packet.contextBytes'],
    copy,
    "The serialized source-context cap mirrors the packet's context byte cap.",
  ),
  derived(
    'context.maxSourceExcerptCodeUnits',
    'code units',
    ['packet.excerptCodeUnits'],
    copy,
    "The excerpt cap mirrors the packet's excerpt code-unit cap.",
  ),
  derived(
    'context.maxSourceFactsPerDependency',
    'count',
    ['packet.facts'],
    copy,
    "The fact cap per dependency mirrors the packet's fact cap.",
  ),
  unjustified('context.maxSourceRoots', 16, 'count'),
  unjustified('context.maxSourceCandidates', 128, 'count'),
  unjustified('context.maxTrackedPathEntries', 10_000, 'count'),
  unjustified('context.maxSourceFileBytes', 65_536, 'bytes'),
  unjustified('context.maxTotalSourceReadBytes', MiB, 'bytes'),
  unjustified('context.generatedMarkerScanLines', 20, 'count'),
  // Handoff, from handoff.ts.
  unjustified('handoff.maxGaps', 4, 'count'),
  // Dependabot roots, from dependabot-roots.ts.
  unjustified('dependabot.maxFileBytes', 65_536, 'bytes'),
  unjustified('dependabot.maxYamlNodes', 20_000, 'count'),
  unjustified('dependabot.maxYamlDepth', 16, 'count'),
  unjustified('dependabot.maxAliasExpansions', 0, 'count'),
  unjustified('dependabot.maxUpdates', 256, 'count'),
  unjustified('dependabot.maxRoots', 256, 'count'),
  derived(
    'dependabot.maxPathBytes',
    'bytes',
    ['packet.identityBytes'],
    copy,
    "The Dependabot path cap mirrors the packet's identity byte cap that bounds every path.",
  ),
  // Event file, from startup.ts.
  unjustified('startup.maxEventBytes', MiB, 'bytes'),
  // Configuration file and validator bounds, from config.ts.
  unjustified('config.maxBytes', 16_384, 'bytes'),
  unjustified('config.maxModelCodeUnits', 128, 'code units'),
  unjustified('config.maxReleaseAgeDays', 30, 'count'),
  // Comment bodies, from comments.ts.
  unjustified('comment.maxBodyCodeUnits', 50_000, 'code units'),
  // Analysis contract, from analysis/contract.ts, batches.ts, and mistral.ts.
  unjustified('analysis.maxUnits', 8, 'count'),
  unjustified('analysis.sourceBytes', 2_048, 'bytes'),
  unjustified('analysis.unitBytes', 65_536, 'bytes'),
  unjustified('analysis.requestBytes', 262_144, 'bytes'),
  unjustified('analysis.completionTokens', 16_384, 'tokens'),
  unjustified('analysis.requestTimeoutMs', 240_000, 'milliseconds'),
  unjustified('analysis.responseBytes', 12_648_448, 'bytes'),
  unjustified('analysis.textBytes', 1_024, 'bytes'),
  unjustified('analysis.featureBytes', 512, 'bytes'),
  unjustified('analysis.followupBytes', 280, 'bytes'),
  unjustified('analysis.steps', 8, 'count'),
  unjustified('analysis.references', 32, 'count'),
  unjustified('analysis.maxCalls', 32, 'count'),
  unjustified('analysis.maxConcurrentCalls', 2, 'count'),
  unjustified('analysis.maxAnalysisMs', 600_000, 'milliseconds'),
  unjustified('analysis.publicationReserveMs', 60_000, 'milliseconds'),
  unjustified('analysis.maxContentChunks', 64, 'count'),
  // Complexity report, from scripts/complexity/report.mjs.
  unjustified('complexity.threshold', 15, 'count'),
  unjustified('complexity.gitMaxBufferBytes', 32 * MiB, 'bytes'),
  unjustified('complexity.cellInputCodeUnits', 160, 'code units'),
  unjustified('complexity.cellOutputCodeUnits', 200, 'code units'),
  unjustified('complexity.maxListedFindings', 100, 'count'),
  // Limits moved from call sites by the L5 register sweep (issue #377).
  unjustified('signals.reasonCodeUnits', 350, 'code units'),
  unjustified('signals.npmMaxMaintainers', 32, 'count'),
  unjustified('pipeline.ownershipWatchMs', 2_000, 'milliseconds'),
  unjustified('research.maxTagCandidates', 100, 'count'),
  unjustified('research.maxTagDepth', 10, 'count'),
  unjustified('research.maxWork', 5_000_000, 'count'),
  unjustified('research.maxAttempts', 512, 'count'),
  derived(
    'research.maxFindings',
    'count',
    ['packet.findings'],
    copy,
    "The research finding cap mirrors the packet's finding cap, since research findings land in the packet.",
  ),
  derived(
    'analysis.projectionBytes',
    'bytes',
    ['packet.bytes'],
    (bytes) => 8 * bytes,
    "The analysis projection's input budget is eight times the packet's byte cap.",
  ),
  unjustified('analysis.maxProjectionDepth', 64, 'count'),
  unjustified('analysis.categoryCodeUnits', 128, 'code units'),
  unjustified('analysis.maxTokenCodeUnits', 128, 'code units'),
  unjustified('analysis.responseEnvelopeBytes', 65_536, 'bytes'),
  unjustified('actions.maxUsesCodeUnits', 2_048, 'code units'),
  unjustified('actions.maxComparisonVersionCodeUnits', 1_024, 'code units'),
  derived(
    'advisories.maxLookups',
    'count',
    ['packet.changes'],
    (changes) => 2 * changes,
    'The advisory lookup cap is one identity per side of each packet change.',
  ),
  unjustified('npm.maxIntegrityCodeUnits', 1_024, 'code units'),
  unjustified('github.compareMaxFiles', 300, 'count'),
  unjustified('github.pageSize', 100, 'count'),
  unjustified('github.treeMaxFiles', 3_000, 'count'),
  unjustified('upstream.releasePageSize', 64, 'count'),
  unjustified('uv.maxCorroborationCodeUnits', 4_096, 'code units'),
  unjustified('uv.corroborationWorkPerEntry', 64, 'count'),
  unjustified('handoff.maxTraces', 32, 'count'),
  unjustified('startup.maxReportedDurationMs', 999_999, 'milliseconds'),
  // Spec values at or below this floor are not checked by check:limits, from scripts/limits/check.ts.
  unjustified('checkLimits.specValueFloor', 64, 'count'),
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
