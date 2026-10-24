import { expect, test, vi } from 'vite-plus/test';
import { PACKET_LIMITS, validateReviewPacket } from './schema.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TRUSTED = 'c'.repeat(40);
const repository = { id: 101, owner: 'example', name: 'consumer' };
const ecosystems = ['npm', 'actions', 'uv'] as const;
function sparseArray(length: number) {
  const value: unknown[] = [];
  value.length = length;
  return value;
}

function fixture() {
  const binding = {
    repository: { ...repository },
    workflow: { id: 301, path: '.github/workflows/ci.yml' },
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headRepository: { ...repository },
    headSha: HEAD,
    baseRef: 'main',
    baseSha: BASE,
    mergeBaseSha: BASE,
    actorId: 201,
    conclusion: 'success',
    identity: [101, 301, 401, 1, 42, HEAD],
  };
  const contextRevision = { repository: { ...repository }, sha: TRUSTED };
  const context = { ok: true, status: 'disabled', dependencies: [], reasons: [] };
  const packet = {
    version: 1,
    binding,
    baseSha: BASE,
    contextRevision,
    context,
    coverage: Object.fromEntries(
      ecosystems.map((ecosystem) => [
        ecosystem,
        { status: 'not_applicable', reasons: [] as string[], sourceIds: ['inventory'] },
      ]),
    ),
    changes: [],
    findings: [],
    relationships: [],
    sources: [
      {
        id: 'inventory',
        kind: 'file-list',
        ecosystems: [...ecosystems],
        memberIds: [] as string[],
        status: 'available',
        reasons: [],
        provenance: {
          kind: 'inventory',
          repository: { ...repository },
          baseSha: BASE,
          headSha: HEAD,
          absentEcosystems: [...ecosystems],
        },
      },
    ],
  };
  const expected = structuredClone({ binding, baseSha: BASE, contextRevision, context });
  return { packet, expected };
}

function accepted(input: { packet: unknown; expected: unknown } = fixture()) {
  const result = validateReviewPacket(input.packet, input.expected);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected valid packet');
  return result.packet;
}

test('accepts a self-describing immutable zero-change packet', () => {
  const f = fixture();
  const result = accepted(f);
  expect(result).toEqual(f.packet);
  expect(result).not.toBe(f.packet);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.binding.repository)).toBe(true);
  f.packet.sources[0].provenance.absentEcosystems.pop();
  expect(result.sources[0].provenance).toMatchObject({ absentEcosystems: ecosystems });
});

test.each(['runAttempt', 'actorId', 'pullNumber', 'runId'] as const)(
  'rejects mismatched binding %s even with an unchanged tuple',
  (field) => {
    const f = fixture();
    f.packet.binding[field] += 1;
    expect(validateReviewPacket(f.packet, f.expected)).toEqual({
      ok: false,
      error: { category: 'identity', field: 'binding' },
    });
  },
);

test('rejects a base or trusted-context mismatch', () => {
  for (const field of ['baseSha', 'contextRevision'] as const) {
    const f = fixture();
    if (field === 'baseSha') f.packet.baseSha = HEAD;
    else f.packet.contextRevision.sha = HEAD;
    expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
  }
});

test('requires all three evidence-backed coverage slots', () => {
  const f = fixture();
  delete f.packet.coverage.actions;
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
  const g = fixture();
  g.packet.sources[0].provenance.absentEcosystems = ['npm', 'uv'];
  expect(validateReviewPacket(g.packet, g.expected)).toMatchObject({
    ok: false,
    error: { category: 'coverage', field: 'coverage' },
  });
});

test('retains an unavailable zero-member ecosystem without inventing changes', () => {
  const f = fixture();
  f.packet.coverage.actions = { status: 'unavailable', reasons: ['permission'], sourceIds: [] };
  expect(accepted(f).coverage.actions.status).toBe('unavailable');
});

test('rejects a getter without invoking it', () => {
  const f = fixture();
  const getter = vi.fn(() => 1);
  Object.defineProperty(f.packet, 'version', { get: getter, enumerable: true });
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
  expect(getter).not.toHaveBeenCalled();
});

test('rejects unknown fields, hooks, and malformed trusted expectations', () => {
  const f = fixture();
  const hook = vi.fn();
  expect(validateReviewPacket({ ...f.packet, toJSON: hook }, f.expected)).toMatchObject({
    ok: false,
  });
  expect(validateReviewPacket(f.packet, {})).toMatchObject({ ok: false });
  expect(hook).not.toHaveBeenCalled();
});

function npmFixture(count = 1) {
  const f = fixture();
  f.packet.sources[0].provenance.absentEcosystems = ['actions', 'uv'];
  f.packet.coverage.npm.status = 'complete';
  const changes = Array.from({ length: count }, (_, index) => {
    const name = `example-${index}`;
    const memberId = `npm:${index}`;
    const side = (version: string, sourceId: string) => ({
      root: '.',
      name,
      lockPath: `node_modules/${name}`,
      version,
      source: { kind: 'registry', identity: 'https://registry.npmjs.org' },
      sourceId,
    });
    return {
      id: memberId,
      ecosystem: 'npm',
      kind: 'update',
      from: side('1.0.0', index < 32 ? 'base-lock' : `base-lock:${Math.floor(index / 32)}`),
      to: side('2.0.0', index < 32 ? 'head-lock' : `head-lock:${Math.floor(index / 32)}`),
      role: 'direct',
      evidence: Object.fromEntries(
        ['upstream', 'vulnerability', 'malware', 'installScript'].map((category) => [
          category,
          { status: 'unavailable', reasons: ['missing'], sourceIds: [] as string[] },
        ]),
      ),
    };
  });
  const fileSource = (side: 'base' | 'head', start: number) => ({
    id: start === 0 ? `${side}-lock` : `${side}-lock:${start / 32}`,
    kind: 'file',
    ecosystems: ['npm'],
    memberIds: changes.slice(start, start + 32).map((c) => c.id),
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'file',
      revision: side,
      repository: { ...repository },
      sha: side === 'base' ? BASE : HEAD,
      path: 'package-lock.json',
    },
  });
  const sources = [
    ...f.packet.sources,
    ...Array.from({ length: Math.ceil(count / 32) }, (_, i) => [
      fileSource('base', i * 32),
      fileSource('head', i * 32),
    ]).flat(),
  ];
  const packet = { ...f.packet, changes, sources };
  return { ...f, packet, changes, sources };
}

test('preserves npm inventory and explicit required gaps', () => {
  const f = npmFixture();
  const result = accepted(f);
  expect(result.changes).toEqual(f.changes);
  expect(result.changes[0].evidence.malware.status).toBe('unavailable');
});

