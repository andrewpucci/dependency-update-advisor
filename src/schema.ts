import { isDeepStrictEqual, types } from 'node:util';
import type { Finding } from './policy.js';
import { parseReviewBinding, type RepositoryIdentity, type ReviewBinding } from './event.js';

export const PACKET_LIMITS = Object.freeze({
  bytes: 1_048_576,
  changes: 128,
  sources: 1_024,
  findings: 512,
  relationships: 256,
  pathInstances: 32,
  idCodeUnits: 256,
  identityBytes: 1_024,
  textBytes: 2_048,
  listEntries: 32,
  contextBytes: 65_536,
  excerptCodeUnits: 500,
  facts: 20,
});
const ECOSYSTEMS = ['npm', 'actions', 'uv'] as const;
const REASONS = [
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
] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];
export type EvidenceReason = (typeof REASONS)[number];
export type EvidenceStatus = 'available' | 'partial' | 'unavailable';
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type PacketRevision = { repository: RepositoryIdentity; sha: string };
export type InventoryCoverage = {
  status: 'complete' | 'partial' | 'unavailable' | 'not_applicable';
  reasons: EvidenceReason[];
  sourceIds: string[];
};
export type PackageSource = {
  kind: 'registry' | 'git' | 'url' | 'path' | 'workspace';
  identity: string;
};
export type NpmSide = {
  root: string;
  name: string;
  lockPath: string | null;
  version: string;
  source: PackageSource;
  sourceId: string;
};
export type ChangeEvidence = {
  status: EvidenceStatus;
  reasons: EvidenceReason[];
  sourceIds: string[];
};
export type ActionsSide = {
  workflow: string;
  jobId: string;
  stepIndex: number | null;
  action: string;
  ref: string;
  refKind: 'tag' | 'branch' | 'sha' | 'unknown';
  sourceId: string;
};
export type UvSide = {
  root: string;
  name: string;
  version: string;
  source: PackageSource;
  marker: string | null;
  extras: string[];
  groups: string[];
  sourceId: string;
};
export type DependencySide = NpmSide | ActionsSide | UvSide;
type ChangeFacts = {
  id: string;
  kind: 'update' | 'addition' | 'removal';
  role: 'direct' | 'transitive' | 'unknown';
  evidence: Record<string, ChangeEvidence>;
};
export type PacketChange = ChangeFacts &
  (
    | {
        ecosystem: 'npm';
        from: NpmSide | null;
        to: NpmSide | null;
        directRoles?: ('production' | 'development' | 'peer' | 'optional')[];
      }
    | { ecosystem: 'actions'; from: ActionsSide | null; to: ActionsSide | null }
    | { ecosystem: 'uv'; from: UvSide | null; to: UvSide | null }
  );
export type SourceSubject = { memberId: string; side: 'base' | 'head'; value: string };
export type SourceProvenance =
  | {
      kind: 'inventory';
      repository: RepositoryIdentity;
      baseSha: string;
      headSha: string;
      absentEcosystems: Ecosystem[];
    }
  | {
      kind: 'file';
      revision: 'base' | 'head' | 'context';
      repository: RepositoryIdentity;
      sha: string;
      path: string;
    }
  | { kind: 'unavailable' }
  | {
      kind: 'upstream';
      url: string;
      title: string;
      excerpt: string;
      excerptTruncated: boolean;
      subjects: SourceSubject[];
      range: { from: string | null; to: string | null } | null;
      advisoryId?: string;
      affectedRange?: string;
    };
const SOURCE_KINDS = [
  'file-list',
  'file',
  'comparison',
  'dependabot',
  'release',
  'compare',
  'metadata',
  'advisory',
  'malware',
  'install-script',
  'publishTime',
  'deprecation',
  'trust',
  'publisher',
] as const;
export type PacketSource = {
  id: string;
  kind: (typeof SOURCE_KINDS)[number];
  ecosystems: Ecosystem[];
  memberIds: string[];
  status: EvidenceStatus;
  reasons: EvidenceReason[];
  provenance: SourceProvenance;
};
type DisabledContext = { ok: true; status: 'disabled'; dependencies: never[]; reasons: never[] };
export type ReviewPacket = {
  version: 1;
  binding: ReviewBinding;
  baseSha: string;
  contextRevision: PacketRevision;
  coverage: Record<Ecosystem, InventoryCoverage>;
  changes: PacketChange[];
  sources: PacketSource[];
  findings: Finding[];
  relationships: never[];
  context: DisabledContext;
};
export type PacketExpected = {
  binding: ReviewBinding;
  baseSha: string;
  contextRevision: PacketRevision;
  context: DisabledContext;
};
type Field =
  | 'packet'
  | 'expected'
  | 'binding'
  | 'baseSha'
  | 'contextRevision'
  | 'coverage'
  | 'changes'
  | 'sources'
  | 'findings'
  | 'relationships'
  | 'context';
type Category = 'input' | 'identity' | 'duplicate' | 'reference' | 'coverage' | 'budget';
export type PacketResult =
  | { ok: true; packet: DeepReadonly<ReviewPacket> }
  | { ok: false; error: { category: Category; field: Field } };
