import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { parseReviewBinding, type ReviewBinding, type RepositoryIdentity } from '../event.js';
import type { GithubComparison, GithubFileChange, GithubReadSession } from '../github-read.js';
import { PACKET_LIMITS } from '../schema.js';
import type {
  ActionsSide,
  EvidenceReason,
  InventoryCoverage,
  PacketChange,
  PacketSource,
} from '../schema.js';
import {
  byCodeUnit,
  freeze,
  isEvidencePath,
  isPlainObject,
  longestFittingPrefix,
} from './common.js';
import {
  readWorkflow,
  safeIdentity,
  type WorkflowJob,
  type WorkflowUse,
  type WorkflowStep,
  type YamlBudget,
  type YamlLimits,
} from './actions-yaml.js';

export type ActionsLimits = YamlLimits & { maxWorkflows: number; maxRetainedBytes: number };
export type ActionsGap = {
  path: string | null;
  side: 'base' | 'head' | null;
  jobId: string | null;
  stepIndex: number | null;
  reason: EvidenceReason;
};
export type ActionsSnapshot = {
  state: 'present' | 'absent' | 'unavailable';
  side: 'base' | 'head';
  path: string;
  repository: RepositoryIdentity;
  commitSha: string;
  blobSha: string | null;
  sourceId: string | null;
  jobs: WorkflowJob[];
};
export type ActionsComparison = {
  status: 'available' | 'partial' | 'unavailable';
  reasons: EvidenceReason[];
  sourceIds: string[];
  discrepancies: { path: string; side: 'base' | 'head'; action: string; reason: 'conflict' }[];
};
export type ActionsInventory = {
  kind: 'inventory';
  binding: ReviewBinding;
  changes: PacketChange[];
  sources: PacketSource[];
  workflows: ActionsSnapshot[];
  gaps: ActionsGap[];
  coverage: InventoryCoverage;
  comparison: ActionsComparison;
};
type ReadonlyDeep<T> = T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
export type ActionsInventoryResult =
  | { readonly kind: 'invalid' | 'obsolete' }
  | { readonly kind: 'unavailable'; readonly reason: EvidenceReason }
  | ReadonlyDeep<ActionsInventory>;
