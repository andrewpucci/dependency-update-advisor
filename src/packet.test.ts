import { expect, test, vi } from 'vite-plus/test';
import { assembleReviewPacket } from './packet.js';
import * as optionalEvidence from './optional-evidence.js';
import * as schema from './schema.js';
import { formDecisionUnits } from './units.js';

vi.mock('./schema.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./schema.js')>();
  return { ...original, validateReviewPacket: vi.fn(original.validateReviewPacket) };
});
const validations = () => vi.mocked(schema.validateReviewPacket);
vi.mock('./optional-evidence.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./optional-evidence.js')>();
  return { ...original, fitOptionalEvidence: vi.fn(original.fitOptionalEvidence) };
});

const PACKET_LIMITS_BYTES = 1_048_576;

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

type LockEcosystem = 'npm' | 'uv';
const LOCK_PATH = { npm: 'package-lock.json', uv: 'uv.lock' } as const;
/** Each 32-change chunk is its own root so candidates in one chunk never count against another. */
const chunkRoot = (chunk: number) => (chunk === 0 ? '.' : `root${chunk}`);
function lockSourceId(ecosystem: LockEcosystem, side: string, chunk: number, pad: number) {
  return `${ecosystem}:${side}:${chunk}${pad ? ':' + 's'.repeat(pad) : ''}`;
}
function lockIds(ecosystem: LockEcosystem, count: number, pad: number) {
  return Array.from({ length: count }, (_, i) => `${ecosystem}-${'p'.repeat(pad)}-${i}`);
}
function lockFragment(
  ecosystem: LockEcosystem,
  count: number,
  pad: number,
  extra: Record<string, unknown> = {},
) {
  const ids = lockIds(ecosystem, count, pad);
  const side = (i: number, revision: 'base' | 'head') => ({
    root: chunkRoot(Math.floor(i / 32)),
    name: `pkg${i}`,
    ...(ecosystem === 'npm'
      ? {
          lockPath: `node_modules/pkg${i}`,
          version: revision === 'base' ? '1.0.0' : '2.0.0',
          source: { kind: 'registry', identity: 'https://registry.npmjs.org' },
        }
      : {
          version: revision === 'base' ? '1.0.0' : '2.0.0',
          marker: null,
          extras: [],
          groups: [],
          source: { kind: 'registry', identity: 'https://pypi.org/simple' },
        }),
    sourceId: lockSourceId(ecosystem, revision, Math.floor(i / 32), pad),
  });
  const categories =
    ecosystem === 'npm'
      ? ['upstream', 'vulnerability', 'malware', 'installScript']
      : ['upstream', 'vulnerability', 'malware'];
  const changes = ids.map((id, i) => ({
    id,
    ecosystem,
    kind: 'update',
    role: i % 32 < 16 ? 'direct' : 'transitive',
    from: side(i, 'base'),
    to: side(i, 'head'),
    evidence: Object.fromEntries(
      categories.map((c) => [c, { status: 'unavailable', reasons: ['missing'], sourceIds: [] }]),
    ),
  }));
  const sources = Array.from({ length: Math.ceil(count / 32) }, (_, chunk) =>
    (['base', 'head'] as const).map((revision) => ({
      id: lockSourceId(ecosystem, revision, chunk, pad),
      kind: 'file',
      ecosystems: [ecosystem],
      memberIds: ids.slice(chunk * 32, chunk * 32 + 32),
      status: 'available',
      reasons: [],
      provenance: {
        kind: 'file',
        revision,
        repository,
        sha: revision === 'base' ? base : head,
        path: (chunk === 0 ? '' : `${chunkRoot(chunk)}/`) + LOCK_PATH[ecosystem],
      },
    })),
  ).flat();
  return {
    kind: 'complete' as const,
    ecosystem,
    coverage: { status: 'complete' as const, reasons: [], sourceIds: ['inventory'] },
    changes,
    sources,
    findings: [],
    relationships: [] as unknown[],
    reachability: [] as unknown[],
    ...extra,
  };
}
function pairVerdicts(ecosystem: LockEcosystem, count: number, pad: number, limit = Infinity) {
  const ids = lockIds(ecosystem, count, pad);
  const verdicts: Record<string, unknown>[] = [];
  for (let chunk = 0; chunk * 32 < count; chunk += 1)
    for (const side of ['head', 'base'] as const)
      for (let a = 0; a < 16; a += 1)
        for (let m = 16; m < 32; m += 1)
          verdicts.push({
            ecosystem,
            side,
            sourceId: lockSourceId(ecosystem, side, chunk, pad),
            anchorId: ids[chunk * 32 + a],
            memberId: ids[chunk * 32 + m],
            outcome: 'unreachable',
            reasons: [],
          });
  return verdicts.slice(0, limit);
}
function groupKey(v: Record<string, unknown>) {
  return JSON.stringify([v.ecosystem, v.side, v.anchorId]);
}
function assembleMixed(npm: unknown, uv: unknown) {
  return assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: { npm: async () => npm, actions: collector('actions'), uv: async () => uv },
    inventorySource: {
      ...sharedInventory,
      provenance: { ...sharedInventory.provenance, absentEcosystems: ['actions'] },
    },
  });
}
function ready(result: Awaited<ReturnType<typeof assembleReviewPacket>>) {
  if (result.kind !== 'ready') throw new Error(JSON.stringify(result));
  return result;
}

