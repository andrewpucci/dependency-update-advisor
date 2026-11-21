import { expect, test } from 'vite-plus/test';
import type { LargeInventoryOptions } from '../tests/parity/large-inventory.js';
import { parseReviewConfig } from './config.js';
import {
  EVIDENCE_REASONS,
  validateReviewPacket,
  type ChangeEvidence,
  type EvidenceReason,
  type ReviewPacket,
} from './schema.js';
import { formDecisionUnits, summarizeDecisionCoverage, type DecisionUnit } from './units.js';
import { evidenceGap, renderDecisionBrief } from './reporting.js';
import { limit } from './limits.js';

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
    reachability: [],
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
    signalBinding: binding,
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
  expect(result.body).not.toMatch(/\bmerge\b/i);
});

test('rejects a binding for a different reviewed head', () => {
  const input = emptyBrief();
  const headSha = 'd'.repeat(40);
  const binding = { ...input.binding, headSha, identity: [101, 301, 401, 1, 42, headSha] as const };
  expect(renderDecisionBrief({ ...input, binding, signalBinding: binding })).toEqual({
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

test('reports every unavailable unit and configuration recovery', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body).toContain('Decision queue');
  expect(result.body).toContain('provider configuration or credential');
  const items = queueItemsOf(result.body);
  const entries = items.flatMap(queueEntriesOf);
  expect(entries).toHaveLength(input.inventory.units.length);
  for (const unit of input.inventory.units) expect(unitQueued(entries, unit)).toBe(true);
  for (const item of items)
    expect(item).toContain('Correct the provider configuration or credential, then rerun CI.');
  // Same reason and no gaps, but the direct group's update count differs, so it stays separate.
  const counts = new Set(input.inventory.units.map((unit) => unit.memberCount));
  expect(counts.size).toBeGreaterThan(1);
  expect(items).toHaveLength(counts.size);
  for (const item of items)
    expect(
      new Set(queueEntriesOf(item).map((entry) => /\((\d+) changed/u.exec(entry)?.[1])).size,
    ).toBe(1);
});

test('keeps inventory-gap recovery beside configuration recovery when analysis is unavailable', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario();
  const packet = {
    ...input.inventory.packet,
    coverage: {
      ...input.inventory.packet.coverage,
      actions: { status: 'unavailable' as const, reasons: ['permission' as const], sourceIds: [] },
      uv: { status: 'unavailable' as const, reasons: ['timeout' as const], sourceIds: [] },
    },
  };
  const analysis = await analyzeDecisionUnits(
    { ...input, inventory: formDecisionUnits(packet) },
    { deadlineMs: 700_000 },
    { now: () => 0 },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const [first, second] = analysis.coverage.inventoryGaps;
  expect(analysis.coverage.inventoryGaps).toHaveLength(2);
  expect(first.nextActions[0]).not.toBe(second.nextActions[0]);
  expect(analysis.analysisUnavailable).toBe(true);
  const result = renderDecisionBrief({
    binding: packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  const next = result.body
    .split('\n')
    .find((line) => line.startsWith('**Next action:**'))
    ?.replaceAll('\u200b', '');
  expect(next).toContain(first.nextActions[0]);
  expect(next).not.toContain(second.nextActions[0]);
  expect(next).toContain('Correct the provider configuration or credential, then rerun CI.');
});

test('shows a verified malware hold before unavailable analysis', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario({ mode: 'malware' });
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body).toContain('Reasons not to merge');
  expect(result.body.indexOf('Reasons not to merge')).toBeLessThan(
    result.body.indexOf('Decision queue'),
  );
  expect(result.body).toContain('provider configuration or credential');
  const blockerSection = result.body
    .split('## Reasons not to merge')[1]
    .split('## Decision queue')[0];
  expect(blockerSection).toContain('child-0');
  expect(blockerSection).toContain('Impact: this finding requires a hold.');
  expect(blockerSection).toContain(
    'The cited active malware advisory affects this exact proposed target.',
  );
  expect(blockerSection).toContain('Do not merge this version; select an unaffected version.');
  expect(blockerSection).toContain('Re-run the exact malware lookup before reconsidering.');
  expect(blockerSection).toContain('https://github.com/advisories/');
});

test('merges a model blocker into the finding-backed hold it explains', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario({ mode: 'malware' });
  const analysis = await analyzeDecisionUnits(
    {
      ...input,
      config: parseReviewConfig(
        JSON.stringify({
          version: 1,
          analysis: { provider: 'mistral', model: 'synthetic-model' },
        }),
      ),
    },
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () => {
            const document = analysisDocument(batch);
            for (const assessment of document.assessments)
              for (const blocker of assessment.blockers)
                blocker.remediation = [
                  'Do not merge this version; select an unaffected version.',
                  ...blocker.remediation,
                ];
            return Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(document) },
                },
              ],
            });
          },
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  expect(analysis.records.some((record) => record.assessment?.blockers.length)).toBe(true);
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  if (!result.ok) throw new Error('render failed');
  const items = result.body
    .split('## Reasons not to merge')[1]
    .split('\n## ')[0]
    .split('\n')
    .filter((line) => line.startsWith('- '));
  expect(items).toHaveLength(1);
  const [item] = items;
  expect(item).toMatch(/^- child-0: /u);
  expect(item).not.toContain('orbit');
  for (const value of [
    'The cited active malware advisory affects this exact proposed target.',
    'Impact: The proposed change needs remediation.',
    'Evidence: ',
    'Resolve the named policy finding or evidence gap.',
    'Re-run the exact malware lookup before reconsidering.',
    'Re-run the dependency review.',
    'https://github.com/advisories/',
  ])
    expect(item).toContain(value);
  expect(item.split('Do not merge this version; select an unaffected version.')).toHaveLength(2);
  expect(item.replaceAll('\u200b', '')).toContain(
    'Evidence: The supplied finding cites this exact member and version. [',
  );
  // Once as model evidence and once as the finding's verified link.
  expect(item.split('https://github.com/advisories/GHSA-mmmm-nnnn-pppp')).toHaveLength(3);
});

test.each([false, true])(
  'renders one bullet for a finding that several policy rules hold (model blockers: %s)',
  async (model) => {
    const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
    const { preparedSnapshot } = await import('./analysis/contract.js');
    const { analyzeDecisionUnits } = await import('./analysis/batches.js');
    const { analyzeMistralBatch } = await import('./analysis/mistral.js');
    const { input, scenario } = await analysisScenario({ mode: 'yanked' });
    // The schema permits one release finding with both facts; collectors emit them separately.
    const packet = {
      ...input.inventory.packet,
      findings: input.inventory.packet.findings.map((finding) =>
        finding.kind === 'releaseMetadata' && finding.deprecated
          ? { ...finding, publishedAt: Date.parse('2026-11-06T00:00:00Z') }
          : finding,
      ),
    };
    const config = parseReviewConfig(
      JSON.stringify({
        version: 1,
        ...(model ? { analysis: { provider: 'mistral', model: 'synthetic-model' } } : {}),
        policy: {
          verdicts: { recentRelease: 'do_not_merge', deprecatedRelease: 'do_not_merge' },
          minimumReleaseAgeDays: 30,
        },
      }),
    );
    const analysis = await analyzeDecisionUnits(
      { ...input, inventory: formDecisionUnits(packet), config },
      { apiKey: 'test', deadlineMs: 700_000 },
      {
        now: () => 0,
        analyze: (batch, options) =>
          analyzeMistralBatch(batch, options, {
            now: () => 0,
            fetch: async () => {
              const snapshot = preparedSnapshot(batch)!;
              const document = analysisDocument(batch);
              // One blocker per hold, so both rules on the shared finding have a blocker.
              for (const assessment of document.assessments) {
                const unit = snapshot.units.find((entry) => entry.alias === assessment.unitId)!;
                const [base] = assessment.blockers;
                if (!base) continue;
                assessment.blockers = snapshot.holds
                  .filter((hold) => hold.value.unitId === unit.id)
                  .map((hold) => ({
                    ...base,
                    holdId: hold.alias,
                    impact: `The ${hold.value.trace.rule} hold needs remediation.`,
                    validation: [`Recheck the ${hold.value.trace.rule} hold.`],
                  }));
              }
              return Response.json({
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: JSON.stringify(document) },
                  },
                ],
              });
            },
          }),
      },
    );
    if (!analysis.ok) throw new Error('analysis fixture failed');
    const held = analysis.coverage.policyProvenance.assessments.units.flatMap((unit) =>
      unit.rules.filter((rule) => rule.findingId && rule.effectiveVerdict === 'do_not_merge'),
    );
    const doubled = held.filter((rule) => rule.rule === 'deprecatedRelease')[0]?.findingId;
    expect(held.filter((rule) => rule.findingId === doubled).map((rule) => rule.rule)).toEqual([
      'recentRelease',
      'deprecatedRelease',
    ]);
    const result = renderDecisionBrief({
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: analysis.coverage,
      records: analysis.records,
      analysisUnavailable: analysis.analysisUnavailable,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    });
    if (!result.ok) throw new Error('render failed');
    const items = result.body
      .split('## Reasons not to merge')[1]
      .split('\n## ')[0]
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(items).toHaveLength(new Set(held.map((rule) => rule.findingId)).size);
    expect(items[0]).toMatch(
      // orbit also exists in npm, so the uv package is qualified by its ecosystem.
      /^- orbit \(uv\): The exact PyPI release supplies the cited release metadata\./u,
    );
    expect(analysis.records.some((record) => record.assessment?.blockers.length === 2)).toBe(model);
    for (const rule of ['recentRelease', 'deprecatedRelease']) {
      const blocker = [`The ${rule} hold needs remediation.`, `Recheck the ${rule} hold.`];
      for (const value of blocker) expect(items[0].includes(value)).toBe(model);
    }
  },
);

test('labels each finding-backed hold with the member the finding is about', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario({ mode: 'deprecated' });
  const config = parseReviewConfig(
    JSON.stringify({ version: 1, policy: { verdicts: { deprecatedRelease: 'do_not_merge' } } }),
  );
  const analysis = await analyzeDecisionUnits(
    { ...input, config },
    { deadlineMs: 700_000 },
    { now: () => 0 },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  if (!result.ok) throw new Error('render failed');
  const labels = result.body
    .split('## Reasons not to merge')[1]
    .split('\n## ')[0]
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2, line.indexOf(':')));
  // Both deprecated members share one group; orbit is not the group's first member.
  // orbit exists in npm and uv, so its label carries the ecosystem.
  expect(labels.sort()).toEqual(['child-0', 'orbit (npm)']);
});

