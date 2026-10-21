import { isDeepStrictEqual, types } from 'node:util';
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
export type PacketSource = {
  id: string;
  kind: 'file-list';
  ecosystems: Ecosystem[];
  memberIds: string[];
  status: EvidenceStatus;
  reasons: EvidenceReason[];
  provenance: {
    kind: 'inventory';
    repository: RepositoryIdentity;
    baseSha: string;
    headSha: string;
    absentEcosystems: Ecosystem[];
  };
};
type DisabledContext = { ok: true; status: 'disabled'; dependencies: never[]; reasons: never[] };
export type ReviewPacket = {
  version: 1;
  binding: ReviewBinding;
  baseSha: string;
  contextRevision: PacketRevision;
  coverage: Record<Ecosystem, InventoryCoverage>;
  changes: never[];
  sources: PacketSource[];
  findings: never[];
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
function source(value: unknown, e: PacketExpected): PacketSource {
  const r = object(
    value,
    ['id', 'kind', 'ecosystems', 'memberIds', 'status', 'reasons', 'provenance'],
    [],
    'sources',
  );
  requireValue(r.kind === 'file-list', 'sources');
  const p = object(
    r.provenance,
    ['kind', 'repository', 'baseSha', 'headSha', 'absentEcosystems'],
    [],
    'sources',
  );
  requireValue(p.kind === 'inventory', 'sources');
  const repo = repository(p.repository, 'sources');
  requireValue(
    isDeepStrictEqual(repo, e.binding.repository) &&
      sha(p.baseSha, 'sources') === e.baseSha &&
      sha(p.headSha, 'sources') === e.binding.headSha,
    'sources',
    'identity',
  );
  const status = choice(r.status, ['available', 'partial', 'unavailable'], 'sources');
  const limits = reasons(r.reasons, 'sources');
  requireValue((status === 'available') === (limits.length === 0), 'sources', 'coverage');
  const scopes = distinct(
    array(r.ecosystems, 3, 'sources').map((v) => choice(v, ECOSYSTEMS, 'sources')),
    'sources',
  );
  requireValue(scopes.length > 0, 'sources');
  const absent = distinct(
    array(p.absentEcosystems, 3, 'sources').map((v) => choice(v, ECOSYSTEMS, 'sources')),
    'sources',
  );
  requireValue(
    absent.every((v) => scopes.includes(v)) && (status === 'available' || absent.length === 0),
    'sources',
    'coverage',
  );
  requireValue(ids(r.memberIds, 'sources').length === 0, 'sources', 'reference');
  return {
    id: id(r.id, 'sources'),
    kind: 'file-list',
    ecosystems: scopes,
    memberIds: [],
    status,
    reasons: limits,
    provenance: {
      kind: 'inventory',
      repository: repo,
      baseSha: e.baseSha,
      headSha: e.binding.headSha,
      absentEcosystems: absent,
    },
  };
}
function coverage(value: unknown, sources: PacketSource[]): Record<Ecosystem, InventoryCoverage> {
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
          linked.some((s) => s.provenance.absentEcosystems.includes(ecosystem)),
          'coverage',
          'coverage',
        );
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
    array(r.changes, 0, 'changes');
    array(r.findings, 0, 'findings');
    array(r.relationships, 0, 'relationships');
    const sources = array(r.sources, PACKET_LIMITS.sources, 'sources').map((v) => source(v, e));
    distinct(
      sources.map((s) => s.id),
      'sources',
    );
    const packet: ReviewPacket = {
      version: 1,
      binding: b,
      baseSha,
      contextRevision: ctxRevision,
      coverage: coverage(r.coverage, sources),
      changes: [],
      sources,
      findings: [],
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
