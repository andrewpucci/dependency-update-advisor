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
  expect(result).toEqual({ kind: 'incomplete' });
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
  expect(result).toEqual({ kind: 'incomplete' });
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
  ).resolves.toEqual({ kind: 'incomplete' });
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