test('renders assessed decision units without treating required evidence gaps as complete', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body).toContain('Package assessments');
  expect(result.body).toContain('Decision coverage');
  expect(result.body).toContain('release metadata');
  expect(result.body).toContain('publication time observation');
  expect(result.body).toContain('Base repository file evidence');
  expect(result.body).toContain('Proposed repository file evidence');
  expect(result.body).not.toContain('releaseMetadata');
  expect(result.body).not.toContain('publishTime');
  expect(result.body).toContain('**Recommendation:** Merge.');
  expect(result.body).toContain('**Next action:** Review the evidence, then merge.');
  expect(result.body).toContain('Required evidence: Complete.');
  const assessments = result.body
    .split('## Package assessments')[1]
    .split('## Unchecked signals')[0];
  const assessmentBlocks = assessments.split(/\n(?=- )/u).filter((block) => block.startsWith('- '));
  expect(assessmentBlocks).toHaveLength(input.inventory.units.length);
  expect(assessmentBlocks.every((block) => block.includes('  - Assessment:'))).toBe(true);
  const guide =
    'https://github.com/andrewpucci/dependency-update-advisor/blob/main/docs/policy-guide.md';
  expect(
    assessmentBlocks.every((block) =>
      /\n {2}- \[Policy\]\(<https:\/\/github\.com\/andrewpucci\/dependency-update-advisor\/blob\/main\/docs\/policy-guide\.md>\): [a-z ]+; evidence: (complete|partial)\./u.test(
        block,
      ),
    ),
  ).toBe(true);
  expect(result.body.split(guide)).toHaveLength(assessmentBlocks.length + 1);
  expect(assessmentBlocks.every((block) => block.includes('](<https://'))).toBe(true);
  expect(assessmentBlocks[0]).toContain('https://github.com/fixture/action/releases/tag/v2.0.0');
  expect(assessmentBlocks[1]).toContain(
    'https://github.com/fixture/npm-child-0/releases/tag/v2.0.0',
  );
  expect(assessmentBlocks[2]).toContain('https://github.com/fixture/py-orbit/releases/tag/v2.0.0');
  expect(assessmentBlocks[2]).toContain('**orbit** (uv, direct): 1.0.0 → 2.0.0');
  const groupedUnit = input.inventory.units[1];
  expect(groupedUnit.members.length).toBeGreaterThan(1);
  for (const member of groupedUnit.members)
    expect(assessmentBlocks[1]).toContain(
      `${member.name}: ${member.currentVersion} → ${member.proposedVersion}`,
    );
  const unchecked = result.body.split('## Unchecked signals')[1];
  expect(unchecked).toContain('- **fixture/action** (actions)');
  expect(unchecked).toContain('- **orbit** (uv)');
  expect(unchecked.match(/- \*\*fixture\/action\*\*/gu)).toHaveLength(1);
  expect(unchecked).toContain('deprecation, publisher, trust: unsupported; unavailable.');
  const members = input.inventory.units.flatMap((unit) => unit.members);
  const npmOrbit = members.find((member) => member.name === 'orbit' && member.ecosystem === 'npm');
  const uvOrbit = members.find((member) => member.name === 'orbit' && member.ecosystem === 'uv');
  if (!npmOrbit || !uvOrbit) throw new Error('missing same-name package fixtures');
  const signals = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: [
      ...scenario.result.attempts,
      {
        memberId: npmOrbit.id,
        side: 'base',
        category: 'license',
        url: null,
        outcome: 'unavailable',
        reasons: ['timeout'],
        sourceIds: [],
        truncated: false,
      },
      {
        memberId: uvOrbit.id,
        side: 'head',
        category: 'license',
        url: null,
        outcome: 'unavailable',
        reasons: ['permission'],
        sourceIds: [],
        truncated: false,
      },
    ],
    signalBinding: scenario.result.binding,
  });
  if (!signals.ok) throw new Error('render failed');
  const signalSection = signals.body.split('## Unchecked signals')[1];
  const npmSignals = signalSection.split('- **orbit** (npm)')[1].split('\n- **')[0];
  const uvSignals = signalSection.split('- **orbit** (uv)')[1].split('\n- **')[0];
  expect(npmSignals).toContain('license (base): timeout; unavailable.');
  expect(npmSignals).not.toContain('license (proposed): permission');
  expect(uvSignals).toContain('license (proposed): permission; unavailable.');
  expect(uvSignals).not.toContain('license (base): timeout');
  if (process.env.O1_GROUPED_PREVIEW) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.O1_GROUPED_PREVIEW, result.body);
  }
});

test('distinguishes unchecked signals for same-name packages in different roots', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input: original, scenario } = await analysisScenario({ inventory: { uvVariants: true } });
  const originalVariants = original.inventory.units
    .flatMap((unit) => unit.members)
    .filter((member) => member.name === 'orbit' && member.ecosystem === 'uv');
  expect(originalVariants).toHaveLength(2);
  const moved = original.inventory.packet.changes.find(
    (change) => change.id === originalVariants[1].id && change.ecosystem === 'uv',
  );
  if (!moved || moved.ecosystem !== 'uv' || !moved.from || !moved.to)
    throw new Error('missing uv variant fixture');
  const inventorySources = (['from', 'to'] as const).map((side) => {
    const source = original.inventory.packet.sources.find(
      (item) => item.id === moved[side]!.sourceId,
    );
    if (!source || source.provenance.kind !== 'file') throw new Error('missing inventory source');
    return {
      ...source,
      id: `other-root-${side}`,
      memberIds: [moved.id],
      provenance: { ...source.provenance, path: 'packages/other/uv.lock' },
    };
  });
  const packet = {
    ...original.inventory.packet,
    sources: [...original.inventory.packet.sources, ...inventorySources],
    changes: original.inventory.packet.changes.map((change) =>
      change.id === originalVariants[1].id && change.ecosystem === 'uv'
        ? {
            ...change,
            from: change.from && {
              ...change.from,
              root: 'packages/other',
              sourceId: 'other-root-from',
            },
            to: change.to && { ...change.to, root: 'packages/other', sourceId: 'other-root-to' },
          }
        : change,
    ),
  };
  const validated = validateReviewPacket(packet, {
    binding: packet.binding,
    baseSha: packet.baseSha,
    contextRevision: packet.contextRevision,
    context: packet.context,
  });
  if (!validated.ok)
    throw new Error(`invalid different-root fixture: ${JSON.stringify(validated.error)}`);
  const inventory = formDecisionUnits(validated.packet);
  const input = { ...original, inventory, unitIds: inventory.units.map((unit) => unit.id) };
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const variants = input.inventory.units
    .flatMap((unit) => unit.members)
    .filter((member) => member.name === 'orbit' && member.ecosystem === 'uv');
  expect(variants).toHaveLength(2);
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: [
      ...scenario.result.attempts,
      ...variants.map((member, index) => ({
        memberId: member.id,
        side: 'head' as const,
        category: 'license',
        url: null,
        outcome: 'unavailable' as const,
        reasons: [index === 0 ? ('timeout' as const) : ('permission' as const)],
        sourceIds: [],
        truncated: false,
      })),
    ],
    signalBinding: scenario.result.binding,
  });
  if (!result.ok) throw new Error('render failed');
  const unchecked = result.body.split('## Unchecked signals')[1];
  for (const [index, member] of variants.entries()) {
    const root = member.id === originalVariants[1].id ? 'packages/other' : '.';
    const heading = `- **orbit** (uv, root ${root}, ${member.proposedVersion})`;
    const block = unchecked.split(heading)[1]?.split('\n- **')[0];
    expect(block).toContain(
      `license (proposed): ${index === 0 ? 'timeout' : 'permission'}; unavailable.`,
    );
  }
});

test('reports inventory recovery when no changes can be identified', () => {
  const input = emptyBrief();
  const original = input.coverage.inventory.packet;
  const packet = {
    ...original,
    coverage: {
      ...original.coverage,
      uv: { status: 'unavailable' as const, reasons: ['timeout' as const], sourceIds: [] },
    },
  };
  const coverage = summarizeDecisionCoverage(
    formDecisionUnits(packet),
    parseReviewConfig('{"version":1}'),
    0,
    {},
  );
  if (!coverage.ok) throw new Error('invalid fixture');
  const result = renderDecisionBrief({ ...input, coverage });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body).toContain('No merge recommendation');
  expect(result.body).toContain('uv:');
  expect(result.body).not.toContain('No dependency changes to review');
});

test('shows a failed exact-version license lookup without inventing license information', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const attempt = scenario.result.attempts.find((entry) => entry.category === 'license');
  if (!attempt) throw new Error('missing license fixture');
  const attempts = scenario.result.attempts.map((entry) =>
    entry === attempt
      ? { ...entry, outcome: 'unavailable' as const, reasons: ['timeout' as const], sourceIds: [] }
      : entry,
  );
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: false,
    signalAttempts: attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  const member = input.inventory.units
    .flatMap((unit) => unit.members)
    .find((item) => item.id === attempt.memberId);
  if (!member) throw new Error('missing member fixture');
  const unchecked = result.body.split('## Unchecked signals')[1];
  const memberBlock = unchecked
    .split(`- **${member.name}** (${member.ecosystem})`)[1]
    .split('\n- **')[0];
  expect(memberBlock).toContain(
    `license (${attempt.side === 'head' ? 'proposed' : 'base'}): timeout; unavailable.`,
  );
});

test('renders a validated actionable capability with local context and upstream evidence', async () => {
  const { analysisWithContext, capabilityDocument } = await import('../tests/parity/analysis.js');
  const { preparedSnapshot } = await import('./analysis/contract.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { batch } = await analysisWithContext('available');
  const snapshot = preparedSnapshot(batch)!;
  const result = await analyzeDecisionUnits(
    { inventory: snapshot.inventory, config: snapshot.config, evaluatedAt: snapshot.evaluatedAt },
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (prepared, options) =>
        analyzeMistralBatch(prepared, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: JSON.stringify(capabilityDocument(prepared).document),
                  },
                },
              ],
            }),
        }),
    },
  );
  if (!result.ok) throw new Error('analysis fixture failed');
  const rendered = renderDecisionBrief({
    binding: snapshot.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: result.coverage,
    records: result.records,
    analysisUnavailable: result.analysisUnavailable,
    signalAttempts: [],
    signalBinding: snapshot.inventory.packet.binding,
  });
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error('render failed');
  expect(rendered.body).toContain('New capabilities to adopt now');
  expect(rendered.body).toContain('Adopt the helper');
  expect(rendered.body).toContain('Repository context');
  const capability = result.records.flatMap(
    (record) => record.assessment?.newFunctionality ?? [],
  )[0];
  if (!capability) throw new Error('missing capability fixture');
  const capabilitySection = rendered.body
    .split('## New capabilities to adopt now')[1]
    .split('## ')[0];
  expect(capabilitySection).toContain(`](<${capability.sourceUrl}>)`);
  const otherSource = snapshot.inventory.packet.sources.find(
    (source) =>
      source.provenance.kind === 'upstream' &&
      source.status !== 'unavailable' &&
      !source.memberIds.includes(capability.memberId),
  );
  if (!otherSource || otherSource.provenance.kind !== 'upstream')
    throw new Error('missing other source fixture');
  const records = result.records.map((record) => {
    if (!record.assessment?.newFunctionality.length) return record;
    return {
      ...record,
      assessment: {
        ...record.assessment,
        newFunctionality: record.assessment.newFunctionality.map((capability) => ({
          ...capability,
          sourceId: otherSource.id,
          sourceUrl: otherSource.provenance.kind === 'upstream' ? otherSource.provenance.url : '',
        })),
      },
    };
  });
  expect(
    renderDecisionBrief({
      binding: snapshot.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: result.coverage,
      records,
      analysisUnavailable: result.analysisUnavailable,
      signalAttempts: [],
      signalBinding: snapshot.inventory.packet.binding,
    }),
  ).toEqual({ ok: false, category: 'reference' });
});

test.each(['child-0', 'orbit'])(
  'renders an assessed coverage-policy hold labelled with the gap owner %s',
  async (owner) => {
    const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
    const { analyzeDecisionUnits } = await import('./analysis/batches.js');
    const { analyzeMistralBatch } = await import('./analysis/mistral.js');
    const { input, scenario } = await analysisScenario({ mode: 'malware-failed' });
    // Members sort by ID, so moving the failed lookup to orbit makes the owner a non-first member.
    const npm = input.inventory.packet.changes.filter((change) => change.ecosystem === 'npm');
    expect(npm).toHaveLength(2);
    const packet = {
      ...input.inventory.packet,
      changes: input.inventory.packet.changes.map((change) =>
        owner === 'child-0' || !npm.some((entry) => entry.id === change.id)
          ? change
          : {
              ...change,
              evidence: {
                ...change.evidence,
                malware: npm.find((other) => other.id !== change.id)!.evidence.malware,
              },
            },
      ),
    };
    const config = parseReviewConfig(
      JSON.stringify({
        version: 1,
        analysis: { provider: 'mistral', model: 'synthetic-model' },
        policy: { verdicts: { incompleteEvidence: 'do_not_merge' } },
      }),
    );
    const analysis = await analyzeDecisionUnits(
      { ...input, inventory: formDecisionUnits(packet), config },
      { apiKey: 'test', deadlineMs: 700_000 },
      {
        now: () => 0,
        analyze: (batch, options) =>
          analyzeMistralBatch(batch, options, {
            now: () => 0,
            fetch: async () =>
              Response.json({
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: {
                      role: 'assistant',
                      content: JSON.stringify(analysisDocument(batch)),
                    },
                  },
                ],
              }),
          }),
      },
    );
    if (!analysis.ok) throw new Error('analysis fixture failed');
    expect(analysis.coverage.outcome).toEqual({ kind: 'advice', verdict: 'do_not_merge' });
    const rendered = renderDecisionBrief({
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: analysis.coverage,
      records: analysis.records,
      analysisUnavailable: analysis.analysisUnavailable,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error('render failed');
    expect(rendered.body).toContain('The proposed change needs remediation');
    const reasons = rendered.body
      .split('## Reasons not to merge')[1]
      .split('\n## ')[0]
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(
      // orbit exists in npm and uv, so the npm gap owner is qualified by its ecosystem.
      new RegExp(
        `^- ${owner === 'orbit' ? 'orbit \\(npm\\)' : owner}: The supplied policy requires a hold\\.`,
        'u',
      ),
    );
  },
);

test('omits oversized optional assessment details with a visible notice', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const records = structuredClone(analysis.records);
  if (!records[0].assessment) throw new Error('assessment fixture');
  records[0] = {
    ...records[0],
    assessment: { ...records[0].assessment, reason: { text: 'x'.repeat(50_000), references: [] } },
  };
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records,
    analysisUnavailable: false,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body.length).toBeLessThanOrEqual(50_000);
  expect(result.body).toContain('omitted');
  expect(result.body).toContain('Decision coverage');
});

