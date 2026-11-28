import { afterEach, expect, test, vi } from 'vite-plus/test';
import * as limitsModule from '../limits.js';
import {
  AdvisoryFailure,
  createAdvisoryReader,
  type AdvisoryReader,
  type AdvisoryTarget,
} from './advisory-read.js';
import { enrichAdvisories, prepareAdvisoryInput, resolveAdvisoryTarget } from './advisories.js';
import { limit } from '../limits.js';
import { createGithubReadSession } from '../github-read.js';
import { collectNpmInventory } from './npm.js';
import { validateReviewPacket, type PacketChange, type PacketSource } from '../schema.js';
import { npmScenario } from '../../tests/parity/npm-inventory.js';
import {
  collectAdvisoryActions,
  collectAdvisoryNpm,
  collectMixedAdvisoryInventories,
} from '../../tests/parity/advisories.js';

// Wraps the register lookup in a pass-through mock, so one test can lower a single limit. Each
// test ends with the real lookup restored, so no override reaches another test.
vi.mock('../limits.js', async (original) => {
  const actual = await original<typeof import('../limits.js')>();
  return { ...actual, limit: vi.fn(actual.limit) };
});
afterEach(() => {
  // mockReset returns a vi.fn to the implementation it was created with: the real lookup.
  vi.mocked(limitsModule.limit).mockReset();
});

export const advisoryLimits = {
  maxRequests: 20,
  maxPages: 20,
  maxResponseBytes: 50_000,
  maxTotalBytes: 500_000,
  maxJsonEntries: 20_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 500_000,
  maxFindings: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const advisory = {
  ghsa_id: 'GHSA-aaaa-bbbb-cccc',
  html_url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  summary: 'Synthetic vulnerability',
  type: 'reviewed',
  severity: 'high',
  withdrawn_at: null,
  vulnerabilities: [
    { package: { ecosystem: 'npm', name: 'fixture-anchor' }, vulnerable_version_range: '>=1.1.0' },
  ],
};
/** The `affects` targets of a query; a batch returns the records that affect any of them. */
function affects(url: string): string[];
function affects(url: string, target: string): boolean;
function affects(url: string, target?: string) {
  const targets = new URL(url).searchParams.get('affects')!.split(',');
  return target === undefined ? targets : targets.includes(target);
}
async function fixture(both = false, additions = 1) {
  const f = npmScenario(additions);
  const opened = await createGithubReadSession(
    {
      binding: f.binding,
      limits: {
        ...advisoryLimits,
        maxFiles: 100,
        maxFileBytes: 50_000,
      },
    },
    { fetch: f.fetch, now: () => 0 },
  );
  if (opened.kind !== 'ready') throw new Error('expected session');
  try {
    const inventory = await collectNpmInventory(
      {
        binding: f.binding,
        roots: ['.'],
        configRevision: f.expected.contextRevision,
        limits: {
          maxFileBytes: 50_000,
          maxJsonEntries: 20_000,
          maxJsonDepth: 32,
          maxRoots: 10,
          maxRetainedBytes: 500_000,
        },
      },
      { session: opened.session },
    );
    if (inventory.kind !== 'inventory') throw new Error('expected inventory');
    const proofs: PacketSource[] = [];
    const publicIdentities = inventory.changes.flatMap((c) =>
      (['head', ...(both ? ['base' as const] : [])] as const).flatMap((side) => {
        if (c.ecosystem !== 'npm' || 'basis' in c) return [];
        const s = side === 'head' ? c.to : c.from;
        if (!s) return [];
        const id = 'public:' + c.id + ':' + side;
        proofs.push({
          id,
          kind: 'metadata',
          ecosystems: ['npm'],
          memberIds: [c.id],
          status: 'available',
          reasons: [],
          provenance: {
            kind: 'upstream',
            url: `https://registry.npmjs.org/${s.name}/${s.version}`,
            title: 'Synthetic public identity proof',
            excerpt: 'Synthetic exact public metadata.',
            excerptTruncated: false,
            subjects: [{ memberId: c.id, side, value: s.version }],
            range: {
              from: side === 'base' ? s.version : null,
              to: side === 'head' ? s.version : null,
            },
          },
        });
        return [
          {
            memberId: c.id,
            side,
            ecosystem: 'npm' as const,
            name: s.name,
            version: s.version,
            sourceIdentity: s.source.identity,
            sourceIds: [id],
          },
        ];
      }),
    );
    const input = {
      binding: f.binding,
      changes: inventory.changes,
      sources: [...inventory.sources, ...proofs],
      findings: [],
      publicIdentities,
      limits: advisoryLimits,
    };
    return { f, inventory, input };
  } finally {
    opened.session.close();
  }
}
test.each([true, false])(
  'exact npm %s evidence passes actual T4 without changing inventory',
  async (positive) => {
    const { f, inventory, input } = await fixture();
    const requests: { url: string; init: RequestInit }[] = [];
    const reader = createAdvisoryReader(advisoryLimits, {
      now: () => 0,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json(positive && affects(url, 'fixture-anchor@1.1.0') ? [advisory] : []);
      },
    });
    if (reader.kind !== 'ready') throw new Error('expected reader');
    const output = await enrichAdvisories(input, { reader });
    reader.close();
    expect(output.kind).toBe('enriched');
    if (output.kind !== 'enriched') throw new Error('expected evidence');
    expect(output.findings).toHaveLength(positive ? 1 : 0);
    // The review renderer refuses a blocking finding that names no remediation or validation step.
    for (const finding of output.findings) {
      expect(finding.remediation.length).toBeGreaterThan(0);
      expect(finding.validation.length).toBeGreaterThan(0);
      expect(finding.remediation.join(' ')).toContain('fixture-anchor');
    }
    expect(output.changes.every((c) => c.evidence.vulnerability.status === 'available')).toBe(true);
    expect(inventory.changes.every((c) => c.evidence.vulnerability.status === 'unavailable')).toBe(
      true,
    );
    const { kind: _kind, lookups: _lookups, ...fields } = output;
    const accepted = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        ...fields,
        relationships: [],
        reachability: [],
        retryAfter: null,
        sources: [...output.sources, f.absent],
        coverage: {
          npm: inventory.coverage,
          actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        },
      },
      f.expected,
    );
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(Object.isFrozen(output.changes)).toBe(true);
    // Both head targets are settled by one batch; a record naming one package is attributed.
    expect(requests).toHaveLength(1);
    expect(requests[0].init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(new URL(requests[0].url).origin).toBe('https://api.github.com');
  },
);