type State = {
  binding: ReviewBinding;
  limits: ActionsLimits;
  session: GithubReadSession;
  budget: YamlBudget;
  changes: PacketChange[];
  sources: PacketSource[];
  workflows: ActionsSnapshot[];
  skipped: GithubFileChange[];
  gaps: ActionsGap[];
  comparison: ActionsComparison;
  identities: Map<string, string>;
};
const workflowPath = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{40}$/iu.test(value);
class InventoryFailure extends Error {
  constructor(readonly reason: EvidenceReason) {
    super(reason);
  }
}
function need(value: unknown, reason: EvidenceReason = 'malformed'): asserts value {
  if (!value) throw new InventoryFailure(reason);
}
function own(value: unknown): Record<string, unknown> {
  need(isPlainObject(value));
  return value;
}
function input(value: unknown) {
  const r = own(value),
    raw = own(r.limits),
    b = own(r.binding);
  need(Object.keys(r).length === 2 && Object.hasOwn(r, 'binding') && Object.hasOwn(r, 'limits'));
  for (const key of ['repository', 'headRepository', 'workflow']) own(b[key]);
  need(
    Array.isArray(b.identity) &&
      !types.isProxy(b.identity) &&
      Object.getPrototypeOf(b.identity) === Array.prototype,
  );
  need(b.identity.length === 6 && Reflect.ownKeys(b.identity).length === 7);
  need(Object.values(Object.getOwnPropertyDescriptors(b.identity)).every((d) => 'value' in d));
  const binding = parseReviewBinding(b);
  need(binding);
  const keys = [
    'maxFileBytes',
    'maxWorkflows',
    'maxYamlNodes',
    'maxYamlDepth',
    'maxAliasExpansions',
    'maxOccurrences',
    'maxRetainedBytes',
  ] as const;
  need(
    keys.every(
      (k) => typeof raw[k] === 'number' && Number.isSafeInteger(raw[k]) && (raw[k] as number) > 0,
    ),
  );
  return { binding, limits: Object.fromEntries(keys.map((k) => [k, raw[k]])) as ActionsLimits };
}
function identity(state: State, kind: string, value: unknown) {
  const canonical = JSON.stringify([state.binding.identity, state.binding.baseSha, kind, value]);
  const id = `actions:${kind}:${createHash('sha256').update(canonical).digest('hex')}`;
  need(!state.identities.has(id) || state.identities.get(id) === canonical, 'conflict');
  state.identities.set(id, canonical);
  return id;
}
function gap(
  state: State,
  reason: EvidenceReason,
  path: string | null = null,
  side: ActionsGap['side'] = null,
  jobId: string | null = null,
  stepIndex: number | null = null,
) {
  const value = { path, side, jobId, stepIndex, reason };
  if (!state.gaps.some((g) => isDeepStrictEqual(g, value))) state.gaps.push(value);
}
async function readSideResult(
  state: State,
  side: 'base' | 'head',
  path: string,
): Promise<ActionsSnapshot> {
  const snapshot: ActionsSnapshot = { ...absent(state, side, path), state: 'unavailable' };
  const { repository, commitSha } = snapshot;
  const result = await state.session.readFile({ side, path });
  if (
    result.kind === 'invalid' ||
    result.side !== side ||
    result.path !== path ||
    result.commitSha !== commitSha ||
    !isDeepStrictEqual(result.repository, repository)
  ) {
    gap(state, 'conflict', path, side);
    return snapshot;
  }
  if (result.kind === 'unavailable') {
    gap(state, result.reason, path, side);
    return snapshot;
  }
  if (result.kind === 'absent') {
    snapshot.state = 'absent';
    return snapshot;
  }
  need(sha(result.blobSha) && result.bytes instanceof Uint8Array);
  snapshot.blobSha = result.blobSha;
  snapshot.sourceId = identity(state, 'file', [repository, commitSha, path, result.blobSha]);
  const parsed = readWorkflow(result.bytes, state.limits, state.budget);
  const source: PacketSource = {
    id: snapshot.sourceId,
    kind: 'file',
    ecosystems: ['actions'],
    memberIds: [],
    status: 'available',
    reasons: [],
    provenance: { kind: 'file', revision: side, repository, sha: commitSha, path },
  };
  if (parsed.kind === 'unavailable') {
    gap(state, parsed.reason, path, side);
    source.status = 'unavailable';
    source.reasons = [parsed.reason];
  } else {
    snapshot.state = 'present';
    snapshot.jobs = parsed.jobs;
    for (const g of parsed.gaps) gap(state, g.reason, path, side, g.jobId, g.stepIndex);
  }
  state.sources.push(source);
  return snapshot;
}
async function readSide(
  state: State,
  side: 'base' | 'head',
  path: string,
): Promise<ActionsSnapshot> {
  try {
    return await readSideResult(state, side, path);
  } catch (e) {
    gap(state, e instanceof InventoryFailure ? e.reason : 'unknown', path, side);
    return { ...absent(state, side, path), state: 'unavailable' };
  }
}
function absent(state: State, side: 'base' | 'head', path: string): ActionsSnapshot {
  return {
    state: 'absent',
    side,
    path,
    repository: side === 'base' ? state.binding.repository : state.binding.headRepository,
    commitSha: side === 'base' ? state.binding.baseSha : state.binding.headSha,
    blobSha: null,
    sourceId: null,
    jobs: [],
  };
}
function candidateFiles(state: State, files: readonly GithubFileChange[]) {
  const selected: GithubFileChange[] = [];
  for (const file of files) {
    const paths = [file.path, file.previousPath].filter((p) => p !== null);
    const definitions = paths.filter((p) => /(?:^|\/)action\.ya?ml$/u.test(p));
    if (!definitions.length && !paths.some((p) => workflowPath.test(p))) continue;
    if (!paths.every(isEvidencePath)) gap(state, 'malformed');
    else if (definitions.length) for (const p of definitions) gap(state, 'unsupported', p);
    else selected.push(file);
  }
  return uniqueFiles(state, selected).sort((a, b) =>
    byCodeUnit(
      JSON.stringify([a.path, a.previousPath, a.status]),
      JSON.stringify([b.path, b.previousPath, b.status]),
    ),
  );
}
function fileSides(file: GithubFileChange) {
  return {
    base:
      file.status === 'renamed' ? file.previousPath : file.status === 'added' ? null : file.path,
    head: file.status === 'removed' ? null : file.path,
  };
}
function uniqueFiles(state: State, files: GithubFileChange[]) {
  const seenBase = new Set<string>(),
    seenHead = new Set<string>();
  return [...files]
    .sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)))
    .filter((file) => {
      const { base, head } = fileSides(file);
      if ((base && seenBase.has(base)) || (head && seenHead.has(head))) {
        gap(state, 'conflict', file.path);
        return false;
      }
      if (base) seenBase.add(base);
      if (head) seenHead.add(head);
      return true;
    });
}
async function collectFile(state: State, file: GithubFileChange) {
  const previous = file.status === 'renamed' ? file.previousPath : file.path;
  if (!previous || !['added', 'removed', 'modified', 'renamed'].includes(file.status)) {
    gap(state, 'unsupported', file.path);
    return;
  }
  const inBase = workflowPath.test(previous) && file.status !== 'added';
  const inHead = workflowPath.test(file.path) && file.status !== 'removed';
  const base = inBase ? await readSide(state, 'base', previous) : absent(state, 'base', file.path);
  const head = inHead ? await readSide(state, 'head', file.path) : absent(state, 'head', previous);
  for (const [expected, snapshot] of [
    [inBase, base],
    [inHead, head],
  ] as const) {
    if (expected && snapshot.state === 'absent') {
      gap(state, 'missing', snapshot.path, snapshot.side);
      snapshot.state = 'unavailable';
    }
  }
  state.workflows.push(base, head);
  diff(state, base, head);
}
function occurrences(snapshot: ActionsSnapshot) {
  const entries: { side: ActionsSide }[] = [];
  const add = (jobId: string, stepIndex: number | null, use: WorkflowUse | null) => {
    if (use?.kind !== 'external' || !snapshot.sourceId) return;
    entries.push({
      side: {
        workflow: snapshot.path,
        jobId,
        stepIndex,
        action: use.action,
        ref: use.refKind === 'sha' ? use.ref.toLowerCase() : use.ref,
        refKind: use.refKind,
        sourceId: snapshot.sourceId,
      },
    });
  };
  for (const job of snapshot.jobs) {
    add(job.jobId, null, job.use);
    job.steps?.forEach((step, i) => add(job.jobId, i, step.use));
  }
  return entries;
}
function emit(state: State, from: ActionsSide | null, to: ActionsSide | null) {
  const id = identity(state, 'change', [from, to]);
  if (state.changes.some((c) => c.id === id)) {
    gap(state, 'conflict');
    return;
  }
  state.changes.push({
    id,
    ecosystem: 'actions',
    kind: !from ? 'addition' : !to ? 'removal' : 'update',
    role: 'direct',
    from,
    to,
    evidence: Object.fromEntries(
      ['upstream', 'vulnerability', 'malware'].map((k) => [
        k,
        { status: 'unavailable', reasons: ['missing'], sourceIds: [] },
      ]),
    ),
  });
}
function signature(use: WorkflowUse | null) {
  if (use?.kind === 'external') return use.action;
  if (use?.kind === 'local') return use.path;
  return use?.kind ?? null;
}
function uniqueIds(steps: WorkflowStep[]) {
  const ids = new Map<string, number | null>();
  steps.forEach((step, i) => {
    if (step.id) ids.set(step.id, ids.has(step.id) ? null : i);
  });
  return ids;
}
function stepPairs(base: WorkflowStep[], head: WorkflowStep[]) {
  const before = uniqueIds(base),
    after = uniqueIds(head),
    pairs = new Map<number, number>();
  for (const [id, index] of before) {
    const to = after.get(id);
    if (index !== null && to !== undefined && to !== null) pairs.set(index, to);
  }
  const aligned =
    base.length === head.length &&
    base.every((step, i) => signature(step.use) === signature(head[i].use));
  if (aligned) {
    const used = new Set(pairs.values());
    base.forEach((_, i) => {
      if (!pairs.has(i) && !used.has(i)) pairs.set(i, i);
    });
  }
  return pairs;
}
function uncertain(state: State, snapshot: ActionsSnapshot, jobId: string, index?: number | null) {
  return state.gaps.some(
    (g) =>
      g.path === snapshot.path &&
      g.side === snapshot.side &&
      g.jobId === jobId &&
      (index === undefined || g.stepIndex === null || g.stepIndex === index),
  );
}
function emitPair(state: State, from: ActionsSide | null, to: ActionsSide | null) {
  if (from && to && from.action === to.action) {
    if (from.ref !== to.ref) emit(state, from, to);
  } else {
    if (from) emit(state, from, null);
    if (to) emit(state, null, to);
  }
}
type JobOccurrences = Map<string, Map<number | null, ActionsSide>>;
function byJob(snapshot: ActionsSnapshot): JobOccurrences {
  const jobs: JobOccurrences = new Map();
  for (const { side } of occurrences(snapshot)) {
    const job = jobs.get(side.jobId) ?? new Map<number | null, ActionsSide>();
    jobs.set(side.jobId, job.set(side.stepIndex, side));
  }
  return jobs;
}
function diffJob(
  state: State,
  base: ActionsSnapshot,
  head: ActionsSnapshot,
  jobId: string,
  occurrence: { base: JobOccurrences; head: JobOccurrences },
) {
  const before = new Map(occurrence.base.get(jobId));
  const after = new Map(occurrence.head.get(jobId));
  if (!uncertain(state, base, jobId, null) && !uncertain(state, head, jobId, null)) {
    emitPair(state, before.get(null) ?? null, after.get(null) ?? null);
  }
  before.delete(null);
  after.delete(null);
  const oldJob = base.jobs.find((j) => j.jobId === jobId),
    newJob = head.jobs.find((j) => j.jobId === jobId);
  const pairs = stepPairs(oldJob?.steps ?? [], newJob?.steps ?? []);
  for (const [i, j] of pairs) {
    if (!uncertain(state, base, jobId, i) && !uncertain(state, head, jobId, j))
      emitPair(state, before.get(i) ?? null, after.get(j) ?? null);
    before.delete(i);
    after.delete(j);
  }
  if (uncertain(state, base, jobId) || uncertain(state, head, jobId)) return;
  if (oldJob?.steps && newJob?.steps && before.size + after.size > 0)
    gap(state, 'conflict', head.path, null, jobId);
  for (const from of before.values()) emit(state, from, null);
  for (const to of after.values()) emit(state, null, to);
}
function diff(state: State, base: ActionsSnapshot, head: ActionsSnapshot) {
  if (base.state === 'unavailable' || head.state === 'unavailable') return;
  const jobs = new Set([...base.jobs, ...head.jobs].map((j) => j.jobId));
  const occurrence = { base: byJob(base), head: byJob(head) };
  for (const jobId of jobs) diffJob(state, base, head, jobId, occurrence);
}