test('retains twenty unpaired additions without fabricating updates', () => {
  const f = npmFixture(20);
  const changes = f.changes.map((c) => ({ ...c, kind: 'addition', from: null }));
  const result = accepted({ ...f, packet: { ...f.packet, changes } });
  expect(result.changes).toHaveLength(20);
  expect(result.changes.every((c) => c.kind === 'addition' && c.from === null)).toBe(true);
});

test('rejects duplicate npm instances even with different change IDs', () => {
  const f = npmFixture();
  const duplicate = { ...f.changes[0], id: 'different-id' };
  expect(
    validateReviewPacket({ ...f.packet, changes: [...f.changes, duplicate] }, f.expected),
  ).toMatchObject({ ok: false, error: { category: 'duplicate', field: 'changes' } });
});

test('accepts identical npm names in different roots and lock locations', () => {
  const f = npmFixture(2);
  f.changes[1].from.name = f.changes[0].from.name;
  f.changes[1].to.name = f.changes[0].to.name;
  expect(accepted(f).changes).toHaveLength(2);
});

test('rejects a wrong-side inventory source', () => {
  const f = npmFixture();
  f.changes[0].to.sourceId = 'base-lock';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
    ok: false,
    error: { category: 'reference', field: 'changes' },
  });
});

test('rejects omitted evidence categories and inconsistent change sides', () => {
  const f = npmFixture();
  delete f.changes[0].evidence.malware;
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
  const g = npmFixture();
  g.changes[0].kind = 'addition';
  expect(validateReviewPacket(g.packet, g.expected)).toMatchObject({ ok: false });
});

function upstreamSource(memberId = 'npm:0') {
  return {
    id: 'upstream',
    kind: 'release',
    ecosystems: ['npm'],
    memberIds: [memberId],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'upstream',
      url: 'https://example.com/releases/2.0.0',
      title: 'Version two',
      excerpt: 'Changes.',
      excerptTruncated: false,
      subjects: [{ memberId, side: 'head', value: '2.0.0' }],
      range: { from: null, to: '2.0.0' },
    },
  };
}

test('validates source IDs, upstream range and exact member-version scope', () => {
  const f = npmFixture();
  const source = upstreamSource();
  f.changes[0].evidence.upstream = { status: 'available', reasons: [], sourceIds: ['upstream'] };
  const packet = { ...f.packet, sources: [...f.sources, source] };
  expect(accepted({ ...f, packet }).sources).toHaveLength(4);
  source.provenance.subjects[0].value = '3.0.0';
  expect(validateReviewPacket(packet, f.expected)).toMatchObject({ ok: false });
});

test.each([
  'http://example.com/release',
  'https://user:password@example.com/release',
  'file:///private/release',
  'https://example.com/?token=synthetic',
])('rejects unsafe source URL %s', (url) => {
  const f = npmFixture();
  const source = upstreamSource();
  source.provenance.url = url;
  expect(
    validateReviewPacket({ ...f.packet, sources: [...f.sources, source] }, f.expected),
  ).toMatchObject({ ok: false });
});

function ecosystemFixture(ecosystem: 'actions' | 'uv') {
  const f = fixture();
  f.packet.sources[0].provenance.absentEcosystems = ecosystems.filter((e) => e !== ecosystem);
  f.packet.coverage[ecosystem].status = 'complete';
  const actionSide = (ref: string, sourceId: string) => ({
    workflow: '.github/workflows/ci.yml',
    jobId: 'test',
    stepIndex: 0,
    action: 'example/setup/nested',
    ref,
    refKind: 'tag',
    sourceId,
  });
  const uvSide = (version: string, sourceId: string) => ({
    root: '.',
    name: 'example-package',
    version,
    source: { kind: 'registry', identity: 'https://pypi.org/simple' },
    marker: "python_version >= '3.12'",
    extras: ['test'],
    groups: [],
    sourceId,
  });
  const from =
    ecosystem === 'actions' ? actionSide('v1', 'base-lock') : uvSide('1.0.0', 'base-lock');
  const to = ecosystem === 'actions' ? actionSide('v2', 'head-lock') : uvSide('2.0.0', 'head-lock');
  const c = {
    id: `${ecosystem}:0`,
    ecosystem,
    kind: 'update',
    from,
    to,
    role: 'direct',
    evidence: Object.fromEntries(
      ['upstream', 'vulnerability', 'malware'].map((k) => [
        k,
        { status: 'unavailable', reasons: ['missing'], sourceIds: [] as string[] },
      ]),
    ),
  };
  const sources = ['base', 'head'].map((side) => ({
    id: `${side}-lock`,
    kind: 'file',
    ecosystems: [ecosystem],
    memberIds: [c.id],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'file',
      revision: side,
      repository: { ...repository },
      sha: side === 'base' ? BASE : HEAD,
      path: ecosystem === 'actions' ? '.github/workflows/ci.yml' : 'uv.lock',
    },
  }));
  return {
    packet: { ...f.packet, changes: [c], sources: [...f.packet.sources, ...sources] },
    expected: f.expected,
    c,
  };
}

test.each(['actions', 'uv'] as const)('preserves distinct %s identities', (ecosystem) => {
  const f = ecosystemFixture(ecosystem);
  expect(accepted(f).changes[0]).toEqual(f.c);
});

test('preserves repeated Actions occurrences without collapsing refs', () => {
  const f = ecosystemFixture('actions');
  const c = {
    ...f.c,
    id: 'actions:1',
    from: { ...f.c.from, stepIndex: 1 },
    to: { ...f.c.to, stepIndex: 1 },
  };
  for (const source of f.packet.sources) source.memberIds.push(c.id);
  f.packet.sources[0].memberIds = [];
  expect(accepted({ ...f, packet: { ...f.packet, changes: [f.c, c] } }).changes).toHaveLength(2);
});

test('accepts job-level reusable workflows and rejects short SHA refs', () => {
  const f = ecosystemFixture('actions');
  const from = { ...f.c.from, stepIndex: null, ref: 'a'.repeat(40), refKind: 'sha' };
  const to = { ...f.c.to, stepIndex: null, ref: 'b'.repeat(40), refKind: 'sha' };
  expect(
    accepted({ ...f, packet: { ...f.packet, changes: [{ ...f.c, from, to }] } }).changes,
  ).toHaveLength(1);
  to.ref = 'short';
  expect(
    validateReviewPacket({ ...f.packet, changes: [{ ...f.c, from, to }] }, f.expected),
  ).toMatchObject({ ok: false });
});

test('preserves uv variants and rejects repeated extras', () => {
  const f = ecosystemFixture('uv');
  const c = {
    ...f.c,
    id: 'uv:1',
    from: { ...f.c.from, marker: "python_version < '3.12'" },
    to: { ...f.c.to, marker: "python_version < '3.12'" },
  };
  for (const source of f.packet.sources) source.memberIds.push(c.id);
  f.packet.sources[0].memberIds = [];
  expect(accepted({ ...f, packet: { ...f.packet, changes: [f.c, c] } }).changes).toHaveLength(2);
  const bad = { ...f.c, to: { ...f.c.to, extras: ['test', 'test'] } };
  expect(validateReviewPacket({ ...f.packet, changes: [bad, c] }, f.expected)).toMatchObject({
    ok: false,
  });
});

