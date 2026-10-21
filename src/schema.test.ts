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
        memberIds: [],
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

function accepted(input = fixture()) {
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