test('missing public identity stays unknown without disclosing a guessed package', async () => {
  const { input } = await fixture();
  let calls = 0;
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('expected reader');
  const result = await enrichAdvisories({ ...input, publicIdentities: [] }, { reader });
  reader.close();
  expect(result.kind).toBe('enriched');
  if (result.kind === 'enriched')
    expect(result.changes[0].evidence.vulnerability).toMatchObject({
      status: 'unavailable',
      reasons: ['unsupported'],
    });
  expect(calls).toBe(0);
});

test.each([
  ['empty', 'hit', 'affects_proposed', true],
  ['hit', 'hit', 'affects_proposed', false],
  ['fail', 'hit', 'affects_proposed', false],
  ['hit', 'empty', 'resolved_by_proposed', false],
  ['hit', 'fail', null, false],
  ['empty', 'empty', null, false],
] as const)(
  'base %s / head %s retains only proved conclusions',
  async (base, head, applicability, introduced) => {
    const { input, f, inventory } = await fixture(true);
    const reader = createAdvisoryReader(advisoryLimits, {
      now: () => 0,
      fetch: async (url) => {
        const query = affects(url).find((a) => a.startsWith('fixture-anchor@'));
        if (!query) return Response.json([]);
        const mode = query.endsWith('@1.0.0') ? base : head;
        return mode === 'fail'
          ? Response.json({}, { status: 500 })
          : Response.json(mode === 'hit' ? [advisory] : []);
      },
    });

    if (reader.kind !== 'ready') throw new Error('reader');
    const output = await enrichAdvisories(input, { reader });
    reader.close();
    if (output.kind !== 'enriched') throw new Error('evidence');
    expect(output.findings).toHaveLength(applicability ? 1 : 0);
    if (applicability) {
      expect(output.findings[0]).toMatchObject({ applicability });
      expect(output.findings[0].rationale.includes('introduces')).toBe(introduced);
    }
    expect(output.changes[0].evidence.vulnerability.status).toBe(
      head === 'fail' ? 'unavailable' : 'available',
    );
    const accepted = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes: output.changes,
        sources: [...output.sources, f.absent],
        findings: output.findings,
        relationships: [],
        reachability: [],
        retryAfter: null,
        coverage: {
          npm: inventory.coverage,
          actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        },
      },
      f.expected,
    );
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  },
);

