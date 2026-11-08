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
  const queue = result.body.split('## Decision queue')[1].split('## Decision coverage')[0];
  const items = queue.split('\n').filter((line) => line.startsWith('- '));
  expect(items).toHaveLength(input.inventory.units.length);
  for (const [index, unit] of input.inventory.units.entries()) {
    expect(items[index]).toContain(unit.members[0].name);
    expect(items[index]).toContain(
      'Correct the provider configuration or credential, then rerun CI.',
    );
  }
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
  expect(assessmentBlocks.every((block) => block.includes('  - Policy:'))).toBe(true);
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

test('renders an assessed coverage-policy hold with its concrete blocker', async () => {
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
  const analysis = await analyzeDecisionUnits(
    { ...input, config },
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
  expect(rendered.body).toContain('Reasons not to merge');
  expect(rendered.body).toContain('The proposed change needs remediation');
});

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
    const queue = body.split('## Decision queue')[1].split('## Decision coverage')[0];
    const items = queue.split('\n').filter((line) => line.startsWith('- '));
    expect(items).toHaveLength(input.inventory.units.length);
    for (const [index, unit] of input.inventory.units.entries()) {
      expect(items[index]).toContain(unit.members[0].name);
      expect(items[index]).toContain(`${unit.memberCount} changed update`);
      expect(items[index]).toContain(
        'Correct the provider configuration or credential, then rerun CI.',
      );
    }
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
    '@alice @acme/team #123 owner/repo#123 https://evil.example :smile: ffffffffffffffffffffffffffffffffffffffff </details> <!-- reviewed-head: fake --> [click](https://evil.example)';
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

test('maps every M2 failure category to its applicable recovery action', async () => {
  const { analysisScenario } = await import('../tests/parity/analysis.js');
  const { analyzeDecisionUnits } = await import('./analysis/batches.js');
  const { input, scenario } = await analysisScenario();
  const analysis = await analyzeDecisionUnits(input, { deadlineMs: 700_000 }, { now: () => 0 });
  if (!analysis.ok) throw new Error('analysis fixture failed');
  const cases = [
    ...[
      'transport',
      'http',
      'media-type',
      'response-size',
      'encoding',
      'envelope',
      'json',
      'deadline',
      'cancelled',
      'call_budget',
    ].map((category) => [category, 'Rerun CI to retry dependency analysis.']),
    ['configuration', 'Correct the provider configuration or credential'],
    ...['budget', 'length'].map((category) => [
      category,
      'Inspect the oversized input or response',
    ]),
    ...['input', 'projection', 'reference', 'schema', 'policy', 'unexpected'].map((category) => [
      category,
      'Investigate the failed review data or validation',
    ]),
  ];
  for (const [category, expected] of cases) {
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
    const queue = result.body.split('## Decision queue')[1].split('## Decision coverage')[0];
    const items = queue.split('\n').filter((line) => line.startsWith('- '));
    expect(items).toHaveLength(input.inventory.units.length);
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
  const gapAction = `${member.name}: malware evidence is ${link.status} (${link.reasons.join(', ')}). Review the malware evidence for ${member.name} and rerun CI.`;
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
    const queue = rendered.body.split('## Decision queue')[1].split('## Decision coverage')[0];
    const items = queue.split('\n').filter((line) => line.startsWith('- '));
    expect(items).toHaveLength(input.inventory.units.length);
    for (const [index, unit] of input.inventory.units.entries()) {
      expect(items[index]).toContain(unit.members[0].name);
      expect(items[index]).toContain('Rerun CI to retry dependency analysis.');
    }
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
