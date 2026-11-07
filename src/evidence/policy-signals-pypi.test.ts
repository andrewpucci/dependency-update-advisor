import { expect, test } from 'vite-plus/test';
import { pypiReleaseFacts, pypiProvenanceFacts } from './policy-signals-pypi.js';
import { createPolicySignalReader } from './policy-signals-read.js';
import { enrichPolicySignals } from './policy-signals.js';
import { createMalwareReader } from './advisory-read.js';
import { createUpstreamReader } from './upstream-read.js';
import { enrichUpstream } from './upstream.js';
import { upstreamScenario, upstreamTestLimits } from '../../tests/parity/upstream.js';
import { validateReviewPacket } from '../schema.js';
const evaluationTime = Date.parse('2026-11-07T00:00:00Z');
test('a valid future PyPI upload is conflicting metadata, distinct from an invalid date', () => {
  const data = (date: string) => ({ info: {}, urls: [file(date)] });
  expect(pypiReleaseFacts(data('2027-01-01T00:00:00Z'), evaluationTime).publishedAt).toEqual({
    kind: 'unchecked',
    reason: 'conflict',
  });
  expect(pypiReleaseFacts(data('2027-02-30T00:00:00Z'), evaluationTime).publishedAt).toEqual({
    kind: 'unchecked',
    reason: 'malformed',
  });
});
test.each(['valid', 'digest', 'predicate', 'publisher', 'envelope'])(
  'PyPI %s provenance is bound to the exact artifact without a cryptographic claim',
  (mode) => {
    const artifact = { filename: 'fixture.whl', sha256: 'a'.repeat(64) };
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: artifact.filename,
          digest: { sha256: mode === 'digest' ? 'b'.repeat(64) : artifact.sha256 },
        },
      ],
      predicateType:
        mode === 'predicate'
          ? 'https://unknown.example/predicate'
          : 'https://docs.pypi.org/attestations/publish/v1',
    };
    const metadata = createPolicySignalReader(upstreamTestLimits, {
      now: () => 0,
      fetch: async () => Response.json({}),
    });
    if (metadata.kind !== 'ready') throw new Error('reader');
    const envelope = {
      statement:
        mode === 'envelope' ? 'broken' : Buffer.from(JSON.stringify(statement)).toString('base64'),
      signature: 'c2lnbmF0dXJl',
    };
    const result = pypiProvenanceFacts(
      {
        version: 1,
        attestation_bundles: [
          {
            publisher: {
              kind: mode === 'publisher' ? 'Unknown' : 'GitHub',
              repository: 'fixture/project',
              workflow: 'release.yml',
              environment: '',
            },
            attestations: [
              {
                version: 1,
                envelope,
                verification_material: {
                  certificate: 'registry-reported-certificate',
                  transparency_entries: [{}],
                },
              },
            ],
          },
        ],
      },
      artifact,
      metadata,
    );
    metadata.close();
    expect(result.kind).toBe(mode === 'valid' ? 'known' : 'unchecked');
    if (result.kind === 'known')
      expect(result.value).toMatchObject({ kind: 'trusted', provider: 'pypi:GitHub' });
  },
);
const file = (date: string, yanked = false) => ({
  filename: date.includes('01T') ? 'fixture.tar.gz' : 'fixture.whl',
  digests: { sha256: 'a'.repeat(64) },
  upload_time_iso_8601: date,
  yanked,
  yanked_reason: yanked ? 'Incompatible release' : null,
});
test('earliest PyPI file upload sets release age without selecting an installation environment', () => {
  const f = pypiReleaseFacts(
    {
      info: { license_expression: 'MIT' },
      urls: [file('2026-11-02T00:00:00Z'), file('2026-11-01T00:00:00Z')],
    },
    evaluationTime,
  );
  expect(f.publishedAt).toEqual({ kind: 'known', value: Date.parse('2026-11-01T00:00:00Z') });
  expect(f.deprecated).toEqual({ kind: 'known', value: null });
  expect(f.license).toEqual({ kind: 'known', value: 'MIT' });
});
test('PyPI yank marker retains an empty reason and conflicts remain unchecked', () => {
  const f = pypiReleaseFacts(
    {
      info: { yanked: true, yanked_reason: '' },
      urls: [{ ...file('2026-11-01T00:00:00Z', true), yanked_reason: '' }],
    },
    evaluationTime,
  );
  expect(f.deprecated).toEqual({ kind: 'known', value: { marker: 'yanked', reason: '' } });
  const conflict = pypiReleaseFacts(
    { info: { yanked: false }, urls: [file('2026-11-01T00:00:00Z', true)] },
    evaluationTime,
  );
  expect(conflict.deprecated).toEqual({ kind: 'unchecked', reason: 'conflict' });
  expect(conflict.publishedAt.kind).toBe('known');
});
test.each([
  { urls: [] },
  { urls: [file('2099-01-01T00:00:00Z')] },
  { urls: [{ ...file('2026-11-01T00:00:00Z'), yanked: undefined }] },
])('missing or malformed PyPI file facts remain unchecked: %j', ({ urls }) => {
  const f = pypiReleaseFacts({ info: {}, urls }, evaluationTime);
  expect(f.publishedAt.kind === 'unchecked' || f.deprecated.kind === 'unchecked').toBe(true);
});
test('exact PyPI release evidence passes T4 with earliest upload and yank findings', async () => {
  const f = await upstreamScenario();
  const ur = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch: f.fetch });
  if (ur.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(f.input, ur);
  ur.reader.close();
  if (upstream.kind !== 'enriched') throw new Error('upstream');
  const metadata = createPolicySignalReader(upstreamTestLimits, {
    now: () => 0,
    fetch: async (url) => {
      const parts = new URL(url).pathname.split('/');
      return Response.json({
        info: {
          name: parts[2],
          version: parts[3],
          yanked: true,
          yanked_reason: 'Compatibility regression',
        },
        urls: [
          { ...file('2026-11-01T00:00:00Z', true), yanked_reason: 'Compatibility regression' },
        ],
      });
    },
  });
  const malware = createMalwareReader(f.advisoryLimits, {
    now: () => 0,
    fetch: async () => Response.json([]),
  });
  if (metadata.kind !== 'ready' || malware.kind !== 'ready') throw new Error('reader');
  const out = await enrichPolicySignals(
    { ...upstream, evaluationTime, limits: { ...f.advisoryLimits, maxAttempts: 1000 } },
    { malwareReader: malware, metadataReader: metadata },
  );
  metadata.close();
  malware.close();
  if (out.kind !== 'enriched') throw new Error(JSON.stringify(out));
  expect(
    out.changes
      .filter((c) => c.ecosystem === 'uv')
      .every(
        (c) =>
          c.evidence.publishTime.status === 'available' &&
          c.evidence.deprecation.status === 'available',
      ),
  ).toBe(true);
  expect(
    out.findings.some((f) => f.kind === 'releaseMetadata' && f.deprecated?.marker === 'yanked'),
  ).toBe(true);
  const packet = validateReviewPacket(
    {
      version: 1,
      ...f.expected,
      changes: out.changes,
      sources: out.sources,
      findings: out.findings,
      coverage: f.coverage,
      relationships: f.relationships,
    },
    f.expected,
  );
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
});