test('bounded comparison positives survive a failed global lookup with an explicit gap', async () => {
  const { input, f } = await fixture();
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => Response.json({}, { status: 500 }),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const comparisons = [
    {
      kind: 'available' as const,
      repository: f.binding.repository,
      headRepository: f.binding.headRepository,
      baseSha: f.binding.baseSha,
      headSha: f.binding.headSha,
      mergeBaseSha: f.binding.mergeBaseSha,
      reasons: [],
      records: [
        {
          manifest: 'package-lock.json',
          ecosystem: 'npm',
          name: 'fixture-anchor',
          version: '1.1.0',
          change_type: 'added',
          vulnerabilities: [
            {
              severity: 'high',
              advisory_ghsa_id: advisory.ghsa_id,
              advisory_url: advisory.html_url,
              advisory_summary: advisory.summary,
            },
          ],
        },
      ],
    },
  ];
  const output = await enrichAdvisories({ ...input, comparisons }, { reader });
  reader.close();
  if (output.kind !== 'enriched') throw new Error('evidence');
  expect(output.findings).toHaveLength(1);
  expect(output.findings[0]).toMatchObject({ applicability: 'affects_proposed', severity: 'high' });
  expect(output.changes[0].evidence.vulnerability.status).toBe('partial');
});

test.each([false, true])(
  'duplicate GHSA records are reconciled; conflict=%s retains independent findings',
  async (conflict) => {
    const { input, f, inventory } = await fixture();
    const independent = {
      ...advisory,
      ghsa_id: 'GHSA-dddd-eeee-ffff',
      html_url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
    };
    const reader = createAdvisoryReader(advisoryLimits, {
      now: () => 0,
      fetch: async (url) =>
        Response.json(
          affects(url, 'fixture-anchor@1.1.0')
            ? [advisory, { ...advisory, severity: conflict ? 'low' : 'high' }, independent]
            : [],
        ),
    });
    if (reader.kind !== 'ready') throw new Error('reader');
    const output = await enrichAdvisories(input, { reader });
    reader.close();
    if (output.kind !== 'enriched') throw new Error('enrichment');
    expect(output.findings).toHaveLength(conflict ? 1 : 2);
    expect(output.changes[0].evidence.vulnerability.status).toBe(
      conflict ? 'partial' : 'available',
    );
    const accepted = validateReviewPacket(
      {
        version: 1,
        ...f.expected,
        changes: output.changes,
        sources: [...output.sources, f.absent],
        findings: output.findings,
        relationships: [],
        reachability: [],
        retryAfter: null,
        coverage: {
          npm: inventory.coverage,
          actions: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
          uv: { status: 'not_applicable', reasons: [], sourceIds: ['other'] },
        },
      },
      f.expected,
    );
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  },
);

test('retention limits preserve original findings and mark omitted new evidence as budget gaps', async () => {
  const { input } = await fixture();
  const old = {
    id: 'retained-original',
    memberId: input.changes[0].id,
    kind: 'informational' as const,
    detail: 'Original fact',
    references: [input.changes[0].to!.sourceId],
    rationale: 'Original fact',
    remediation: [],
    validation: [],
  };
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () =>
      Response.json([
        advisory,
        {
          ...advisory,
          ghsa_id: 'GHSA-dddd-eeee-ffff',
          html_url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
        },
      ]),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const output = await enrichAdvisories(
    { ...input, findings: [old], limits: { ...advisoryLimits, maxFindings: 1 } },
    { reader },
  );
  reader.close();
  expect(output.kind).toBe('enriched');
  if (output.kind !== 'enriched') throw new Error('enrichment');
  expect(output.findings).toContainEqual(old);
  expect(output.changes[0].evidence.vulnerability.reasons).toContain('budget');
});

test('input getters and conflicting eligibility proofs cannot run or disclose package names', async () => {
  const { input } = await fixture();
  let executed = 0,
    calls = 0;
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const hostile = Object.defineProperty({ ...input }, 'limits', {
    get() {
      executed++;
      return advisoryLimits;
    },
  });
  expect(await enrichAdvisories(hostile, { reader })).toEqual({ kind: 'invalid' });
  expect(executed).toBe(0);
  expect(
    await enrichAdvisories(
      {
        ...input,
        publicIdentities: [
          ...input.publicIdentities,
          { ...input.publicIdentities[0], name: 'private-name' },
        ],
      },
      { reader },
    ),
  ).toEqual({ kind: 'invalid' });
  reader.close();
  expect(calls).toBe(0);
});

test('duplicate semantic instances and dangling references fail before I/O', async () => {
  const { input } = await fixture();
  let calls = 0;
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  const duplicate = { ...input.changes[0], id: 'duplicate-instance' };
  const sources = input.sources.map((s) =>
    s.kind === 'file' && s.memberIds.includes(input.changes[0].id)
      ? { ...s, memberIds: [...s.memberIds, duplicate.id] }
      : s,
  );
  expect(
    await enrichAdvisories(
      { ...input, changes: [...input.changes, duplicate], sources },
      { reader },
    ),
  ).toEqual({ kind: 'invalid' });
  expect(
    await enrichAdvisories(
      {
        ...input,
        publicIdentities: [{ ...input.publicIdentities[0], sourceIds: ['missing-proof'] }],
      },
      { reader },
    ),
  ).toEqual({ kind: 'invalid' });
  expect(calls).toBe(0);
  reader.close();
});

