import { expect, test, vi } from 'vite-plus/test';
import * as npmModule from './evidence/npm.js';
import * as uvModule from './evidence/uv.js';
import * as npmGraphModule from './evidence/npm-graph.js';
import * as uvGraphModule from './evidence/uv-graph.js';
import * as readModule from './github-read.js';
import { npmScenario } from '../tests/parity/npm-inventory.js';
import { uvMetadataScenario } from '../tests/parity/uv-metadata.js';
import { createEvidenceCollectors, openEvidenceSession, W2_EVIDENCE_LIMITS } from './collection.js';
import type { DependabotRootsOutcome } from './dependabot-roots.js';
import type { GithubReadSession } from './github-read.js';
import { assembleReviewPacket } from './packet.js';

vi.mock('./evidence/npm.js', async (original) => {
  const actual = await original<typeof import('./evidence/npm.js')>();
  return { ...actual, collectNpmInventory: vi.fn(actual.collectNpmInventory) };
});
vi.mock('./evidence/uv.js', async (original) => {
  const actual = await original<typeof import('./evidence/uv.js')>();
  return { ...actual, collectUvMetadata: vi.fn(actual.collectUvMetadata) };
});

vi.mock('./evidence/npm-graph.js', async (original) => {
  const actual = await original<typeof import('./evidence/npm-graph.js')>();
  return { ...actual, enrichNpmEvidence: vi.fn(actual.enrichNpmEvidence) };
});
vi.mock('./evidence/uv-graph.js', async (original) => {
  const actual = await original<typeof import('./evidence/uv-graph.js')>();
  return { ...actual, reconcileUvGraph: vi.fn(actual.reconcileUvGraph) };
});
vi.mock('./github-read.js', async (original) => {
  const actual = await original<typeof import('./github-read.js')>();
  return { ...actual, createGithubReadSession: vi.fn(actual.createGithubReadSession) };
});

const context = { ok: true, status: 'disabled', dependencies: [], reasons: [] };

function configured(
  revision: { repository: unknown; sha: string },
  npm: string[] = ['.'],
  uv: string[] = ['.'],
): DependabotRootsOutcome {
  return {
    kind: 'roots',
    revision: revision as never,
    npm: { kind: 'roots', roots: npm },
    uv: { kind: 'roots', roots: uv },
  };
}