test('retains a mixed packet gap even with no retained Actions changes', () => {
  const f = npmFixture();
  f.packet.coverage.actions = { status: 'partial', reasons: ['truncated'], sourceIds: [] };
  expect(accepted(f).coverage.actions).toEqual(f.packet.coverage.actions);
});

function findingFixture() {
  const f = npmFixture();
  const source = {
    ...upstreamSource(),
    id: 'advisory',
    kind: 'advisory',
    provenance: {
      ...upstreamSource().provenance,
      advisoryId: 'GHSA-synthetic',
      affectedRange: '>=2.0.0',
    },
  };
  const finding = {
    id: 'finding',
    memberId: 'npm:0',
    references: ['advisory'],
    rationale: 'Synthetic advisory affects the proposed version.',
    remediation: ['Use a fixed release.'],
    validation: ['Check the resolved version.'],
    kind: 'vulnerability',
    severity: 'high',
    applicability: 'affects_proposed',
    affectedRange: '>=2.0.0',
  };
  f.changes[0].evidence.vulnerability = {
    status: 'available',
    reasons: [],
    sourceIds: ['advisory'],
  };
  return {
    ...f,
    finding,
    source,
    packet: { ...f.packet, sources: [...f.sources, source], findings: [finding] },
  };
}

test('retains a deterministic finding with change-ID and source-ID links', () => {
  const f = findingFixture();
  expect(accepted(f).findings).toEqual([f.finding]);
});

test.each(['https://example.com/advisory', 'head-lock', 'unknown'])(
  'rejects invalid finding reference %s',
  (reference) => {
    const f = findingFixture();
    f.finding.references = [reference];
    expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
      ok: false,
      error: { category: 'reference', field: 'findings' },
    });
  },
);

test('accepts a clean vulnerability lookup but requires advisory identity for findings', () => {
  const f = findingFixture();
  const { advisoryId, ...withoutId } = f.source.provenance;
  expect(advisoryId).toBe('GHSA-synthetic');
  const source = { ...f.source, provenance: withoutId };
  const clean = { ...f.packet, sources: [...f.sources, source], findings: [] };
  expect(accepted({ ...f, packet: clean }).changes[0].evidence.vulnerability.status).toBe(
    'available',
  );
  expect(validateReviewPacket({ ...clean, findings: [f.finding] }, f.expected)).toEqual({
    ok: false,
    error: { category: 'reference', field: 'findings' },
  });
});

test('reports an unparsable source URL against its section', () => {
  const f = npmFixture();
  const source = upstreamSource();
  source.provenance.url = 'https://exa mple.com/release';
  expect(
    validateReviewPacket({ ...f.packet, sources: [...f.sources, source] }, f.expected),
  ).toEqual({ ok: false, error: { category: 'input', field: 'sources' } });
});

test('normalizes Actions SHA refs so a case-only change is not an update', () => {
  const f = ecosystemFixture('actions');
  const from = { ...f.c.from, ref: 'A'.repeat(40), refKind: 'sha' };
  const to = { ...f.c.to, ref: 'a'.repeat(40), refKind: 'sha' };
  expect(
    validateReviewPacket({ ...f.packet, changes: [{ ...f.c, from, to }] }, f.expected),
  ).toMatchObject({ ok: false, error: { field: 'changes' } });
  const head = { ...to, ref: 'B'.repeat(40) };
  const result = accepted({ ...f, packet: { ...f.packet, changes: [{ ...f.c, from, to: head }] } });
  expect(result.changes[0].to).toMatchObject({ ref: 'b'.repeat(40) });
});

test.each(['medium', 'critical-ish', 'HIGH'])('rejects unsupported severity %s', (severity) => {
  const f = findingFixture();
  f.finding.severity = severity;
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
});

test('accepts an unscored advisory without weakening applicability', () => {
  const f = findingFixture();
  const { severity, ...unscored } = f.finding;
  expect(severity).toBe('high');
  expect(
    accepted({ ...f, packet: { ...f.packet, findings: [unscored] } }).findings[0],
  ).not.toHaveProperty('severity');
});

test('rejects conflicting advisory applicability for the same member and side', () => {
  const f = findingFixture();
  const other = { ...f.finding, id: 'other', applicability: 'unaffected' };
  expect(
    validateReviewPacket({ ...f.packet, findings: [f.finding, other] }, f.expected),
  ).toMatchObject({ ok: false });
});

test('rejects finding/member/range mismatches', () => {
  const f = findingFixture();
  f.finding.memberId = 'another-change';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
  const g = findingFixture();
  g.finding.affectedRange = '<1.0.0';
  expect(validateReviewPacket(g.packet, g.expected)).toMatchObject({ ok: false });
});

test('requires trusted-context evidence for verified incompatibility', () => {
  const f = contextFixture();
  const upstream = upstreamSource();
  const finding = {
    id: 'migration',
    memberId: 'npm:0',
    kind: 'incompatibleMigration',
    references: ['upstream'],
    rationale: 'Verified conflict.',
    remediation: [],
    validation: [],
  };
  const sources = [...f.sources, upstream];
  expect(
    validateReviewPacket({ ...f.packet, sources, findings: [finding] }, f.expected),
  ).toMatchObject({ ok: false });
  const contextSource = {
    id: 'trusted-file',
    kind: 'file',
    ecosystems: ['npm'],
    memberIds: ['npm:0'],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'file',
      revision: 'context',
      repository: { ...repository },
      sha: TRUSTED,
      path: 'src/example.ts',
    },
  };
  finding.references.push('trusted-file');
  expect(
    accepted({
      ...f,
      packet: { ...f.packet, sources: [...sources, contextSource], findings: [finding] },
    }).findings,
  ).toHaveLength(1);
});

function relationshipFixture() {
  const f = npmFixture(2);
  const proof = {
    fromId: f.changes[0].id,
    toId: f.changes[1].id,
    ecosystem: 'npm',
    side: 'head',
    sourceId: 'head-lock',
    path: [f.changes[0].to, f.changes[1].to],
  };
  return { ...f, proof, packet: { ...f.packet, relationships: [proof] } };
}

test('retains a structural relationship proof without assigning a group', () => {
  const f = relationshipFixture();
  expect(accepted(f).relationships).toEqual([f.proof]);
});

test('retains a path through an unchanged intermediate instance', () => {
  const f = relationshipFixture();
  f.proof.path.splice(1, 0, {
    ...f.proof.path[0],
    name: 'intermediate',
    lockPath: 'node_modules/intermediate',
  });
  expect(accepted(f).relationships[0].path).toHaveLength(3);
});

