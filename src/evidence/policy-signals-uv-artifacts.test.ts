import { expect, test } from 'vite-plus/test';
import { readUvArtifacts } from './policy-signals-uv-artifacts.js';
import { uvGraphFixture, uvLock } from '../../tests/parity/uv-graph.js';
import { uvMetadataScenario } from '../../tests/parity/uv-metadata.js';
import { reconcileUvGraph } from './uv-graph.js';
import type { GithubReadSession } from '../github-read.js';
const hash = 'a'.repeat(64);
const artifacts = `sdist={url="https://files.pythonhosted.org/fixture-1.tar.gz",hash="sha256:${hash}"}\nwheels=[{url="https://files.pythonhosted.org/fixture-1.whl",hash="sha256:${'b'.repeat(64)}"}]\n`;
test('recovers the complete exact artifact set from the same immutable lock', async () => {
  const f = await uvGraphFixture({ 'base:uv.lock': uvLock('1', artifacts) });
  const inventory = reconcileUvGraph({
    binding: f.binding,
    metadata: f.metadata,
    limits: f.limits,
  });
  if (inventory.kind !== 'inventory') throw new Error('inventory');
  const c = inventory.changes.find((c) => c.ecosystem === 'uv')!;
  const source = inventory.sources.find((s) => s.id === c.from?.sourceId)!;
  if (source.provenance.kind !== 'file') throw new Error('source');
  const p = source.provenance;
  expect(source.status, JSON.stringify(source)).toBe('available');
  const session: Pick<GithubReadSession, 'readFile'> = {
    readFile: async () => ({
      kind: 'available' as const,
      side: 'base' as const,
      path: p.path,
      repository: p.repository,
      commitSha: p.sha,
      blobSha: 'c'.repeat(40),
      bytes: Buffer.from(uvLock('1', artifacts)),
    }),
  };
  const input = { binding: f.binding, sources: inventory.sources };
  const limits = { ...uvMetadataScenario().input.limits, maxArtifacts: 10 };
  const result = await readUvArtifacts(input, c, 'base', session, limits);
  expect(result, JSON.stringify({ result, instance: c.from, limits })).toMatchObject({
    kind: 'known',
    value: [
      { filename: 'fixture-1.tar.gz', sha256: hash },
      { filename: 'fixture-1.whl', sha256: 'b'.repeat(64) },
    ],
  });
  expect(await readUvArtifacts(input, c, 'base', session, { ...limits, maxArtifacts: 1 })).toEqual({
    kind: 'unchecked',
    reason: 'budget',
  });
  expect(await readUvArtifacts(input, c, 'head', session, limits)).toEqual({
    kind: 'unchecked',
    reason: 'conflict',
  });
});