async function uvPipeline(
  dependabot?: (revision: { repository: unknown; sha: string }) => DependabotRootsOutcome,
) {
  const fixture = uvMetadataScenario('empty');
  const { binding, configRevision } = fixture.input;
  const registryFetch = vi.fn(async () => {
    throw new Error('unexpected registry request');
  });
  const collectors = createEvidenceCollectors({
    binding,
    dependabot: (dependabot ?? configured)(configRevision),
    registryFetch,
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  const trusted = { binding, baseSha: binding.baseSha, contextRevision: configRevision, context };
  const result = await assembleReviewPacket({
    trusted,
    isCurrent: () => true,
    openSession: async () => {
      const opened = await openEvidenceSession({
        binding,
        fetch: fixture.fetch,
        now: () => 0,
        deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
      });
      if (opened.kind !== 'ready') throw new Error('expected a D1 session');
      return opened.session;
    },
    collectors,
    inventorySource: null,
  });
  return { result, requests: fixture.requests, registryFetch };
}

test('runs the real collectors through one owner-bound session into a validated packet', async () => {
  const { result, registryFetch } = await uvPipeline();
  expect(result.kind, JSON.stringify(result)).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(result.packet.coverage.uv.status).not.toBe('unavailable');
  expect(result.packet.coverage.npm.status).toBe('not_applicable');
  expect(registryFetch).not.toHaveBeenCalled();
});
test("carries each collector's own not-applicable proof, with no shared source", async () => {
  const { result } = await uvPipeline();
  if (result.kind !== 'ready') throw new Error('expected a packet');
  expect(result.packet.coverage.npm).toMatchObject({ status: 'not_applicable' });
  expect(result.packet.coverage.actions).toMatchObject({ status: 'not_applicable' });
  expect(result.packet.sources.some((source) => source.id.startsWith('uv:source:'))).toBe(true);
});

test('gives the collectors the snapshot revision, exact roots, and the configured limits', async () => {
  vi.mocked(npmModule.collectNpmInventory).mockClear();
  vi.mocked(uvModule.collectUvMetadata).mockClear();
  const fixture = uvMetadataScenario('empty');
  const revision = fixture.input.configRevision;
  await uvPipeline((rev) => configured(rev, ['web'], ['py', '.']));
  expect(npmModule.collectNpmInventory).toHaveBeenCalledWith(
    expect.objectContaining({
      roots: ['web'],
      configRevision: revision,
      limits: W2_EVIDENCE_LIMITS.npm,
    }),
    expect.anything(),
  );
  expect(uvModule.collectUvMetadata).toHaveBeenCalledWith(
    expect.objectContaining({
      roots: ['py', '.'],
      configRevision: revision,
      limits: W2_EVIDENCE_LIMITS.uv,
    }),
    expect.anything(),
  );
});

test('passes no configured roots when the Dependabot file is absent', async () => {
  vi.mocked(npmModule.collectNpmInventory).mockClear();
  vi.mocked(uvModule.collectUvMetadata).mockClear();
  const { result } = await uvPipeline((revision) => ({
    kind: 'absent',
    revision: revision as never,
  }));
  expect(result.kind).toBe('ready');
  expect(npmModule.collectNpmInventory).toHaveBeenCalledWith(
    expect.objectContaining({ roots: [] }),
    expect.anything(),
  );
  expect(uvModule.collectUvMetadata).toHaveBeenCalledWith(
    expect.objectContaining({ roots: [] }),
    expect.anything(),
  );
});

test.each([
  ['an unreadable file', { kind: 'unavailable', reason: 'rate_limit' } as DependabotRootsOutcome],
  [
    'an unsupported ecosystem entry',
    {
      kind: 'roots',
      revision: {
        repository: { id: 101, owner: 'example', name: 'consumer' },
        sha: 'b'.repeat(40),
      },
      npm: { kind: 'unavailable', reason: 'rate_limit' },
      uv: { kind: 'unavailable', reason: 'rate_limit' },
    } as DependabotRootsOutcome,
  ],
])('reports %s as unavailable coverage without invoking the collector', async (_label, outcome) => {
  vi.mocked(npmModule.collectNpmInventory).mockClear();
  vi.mocked(uvModule.collectUvMetadata).mockClear();
  const { result } = await uvPipeline(() => outcome);
  if (result.kind !== 'ready') throw new Error(`expected a packet: ${JSON.stringify(result)}`);
  expect(result.packet.coverage.npm).toEqual({
    status: 'unavailable',
    reasons: ['rate_limit'],
    sourceIds: ['npm-roots-gap'],
  });
  expect(result.packet.coverage.uv).toEqual({
    status: 'unavailable',
    reasons: ['rate_limit'],
    sourceIds: ['uv-roots-gap'],
  });
  expect(npmModule.collectNpmInventory).not.toHaveBeenCalled();
  expect(uvModule.collectUvMetadata).not.toHaveBeenCalled();
});

test('never turns a collector without an inventory into an empty fragment', async () => {
  const fixture = uvMetadataScenario('empty');
  const { binding, configRevision } = fixture.input;
  const collectors = createEvidenceCollectors({
    binding,
    dependabot: configured(configRevision),
    registryFetch: async () => new Response(null, { status: 500 }),
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  const obsolete = {
    discoverFiles: async () => ({ kind: 'obsolete' }),
    readFile: async () => ({ kind: 'invalid' }),
    readComparison: async () => ({ kind: 'unavailable' }),
    close: () => undefined,
  } as unknown as GithubReadSession;
  // An obsolete read means the attempt's evidence moved underneath it, which is a conflict.
  for (const ecosystem of ['npm', 'actions', 'uv'] as const)
    await expect(collectors[ecosystem](obsolete)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'conflict',
    });
  await expect(
    assembleReviewPacket({
      trusted: {
        binding,
        baseSha: binding.baseSha,
        contextRevision: configRevision,
        context,
      },
      isCurrent: () => true,
      openSession: async () => obsolete,
      collectors,
      inventorySource: null,
    }),
  ).resolves.toEqual({ kind: 'incomplete', gaps: [{ source: 'npm', reason: 'conflict' }] });
});

test('keeps the registry capability separate from the GitHub fetch', async () => {
  const fixture = npmScenario(2, false, 'empty', true);
  const githubUrls: string[] = [];
  const registryUrls: string[] = [];
  const registryFetch = async (url: string) => {
    registryUrls.push(url);
    const [name, version] = new URL(url).pathname.slice(1).split('/').map(decodeURIComponent);
    return new Response(
      JSON.stringify({
        _id: `${name}@${version}`,
        name,
        version,
        dist: { integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}` },
        scripts: { install: version === '1.0.0' ? 'node old.js' : 'node new.js' },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const { binding } = fixture;
  const configRevision = fixture.expected.contextRevision;
  const collectors = createEvidenceCollectors({
    binding,
    dependabot: configured(configRevision),
    registryFetch,
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  const notApplicable = (ecosystem: 'actions' | 'uv') => async () => ({
    kind: 'complete' as const,
    ecosystem,
    coverage: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
    changes: [],
    sources: [],
    findings: [],
    relationships: [],
  });
  const result = await assembleReviewPacket({
    trusted: fixture.expected,
    isCurrent: () => true,
    openSession: async () => {
      const opened = await openEvidenceSession({
        binding,
        fetch: async (url, init) => {
          githubUrls.push(url);
          return fixture.fetch(url, init);
        },
        now: () => 0,
        deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
      });
      if (opened.kind !== 'ready') throw new Error('expected a D1 session');
      return opened.session;
    },
    collectors: { ...collectors, actions: notApplicable('actions'), uv: notApplicable('uv') },
    inventorySource: fixture.absent,
  });
  expect(result.kind, JSON.stringify(result)).toBe('ready');
  if (result.kind !== 'ready') return;
  expect(registryUrls.length).toBeGreaterThan(0);
  expect(registryUrls.every((url) => url.startsWith('https://registry.npmjs.org/'))).toBe(true);
  expect(githubUrls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
  expect(result.packet.findings.length).toBeGreaterThan(0);
  expect(result.packet.relationships.length).toBeGreaterThan(0);
});

test('maps a failed or exhausted session to unavailable instead of throwing', async () => {
  const fixture = uvMetadataScenario('empty');
  await expect(
    openEvidenceSession({
      binding: fixture.input.binding,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => 0,
      deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
    }),
  ).resolves.toEqual({ kind: 'unavailable' });
});

async function readySession() {
  const fixture = uvMetadataScenario('empty');
  const opened = await openEvidenceSession({
    binding: fixture.input.binding,
    fetch: fixture.fetch,
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  if (opened.kind !== 'ready') throw new Error('expected a D1 session');
  const { binding, configRevision } = fixture.input;
  return {
    session: opened.session,
    collectors: createEvidenceCollectors({
      binding,
      dependabot: configured(configRevision),
      registryFetch: async () => new Response('{}'),
      now: () => 0,
      deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
    }),
  };
}

test("forwards the uv graph's coverage, findings, and relationships unchanged", async () => {
  const { session, collectors } = await readySession();
  const graph = {
    kind: 'inventory',
    coverage: { status: 'available', reasons: [], sourceIds: ['s'] },
    changes: [{ id: 'c' }],
    sources: [{ id: 's' }],
    findings: [{ id: 'f' }],
    relationships: [{ id: 'r' }],
  };
  vi.mocked(uvGraphModule.reconcileUvGraph).mockReturnValueOnce(graph as never);
  await expect(collectors.uv(session)).resolves.toEqual({
    kind: 'complete',
    ecosystem: 'uv',
    coverage: graph.coverage,
    changes: graph.changes,
    sources: graph.sources,
    findings: graph.findings,
    relationships: graph.relationships,
  });
});

test.each([
  ['uv', { kind: 'unavailable', reason: 'budget' }],
  ['uv', { kind: 'invalid' }],
])('reports a %s graph result of %j as unavailable, not empty', async (_label, graph) => {
  const { session, collectors } = await readySession();
  vi.mocked(uvGraphModule.reconcileUvGraph).mockReturnValueOnce(graph as never);
  await expect(collectors.uv(session)).resolves.toEqual({
    kind: 'unavailable',
    reason: (graph as { reason?: string }).reason ?? 'malformed',
  });
});

test('reports an unusable N2 result as unavailable, not as the unenriched inventory', async () => {
  const fixture = npmScenario(2, false, 'empty', true);
  const opened = await openEvidenceSession({
    binding: fixture.binding,
    fetch: fixture.fetch,
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  if (opened.kind !== 'ready') throw new Error('expected a D1 session');
  const configRevision = fixture.expected.contextRevision;
  const collectors = createEvidenceCollectors({
    binding: fixture.binding,
    dependabot: configured(configRevision),
    registryFetch: async () => new Response('{}'),
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  vi.mocked(npmGraphModule.enrichNpmEvidence).mockResolvedValueOnce({
    kind: 'unavailable',
    reason: 'budget',
  } as never);
  await expect(collectors.npm(opened.session)).resolves.toEqual({
    kind: 'unavailable',
    reason: 'budget',
  });
});

test.each([
  ['the time left before the deadline', 100_000, 40_000, 60_000],
  ['the full 240,000 ms when more than that remains', 900_000, 0, 240_000],
])('limits the session to %s', async (_label, deadline, now, expected) => {
  vi.mocked(readModule.createGithubReadSession).mockClear();
  const fixture = uvMetadataScenario('empty');
  await openEvidenceSession({
    binding: fixture.input.binding,
    fetch: fixture.fetch,
    now: () => now,
    deadline,
  });
  expect(readModule.createGithubReadSession).toHaveBeenCalledWith(
    expect.objectContaining({
      limits: expect.objectContaining({
        totalTimeoutMs: expected,
        maxRequests: 160,
        maxTotalBytes: 12 * 1024 * 1024,
      }),
    }),
    expect.anything(),
  );
});

test.each([
  ['the time left before the deadline', 100_000, 40_000, 60_000],
  ['the full 240,000 ms when more than that remains', 900_000, 0, 240_000],
])(
  'limits registry enrichment to %s and the registry allocation',
  async (_label, deadline, now, expected) => {
    const fixture = npmScenario(2, false, 'empty', true);
    const opened = await openEvidenceSession({
      binding: fixture.binding,
      fetch: fixture.fetch,
      now: () => 0,
      deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
    });
    if (opened.kind !== 'ready') throw new Error('expected a D1 session');
    const configRevision = fixture.expected.contextRevision;
    const collectors = createEvidenceCollectors({
      binding: fixture.binding,
      dependabot: configured(configRevision),
      registryFetch: async () => new Response('{}'),
      now: () => now,
      deadline,
    });
    vi.mocked(npmGraphModule.enrichNpmEvidence).mockClear();
    await collectors.npm(opened.session);
    expect(npmGraphModule.enrichNpmEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: expect.objectContaining({
          totalTimeoutMs: expected,
          maxRequests: 64,
          maxTotalBytes: 4 * 1024 * 1024,
        }),
      }),
      expect.anything(),
    );
  },
);

test('hands the authentic npm inventory to the caller for upstream research', async () => {
  const fixture = npmScenario(2, false, 'empty', true);
  const opened = await openEvidenceSession({
    binding: fixture.binding,
    fetch: fixture.fetch,
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  if (opened.kind !== 'ready') throw new Error('expected a D1 session');
  const configRevision = fixture.expected.contextRevision;
  const seen: unknown[] = [];
  const collectors = createEvidenceCollectors({
    binding: fixture.binding,
    dependabot: configured(configRevision),
    registryFetch: async () => new Response('{}'),
    onNpmInventory: (inventory) => seen.push(inventory),
    now: () => 0,
    deadline: W2_EVIDENCE_LIMITS.totalTimeoutMs,
  });
  await collectors.npm(opened.session);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: 'inventory', binding: fixture.binding });
});

test('opens the evidence session with a request timeout no longer than the time left', async () => {
  vi.mocked(readModule.createGithubReadSession).mockClear();
  const fixture = uvMetadataScenario('empty');
  const opened = await openEvidenceSession({
    binding: fixture.input.binding,
    fetch: fixture.fetch,
    now: () => 0,
    deadline: 5_000,
  });
  expect(opened.kind).toBe('ready');
  expect(readModule.createGithubReadSession).toHaveBeenCalledWith(
    expect.objectContaining({
      limits: expect.objectContaining({ totalTimeoutMs: 5_000, requestTimeoutMs: 5_000 }),
    }),
    expect.anything(),
  );
});
