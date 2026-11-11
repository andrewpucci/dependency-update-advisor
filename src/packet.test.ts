import { expect, test, vi } from 'vite-plus/test';
import { assembleReviewPacket } from './packet.js';

const repository = { id: 101, owner: 'example', name: 'consumer' };
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const trusted = {
  binding: {
    repository,
    workflow: { id: 301, path: '.github/workflows/ci.yml' },
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headRepository: repository,
    headSha: head,
    baseRef: 'main',
    baseSha: base,
    mergeBaseSha: base,
    actorId: 201,
    conclusion: 'success',
    identity: [101, 301, 401, 1, 42, head],
  },
  baseSha: base,
  contextRevision: { repository, sha: 'c'.repeat(40) },
  context: { ok: true, status: 'disabled', dependencies: [], reasons: [] },
};

function collector(ecosystem: 'npm' | 'actions' | 'uv') {
  return async () => ({
    kind: 'complete' as const,
    coverage: { status: 'not_applicable' as const, reasons: [], sourceIds: ['inventory'] },
    changes: [],
    sources: [],
    findings: [],
    relationships: [],
    reachability: [],
    ecosystem,
  });
}

test('validates one owner-bound mixed packet without replacing C1/C2 provenance', async () => {
  let closed = false;
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => (closed = true) }),
    collectors: { npm: collector('npm'), actions: collector('actions'), uv: collector('uv') },
    inventorySource: {
      id: 'inventory',
      kind: 'file-list',
      ecosystems: ['npm', 'actions', 'uv'],
      memberIds: [],
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'inventory',
        repository,
        baseSha: base,
        headSha: head,
        absentEcosystems: ['npm', 'actions', 'uv'],
      },
    },
  });

  expect(result).toMatchObject({
    kind: 'ready',
    packet: { contextRevision: trusted.contextRevision },
  });
  expect(closed).toBe(true);
});

test('never turns an unavailable collector into an empty complete packet', async () => {
  const unavailable = async () => ({ kind: 'unavailable' as const });
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: { npm: collector('npm'), actions: unavailable, uv: collector('uv') },
    inventorySource: null,
  });
  expect(result).toEqual({ kind: 'incomplete', gaps: [{ source: 'actions', reason: 'unknown' }] });
});

test.each([
  ['a collector reason', async () => ({ kind: 'unavailable', reason: 'budget' }), 'budget'],
  ['an unusable fragment', async () => ({ kind: 'complete', ecosystem: 'other' }), 'malformed'],
  ['no result', async () => null, 'malformed'],
  [
    'a reason outside the fixed set',
    async () => ({ kind: 'unavailable', reason: 'secret-text' }),
    'unknown',
  ],
])('names the ecosystem and a fixed reason for %s', async (_label, uv, reason) => {
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: { npm: collector('npm'), actions: collector('actions'), uv },
    inventorySource: null,
  });
  expect(result).toEqual({ kind: 'incomplete', gaps: [{ source: 'uv', reason }] });
});

test('names the packet as the gap when validation rejects the assembled evidence', async () => {
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    // Without the shared source, not-applicable coverage cites a source that does not exist.
    collectors: { npm: collector('npm'), actions: collector('actions'), uv: collector('uv') },
    inventorySource: null,
  });
  expect(result).toMatchObject({ kind: 'incomplete', gaps: [{ source: 'packet' }] });
});

const sharedInventory = {
  id: 'inventory',
  kind: 'file-list',
  ecosystems: ['npm', 'actions', 'uv'],
  memberIds: [],
  status: 'available',
  reasons: [],
  provenance: {
    kind: 'inventory',
    repository,
    baseSha: base,
    headSha: head,
    absentEcosystems: ['npm', 'actions', 'uv'],
  },
};
function assembleWithUv(uv: () => Promise<unknown>) {
  return assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: { npm: collector('npm'), actions: collector('actions'), uv },
    inventorySource: sharedInventory,
  });
}

test('a fragment without reachability yields an explicit empty array, never a missing field', async () => {
  const { reachability: _omitted, ...fragment } = await collector('uv')();
  const result = await assembleWithUv(async () => fragment);
  expect(result).toMatchObject({ kind: 'ready', packet: { reachability: [] } });
});

test('forwards fragment reachability to T4 instead of dropping it', async () => {
  const fragment = await collector('uv')();
  const result = await assembleWithUv(async () => ({ ...fragment, reachability: [{}] }));
  expect(result).toEqual({ kind: 'incomplete', gaps: [{ source: 'packet', reason: 'malformed' }] });
});

test('rejects a fragment whose reachability is not an array', async () => {
  const fragment = await collector('uv')();
  const result = await assembleWithUv(async () => ({ ...fragment, reachability: 'none' }));
  expect(result).toEqual({ kind: 'incomplete', gaps: [{ source: 'uv', reason: 'malformed' }] });
});

