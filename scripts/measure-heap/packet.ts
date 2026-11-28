/**
 * Writes an invented review packet for the heap probe (see run.ts): the large-inventory npm
 * scenario built through the repository's parity collectors, with its trusted expectation.
 * Usage: packet.ts <out.json> <members> [<copies>] [<shape>]. With copies k above 1, every scaled
 * record is repeated k times under fresh hex ids, so ids and references stay consistent. Shape
 * `expansion` or `dense` then applies that shape from tests/parity/heap-shapes.ts.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Analysis from '../../tests/parity/analysis.js';
import type * as Shapes from '../../tests/parity/heap-shapes.js';
import type * as Limits from '../../src/limits.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { analysisScenario } = (await import(
  pathToFileURL(join(ROOT, 'tests/parity/analysis.ts')).href
)) as typeof Analysis;

const { denseShape, expansionShape } = (await import(
  pathToFileURL(join(ROOT, 'tests/parity/heap-shapes.ts')).href
)) as typeof Shapes;
const { limit } = (await import(pathToFileURL(join(ROOT, 'src/limits.ts')).href)) as typeof Limits;

const [out, members, copies = '1', shape = 'plain'] = process.argv.slice(2);
const { scenario, input } = await analysisScenario({
  inventory: { children: Number(members), anchorUnchanged: true, duplicateNames: 2 },
});
const packet = JSON.parse(JSON.stringify(input.inventory.packet)) as Record<
  string,
  { id: string }[]
>;

const HEX_ID = /[0-9a-f]{64}/g;
const renamed = (value: unknown, copy: number): unknown =>
  copy === 0
    ? value
    : JSON.parse(
        JSON.stringify(value)
          .replace(HEX_ID, (hex) => createHash('sha256').update(`${hex}:${copy}`).digest('hex'))
          .replace(/child-/g, `c${copy}child-`)
          .replace(/orbit/g, `orbit${copy}`)
          .replace(/"stepIndex":0/g, `"stepIndex":${copy}`),
      );
const FIELDS = ['changes', 'sources', 'findings', 'relationships', 'reachability'];
const scaled = (record: { id: string }) => new RegExp(HEX_ID.source).test(record.id);
for (const field of Number(copies) > 1 ? FIELDS : []) {
  const records = packet[field];
  packet[field] = [
    ...records.filter((record) => !scaled(record)),
    ...Array.from({ length: Number(copies) }, (_, copy) =>
      records.filter(scaled).map((record) => renamed(record, copy) as { id: string }),
    ).flat(),
  ];
}
const dump = {
  packet,
  expected: scenario.fixture.expected,
  configText: JSON.stringify({
    version: 1,
    analysis: { provider: 'mistral', model: 'synthetic-model' },
  }),
  evaluatedAt: input.evaluatedAt,
  signalAttempts: scenario.result.attempts,
};
const shapes: Record<string, () => string> = {
  plain: () => JSON.stringify(dump),
  expansion: () => expansionShape(dump, limit('packet.idCodeUnits')).text,
  dense: () => denseShape(JSON.stringify(dump)),
};
const text = shapes[shape]?.();
if (text === undefined) throw new Error(`shape must be one of ${Object.keys(shapes).join(', ')}`);
writeFileSync(out, text);
const written = JSON.parse(text) as { packet: Record<string, unknown[]> };
console.log(
  JSON.stringify({
    members: Number(members),
    copies: Number(copies),
    shape,
    bytes: Buffer.byteLength(JSON.stringify(written.packet)),
    changes: written.packet.changes?.length,
    sources: written.packet.sources?.length,
    findings: written.packet.findings?.length,
    relationships: written.packet.relationships?.length,
    reachability: written.packet.reachability?.length,
  }),
);