test.each(['dangling', 'self', 'wrong-side', 'cycle', 'wrong-source'])(
  'rejects a %s relationship proof',
  (mode) => {
    const f = relationshipFixture();
    if (mode === 'dangling') f.proof.toId = 'missing';
    if (mode === 'self') f.proof.toId = f.proof.fromId;
    if (mode === 'wrong-side') f.proof.side = 'base';
    if (mode === 'cycle') f.proof.path.splice(1, 0, f.proof.path[0]);
    if (mode === 'wrong-source') f.proof.sourceId = 'inventory';
    expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
      ok: false,
      error: { field: 'relationships' },
    });
  },
);

test('rejects a proof step that contradicts a recorded change instance', () => {
  const f = npmFixture(3);
  const proof = {
    fromId: f.changes[0].id,
    toId: f.changes[1].id,
    ecosystem: 'npm',
    side: 'head',
    sourceId: 'head-lock',
    path: [f.changes[0].to, f.changes[2].to, f.changes[1].to],
  };
  expect(accepted({ ...f, packet: { ...f.packet, relationships: [proof] } }).relationships).toEqual(
    [proof],
  );
  proof.path[1] = { ...f.changes[2].to, version: '0.0.1' };
  expect(validateReviewPacket({ ...f.packet, relationships: [proof] }, f.expected)).toEqual({
    ok: false,
    error: { category: 'reference', field: 'relationships' },
  });
});

test('rejects duplicated proofs and cross-root or cross-ecosystem grouping', () => {
  const f = relationshipFixture();
  expect(
    validateReviewPacket({ ...f.packet, relationships: [f.proof, f.proof] }, f.expected),
  ).toMatchObject({ ok: false, error: { category: 'duplicate', field: 'relationships' } });
  const proof = { ...f.proof, ecosystem: 'actions' };
  expect(validateReviewPacket({ ...f.packet, relationships: [proof] }, f.expected)).toMatchObject({
    ok: false,
  });
});

function contextFixture() {
  const f = npmFixture();
  const context = {
    ok: true,
    status: 'available',
    reasons: [] as string[],
    dependencies: [
      {
        id: f.changes[0].id,
        name: f.changes[0].to.name,
        status: 'available',
        reasons: [] as string[],
        facts: [
          {
            kind: 'package-usage',
            path: 'src/example.ts',
            excerpt: "import 'example-0';",
            excerptTruncated: false,
          },
        ],
      },
    ],
  };
  return {
    ...f,
    context,
    packet: { ...f.packet, context },
    expected: { ...f.expected, context: structuredClone(context) },
  };
}

test('preserves only the separately supplied successful C2 result', () => {
  const f = contextFixture();
  expect(accepted(f).context).toEqual(f.context);
  f.context.dependencies[0].facts[0].excerpt = 'forged context';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
    ok: false,
    error: { category: 'identity', field: 'context' },
  });
});

test.each(['unavailable', 'partial'])(
  'retains %s context without claiming source coverage',
  (status) => {
    const f = contextFixture();
    f.context.status = status;
    f.context.reasons = ['missing-source'];
    f.context.dependencies[0].status = status;
    f.context.dependencies[0].reasons = ['missing-source'];
    if (status === 'unavailable') f.context.dependencies[0].facts = [];
    f.expected.context = structuredClone(f.context);
    expect(accepted(f).context.status).toBe(status);
  },
);

test('rejects missing or unknown C2 dependencies and unsuccessful C2 results', () => {
  const f = contextFixture();
  f.context.dependencies = [];
  f.expected.context = structuredClone(f.context);
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
  const g = contextFixture();
  g.context.dependencies[0].id = 'another-change';
  g.expected.context = structuredClone(g.context);
  expect(validateReviewPacket(g.packet, g.expected)).toMatchObject({ ok: false });
  const h = contextFixture();
  expect(
    validateReviewPacket(
      { ...h.packet, context: { ok: false, error: { category: 'read' } } },
      h.expected,
    ),
  ).toMatchObject({ ok: false });
});

test('enforces C2 excerpt code-unit bounds without losing immutable facts', () => {
  const f = contextFixture();
  f.context.dependencies[0].facts[0].excerpt = 'é'.repeat(500);
  f.expected.context = structuredClone(f.context);
  const result = accepted(f);
  f.context.dependencies[0].facts[0].excerpt += 'é';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
    ok: false,
    error: { category: 'budget', field: 'context' },
  });
  expect(result.context.dependencies[0].facts[0].excerpt).toHaveLength(500);
});

test('rejects proposed-version findings and available lookups backed only by base evidence', () => {
  const f = findingFixture();
  f.source.provenance.subjects = [{ memberId: 'npm:0', side: 'base', value: '1.0.0' }];
  const source = {
    ...f.source,
    provenance: { ...f.source.provenance, range: { from: '1.0.0', to: null } },
  };
  const packet = { ...f.packet, sources: [...f.sources, source] };
  expect(validateReviewPacket(packet, f.expected)).toMatchObject({ ok: false });
  expect(validateReviewPacket({ ...packet, findings: [] }, f.expected)).toMatchObject({
    ok: false,
  });
});

test('requires the complete declared comparison range to match the change', () => {
  const f = npmFixture();
  const source = {
    ...upstreamSource(),
    kind: 'compare',
    provenance: { ...upstreamSource().provenance, range: { from: '99.0.0', to: '2.0.0' } },
  };
  expect(
    validateReviewPacket({ ...f.packet, sources: [...f.sources, source] }, f.expected),
  ).toMatchObject({ ok: false });
});

test('requires complete coverage to include a completed scoped inventory', () => {
  const f = fixture();
  f.packet.coverage.npm = { status: 'complete', reasons: [], sourceIds: ['readme'] };
  f.packet.sources[0].provenance.absentEcosystems = ['actions', 'uv'];
  const source = {
    id: 'readme',
    kind: 'file',
    ecosystems: ['npm'],
    memberIds: [],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'file',
      revision: 'head',
      repository: { ...repository },
      sha: HEAD,
      path: 'README.md',
    },
  };
  expect(
    validateReviewPacket({ ...f.packet, sources: [...f.packet.sources, source] }, f.expected),
  ).toMatchObject({ ok: false });
});

test('rejects an invented context path as proof of incompatibility', () => {
  const f = npmFixture();
  const context = {
    id: 'invented',
    kind: 'file',
    ecosystems: ['npm'],
    memberIds: ['npm:0'],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'file',
      revision: 'context',
      repository: { ...repository },
      sha: TRUSTED,
      path: 'does-not-exist.ts',
    },
  };
  const finding = {
    id: 'migration',
    kind: 'incompatibleMigration',
    memberId: 'npm:0',
    references: ['upstream', 'invented'],
    rationale: 'Unproven.',
    remediation: [],
    validation: [],
  };
  expect(
    validateReviewPacket(
      { ...f.packet, sources: [...f.sources, upstreamSource(), context], findings: [finding] },
      f.expected,
    ),
  ).toMatchObject({ ok: false });
});

