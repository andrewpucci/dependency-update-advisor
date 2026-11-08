import { expect, test } from 'vite-plus/test';
import { parseReviewConfig } from './config.js';
import { validateReviewPacket, type ReviewPacket } from './schema.js';
import { formDecisionUnits, summarizeDecisionCoverage } from './units.js';
import { renderDecisionBrief } from './reporting.js';

function emptyBrief() {
  const repository = { id: 101, owner: 'example', name: 'consumer' };
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const binding = {
    repository,
    workflow: { id: 301, path: '.github/workflows/ci.yml' },
    runId: 401,
    runAttempt: 1,
    pullNumber: 42,
    headRepository: repository,
    headSha,
    baseRef: 'main',
    baseSha,
    mergeBaseSha: baseSha,
    actorId: 201,
    conclusion: 'success' as const,
    identity: [101, 301, 401, 1, 42, headSha] as const,
  };
  const expected = {
    binding,
    baseSha,
    contextRevision: { repository, sha: 'c'.repeat(40) },
    context: { ok: true as const, status: 'disabled' as const, dependencies: [], reasons: [] },
  };
  const ecosystems = ['npm', 'actions', 'uv'] as const;
  const coverage = { status: 'not_applicable' as const, reasons: [], sourceIds: ['inventory'] };
  const packet: ReviewPacket = {
    version: 1,
    ...expected,
    changes: [],
    relationships: [],
    findings: [],
    coverage: { npm: coverage, actions: coverage, uv: coverage },
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
          repository,
          baseSha,
          headSha,
          absentEcosystems: [...ecosystems],
        },
      },
    ],
  };
  const validated = validateReviewPacket(packet, expected);
  if (!validated.ok) throw new Error('invalid fixture');
  const result = summarizeDecisionCoverage(
    formDecisionUnits(validated.packet),
    parseReviewConfig('{"version":1}'),
    0,
  );
  if (!result.ok) throw new Error('invalid coverage');
  return {
    binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: result,
    records: [],
    analysisUnavailable: false,
    signalAttempts: [],
  };
}

test('renders an attributable empty inventory without a merge verdict', () => {
  const input = emptyBrief();
  const result = renderDecisionBrief(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(
    result.body.startsWith(
      `<!-- dependabot-intelligent-review -->\n<!-- reviewed-head: ${input.binding.headSha} -->\n`,
    ),
  ).toBe(true);
  expect(result.body).toContain('No dependency changes to review');
  expect(result.body).toContain('2026-11-08');
  expect(result.body).toContain(
    `https://github.com/example/consumer/commit/${input.binding.headSha}`,
  );
  expect(result.body).not.toMatch(/\bmerge recommendation\b/i);
});

test('rejects a binding for a different reviewed head', () => {
  const input = emptyBrief();
  const headSha = 'd'.repeat(40);
  expect(renderDecisionBrief({ ...input, binding: { ...input.binding, headSha } })).toEqual({
    ok: false,
    category: 'input',
  });
});

test('rejects an empty verdict when packet-wide inventory is unavailable', () => {
  const input = emptyBrief();
  const original = input.coverage.inventory.packet;
  const packet = {
    ...original,
    coverage: {
      ...original.coverage,
      uv: { status: 'unavailable' as const, reasons: ['timeout' as const], sourceIds: [] },
    },
  };
  const inventory = formDecisionUnits(packet);
  expect(renderDecisionBrief({ ...input, coverage: { ...input.coverage, inventory } })).toEqual({
    ok: false,
    category: 'content',
  });
});

test('preserves a supplied digest in the metadata prefix', () => {
  const input = emptyBrief();
  const digest = 'c'.repeat(64);
  const result = renderDecisionBrief({ ...input, reviewDigest: digest });
  expect(result.ok && result.body.split('\n')[2]).toBe(`<!-- review-digest: ${digest} -->`);
  expect(renderDecisionBrief({ ...input, reviewDigest: 'invalid' })).toEqual({
    ok: false,
    category: 'input',
  });
});

test('rejects an empty verdict with a nonempty inventory', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { input: scenario } = await analysisScenario();
  const empty = emptyBrief();
  const binding = scenario.inventory.packet.binding;
  const result = renderDecisionBrief({
    ...empty,
    binding,
    coverage: { ...empty.coverage, inventory: scenario.inventory },
  });
  expect(result).toEqual({ ok: false, category: 'content' });
});
