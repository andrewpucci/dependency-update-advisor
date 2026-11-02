import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { parseReviewBinding, type ReviewBinding, type RepositoryIdentity } from '../event.js';
import type { GithubReadSession, GithubFileResult, GithubDiscovery } from '../github-read.js';
import type { EvidenceReason, PacketRevision } from '../schema.js';
import { byCodeUnit, isEvidencePath, isPlainObject, longestFittingPrefix } from './common.js';
import { readManifest, type UvManifest } from './uv-manifest.js';
import { readLock, type UvLock } from './uv-lock.js';
import {
  need,
  newBudget,
  UvFailure,
  type UvBudget,
  type UvParseLimits,
  type UvRead,
} from './uv-toml.js';
export type UvLimits = UvParseLimits & { maxRoots: number; maxRetainedBytes: number };
type Side = 'base' | 'head';
type Availability = 'present' | 'partial' | 'absent' | 'unavailable';
export type UvGap = {
  root: string | null;
  side: Side | null;
  path: string | null;
  entry: string | null;
  reason: EvidenceReason;
};
export type UvFileSnapshot<T> = {
  id: string;
  sourceId: string | null;
  state: Availability;
  side: Side;
  path: string;
  repository: RepositoryIdentity;
  commitSha: string;
  blobSha: string | null;
  treeSha: string | null;
  data: T | null;
};
export type UvRootSide = {
  state: Availability;
  manifest: UvFileSnapshot<UvManifest>;
  lock: UvFileSnapshot<UvLock>;
};
export type UvRootSnapshot = {
  id: string;
  root: string;
  configured: boolean;
  base: UvRootSide;
  head: UvRootSide;
};
/** U2 translates these identities into T4 sources with actual change membership. */
export type UvFileSource = {
  id: string;
  kind: 'file' | 'absence';
  side: Side;
  path: string;
  repository: RepositoryIdentity;
  commitSha: string;
  blobSha: string | null;
  treeSha: string | null;
  status: 'available' | 'partial' | 'unavailable';
  reasons: EvidenceReason[];
};
export type UvMetadata = {
  kind: 'metadata';
  binding: ReviewBinding;
  configRevision: PacketRevision;
  roots: UvRootSnapshot[];
  sources: UvFileSource[];
  gaps: UvGap[];
  discovery: {
    status: 'available' | 'partial' | 'unavailable';
    complete: boolean;
    applicable: boolean;
    reasons: EvidenceReason[];
  };
  comparison: { status: 'available' | 'partial' | 'unavailable'; reasons: EvidenceReason[] };
};
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type UvMetadataResult =
  | { readonly kind: 'invalid' | 'obsolete' }
  | { readonly kind: 'unavailable'; readonly reason: EvidenceReason }
  | DeepReadonly<UvMetadata>;