test('preserves C2 excerpts containing legitimate internal tabs', () => {
  const f = contextFixture();
  f.context.dependencies[0].facts[0].excerpt = "import\tthing from 'example-0';";
  f.expected.context = structuredClone(f.context);
  expect(accepted(f).context).toEqual(f.context);
});

test('preserves tabs in upstream excerpts', () => {
  const f = npmFixture();
  const source = upstreamSource();
  source.provenance.excerpt = 'Example:\n\tconst value = 1;';
  const result = accepted({ ...f, packet: { ...f.packet, sources: [...f.sources, source] } });
  expect(result.sources.at(-1)).toEqual(source);
});

test('labels a malformed trusted argument as expected, not as packet data', () => {
  const f = npmFixture();
  for (const expected of [
    null,
    { ...f.expected, context: { ...f.expected.context, ok: false } },
    { ...f.expected, baseSha: 'raw' },
  ])
    expect(validateReviewPacket(f.packet, expected)).toEqual({
      ok: false,
      error: { category: 'input', field: 'expected' },
    });
  expect(validateReviewPacket(null, null)).toEqual({
    ok: false,
    error: { category: 'input', field: 'expected' },
  });
});

test('rejects explicit undefined optional properties rather than dropping them', () => {
  const f = npmFixture();
  const change = { ...f.changes[0], directRoles: undefined };
  expect(validateReviewPacket({ ...f.packet, changes: [change] }, f.expected)).toMatchObject({
    ok: false,
  });
});

test.each([null, 0, 'raw', [], {}, NaN, Infinity, new Date()])(
  'rejects a malformed packet root %#',
  (value) => {
    expect(validateReviewPacket(value, fixture().expected)).toMatchObject({ ok: false });
  },
);

test('rejects proxies before running inspection traps', () => {
  const f = fixture(),
    trap = vi.fn(() => {
      throw new Error('synthetic private detail');
    });
  const proxy = new Proxy(f.packet, { ownKeys: trap, getPrototypeOf: trap, get: trap });
  expect(validateReviewPacket(proxy, f.expected)).toEqual({
    ok: false,
    error: { category: 'input', field: 'packet' },
  });
  expect(trap).not.toHaveBeenCalled();
});

test('rejects symbols, prototype-like keys, cycles, sparse arrays, and nested hooks', () => {
  const f = fixture();
  const hostile = [
    { ...f.packet, [Symbol('hidden')]: true },
    { ...f.packet, constructor: 'synthetic' },
    { ...f.packet, prototype: 'synthetic' },
    { ...f.packet, context: f.packet },
    { ...f.packet, changes: sparseArray(128) },
    { ...f.packet, changes: sparseArray(1_000_000) },
  ];
  for (const packet of hostile)
    expect(validateReviewPacket(packet, f.expected)).toMatchObject({ ok: false });
  const hook = vi.fn();
  const source = {
    ...f.packet.sources[0],
    provenance: { ...f.packet.sources[0].provenance, toJSON: hook },
  };
  expect(validateReviewPacket({ ...f.packet, sources: [source] }, f.expected)).toMatchObject({
    ok: false,
  });
  expect(hook).not.toHaveBeenCalled();
});

test.each(['../escape', '/absolute', 'C:/absolute', 'a\\b', 'a//b', 'a/./b', 'a/../b'])(
  'rejects noncanonical evidence path %s',
  (invalidPath) => {
    const f = npmFixture();
    const sources = f.sources.map((source) =>
      source.kind === 'file'
        ? { ...source, provenance: { ...source.provenance, path: invalidPath } }
        : source,
    );
    expect(validateReviewPacket({ ...f.packet, sources }, f.expected)).toMatchObject({ ok: false });
  },
);

test('canonicalizes repository casing and full SHAs without changing exact refs', () => {
  const f = fixture();
  f.packet.binding.repository.owner = 'Example';
  f.packet.binding.headSha = HEAD.toUpperCase();
  f.packet.binding.identity[5] = HEAD.toUpperCase();
  expect(accepted(f).binding.repository.owner).toBe('example');
});

test.each(['permission', 'rate_limit', 'timeout', 'unsupported', 'truncated', 'conflict'])(
  'retains required evidence failure reason %s',
  (reason) => {
    const f = npmFixture();
    f.changes[0].evidence.vulnerability.reasons = [reason];
    expect(accepted(f).changes[0].evidence.vulnerability.reasons).toEqual([reason]);
  },
);

test('retains optional unchecked signals and rejects collector-assigned grouping', () => {
  const f = npmFixture();
  f.changes[0].evidence.publishTime = {
    status: 'unavailable',
    reasons: ['timeout'],
    sourceIds: [],
  };
  expect(accepted(f).changes[0].evidence.publishTime.status).toBe('unavailable');
  f.changes[0].evidence.upstream.status = 'group_backed';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
});

test.each(['registry', 'git', 'url', 'path', 'workspace'])(
  'preserves npm package source kind %s',
  (kind) => {
    const f = npmFixture();
    f.changes[0].to.source = {
      kind,
      identity:
        kind === 'path' || kind === 'workspace' ? 'packages/local' : 'https://example.com/source',
    };
    expect(accepted(f).changes[0].to).toMatchObject({ source: { kind } });
  },
);

test('accepts removals without inventing a proposed version', () => {
  const f = npmFixture();
  const c = { ...f.changes[0], kind: 'removal', to: null };
  expect(accepted({ ...f, packet: { ...f.packet, changes: [c] } }).changes[0].to).toBeNull();
});

test('keeps unknown Actions refs explicit and rejects uv names that need normalization', () => {
  const f = ecosystemFixture('actions');
  const c = { ...f.c, to: { ...f.c.to, refKind: 'unknown', ref: 'unresolved-expression' } };
  expect(accepted({ ...f, packet: { ...f.packet, changes: [c] } }).changes[0].to).toMatchObject({
    refKind: 'unknown',
  });
  const g = ecosystemFixture('uv');
  expect(
    validateReviewPacket(
      { ...g.packet, changes: [{ ...g.c, to: { ...g.c.to, name: 'Example_Package' } }] },
      g.expected,
    ),
  ).toMatchObject({ ok: false });
});

test('accepts exactly 128 changes and rejects 129 before resolving references', () => {
  expect(accepted(npmFixture(128)).changes).toHaveLength(128);
  const f = npmFixture(128);
  expect(
    validateReviewPacket({ ...f.packet, changes: [...f.changes, f.changes[0]] }, f.expected),
  ).toEqual({ ok: false, error: { category: 'budget', field: 'changes' } });
});

