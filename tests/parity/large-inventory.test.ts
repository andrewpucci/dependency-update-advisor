import { expect, test, vi } from 'vite-plus/test';
import { limit } from '../../src/limits.js';
import { renderDecisionBrief } from '../../src/reporting.js';
import { largeInventoryScenario } from './large-inventory.js';

// These tests build a 93-member inventory, some of them twice; that is about 2 s locally and
// several times that on a busy CI runner, so they share the reporting tests' fixed allowance.
vi.setConfig({ testTimeout: limit('tests.largeInventoryRenderTimeoutMs') });

const unavailableVulnerability = () => ({
  status: 'unavailable' as const,
  reasons: ['budget' as const],
  sourceIds: [],
});

function nameOf(change: { to?: unknown; from?: unknown }) {
  const side = (change.to ?? change.from) as { name?: string; action?: string };
  return side.name ?? side.action ?? '';
}

test('builds 93 members plus two same-named nested copies as standalone npm units', async () => {
  const { input, render } = await largeInventoryScenario({ members: 93, duplicateNames: 2 });
  const units = input.inventory.units.filter((unit) => unit.ecosystem === 'npm');
  expect(units).toHaveLength(95);
  expect(units.every((unit) => unit.kind === 'standalone')).toBe(true);
  const counts = new Map<string, number>();
  for (const unit of units) {
    const name = unit.members[0].name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  expect([...counts.values()].filter((count) => count === 2)).toHaveLength(2);
  expect(Math.max(...counts.values())).toBe(2);
  // Same-named members differ by version, so the renderer can tell them apart.
  for (const [name, count] of counts) {
    if (count < 2) continue;
    const versions = units
      .filter((unit) => unit.members[0].name === name)
      .map((unit) => unit.members[0].proposedVersion);
    expect(new Set(versions).size, name).toBe(2);
  }
  const result = renderDecisionBrief(render);
  expect(result.ok).toBe(true);
});

test('applies the vulnerability evidence option to every child in the packet', async () => {
  const { packet } = await largeInventoryScenario({
    members: 93,
    duplicateNames: 2,
    evidence: (_index, category) =>
      category === 'vulnerability' ? unavailableVulnerability() : null,
  });
  const children = packet.changes.filter((change) => nameOf(change).startsWith('child-'));
  expect(children).toHaveLength(95);
  for (const change of children)
    expect(change.evidence.vulnerability).toEqual(unavailableVulnerability());
});

// Rendering this shape within the comment limit is the capacity work (A3–A7); here only its inputs.
test('leaves 21 units unresolved', async () => {
  const { render } = await largeInventoryScenario({
    members: 93,
    duplicateNames: 2,
    unresolved: 21,
    followups: 71,
  });
  expect(render.coverage.counts.unresolvedUnits).toBe(21);
  expect(render.records.filter((record) => record.state.state !== 'assessed')).toHaveLength(21);
});

test('gives every member the shared informational findings R1 had', async () => {
  const { packet } = await largeInventoryScenario({ members: 93, duplicateNames: 2 });
  const sources = new Map(packet.sources.map((source) => [source.id, source]));
  const children = packet.changes.filter((change) => nameOf(change).startsWith('child-'));
  for (const change of children) {
    const findings = packet.findings.filter(
      (finding) => finding.memberId === change.id && finding.kind === 'informational',
    );
    expect(findings.length, change.id).toBeGreaterThanOrEqual(1);
    // Shared: each citation is a file source that names many members, as in R1.
    for (const finding of findings)
      for (const id of finding.references)
        expect(sources.get(id)?.memberIds.length ?? 0).toBeGreaterThan(1);
  }
});

test('gives 71 distinct follow-ups of about 150 characters', async () => {
  const { analysis } = await largeInventoryScenario({
    members: 93,
    duplicateNames: 2,
    unresolved: 21,
    followups: 71,
  });
  const texts = analysis.records.flatMap(
    (record) => record.assessment?.followups.map((followup) => followup.description) ?? [],
  );
  expect(texts).toHaveLength(71);
  for (const text of texts) expect(text.length).toBeGreaterThanOrEqual(130);
  for (const text of texts) expect(text.length).toBeLessThanOrEqual(170);
  expect(new Set(texts).size).toBe(71);
});

test('two runs with the same options build identical render inputs', async () => {
  const options = {
    members: 93,
    duplicateNames: 2,
    unresolved: 21,
    followups: 71,
  };
  const first = (await largeInventoryScenario(options)).render;
  const second = (await largeInventoryScenario(options)).render;
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
});