function realReader(): AdvisoryReader {
  const reader = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async (url) => Response.json(affects(url, 'fixture-anchor@1.1.0') ? [advisory] : []),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  return reader;
}
/** Delegates to the real reader; `fail` throws a malformed read, `stopAfter` stops after N reads. */
function scriptedReader(
  options: { fail?: (target: AdvisoryTarget) => boolean; stopAfter?: number } = {},
): AdvisoryReader {
  const real = realReader();
  let reads = 0;
  return {
    read: async (target) => {
      reads++;
      if (options.fail?.(target as AdvisoryTarget)) throw new AdvisoryFailure('malformed');
      return real.read(target);
    },
    settle: (targets) => real.settle!(targets),
    close: () => real.close(),
    stopped: () =>
      options.stopAfter !== undefined && reads >= options.stopAfter ? 'rate_limit' : null,
  };
}
function vulnerability(output: { changes: readonly PacketChange[] }, id: string) {
  return output.changes.find((c) => c.id === id)!.evidence.vulnerability;
}

test("one member's read failure leaves the others intact", async () => {
  const { input } = await fixture(false, 3);
  const members = input.changes.filter((c) => !('basis' in c));
  const second = members[1];
  const failName = ((second.to ?? second.from) as { name: string }).name;
  const baseline = await enrichAdvisories(input, { reader: scriptedReader() });
  const result = await enrichAdvisories(input, {
    reader: scriptedReader({ fail: (t) => t.name === failName }),
  });
  if (baseline.kind !== 'enriched' || result.kind !== 'enriched') throw new Error('evidence');
  expect(result.stopped).toBeUndefined();
  const failed = vulnerability(result, second.id);
  expect(failed).toEqual({
    status: 'unavailable',
    reasons: ['malformed'],
    sourceIds: [expect.any(String)],
  });
  expect(result.sources.map((s) => s.id)).toContain(failed.sourceIds[0]);
  for (const member of members.filter((c) => c.id !== second.id))
    expect(vulnerability(result, member.id)).toEqual(vulnerability(baseline, member.id));
});

test("a failed member's partial additions are removed", async () => {
  const { input } = await fixture(true, 3);
  const anchor = input.changes.find((c) => !('basis' in c) && c.from && c.to)!;
  const fromSide = anchor.from as { name: string; version: string };
  const baseline = await enrichAdvisories(input, { reader: scriptedReader() });
  const result = await enrichAdvisories(input, {
    reader: scriptedReader({
      fail: (t) => t.name === fromSide.name && t.version === fromSide.version,
    }),
  });
  if (baseline.kind !== 'enriched' || result.kind !== 'enriched') throw new Error('evidence');
  const inputSourceIds = new Set(input.sources.map((s) => s.id));
  const appended = (output: { sources: readonly PacketSource[] }) =>
    output.sources
      .filter((s) => !inputSourceIds.has(s.id) && s.memberIds.includes(anchor.id))
      .map((s) => s.id);
  // The all-success run appends several sources for this member, so the rollback is observable.
  expect(appended(baseline).length).toBeGreaterThan(1);
  const failed = vulnerability(result, anchor.id);
  expect(failed).toEqual({
    status: 'unavailable',
    reasons: ['malformed'],
    sourceIds: [expect.any(String)],
  });
  expect(appended(result)).toEqual(failed.sourceIds);
  expect(result.lookups.filter((l) => l.memberId === anchor.id && l.lookup !== null)).toEqual([]);
});

const BATCHED = 'A complete batched query checked reviewed advisories for this target.';
const lookupSources = (output: { sources: readonly PacketSource[] }) =>
  output.sources.filter(
    (s) => s.kind === 'advisory' && s.provenance.kind === 'upstream' && !s.provenance.advisoryId,
  );
/** A reader over `answer`, recording every URL it sends; `batched: false` drops the pre-pass. */
function recordingReader(
  answer: (url: URL) => Response,
  options: { batched?: boolean; limits?: typeof advisoryLimits } = {},
) {
  const sent: string[] = [];
  const reader = createAdvisoryReader(options.limits ?? advisoryLimits, {
    now: () => 0,
    fetch: async (url) => (sent.push(url), answer(new URL(url))),
  });
  if (reader.kind !== 'ready') throw new Error('reader');
  return { sent, reader: options.batched === false ? { ...reader, settle: undefined } : reader };
}