test('keeps the computed result when closing the session fails', async () => {
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({
      close: () => {
        throw new Error('close failed');
      },
    }),
    collectors: { npm: async () => null, actions: collector('actions'), uv: collector('uv') },
    inventorySource: null,
  });
  expect(result).toEqual({ kind: 'incomplete', gaps: [{ source: 'npm', reason: 'malformed' }] });
});

const { context: _context, ...trustedWithoutContext } = trusted;

function sources(ecosystems: ('npm' | 'actions' | 'uv')[]) {
  return {
    collectors: {
      npm: collector('npm'),
      actions: collector('actions'),
      uv: collector('uv'),
    },
    inventorySource: {
      id: 'inventory',
      kind: 'file-list',
      ecosystems,
      memberIds: [],
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'inventory',
        repository,
        baseSha: base,
        headSha: head,
        absentEcosystems: ecosystems,
      },
    },
  };
}

test('collects C2 context for the collected changes and validates the packet with it', async () => {
  const seen: unknown[] = [];
  const result = await assembleReviewPacket({
    trusted: trustedWithoutContext,
    collectContext: async (changes) => {
      seen.push(changes);
      return { ok: true, status: 'disabled', dependencies: [], reasons: [] };
    },
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    ...sources(['npm', 'actions', 'uv']),
  });
  expect(result).toMatchObject({ kind: 'ready', packet: { context: { status: 'disabled' } } });
  expect(seen).toEqual([[]]);
});

test('reports a C2 failure by its category instead of supplying an empty context', async () => {
  const result = await assembleReviewPacket({
    trusted: trustedWithoutContext,
    collectContext: async () => ({
      ok: false,
      error: { file: 'x', category: 'config', field: 'context.excerptFiles' },
    }),
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    ...sources(['npm', 'actions', 'uv']),
  });
  expect(result).toEqual({ kind: 'context-failure', category: 'config' });
});

test('does not collect context for an incomplete collector, and needs one source of it', async () => {
  const collectContext = vi.fn(async () => ({
    ok: true,
    status: 'disabled',
    dependencies: [],
    reasons: [],
  }));
  const unavailable = async () => ({ kind: 'unavailable' as const });
  await expect(
    assembleReviewPacket({
      trusted: trustedWithoutContext,
      collectContext,
      isCurrent: () => true,
      openSession: async () => ({ close: () => undefined }),
      collectors: { ...sources([]).collectors, npm: unavailable },
      inventorySource: null,
    }),
  ).resolves.toEqual({ kind: 'incomplete', gaps: [{ source: 'npm', reason: 'unknown' }] });
  expect(collectContext).not.toHaveBeenCalled();
  await expect(
    assembleReviewPacket({
      trusted: trustedWithoutContext,
      isCurrent: () => true,
      openSession: async () => ({ close: () => undefined }),
      ...sources(['npm', 'actions', 'uv']),
    }),
  ).resolves.toEqual({ kind: 'internal-failure' });
});

test('is stale when ownership ends while context is collected', async () => {
  let current = true;
  const result = await assembleReviewPacket({
    trusted: trustedWithoutContext,
    collectContext: async () => {
      current = false;
      return { ok: true, status: 'disabled', dependencies: [], reasons: [] };
    },
    isCurrent: () => current,
    openSession: async () => ({ close: () => undefined }),
    ...sources(['npm', 'actions', 'uv']),
  });
  expect(result).toEqual({ kind: 'stale' });
});

test('passes the collected changes, in collector order, to context collection', async () => {
  const seen: unknown[] = [];
  const withChange = (ecosystem: 'npm' | 'actions' | 'uv', id: string) => async () => ({
    ...(await collector(ecosystem)()),
    changes: [{ id }],
  });
  await assembleReviewPacket({
    trusted: trustedWithoutContext,
    collectContext: async (changes) => {
      seen.push(changes);
      return { ok: true, status: 'disabled', dependencies: [], reasons: [] };
    },
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: {
      npm: withChange('npm', 'n'),
      actions: withChange('actions', 'a'),
      uv: withChange('uv', 'u'),
    },
    inventorySource: null,
  });
  expect(seen).toEqual([[{ id: 'n' }, { id: 'a' }, { id: 'u' }]]);
});

test('names a packet that exceeds its size limits as a budget gap', async () => {
  const tooMany = async () => ({
    ...(await collector('npm')()),
    changes: Array.from({ length: 129 }, (_, index) => ({ id: `change-${index}` })),
  });
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: { npm: tooMany, actions: collector('actions'), uv: collector('uv') },
    inventorySource: null,
  });
  expect(result).toEqual({ kind: 'incomplete', gaps: [{ source: 'packet', reason: 'budget' }] });
});