test('keeps all reachability evidence when the packet fits its budgets', async () => {
  const verdicts = pairVerdicts('npm', 64, 0, 100);
  const result = ready(
    await assembleMixed(
      lockFragment('npm', 64, 0, { reachability: verdicts }),
      lockFragment('uv', 64, 0),
    ),
  );
  expect(result.packet.reachability).toHaveLength(100);
  expect(result.droppedOptional).toEqual([]);
});

test('does not repeatedly validate whole packets after the fitter has accounted for every budget', async () => {
  const validate = validations();
  validate.mockImplementation(() => ({ ok: false, error: { category: 'budget' } }) as never);
  try {
    const result = await assembleMixed(
      lockFragment('npm', 64, 0, { reachability: pairVerdicts('npm', 64, 0, 10) }),
      lockFragment('uv', 64, 0),
    );
    expect(result).toEqual({ kind: 'incomplete', gaps: [{ source: 'packet', reason: 'budget' }] });
    expect(validate).toHaveBeenCalledTimes(1);
  } finally {
    validate.mockRestore();
  }
});

test('a mixed packet over the verdict cap drops uv groups first, then the largest npm groups', async () => {
  const npmVerdicts = pairVerdicts('npm', 64, 0),
    uvVerdicts = pairVerdicts('uv', 64, 0);
  expect(npmVerdicts.length).toBe(1024);
  expect(uvVerdicts.length).toBe(1024);
  validations().mockClear();
  const result = ready(
    await assembleMixed(
      lockFragment('npm', 64, 0, { reachability: npmVerdicts }),
      lockFragment('uv', 64, 0, { reachability: uvVerdicts }),
    ),
  );
  expect(validations()).toHaveBeenCalledTimes(1);
  const { packet } = result;
  expect(packet.changes).toHaveLength(128);
  expect(packet.reachability.length).toBeLessThanOrEqual(1_024);
  const uvRecords = packet.reachability.filter((v) => v.ecosystem === 'uv');
  expect(uvRecords).toHaveLength(64);
  expect(
    uvRecords.every(
      (v) => v.memberId === null && v.outcome === 'truncated' && v.reasons.includes('budget'),
    ),
  ).toBe(true);
  const npmGroups = [...new Set(npmVerdicts.map(groupKey))].sort().reverse();
  const droppedNpm = result.droppedOptional.filter((d) => d.ecosystem === 'npm').map((d) => d.key);
  expect(droppedNpm).toHaveLength(5);
  expect(droppedNpm).toEqual(npmGroups.slice(0, 5));
  expect(result.droppedOptional.filter((d) => d.ecosystem === 'uv')).toHaveLength(64);
  expect(packet.reachability).toHaveLength(1_013);
});

