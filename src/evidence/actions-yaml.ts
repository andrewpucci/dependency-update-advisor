import { Composer, Parser, isAlias, isMap, isNode, isScalar, isSeq, type Node } from 'yaml';
import type { EvidenceReason } from '../schema.js';

export type YamlLimits = {
  maxFileBytes: number;
  maxYamlNodes: number;
  maxYamlDepth: number;
  maxAliasExpansions: number;
  maxOccurrences: number;
};
export type YamlBudget = { nodes: number; aliases: number; occurrences: number };
export type WorkflowUse =
  | { kind: 'external'; action: string; ref: string; refKind: 'sha' | 'unknown' }
  | { kind: 'local'; path: string }
  | { kind: 'unsupported' };
export type WorkflowStep = { id: string | null; use: WorkflowUse | null };
export type WorkflowJob = {
  jobId: string;
  steps: WorkflowStep[] | null;
  use: WorkflowUse | null;
};
export type YamlGap = { jobId: string | null; stepIndex: number | null; reason: EvidenceReason };
export type WorkflowRead =
  | { kind: 'unavailable'; reason: EvidenceReason }
  | { kind: 'parsed'; jobs: WorkflowJob[]; gaps: YamlGap[] };

class YamlFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
function need(value: unknown, reason: EvidenceReason = 'malformed'): asserts value {
  if (!value) throw new YamlFailure(reason);
}
export function safeIdentity(value: unknown, units = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= units &&
    Buffer.byteLength(value) <= 1024 &&
    !/[\p{Cc}\p{Cs}]/u.test(value)
  );
}
function debit(budget: YamlBudget, key: keyof YamlBudget, limit: number) {
  need(budget[key] < limit, 'budget');
  budget[key]++;
}

// CST inspection precedes the library's recursive composition; aliases are still unexpanded.
function preflight(value: unknown, limits: YamlLimits, budget: YamlBudget) {
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const { value: item, depth } = stack.pop()!;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const collection = ['block-map', 'block-seq', 'flow-collection'].includes(r.type as string);
    const next = depth + Number(collection);
    need(next <= limits.maxYamlDepth, 'budget');
    debit(budget, 'nodes', limits.maxYamlNodes);
    if (r.type === 'tag')
      need(
        ['!!str', '!!int', '!!float', '!!bool', '!!null', '!!map', '!!seq'].includes(
          r.source as string,
        ),
        'unsupported',
      );
    if (r.type === 'directive') need(r.source === '%YAML 1.2', 'unsupported');
    const children = Object.values(r).flatMap((child) =>
      Array.isArray(child) ? child.toReversed() : [child],
    );
    for (const child of children) stack.push({ value: child, depth: next });
  }
}

function children(node: Node): Node[] {
  if (isSeq(node)) return node.items.filter((n): n is Node => n !== null);
  if (!isMap(node)) return [];
  return node.items.flatMap((p) => [p.key, p.value].filter((n): n is Node => n !== null));
}
function aliases(root: Node) {
  const anchors = new Map<string, Node>();
  const targets = new Map<Node, Node>();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (isAlias(node)) {
      const target = anchors.get(node.source);
      need(target);
      targets.set(node, target);
    } else {
      if (node.anchor) anchors.set(node.anchor, node);
      const list = children(node);
      for (let i = list.length - 1; i >= 0; i--) pending.push(list[i]);
    }
  }
  return targets;
}

type Value = string | number | boolean | null | Map<string, Value> | Value[];
type Entry = { node: Node | null; depth: number; assign: (v: Value) => void };
type Frame = Entry | { leave: Node };
function queueCollection(node: Node, frame: Entry, stack: Frame[]) {
  const depth = frame.depth + 1;
  if (isSeq(node)) {
    const out: Value[] = [];
    frame.assign(out);
    for (let i = node.items.length - 1; i >= 0; i--) {
      const child = node.items[i];
      need(child === null || isNode(child));
      stack.push({
        node: child,
        depth,
        assign: (v) => {
          out[i] = v;
        },
      });
    }
  } else {
    need(isMap(node));
    const out = new Map<string, Value>();
    frame.assign(out);
    for (let i = node.items.length - 1; i >= 0; i--) {
      const pair = node.items[i];
      need(isScalar(pair.key) && typeof pair.key.value === 'string');
      const key = pair.key.value;
      need(key !== '<<', 'unsupported');
      need(pair.value === null || isNode(pair.value));
      stack.push({
        node: pair.value,
        depth,
        assign: (v) => {
          out.set(key, v);
        },
      });
    }
  }
}
function expand(root: Node, limits: YamlLimits, budget: YamlBudget): Value {
  const targets = aliases(root),
    active = new Set<Node>();
  let result: Value = null;
  const stack: Frame[] = [
    {
      node: root,
      depth: 0,
      assign: (v) => {
        result = v;
      },
    },
  ];
  while (stack.length) {
    const frame = stack.pop()!;
    if ('leave' in frame) {
      active.delete(frame.leave);
      continue;
    }
    const { node, depth, assign } = frame;
    if (!node) {
      assign(null);
      continue;
    }
    debit(budget, 'nodes', limits.maxYamlNodes);
    need(!active.has(node), 'unsupported');
    if (isAlias(node)) {
      debit(budget, 'aliases', limits.maxAliasExpansions);
      stack.push({ node: targets.get(node)!, depth, assign });
    } else if (isScalar(node)) {
      need(node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value));
      assign(node.value as Value);
    } else {
      need(depth < limits.maxYamlDepth, 'budget');
      active.add(node);
      stack.push({ leave: node });
      queueCollection(node, frame, stack);
    }
  }
  return result;
}