test('retains every unresolved action at exactly 50,000 string units and rejects overflow', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const original = analysis.records[0];
  if (original.state.state === 'assessed') throw new Error('expected unresolved');
  const state = original.state;
  const make = (reason: string) => {
    const records = analysis.records.map((record, index) =>
      index ? record : { ...record, state: { ...state, reason } },
    );
    const policy = analysis.coverage.policyProvenance.assessments;
    const assessments = policy.assessments.map((entry, index) =>
      index ? entry : { ...entry, reason },
    );
    const unresolvedUnits = policy.unresolvedUnits.map((entry, index) =>
      index ? entry : { ...entry, reason },
    );
    const coverage = {
      ...analysis.coverage,
      policyProvenance: {
        ...analysis.coverage.policyProvenance,
        assessments: { ...policy, assessments, unresolvedUnits },
      },
    };
    return {
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      reviewDigest: 'c'.repeat(64),
      coverage,
      records,
      analysisUnavailable: true,
      signalAttempts: [],
      signalBinding: input.inventory.packet.binding,
    };
  };
  const baseline = renderDecisionBrief(make('é<'));
  if (!baseline.ok) throw new Error('render fixture');
  const length = 50_000 - baseline.body.length + 1;
  const exact = renderDecisionBrief(make('é'.repeat(length) + '<'));
  expect(exact.ok).toBe(true);
  if (!exact.ok) throw new Error('exact boundary failed');
  expect(exact.body.length).toBe(50_000);
  expect(exact.body).toContain('Decision queue');
  expect(exact.body).toContain('&lt;');
  expect(exact.body).toContain(`<!-- review-digest: ${'c'.repeat(64)} -->`);
  const verifyQueue = (body: string) => {
    const items = queueItemsOf(body);
    const entries = items.flatMap(queueEntriesOf);
    expect(entries).toHaveLength(input.inventory.units.length);
    for (const unit of input.inventory.units) expect(unitQueued(entries, unit)).toBe(true);
    for (const item of items)
      expect(item).toContain('Correct the provider configuration or credential, then rerun CI.');
  };
  verifyQueue(exact.body);
  const overflow = renderDecisionBrief(make('é'.repeat(length + 1) + '<'));
  expect(overflow.ok && overflow.body).toContain('omitted');
  if (!overflow.ok) throw new Error('overflow rendering failed');
  verifyQueue(overflow.body);
  expect(renderDecisionBrief(make('é'.repeat(length + 5_000) + '<'))).toEqual({
    ok: false,
    category: 'size',
  });
});

test('neutralizes external Markdown, HTML and GitHub autolinks in assessment text', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario();
  const hostile =
    '@alice @acme/team #123 owner/repo#123 GH-123 gh-456 https://evil.example :smile: ffffffffffffffffffffffffffffffffffffffff </details> <!-- reviewed-head: fake --> [click](https://evil.example)';
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () => {
            const document = analysisDocument(batch);
            document.assessments[0].reason.text = hostile;
            return Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(document) },
                },
              ],
            });
          },
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: false,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body).not.toContain('@alice');
  expect(result.body).not.toContain('@acme/team');
  expect(result.body).not.toContain('#123');
  expect(result.body).not.toContain('owner/repo#123');
  expect(result.body).not.toMatch(/\bgh-\d/iu);
  expect(result.body).not.toContain(':smile:');
  expect(result.body).not.toContain('ffffffffffffffffffffffffffffffffffffffff');
  expect(result.body).not.toContain('https://evil.example');
  expect(result.body).not.toContain('</details>');
  expect(result.body).not.toContain('<!-- reviewed-head: fake -->');
  if (process.env.O1_MARKDOWN_PROBE) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.O1_MARKDOWN_PROBE, result.body);
  }
});

/** Each M2 failure category with the start of the recovery action it renders. */
const RECOVERY_BY_CATEGORY: [string, string][] = [
  ...[
    'transport',
    'http-auth',
    'http-rate-limit',
    'http-server',
    'http-other',
    'media-type',
    'response-size',
    'encoding',
    'envelope',
    'json',
    'deadline',
    'cancelled',
    'call_budget',
  ].map((category): [string, string] => [category, 'Rerun CI to retry dependency analysis.']),
  ['configuration', 'Correct the provider configuration or credential'],
  ...['budget', 'length'].map((category): [string, string] => [
    category,
    'Inspect the oversized input or response',
  ]),
  ...['input', 'projection', 'reference', 'schema', 'policy', 'unexpected'].map(
    (category): [string, string] => [category, 'Investigate the failed review data or validation'],
  ),
];

test('maps every M2 failure category to its applicable recovery action', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  for (const [category, expected] of RECOVERY_BY_CATEGORY) {
    const records = analysis.records.map((record) => ({ ...record, category }));
    const result = renderDecisionBrief({
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: analysis.coverage,
      records,
      analysisUnavailable: true,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(category);
    expect(result.body).toContain(expected);
    const items = queueItemsOf(result.body);
    expect(items.flatMap(queueEntriesOf)).toHaveLength(input.inventory.units.length);
    for (const item of items) expect(item).toContain(expected);
  }
});

test('rejects a merge outcome that contradicts the authoritative unresolved coverage', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const coverage = {
    ...analysis.coverage,
    outcome: { kind: 'advice' as const, verdict: 'merge' as const },
  };
  expect(
    renderDecisionBrief({
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage,
      records: analysis.records,
      analysisUnavailable: true,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    }),
  ).toEqual({ ok: false, category: 'content' });
});

test('retains the exact next action for assessed evidence gaps and relaxed advice', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario({ mode: 'malware-failed' });
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  expect(analysis.coverage.outcome).toEqual({ kind: 'advice', verdict: 'merge_with_followups' });
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: false,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body).toContain('Merge with follow-ups');
  expect(result.body).toContain('Required evidence: Incomplete');
  expect(result.body).toContain('Non-blocking follow-ups');
  expect(result.body).toContain('malware evidence');
  const gapUnit = analysis.coverage.policyProvenance.assessments.units.find((unit) =>
    unit.gaps.some((gap) =>
      input.inventory.units
        .find((candidate) => candidate.id === unit.id)
        ?.evidenceLinks.some((link) => link.id === gap.sourceId && link.category === 'malware'),
    ),
  );
  if (!gapUnit) throw new Error('missing malware gap');
  const unit = input.inventory.units.find((candidate) => candidate.id === gapUnit.id)!;
  const assessmentIndex = input.inventory.units.findIndex(
    (candidate) => candidate.id === gapUnit.id,
  );
  const assessments = result.body.split('## Package assessments')[1].split('## ')[0];
  const assessmentBlocks = assessments.split(/\n(?=- )/u).filter((block) => block.startsWith('- '));
  expect(assessmentBlocks[assessmentIndex]).toContain('evidence: partial.');
  const link = unit.evidenceLinks.find(
    (entry) =>
      entry.category === 'malware' && gapUnit.gaps.some((gap) => gap.sourceId === entry.id),
  )!;
  const member = unit.members.find((entry) => entry.id === link.memberId)!;
  const gapAction = `${member.name}: malware evidence is ${link.status} (${link.reasons.join(', ')}). The source could not be trusted; check it manually: search the GitHub Advisory Database for ${member.name}.`;
  const followupSection = (body: string) =>
    body.split('## Non-blocking follow-ups')[1].split('\n## ')[0];
  expect(followupSection(result.body)).toContain(gapAction);
  const records = analysis.records.map((record, index) =>
    index || !record.assessment
      ? record
      : {
          ...record,
          assessment: {
            ...record.assessment,
            reason: { text: 'x'.repeat(50_000), references: [] },
          },
        },
  );
  const boundary = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records,
    analysisUnavailable: false,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(boundary.ok).toBe(true);
  if (!boundary.ok) throw new Error('boundary rendering failed');
  expect(boundary.body).toContain('omitted');
  expect(boundary.body).toContain('malware evidence');
  expect(boundary.body).toContain('Non-blocking follow-ups');
  expect(followupSection(boundary.body)).toContain(gapAction);
});

test('rejects an inventory gap whose reasons disagree with the packet', () => {
  const input = emptyBrief();
  const original = input.coverage.inventory.packet;
  const packet = {
    ...original,
    coverage: {
      ...original.coverage,
      uv: { status: 'unavailable' as const, reasons: ['timeout' as const], sourceIds: [] },
    },
  };
  const coverage = summarizeDecisionCoverage(
    formDecisionUnits(packet),
    parseReviewConfig('{"version":1}'),
    0,
    {},
  );
  if (!coverage.ok) throw new Error('invalid fixture');
  const changed = {
    ...coverage,
    inventoryGaps: coverage.inventoryGaps.map((gap) => ({ ...gap, reasons: [] })),
  };
  expect(renderDecisionBrief({ ...input, coverage: changed })).toEqual({
    ok: false,
    category: 'content',
  });
});

test('neutralizes hostile Markdown in every model blocker field', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario({ mode: 'malware-failed' });
  const config = parseReviewConfig(
    JSON.stringify({
      version: 1,
      analysis: { provider: 'mistral', model: 'synthetic-model' },
      policy: { verdicts: { incompleteEvidence: 'do_not_merge' } },
    }),
  );
  const hostile =
    '@alice @acme/team #123 owner/repo#123 https://evil.example :smile: ffffffffffffffffffffffffffffffffffffffff </details> <!-- reviewed-head: fake --> [click](https://evil.example)';
  const analysis = await analyzeDecisionUnits(
    { ...input, config },
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () => {
            const document = analysisDocument(batch);
            for (const assessment of document.assessments)
              for (const blocker of assessment.blockers) {
                blocker.reason = hostile;
                blocker.impact = hostile;
                blocker.evidence = [{ text: hostile, references: [] }];
                blocker.remediation = [hostile];
                blocker.validation = [hostile];
              }
            return Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(document) },
                },
              ],
            });
          },
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: false,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('render failed');
  expect(result.body).toContain('Reasons not to merge');
  expect(result.body).not.toContain('@alice');
  expect(result.body).not.toContain('@acme/team');
  expect(result.body).not.toContain('#123');
  expect(result.body).not.toContain('owner/repo#123');
  expect(result.body).not.toContain(':smile:');
  expect(result.body).not.toContain('ffffffffffffffffffffffffffffffffffffffff');
  expect(result.body).not.toContain('https://evil.example');
  expect(result.body).not.toContain('</details>');
  if (process.env.O1_BLOCKER_PROBE) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.O1_BLOCKER_PROBE, result.body);
  }
});

test.each(['rejected', 'unattempted'] as const)(
  'retains every %s unit when analysis is unavailable',
  async (kind) => {
    const { analysisScenario } = await import('../tests/parity/analysis.js');
    const { analyzeDecisionUnits } = await import('./analysis/batches.js');
    const { analyzeMistralBatch } = await import('./analysis/mistral.js');
    const { input, scenario } = await analysisScenario();
    const controller = new AbortController();
    if (kind === 'unattempted') controller.abort();
    const analysis = await analyzeDecisionUnits(
      input,
      { apiKey: 'test', deadlineMs: 700_000, signal: controller.signal },
      {
        now: () => 0,
        analyze: (batch, options) =>
          analyzeMistralBatch(batch, options, {
            now: () => 0,
            fetch: async () =>
              Response.json({
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'invalid-json' },
                  },
                ],
              }),
          }),
      },
    );
    if (!analysis.ok) throw new Error('analysis fixture failed');
    expect(analysis.records.every((record) => record.state.state === kind)).toBe(true);
    const rendered = renderDecisionBrief({
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: analysis.coverage,
      records: analysis.records,
      analysisUnavailable: analysis.analysisUnavailable,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error('render failed');
    expect(rendered.body).toContain('No merge recommendation');
    expect(rendered.body).toContain(`${input.inventory.units.length} unresolved decision units`);
    expect(rendered.body).toContain('Rerun CI');
    const items = queueItemsOf(rendered.body);
    const entries = items.flatMap(queueEntriesOf);
    expect(entries).toHaveLength(input.inventory.units.length);
    for (const unit of input.inventory.units) expect(unitQueued(entries, unit)).toBe(true);
    for (const item of items) expect(item).toContain('Rerun CI to retry dependency analysis.');
  },
);