test('each collector alone fits the cap, so per-collector caps would let the packet overflow', async () => {
  const solo = ready(
    await assembleMixed(
      lockFragment('npm', 64, 0, { reachability: pairVerdicts('npm', 64, 0) }),
      lockFragment('uv', 64, 0),
    ),
  );
  expect(solo.packet.reachability).toHaveLength(1_024);
  expect(solo.droppedOptional).toEqual([]);
});

test('drop order and results do not depend on verdict order', async () => {
  const run = async (reverse: boolean) => {
    const npmVerdicts = pairVerdicts('npm', 64, 0),
      uvVerdicts = pairVerdicts('uv', 64, 0);
    if (reverse) {
      npmVerdicts.reverse();
      uvVerdicts.reverse();
    }
    return ready(
      await assembleMixed(
        lockFragment('npm', 64, 0, { reachability: npmVerdicts }),
        lockFragment('uv', 64, 0, { reachability: uvVerdicts }),
      ),
    );
  };
  const forward = await run(false),
    reversed = await run(true);
  const norm = (r: Awaited<ReturnType<typeof run>>) =>
    JSON.stringify(r.packet.reachability.map((v) => JSON.stringify(v)).sort());
  expect(norm(reversed)).toBe(norm(forward));
  expect(reversed.droppedOptional).toEqual(forward.droppedOptional);
});

test('over the byte ceiling with the count under the cap, optional evidence is dropped, never changes', async () => {
  const pad = 240;
  const verdicts = pairVerdicts('npm', 64, pad);
  expect(verdicts.length).toBe(1024);
  const full = JSON.stringify(verdicts);
  validations().mockClear();
  const result = ready(
    await assembleMixed(
      lockFragment('npm', 64, pad, { reachability: verdicts }),
      lockFragment('uv', 64, pad),
    ),
  );
  expect(validations()).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(JSON.stringify(result.packet))).toBeLessThanOrEqual(PACKET_LIMITS_BYTES);
  expect(result.droppedOptional.length).toBeGreaterThan(0);
  expect(result.packet.changes).toHaveLength(128);
  expect(
    Buffer.byteLength(JSON.stringify(result.packet)) + Buffer.byteLength(full),
  ).toBeGreaterThan(PACKET_LIMITS_BYTES);
});

test('second proofs are dropped after the proof cap, keeping every required proof', async () => {
  const ids = lockIds('npm', 64, 0);
  const fragment = lockFragment('npm', 64, 0);
  const byId = new Map(fragment.changes.map((c) => [c.id, c]));
  const proofs: Record<string, unknown>[] = [];
  for (let chunk = 0; chunk < 2; chunk += 1)
    for (let a = 0; a < 16; a += 1)
      for (let m = 16; m < 32; m += 1) {
        const from = ids[chunk * 32 + a],
          to = ids[chunk * 32 + m];
        proofs.push({
          fromId: from,
          toId: to,
          ecosystem: 'npm',
          side: 'head',
          sourceId: lockSourceId('npm', 'head', chunk, 0),
          path: [byId.get(from)!.to, byId.get(to)!.to],
        });
      }
  const key = (p: Record<string, unknown>) => JSON.stringify(['npm', p.fromId, p.toId, p.side]);
  const required = proofs.slice(0, 10),
    optional = proofs.slice(10, 310);
  validations().mockClear();
  const result = ready(
    await assembleMixed(
      { ...fragment, relationships: required, optionalRelationships: optional },
      lockFragment('uv', 64, 0),
    ),
  );
  expect(validations()).toHaveBeenCalledTimes(1);
  expect(result.packet.relationships).toHaveLength(256);
  for (const proof of required)
    expect(result.packet.relationships.map((p) => key(p))).toContain(key(proof));
  const dropped = result.droppedOptional.filter((d) => d.kind === 'proof').map((d) => d.key);
  expect(dropped).toEqual(optional.map(key).sort().reverse().slice(0, 54));
});