function comparisonIdentity(state: State, result: GithubComparison) {
  const b = state.binding;
  need(
    result.baseSha === b.baseSha &&
      result.headSha === b.headSha &&
      result.mergeBaseSha === b.mergeBaseSha &&
      isDeepStrictEqual(result.repository, b.repository) &&
      isDeepStrictEqual(result.headRepository, b.headRepository),
    'conflict',
  );
}
function versionMatches(ref: string, version: string) {
  return (
    ref === version ||
    (ref.startsWith('v') && ref.slice(1) === version) ||
    (sha(ref) && sha(version) && ref.toLowerCase() === version.toLowerCase())
  );
}
function comparisonSource(
  state: State,
  path: string,
  action: string,
  side: 'base' | 'head',
  refs: Set<string>,
) {
  const field = side === 'base' ? 'from' : 'to';
  const members = state.changes.filter(
    (c) =>
      c.ecosystem === 'actions' &&
      c[field]?.workflow === path &&
      c[field]?.action === action &&
      refs.has(c[field]!.ref),
  );
  if (!members.length) return;
  const memberIds = members.map((c) => c.id).sort();
  const id = identity(state, 'comparison', [path, action, side, [...refs].sort(), memberIds]);
  if (state.sources.some((s) => s.id === id)) return;
  const b = state.binding;
  state.sources.push({
    id,
    kind: 'comparison',
    ecosystems: ['actions'],
    memberIds,
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'upstream',
      url: `https://api.github.com/repos/${encodeURIComponent(b.repository.owner)}/${encodeURIComponent(b.repository.name)}/dependency-graph/compare/${b.baseSha}...${b.headSha}`,
      title: 'GitHub Actions dependency comparison',
      excerpt: 'The comparison corroborates this workflow action reference.',
      excerptTruncated: false,
      subjects: members.map((c) => ({
        memberId: c.id,
        side,
        value: (c[field] as ActionsSide).ref,
      })),
      range: null,
    },
  });
}
// A record for a selected workflow that was never read can be neither matched nor contradicted.
function uninventoried(state: State, path: string, side: 'base' | 'head'): EvidenceReason | null {
  if (state.skipped.some((f) => fileSides(f)[side] === path)) return 'budget';
  const at = (w: { path: string | null; side: string | null }) =>
    w.path === path && w.side === side;
  if (!state.workflows.some((w) => at(w) && w.state === 'unavailable')) return null;
  return state.gaps.find((g) => at(g) && g.jobId === null)?.reason ?? 'unknown';
}
function comparisonRow(state: State, value: unknown) {
  const row = own(value);
  need(isEvidencePath(row.manifest) && safeIdentity(row.name) && safeIdentity(row.version, 1024));
  need(row.change_type === 'added' || row.change_type === 'removed');
  const path = row.manifest,
    action = row.name,
    version = row.version;
  const side: 'base' | 'head' = row.change_type === 'added' ? 'head' : 'base';
  const set = state.workflows
    .filter((w) => w.path === path && w.side === side)
    .flatMap(occurrences)
    .filter((o) => o.side.action === action);
  if (!set.length) {
    const unread = uninventoried(state, path, side);
    if (unread) return unread;
    gap(state, 'conflict', path, side);
    return 'conflict' as const;
  }
  const matching = set.filter((o) => versionMatches(o.side.ref, version));
  if (!matching.length) {
    const discrepancy = { path, side, action, reason: 'conflict' as const };
    if (!state.comparison.discrepancies.some((d) => isDeepStrictEqual(d, discrepancy)))
      state.comparison.discrepancies.push(discrepancy);
    return 'conflict' as const;
  }
  comparisonSource(state, path, action, side, new Set(matching.map((o) => o.side.ref)));
  return null;
}
function comparisonReason(state: State, row: unknown): EvidenceReason | null {
  try {
    return comparisonRow(state, row);
  } catch (e) {
    return e instanceof InventoryFailure ? e.reason : 'malformed';
  }
}
async function reconcileComparison(state: State) {
  try {
    const result = await state.session.readComparison();
    comparisonIdentity(state, result);
    const reasons = new Set(result.reasons);
    for (const row of result.records.filter((r) => r.ecosystem === 'actions')) {
      const why = comparisonReason(state, row);
      if (why) reasons.add(why);
    }
    state.comparison.status = result.kind === 'available' && reasons.size ? 'partial' : result.kind;
    state.comparison.reasons = [...reasons].sort();
  } catch (e) {
    state.comparison.status = 'unavailable';
    state.comparison.reasons = [e instanceof InventoryFailure ? e.reason : 'unknown'];
  }
  if (state.comparison.status === 'unavailable') {
    if (!state.comparison.reasons.length) state.comparison.reasons = ['unknown'];
    state.sources.push({
      id: identity(state, 'comparison-unavailable', state.comparison.reasons),
      kind: 'comparison',
      ecosystems: ['actions'],
      memberIds: [],
      status: 'unavailable',
      reasons: state.comparison.reasons,
      provenance: { kind: 'unavailable' },
    });
  }
  state.comparison.discrepancies.sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
}
function retargetFileSource(changes: PacketChange[], from: string, to: string) {
  for (const side of changes.flatMap((c) => [c.from, c.to])) {
    if (side?.sourceId === from) side.sourceId = to;
  }
}
function splitSource(source: PacketSource, changes: PacketChange[]) {
  const members =
    source.kind === 'file'
      ? changes
          .filter((c) => c.from?.sourceId === source.id || c.to?.sourceId === source.id)
          .map((c) => c.id)
          .sort()
      : source.memberIds.filter((id) => changes.some((c) => c.id === id)).sort();
  if (!members.length)
    return source.provenance.kind === 'upstream' ? [] : [{ ...source, memberIds: [] }];
  const result: PacketSource[] = [];
  for (let i = 0; i < members.length; i += PACKET_LIMITS.listEntries) {
    const memberIds = members.slice(i, i + PACKET_LIMITS.listEntries),
      group = new Set(memberIds);
    const id = i === 0 ? source.id : `${source.id}:${i / PACKET_LIMITS.listEntries}`;
    const provenance =
      source.provenance.kind === 'upstream'
        ? {
            ...source.provenance,
            subjects: source.provenance.subjects.filter((t) => group.has(t.memberId)),
          }
        : source.provenance;
    result.push({ ...source, id, memberIds, provenance });
    if (source.kind === 'file')
      retargetFileSource(
        changes.filter((c) => group.has(c.id)),
        source.id,
        id,
      );
  }
  return result;
}
function assemble(state: State, applicable: boolean, snapshots = true): ActionsInventory {
  const reasons = [...new Set(state.gaps.map((g) => g.reason))].sort();
  const status: InventoryCoverage['status'] = reasons.length
    ? 'partial'
    : applicable
      ? 'complete'
      : 'not_applicable';
  const source: PacketSource = {
    id: 'actions:inventory',
    kind: 'file-list',
    ecosystems: ['actions'],
    memberIds: [],
    status: reasons.length ? 'partial' : 'available',
    reasons,
    provenance: {
      kind: 'inventory',
      repository: state.binding.repository,
      baseSha: state.binding.baseSha,
      headSha: state.binding.headSha,
      absentEcosystems: status === 'not_applicable' ? ['actions'] : [],
    },
  };
  const changes = structuredClone(state.changes).sort((a, b) => byCodeUnit(a.id, b.id));
  const sources = state.sources
    .flatMap((s) => splitSource(s, changes))
    .filter((s) => snapshots || s.memberIds.length > 0 || s.kind === 'comparison')
    .sort((a, b) => byCodeUnit(a.id, b.id));
  const gaps = snapshots
    ? [...state.gaps]
    : reasons.map((reason) => ({ path: null, side: null, jobId: null, stepIndex: null, reason }));
  return {
    kind: 'inventory',
    binding: state.binding,
    changes,
    sources: [source, ...sources],
    workflows: snapshots ? state.workflows : [],
    gaps: gaps.sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b))),
    coverage: { status, reasons, sourceIds: [source.id] },
    comparison: {
      ...state.comparison,
      sourceIds: sources.filter((s) => s.kind === 'comparison').map((s) => s.id),
    },
  };
}
function finish(state: State, applicable: boolean): ActionsInventoryResult {
  const fits = (value: ActionsInventory) =>
    Buffer.byteLength(JSON.stringify(value)) <= state.limits.maxRetainedBytes;
  const full = assemble(state, applicable);
  if (fits(full)) return freeze(structuredClone(full));
  gap(state, 'budget');
  const all = [...state.changes].sort((a, b) => byCodeUnit(a.id, b.id));
  const prefix = (length: number) => {
    state.changes = all.slice(0, length);
    return assemble(state, applicable, false);
  };
  const trimmed = longestFittingPrefix(all.length, prefix, fits);
  return trimmed ? freeze(structuredClone(trimmed)) : { kind: 'unavailable', reason: 'budget' };
}