class PacketError extends Error {
  constructor(
    readonly field: Field,
    readonly category: Category = 'input',
  ) {
    super('invalid packet');
  }
}
function requireValue(
  condition: unknown,
  field: Field,
  category: Category = 'input',
): asserts condition {
  if (!condition) throw new PacketError(field, category);
}

// Copy only own data descriptors: no caller getters or serialization hooks run.
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  field: Field,
) {
  requireValue(value !== null && typeof value === 'object' && !types.isProxy(value), field);
  const proto = Object.getPrototypeOf(value);
  requireValue(proto === Object.prototype || proto === null, field);
  const keys = Reflect.ownKeys(value);
  requireValue(keys.length <= required.length + optional.length, field);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    requireValue(
      typeof key === 'string' && (required.includes(key) || optional.includes(key)),
      field,
    );
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor && 'value' in descriptor && descriptor.enumerable, field);
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  requireValue(
    required.every((key) => Object.hasOwn(result, key)),
    field,
  );
  return result;
}
function array(value: unknown, limit: number, field: Field): unknown[] {
  requireValue(
    value && typeof value === 'object' && !types.isProxy(value) && Array.isArray(value),
    field,
  );
  requireValue(Object.getPrototypeOf(value) === Array.prototype, field);
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  requireValue(Number.isSafeInteger(length) && length >= 0, field);
  requireValue(length <= limit, field, 'budget');
  requireValue(Reflect.ownKeys(value).length === length + 1, field);
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireValue(descriptor && 'value' in descriptor && descriptor.enumerable, field);
    result.push(descriptor.value);
  }
  return result;
}
function text(
  value: unknown,
  field: Field,
  bytes: number = PACKET_LIMITS.identityBytes,
  units: number = bytes,
  multiline = false,
): string {
  requireValue(typeof value === 'string' && value.length > 0, field);
  requireValue(value.length <= units && Buffer.byteLength(value) <= bytes, field, 'budget');
  for (const character of value) {
    const code = character.charCodeAt(0);
    requireValue(!(code >= 0xd800 && code <= 0xdfff && character.length === 1), field);
    const lineBreak = multiline && (code === 10 || code === 13);
    requireValue(lineBreak || (code >= 32 && (code < 127 || code > 159)), field);
  }
  return value;
}
function id(value: unknown, field: Field) {
  return text(value, field, PACKET_LIMITS.identityBytes, PACKET_LIMITS.idCodeUnits);
}
function choice<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  field: Field,
): T[number] {
  requireValue(typeof value === 'string' && choices.includes(value), field);
  return value;
}
function distinct<T>(values: T[], field: Field): T[] {
  requireValue(new Set(values).size === values.length, field, 'duplicate');
  return values;
}
function ids(value: unknown, field: Field) {
  return distinct(
    array(value, PACKET_LIMITS.listEntries, field).map((v) => id(v, field)),
    field,
  );
}
function reasons(value: unknown, field: Field) {
  return distinct(
    array(value, PACKET_LIMITS.listEntries, field).map((v) => choice(v, REASONS, field)),
    field,
  );
}
function positive(value: unknown, field: Field): number {
  requireValue(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    field,
    'identity',
  );
  return value;
}
function sha(value: unknown, field: Field) {
  requireValue(
    typeof value === 'string' && value.length === 40 && /^[a-f\d]{40}$/iu.test(value),
    field,
    'identity',
  );
  return value.toLowerCase();
}
function path(value: unknown, field: Field, root = false) {
  const result = text(value, field);
  requireValue(
    !result.includes('\\') &&
      !/^[a-z]:/iu.test(result) &&
      ((root && result === '.') || result.split('/').every((s) => s && s !== '.' && s !== '..')),
    field,
  );
  return result;
}
function repository(value: unknown, field: Field): RepositoryIdentity {
  const r = object(value, ['id', 'owner', 'name'], [], field);
  const owner = text(r.owner, field),
    name = text(r.name, field);
  requireValue(/^[\w.-]+$/u.test(owner) && /^[\w.-]+$/u.test(name), field, 'identity');
  return { id: positive(r.id, field), owner: owner.toLowerCase(), name: name.toLowerCase() };
}
function binding(value: unknown): ReviewBinding {
  const r = object(
    value,
    [
      'repository',
      'workflow',
      'runId',
      'runAttempt',
      'pullNumber',
      'headRepository',
      'headSha',
      'actorId',
      'conclusion',
      'identity',
    ],
    [],
    'binding',
  );
  const workflow = object(r.workflow, ['id', 'path'], [], 'binding');
  const tuple = array(r.identity, 6, 'binding');
  requireValue(tuple.length === 6, 'binding', 'identity');
  const copy = {
    repository: repository(r.repository, 'binding'),
    workflow: { id: positive(workflow.id, 'binding'), path: path(workflow.path, 'binding') },
    runId: positive(r.runId, 'binding'),
    runAttempt: positive(r.runAttempt, 'binding'),
    pullNumber: positive(r.pullNumber, 'binding'),
    actorId: positive(r.actorId, 'binding'),
    headRepository: repository(r.headRepository, 'binding'),
    headSha: sha(r.headSha, 'binding'),
    conclusion: text(r.conclusion, 'binding'),
    identity: [...tuple.slice(0, 5).map((v) => positive(v, 'binding')), sha(tuple[5], 'binding')],
  };
  const parsed = parseReviewBinding(copy);
  requireValue(parsed, 'binding', 'identity');
  return parsed;
}
function revision(value: unknown): PacketRevision {
  const r = object(value, ['repository', 'sha'], [], 'contextRevision');
  return {
    repository: repository(r.repository, 'contextRevision'),
    sha: sha(r.sha, 'contextRevision'),
  };
}
function context(value: unknown): DisabledContext {
  const r = object(value, ['ok', 'status', 'dependencies', 'reasons'], [], 'context');
  requireValue(r.ok === true && r.status === 'disabled', 'context');
  array(r.dependencies, 0, 'context');
  array(r.reasons, 0, 'context');
  return { ok: true, status: 'disabled', dependencies: [], reasons: [] };
}
function expected(value: unknown): PacketExpected {
  const r = object(value, ['binding', 'baseSha', 'contextRevision', 'context'], [], 'expected');
  return {
    binding: binding(r.binding),
    baseSha: sha(r.baseSha, 'baseSha'),
    contextRevision: revision(r.contextRevision),
    context: context(r.context),
  };
}
function url(value: unknown, field: Field) {
  const result = text(value, field),
    parsed = new URL(result);
  requireValue(
    parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password,
    field,
  );
  for (const key of parsed.searchParams.keys())
    requireValue(!/token|secret|password|credential|api.?key|authorization/iu.test(key), field);
  return result;
}
function bool(value: unknown, field: Field): boolean {
  requireValue(typeof value === 'boolean', field);
  return value;
}
function nullableText(value: unknown, field: Field) {
  return value === null ? null : text(value, field);
}
function ecosystemList(value: unknown) {
  const result = distinct(
    array(value, 3, 'sources').map((v) => choice(v, ECOSYSTEMS, 'sources')),
    'sources',
  );
  requireValue(result.length > 0, 'sources');
  return result;
}
function provenance(value: unknown, e: PacketExpected): SourceProvenance {
  const tag = object(
    value,
    ['kind'],
    [
      'repository',
      'baseSha',
      'headSha',
      'absentEcosystems',
      'revision',
      'sha',
      'path',
      'url',
      'title',
      'excerpt',
      'excerptTruncated',
      'subjects',
      'range',
      'advisoryId',
      'affectedRange',
    ],
    'sources',
  );
  if (tag.kind === 'unavailable') {
    object(value, ['kind'], [], 'sources');
    return { kind: 'unavailable' };
  }
  if (tag.kind === 'inventory') {
    const r = object(
      value,
      ['kind', 'repository', 'baseSha', 'headSha', 'absentEcosystems'],
      [],
      'sources',
    );
    const repo = repository(r.repository, 'sources');
    requireValue(
      isDeepStrictEqual(repo, e.binding.repository) &&
        sha(r.baseSha, 'sources') === e.baseSha &&
        sha(r.headSha, 'sources') === e.binding.headSha,
      'sources',
      'identity',
    );
    const absent = distinct(
      array(r.absentEcosystems, 3, 'sources').map((v) => choice(v, ECOSYSTEMS, 'sources')),
      'sources',
    );
    return {
      kind: 'inventory',
      repository: repo,
      baseSha: e.baseSha,
      headSha: e.binding.headSha,
      absentEcosystems: absent,
    };
  }
  if (tag.kind === 'file') {
    const r = object(value, ['kind', 'revision', 'repository', 'sha', 'path'], [], 'sources');
    const side = choice(r.revision, ['base', 'head', 'context'], 'sources');
    const repo = repository(r.repository, 'sources'),
      commit = sha(r.sha, 'sources');
    const expectedRepo =
      side === 'head'
        ? e.binding.headRepository
        : side === 'base'
          ? e.binding.repository
          : e.contextRevision.repository;
    const expectedSha =
      side === 'head' ? e.binding.headSha : side === 'base' ? e.baseSha : e.contextRevision.sha;
    requireValue(
      isDeepStrictEqual(repo, expectedRepo) && commit === expectedSha,
      'sources',
      'identity',
    );
    return {
      kind: 'file',
      revision: side,
      repository: repo,
      sha: commit,
      path: path(r.path, 'sources'),
    };
  }
  requireValue(tag.kind === 'upstream', 'sources');
  const r = object(
    value,
    ['kind', 'url', 'title', 'excerpt', 'excerptTruncated', 'subjects', 'range'],
    ['advisoryId', 'affectedRange'],
    'sources',
  );
  const subjects = array(r.subjects, PACKET_LIMITS.listEntries, 'sources').map((v) => {
    const t = object(v, ['memberId', 'side', 'value'], [], 'sources');
    return {
      memberId: id(t.memberId, 'sources'),
      side: choice(t.side, ['base', 'head'], 'sources'),
      value: text(t.value, 'sources'),
    };
  });
  requireValue(subjects.length > 0, 'sources');
  distinct(
    subjects.map((v) => JSON.stringify([v.memberId, v.side])),
    'sources',
  );
  let range = null;
  if (r.range !== null) {
    const t = object(r.range, ['from', 'to'], [], 'sources');
    range = { from: nullableText(t.from, 'sources'), to: nullableText(t.to, 'sources') };
    requireValue(range.from !== null || range.to !== null, 'sources');
  }
  return {
    kind: 'upstream',
    url: url(r.url, 'sources'),
    title: text(r.title, 'sources', PACKET_LIMITS.textBytes),
    excerpt: text(r.excerpt, 'sources', PACKET_LIMITS.textBytes, PACKET_LIMITS.textBytes, true),
    excerptTruncated: bool(r.excerptTruncated, 'sources'),
    subjects,
    range,
    ...(r.advisoryId !== undefined ? { advisoryId: id(r.advisoryId, 'sources') } : {}),
    ...(r.affectedRange !== undefined ? { affectedRange: text(r.affectedRange, 'sources') } : {}),
  };
}
function source(value: unknown, e: PacketExpected): PacketSource {
  const r = object(
    value,
    ['id', 'kind', 'ecosystems', 'memberIds', 'status', 'reasons', 'provenance'],
    [],
    'sources',
  );
  const kind = choice(r.kind, SOURCE_KINDS, 'sources');
  const status = choice(r.status, ['available', 'partial', 'unavailable'], 'sources');
  const limits = reasons(r.reasons, 'sources'),
    scopes = ecosystemList(r.ecosystems),
    p = provenance(r.provenance, e);
  requireValue((status === 'available') === (limits.length === 0), 'sources', 'coverage');
  requireValue(p.kind !== 'unavailable' || status === 'unavailable', 'sources', 'coverage');
  requireValue((kind === 'file-list') === (p.kind === 'inventory'), 'sources');
  if (kind === 'file') requireValue(p.kind === 'file' || p.kind === 'unavailable', 'sources');
  else if (kind !== 'file-list')
    requireValue(p.kind === 'upstream' || p.kind === 'unavailable', 'sources');
  if (p.kind === 'inventory')
    requireValue(
      p.absentEcosystems.every((v) => scopes.includes(v)) &&
        (status === 'available' || p.absentEcosystems.length === 0),
      'sources',
      'coverage',
    );
  const members = ids(r.memberIds, 'sources');
  if (p.kind === 'inventory') requireValue(members.length === 0, 'sources', 'reference');
  if (p.kind === 'upstream') {
    requireValue(
      members.length > 0 &&
        p.subjects.every((v) => members.includes(v.memberId)) &&
        members.every((v) => p.subjects.some((t) => t.memberId === v)),
      'sources',
      'reference',
    );
    if (kind === 'advisory') requireValue(p.advisoryId, 'sources', 'reference');
  }
  return {
    id: id(r.id, 'sources'),
    kind,
    ecosystems: scopes,
    memberIds: members,
    status,
    reasons: limits,
    provenance: p,
  };
}
function packageSource(value: unknown): PackageSource {
  const r = object(value, ['kind', 'identity'], [], 'changes');
  const kind = choice(r.kind, ['registry', 'git', 'url', 'path', 'workspace'], 'changes');
  const identity =
    kind === 'registry' || kind === 'url' || kind === 'git'
      ? url(r.identity, 'changes')
      : path(r.identity, 'changes', true);
  return { kind, identity };
}
function npmSide(value: unknown): NpmSide {
  const r = object(
    value,
    ['root', 'name', 'lockPath', 'version', 'source', 'sourceId'],
    [],
    'changes',
  );
  return {
    root: path(r.root, 'changes', true),
    name: id(r.name, 'changes'),
    lockPath: r.lockPath === null ? null : path(r.lockPath, 'changes'),
    version: text(r.version, 'changes'),
    source: packageSource(r.source),
    sourceId: id(r.sourceId, 'changes'),
  };
}
const REQUIRED_EVIDENCE = ['upstream', 'vulnerability', 'malware'] as const;
const OPTIONAL_SIGNALS = ['publishTime', 'deprecation', 'trust', 'publisher'] as const;
function evidence(value: unknown, ecosystem: Ecosystem): Record<string, ChangeEvidence> {
  const required =
    ecosystem === 'npm' ? [...REQUIRED_EVIDENCE, 'installScript'] : [...REQUIRED_EVIDENCE];
  const r = object(value, required, OPTIONAL_SIGNALS, 'changes');
  return Object.fromEntries(
    Object.entries(r).map(([key, value]) => {
      const v = object(value, ['status', 'reasons', 'sourceIds'], [], 'changes');
      const status = choice(v.status, ['available', 'partial', 'unavailable'], 'changes');
      const limits = reasons(v.reasons, 'changes'),
        sourceIds = ids(v.sourceIds, 'changes');
      requireValue((status === 'available') === (limits.length === 0), 'changes', 'coverage');
      requireValue(status !== 'available' || sourceIds.length > 0, 'changes', 'coverage');
      return [key, { status, reasons: limits, sourceIds }];
    }),
  );
}
function actionsSide(value: unknown): ActionsSide {
  const r = object(
    value,
    ['workflow', 'jobId', 'stepIndex', 'action', 'ref', 'refKind', 'sourceId'],
    [],
    'changes',
  );
  const workflow = path(r.workflow, 'changes');
  requireValue(/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(workflow), 'changes');
  const action = path(r.action, 'changes');
  requireValue(action.split('/').length >= 2 && !action.includes('@'), 'changes');
  const stepIndex = r.stepIndex;
  requireValue(
    stepIndex === null ||
      (typeof stepIndex === 'number' && Number.isSafeInteger(stepIndex) && stepIndex >= 0),
    'changes',
  );
  const refKind = choice(r.refKind, ['tag', 'branch', 'sha', 'unknown'], 'changes');
  const ref = text(r.ref, 'changes');
  if (refKind === 'sha') sha(ref, 'changes');
  return {
    workflow,
    jobId: id(r.jobId, 'changes'),
    stepIndex,
    action: id(action, 'changes'),
    ref,
    refKind,
    sourceId: id(r.sourceId, 'changes'),
  };
}
function sortedIds(value: unknown, field: Field) {
  const result = ids(value, field);
  requireValue(isDeepStrictEqual(result, [...result].sort()), field);
  return result;
}
function uvSide(value: unknown): UvSide {
  const r = object(
    value,
    ['root', 'name', 'version', 'source', 'marker', 'extras', 'groups', 'sourceId'],
    [],
    'changes',
  );
  const name = id(r.name, 'changes');
  requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name), 'changes');
  return {
    root: path(r.root, 'changes', true),
    name,
    version: text(r.version, 'changes'),
    source: packageSource(r.source),
    marker: nullableText(r.marker, 'changes'),
    extras: sortedIds(r.extras, 'changes'),
    groups: sortedIds(r.groups, 'changes'),
    sourceId: id(r.sourceId, 'changes'),
  };
}
function changeSides<T extends { sourceId: string }>(
  r: Record<string, unknown>,
  kind: ChangeFacts['kind'],
  parse: (v: unknown) => T,
) {
  const from = r.from === null ? null : parse(r.from),
    to = r.to === null ? null : parse(r.to);
  requireValue(
    (kind === 'addition' && from === null && to !== null) ||
      (kind === 'removal' && from !== null && to === null) ||
      (kind === 'update' && from !== null && to !== null),
    'changes',
  );
  if (from && to) {
    const { sourceId: oldSource, ...oldIdentity } = from;
    const { sourceId: newSource, ...newIdentity } = to;
    requireValue(oldSource && newSource && !isDeepStrictEqual(oldIdentity, newIdentity), 'changes');
  }
  return { from, to };
}
function change(value: unknown): PacketChange {
  const r = object(
    value,
    ['id', 'ecosystem', 'kind', 'from', 'to', 'role', 'evidence'],
    ['directRoles'],
    'changes',
  );
  const ecosystem = choice(r.ecosystem, ECOSYSTEMS, 'changes');
  const facts: ChangeFacts = {
    id: id(r.id, 'changes'),
    kind: choice(r.kind, ['update', 'addition', 'removal'], 'changes'),
    role: choice(r.role, ['direct', 'transitive', 'unknown'], 'changes'),
    evidence: evidence(r.evidence, ecosystem),
  };
  requireValue(ecosystem === 'npm' || !Object.hasOwn(r, 'directRoles'), 'changes');
  if (ecosystem === 'actions')
    return { ...facts, ecosystem, ...changeSides(r, facts.kind, actionsSide) };
  if (ecosystem === 'uv') return { ...facts, ecosystem, ...changeSides(r, facts.kind, uvSide) };
  const result: Extract<PacketChange, { ecosystem: 'npm' }> = {
    ...facts,
    ecosystem,
    ...changeSides(r, facts.kind, npmSide),
  };
  if (r.directRoles !== undefined) {
    requireValue(facts.role === 'direct', 'changes');
    result.directRoles = distinct(
      array(r.directRoles, 4, 'changes').map((v) =>
        choice(v, ['production', 'development', 'peer', 'optional'], 'changes'),
      ),
      'changes',
    );
    requireValue(result.directRoles.length > 0, 'changes');
  }
  return result;
}
function sideValue(side: DependencySide) {
  return 'version' in side ? side.version : side.ref;
}
function instanceKey(c: PacketChange, side: DependencySide) {
  if ('workflow' in side)
    return JSON.stringify([c.ecosystem, side.workflow, side.jobId, side.stepIndex]);
  if ('lockPath' in side)
    return JSON.stringify([c.ecosystem, side.root, side.lockPath ?? side.name]);
  return JSON.stringify([
    c.ecosystem,
    side.root,
    side.name,
    side.version,
    side.source,
    side.marker,
    side.extras,
    side.groups,
  ]);
}
function inventoryPaths(side: DependencySide) {
  if ('workflow' in side) return [side.workflow];
  const prefix = side.root === '.' ? '' : side.root + '/';
  if ('lockPath' in side)
    return [prefix + (side.lockPath === null ? 'package.json' : 'package-lock.json')];
  return [prefix + 'uv.lock', prefix + 'pyproject.toml'];
}
function category(s: PacketSource) {
  const categories: Partial<Record<PacketSource['kind'], string>> = {
    release: 'upstream',
    compare: 'upstream',
    metadata: 'upstream',
    advisory: 'vulnerability',
    malware: 'malware',
    'install-script': 'installScript',
    publishTime: 'publishTime',
    deprecation: 'deprecation',
    trust: 'trust',
    publisher: 'publisher',
  };
  return categories[s.kind];
}
function scoped(s: PacketSource, c: PacketChange) {
  requireValue(
    s.ecosystems.includes(c.ecosystem) && s.memberIds.includes(c.id),
    'changes',
    'reference',
  );
}
function linkChanges(changes: PacketChange[], sources: PacketSource[]) {
  distinct(
    changes.map((c) => c.id),
    'changes',
  );
  for (const side of ['from', 'to'] as const)
    distinct(
      changes.flatMap((c) => (c[side] ? [instanceKey(c, c[side])] : [])),
      'changes',
    );
  for (const c of changes) {
    for (const key of ['from', 'to'] as const) {
      const side = c[key];
      if (!side) continue;
      const s = sources.find((s) => s.id === side.sourceId);
      requireValue(s, 'changes', 'reference');
      scoped(s, c);
      const p = s.provenance;
      requireValue(
        s.kind === 'file' &&
          s.status === 'available' &&
          p.kind === 'file' &&
          p.revision === (key === 'from' ? 'base' : 'head'),
        'changes',
        'reference',
      );
      requireValue(inventoryPaths(side).includes(p.path), 'changes', 'reference');
    }
    for (const [key, entry] of Object.entries(c.evidence))
      for (const sourceId of entry.sourceIds) {
        const s = sources.find((s) => s.id === sourceId);
        requireValue(s && category(s) === key, 'changes', 'reference');
        scoped(s, c);
        requireValue(
          entry.status !== 'available' || s.status === 'available',
          'changes',
          'coverage',
        );
      }
  }
  for (const s of sources) {
    for (const memberId of s.memberIds) {
      const c = changes.find((c) => c.id === memberId);
      requireValue(c, 'sources', 'reference');
      requireValue(s.ecosystems.includes(c.ecosystem), 'sources', 'reference');
    }
    if (s.provenance.kind === 'inventory')
      requireValue(
        !changes.some(
          (c) =>
            s.provenance.kind === 'inventory' &&
            s.provenance.absentEcosystems.includes(c.ecosystem),
        ),
        'sources',
        'coverage',
      );
    if (s.provenance.kind !== 'upstream') continue;
    for (const t of s.provenance.subjects) {
      const c = changes.find((c) => c.id === t.memberId);
      requireValue(c, 'sources', 'reference');
      const side = t.side === 'base' ? c.from : c.to;
      requireValue(side && sideValue(side) === t.value, 'sources', 'reference');
      const range = s.provenance.range;
      if (range)
        requireValue(
          (t.side === 'base' ? range.from : range.to) === t.value,
          'sources',
          'reference',
        );
    }
  }
}
const FINDING_FIELDS = ['id', 'memberId', 'references', 'rationale', 'remediation', 'validation'];
function finding(value: unknown): Finding {
  const tag = object(
    value,
    [...FINDING_FIELDS, 'kind'],
    [
      'severity',
      'applicability',
      'affectedRange',
      'change',
      'currentLicense',
      'proposedLicense',
      'publishedAt',
      'deprecated',
      'detail',
    ],
    'findings',
  );
  const kind = choice(
    tag.kind,
    [
      'vulnerability',
      'malware',
      'incompatibleMigration',
      'applicableCodemod',
      'compatibilityUncertainty',
      'supplyChainChange',
      'licenseChange',
      'releaseMetadata',
      'informational',
    ],
    'findings',
  );
  const fields: Record<typeof kind, string[]> = {
    vulnerability: ['severity', 'applicability', 'affectedRange'],
    malware: ['applicability', 'affectedRange'],
    incompatibleMigration: [],
    applicableCodemod: [],
    compatibilityUncertainty: ['change'],
    supplyChainChange: ['change'],
    licenseChange: ['currentLicense', 'proposedLicense'],
    releaseMetadata: ['publishedAt', 'deprecated'],
    informational: ['detail'],
  };
  const r = object(value, [...FINDING_FIELDS, 'kind'], fields[kind], 'findings');
  const refs = ids(r.references, 'findings');
  requireValue(refs.length > 0, 'findings', 'reference');
  const actions = (v: unknown) =>
    array(v, PACKET_LIMITS.listEntries, 'findings').map((t) =>
      text(t, 'findings', PACKET_LIMITS.textBytes),
    );
  const base = {
    id: id(r.id, 'findings'),
    memberId: id(r.memberId, 'findings'),
    references: refs,
    rationale: text(r.rationale, 'findings', PACKET_LIMITS.textBytes),
    remediation: actions(r.remediation),
    validation: actions(r.validation),
  };
  switch (kind) {
    case 'vulnerability':
    case 'malware': {
      const applicability = choice(
        r.applicability,
        ['affects_proposed', 'resolved_by_proposed', 'unaffected', 'withdrawn'],
        'findings',
      );
      const range =
        r.affectedRange !== undefined ? { affectedRange: text(r.affectedRange, 'findings') } : {};
      if (kind === 'malware') return { ...base, kind, applicability, ...range };
      return {
        ...base,
        kind,
        applicability,
        ...range,
        ...(r.severity !== undefined
          ? { severity: choice(r.severity, ['critical', 'high', 'moderate', 'low'], 'findings') }
          : {}),
      };
    }
    case 'incompatibleMigration':
    case 'applicableCodemod':
      return { ...base, kind };
    case 'compatibilityUncertainty':
      return {
        ...base,
        kind,
        change: choice(
          r.change,
          ['raised_runtime_floor', 'tightened_peer_range', 'deprecated_workflow_input'],
          'findings',
        ),
      };
    case 'supplyChainChange':
      return {
        ...base,
        kind,
        change: choice(
          r.change,
          [
            'install_script',
            'package_source',
            'publisher',
            'trust_downgrade',
            'action_identity',
            'mutable_action_ref',
          ],
          'findings',
        ),
      };
    case 'licenseChange':
      return {
        ...base,
        kind,
        currentLicense: text(r.currentLicense, 'findings'),
        proposedLicense: text(r.proposedLicense, 'findings'),
      };
    case 'releaseMetadata': {
      requireValue(Object.hasOwn(r, 'publishedAt') || Object.hasOwn(r, 'deprecated'), 'findings');
      let publishedAt: number | undefined;
      let deprecated: Extract<Finding, { kind: 'releaseMetadata' }>['deprecated'];
      if (r.publishedAt !== undefined) {
        requireValue(
          typeof r.publishedAt === 'number' &&
            Number.isSafeInteger(r.publishedAt) &&
            r.publishedAt >= 0 &&
            Number.isFinite(new Date(r.publishedAt).getTime()),
          'findings',
        );
        publishedAt = r.publishedAt;
      }
      if (r.deprecated !== undefined) {
        const d = object(r.deprecated, ['marker'], ['reason'], 'findings');
        deprecated = {
          marker: choice(d.marker, ['deprecated', 'yanked'], 'findings'),
          ...(d.reason !== undefined
            ? { reason: text(d.reason, 'findings', PACKET_LIMITS.textBytes) }
            : {}),
        };
      }
      return {
        ...base,
        kind,
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        ...(deprecated !== undefined ? { deprecated } : {}),
      };
    }
    case 'informational':
      return { ...base, kind, detail: text(r.detail, 'findings', PACKET_LIMITS.textBytes) };
  }
}
function findingSourceKinds(f: Finding): readonly PacketSource['kind'][] {
  switch (f.kind) {
    case 'vulnerability':
      return ['advisory'];
    case 'malware':
      return ['malware'];
    case 'incompatibleMigration':
      return ['release', 'compare', 'metadata', 'file'];
    case 'applicableCodemod':
    case 'compatibilityUncertainty':
      return ['release', 'compare', 'metadata'];
    case 'licenseChange':
      return ['metadata', 'release', 'compare'];
    case 'releaseMetadata':
      return ['publishTime', 'deprecation'];
    case 'supplyChainChange': {
      const kinds: Record<typeof f.change, readonly PacketSource['kind'][]> = {
        install_script: ['install-script'],
        package_source: ['file', 'metadata'],
        publisher: ['publisher'],
        trust_downgrade: ['trust'],
        action_identity: ['file'],
        mutable_action_ref: ['file'],
      };
      return kinds[f.change];
    }
    case 'informational':
      return ['file', 'release', 'compare', 'metadata', 'advisory', 'malware', ...OPTIONAL_SIGNALS];
  }
}
function linkFindings(findings: Finding[], changes: PacketChange[], sources: PacketSource[]) {
  distinct(
    findings.map((f) => f.id),
    'findings',
  );
  const claims = new Map<string, string>();
  for (const f of findings) {
    const c = changes.find((c) => c.id === f.memberId);
    requireValue(c, 'findings', 'reference');
    const linked = f.references.map((ref) => {
      const s = sources.find((s) => s.id === ref);
      requireValue(
        s &&
          s.ecosystems.includes(c.ecosystem) &&
          s.memberIds.includes(c.id) &&
          findingSourceKinds(f).includes(s.kind) &&
          s.status !== 'unavailable',
        'findings',
        'reference',
      );
      requireValue(
        s.provenance.kind === 'file' ||
          (s.provenance.kind === 'upstream' &&
            s.provenance.range !== null &&
            s.provenance.subjects.some((t) => t.memberId === c.id)),
        'findings',
        'reference',
      );
      if (
        (f.kind === 'vulnerability' || f.kind === 'malware') &&
        s.provenance.kind === 'upstream'
      ) {
        if (f.affectedRange !== undefined)
          requireValue(f.affectedRange === s.provenance.affectedRange, 'findings', 'reference');
        for (const t of s.provenance.subjects.filter((t) => t.memberId === c.id)) {
          const claim = JSON.stringify([
            f.kind,
            s.provenance.advisoryId ?? s.provenance.url,
            c.id,
            t.side,
          ]);
          requireValue(
            !claims.has(claim) || claims.get(claim) === f.applicability,
            'findings',
            'reference',
          );
          claims.set(claim, f.applicability);
        }
      }
      return s;
    });
    if (f.kind === 'incompatibleMigration')
      requireValue(
        linked.some(
          (s) =>
            s.kind === 'file' &&
            s.provenance.kind === 'file' &&
            s.provenance.revision === 'context',
        ) && linked.some((s) => category(s) === 'upstream'),
        'findings',
        'reference',
      );
    if (f.kind === 'releaseMetadata') {
      if (f.publishedAt !== undefined)
        requireValue(
          linked.some((s) => s.kind === 'publishTime'),
          'findings',
          'reference',
        );
      if (f.deprecated !== undefined)
        requireValue(
          linked.some((s) => s.kind === 'deprecation'),
          'findings',
          'reference',
        );
    }
  }
}
function coverage(
  value: unknown,
  sources: PacketSource[],
  changes: PacketChange[],
): Record<Ecosystem, InventoryCoverage> {
  const c = object(value, ECOSYSTEMS, [], 'coverage');
  const entries = ECOSYSTEMS.map((ecosystem) => {
    const r = object(c[ecosystem], ['status', 'reasons', 'sourceIds'], [], 'coverage');
    const status = choice(
      r.status,
      ['complete', 'partial', 'unavailable', 'not_applicable'],
      'coverage',
    );
    const limits = reasons(r.reasons, 'coverage'),
      sourceIds = ids(r.sourceIds, 'coverage');
    const linked = sourceIds.map((sourceId) => {
      const s = sources.find((s) => s.id === sourceId);
      requireValue(s && s.ecosystems.includes(ecosystem), 'coverage', 'reference');
      return s;
    });
    if (status === 'complete' || status === 'not_applicable') {
      requireValue(
        limits.length === 0 && linked.length > 0 && linked.every((s) => s.status === 'available'),
        'coverage',
        'coverage',
      );
      if (status === 'not_applicable')
        requireValue(
          linked.some(
            (s) =>
              s.provenance.kind === 'inventory' &&
              s.provenance.absentEcosystems.includes(ecosystem),
          ),
          'coverage',
          'coverage',
        );
      requireValue(
        linked.every(
          (s) =>
            s.kind === 'file-list' ||
            (s.kind === 'file' &&
              s.provenance.kind === 'file' &&
              s.provenance.revision !== 'context'),
        ),
        'coverage',
        'coverage',
      );
      if (status === 'not_applicable')
        requireValue(!changes.some((c) => c.ecosystem === ecosystem), 'coverage', 'coverage');
    } else requireValue(limits.length > 0, 'coverage', 'coverage');
    return [ecosystem, { status, reasons: limits, sourceIds }] as const;
  });
  return Object.fromEntries(entries) as Record<Ecosystem, InventoryCoverage>;
}
function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Pure validation; expected snapshots come from trusted T1/C2 orchestration, never the packet. */
export function validateReviewPacket(candidate: unknown, trusted: unknown): PacketResult {
  try {
    const r = object(
      candidate,
      [
        'version',
        'binding',
        'baseSha',
        'contextRevision',
        'coverage',
        'changes',
        'sources',
        'findings',
        'relationships',
        'context',
      ],
      [],
      'packet',
    );
    requireValue(r.version === 1, 'packet');
    const e = expected(trusted);
    const b = binding(r.binding),
      baseSha = sha(r.baseSha, 'baseSha'),
      ctxRevision = revision(r.contextRevision);
    requireValue(isDeepStrictEqual(b, e.binding), 'binding', 'identity');
    requireValue(baseSha === e.baseSha, 'baseSha', 'identity');
    requireValue(isDeepStrictEqual(ctxRevision, e.contextRevision), 'contextRevision', 'identity');
    const ctx = context(r.context);
    requireValue(isDeepStrictEqual(ctx, e.context), 'context', 'identity');
    const changes = array(r.changes, PACKET_LIMITS.changes, 'changes').map(change);
    const findings = array(r.findings, PACKET_LIMITS.findings, 'findings').map(finding);
    array(r.relationships, 0, 'relationships');
    const sources = array(r.sources, PACKET_LIMITS.sources, 'sources').map((v) => source(v, e));
    distinct(
      sources.map((s) => s.id),
      'sources',
    );
    linkChanges(changes, sources);
    linkFindings(findings, changes, sources);
    const packet: ReviewPacket = {
      version: 1,
      binding: b,
      baseSha,
      contextRevision: ctxRevision,
      coverage: coverage(r.coverage, sources, changes),
      changes,
      sources,
      findings,
      relationships: [],
      context: ctx,
    };
    requireValue(
      Buffer.byteLength(JSON.stringify(packet)) <= PACKET_LIMITS.bytes,
      'packet',
      'budget',
    );
    return { ok: true, packet: freeze(packet) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof PacketError
          ? { category: error.category, field: error.field }
          : { category: 'input', field: 'packet' },
    };
  }
}