test('the pre-pass settles both sides, cites each singleton URL, and sends fewer requests', async () => {
  const { input } = await fixture(true, 3);
  const empty = () => Response.json([]);
  const plain = recordingReader(empty, { batched: false });
  const batched = recordingReader(empty);
  const before = await enrichAdvisories(input, { reader: plain.reader });
  const after = await enrichAdvisories(input, { reader: batched.reader });
  if (before.kind !== 'enriched' || after.kind !== 'enriched') throw new Error('evidence');
  expect(batched.sent.length).toBeLessThan(plain.sent.length);
  const cleared = lookupSources(after);
  // Every lookup of both sides was cleared by a batch, so none was read alone.
  expect(cleared.length).toBe(plain.sent.length);
  const sides = new Set<string>();
  for (const source of cleared) {
    if (source.provenance.kind !== 'upstream') throw new Error('provenance');
    expect(source.provenance.excerpt).toBe(BATCHED);
    for (const subject of source.provenance.subjects) sides.add(subject.side);
    // The cited URL is the singleton the unbatched run fetched. The batched run sends it at most
    // once, as a batch of one, which shares its singleton's URL.
    const cited = source.provenance.url;
    expect(plain.sent).toContain(cited);
    expect(batched.sent.filter((u) => u === cited).length).toBeLessThanOrEqual(1);
  }
  expect(sides).toEqual(new Set(['base', 'head']));
  // Apart from that text, the packet fields are the same; `lookups` are diagnostics.
  const packet = ({ changes, sources, findings }: typeof after) => ({ changes, sources, findings });
  const restored = JSON.parse(
    JSON.stringify(packet(after)).replaceAll(
      BATCHED,
      'The complete exact-version query checked reviewed advisories for this target.',
    ),
  );
  expect(restored).toEqual(JSON.parse(JSON.stringify(packet(before))));
});

test("the pre-pass's requests are charged to the stage's reader share, not to members", async () => {
  const { input } = await fixture(false, 3);
  const members = input.changes.filter((c) => !('basis' in c));
  expect(members.length).toBeGreaterThan(1);
  const limits = { ...advisoryLimits, maxRequests: 1, maxPages: 1 };
  const empty = () => Response.json([]);
  const batched = recordingReader(empty, { limits });
  const plain = recordingReader(empty, { limits, batched: false });
  const settled = await enrichAdvisories(input, { reader: batched.reader });
  const alone = await enrichAdvisories(input, { reader: plain.reader });
  if (settled.kind !== 'enriched' || alone.kind !== 'enriched') throw new Error('evidence');
  // One batch request, within the share, settles every member; read alone, the share runs out.
  expect(batched.sent).toHaveLength(1);
  for (const member of members) expect(vulnerability(settled, member.id).status).toBe('available');
  expect(members.some((m) => vulnerability(alone, m.id).reasons.includes('budget'))).toBe(true);
});

test('a failed singleton for a record naming two batched packages fails only its member', async () => {
  const { input } = await fixture(false, 3);
  const members = input.changes.filter((c) => !('basis' in c) && c.to);
  const [failing, partner] = members.map((c) => c.to as { name: string; version: string });
  const failed = members[0];
  const shared = {
    ...advisory,
    vulnerabilities: [failing, partner].map((t) => ({
      package: { ecosystem: 'npm', name: t.name },
      vulnerable_version_range: '>=99.0.0',
    })),
  };
  const answer = (fail: boolean) => (url: URL) => {
    const targets = url.searchParams.get('affects')!.split(',');
    // A batch lists more than one target; a singleton lists one.
    if (targets.length > 1)
      return Response.json(targets.includes(`${failing.name}@${failing.version}`) ? [shared] : []);
    return fail && targets[0] === `${failing.name}@${failing.version}`
      ? Response.json({}, { status: 500 })
      : Response.json([]);
  };
  const baseline = recordingReader(answer(false));
  const run = recordingReader(answer(true));
  const expected = await enrichAdvisories(input, { reader: baseline.reader });
  const result = await enrichAdvisories(input, { reader: run.reader });
  if (expected.kind !== 'enriched' || result.kind !== 'enriched') throw new Error('evidence');
  // Both named packages got their singleton; only the failed one lost its coverage.
  expect(
    run.sent.filter((u) => new URL(u).searchParams.get('affects')!.split(',').length === 1),
  ).toHaveLength(2);
  expect(vulnerability(result, failed.id)).toMatchObject({ status: 'unavailable' });
  for (const member of input.changes.filter((c) => !('basis' in c) && c.id !== failed.id))
    expect(vulnerability(result, member.id)).toEqual(vulnerability(expected, member.id));
  expect(vulnerability(expected, failed.id).status).toBe('available');
});