test('retains assessed and unresolved units together without recommending merge', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario();
  const result = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  if (!result.ok) throw new Error('analysis fixture failed');
  const state = {
    state: 'unavailable' as const,
    reason: 'Analysis did not produce a validated assessment.',
    nextAction: 'Re-run dependency analysis.',
    coverageLimits: ['Model assessment unavailable.'],
  };
  const records = result.records.map((record, index) =>
    index ? record : { ...record, state, category: 'transport', assessment: null },
  );
  const coverage = summarizeDecisionCoverage(
    input.inventory,
    input.config,
    input.evaluatedAt,
    Object.fromEntries(records.map((record) => [record.unitId, record.state])),
  );
  if (!coverage.ok) throw new Error('coverage fixture failed');
  const rendered = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage,
    records,
    analysisUnavailable: false,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error('render failed');
  expect(rendered.body).toContain('No merge recommendation');
  expect(rendered.body).toContain('Decision queue');
  expect(rendered.body).toContain('Package assessments');
  expect(rendered.body).toContain('1 unresolved decision unit.');
  const queue = rendered.body.split('## Decision queue')[1].split('## Decision coverage')[0];
  const queueItems = queue.split('\n').filter((line) => line.startsWith('- '));
  expect(queueItems).toHaveLength(1);
  expect(queueItems[0]).toContain(input.inventory.units[0].members[0].name);
  expect(queueItems[0]).toContain('Rerun CI to retry dependency analysis.');
  const assessments = rendered.body.split('## Package assessments')[1].split('## ')[0];
  const assessmentItems = assessments.split(/\n(?=- )/u).filter((block) => block.startsWith('- '));
  expect(assessmentItems).toHaveLength(input.inventory.units.length - 1);
  for (const [index, unit] of input.inventory.units.slice(1).entries())
    expect(assessmentItems[index]).toContain(unit.members[0].name);
});

test('rejects a policy summary that drops a required unit evidence gap', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario({ mode: 'malware-failed' });
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  expect(
    analysis.coverage.policyProvenance.assessments.units.some((unit) => unit.gaps.length),
  ).toBe(true);
  const summary = analysis.coverage.policyProvenance.assessments;
  const altered = {
    ...analysis.coverage,
    policyProvenance: {
      ...analysis.coverage.policyProvenance,
      assessments: { ...summary, units: summary.units.map((unit) => ({ ...unit, gaps: [] })) },
    },
  };
  expect(
    renderDecisionBrief({
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: altered,
      records: analysis.records,
      analysisUnavailable: false,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    }),
  ).toEqual({ ok: false, category: 'content' });
});

test('rejects a policy summary that drops unchecked optional signals', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const summary = analysis.coverage.policyProvenance.assessments;
  expect(summary.units.some((unit) => unit.uncheckedSignals.length)).toBe(true);
  const coverage = {
    ...analysis.coverage,
    policyProvenance: {
      ...analysis.coverage.policyProvenance,
      assessments: {
        ...summary,
        units: summary.units.map((unit) => ({ ...unit, uncheckedSignals: [] })),
      },
    },
  };
  expect(
    renderDecisionBrief({
      binding: input.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage,
      records: analysis.records,
      analysisUnavailable: analysis.analysisUnavailable,
      signalAttempts: scenario.result.attempts,
      signalBinding: scenario.result.binding,
    }),
  ).toEqual({ ok: false, category: 'content' });
});

test.each(['gaps', 'uncheckedSignals'] as const)(
  'rejects a policy summary that rewords one of its %s',
  async (field) => {
    const { analysisScenario } = await import('../tests/parity/analysis.js');
    const { analyzeDecisionUnits } = await import('./analysis/batches.js');
    const { input, scenario } = await analysisScenario({ mode: 'malware-failed' });
    const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
    if (!analysis.ok) throw new Error('analysis fixture failed');
    const summary = analysis.coverage.policyProvenance.assessments;
    const target = summary.units.findIndex((unit) => unit[field].length);
    expect(target).toBeGreaterThanOrEqual(0);
    const render = (coverage: typeof analysis.coverage) =>
      renderDecisionBrief({
        binding: input.inventory.packet.binding,
        generatedAt: '2026-11-08T00:00:00.000Z',
        coverage,
        records: analysis.records,
        analysisUnavailable: analysis.analysisUnavailable,
        signalAttempts: scenario.result.attempts,
        signalBinding: scenario.result.binding,
      });
    expect(render(analysis.coverage).ok).toBe(true);
    // Same counts, different content: only a full comparison notices.
    const units = summary.units.map((unit, index) =>
      index === target
        ? {
            ...unit,
            [field]: unit[field].map((entry, position) =>
              position ? entry : { ...entry, reason: `${entry.reason} (reworded)` },
            ),
          }
        : unit,
    );
    expect(
      render({
        ...analysis.coverage,
        policyProvenance: {
          ...analysis.coverage.policyProvenance,
          assessments: { ...summary, units },
        },
      }),
    ).toEqual({ ok: false, category: 'content' });
  },
);

test('accepts valid UTC generation times with and without fractional seconds', () => {
  const input = emptyBrief();
  for (const generatedAt of [
    '2026-11-08T00:00:00Z',
    '2026-11-08T00:00:00.5Z',
    '2026-11-08T00:00:00.000Z',
    '2026-11-08T00:00:00+00:00',
  ]) {
    const result = renderDecisionBrief({ ...input, generatedAt });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(generatedAt);
    expect(result.body).toContain(`Generated: ${generatedAt}`);
  }
  expect(renderDecisionBrief({ ...input, generatedAt: '2026-02-30T00:00:00Z' })).toEqual({
    ok: false,
    category: 'input',
  });
});

test('neutralizes hostile text in model follow-ups', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario({ mode: 'malware-failed' });
  const hostile =
    '@alice @acme/team #123 owner/repo#123 https://evil.example :smile: ffffffffffffffffffffffffffffffffffffffff </details> <!-- reviewed-head: fake -->';
  const analysis = await analyzeDecisionUnits(
    input,
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () => {
            const document = analysisDocument(batch);
            for (const row of document.assessments)
              for (const followup of row.followups) followup.description = hostile;
            return Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(document) },
                },
              ],
            });
          },
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const rendered = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error('render failed');
  const section = rendered.body.split('## Non-blocking follow-ups')[1].split('\n## ')[0];
  expect(section).toContain('@\u200balice');
  for (const value of [
    '@alice',
    '@acme/team',
    '#123',
    'https://evil.example',
    ':smile:',
    'f'.repeat(40),
    '</details>',
    '<!-- reviewed-head: fake -->',
  ])
    expect(section).not.toContain(value);
  if (process.env.O1_FOLLOWUP_PROBE) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.O1_FOLLOWUP_PROBE, rendered.body);
  }
});

test('neutralizes hostile capability text while retaining its vetted source and context', async () => {
  const { analysisWithContext, capabilityDocument } = await import('../tests/parity/analysis.js');
  const { preparedSnapshot } = await import('./analysis/contract.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { batch } = await analysisWithContext('available');
  const snapshot = preparedSnapshot(batch)!;
  const hostile =
    '@alice @acme/team #123 owner/repo#123 https://evil.example :smile: ffffffffffffffffffffffffffffffffffffffff </details> <!-- reviewed-head: fake -->';
  const analysis = await analyzeDecisionUnits(
    { inventory: snapshot.inventory, config: snapshot.config, evaluatedAt: snapshot.evaluatedAt },
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (prepared, options) =>
        analyzeMistralBatch(prepared, options, {
          now: () => 0,
          fetch: async () => {
            const { document, feature } = capabilityDocument(prepared);
            const row = document.assessments.find((entry) => entry.newFunctionality.length);
            if (!row) throw new Error('missing capability fixture');
            row.newFunctionality = [
              { ...feature, feature: hostile, action: hostile, rationale: hostile },
            ];
            return Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(document) },
                },
              ],
            });
          },
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const rendered = renderDecisionBrief({
    binding: snapshot.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: [],
    signalBinding: snapshot.inventory.packet.binding,
  });
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error('render failed');
  const section = rendered.body.split('## New capabilities to adopt now')[1].split('\n## ')[0];
  expect(section).toContain('Repository context');
  expect(section).toContain('](<https://');
  expect(section).toContain('@\u200balice');
  for (const value of [
    '@alice',
    '@acme/team',
    '#123',
    'https://evil.example',
    ':smile:',
    'f'.repeat(40),
    '</details>',
    '<!-- reviewed-head: fake -->',
  ])
    expect(section).not.toContain(value);
  if (process.env.O1_CAPABILITY_PROBE) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.O1_CAPABILITY_PROBE, rendered.body);
  }
});

test('keeps a capability feature that starts with a list marker inside its list item', async () => {
  const { analysisWithContext, capabilityDocument } = await import('../tests/parity/analysis.js');
  const { preparedSnapshot } = await import('./analysis/contract.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { batch } = await analysisWithContext('available');
  const snapshot = preparedSnapshot(batch)!;
  for (const [feature, escaped] of [
    ['1. nested', '1\\. nested'],
    ['12. nested', '12\\. nested'],
    ['12) nested', '12\\) nested'],
    ['- nested', '\\- nested'],
    ['+ nested', '\\+ nested'],
    ['--- nested', '\\--- nested'],
    ['    1. nested', '1\\. nested'],
  ]) {
    const analysis = await analyzeDecisionUnits(
      { inventory: snapshot.inventory, config: snapshot.config, evaluatedAt: snapshot.evaluatedAt },
      { apiKey: 'test', deadlineMs: 700_000 },
      {
        now: () => 0,
        analyze: (prepared, options) =>
          analyzeMistralBatch(prepared, options, {
            now: () => 0,
            fetch: async () => {
              const { document, feature: base } = capabilityDocument(prepared);
              const row = document.assessments.find((entry) => entry.newFunctionality.length);
              if (!row) throw new Error('missing capability fixture');
              row.newFunctionality = [{ ...base, feature }];
              return Response.json({
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: JSON.stringify(document) },
                  },
                ],
              });
            },
          }),
      },
    );
    if (!analysis.ok) throw new Error('analysis fixture failed');
    const rendered = renderDecisionBrief({
      binding: snapshot.inventory.packet.binding,
      generatedAt: '2026-11-08T00:00:00.000Z',
      coverage: analysis.coverage,
      records: analysis.records,
      analysisUnavailable: analysis.analysisUnavailable,
      signalAttempts: [],
      signalBinding: snapshot.inventory.packet.binding,
    });
    if (!rendered.ok) throw new Error('render failed');
    const section = rendered.body.split('## New capabilities to adopt now')[1].split('\n## ')[0];
    expect(section).toContain(`\n- ${escaped} `);
    expect(section).not.toMatch(/^- (?:\s|\d+[.)]|[-+])/mu);
  }
});

test('neutralizes hostile finding and upstream source titles from a validated packet', async () => {
  const { analysisScenario, analysisDocument } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { analyzeMistralBatch } = await import('./analysis/mistral.js');
  const { input, scenario } = await analysisScenario();
  const packet = input.inventory.packet;
  const hostile =
    '@alice @acme/team #123 owner/repo#123 https://evil.example :smile: ffffffffffffffffffffffffffffffffffffffff </details> <!-- reviewed-head: fake -->';
  const candidate = {
    ...packet,
    changes: packet.changes.map((change) =>
      change.ecosystem === 'actions'
        ? {
            ...change,
            from: change.from ? { ...change.from, action: 'fixture/#123' } : null,
            to: change.to ? { ...change.to, action: 'fixture/#123' } : null,
          }
        : change,
    ),
    findings: packet.findings.map((finding) => ({ ...finding, rationale: hostile })),
    sources: packet.sources.map((source) =>
      source.provenance.kind === 'upstream'
        ? { ...source, provenance: { ...source.provenance, title: hostile } }
        : source,
    ),
  };
  const validated = validateReviewPacket(candidate, {
    binding: packet.binding,
    baseSha: packet.baseSha,
    contextRevision: packet.contextRevision,
    context: packet.context,
  });
  if (!validated.ok) throw new Error('hostile packet fixture rejected');
  const inventory = formDecisionUnits(validated.packet);
  const analysis = await analyzeDecisionUnits(
    { ...input, inventory },
    { apiKey: 'test', deadlineMs: 700_000 },
    {
      now: () => 0,
      analyze: (batch, options) =>
        analyzeMistralBatch(batch, options, {
          now: () => 0,
          fetch: async () =>
            Response.json({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) },
                },
              ],
            }),
        }),
    },
  );
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const rendered = renderDecisionBrief({
    binding: packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error('render failed');
  const coverage = rendered.body.split('## Decision coverage')[1].split('\n## ')[0];
  expect(coverage).toContain('@\u200balice');
  expect(rendered.body).toContain('fixture/#\u200b123');
  const assessments = rendered.body.split('## Package assessments')[1].split('\n## ')[0];
  expect(assessments).toContain('fixture/#\u200b123');
  expect(assessments).toContain('@\u200balice');
  expect(assessments).not.toContain('fixture/#123');
  for (const value of [
    '@alice',
    '@acme/team',
    '#123',
    'https://evil.example',
    ':smile:',
    'f'.repeat(40),
    '</details>',
    '<!-- reviewed-head: fake -->',
  ]) {
    expect(coverage).not.toContain(value);
    expect(assessments).not.toContain(value);
  }
  if (process.env.O1_FINDING_PROBE) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.O1_FINDING_PROBE, rendered.body);
  }
});

