import { expect, test, vi } from 'vite-plus/test';
import { validateReviewPacket } from './schema.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TRUSTED = 'c'.repeat(40);
const repository = { id: 101, owner: 'example', name: 'consumer' };
const ecosystems = ['npm', 'actions', 'uv'] as const;

function fixture() {
  const binding = {
    repository: { ...repository },
    workflow: { id: 301, path: '.github/workflows/ci.yml' },
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headRepository: { ...repository },
    headSha: HEAD,
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
      from: side('1.0.0', 'base-lock'),
      to: side('2.0.0', 'head-lock'),
      role: 'direct',
      evidence: Object.fromEntries(
        ['upstream', 'vulnerability', 'malware', 'installScript'].map((category) => [
          category,
          { status: 'unavailable', reasons: ['missing'], sourceIds: [] as string[] },
        ]),
      ),
    };
  });
  const fileSource = (side: 'base' | 'head') => ({
    id: `${side}-lock`,
    kind: 'file',
    ecosystems: ['npm'],
    memberIds: changes.map((c) => c.id),
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
  const sources = [...f.packet.sources, fileSource('base'), fileSource('head')];
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
