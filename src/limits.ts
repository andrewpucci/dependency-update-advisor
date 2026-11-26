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
const SHARE_START_TEST =
  'src/budget.test.ts > starting parameters reproduce the current research shares for any change';

/** One scaled share's base and rate entries for one dimension; its ceiling is the allocation entry. */
function scaledShareEntries<const S extends ScaledShare, const D extends ShareDimension>(
  share: S,
  dimension: D,
) {
  const ceiling = `${SCALED_SHARES[share]}.${SHARE_DIMENSIONS[dimension]}`;
  const unit: LimitUnit = dimension === 'bytes' ? 'bytes' : 'count';
  const units: readonly ShareUnit[] = share.startsWith('signals.')
    ? [...ROLE_UNITS, 'eligible']
    : ROLE_UNITS;
  const base = derived(
    `research.share.${share}.${dimension}.base` as `research.share.${S}.${D}.base`,
    unit,
    [ceiling],
    copy,
    `The ${share} ${dimension} share starts at its ceiling until B12 fits a smaller base.`,
    {
      protects:
        'Sets the share a change of no counted members gets, before any per-member rate is added.',
      effect:
        'The computed share starts here; with every rate at zero it equals the ceiling, as before scaling.',
      test: SHARE_START_TEST,
    },
  );
  const rates = units.map((rateUnit) =>
    unjustified(
      `research.share.${share}.${dimension}.rate.${rateUnit}` as `research.share.${S}.${D}.rate.${ShareUnit}`,
      0,
      unit,
      {
        protects: `Grows the ${share} ${dimension} share with each ${rateUnit} member, so a larger change gets more and a small one fails faster.`,
        effect:
          'Adds rate times the count to the share, rounded up and capped at the ceiling; zero leaves the share at its base.',
        note: 'awaiting B12/L8 measurement',
        test: SHARE_FORMULA_TEST,
      },
    ),
  );
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

const DEFINITIONS = [
  {
    id: 'packet.bytes',
    value: 1_048_576,
    unit: 'bytes',
    protects:
      'An untrusted review packet of unbounded size would make validation and the analysis projection unbounded in memory and CPU; the serialized size is measured and rejected above the cap.',
    effect:
      'The whole packet is rejected with category budget on field packet, and no partial packet is returned. Optional evidence is dropped first so the assembled packet can fit.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/schema.test.ts > enforces the exact serialized packet budget including multibyte text',
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
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/schema.test.ts > accepts 512 findings and rejects the overflow record',
  },
  {
    id: 'packet.relationships',
    value: 256,
    unit: 'count',
    protects:
      'Relationship proofs come from collector output and their linking work grows with their count; an unbounded set would grow the proof graph without limit.',
    effect:
      'Overflow rejects the packet with budget on relationships. The assembler drops optional proofs before this check runs.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
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
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
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
    basis: { kind: 'unjustified', note: 'no recorded reason' },
    test: 'src/schema.test.ts > enforces 256-code-unit IDs and 1024-byte identity strings',
  },
  {
    id: 'packet.identityBytes',
    value: 1_024,
    unit: 'bytes',
    protects:
      'Other identity strings such as versions, refs and paths come from untrusted input; an oversized byte length would inflate records and the packet bytes budget.',
    effect: 'An identity string over the byte cap rejects the packet with budget on the field.',
    basis: { kind: 'unjustified', note: 'no recorded reason' },
    test: 'src/schema.test.ts > enforces 256-code-unit IDs and 1024-byte identity strings',
  },
  {
    id: 'packet.textBytes',
    value: 2_048,
    unit: 'bytes',
    protects:
      'Rationale, title and upstream excerpt text come from untrusted advisory and registry input; unbounded text would dominate the packet bytes budget and the comment.',
    effect:
      'Over-long text rejects the packet with budget on the field. Upstream and policy readers stop adding text at the cap before the packet check.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
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
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
    test: 'src/schema.test.ts > enforces text and reference-list bounds independently of the packet size',
  },
  {
    id: 'packet.contextBytes',
    value: 65_536,
    unit: 'bytes',
    protects:
      'Source context is serialized into every packet and read from repository files; an unbounded context would grow the packet and the analysis input without limit.',
    effect:
      'A context over the byte cap rejects the packet with budget on context; no partial context is kept.',
    basis: { kind: 'unjustified', note: 'awaiting L8 measurement' },
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
  unjustified('evidence.envelope.maxResponseBytes', MiB, 'bytes', {
    protects:
      'A response body is buffered before its size is checked, so one oversized response could exhaust runner memory; the cap bounds each response.',
    effect:
      'A response over the cap fails only its own read with budget and its body is cancelled; other reads continue.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm-registry.test.ts > a response exactly at the envelope per-response cap reads; one byte more fails only that read',
  }),
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
  unjustified('evidence.envelope.requestTimeoutMs', 15_000, 'milliseconds', {
    protects:
      'One stalled request must not hold the job until the runner kills it; the timeout frees the time for the reads that follow, including freshness reads.',
    effect:
      'The request is aborted with the fixed timeout reason and its reader stops with that reason, keeping the evidence it already collected.',
    test: 'src/runtime.test.ts > times a freshness read made %s out at the smaller of the request timeout and the time left',
    note: 'awaiting L8 measurement',
  }),
  unjustified('evidence.envelope.totalTimeoutMs', 240_000, 'milliseconds', {
    protects:
      "The shared evidence deadline keeps every pre-analysis read inside the job window, so analysis and the final freshness check keep their time before the runner's timeout.",
    effect:
      "Once the time is spent, a reader's next request is refused with budget or cut off with timeout, and the evidence already collected is kept.",
    test: 'src/runtime.test.ts > limits a late request to the time left in the total deadline',
    note: 'awaiting L8 measurement',
  }),
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
  unjustified('evidence.allocation.transport.snapshot.maxRequests', 200, 'count', {
    protects:
      'Caps snapshot reads (repository, commit, trees, blobs) so a heavy snapshot cannot use the freshness share or the GitHub rate limit.',
    effect: 'The read past the share is refused with budget before any request is sent.',
    test: 'src/runtime.test.ts > an exhausted snapshot share cannot starve freshness reads, and the reverse',
    note: 'awaiting L8 measurement',
  }),
  unjustified('evidence.allocation.transport.snapshot.maxTotalBytes', 9 * MiB, 'bytes', {
    protects:
      'Caps snapshot response bytes so a heavy snapshot cannot use the freshness bytes or runner memory.',
    effect:
      "A read that would pass the share's remaining bytes returns budget and is not returned as available; the freshness share is unaffected.",
    test: "src/runtime.test.ts > stops a %s read at that share's byte limit and leaves the other share alone",
    note: 'awaiting L8 measurement',
  }),
  unjustified('evidence.allocation.transport.freshness.maxRequests', 24, 'count', {
    protects:
      'Reserves requests for freshness checks (workflow, run, PR, comparison) so a heavy snapshot cannot prevent the checks that keep a finished review valid.',
    effect:
      'The request past the share is refused with budget and no request is sent; a failed freshness read is an internal failure, never a stale head.',
    test: 'src/runtime.test.ts > an exhausted snapshot share cannot starve freshness reads, and the reverse',
    note: 'awaiting L8 measurement',
  }),
  unjustified('evidence.allocation.transport.freshness.maxTotalBytes', 3 * MiB, 'bytes', {
    protects:
      'Reserves response bytes for freshness checks so a heavy snapshot cannot starve the checks that keep a finished review valid.',
    effect:
      "A read that would pass the share's remaining bytes returns budget; the snapshot share is unaffected.",
    test: "src/runtime.test.ts > stops a %s read at that share's byte limit and leaves the other share alone",
    note: 'awaiting L8 measurement',
  }),
  unjustified('evidence.allocation.session.maxRequests', 160, 'count', {
    protects:
      'Caps requests of the GitHub evidence session reader so one review cannot exceed the GitHub rate limit or the evidence time.',
    effect:
      'The request past the cap returns budget and no request is sent; other readers are not borrowed from.',
    note: 'awaiting L8 measurement',
    test: 'src/github-read.test.ts > the session stops at exactly evidence.allocation.session.maxRequests requests',
  }),
  unjustified('evidence.allocation.session.maxTotalBytes', 12 * MiB, 'bytes', {
    protects: 'Caps response bytes of the GitHub evidence session reader against runner memory.',
    effect:
      "A response past the share's remaining bytes returns budget and the reader stops; other shares are unaffected.",
    note: 'awaiting L8 measurement',
    test: 'src/github-read.test.ts > the session refuses the read that passes evidence.allocation.session.maxTotalBytes',
  }),
  unjustified('evidence.allocation.registry.maxRequests', 64, 'count', {
    protects:
      'Caps npm registry detail requests for one review so a large dependency set cannot spend the shared evidence time on registry reads.',
    effect: 'The request past the cap returns budget and no request is sent.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm-registry.test.ts > the registry request share allows exactly its count and refuses the next read unsent',
  }),
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
  unjustified('evidence.allocation.upstream.maxTotalBytes', 15 * MiB, 'bytes', {
    protects:
      'Caps response bytes of upstream research reads so they cannot exhaust runner memory.',
    effect:
      "A response past the share's remaining bytes is refused with budget and the upstream reader stops.",
    note: 'awaiting L8 measurement',
    test: 'src/evidence/upstream-read.test.ts > upstream reader accepts a byte share exactly and refuses the byte past it',
  }),
  unjustified('evidence.allocation.advisory.maxRequests', 80, 'count', {
    protects:
      'Caps advisory lookups per changed package so a large group cannot take the shared evidence time.',
    effect:
      'Requests past the cap return budget; the stage keeps the advisory evidence already read.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/advisory-read.test.ts > advisory reader spends exactly its request share and refuses the lookup past it',
  }),
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
  unjustified('evidence.allocation.signals.readers.malware.maxRequests', 40, 'count', {
    protects:
      'Caps malware-signal lookups at one per extra changed package, so the signals stage cannot exhaust the envelope.',
    effect:
      'The lookup past the cap returns budget and the malware reader stops, keeping results already read.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/advisory-read.test.ts > malware reader spends exactly its request share and refuses the lookup past it',
  }),
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
    protects: 'Discovery URLs stay under the length GitHub accepted (414 at 8,259 bytes).',
    effect:
      "Spellings split across as many discovery requests as the cap requires; a continuation URL over it is budget. The batching probe's npm sweep splits batches to fit it, and a probe batch size over it that fails is recorded but does not make the verdict incomplete.",
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
  unjustified('evidence.allocation.signals.readers.metadata.maxRequests', 16, 'count', {
    protects:
      'Caps PyPI metadata requests in the signals stage so the stage stays inside the envelope.',
    effect: 'The request past the cap returns budget and the metadata reader stops.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/policy-signals-read.test.ts > metadata reader spends exactly its request share and refuses the request past it',
  }),
  unjustified('evidence.allocation.signals.readers.metadata.maxTotalBytes', 0.5 * MiB, 'bytes', {
    protects: 'Caps PyPI metadata response bytes so they cannot exhaust runner memory.',
    effect: "A response past the share's remaining bytes returns budget and the reader stops.",
    note: 'awaiting L8 measurement',
    test: 'src/evidence/policy-signals-read.test.ts > metadata reader accepts a byte share exactly and refuses the byte past it',
  }),
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
  unjustified('w2.session.maxPages', 10, 'count', {
    protects:
      "Bounds PR-file listing requests to 10 pages (1,000 rows at GitHub's 100-per-page size), so a PR's file list cannot drive unbounded paging.",
    effect:
      'Requesting a page beyond the cap throws budget before dispatch, discovery is partial with reason budget, and rows already read are kept.',
    note: 'awaiting L8 measurement',
    test: 'src/github-read.test.ts > discovery reads exactly w2.session.maxPages pages and keeps the rows it read',
  }),
  unjustified('w2.session.maxFiles', 1_000, 'count', {
    protects:
      'Caps PR-file rows examined per session, so an oversized file list cannot make the reader parse and retain unbounded rows.',
    effect:
      'Examining one row beyond the cap throws budget, discovery is partial with reason budget, and the earlier rows are retained.',
    test: 'src/github-read.test.ts > accepts exact file entry count and rejects one beyond %s',
    note: 'awaiting L8 measurement',
  }),
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
  unjustified('w2.npm.maxFileBytes', 500_000, 'bytes', {
    protects:
      'Caps the decoded bytes of one PR-controlled package-lock.json before JSON parsing, so a huge lockfile cannot make the npm reader parse unbounded data (memory and CPU).',
    effect:
      'A file over the cap is refused with budget before parsing, so the inventory is not claimed complete.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm.test.ts > the file byte cap admits a lockfile of exactly the registered size and refuses one byte more',
  }),
  unjustified('w2.npm.maxJsonDepth', 32, 'count', {
    protects:
      'Caps nesting depth of PR-controlled package-lock.json input, so deeply nested JSON cannot exhaust the stack or CPU in the depth walk and parser.',
    effect:
      'Depth over the cap throws budget: the input envelope is reported invalid with no reads, and a parsed file yields a budget gap.',
    test: 'src/evidence/npm.test.ts > counts the input envelope as depth 1 like parsed files',
    note: 'no recorded reason',
  }),
  unjustified('w2.npm.maxJsonEntries', 100_000, 'count', {
    protects:
      'Caps cumulative JSON entries across PR-controlled lockfiles, so many or wide objects cannot drive unbounded parse and walk work.',
    effect:
      'Crossing the cumulative count throws budget, and the file yields a budget gap so inventory is not claimed complete.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm.test.ts > the cumulative JSON entry cap admits exactly the registered count and refuses one more',
  }),
  unjustified('w2.npm.maxRoots', 10, 'count', {
    protects:
      'Caps the number of changed npm roots read in one run, so a PR touching many package directories cannot multiply lockfile reads beyond the session budget.',
    effect:
      'Roots past the cap are not read; a budget gap is recorded for the whole inventory and the first sorted roots are kept.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm.test.ts > the changed npm root cap reads exactly the registered number of roots and records a budget gap for the rest',
  }),
  unjustified('w2.npm.maxRetainedBytes', 2_000_000, 'bytes', {
    protects:
      'Caps the serialized npm inventory bytes kept in memory and handed to the graph stage.',
    effect:
      'The inventory is trimmed to the longest prefix that fits with a budget gap; if no prefix fits the result is unavailable with reason budget.',
    note: 'awaiting L8 measurement',
    test: 'src/evidence/npm.test.ts > the retained inventory cap keeps a whole inventory at its exact serialized size and trims one byte under it',
  }),
  unjustified('w2.actions.maxFileBytes', 100_000, 'bytes', {
    protects:
      'Caps the bytes of one PR-controlled workflow file before YAML parsing, so a huge workflow cannot make the YAML parser run unbounded (memory and CPU).',
    effect:
      'The workflow read returns unavailable with reason budget before decoding, so no jobs from that file are parsed.',
    test: 'src/evidence/actions-yaml.test.ts > enforces byte, node, nesting and occurrence limits with fatal UTF-8 decoding',
    note: 'awaiting L8 measurement',
  }),
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
  unjustified('w2.actions.maxYamlDepth', 32, 'count', {
    protects:
      'Caps YAML nesting depth before composition, so deeply nested input cannot exhaust the recursion stack or CPU in the composer.',
    effect:
      'Exceeding the depth throws budget and the workflow read is unavailable with reason budget.',
    test: 'src/evidence/actions-yaml.test.ts > counts cumulative nodes and UTF-8 bytes at exact boundaries and bounds deeply nested flow input before composition',
    note: 'no recorded reason',
  }),
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
  unjustified('w2.uv.maxFileBytes', 100_000, 'bytes', {
    protects:
      'Caps bytes of one PR-controlled uv.lock or pyproject.toml before fatal UTF-8 decoding and TOML parsing.',
    effect:
      'A file over the cap throws budget before decoding, and the side yields a budget gap for that file.',
    test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.uv.maxTomlDepth', 32, 'count', {
    protects:
      'Caps TOML nesting depth in PR-controlled files, so recursive inline parsing cannot exhaust the stack.',
    effect: 'Exceeding the depth throws budget for that file and the side yields a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    note: 'no recorded reason',
  }),
  unjustified('w2.uv.maxTomlEntries', 100_000, 'count', {
    protects:
      'Caps cumulative TOML object properties and array elements across all uv files, so ignored fields cannot drive unbounded parse work.',
    effect: 'Debiting past the cap throws budget and the file yields a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.uv.maxPackages', 1_000, 'count', {
    protects:
      'Caps cumulative attempted package entries across uv.lock files, so a very large lock cannot drive unbounded parse and graph work.',
    effect: 'Debiting past the cap throws budget and the file yields a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.uv.maxDeclarations', 1_000, 'count', {
    protects:
      'Caps cumulative requirement declarations from manifests and lock requires-dist items, bounding requirement parsing work.',
    effect: 'Debiting past the cap throws budget and the side yields a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.uv.maxEdges', 1_000, 'count', {
    protects: 'Caps cumulative dependency edges parsed from uv.lock, bounding graph input size.',
    effect: 'Debiting past the cap throws budget and the head side yields a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.uv.maxStringBytes', 4_096, 'bytes', {
    protects:
      'Caps each TOML key or string value and requirement text, so one very long string cannot drive unbounded decode and identity work.',
    effect: 'A string over the cap throws budget for that entry, which becomes a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.uv.maxRequirementTokens', 200, 'count', {
    protects:
      'Caps lexical tokens per requirement, so one pathological requirement string cannot drive unbounded tokenization.',
    effect:
      'Exceeding the token cap throws budget for that requirement, which becomes a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces exact/over %s through the real collector across both sides',
    note: 'awaiting L8 measurement',
  }),
  unjustified('w2.uv.maxMarkerDepth', 16, 'count', {
    protects:
      'Caps parenthesis nesting in requirement environment markers, so nested markers cannot drive unbounded recursion.',
    effect:
      'Exceeding the nesting depth throws budget for that requirement, which becomes a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
    note: 'no recorded reason',
  }),
  unjustified('w2.uv.maxRoots', 20, 'count', {
    protects:
      'Caps the number of selected uv roots read, so many changed directories cannot multiply file reads beyond the session budget.',
    effect:
      'Configured roots above the cap make the input invalid (src/evidence/uv.ts:173); discovered roots past the cap are not read and each adds a budget gap.',
    test: 'src/evidence/uv.test.ts > enforces file, edge, marker and selected-root caps at boundaries',
    note: 'awaiting L8 measurement',
  }),
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
    "The registry reader's request cap is its allocation share's request cap.",
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
  unjustified('w2.registry.maxJsonDepth', 32, 'count', {
    protects:
      'Caps nesting depth in registry documents, so deep JSON cannot exhaust the stack or CPU in the walker.',
    effect: 'Exceeding the depth throws budget and the read is unavailable with reason budget.',
    note: 'no recorded reason',
    test: 'src/evidence/npm-registry.test.ts > registry JSON nesting at the depth cap parses and one level deeper is a budget failure',
  }),
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
  unjustified('research.maxJsonEntries', 200_000, 'count', {
    protects:
      'Untrusted upstream JSON cannot make a research reader parse an unbounded number of entries (CPU and memory).',
    effect:
      "Exceeding the cap fails that reader's read with reason budget; the stage stops and is recorded unavailable with its reason.",
    note: 'awaiting L8 measurement',
    test: 'src/research.test.ts > the npm registry reader counts exactly research.maxJsonEntries entries and refuses one more',
  }),
  unjustified('research.maxJsonDepth', 32, 'count', {
    protects:
      'Untrusted upstream JSON cannot nest deeper than the cap, so parsing cannot exhaust the stack or CPU.',
    effect:
      "Input nested deeper than the cap fails that reader's read with reason budget; the stage is recorded unavailable.",
    note: 'no recorded reason',
    test: 'src/evidence/advisory-read.test.ts > advisory JSON depth accepts the register depth exactly and refuses one level deeper',
  }),
  unjustified('research.maxRetainedBytes', 2_000_000, 'bytes', {
    protects:
      'Bytes a research stage keeps from untrusted responses are bounded, so retained evidence cannot exhaust memory.',
    effect:
      'Exceeding the cap sets the stage stop to budget; the stage stops, keeps the members it already retained, and records the stop.',
    note: 'awaiting L8 measurement',
    test: 'src/research.test.ts > the npm registry reader retains exactly research.maxRetainedBytes and refuses one byte more',
  }),
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
  unjustified('snapshot.maxTreeEntries', 10_000, 'count', {
    protects:
      'The total number of tree entries listed from GitHub is bounded, so a very large repository cannot make the snapshot listing unbounded (memory and requests).',
    effect:
      'Once the running count exceeds the cap, the listing throws Unavailable with the default reason unknown, and the snapshot is reported unusable.',
    note: 'awaiting L8 measurement',
    test: 'src/snapshot.test.ts > a listing at snapshot.maxTreeEntries is read and one more entry is refused',
  }),
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
  unjustified('analysis.responseBytes', 12_648_448, 'bytes', {
    protects:
      'The reply body read is capped so a runaway or hostile response cannot exhaust memory. The cap is sized to hold the largest legal reply.',
    effect:
      'A reply body over the cap fails the whole call as response-size. No assessments are kept.',
    test: 'src/analysis/mistral.test.ts > admits a valid stop at the full token-byte, escaping and envelope allowance, but rejects one extra observed byte',
    note: 'awaiting L8 measurement',
  }),
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
      'Keeps the large-inventory reporting and parity tests from failing by chance on a slow CI runner, while still ending a build or render that hangs.',
    basis: {
      kind: 'safety',
      reason:
        "The heaviest of these tests take about 2 s locally and timed out at vitest's 5 s default on CI runners about three times slower (PR #424 for reporting; main at 99131b3 and PR #425 for the parity test that builds the inventory twice); 30 s leaves several times that headroom and still stops a hung test well inside the CI job's timeout.",
    },
    effect:
      "A reporting or parity test past the allowance fails under vitest's timeout behavior, as any timed-out test does.",
    test: 'none: a test-runner allowance for src/reporting.test.ts and tests/parity/large-inventory.test.ts, which no application code reads',
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
  unjustified('pipeline.ownershipWatchMs', 2_000, 'milliseconds', {
    protects:
      'A lost claim must stop a pending request within the watch interval, and the code requires that interval to be shorter than any request timeout, so lost work does not keep running (work after ownership is lost).',
    effect: 'Each tick checks ownership; when ownership is lost the pending request is aborted.',
    note: 'no recorded reason',
    test: 'src/pipeline.test.ts > checks ownership every pipeline.ownershipWatchMs while a request is pending',
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
    'analysis.projectionBytes',
    'bytes',
    ['packet.bytes'],
    (bytes) => 8 * bytes,
    "The analysis projection's input budget is eight times the packet's byte cap.",
    {
      protects:
        'Input work during snapshot (the parsed reply or inventory and its detached copy) is capped at eight packet-byte caps, so crafted JSON cannot allocate without bound.',
      effect:
        'Exceeding the byte budget throws a budget error and no snapshot or batch is produced. Nothing partial is kept.',
      test: 'src/analysis/projection.test.ts > the snapshot byte budget admits exactly eight packet caps of input and refuses one byte more',
    },
  ),
  unjustified('analysis.maxProjectionDepth', 64, 'count', {
    protects:
      'Snapshot recursion depth is capped at 64, so deeply nested input cannot exhaust the call stack.',
    effect: 'Input deeper than 64 levels throws a budget error and no snapshot is taken.',
    note: 'no recorded reason',
    test: 'src/analysis/projection.test.ts > the snapshot depth cap admits a leaf at the registered depth and refuses one level deeper',
  }),
  unjustified('analysis.maxTokenCodeUnits', 128, 'code units', {
    protects:
      'Sets the assumed code units per token in the reply-byte formula (completionTokens * 128 * 6 plus the envelope), so the reply byte cap covers the largest legal reply.',
    effect:
      'Caller limits whose responseBytes is below the formula fail preparation as budget (projection.ts:132-137). A reply over responseBytes fails as response-size at runtime.',
    test: 'src/analysis/bounds.test.ts > every declared resource limit rejects larger, unsafe, fractional and incompatible values before a usable handle',
    note: 'no recorded reason',
  }),
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
  unjustified('npm.maxIntegrityCodeUnits', 1_024, 'code units', {
    protects:
      'The integrity string from the untrusted npm registry is bounded before the hash parser splits and matches it, so the parse cannot do unbounded work (CPU).',
    effect:
      "A longer integrity string fails the registry document with reason malformed, so the package's registry evidence is unavailable.",
    note: 'no recorded reason',
    test: 'src/evidence/npm-registry.test.ts > an integrity string at the code-unit cap binds and one more code unit is malformed',
  }),
  unjustified('github.compareMaxFiles', 300, 'count', {
    protects:
      'A compare response with the cap or more changed files may be incomplete, so the list is marked truncated instead of being treated as complete (evidence completeness).',
    effect:
      'At or above the cap, filesComplete is false and the reason truncated is recorded; the patches already read are kept.',
    note: 'no recorded reason',
    test: 'src/evidence/upstream-github.test.ts > a comparison keeps its file list complete below the register file cap and truncates at it',
  }),
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
  unjustified('upstream.releasePageSize', 64, 'count', {
    protects:
      'The start size of the release page-size ladder is bounded, so a release page that does not fit the response cap is halved and retried instead of failing outright (response size and memory).',
    effect:
      'A page that does not fit halves and is retried at the same offset; a single release over the cap fails with reason budget.',
    test: 'src/evidence/upstream-releases.test.ts > halves the page until it fits and keeps reading from the same release',
    note: 'no recorded reason',
  }),
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
    "Research's GitHub requests can be no more than the three research stages' request ceilings together.",
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
        "none: GitHub's documented `affects` maximum is the size the probe must check (S1 Batched Lookup Amendment, Verification), and the one batch above it records what GitHub does there",
    },
    effect:
      'Batch sizes halve down from this value to one, and the probe also sends one batch of this many plus one, which the verdict ignores. The sweep splits a larger group into batches of at most this many, each with a URL within `limit:advisory.discovery.urlBytes`.',
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
        "GitHub documents no alias, field, or query-size limit for GraphQL; its documented bounds are 500,000 nodes per call, a 10-second processing timeout, and per-hour and per-minute point limits (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api, checked 2026-11-26). Each candidate selects one repository, one ref, and its target, with no connection, so 100 candidates request a few hundred nodes, under a thousandth of the node limit, in one query of a few tens of KB. 100 is the top of the probe's measured sizes, not the production value, which C3 proposes Ask-first from this probe's cost and bytes per size. A size GitHub rejects is recorded as an unanswered query, never as a disagreement.",
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