test('policy guide linked from assessments lists every default rule and verdict', async () => {
  const fs = await import('node:fs/promises');
  const { DEFAULT_VERDICTS } = await import('./config.js');
  const guide = await fs.readFile(new URL('../docs/policy-guide.md', import.meta.url), 'utf8');
  for (const [rule, verdict] of Object.entries(DEFAULT_VERDICTS)) {
    const row = guide.split('\n').find((line) => line.startsWith(`| \`${rule}\``));
    expect(row, rule).toBeDefined();
    expect(row, rule).toContain(`\`${verdict}\``);
  }
  expect(guide).toContain('.github/dependabot-review.json');
  const defaults = parseReviewConfig('{"version":1}');
  if (!defaults.ok) throw new Error('default config failed');
  expect(defaults.config.policy.minimumReleaseAgeDays).toBe(1);
  expect(guide).toContain('minimum release age (default one day)');
});

function gapUnit(reasons: EvidenceReason[], category = 'vulnerability') {
  return {
    members: [{ id: 'm1', name: 'pkg' }],
    evidenceLinks: [{ id: 's1', memberId: 'm1', category, status: 'unavailable', reasons }],
  } as unknown as DecisionUnit;
}

function gap(reasons: EvidenceReason[], category?: string): string {
  return evidenceGap(gapUnit(reasons, category), 's1');
}

function actionOf(sentence: string): string {
  return sentence.slice(sentence.indexOf('). ') + 3);
}

test('every evidence reason has a non-empty action sentence', () => {
  for (const reason of EVIDENCE_REASONS) {
    const action = actionOf(gap([reason]));
    expect(action, reason).not.toBe('');
    expect(action, reason).toMatch(/\.$/u);
  }
});

test.each([['budget'], ['missing'], ['unsupported']] as const)(
  'a %s gap never asks for a CI rerun, alone or with timeout',
  (reason) => {
    for (const reasons of [
      [reason],
      [reason, 'timeout'],
      [reason, 'permission'],
    ] as EvidenceReason[][]) {
      expect(gap(reasons), reasons.join(',')).not.toMatch(/rerun ci/iu);
    }
  },
);

test.each([[['timeout']], [['rate_limit', 'timeout']]] as const)(
  'a retry-only gap %j asks for exactly one later rerun',
  (reasons) => {
    const sentence = gap([...reasons]);
    expect(sentence.split('Rerun CI later.').length - 1).toBe(1);
  },
);

test('orders distinct actions by group and renders each once', () => {
  const budgetThenNoSource = actionOf(gap(['budget', 'missing']));
  expect(budgetThenNoSource.split('The review could not check').length - 1).toBe(1);
  expect(budgetThenNoSource.split('No supported source was found').length - 1).toBe(1);
  expect(budgetThenNoSource.indexOf('The review could not check')).toBeLessThan(
    budgetThenNoSource.indexOf('No supported source was found'),
  );
  const permissionFirst = actionOf(gap(['budget', 'permission']));
  expect(permissionFirst.indexOf('Correct the reviewer')).toBeLessThan(
    permissionFirst.indexOf('The review could not check'),
  );
  for (const reasons of [
    ['missing', 'unsupported'],
    ['malformed', 'truncated', 'conflict', 'unknown'],
  ] as EvidenceReason[][]) {
    const action = actionOf(gap(reasons));
    expect(action.split('check it manually').length - 1, reasons.join(',')).toBe(1);
  }
});

test('names a concrete manual step for each category', () => {
  expect(gap(['budget'], 'vulnerability')).toContain('search the GitHub Advisory Database for pkg');
  expect(gap(['budget'], 'malware')).toContain('search the GitHub Advisory Database for pkg');
  expect(gap(['budget'], 'upstream')).toContain("read pkg's release notes");
  expect(gap(['budget'], 'installScript')).toContain("review pkg's install scripts");
  expect(gap(['budget'], 'uploadedArtifact')).toContain("review pkg's uploaded artifact evidence");
});

async function renderLargeInventory(options: Omit<LargeInventoryOptions, 'duplicateNames'> = {}) {
  const { largeInventoryScenario } = await import('../tests/parity/large-inventory.js');
  const scenario = await largeInventoryScenario({ members: 93, duplicateNames: 2, ...options });
  const result = renderDecisionBrief(scenario.render);
  if (!result.ok) throw new Error(`large inventory render failed: ${result.category}`);
  const lines = result.body
    .split('\n')
    .filter((line) => line.startsWith('- ') && line.includes(' — '));
  return { packet: scenario.packet, body: result.body, lines, render: scenario.render };
}

type LargeRender = Awaited<ReturnType<typeof renderLargeInventory>>['render'];

function followupSectionOf(body: string) {
  return body.split('## Non-blocking follow-ups')[1].split('\n## ')[0];
}

function gapLinesOf(body: string) {
  return followupSectionOf(body)
    .split('\n')
    .filter((line) => line.startsWith('- ') && line.includes(' evidence is '));
}

function assessedGapsOf(render: LargeRender) {
  return render.coverage.policyProvenance.assessments.units.flatMap((evaluation, index) => {
    if (!render.records[index].assessment) return [];
    const unit = render.coverage.inventory.units[index];
    return evaluation.gaps.map((gap) => {
      const link = unit.evidenceLinks.find((entry) => entry.id === gap.sourceId)!;
      const member = unit.members.find((entry) => entry.id === link.memberId)!;
      return { unit, link, member };
    });
  });
}

function timeoutOnFirstFive(memberIndex: number, category: string) {
  return category === 'vulnerability' && memberIndex < 5
    ? { status: 'unavailable' as const, reasons: ['timeout' as const], sourceIds: [] }
    : null;
}

function namesPart(line: string) {
  return line.slice(2, line.indexOf(' — '));
}