test('accepts 1024 source records and rejects the overflow record', () => {
  const f = fixture();
  const sources = Array.from({ length: 1024 }, (_, i) => ({
    ...f.packet.sources[0],
    id: i === 0 ? 'inventory' : `source:${i}`,
  }));
  expect(accepted({ ...f, packet: { ...f.packet, sources } }).sources).toHaveLength(1024);
  expect(
    validateReviewPacket({ ...f.packet, sources: [...sources, sources[0]] }, f.expected),
  ).toEqual({ ok: false, error: { category: 'budget', field: 'sources' } });
});

test('accepts 512 findings and rejects the overflow record', () => {
  const f = findingFixture();
  const findings = Array.from({ length: 512 }, (_, i) => ({ ...f.finding, id: `finding:${i}` }));
  expect(accepted({ ...f, packet: { ...f.packet, findings } }).findings).toHaveLength(512);
  expect(
    validateReviewPacket({ ...f.packet, findings: [...findings, findings[0]] }, f.expected),
  ).toEqual({ ok: false, error: { category: 'budget', field: 'findings' } });
});

test('accepts 256 distinct proofs and rejects the overflow proof', () => {
  const f = npmFixture(32);
  const relationships = Array.from({ length: 256 }, (_, i) => {
    const from = f.changes[Math.floor(i / 31)],
      other = i % 31,
      to = f.changes[other >= Math.floor(i / 31) ? other + 1 : other];
    return {
      fromId: from.id,
      toId: to.id,
      ecosystem: 'npm',
      side: 'head',
      sourceId: 'head-lock',
      path: [from.to, to.to],
    };
  });
  expect(accepted({ ...f, packet: { ...f.packet, relationships } }).relationships).toHaveLength(
    256,
  );
  expect(
    validateReviewPacket(
      { ...f.packet, relationships: [...relationships, relationships[0]] },
      f.expected,
    ),
  ).toEqual({ ok: false, error: { category: 'budget', field: 'relationships' } });
});

test('enforces the 32-instance path ceiling', () => {
  const f = relationshipFixture();
  f.proof.path.splice(
    1,
    0,
    ...Array.from({ length: 30 }, (_, i) => ({
      ...f.proof.path[0],
      name: `middle-${i}`,
      lockPath: `node_modules/middle-${i}`,
    })),
  );
  expect(accepted(f).relationships[0].path).toHaveLength(32);
  f.proof.path.splice(1, 0, {
    ...f.proof.path[0],
    name: 'overflow',
    lockPath: 'node_modules/overflow',
  });
  expect(validateReviewPacket(f.packet, f.expected)).toEqual({
    ok: false,
    error: { category: 'budget', field: 'relationships' },
  });
});

test('enforces the exact serialized packet budget including multibyte text', () => {
  const f = findingFixture();
  const findings = Array.from({ length: 512 }, (_, i) => ({
    ...f.finding,
    id: `finding:${i}`,
    rationale: 'a',
  }));
  const packet = { ...f.packet, findings };
  let remaining = PACKET_LIMITS.bytes - Buffer.byteLength(JSON.stringify(packet));
  for (const finding of findings) {
    const extra = Math.min(2047, remaining);
    finding.rationale += 'é'.repeat(Math.floor(extra / 2)) + (extra % 2 ? 'a' : '');
    remaining -= extra;
  }
  expect(remaining).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(packet))).toBe(PACKET_LIMITS.bytes);
  expect(accepted({ ...f, packet }).findings).toHaveLength(512);
  const last = findings.find((f) => Buffer.byteLength(f.rationale) < 2048);
  if (!last) throw new Error('expected room in a single field');
  last.rationale += 'a';
  expect(validateReviewPacket(packet, f.expected)).toEqual({
    ok: false,
    error: { category: 'budget', field: 'packet' },
  });
});

test('enforces 256-code-unit IDs and 1024-byte identity strings', () => {
  const f = npmFixture();
  f.changes[0].id = 'é'.repeat(256);
  for (const source of f.sources) if (source.memberIds.length) source.memberIds = [f.changes[0].id];
  f.changes[0].to.version = 'é'.repeat(512);
  expect(accepted(f).changes[0].id).toHaveLength(256);
  f.changes[0].id += 'a';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
    ok: false,
    error: { category: 'budget', field: 'changes' },
  });
  const g = npmFixture();
  g.changes[0].to.version = 'é'.repeat(512) + 'a';
  expect(validateReviewPacket(g.packet, g.expected)).toMatchObject({
    ok: false,
    error: { category: 'budget', field: 'changes' },
  });
});

test('enforces text and reference-list bounds independently of the packet size', () => {
  const f = findingFixture();
  f.finding.rationale = 'é'.repeat(1024);
  expect(accepted(f).findings).toHaveLength(1);
  f.finding.rationale += 'a';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
    ok: false,
    error: { category: 'budget', field: 'findings' },
  });
  const g = findingFixture();
  const sources = Array.from({ length: 32 }, (_, i) => ({ ...g.source, id: `advisory:${i}` }));
  g.finding.references = sources.map((s) => s.id);
  const packet = { ...g.packet, sources: [...g.packet.sources, ...sources] };
  expect(accepted({ ...g, packet }).findings).toHaveLength(1);
  g.finding.references.push('advisory');
  expect(validateReviewPacket(packet, g.expected)).toMatchObject({
    ok: false,
    error: { category: 'budget', field: 'findings' },
  });
});

test('preserves every deterministic C3 finding variant with appropriate sources', () => {
  const f = contextFixture();
  f.changes[0].to.source = { kind: 'git', identity: 'https://example.com/source.git#revision' };
  const sourceKinds = [
    'release',
    'metadata',
    'malware',
    'install-script',
    'publisher',
    'trust',
    'publishTime',
    'deprecation',
  ];
  const sources = sourceKinds.map((kind) => ({
    ...upstreamSource(),
    id: `source:${kind}`,
    kind,
    provenance: {
      ...upstreamSource().provenance,
      subjects: [
        { memberId: 'npm:0', side: 'base', value: '1.0.0' },
        { memberId: 'npm:0', side: 'head', value: '2.0.0' },
      ],
      range: { from: '1.0.0', to: '2.0.0' },
    },
  }));
  const file = {
    id: 'trusted-file',
    kind: 'file',
    ecosystems: ['npm'],
    memberIds: ['npm:0'],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'file',
      revision: 'context',
      repository: { ...repository },
      sha: TRUSTED,
      path: 'src/example.ts',
    },
  };
  const base = {
    memberId: 'npm:0',
    rationale: 'Verified normalized evidence.',
    remediation: [],
    validation: [],
  };
  const variants = [
    { kind: 'malware', applicability: 'affects_proposed', references: ['source:malware'] },
    { kind: 'incompatibleMigration', references: ['source:release', 'trusted-file'] },
    { kind: 'applicableCodemod', references: ['source:release'] },
    ...['raised_runtime_floor', 'tightened_peer_range', 'deprecated_workflow_input'].map(
      (change) => ({ kind: 'compatibilityUncertainty', change, references: ['source:release'] }),
    ),
    { kind: 'supplyChainChange', change: 'install_script', references: ['source:install-script'] },
    { kind: 'supplyChainChange', change: 'package_source', references: ['source:metadata'] },
    { kind: 'supplyChainChange', change: 'publisher', references: ['source:publisher'] },
    { kind: 'supplyChainChange', change: 'trust_downgrade', references: ['source:trust'] },
    {
      kind: 'licenseChange',
      currentLicense: 'MIT',
      proposedLicense: 'Apache-2.0',
      references: ['source:metadata'],
    },
    {
      kind: 'releaseMetadata',
      publishedAt: 1_700_000_000_000,
      deprecated: { marker: 'deprecated', reason: 'Use the maintained successor.' },
      references: ['source:publishTime', 'source:deprecation'],
    },
    {
      kind: 'informational',
      detail: 'Bounded retained information.',
      references: ['source:release'],
    },
  ];
  const findings = variants.map((v, i) => ({ ...base, ...v, id: `variant:${i}` }));
  expect(
    accepted({ ...f, packet: { ...f.packet, sources: [...f.sources, ...sources, file], findings } })
      .findings,
  ).toHaveLength(findings.length);
});