test('a failed versioned query after a discovery batch hit fails only its member', async () => {
  const f = await collectAdvisoryActions(true);
  const record = (name: string) => ({
    ...advisory,
    vulnerabilities: [
      { package: { ecosystem: 'actions', name }, vulnerable_version_range: '>=2.0.0' },
    ],
  });
  const hit = 'chromaui/action';
  const answer = (fail: boolean) => (url: URL) => {
    const targets = url.searchParams.get('affects')!.split(',');
    // A discovery query is package-only: no `affects` entry names a version.
    if (targets.every((target) => !target.includes('@')))
      return Response.json(targets.includes(hit) ? [record(hit)] : []);
    return fail && targets[0].startsWith(hit + '@')
      ? Response.json({}, { status: 500 })
      : Response.json([]);
  };
  const baseline = recordingReader(answer(false));
  const run = recordingReader(answer(true));
  const expected = await enrichAdvisories(f.input, { reader: baseline.reader });
  const result = await enrichAdvisories(f.input, { reader: run.reader });
  if (expected.kind !== 'enriched' || result.kind !== 'enriched') throw new Error('evidence');
  const failed = f.input.changes.filter(
    (c) => c.to && 'action' in c.to && c.to.action.startsWith(hit),
  );
  expect(failed.length).toBeGreaterThan(0);
  for (const change of f.input.changes) {
    if (failed.includes(change)) {
      expect(vulnerability(result, change.id)).toMatchObject({ status: 'unavailable' });
      expect(vulnerability(expected, change.id).status).toBe('available');
    } else expect(vulnerability(result, change.id)).toEqual(vulnerability(expected, change.id));
  }
  // The cleared members cite their unfetched versioned URL, never the discovery URL.
  const cleared = lookupSources(result).filter(
    (s) => s.provenance.kind === 'upstream' && s.provenance.excerpt === BATCHED,
  );
  expect(cleared.length).toBeGreaterThan(0);
  for (const source of cleared) {
    if (source.provenance.kind !== 'upstream') continue;
    expect(new URL(source.provenance.url).searchParams.get('per_page')).toBe('100');
    expect(run.sent).not.toContain(source.provenance.url);
  }
});

test('a stopped reader keeps completed members and marks the rest', async () => {
  const { input } = await fixture(false, 3);
  const members = input.changes.filter((c) => !('basis' in c));
  const baseline = await enrichAdvisories(input, { reader: scriptedReader() });
  const result = await enrichAdvisories(input, { reader: scriptedReader({ stopAfter: 1 }) });
  if (baseline.kind !== 'enriched' || result.kind !== 'enriched') throw new Error('evidence');
  expect(result.stopped).toBe('rate_limit');
  const [first, ...later] = members;
  expect(later.length).toBeGreaterThanOrEqual(2);
  expect(vulnerability(result, first.id)).toEqual(vulnerability(baseline, first.id));
  for (const member of later)
    expect(vulnerability(result, member.id)).toMatchObject({
      status: 'unavailable',
      reasons: ['rate_limit'],
    });
});

