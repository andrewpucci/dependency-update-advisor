/**
 * The largest-expansion packet the parity builders reach, validated by T4: the large-inventory
 * scenario at limit:packet.changes changes in the expansion shape (heap-shapes.ts), with every
 * source and finding id padded to limit:packet.idCodeUnits as well. src/units.test.ts and
 * src/analysis/projection.test.ts check the projection caps against it.
 */
import { limit } from '../../src/limits.js';
import { validateReviewPacket } from '../../src/schema.js';
import { analysisScenario } from './analysis.js';
import { expansionShape } from './heap-shapes.js';

/** 124 npm members plus the scenario's four other changes. */
const MEMBERS = limit('packet.changes') - 4;
const PAD = 'あ';

export async function expansionPacket() {
  const { scenario, input } = await analysisScenario({
    inventory: { children: MEMBERS, anchorUnchanged: true, duplicateNames: 2 },
  });
  const dump = {
    packet: JSON.parse(JSON.stringify(input.inventory.packet)) as {
      sources: { id: string }[];
      findings: { id: string }[];
    },
    expected: scenario.fixture.expected,
  };
  const units = limit('packet.idCodeUnits');
  let text = expansionShape(dump, units).text;
  const ids = [...dump.packet.sources, ...dump.packet.findings]
    .map((record) => record.id)
    .sort((a, b) => b.length - a.length);
  for (const id of ids)
    if (id.length < units)
      text = text.replaceAll(`"${id}"`, `"${id}${PAD.repeat(units - id.length)}"`);
  const shaped = JSON.parse(text) as typeof dump;
  const validated = validateReviewPacket(shaped.packet, shaped.expected as never);
  if (!validated.ok) throw new Error(`expansion packet: ${JSON.stringify(validated.error)}`);
  return { packet: validated.packet, config: input.config, evaluatedAt: input.evaluatedAt };
}