test.each(['affects_proposed', 'resolved_by_proposed', 'unaffected', 'withdrawn'])(
  'preserves advisory applicability %s',
  (applicability) => {
    const f = findingFixture();
    f.finding.applicability = applicability;
    if (applicability === 'resolved_by_proposed') {
      const source = {
        ...f.source,
        provenance: {
          ...f.source.provenance,
          subjects: [
            { memberId: 'npm:0', side: 'base', value: '1.0.0' },
            { memberId: 'npm:0', side: 'head', value: '2.0.0' },
          ],
          range: { from: '1.0.0', to: '2.0.0' },
          affectedRange: '<2.0.0',
        },
      };
      f.finding.affectedRange = '<2.0.0';
      expect(
        accepted({ ...f, packet: { ...f.packet, sources: [...f.sources, source] } }).findings[0],
      ).toMatchObject({ applicability });
    } else expect(accepted(f).findings[0]).toMatchObject({ applicability });
  },
);

test('rejects unrecognized finding variants and extra fields on known variants', () => {
  const f = findingFixture();
  for (const finding of [
    { ...f.finding, kind: 'modelAssertion' },
    { ...f.finding, severity: null },
    { ...f.finding, applicability: 'unknown' },
    { ...f.finding, proposedLicense: 'extra' },
  ]) {
    expect(validateReviewPacket({ ...f.packet, findings: [finding] }, f.expected)).toMatchObject({
      ok: false,
    });
  }
});

test('enforces the context fact count independently of excerpt and packet bounds', () => {
  const f = contextFixture();
  const fact = f.context.dependencies[0].facts[0];
  f.context.dependencies[0].facts = Array.from({ length: 20 }, (_, i) => ({
    ...fact,
    path: `src/example-${i}.ts`,
  }));
  f.expected.context = structuredClone(f.context);
  expect(accepted(f).context.dependencies[0].facts).toHaveLength(20);
  f.context.dependencies[0].facts.push({ ...fact, path: 'src/overflow.ts' });
  expect(validateReviewPacket(f.packet, f.expected)).toEqual({
    ok: false,
    error: { category: 'budget', field: 'context' },
  });
});

test('enforces exactly 65536 serialized context bytes across 128 dependencies', () => {
  const f = npmFixture(128);
  const context = {
    ok: true,
    status: 'available',
    reasons: [],
    dependencies: f.changes.map((c) => ({
      id: c.id,
      name: c.to.name,
      status: 'available',
      reasons: [],
      facts: [
        { kind: 'package-usage', path: 'src/example.ts', excerpt: 'a', excerptTruncated: false },
      ],
    })),
  };
  let remaining = 65_536 - Buffer.byteLength(JSON.stringify(context));
  for (const d of context.dependencies) {
    const extra = Math.min(499, remaining);
    d.facts[0].excerpt += 'a'.repeat(extra);
    remaining -= extra;
  }
  expect(remaining).toBe(0);
  const packet = { ...f.packet, context },
    expected = { ...f.expected, context: structuredClone(context) };
  expect(accepted({ packet, expected }).context.dependencies).toHaveLength(128);
  const last = context.dependencies.find((d) => d.facts[0].excerpt.length < 500);
  if (!last) throw new Error('expected one field with room');
  last.facts[0].excerpt += 'a';
  expect(validateReviewPacket(packet, expected)).toEqual({
    ok: false,
    error: { category: 'budget', field: 'context' },
  });
});

test('rejects context overflow dependencies, duplicate IDs, unsupported suffixes and bad flags', () => {
  const f = contextFixture();
  for (const dependencies of [
    sparseArray(129),
    [...f.context.dependencies, ...f.context.dependencies],
  ]) {
    const context = { ...f.context, dependencies };
    expect(
      validateReviewPacket({ ...f.packet, context }, { ...f.expected, context }),
    ).toMatchObject({ ok: false });
  }
  for (const fact of [
    { ...f.context.dependencies[0].facts[0], path: 'src/example.py' },
    { ...f.context.dependencies[0].facts[0], excerptTruncated: 'true' },
  ]) {
    const context = {
      ...f.context,
      dependencies: [{ ...f.context.dependencies[0], facts: [fact] }],
    };
    expect(
      validateReviewPacket({ ...f.packet, context }, { ...f.expected, context }),
    ).toMatchObject({ ok: false });
  }
});

test('accepts frozen inputs without mutation and returns independent nested snapshots', () => {
  const f = findingFixture();
  const freeze = (value: unknown) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(f.packet);
  freeze(f.expected);
  const first = accepted(f),
    second = accepted(f);
  expect(first).toEqual(second);
  expect(first).not.toBe(second);
  expect(first.findings[0].references).not.toBe(second.findings[0].references);
  expect(Object.isFrozen(first.sources[0].provenance)).toBe(true);
});

test('sanitizes sensitive-looking fields and never logs inspection failures', () => {
  const f = fixture(),
    log = vi.spyOn(console, 'error');
  const value = { ...f.packet, privateCredential: 'SYNTHETIC-PRIVATE-VALUE' };
  const result = validateReviewPacket(value, f.expected);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  expect(result).not.toHaveProperty('packet');
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});

test('requires every successful category to resolve to the same member and ecosystem', () => {
  const f = npmFixture();
  const source = upstreamSource();
  source.ecosystems = ['actions'];
  f.changes[0].evidence.upstream = { status: 'available', reasons: [], sourceIds: ['upstream'] };
  expect(
    validateReviewPacket({ ...f.packet, sources: [...f.sources, source] }, f.expected),
  ).toMatchObject({ ok: false });
  const g = npmFixture();
  const bad = { ...upstreamSource(), memberIds: ['other'] };
  expect(
    validateReviewPacket({ ...g.packet, sources: [...g.sources, bad] }, g.expected),
  ).toMatchObject({ ok: false });
});