function groupable(chunks: number) {
  const ids = lockIds('npm', chunks * 32, 0);
  const fragment = lockFragment('npm', chunks * 32, 0);
  const byId = new Map(fragment.changes.map((c) => [c.id, c]));
  const required: unknown[] = [],
    verdicts: Record<string, unknown>[] = [];
  for (let chunk = 0; chunk < chunks; chunk += 1)
    for (let m = 16; m < 32; m += 1) {
      const anchor = ids[chunk * 32],
        member = ids[chunk * 32 + m];
      required.push({
        fromId: anchor,
        toId: member,
        ecosystem: 'npm',
        side: 'head',
        sourceId: lockSourceId('npm', 'head', chunk, 0),
        path: [byId.get(anchor)!.to, byId.get(member)!.to],
      });
      for (let a = 1; a < 16; a += 1)
        for (const side of ['head', 'base'] as const)
          verdicts.push({
            ecosystem: 'npm',
            side,
            sourceId: lockSourceId('npm', side, chunk, 0),
            anchorId: ids[chunk * 32 + a],
            memberId: member,
            outcome: 'unreachable',
            reasons: [],
          });
    }
  return { ids, npm: { ...fragment, relationships: required, reachability: verdicts }, verdicts };
}

test('with everything inside budget each root groups under its one proven anchor', async () => {
  const { ids, npm } = groupable(2);
  const result = ready(await assembleMixed(npm, lockFragment('uv', 32, 0)));
  expect(result.droppedOptional).toEqual([]);
  const groups = formDecisionUnits(result.packet).units.filter((u) => u.kind === 'direct_group');
  expect(groups.map((u) => u.anchorId).sort()).toEqual([ids[0], ids[32]].sort());
});

test('a partial drop never forms a group: members of a truncated anchor/side stay standalone', async () => {
  const { ids, npm, verdicts } = groupable(3);
  expect(verdicts.length).toBe(1_440);
  const result = ready(
    await assembleMixed(
      npm,
      lockFragment('uv', 32, 0, { reachability: pairVerdicts('uv', 32, 0) }),
    ),
  );
  const touched = new Set(
    result.droppedOptional
      .filter((d) => d.ecosystem === 'npm')
      .map((d) => Math.floor(ids.indexOf(JSON.parse(d.key)[2]) / 32)),
  );
  expect(touched.size).toBeGreaterThan(0);
  const units = formDecisionUnits(result.packet).units;
  for (let chunk = 0; chunk < 3; chunk += 1) {
    const grouped = units.filter(
      (u) => u.kind === 'direct_group' && u.anchorId === ids[chunk * 32],
    );
    expect(grouped.length).toBe(touched.has(chunk) ? 0 : 1);
  }
  const members = units.filter((u) => u.relationship.reason === 'reachability_unproven');
  expect(members.length).toBeGreaterThan(0);
  expect(units.flatMap((u) => u.memberIds).sort()).toEqual(
    result.packet.changes.map((c) => c.id).sort(),
  );
});

test('reports an internal failure when fitting optional evidence throws', async () => {
  vi.mocked(optionalEvidence.fitOptionalEvidence).mockImplementationOnce(() => {
    throw new TypeError('regression inside fitOptionalEvidence');
  });
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => ({ close: () => undefined }),
    collectors: { npm: collector('npm'), actions: collector('actions'), uv: collector('uv') },
    inventorySource: null,
  });
  expect(result).toEqual({ kind: 'internal-failure' });
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