test('accepts exactly advisories.maxLookups public identities and refuses one more', async () => {
  const { input } = await fixture(true);
  const anchor = input.changes.find(
    (c) =>
      c.ecosystem === 'npm' &&
      c.from &&
      c.to &&
      input.publicIdentities.some((p) => p.memberId === c.id && p.side === 'base'),
  )!;
  // Two lookups per change, one per side: packet.changes two-sided changes reach the cap. Each copy
  // is a distinct package with its own copy of the anchor's lock file sources (copy 0 is the anchor).
  const copies = limit('advisories.maxLookups') / 2;
  const sides = ['base', 'head'] as const;
  const fileSources = input.sources.filter(
    (s) => !s.id.startsWith('public:') && s.memberIds.includes(anchor.id),
  );
  const copy = (i: number) => ({
    id: i === 0 ? anchor.id : `${anchor.id}#${i}`,
    suffix: i === 0 ? '' : `#${i}`,
    name: (name: string) => (i === 0 ? name : `${name}-copy-${i}`),
  });
  const plan = Array.from({ length: copies }, (_, i) => copy(i));
  const changes = plan.map(({ id, suffix, name }) => ({
    ...anchor,
    id,
    from: {
      ...anchor.from!,
      name: name((anchor.from as { name: string }).name),
      sourceId: anchor.from!.sourceId + suffix,
    },
    to: {
      ...anchor.to!,
      name: name((anchor.to as { name: string }).name),
      sourceId: anchor.to!.sourceId + suffix,
    },
  })) as PacketChange[];
  const inventorySources = plan.flatMap(({ id, suffix }) =>
    fileSources.map((s) => ({ ...s, id: s.id + suffix, memberIds: [id] })),
  );
  const identities = plan.flatMap(({ id, name }) =>
    sides.map((side) => {
      const original = input.publicIdentities.find(
        (p) => p.memberId === anchor.id && p.side === side,
      )!;
      return {
        ...original,
        memberId: id,
        name: name(original.name),
        sourceIds: [`public:${id}:${side}`],
      };
    }),
  );
  const proofs = plan.flatMap(({ id }) =>
    sides.map((side) => {
      const original = input.sources.find((s) => s.id === `public:${anchor.id}:${side}`)!;
      const provenance = original.provenance as Extract<
        PacketSource['provenance'],
        { kind: 'upstream' }
      >;
      return {
        ...original,
        id: `public:${id}:${side}`,
        memberIds: [id],
        provenance: {
          ...provenance,
          subjects: provenance.subjects.map((subject) => ({ ...subject, memberId: id })),
        },
      };
    }),
  );
  const atLimit = {
    ...input,
    // Room to copy the larger input, so the copy budget is not what stops it.
    limits: { ...input.limits, maxJsonEntries: 200_000, maxRetainedBytes: 5_000_000 },
    changes,
    sources: [...inventorySources, ...proofs],
    publicIdentities: identities,
  };
  expect(identities).toHaveLength(limit('advisories.maxLookups'));
  expect(prepareAdvisoryInput(atLimit).ok).toBe(true);
  // At the real cap, a lookup past it must repeat a (member, side) pair, since packet.changes caps
  // the changes, so the uniqueness check would refuse it too. With the cap one below these unique
  // pairs, only the length check can refuse them.
  const actual = await vi.importActual<typeof import('../limits.js')>('../limits.js');
  const lowered = identities.length - 1;
  vi.mocked(limitsModule.limit).mockImplementation((id) =>
    id === 'advisories.maxLookups' ? lowered : actual.limit(id),
  );
  expect(prepareAdvisoryInput(atLimit).ok).toBe(false);
  const atLowered = { ...atLimit, publicIdentities: identities.slice(0, lowered) };
  expect(prepareAdvisoryInput(atLowered).ok).toBe(true);
});

/** The packet fields of an enrichment, with batched source text read as the singleton's. */
function asUnbatched(output: Awaited<ReturnType<typeof enrichAdvisories>>) {
  if (output.kind !== 'enriched') throw new Error('evidence');
  const { changes, sources, findings } = output;
  return JSON.parse(
    JSON.stringify({ changes, sources, findings }).replaceAll(
      BATCHED,
      'The complete exact-version query checked reviewed advisories for this target.',
    ),
  );
}

test.each(['none', 'head', 'base'] as const)(
  'a reader stopping after the pre-pass keeps each settled side; failed %s batch',
  async (failed) => {
    const { input: collected } = await fixture(true, 3);
    // The two-sided anchor goes last, so it is researched after the stop.
    const anchor = collected.changes.find((c) => !('basis' in c) && c.from && c.to)!;
    const input = {
      ...collected,
      changes: [...collected.changes.filter((c) => c !== anchor), anchor],
    };
    const members = input.changes.filter((c) => !('basis' in c));
    const sideOf = (c: (typeof members)[number], side: 'head' | 'base') => {
      const s = (side === 'head' ? c.to : c.from) as { name: string; version: string } | null;
      return s ? [`${s.name}@${s.version}`] : [];
    };
    const failing = new Set(failed === 'none' ? [] : members.flatMap((c) => sideOf(c, failed)));
    // Only the pre-pass's batches fail; singletons answer. A batch of one shares its singleton's
    // URL, so the batches are told apart by when they are sent.
    let settling = false;
    const answer = (url: URL) =>
      settling &&
      url.searchParams
        .get('affects')!
        .split(',')
        .some((a) => failing.has(a))
        ? Response.json({}, { status: 500 })
        : Response.json([]);
    const prePass = (r: AdvisoryReader): AdvisoryReader => ({
      ...r,
      settle: async (values) => {
        settling = true;
        try {
          return (await r.settle?.(values)) ?? null;
        } finally {
          settling = false;
        }
      },
    });
    const baseline = await enrichAdvisories(input, {
      reader: prePass(recordingReader(answer).reader),
    });
    const real = prePass(recordingReader(answer).reader);
    let reads = 0,
      stop = false;
    // Stops after the first member, as a rate limit would; like the real reader, a stopped
    // reader still answers a settled target and refuses every other one with the stop reason.
    const reader: AdvisoryReader = {
      ...real,
      read: async (target) => {
        reads++;
        if (stop && !real.isSettled!(target))
          return {
            target: target as AdvisoryTarget,
            url: '',
            status: 'unavailable',
            complete: false,
            records: [],
            reasons: ['rate_limit'],
          };
        return real.read(target);
      },
      stopped: () => {
        stop = reads > 0;
        return stop ? 'rate_limit' : null;
      },
    };
    const result = await enrichAdvisories(input, { reader });
    if (baseline.kind !== 'enriched' || result.kind !== 'enriched') throw new Error('evidence');
    expect(result.stopped).toBe('rate_limit');
    const [first, ...later] = members;
    expect(later.length).toBeGreaterThanOrEqual(2);
    expect(vulnerability(result, first.id)).toEqual(vulnerability(baseline, first.id));
    const lookup = (output: typeof result, side: 'head' | 'base') =>
      output.lookups.find((l) => l.memberId === anchor.id && l.side === side);
    for (const member of later.filter((c) => c !== anchor))
      if (failed === 'head')
        expect(vulnerability(result, member.id)).toMatchObject({
          status: 'unavailable',
          reasons: ['rate_limit'],
        });
      else expect(vulnerability(result, member.id)).toEqual(vulnerability(baseline, member.id));
    // The anchor keeps its settled side and loses only the unsettled one to the stop.
    for (const side of ['head', 'base'] as const)
      if (side === failed) expect(lookup(result, side)?.reasons).toEqual(['rate_limit']);
      else expect(lookup(result, side)).toEqual(lookup(baseline, side));
    if (failed === 'head')
      expect(vulnerability(result, anchor.id)).toMatchObject({ reasons: ['rate_limit'] });
    else expect(vulnerability(result, anchor.id)).toEqual(vulnerability(baseline, anchor.id));
  },
);