test('rejects ecosystem-inapplicable or contradicted supply-chain findings', () => {
  const f = npmFixture();
  const base = {
    id: 'supply',
    memberId: 'npm:0',
    references: ['head-lock'],
    rationale: 'Contradiction.',
    remediation: [],
    validation: [],
    kind: 'supplyChainChange',
  };
  for (const change of ['action_identity', 'mutable_action_ref'])
    expect(
      validateReviewPacket({ ...f.packet, findings: [{ ...base, change }] }, f.expected),
    ).toMatchObject({ ok: false });
  const finding = { ...base, references: ['upstream'], change: 'package_source' };
  const source = { ...upstreamSource(), kind: 'metadata' };
  expect(
    validateReviewPacket(
      { ...f.packet, sources: [...f.sources, source], findings: [finding] },
      f.expected,
    ),
  ).toMatchObject({ ok: false });
});

test.each(['action_identity', 'mutable_action_ref'])(
  'preserves a proven Actions %s signal',
  (change) => {
    const f = ecosystemFixture('actions');
    const from = { ...f.c.from, ref: 'a'.repeat(40), refKind: 'sha', action: 'example/old-action' };
    const to = { ...f.c.to, action: 'example/new-action', refKind: 'tag', ref: 'v2' };
    const finding = {
      id: 'supply',
      memberId: 'actions:0',
      kind: 'supplyChainChange',
      change,
      references: ['base-lock', 'head-lock'],
      rationale: 'Verified immutable workflow change.',
      remediation: [],
      validation: [],
    };
    expect(
      accepted({
        ...f,
        packet: { ...f.packet, changes: [{ ...f.c, from, to }], findings: [finding] },
      }).findings,
    ).toHaveLength(1);
  },
);

test('requires baseline attribution before claiming an advisory is resolved', () => {
  const f = findingFixture();
  f.finding.applicability = 'resolved_by_proposed';
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({ ok: false });
});

test('rejects proposed release and compatibility claims backed only by old-version evidence', () => {
  for (const [kind, extra, sourceKind] of [
    ['releaseMetadata', { publishedAt: 0 }, 'publishTime'],
    ['compatibilityUncertainty', { change: 'raised_runtime_floor' }, 'release'],
  ] as const) {
    const f = npmFixture();
    const source = {
      ...upstreamSource(),
      kind: sourceKind,
      provenance: {
        ...upstreamSource().provenance,
        subjects: [{ memberId: 'npm:0', side: 'base', value: '1.0.0' }],
        range: { from: '1.0.0', to: null },
      },
    };
    const finding = {
      id: 'finding',
      memberId: 'npm:0',
      references: ['upstream'],
      rationale: 'Unattributed claim.',
      remediation: [],
      validation: [],
      kind,
      ...extra,
    };
    expect(
      validateReviewPacket(
        { ...f.packet, sources: [...f.sources, source], findings: [finding] },
        f.expected,
      ),
    ).toMatchObject({ ok: false });
  }
});

test('rejects unlinked inventory gaps alongside complete or absent coverage', () => {
  const f = fixture();
  const gap = {
    ...f.packet.sources[0],
    id: 'omitted-gap',
    status: 'partial',
    reasons: ['truncated'],
    provenance: { ...f.packet.sources[0].provenance, absentEcosystems: [] },
  };
  expect(
    validateReviewPacket({ ...f.packet, sources: [...f.packet.sources, gap] }, f.expected),
  ).toMatchObject({ ok: false });
});

test('does not invent an Action owner/repository change from a subpath-only update', () => {
  const f = ecosystemFixture('actions');
  const c = {
    ...f.c,
    from: { ...f.c.from, action: 'example/setup/old' },
    to: { ...f.c.to, action: 'example/setup/new' },
  };
  const finding = {
    id: 'supply',
    memberId: c.id,
    references: ['base-lock', 'head-lock'],
    kind: 'supplyChainChange',
    change: 'action_identity',
    rationale: 'Same owner and repository.',
    remediation: [],
    validation: [],
  };
  expect(
    validateReviewPacket({ ...f.packet, changes: [c], findings: [finding] }, f.expected),
  ).toMatchObject({ ok: false });
});

test('requires proposed-side upstream evidence even when head inventory is cited', () => {
  const f = contextFixture();
  const upstream = {
    ...upstreamSource(),
    provenance: {
      ...upstreamSource().provenance,
      subjects: [{ memberId: 'npm:0', side: 'base', value: '1.0.0' }],
      range: { from: '1.0.0', to: null },
    },
  };
  const file = {
    id: 'trusted-file',
    kind: 'file',
    ecosystems: ['npm'],
    memberIds: ['npm:0'],
    status: 'available',
    reasons: [],
    provenance: {
      kind: 'file',
      revision: 'context',
      repository: { ...repository },
      sha: TRUSTED,
      path: 'src/example.ts',
    },
  };
  const finding = {
    id: 'migration',
    kind: 'incompatibleMigration',
    memberId: 'npm:0',
    references: ['upstream', 'trusted-file', 'head-lock'],
    rationale: 'Old-version release cannot prove this.',
    remediation: [],
    validation: [],
  };
  expect(
    validateReviewPacket(
      { ...f.packet, sources: [...f.sources, upstream, file], findings: [finding] },
      f.expected,
    ),
  ).toMatchObject({ ok: false });
});

test('rejects contradictory applicability across vulnerability and malware findings', () => {
  const f = findingFixture(),
    source = { ...f.source, id: 'malware', kind: 'malware' };
  const finding = {
    id: 'malware-finding',
    memberId: 'npm:0',
    kind: 'malware',
    applicability: 'withdrawn',
    references: ['malware'],
    rationale: 'Conflicting applicability.',
    remediation: [],
    validation: [],
  };
  expect(
    validateReviewPacket(
      {
        ...f.packet,
        sources: [...f.packet.sources, source],
        findings: [...f.packet.findings, finding],
      },
      f.expected,
    ),
  ).toMatchObject({ ok: false });
});

test.each(['baseRef', 'baseSha', 'mergeBaseSha'] as const)(
  'rejects conflicting packet binding %s',
  (field) => {
    const f = fixture();
    f.packet.binding[field] = field === 'baseRef' ? 'other' : HEAD;
    expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
      ok: false,
      error: { category: 'identity' },
    });
  },
);

test('rejects a trusted base that disagrees with its own binding', () => {
  const f = fixture();
  f.packet.baseSha = HEAD;
  f.expected.baseSha = HEAD;
  f.packet.sources[0].provenance.baseSha = HEAD;
  expect(validateReviewPacket(f.packet, f.expected)).toMatchObject({
    ok: false,
    error: { category: 'identity' },
  });
});