type Input = {
  binding: ReviewBinding;
  configRevision: PacketRevision;
  roots: string[];
  limits: UvLimits;
};
type State = {
  input: Input;
  session: GithubReadSession;
  budget: UvBudget;
  output: UvMetadata;
  identities: Map<string, string>;
};
const limitKeys = [
  'maxFileBytes',
  'maxTomlDepth',
  'maxTomlEntries',
  'maxPackages',
  'maxDeclarations',
  'maxEdges',
  'maxStringBytes',
  'maxRequirementTokens',
  'maxMarkerDepth',
  'maxRoots',
  'maxRetainedBytes',
] as const;
const reasons: readonly EvidenceReason[] = [
  'permission',
  'rate_limit',
  'timeout',
  'missing',
  'malformed',
  'unsupported',
  'truncated',
  'budget',
  'conflict',
  'unknown',
];
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{40}$/iu.test(value);
function failure(error: unknown): EvidenceReason {
  return error instanceof UvFailure ? error.reason : 'unknown';
}
function own(value: unknown) {
  need(isPlainObject(value));
  return value;
}
function array(value: unknown): unknown[] {
  need(
    Array.isArray(value) &&
      !types.isProxy(value) &&
      Object.getPrototypeOf(value) === Array.prototype,
  );
  need(
    Reflect.ownKeys(value).length === value.length + 1 &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every((d) => 'value' in d),
  );
  need(
    Reflect.ownKeys(value).every(
      (key) =>
        key === 'length' ||
        (typeof key === 'string' && /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < value.length),
    ),
  );
  return value;
}
function input(value: unknown): Input {
  const raw = own(value),
    limits = own(raw.limits),
    b = own(raw.binding);
  need(
    Object.keys(raw).length === 4 &&
      ['binding', 'configRevision', 'roots', 'limits'].every((k) => Object.hasOwn(raw, k)),
  );
  for (const key of ['repository', 'headRepository', 'workflow']) own(b[key]);
  array(b.identity);
  const binding = parseReviewBinding(b);
  need(binding);
  for (const key of limitKeys)
    need(
      typeof limits[key] === 'number' &&
        Number.isSafeInteger(limits[key]) &&
        (limits[key] as number) > 0,
    );
  need((limits.maxStringBytes as number) <= (limits.maxFileBytes as number));
  const config = own(raw.configRevision);
  own(config.repository);
  need(isDeepStrictEqual(config.repository, binding.repository) && sha(config.sha));
  const roots = array(raw.roots).map((root) => {
    need(root === '.' || isEvidencePath(root));
    return root as string;
  });
  need(roots.length <= (limits.maxRoots as number) && new Set(roots).size === roots.length);
  return {
    binding: structuredClone(binding),
    configRevision: {
      repository: structuredClone(binding.repository),
      sha: config.sha.toLowerCase(),
    },
    roots: roots.sort(byCodeUnit),
    limits: Object.fromEntries(limitKeys.map((k) => [k, limits[k]])) as UvLimits,
  };
}
function identity(state: State, kind: string, value: unknown) {
  const canonical = JSON.stringify([
    state.input.binding.identity,
    state.input.binding.baseSha,
    kind,
    value,
  ]);
  const id = `uv:${kind}:${createHash('sha256').update(canonical).digest('hex')}`;
  need(!state.identities.has(id) || state.identities.get(id) === canonical, 'conflict');
  state.identities.set(id, canonical);
  return id;
}
function gap(
  state: State,
  reason: EvidenceReason,
  root: string | null = null,
  side: Side | null = null,
  path: string | null = null,
  entry: string | null = null,
) {
  const value = { root, side, path, entry, reason };
  if (!state.output.gaps.some((g) => isDeepStrictEqual(g, value))) state.output.gaps.push(value);
}
function emptyFile<T>(state: State, side: Side, path: string): UvFileSnapshot<T> {
  const binding = state.input.binding,
    repository = side === 'base' ? binding.repository : binding.headRepository,
    commitSha = side === 'base' ? binding.baseSha : binding.headSha;
  return {
    id: identity(state, 'snapshot', [repository, commitSha, side, path, null]),
    sourceId: null,
    state: 'unavailable',
    side,
    path,
    repository,
    commitSha,
    blobSha: null,
    treeSha: null,
    data: null,
  };
}
function checkFile<T>(snapshot: UvFileSnapshot<T>, result: GithubFileResult) {
  need(result.kind !== 'invalid', 'conflict');
  need(
    result.side === snapshot.side &&
      result.path === snapshot.path &&
      result.commitSha === snapshot.commitSha &&
      isDeepStrictEqual(result.repository, snapshot.repository),
    'conflict',
  );
  if (result.kind === 'available')
    need(sha(result.blobSha) && result.bytes instanceof Uint8Array, 'conflict');
  if (result.kind === 'absent') need(sha(result.treeSha), 'conflict');
  return result;
}
function fileSource<T>(state: State, snapshot: UvFileSnapshot<T>, why: EvidenceReason[]) {
  const { side, path, repository, commitSha, blobSha, treeSha } = snapshot;
  const id = identity(state, 'source', [repository, commitSha, side, path, blobSha, treeSha]);
  snapshot.sourceId = id;
  snapshot.id = identity(state, 'snapshot', [repository, commitSha, side, path, blobSha, treeSha]);
  state.output.sources.push({
    id,
    kind: snapshot.state === 'absent' ? 'absence' : 'file',
    side,
    path,
    repository,
    commitSha,
    blobSha,
    treeSha,
    status:
      snapshot.state === 'absent' || snapshot.state === 'present'
        ? 'available'
        : snapshot.state === 'partial'
          ? 'partial'
          : 'unavailable',
    reasons: [...new Set(why)].sort(byCodeUnit),
  });
}
async function readFile<T>(
  state: State,
  root: string,
  side: Side,
  path: string,
  reader: (bytes: Uint8Array, limits: UvParseLimits, budget: UvBudget) => UvRead<T>,
): Promise<UvFileSnapshot<T>> {
  const snapshot = emptyFile<T>(state, side, path);
  try {
    const result = checkFile(snapshot, await state.session.readFile({ side, path }));
    if (result.kind === 'unavailable') {
      need(reasons.includes(result.reason));
      gap(state, result.reason, root, side, path);
      return snapshot;
    }
    if (result.kind === 'absent') {
      snapshot.state = 'absent';
      snapshot.treeSha = result.treeSha;
      fileSource(state, snapshot, []);
      return snapshot;
    }
    snapshot.blobSha = result.blobSha;
    const parsed = reader(result.bytes, state.input.limits, state.budget);
    if (parsed.kind === 'unavailable') {
      gap(state, parsed.reason, root, side, path);
      fileSource(state, snapshot, [parsed.reason]);
      return snapshot;
    }
    snapshot.data = parsed.value;
    snapshot.state = parsed.gaps.length ? 'partial' : 'present';
    for (const g of parsed.gaps) gap(state, g.reason, root, side, path, g.entry);
    fileSource(
      state,
      snapshot,
      parsed.gaps.map((g) => g.reason),
    );
  } catch (error) {
    snapshot.state = 'unavailable';
    snapshot.data = null;
    snapshot.sourceId = null;
    gap(state, failure(error), root, side, path);
  }
  return snapshot;
}
function combinedState(a: Availability, b: Availability): Availability {
  if (a === b && ['absent', 'present', 'unavailable'].includes(a)) return a;
  return 'partial';
}
function associateProject(
  state: State,
  root: string,
  side: Side,
  manifest: UvFileSnapshot<UvManifest>,
  lock: UvFileSnapshot<UvLock>,
) {
  if (!manifest.data || !lock.data) return;
  const anchors = lock.data.packages.filter((p) => !p.external);
  if (anchors.length === 1 && anchors[0].name === manifest.data.name) return;
  const why = anchors.length ? 'conflict' : 'unsupported';
  gap(state, why, root, side, lock.path, 'project-anchor');
  lock.state = 'partial';
  const source = state.output.sources.find((s) => s.id === lock.sourceId);
  if (source) {
    source.status = 'partial';
    source.reasons = [...new Set([...source.reasons, why as EvidenceReason])].sort(byCodeUnit);
  }
}
async function rootSide(state: State, root: string, side: Side): Promise<UvRootSide> {
  const path = (file: string) => (root === '.' ? file : `${root}/${file}`);
  const manifest = await readFile(state, root, side, path('pyproject.toml'), readManifest);
  const lock = await readFile(state, root, side, path('uv.lock'), readLock);
  if ((manifest.state === 'absent') !== (lock.state === 'absent')) {
    const absent = manifest.state === 'absent' ? manifest : lock;
    gap(state, 'missing', root, side, absent.path);
  }
  associateProject(state, root, side, manifest, lock);
  return { state: combinedState(manifest.state, lock.state), manifest, lock };
}
function candidateRoots(state: State, discovery: GithubDiscovery) {
  const roots = new Set<string>();
  for (const file of discovery.files) {
    for (const path of [file.path, file.previousPath]) {
      if (typeof path !== 'string' || !/(?:^|\/)(?:pyproject\.toml|uv\.lock)$/u.test(path))
        continue;
      if (!isEvidencePath(path)) {
        gap(state, 'malformed');
        continue;
      }
      roots.add(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
    }
  }
  if (!discovery.complete) for (const root of state.input.roots) roots.add(root);
  return [...roots].sort(byCodeUnit);
}
async function collectRoot(state: State, root: string) {
  const configured = state.input.roots.includes(root);
  if (!configured) gap(state, 'unsupported', root);
  const base = await rootSide(state, root, 'base'),
    head = await rootSide(state, root, 'head');
  state.output.roots.push({
    id: identity(state, 'root', [root, state.input.configRevision]),
    root,
    configured,
    base,
    head,
  });
}
function discoveryState(state: State, result: GithubDiscovery) {
  need(isDeepStrictEqual(result.binding, state.input.binding), 'conflict');
  need(['available', 'partial', 'unavailable'].includes(result.kind), 'malformed');
  need(result.reasons.every((r) => reasons.includes(r)));
  const why = new Set(result.reasons);
  if (!result.complete && !why.size) why.add('unknown');
  if (state.input.binding.baseSha !== state.input.binding.mergeBaseSha) why.add('conflict');
  for (const r of why) gap(state, r);
  state.output.discovery = {
    status: result.kind as 'available' | 'partial' | 'unavailable',
    complete: result.complete && !why.size,
    applicable: false,
    reasons: [...why].sort(byCodeUnit),
  };
}
async function comparison(state: State) {
  try {
    const result = await state.session.readComparison(),
      b = state.input.binding;
    need(
      isDeepStrictEqual(result.repository, b.repository) &&
        isDeepStrictEqual(result.headRepository, b.headRepository) &&
        result.baseSha === b.baseSha &&
        result.headSha === b.headSha &&
        result.mergeBaseSha === b.mergeBaseSha,
      'conflict',
    );
    need(
      ['available', 'partial', 'unavailable'].includes(result.kind) &&
        result.reasons.every((r) => reasons.includes(r)),
    );
    const why = [...new Set(result.reasons)].sort(byCodeUnit);
    state.output.comparison = {
      status: result.kind,
      reasons: why.length ? why : result.kind === 'available' ? [] : ['unknown'],
    };
  } catch (error) {
    state.output.comparison = { status: 'unavailable', reasons: [failure(error)] };
  }
}
function detach<T>(value: T): DeepReadonly<T> {
  const result = structuredClone(value),
    stack: unknown[] = [result];
  while (stack.length) {
    const next = stack.pop();
    if (next && typeof next === 'object') {
      for (const child of Object.values(next)) stack.push(child);
      Object.freeze(next);
    }
  }
  return result as DeepReadonly<T>;
}
function orderedGaps(gaps: UvGap[]) {
  const unique = new Map(gaps.map((g) => [JSON.stringify(g), g]));
  return [...unique].sort(([a], [b]) => byCodeUnit(a, b)).map(([, value]) => value);
}
function rootFiles(root: UvRootSnapshot) {
  return [root.base.manifest, root.base.lock, root.head.manifest, root.head.lock];
}
// Roots are atomic retention units. Omitted files keep diagnostics even with no retained packages.
function prefix(state: State, count: number): UvMetadata {
  const full = state.output,
    roots = full.roots.slice(0, count),
    sourceIds = new Set<string>();
  for (const root of roots)
    for (const file of rootFiles(root)) if (file.sourceId) sourceIds.add(file.sourceId);
  const gaps: UvGap[] = [
    ...full.gaps,
    { root: null, side: null, path: null, entry: null, reason: 'budget' },
  ];
  for (const root of full.roots.slice(count))
    for (const file of rootFiles(root))
      gaps.push({
        root: root.root,
        side: file.side,
        path: file.path,
        entry: null,
        reason: 'budget',
      });
  return {
    ...full,
    roots,
    sources: full.sources.filter((s) => sourceIds.has(s.id)),
    gaps: orderedGaps(gaps),
  };
}
function finish(state: State): UvMetadataResult {
  state.output.gaps = orderedGaps(state.output.gaps);
  state.output.sources.sort((a, b) => byCodeUnit(a.id, b.id));
  const fits = (value: UvMetadata) =>
    Buffer.byteLength(JSON.stringify(value)) <= state.input.limits.maxRetainedBytes;
  if (fits(state.output)) return detach(state.output);
  const trimmed = longestFittingPrefix(
    state.output.roots.length,
    (count) => prefix(state, count),
    fits,
  );
  return trimmed ? detach(trimmed) : { kind: 'unavailable', reason: 'budget' };
}
/** Bound immutable D1 reads only. U2 must consume all gaps before making any inventory claim. */
export async function collectUvMetadata(
  value: unknown,
  { session }: { session: GithubReadSession },
): Promise<UvMetadataResult> {
  let parsed: Input;
  try {
    parsed = input(value);
  } catch {
    return { kind: 'invalid' };
  }
  const output: UvMetadata = {
    kind: 'metadata',
    binding: parsed.binding,
    configRevision: parsed.configRevision,
    roots: [],
    sources: [],
    gaps: [],
    discovery: { status: 'unavailable', complete: false, applicable: false, reasons: ['missing'] },
    comparison: { status: 'unavailable', reasons: ['missing'] },
  };
  const state: State = {
    input: parsed,
    session,
    budget: newBudget(),
    output,
    identities: new Map(),
  };
  try {
    const discovery = await session.discoverFiles();
    if (discovery.kind === 'obsolete') return { kind: 'obsolete' };
    discoveryState(state, discovery);
    const roots = candidateRoots(state, discovery);
    output.discovery.applicable = roots.length > 0;
    for (const root of roots.slice(0, parsed.limits.maxRoots)) await collectRoot(state, root);
    for (const root of roots.slice(parsed.limits.maxRoots)) gap(state, 'budget', root);
    await comparison(state);
    return finish(state);
  } catch (error) {
    return { kind: 'unavailable', reason: failure(error) };
  }
}
