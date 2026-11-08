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
  for (const unit of input.inventory.units) expect(result.body).toContain(unit.members[0].name);
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
  expect(result.body).toContain('releaseMetadata');
  expect(result.body).toContain('Merge after reviewing the evidence');
  if (process.env.O1_GROUPED_PREVIEW) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.O1_GROUPED_PREVIEW, result.body);
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
  expect(result.body).toContain(`License lookup for ${member.name} (${attempt.side}): timeout.`);
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
  const records = result.records.map((record) => {
    if (!record.assessment?.newFunctionality.length) return record;
    return {
      ...record,
      assessment: {
        ...record.assessment,
        newFunctionality: record.assessment.newFunctionality.map((capability) => ({
          ...capability,
          sourceUrl: 'https://evil.example/',
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
  const overflow = renderDecisionBrief(make('é'.repeat(length + 1) + '<'));
  expect(overflow.ok && overflow.body).toContain('omitted');
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
    '@alice #123 owner/repo#123 https://evil.example :smile: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa </details> <!-- reviewed-head: fake --> [click](https://evil.example)';
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
  expect(result.body).toContain('Evidence coverage:** Incomplete');
  expect(result.body).toContain('Non-blocking follow-ups');
  expect(result.body).toContain('malware evidence');
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
    '@alice #123 owner/repo#123 https://evil.example :smile: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa </details> <!-- reviewed-head: fake --> [click](https://evil.example)';
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
    for (const unit of input.inventory.units) expect(rendered.body).toContain(unit.members[0].name);
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