function tailOf(line: string) {
  return line.slice(line.indexOf(' — '));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function changeName(change: { to?: unknown; from?: unknown }) {
  const side = (change.to ?? change.from) as { name?: string; action?: string } | undefined;
  return side?.name ?? side?.action;
}

function citationKey(
  packet: Awaited<ReturnType<typeof renderLargeInventory>>['packet'],
  sourceId: string,
) {
  const source = packet.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error(`missing source ${sourceId}`);
  if (source.provenance.kind === 'file') return source.provenance.revision;
  if (source.provenance.kind === 'upstream') return source.provenance.url;
  throw new Error(`unexpected provenance ${source.provenance.kind}`);
}

test('merges findings that share every rendered field into one line each', async () => {
  const { packet, lines } = await renderLargeInventory();
  const keys = new Set(
    packet.findings.map((finding) =>
      JSON.stringify([
        finding.kind,
        finding.rationale,
        'applicability' in finding ? (finding.applicability ?? null) : null,
        'severity' in finding ? (finding.severity ?? null) : null,
        ...finding.references.map((id) => citationKey(packet, id)),
      ]),
    ),
  );
  const tails = lines.map(tailOf);
  expect(new Set(tails).size).toBe(tails.length);
  expect(lines).toHaveLength(keys.size);
  expect(lines.length).toBeLessThan(packet.findings.length);
});

test('names every member of a merged finding line', async () => {
  const { packet, lines } = await renderLargeInventory();
  const duplicated = new Set<string>();
  const seen = new Set<string>();
  for (const change of packet.changes) {
    const name = changeName(change);
    if (name === undefined) continue;
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  }
  for (const finding of packet.findings) {
    const change = packet.changes.find((item) => item.id === finding.memberId);
    const name = change && changeName(change);
    if (!change || name === undefined) throw new Error('finding member has no name');
    // A same-named member must match its own copy's qualifier, which ends with its version.
    const version = ((change.to ?? change.from) as { version?: string }).version ?? 'unknown';
    const entry = duplicated.has(name)
      ? new RegExp(
          `(?:^|, )${escapeRegExp(name)} \\([^)]*, ${escapeRegExp(version)}\\)(?:,|$)`,
          'u',
        )
      : new RegExp(`(?:^|, )${escapeRegExp(name)}(?:,|$)`, 'u');
    expect(
      lines.some((line) => line.includes(`: ${finding.rationale}`) && entry.test(namesPart(line))),
    ).toBe(true);
  }
});

test('qualifies same-named members with distinct qualifiers on a merged line', async () => {
  const { packet, lines } = await renderLargeInventory();
  for (const name of ['child-0', 'child-1']) {
    const qualified = new RegExp(`(?:^|, )${escapeRegExp(name)} \\((npm[^)]*)\\)`, 'gu');
    const merged = lines
      .map((line) => [...namesPart(line).matchAll(qualified)].map((match) => match[1]))
      .find((qualifiers) => qualifiers.length === 2);
    expect(merged, `${name} copies on one finding line`).toBeDefined();
    expect(merged![0]).not.toBe(merged![1]);
    const bare = new RegExp(`(?:^|, )${escapeRegExp(name)}(?:,|$)`, 'u');
    expect(lines.some((line) => bare.test(namesPart(line)))).toBe(false);
    expect(packet.changes.filter((change) => changeName(change) === name).length).toBe(2);
  }
});

test('keeps findings that differ only in kind, applicability, or severity on separate lines', async () => {
  const { largeInventoryScenario } = await import('../tests/parity/large-inventory.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const scenario = await largeInventoryScenario({ members: 93, duplicateNames: 2 });
  const packet = scenario.render.coverage.inventory.packet;
  // Two findings on different members that share a rationale and render on one line.
  const byRationale = new Map<string, (typeof packet.findings)[number][]>();
  for (const finding of packet.findings)
    byRationale.set(finding.rationale, [...(byRationale.get(finding.rationale) ?? []), finding]);
  const pair = [...byRationale.values()].find(
    (findings) => new Set(findings.map((finding) => finding.memberId)).size > 1,
  )!;
  expect(pair, 'fixture has findings sharing a rationale').toBeDefined();
  const [a, b] = [pair[0], pair.find((finding) => finding.memberId !== pair[0].memberId)!];

  const base = { kind: 'vulnerability', applicability: 'unaffected', severity: 'low' };
  /** Renders with `a` and `b` as vulnerability findings; returns the line index naming each. */
  const lineIndexes = async (
    change: Partial<Record<'severity' | 'applicability' | 'kind', string>>,
  ) => {
    const edits = new Map([
      [a.id, base],
      [b.id, { ...base, ...change }],
    ]);
    const findings = packet.findings.map((finding) => ({
      ...finding,
      ...edits.get(finding.id),
    })) as unknown as typeof packet.findings;
    const inventory = formDecisionUnits({ ...packet, findings });
    const input = { ...scenario.input, inventory, unitIds: inventory.units.map((unit) => unit.id) };
    // Without a model every unit is unresolved; findings still render deterministically.
    const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
    if (!analysis.ok) throw new Error('analysis failed');
    const result = renderDecisionBrief({
      ...scenario.render,
      coverage: analysis.coverage,
      records: analysis.records,
      analysisUnavailable: analysis.analysisUnavailable,
    });
    if (!result.ok) throw new Error(`edited render rejected: ${result.category}`);
    const findingLines = result.body
      .split('\n')
      .filter((line) => line.startsWith('- ') && line.includes(' — '));
    const units = inventory.units;
    return [a, b].map((finding) => {
      const member = units.flatMap((unit) => unit.members).find((m) => m.id === finding.memberId)!;
      const shared = units
        .flatMap((unit) => unit.members)
        .some((m) => m.id !== member.id && m.name === member.name);
      const version = member.proposedVersion ?? member.currentVersion ?? 'unknown';
      const entry = new RegExp(
        shared
          ? `(?:^|, )${escapeRegExp(member.name)} \\([^)]*, ${escapeRegExp(version)}\\)(?:,|$)`
          : `(?:^|, )${escapeRegExp(member.name)}(?:,|$)`,
        'u',
      );
      return findingLines.findIndex(
        (line) => line.includes(`: ${finding.rationale}`) && entry.test(namesPart(line)),
      );
    });
  };

  const [first, second] = await lineIndexes({});
  expect(first, 'identical vulnerability findings share a line').toBeGreaterThanOrEqual(0);
  expect(first).toBe(second);
  for (const change of [
    { severity: 'moderate' },
    { applicability: 'resolved_by_proposed' },
    { kind: 'malware' },
  ]) {
    const [x, y] = await lineIndexes(change);
    const label = JSON.stringify(change);
    expect(x, label).toBeGreaterThanOrEqual(0);
    expect(y, label).toBeGreaterThanOrEqual(0);
    expect(x, label).not.toBe(y);
  }
});

test('keeps release-metadata findings with differing upstream URLs on separate lines', async () => {
  const { packet, lines } = await renderLargeInventory();
  const urlsByRationale = new Map<string, Set<string>>();
  for (const finding of packet.findings) {
    const keys = finding.references.map((id) => citationKey(packet, id));
    const bucket = urlsByRationale.get(finding.rationale) ?? new Set<string>();
    for (const key of keys) bucket.add(key);
    urlsByRationale.set(finding.rationale, bucket);
  }
  const differing = [...urlsByRationale].filter(([, urls]) => urls.size > 1);
  expect(differing.length).toBeGreaterThan(0);
  for (const [rationale] of differing) {
    const rendered = lines.filter((line) => line.includes(`: ${rationale}`));
    const distinct = new Set(
      packet.findings
        .filter((finding) => finding.rationale === rationale)
        .map((finding) => finding.references.map((id) => citationKey(packet, id)).join('\n')),
    );
    expect(rendered).toHaveLength(distinct.size);
  }
});

test('merges assessed-unit gaps with the same category, status, and reasons into one line each', async () => {
  const { body, render } = await renderLargeInventory({
    followups: 71,
    evidence: timeoutOnFirstFive,
  });
  const gaps = assessedGapsOf(render);
  const keys = new Set(
    gaps.map(({ link }) => JSON.stringify([link.category, link.status, link.reasons])),
  );
  expect(keys.size).toBe(2);
  expect(gapLinesOf(body)).toHaveLength(keys.size);
  expect(keys.size).toBeLessThan(gaps.length);
});

test('names every assessed gap member on its merged line, qualifying shared names', async () => {
  const { body, render } = await renderLargeInventory({
    followups: 71,
    evidence: timeoutOnFirstFive,
  });
  const lines = gapLinesOf(body);
  const memberCount = (name: string) =>
    render.coverage.inventory.units
      .flatMap((unit) => unit.members)
      .filter((member) => member.name === name).length;
  let sharedNamed = 0;
  for (const { link, member } of assessedGapsOf(render)) {
    const name = member.name;
    const shared = memberCount(name) > 1;
    sharedNamed += shared ? 1 : 0;
    const version = member.proposedVersion ?? member.currentVersion ?? 'unknown';
    const entry = shared
      ? new RegExp(
          `(?:^|, )${escapeRegExp(name)} \\([^)]*, ${escapeRegExp(version)}\\)(?:,|$)`,
          'u',
        )
      : new RegExp(`(?:^|, )${escapeRegExp(name)}(?:,|$)`, 'u');
    const phrase = `${link.category} evidence is ${link.status} (${link.reasons.join(', ')})`;
    expect(
      lines.some((line) => line.includes(phrase) && entry.test(line.slice(2, line.indexOf(': ')))),
      name,
    ).toBe(true);
  }
  expect(sharedNamed).toBeGreaterThan(0);
  for (const line of lines) expect(line).not.toMatch(/\d+ others?/u);
});

test('states the plural action once on the merged budget line', async () => {
  const { body } = await renderLargeInventory({ followups: 71 });
  const budget = gapLinesOf(body).filter((line) =>
    line.includes('check these packages within its limits'),
  );
  expect(budget).toHaveLength(1);
  const [line] = budget;
  expect(
    line.split('search the GitHub Advisory Database for each listed package.').length - 1,
  ).toBe(1);
  expect(line.slice(line.indexOf('). ') + 3)).not.toMatch(/child-/u);
});

test('renders a one-member gap group exactly as evidenceGap does', async () => {
  const { body, render } = await renderLargeInventory({
    followups: 71,
    evidence: (memberIndex, category) =>
      category === 'vulnerability' && memberIndex === 3
        ? { status: 'unavailable', reasons: ['timeout'], sourceIds: [] }
        : null,
  });
  const matches = assessedGapsOf(render).filter(
    ({ link }) => link.category === 'vulnerability' && link.reasons.join() === 'timeout',
  );
  expect(matches).toHaveLength(1);
  const [{ unit, link }] = matches;
  expect(gapLinesOf(body)).toContain(`- ${evidenceGap(unit, link.id)}`);
});

function gapKey(link: { category: string; status: string; reasons: readonly string[] }) {
  return JSON.stringify([link.category, link.status, link.reasons]);
}

/** Assessed gaps that differ only in status, or only in category, plus a same-named pair. */
function statusAndCategoryGaps(
  memberIndex: number,
  category: string,
  current: ChangeEvidence | undefined,
): ChangeEvidence | null {
  if (category === 'vulnerability' && memberIndex < 3)
    return { status: 'unavailable', reasons: ['timeout'], sourceIds: [] };
  if (category === 'vulnerability' && memberIndex < 6)
    return { status: 'partial', reasons: ['timeout'], sourceIds: current?.sourceIds ?? [] };
  if (category === 'malware' && memberIndex >= 6 && memberIndex < 9)
    return { status: 'unavailable', reasons: ['timeout'], sourceIds: [] };
  return null;
}

test('keeps assessed gaps that differ in status or category on separate lines', async () => {
  // 93 children plus 2 same-named copies, all assessed with a follow-up.
  const { body, render } = await renderLargeInventory({
    followups: 95,
    evidence: statusAndCategoryGaps,
  });
  const gaps = assessedGapsOf(render);
  const keys = new Set(gaps.map(({ link }) => gapKey(link)));
  const differOnlyIn = (field: 'status' | 'category') =>
    gaps.some(({ link: a }) =>
      gaps.some(
        ({ link: b }) =>
          a[field] !== b[field] &&
          (field === 'status' ? a.category === b.category : a.status === b.status) &&
          a.reasons.join() === b.reasons.join(),
      ),
    );
  expect(differOnlyIn('status'), 'fixture has gaps differing only in status').toBe(true);
  expect(differOnlyIn('category'), 'fixture has gaps differing only in category').toBe(true);
  const pairedOnOneLine = gaps.some(({ link: x, member: m }) =>
    gaps.some(
      ({ link: y, member: n }) => n.id !== m.id && n.name === m.name && gapKey(x) === gapKey(y),
    ),
  );
  expect(pairedOnOneLine, 'fixture has a same-named pair on one gap line').toBe(true);

  const lines = gapLinesOf(body);
  expect(lines).toHaveLength(keys.size);
  for (const { link, member } of gaps) {
    const phrase = `${link.category} evidence is ${link.status} (${link.reasons.join(', ')})`;
    const matching = lines.filter((line) => line.includes(phrase));
    expect(matching, phrase).toHaveLength(1);
    expect(
      entryPattern(render, member).test(matching[0].slice(2, matching[0].indexOf(': '))),
      `${member.name} on ${phrase}`,
    ).toBe(true);
  }
});

test('keeps each model follow-up as its own line in record order', async () => {
  const sentence = 'Confirm the recorded evidence gap with a fresh lookup before merging.';
  const { body, render } = await renderLargeInventory({
    followups: 71,
    followupText: () => sentence,
  });
  const found = followupSectionOf(body)
    .split('\n')
    .filter((line) => line.includes(sentence));
  expect(found).toHaveLength(71);
  const expectedUnits = render.records.flatMap((record, index) =>
    (record.assessment?.followups ?? []).map(() => render.coverage.inventory.units[index]),
  );
  expect(found).toHaveLength(expectedUnits.length);
  for (const [index, line] of found.entries()) {
    const names = line.slice(2, line.indexOf(': '));
    // Same-named members carry their qualifier; every member appears, in record order.
    for (const member of expectedUnits[index].members)
      expect(entryPattern(render, member).test(names), member.name).toBe(true);
    expect(names.replace(/ \([^)]*\)/gu, '')).toBe(
      expectedUnits[index].members.map((member) => member.name).join(', '),
    );
  }
});

function queueSectionOf(body: string) {
  return body.split('## Decision queue')[1].split('\n## ')[0];
}

function queueItemsOf(body: string) {
  return queueSectionOf(body)
    .split('\n')
    .filter((line) => line.startsWith('- '));
}

/** Entries are the names part of a queue item, split on "; ". */
function queueEntriesOf(item: string) {
  return /^- (.*?): /u.exec(item)![1].split('; ');
}

function entryMatches(entry: string, name: string, count = 1) {
  const noun = count === 1 ? 'update' : 'updates';
  return new RegExp(
    `^${escapeRegExp(name)}(?: \\([^)]*\\))? \\(${count} changed ${noun}\\)$`,
    'u',
  ).test(entry);
}

function unresolvedOf(render: LargeRender) {
  return render.records.flatMap((record, index) => {
    if (record.state.state === 'assessed') return [];
    return [{ unit: render.coverage.inventory.units[index], reason: record.state.reason }];
  });
}

const GAP_OPTIONS = {
  unresolved: 21,
  followups: 71,
  evidence: (memberIndex: number, category: string) =>
    category === 'vulnerability' && memberIndex < 3
      ? { status: 'unavailable' as const, reasons: ['budget' as const], sourceIds: [] }
      : null,
};

test('merges identical unresolved units into one queue item that names each unit', async () => {
  const { body, render } = await renderLargeInventory({ unresolved: 21, followups: 71 });
  const items = queueItemsOf(body);
  expect(items).toHaveLength(1);
  const unresolved = unresolvedOf(render);
  expect(unresolved).toHaveLength(21);
  const entries = queueEntriesOf(items[0]);
  expect(entries).toHaveLength(21);
  unresolved.forEach(({ unit }, index) => {
    expect(unit.members).toHaveLength(1);
    expect(entryMatches(entries[index], unit.members[0].name), entries[index]).toBe(true);
    // A same-named unit carries its qualifier, so the two copies stay distinguishable.
    const names = entries[index].replace(/ \(\d+ changed updates?\)$/u, '');
    expect(entryPattern(render, unit.members[0]).test(names), entries[index]).toBe(true);
  });
  expect(
    unresolved.some(({ unit }) =>
      render.coverage.inventory.units.some(
        (other) => other !== unit && other.members[0].name === unit.members[0].name,
      ),
    ),
    'fixture queues a same-named unit',
  ).toBe(true);
  expect(queueSectionOf(body).split(unresolved[0].reason).length - 1).toBe(1);
});

test('keeps unresolved units with different gap sets in separate queue items', async () => {
  const { body, render } = await renderLargeInventory(GAP_OPTIONS);
  const items = queueItemsOf(body);
  expect(items).toHaveLength(2);
  const gapItems = items.filter((item) => item.includes(' evidence is '));
  expect(gapItems).toHaveLength(1);
  const [gapItem] = gapItems;
  const gapped = unresolvedOf(render).filter(({ unit }) =>
    unit.evidenceLinks.some(
      (link) => link.category === 'vulnerability' && link.status === 'unavailable',
    ),
  );
  expect(gapped).toHaveLength(3);
  const gappedEntries = queueEntriesOf(gapItem);
  expect(gappedEntries).toHaveLength(3);
  gapped.forEach(({ unit }, index) =>
    expect(entryMatches(gappedEntries[index], unit.members[0].name)).toBe(true),
  );
  expect(gapItem).toContain('vulnerability evidence is unavailable (budget)');
  expect(gapItem.split('each listed package').length - 1).toBe(1);

  const [plainItem] = items.filter((item) => !item.includes(' evidence is '));
  expect(queueEntriesOf(plainItem)).toHaveLength(18);
  expect(plainItem).not.toContain(' evidence is ');
});

test('keeps queue-only gaps of unresolved units out of non-blocking follow-ups', async () => {
  const { body, render } = await renderLargeInventory(GAP_OPTIONS);
  const gapLines = gapLinesOf(body);
  expect(gapLines.length).toBeGreaterThan(0);
  const memberCount = (name: string) =>
    render.coverage.inventory.units
      .flatMap((unit) => unit.members)
      .filter((member) => member.name === name).length;
  // Same-named members are qualified on shared lines, so only uniquely named members can be matched exactly.
  const unique = unresolvedOf(render)
    .flatMap(({ unit }) => unit.members)
    .filter((member) => memberCount(member.name) === 1);
  const gappedUnique = unresolvedOf(render).filter(
    ({ unit }) =>
      unit.evidenceLinks.some(
        (link) => link.category === 'vulnerability' && link.status === 'unavailable',
      ) && memberCount(unit.members[0].name) === 1,
  );
  expect(gappedUnique.length).toBeGreaterThan(0);
  for (const member of unique) {
    const whole = new RegExp(`(?:^- |, )${escapeRegExp(member.name)}(?=:|,| \\()`, 'u');
    for (const line of gapLines) expect(line, member.name).not.toMatch(whole);
  }
});

test('keeps unresolved units with a different reason in separate queue items', async () => {
  const { render } = await renderLargeInventory({ unresolved: 21, followups: 71 });
  const k = render.records.findIndex((record) => record.state.state !== 'assessed');
  const reason = 'Analysis was rejected for this unit.';
  const unitId = render.coverage.inventory.units[k].id;
  const records = render.records.map((record, index) =>
    index === k ? { ...record, state: { ...record.state, reason } } : record,
  );
  const policy = render.coverage.policyProvenance.assessments;
  const assessments = policy.assessments.map((entry, index) =>
    index === k ? { ...entry, reason } : entry,
  );
  const unresolvedUnits = policy.unresolvedUnits.map((entry) =>
    entry.unitId === unitId ? { ...entry, reason } : entry,
  );
  const coverage = {
    ...render.coverage,
    policyProvenance: {
      ...render.coverage.policyProvenance,
      assessments: { ...policy, assessments, unresolvedUnits },
    },
  };
  const result = renderDecisionBrief({ ...render, coverage, records });
  if (!result.ok) throw new Error(`edited render rejected: ${result.category}`);
  const items = queueItemsOf(result.body);
  expect(items).toHaveLength(2);
  const rejected = items.filter((item) => item.includes(reason));
  expect(rejected).toHaveLength(1);
  const entries = queueEntriesOf(rejected[0]);
  expect(entries).toHaveLength(1);
  expect(entryMatches(entries[0], render.coverage.inventory.units[k].members[0].name)).toBe(true);
});

test('keeps unresolved units with a different recovery action in separate queue items', async () => {
  const { render } = await renderLargeInventory({ unresolved: 21, followups: 71 });
  const k = render.records.findIndex((record) => record.state.state !== 'assessed');
  // Same reason text; only the failure category, and so the recovery action, differs.
  const records = render.records.map((record, index) =>
    index === k ? { ...record, category: 'configuration' as const } : record,
  );
  const result = renderDecisionBrief({ ...render, records });
  if (!result.ok) throw new Error(`edited render rejected: ${result.category}`);
  const items = queueItemsOf(result.body);
  expect(items).toHaveLength(2);
  const configuration = items.filter((item) =>
    item.includes('Correct the provider configuration or credential, then rerun CI.'),
  );
  expect(configuration).toHaveLength(1);
  const entries = queueEntriesOf(configuration[0]);
  expect(entries).toHaveLength(1);
  expect(entryMatches(entries[0], render.coverage.inventory.units[k].members[0].name)).toBe(true);
});

test('renders a single unresolved unit as one unchanged queue line', async () => {
  const { body, render } = await renderLargeInventory({ unresolved: 1, followups: 71 });
  const [{ unit, reason }] = unresolvedOf(render);
  expect(queueItemsOf(body)).toEqual([
    `- ${unit.members[0].name} (1 changed update): ${reason} Rerun CI to retry dependency analysis. `,
  ]);
});

test('qualifies same-named members on single-unit queue items and follow-up lines', async () => {
  const { render } = await renderLargeInventory({ unresolved: 21, followups: 71 });
  const units = render.coverage.inventory.units;
  const members = units.flatMap((unit) => unit.members);
  const shared = (member: DecisionUnit['members'][number]) =>
    members.some((item) => item.id !== member.id && item.name === member.name);
  // A distinct recovery action puts one same-named unresolved unit in its own queue item.
  const k = render.records.findIndex(
    (record, index) => record.state.state !== 'assessed' && units[index].members.some(shared),
  );
  expect(k, 'fixture has a same-named unresolved unit').toBeGreaterThanOrEqual(0);
  const records = render.records.map((record, index) =>
    index === k ? { ...record, category: 'configuration' as const } : record,
  );
  const result = renderDecisionBrief({ ...render, records });
  if (!result.ok) throw new Error(`edited render rejected: ${result.category}`);
  const item = queueItemsOf(result.body).find((entry) =>
    entry.includes('Correct the provider configuration or credential, then rerun CI.'),
  );
  expect(item).toBeDefined();
  const entries = queueEntriesOf(item!);
  expect(entries).toHaveLength(1);
  const names = entries[0].replace(/ \(\d+ changed updates?\)$/u, '');
  for (const member of units[k].members)
    expect(entryPattern(render, member).test(names), member.name).toBe(true);

  const followed = render.records.flatMap((record, index) =>
    record.assessment?.followups.length && units[index].members.some(shared) ? [units[index]] : [],
  );
  expect(followed.length, 'fixture has a same-named unit with a follow-up').toBeGreaterThan(0);
  const lines = followupSectionOf(result.body)
    .split('\n')
    .filter((line) => line.startsWith('- ') && !line.includes(' evidence is '));
  for (const unit of followed)
    expect(
      lines.some((line) =>
        unit.members.every((member) =>
          entryPattern(render, member).test(line.slice(2, line.indexOf(': '))),
        ),
      ),
      unit.members[0].name,
    ).toBe(true);
});

function recoveryOf(category: string | null) {
  const found = RECOVERY_BY_CATEGORY.find(([entry]) => entry === category);
  if (!found) throw new Error(`no recovery action for ${category}`);
  return found[1];
}

/** A grouped item's gap sentence: the singular evidenceGap wording for "each listed package". */
function groupedGap(unit: DecisionUnit, sourceId: string) {
  const link = unit.evidenceLinks.find((entry) => entry.id === sourceId)!;
  const subject = 'each listed package';
  const placeholder = {
    members: [{ id: link.memberId, name: subject }],
    evidenceLinks: [link],
  } as unknown as DecisionUnit;
  return evidenceGap(placeholder, link.id)
    .slice(`${subject}: `.length)
    .replace('could not check this package', 'could not check these packages');
}

/** The queue item names the unit, states its recovery once, and ends with its exact gap text. */
function expectQueueItemActions(render: LargeRender, item: string) {
  const entries = queueEntriesOf(item);
  const units = render.coverage.inventory.units;
  const index = units.findIndex(
    (unit, i) =>
      render.records[i].state.state !== 'assessed' &&
      entryMatches(entries[0], unit.members[0].name, unit.memberCount),
  );
  expect(index, item).toBeGreaterThanOrEqual(0);
  const recoveryText = recoveryOf(render.records[index].category);
  expect(item.split(recoveryText).length - 1, item).toBe(1);
  const unit = units[index];
  const gaps = render.coverage.policyProvenance.assessments.units[index].gaps;
  const gapText = gaps
    .map((gap) =>
      entries.length > 1 ? groupedGap(unit, gap.sourceId) : evidenceGap(unit, gap.sourceId),
    )
    .join(' ');
  expect(item.endsWith(` ${gapText}`), item).toBe(true);
}

test('renders a single unresolved unit with a budget gap and its exact action', async () => {
  const { body, render } = await renderLargeInventory({
    unresolved: 1,
    followups: 71,
    evidence: (memberIndex, category) =>
      category === 'vulnerability' && memberIndex === 0
        ? { status: 'unavailable', reasons: ['budget'], sourceIds: [] }
        : null,
  });
  const [{ unit }] = unresolvedOf(render);
  const index = render.coverage.inventory.units.indexOf(unit);
  const gaps = render.coverage.policyProvenance.assessments.units[index].gaps;
  expect(gaps.length, 'the unresolved unit has a gap').toBeGreaterThan(0);
  const items = queueItemsOf(body);
  expect(items).toHaveLength(1);
  expect(queueEntriesOf(items[0])).toHaveLength(1);
  expectQueueItemActions(render, items[0]);
});

/** Whether a queue entry names the unit's first member with its changed-update count. */
function unitQueued(entries: string[], unit: DecisionUnit) {
  return entries.some(
    (entry) =>
      entry.includes(unit.members[0].name) && entry.includes(`${unit.memberCount} changed update`),
  );
}

const REQUIRED_CATEGORIES = ['upstream', 'vulnerability', 'malware', 'installScript'];

function coverageSectionOf(body: string) {
  return body.split('## Decision coverage')[1].split('\n## ')[0];
}

function checkedLinesOf(body: string) {
  return coverageSectionOf(body)
    .split('\n')
    .filter((line) => line.includes(': checked, none found for '));
}

function checkedLineOf(body: string, category: string) {
  return checkedLinesOf(body).filter((line) => line.startsWith(`- ${category}: `));
}

/** Member entries on a checked line, anchored as whole entries, qualified by version when shared. */
function entryPattern(render: LargeRender, member: DecisionUnit['members'][number]) {
  const shared = render.coverage.inventory.units
    .flatMap((unit) => unit.members)
    .some((item) => item.id !== member.id && item.name === member.name);
  const version = member.proposedVersion ?? member.currentVersion ?? 'unknown';
  return new RegExp(
    shared
      ? `(?:^|, )${escapeRegExp(member.name)} \\([^)]*, ${escapeRegExp(version)}\\)(?:,|$)`
      : `(?:^|, )${escapeRegExp(member.name)}(?:,|$)`,
    'u',
  );
}

/** Independently derived from the units, per the evidence coverage spec. */
function expectedCheckedNoneFound(render: LargeRender, category: string) {
  const units = render.coverage.inventory.units;
  return units.flatMap((unit) =>
    unit.members.filter((member) => {
      const link = unit.evidenceLinks.find(
        (entry) => entry.memberId === member.id && entry.category === category,
      );
      if (!link || link.status !== 'available') return false;
      return !units.some((other) =>
        other.findings.some(
          (finding) =>
            finding.memberId === member.id &&
            finding.references.some((id) => link.sourceIds.includes(id)),
        ),
      );
    }),
  );
}

function checkedNamesOf(line: string) {
  return line.slice(
    line.indexOf(': checked, none found for ') + ': checked, none found for '.length,
    -1,
  );
}

test('lists each category checked-none-found member once, on one line per category', async () => {
  const { render, body } = await renderLargeInventory();
  let categoriesWithLines = 0;
  for (const category of REQUIRED_CATEGORIES) {
    const expected = expectedCheckedNoneFound(render, category);
    const lines = checkedLineOf(body, category === 'installScript' ? 'install script' : category);
    if (!expected.length) {
      expect(lines, category).toHaveLength(0);
      continue;
    }
    categoriesWithLines++;
    expect(lines, category).toHaveLength(1);
    const names = checkedNamesOf(lines[0]);
    for (const member of expected) {
      expect(entryPattern(render, member).test(names), `${category}: ${member.name}`).toBe(true);
    }
    const unexpected = render.coverage.inventory.units
      .flatMap((unit) => unit.members)
      .filter((member) => !expected.includes(member));
    for (const member of unexpected) {
      expect(entryPattern(render, member).test(names), `${category} lists ${member.name}`).toBe(
        false,
      );
    }
  }
  expect(categoriesWithLines).toBeGreaterThanOrEqual(2);
});

test('never lists a member whose category is unavailable on its checked line', async () => {
  const { render, body } = await renderLargeInventory({ followups: 71 });
  const [line] = checkedLineOf(body, 'vulnerability');
  expect(line).toBeDefined();
  const unavailable = render.coverage.inventory.units
    .flatMap((unit) =>
      unit.members.map((member) => ({
        member,
        link: unit.evidenceLinks.find(
          (entry) => entry.memberId === member.id && entry.category === 'vulnerability',
        ),
      })),
    )
    .filter(({ link }) => link?.status === 'unavailable');
  expect(unavailable.length).toBeGreaterThan(0);
  const names = checkedNamesOf(line);
  for (const { member } of unavailable) {
    expect(entryPattern(render, member).test(names), member.name).toBe(false);
  }
  expect(names).toContain('child-0');
});

test('never lists a partial member on a checked line', async () => {
  const { render, body } = await renderLargeInventory({
    evidence: (memberIndex, category) =>
      category === 'upstream' && memberIndex === 0
        ? { status: 'partial', reasons: ['budget'], sourceIds: [] }
        : null,
  });
  const partial = render.coverage.inventory.units.flatMap((unit) =>
    unit.members.filter((member) =>
      unit.evidenceLinks.some(
        (link) =>
          link.memberId === member.id && link.category === 'upstream' && link.status === 'partial',
      ),
    ),
  );
  expect(partial).toHaveLength(1);
  const [line] = checkedLineOf(body, 'upstream');
  expect(line).toBeDefined();
  expect(entryPattern(render, partial[0]).test(checkedNamesOf(line))).toBe(false);
  expect(checkedNamesOf(line)).toContain('child-');
});

test('keeps checked-none-found lines when optional detail is omitted', async () => {
  const followupText = (i: number, name: string) =>
    `Follow-up for ${name} (${i}): ${'Confirm the recorded evidence with a fresh lookup. '.repeat(5)}`.slice(
      0,
      270,
    );
  const plain = await renderLargeInventory({ followups: 71 });
  const pressured = await renderLargeInventory({ followups: 71, followupText });
  expect(pressured.body).toContain('Some lower-priority detail was omitted to fit the comment.');
  expect(checkedLinesOf(plain.body).length).toBeGreaterThan(0);
  expect(checkedLinesOf(pressured.body)).toEqual(checkedLinesOf(plain.body));
});

test('leaves a member with an attributable finding off its category checked line', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario({ mode: 'malware' });
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const result = renderDecisionBrief({
    binding: input.inventory.packet.binding,
    generatedAt: '2026-11-08T00:00:00.000Z',
    coverage: analysis.coverage,
    records: analysis.records,
    analysisUnavailable: analysis.analysisUnavailable,
    signalAttempts: scenario.result.attempts,
    signalBinding: scenario.result.binding,
  });
  if (!result.ok) throw new Error('render failed');
  // child-0's malware finding cites its malware evidence, so its malware state is found, not clean.
  const found = input.inventory.units.flatMap((unit) =>
    unit.evidenceLinks
      .filter((link) => link.category === 'malware' && link.status === 'available')
      .filter((link) =>
        unit.findings.some(
          (finding) =>
            finding.memberId === link.memberId &&
            finding.references.some((id) => link.sourceIds.includes(id)),
        ),
      )
      .map((link) => unit.members.find((member) => member.id === link.memberId)!.name),
  );
  expect(found).toEqual(['child-0']);
  const malware = result.body.split('\n').find((line) => line.startsWith('- malware: '));
  expect(malware).toBeDefined();
  expect(malware).not.toMatch(/(?:for |, )child-0(?:,|\.$)/u);
  expect(malware).toMatch(/(?:for |, )fixture\/action(?:,|\.$)/u);
  // The same member stays on a category where nothing was found.
  const vulnerability = result.body
    .split('\n')
    .find((line) => line.startsWith('- vulnerability: '));
  expect(vulnerability).toMatch(/(?:for |, )child-0(?:,|\.$)/u);
});

