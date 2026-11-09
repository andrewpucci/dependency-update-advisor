import { expect, test } from 'vite-plus/test';
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