/** Read-only D1 collection; no PR code, provider calls, credentials or publication capability. */
export async function collectActionsInventory(
  value: unknown,
  { session }: { session: GithubReadSession },
): Promise<ActionsInventoryResult> {
  let parsed: ReturnType<typeof input>;
  try {
    parsed = input(value);
  } catch {
    return { kind: 'invalid' };
  }
  const state: State = {
    ...parsed,
    session,
    budget: { nodes: 0, aliases: 0, occurrences: 0 },
    changes: [],
    sources: [],
    workflows: [],
    skipped: [],
    gaps: [],
    identities: new Map(),
    comparison: { status: 'unavailable', reasons: ['missing'], sourceIds: [], discrepancies: [] },
  };
  try {
    const discovery = await session.discoverFiles();
    if (discovery.kind === 'obsolete') return { kind: 'obsolete' };
    need(isDeepStrictEqual(discovery.binding, state.binding), 'conflict');
    if (!discovery.complete)
      for (const reason of discovery.reasons.length ? discovery.reasons : ['unknown' as const])
        gap(state, reason);
    const files = candidateFiles(state, discovery.files);
    for (const f of files.slice(0, state.limits.maxWorkflows)) await collectFile(state, f);
    state.skipped = files.slice(state.limits.maxWorkflows);
    if (state.skipped.length) gap(state, 'budget');
    await reconcileComparison(state);
    return finish(state, files.length > 0);
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof InventoryFailure ? e.reason : 'unknown' };
  }
}