test.each(['throws', 'returns null'] as const)(
  'a pre-pass that %s leaves the packet as an unbatched run makes it',
  async (mode) => {
    const { input } = await fixture(true, 3);
    const empty = () => Response.json([]);
    const plain = recordingReader(empty, { batched: false });
    const failing = recordingReader(empty);
    const reader: AdvisoryReader = {
      ...failing.reader,
      settle: async () => {
        if (mode === 'throws') throw new Error('settle');
        return null;
      },
    };
    const expected = await enrichAdvisories(input, { reader: plain.reader });
    const result = await enrichAdvisories(input, { reader });
    expect(result).toEqual(expected);
    expect(failing.sent).toEqual(plain.sent);
  },
);

test('the pre-pass leaves basis members out', async () => {
  const { input } = await collectAdvisoryNpm('empty', 1, undefined, { declaration: true });
  expect(input.changes.some((c) => 'basis' in c)).toBe(true);
  const empty = () => Response.json([]);
  const batched = recordingReader(empty);
  const settled: unknown[] = [];
  const reader: AdvisoryReader = {
    ...batched.reader,
    settle: (targets) => (settled.push(...targets), batched.reader.settle!(targets)),
  };
  const plain = recordingReader(empty, { batched: false });
  const result = await enrichAdvisories(input, { reader });
  const expected = await enrichAdvisories(input, { reader: plain.reader });
  expect(asUnbatched(result)).toEqual(asUnbatched(expected));
  // settle gets exactly the targets of the members the loop researches, so none of a basis member.
  const researched = input.changes
    .filter((c) => !('basis' in c))
    .flatMap((c) =>
      (['head', 'base'] as const).flatMap((side) => {
        const target = (side === 'head' ? c.to : c.from)
          ? resolveAdvisoryTarget(input, c as PacketChange, side)
          : null;
        return target ? [target] : [];
      }),
    );
  expect(researched.length).toBeGreaterThan(0);
  expect(settled).toEqual(researched);
});

test('the pre-pass never hands pip targets to settle', async () => {
  const f = await collectMixedAdvisoryInventories();
  const settled: AdvisoryTarget[] = [];
  const real = createAdvisoryReader(advisoryLimits, {
    now: () => 0,
    fetch: async (url) =>
      new URL(url).origin === 'https://api.osv.dev' ? Response.json({}) : Response.json([]),
  });
  if (real.kind !== 'ready') throw new Error('reader');
  const reader: AdvisoryReader = {
    ...real,
    settle: (targets) => (settled.push(...(targets as AdvisoryTarget[])), real.settle!(targets)),
  };
  const result = await enrichAdvisories(f.input, { reader });
  if (result.kind !== 'enriched') throw new Error('evidence');
  // The uv members are still read, through OSV, in the member loop.
  expect(result.lookups.some((l) => l.lookup?.target.ecosystem === 'pip')).toBe(true);
  expect(settled.length).toBeGreaterThan(0);
  expect(settled.some((t) => t.ecosystem === 'pip')).toBe(false);
});