/** Markdown escaping as the renderer applies it to model text (see `text` in reporting.ts). */
function renderedText(value: string) {
  return value.replace(/([\\`*_[\]{}()!|~])/gu, '\\$1').replace(/([@#:])/gu, '$1\u200b');
}

/** The R1 measurements: 93 members, 21 unresolved, 71 follow-ups, three or four shared gaps. */
function r1Evidence(memberIndex: number, category: string): ChangeEvidence | null {
  if (memberIndex === 21) return null;
  if (category === 'upstream')
    return { status: 'unavailable', reasons: ['unsupported'], sourceIds: [] };
  if (category === 'vulnerability')
    return { status: 'unavailable', reasons: ['budget'], sourceIds: [] };
  if (category === 'malware') {
    const reason: EvidenceReason = memberIndex < 10 ? 'budget' : 'missing';
    return { status: 'unavailable', reasons: [reason], sourceIds: [] };
  }
  return null;
}

test('the R1-shaped fixture fits the body limit and names every required record', async () => {
  // R1 had 93 units including two same-named pairs: 91 children plus 2 nested copies.
  const { packet, body, render } = await renderLargeInventory({
    members: 91,
    unresolved: 21,
    followups: 71,
    evidence: r1Evidence,
  });
  expect(render.coverage.inventory.units.filter((unit) => unit.ecosystem === 'npm')).toHaveLength(
    93,
  );
  expect(body.length).toBeLessThanOrEqual(limit('comment.maxBodyCodeUnits'));

  const queueEntries = queueItemsOf(body).flatMap(queueEntriesOf);
  expect(queueEntries).toHaveLength(21);
  for (const { unit } of unresolvedOf(render)) {
    expect(unitQueued(queueEntries, unit), unit.members[0].name).toBe(true);
    // The queue renders the required categories; other baseline gaps are outside this check.
    const phrases = unit.evidenceLinks
      .filter((link) => link.status !== 'available' && REQUIRED_CATEGORIES.includes(link.category))
      .map((link) => `${link.category} evidence is ${link.status} (${link.reasons.join(', ')})`);
    for (const phrase of phrases) {
      const items = queueItemsOf(body).filter((item) => item.includes(phrase));
      expect(unitQueued(items.flatMap(queueEntriesOf), unit), phrase).toBe(true);
    }
  }

  // Gap lines and gap queue items never ask for a CI rerun. An unresolved unit's analysis
  // reason and its recovery sentence say so, but they are not evidence gaps, so they are set aside.
  const unitText = [
    ...new Set(unresolvedOf(render).map(({ reason }) => reason)),
    'Rerun CI to retry dependency analysis.',
  ];
  const gapItems = queueItemsOf(body)
    .filter((item) => item.includes(' evidence is '))
    .map((item) => unitText.reduce((text, sentence) => text.split(sentence).join(''), item));
  const gapText = [...gapItems, ...gapLinesOf(body)];
  expect(gapText.length).toBeGreaterThan(0);
  for (const line of gapText) expect(line).not.toMatch(/rerun ci/iu);
  // Each queue item states its units' recovery once and ends with their exact gap actions.
  for (const item of queueItemsOf(body)) expectQueueItemActions(render, item);

  const section = followupSectionOf(body);
  const descriptions = render.records.flatMap((record) =>
    (record.assessment?.followups ?? []).map((followup) => followup.description),
  );
  // Every unit but child 21 has a gap: 93 units - 1 merge - 21 unresolved = 71 follow-ups, as in R1.
  expect(descriptions).toHaveLength(71);
  for (const description of descriptions)
    expect(section, description).toContain(renderedText(description));

  for (const { link, member } of assessedGapsOf(render)) {
    const phrase = `${link.category} evidence is ${link.status} (${link.reasons.join(', ')})`;
    const line = gapLinesOf(body).find((entry) => entry.includes(phrase));
    expect(line, phrase).toBeDefined();
    expect(
      entryPattern(render, member).test(line!.slice(2, line!.indexOf(': '))),
      member.name,
    ).toBe(true);
  }

  const children = packet.changes.filter(
    (change) => change.ecosystem === 'npm' && changeName(change)?.startsWith('child-'),
  );
  const child21 = children[21];
  const unitIndex = render.coverage.inventory.units.findIndex((unit) =>
    unit.members.some((member) => member.id === child21.id),
  );
  const unit = render.coverage.inventory.units[unitIndex];
  const record = render.records[unitIndex];
  expect(record.state.state).toBe('assessed');
  expect(record.assessment?.verdict).toBe('merge');
  expect(record.assessment?.followups ?? []).toHaveLength(0);
  // Baseline links outside the required categories can be unavailable without a policy gap.
  expect(render.coverage.policyProvenance.assessments.units[unitIndex].gaps).toEqual([]);
  for (const category of REQUIRED_CATEGORIES)
    expect(unit.evidenceLinks.find((link) => link.category === category)?.status, category).toBe(
      'available',
    );
  expect(assessedGapsOf(render).filter((entry) => entry.unit === unit)).toHaveLength(0);
  const assessed = render.records.filter((entry) => entry.state.state === 'assessed').length;
  expect(coverageSectionOf(body)).toContain(`${assessed} assessed decision unit`);
});

test('renders the checked lines after the coverage counts and before the finding lines', async () => {
  const { body } = await renderLargeInventory();
  const lines = coverageSectionOf(body)
    .split('\n')
    .filter((line) => line.trim() !== '');
  const counts = lines.findIndex((line) => /^\d+ changed updates?; /u.test(line));
  expect(counts, 'the coverage counts open the section').toBe(0);
  const checked = checkedLinesOf(body).map((line) => lines.indexOf(line));
  expect(checked.length, 'fixture has checked lines').toBeGreaterThan(0);
  for (const index of checked) expect(index).toBeGreaterThan(counts);
  const findings = lines.flatMap((line, index) => (line.includes(' — ') ? [index] : []));
  expect(findings.length, 'fixture has finding lines').toBeGreaterThan(0);
  expect(Math.max(...checked)).toBeLessThan(Math.min(...findings));
});

test('the checked-state fixture lists each required category once and names the partial finding', async () => {
  // Index 7 in the base packet's child order is child-0 at 2.0.0, the malware scenario's
  // target; the validated packet orders children differently, so the member is looked up below.
  const CHILD0_AT_2_0_0 = 7;
  const { packet, body, render } = await renderLargeInventory({
    mode: 'malware',
    evidence: (memberIndex, category, current) =>
      memberIndex === CHILD0_AT_2_0_0 && category === 'malware' && current
        ? { status: 'partial', reasons: ['budget'], sourceIds: current.sourceIds }
        : null,
  });
  expect(body.length).toBeLessThanOrEqual(limit('comment.maxBodyCodeUnits'));

  const partialLinks = render.coverage.inventory.units.flatMap((unit) =>
    unit.evidenceLinks.filter((link) => link.status === 'partial'),
  );
  expect(partialLinks.map((link) => link.category)).toEqual(['malware']);
  const [partialLink] = partialLinks;
  const member = render.coverage.inventory.units
    .flatMap((unit) => unit.members)
    .find((entry) => entry.id === partialLink.memberId)!;
  expect(member.name).toBe('child-0');
  expect(member.proposedVersion ?? member.currentVersion).toBe('2.0.0');
  const child0 = { id: member.id };

  for (const category of REQUIRED_CATEGORIES) {
    const label = category === 'installScript' ? 'install script' : category;
    const lines = checkedLineOf(body, label);
    expect(lines, category).toHaveLength(1);
    const names = checkedNamesOf(lines[0]);
    const expected = expectedCheckedNoneFound(render, category);
    expect(expected.length, category).toBeGreaterThan(0);
    for (const entry of expected)
      expect(entryPattern(render, entry).test(names), `${category}: ${entry.name}`).toBe(true);
    const others = render.coverage.inventory.units
      .flatMap((unit) => unit.members)
      .filter((entry) => !expected.includes(entry));
    for (const entry of others)
      expect(entryPattern(render, entry).test(names), `${category} lists ${entry.name}`).toBe(
        false,
      );
  }
  // child-0 at 2.0.0 is the malware target; that copy is not on the malware checked line.
  expect(entryPattern(render, member).test(checkedNamesOf(checkedLineOf(body, 'malware')[0]))).toBe(
    false,
  );

  const malwareFindings = packet.findings.filter(
    (finding) => finding.kind === 'malware' && finding.memberId === child0.id,
  );
  expect(malwareFindings.length).toBeGreaterThan(0);
  // Another child-0 copy (1.0.0) exists, so the Reasons not to merge line must qualify this one.
  const holds = body
    .split('## Reasons not to merge')[1]
    .split('\n## ')[0]
    .split('\n')
    .filter((line) => line.startsWith('- '));
  for (const finding of malwareFindings) {
    const line = holds.find((entry) => entry.includes(`: ${finding.rationale}`));
    expect(line, finding.rationale).toBeDefined();
    const label = line!.slice(2, line!.indexOf(`: ${finding.rationale}`));
    expect(label).toMatch(/ \(npm, .*, 2\.0\.0\)$/u);
    expect(entryPattern(render, member).test(label), label).toBe(true);
  }
  const gap = gapLinesOf(body).find((line) =>
    line.includes('malware evidence is partial (budget)'),
  );
  expect(gap).toBeDefined();
  expect(entryPattern(render, member).test(gap!.slice(2, gap!.indexOf(': ')))).toBe(true);
});

test('the irreducible boundary fixture returns size, not a rendered brief', async () => {
  const { largeInventoryScenario } = await import('../tests/parity/large-inventory.js');
  const followupText = (index: number, name: string) =>
    `Follow-up ${index} for ${name}: ${'Confirm the recorded evidence with a fresh lookup. '.repeat(6)}`.slice(
      0,
      270,
    );
  const scenario = await largeInventoryScenario({
    members: 93,
    duplicateNames: 2,
    followups: 71,
    followupsPerUnit: 8,
    followupText,
  });
  // Under the 50,000-code-unit limit, an oversized brief is reported as size; W2 maps this
  // to `render-size`, which src/pipeline.test.ts "hands a group too large to render off as a
  // failure that says so, never as a defect" pins for a real oversized brief.
  expect(renderDecisionBrief(scenario.render)).toMatchObject({ ok: false, category: 'size' });
});