function use(value: Value, budget: YamlBudget, limits: YamlLimits): WorkflowUse {
  debit(budget, 'occurrences', limits.maxOccurrences);
  need(typeof value === 'string');
  need(safeIdentity(value, 2048));
  need(!value.includes('${{') && !value.startsWith('docker:'), 'unsupported');
  if (value.startsWith('./')) {
    need(
      value
        .slice(2)
        .split('/')
        .every((s) => s && s !== '.' && s !== '..' && !/[\\:]/u.test(s)),
    );
    return { kind: 'local', path: value };
  }
  const at = value.indexOf('@');
  need(at > 0 && at < value.length - 1);
  const action = value.slice(0, at),
    ref = value.slice(at + 1);
  need(safeIdentity(action) && safeIdentity(ref, 1024));
  need(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(action));
  need(action.split('/').every((s) => s !== '.' && s !== '..'));
  need(!/[\s\\]|[?&](?:token|key|password|secret|auth)=/iu.test(ref));
  return {
    kind: 'external',
    action,
    ref,
    refKind: /^[a-f\d]{40}$/iu.test(ref) ? 'sha' : 'unknown',
  };
}
type Extraction = { budget: YamlBudget; limits: YamlLimits; gaps: YamlGap[] };
function readUse(
  raw: Value,
  jobId: string,
  stepIndex: number | null,
  state: Extraction,
): WorkflowUse {
  try {
    return use(raw, state.budget, state.limits);
  } catch (e) {
    if (e instanceof YamlFailure && e.reason === 'budget') throw e;
    state.gaps.push({
      jobId,
      stepIndex,
      reason: e instanceof YamlFailure ? e.reason : 'malformed',
    });
    return { kind: 'unsupported' };
  }
}
function readStep(step: Value, jobId: string, stepIndex: number, state: Extraction): WorkflowStep {
  if (!(step instanceof Map)) {
    state.gaps.push({ jobId, stepIndex, reason: 'malformed' });
    return { id: null, use: { kind: 'unsupported' } };
  }
  const id = step.get('id');
  if (id !== undefined && !safeIdentity(id))
    state.gaps.push({ jobId, stepIndex, reason: 'malformed' });
  return {
    id: safeIdentity(id) ? id : null,
    use: step.has('uses') ? readUse(step.get('uses')!, jobId, stepIndex, state) : null,
  };
}
function readJob(jobId: string, raw: Value, state: Extraction): WorkflowJob | null {
  if (!safeIdentity(jobId) || !(raw instanceof Map)) {
    state.gaps.push({
      jobId: safeIdentity(jobId) ? jobId : null,
      stepIndex: null,
      reason: 'malformed',
    });
    return null;
  }
  const job: WorkflowJob = { jobId, steps: null, use: null };
  if (raw.has('uses')) job.use = readUse(raw.get('uses')!, jobId, null, state);
  if (raw.has('steps')) {
    const steps = raw.get('steps');
    if (!Array.isArray(steps) || job.use)
      state.gaps.push({ jobId, stepIndex: null, reason: 'malformed' });
    else job.steps = steps.map((step, i) => readStep(step, jobId, i, state));
  } else if (!job.use) state.gaps.push({ jobId, stepIndex: null, reason: 'malformed' });
  return job;
}
function extract(
  value: Value,
  budget: YamlBudget,
  limits: YamlLimits,
): Extract<WorkflowRead, { kind: 'parsed' }> {
  need(value instanceof Map);
  const rawJobs = value.get('jobs');
  need(rawJobs instanceof Map);
  const jobs: WorkflowJob[] = [],
    gaps: YamlGap[] = [];
  for (const [jobId, raw] of [...rawJobs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const job = readJob(jobId, raw, { budget, limits, gaps });
    if (job) jobs.push(job);
  }
  return { kind: 'parsed', jobs, gaps };
}

/** Parses bounded immutable bytes only; caller owns cumulative budget across revisions/files. */
export function readWorkflow(
  bytes: Uint8Array,
  limits: YamlLimits,
  budget: YamlBudget = { nodes: 0, aliases: 0, occurrences: 0 },
): WorkflowRead {
  try {
    need(bytes.byteLength <= limits.maxFileBytes, 'budget');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const tokens = [];
    for (const token of new Parser().parse(text)) {
      preflight(token, limits, budget);
      tokens.push(token);
    }
    const docs = [
      ...new Composer({
        version: '1.2',
        schema: 'core',
        strict: true,
        stringKeys: true,
        uniqueKeys: true,
        merge: false,
        resolveKnownTags: false,
        prettyErrors: false,
        logLevel: 'silent',
      }).compose(tokens),
    ];
    need(docs.length === 1 && docs[0].errors.length === 0);
    need(docs[0].warnings.length === 0, 'unsupported');
    need(docs[0].contents);
    return extract(expand(docs[0].contents, limits, budget), budget, limits);
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof YamlFailure ? e.reason : 'malformed' };
  }
}
