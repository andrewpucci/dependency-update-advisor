import { upstreamScenario, upstreamTestLimits } from './upstream.js';
import { createUpstreamReader } from '../../src/evidence/upstream-read.js';
import { enrichUpstream } from '../../src/evidence/upstream.js';
import { createAdvisoryReader, createMalwareReader } from '../../src/evidence/advisory-read.js';
import { enrichAdvisories } from '../../src/evidence/advisories.js';
import { createNpmRegistryReader } from '../../src/evidence/npm-registry.js';
import { createNpmPublishTimeReader } from '../../src/evidence/npm-publish-times.js';
import { createPolicySignalReader } from '../../src/evidence/policy-signals-read.js';
import { enrichPolicySignals } from '../../src/evidence/policy-signals.js';
import { validateReviewPacket } from '../../src/schema.js';
import { formDecisionUnits, evaluateUnitPolicy } from '../../src/units.js';
import { parseReviewConfig } from '../../src/config.js';
import { createGithubReadSession } from '../../src/github-read.js';

export type SignalScenarioOptions = {
  mode?:
    | 'clean'
    | 'malware'
    | 'malware-failed'
    | 'optional-failed'
    | 'recent'
    | 'boundary'
    | 'security-fix'
    | 'supply'
    | 'license'
    | 'deprecated'
    | 'pypi-provenance'
    | 'trust-downgrade'
    | 'artifact-mismatch'
    | 'artifact-mixed'
    | 'yanked';
  inventory?: Parameters<typeof upstreamScenario>[0];
};
const evaluationTime = Date.parse('2026-11-07T00:00:00Z');
function advisory(ecosystem: string, name: string, malware: boolean) {
  const id = malware ? 'GHSA-mmmm-nnnn-pppp' : 'GHSA-aaaa-bbbb-cccc';
  return {
    ghsa_id: id,
    html_url: 'https://github.com/advisories/' + id,
    type: malware ? 'malware' : 'reviewed',
    summary: malware ? 'Synthetic malware' : 'Synthetic fixed vulnerability',
    severity: 'high',
    withdrawn_at: null,
    vulnerabilities: [
      { package: { ecosystem, name }, vulnerable_version_range: malware ? '>=2.0.0' : '<2.0.0' },
    ],
  };
}
/** Synthetic HTTP with actual collectors/proof acquisition; C2 is explicitly disabled scaffolding. */
export async function policySignalScenario(options: SignalScenarioOptions = {}) {
  const mode = options.mode ?? 'clean',
    withArtifacts =
      options.inventory?.uvArtifacts ||
      [
        'pypi-provenance',
        'trust-downgrade',
        'artifact-mismatch',
        'artifact-mixed',
        'yanked',
      ].includes(mode);
  const fixture = await upstreamScenario({ ...options.inventory, uvArtifacts: withArtifacts }),
    requests: string[] = [];
  let phase: 'research' | 'signals' = 'research';
  const fetch = async (url: string, init: RequestInit) => {
    requests.push(url);
    const u = new URL(url),
      parts = u.pathname.split('/').map(decodeURIComponent);
    if (u.origin === 'https://api.github.com' && u.pathname === '/advisories') {
      const target = u.searchParams.get('affects')!,
        split = target.lastIndexOf('@'),
        name = target.slice(0, split),
        version = target.slice(split + 1),
        ecosystem = u.searchParams.get('ecosystem')!,
        malware = u.searchParams.get('type') === 'malware';
      if (malware && mode === 'malware-failed' && name === 'child-0')
        return Response.json({}, { status: 503 });
      return Response.json(
        malware && mode === 'malware' && name === 'child-0' && version === '2.0.0'
          ? [advisory(ecosystem, name, true)]
          : !malware &&
              mode === 'security-fix' &&
              ecosystem === 'npm' &&
              name === 'orbit' &&
              version === '1.0.0'
            ? [advisory(ecosystem, name, false)]
            : [],
      );
    }
    if (phase === 'signals' && mode === 'optional-failed')
      return Response.json({}, { status: 403 });
    const time = (name: string, version: string) =>
      version === '2.0.0' &&
      (mode === 'recent' || mode === 'boundary' || mode === 'security-fix') &&
      name === 'orbit'
        ? mode === 'boundary'
          ? '2026-11-06T00:00:00Z'
          : '2026-11-06T12:00:00Z'
        : version === '1.0.0'
          ? '2026-09-01T00:00:00Z'
          : '2026-10-01T00:00:00Z';
    if (u.origin === 'https://registry.npmjs.org') {
      const name = parts[1],
        version = parts[2];
      if (!version)
        return Response.json({
          name,
          time: { '1.0.0': time(name, '1.0.0'), '2.0.0': time(name, '2.0.0') },
        });
      const raw = await (await fixture.fetch(url, init)).json();
      const trusted = mode === 'supply' && version === '1.0.0';
      return Response.json({
        ...raw,
        license: mode === 'license' && version === '2.0.0' ? 'Apache-2.0' : 'MIT',
        maintainers: [{ name: mode === 'supply' && version === '2.0.0' ? 'bob' : 'alice' }],
        _npmUser: trusted
          ? {
              name: 'GitHub Actions',
              trustedPublisher: { id: 'github', oidcConfigId: 'fixture-config' },
            }
          : { name: 'alice' },
        deprecated:
          mode === 'deprecated' && version === '2.0.0' ? 'Use a maintained release' : undefined,
      });
    }
    if (u.origin === 'https://pypi.org') {
      if (parts[1] === 'integrity') {
        const version = parts[3],
          filename = parts[4];
        if (
          version === '2.0.0' &&
          (mode === 'trust-downgrade' || (mode === 'artifact-mixed' && filename.endsWith('.whl')))
        )
          return Response.json({}, { status: 404 });
        const sha256 = filename.endsWith('.whl') ? 'b'.repeat(64) : 'a'.repeat(64);
        const statement = {
          _type: 'https://in-toto.io/Statement/v1',
          subject: [{ name: filename, digest: { sha256 } }],
          predicateType: 'https://docs.pypi.org/attestations/publish/v1',
        };
        return Response.json({
          version: 1,
          attestation_bundles: [
            {
              publisher: {
                kind: 'GitHub',
                repository: 'fixture/python',
                workflow:
                  mode === 'pypi-provenance' && version === '2.0.0'
                    ? 'new-release.yml'
                    : 'release.yml',
                environment: '',
              },
              attestations: [
                {
                  version: 1,
                  envelope: {
                    statement: Buffer.from(JSON.stringify(statement)).toString('base64'),
                    signature: 'c2lnbmF0dXJl',
                  },
                  verification_material: {
                    certificate: 'registry-reported-certificate',
                    transparency_entries: [{}],
                  },
                },
              ],
            },
          ],
        });
      }
      const raw = await (await fixture.fetch(url, init)).json();
      const yanked = mode === 'yanked' && parts[3] === '2.0.0';
      return Response.json({
        ...raw,
        info: {
          ...raw.info,
          license_expression: 'MIT',
          yanked,
          yanked_reason: yanked ? 'Compatibility regression' : null,
        },
        urls: [
          {
            filename: parts[2] + '-' + parts[3] + '.tar.gz',
            digests: { sha256: mode === 'artifact-mismatch' ? 'c'.repeat(64) : 'a'.repeat(64) },
            upload_time_iso_8601: time(parts[2], parts[3]),
            yanked,
            yanked_reason: yanked ? 'Compatibility regression' : null,
          },
          ...(withArtifacts
            ? [
                {
                  filename: parts[2] + '-' + parts[3] + '.whl',
                  digests: { sha256: 'b'.repeat(64) },
                  upload_time_iso_8601: '2026-10-02T00:00:00Z',
                  yanked,
                  yanked_reason: yanked ? 'Compatibility regression' : null,
                },
              ]
            : []),
        ],
      });
    }
    return fixture.fetch(url, init);
  };
  const open = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch });
  if (open.kind !== 'ready') throw new Error('reader');
  const upstream = await enrichUpstream(fixture.input, open);
  open.reader.close();
  if (upstream.kind !== 'enriched') throw new Error('S2: ' + JSON.stringify(upstream));
  const reviewed = createAdvisoryReader(fixture.advisoryLimits, { now: () => 0, fetch });
  if (reviewed.kind !== 'ready') throw new Error('reader');
  const advisories = await enrichAdvisories(
    { ...upstream, limits: fixture.advisoryLimits },
    { reader: reviewed },
  );
  reviewed.close();
  if (advisories.kind !== 'enriched') throw new Error('advisories');
  phase = 'signals';
  const artifacts = withArtifacts
    ? await createGithubReadSession(
        { binding: fixture.input.binding, limits: fixture.consumerReadLimits },
        { fetch: fixture.consumerFetch, now: () => 0 },
      )
    : null;
  if (artifacts && artifacts.kind !== 'ready') throw new Error('artifact session');
  const lockReads: unknown[] = [];
  const artifactSession =
    artifacts?.kind === 'ready'
      ? {
          ...artifacts.session,
          readFile: (request: unknown) => {
            lockReads.push(request);
            return artifacts.session.readFile(request);
          },
        }
      : undefined;
  const malware = createMalwareReader(upstreamTestLimits, { now: () => 0, fetch }),
    npm = createNpmRegistryReader(upstreamTestLimits, { now: () => 0, fetch }),
    times = createNpmPublishTimeReader(upstreamTestLimits, { now: () => 0, fetch }),
    metadata = createPolicySignalReader(upstreamTestLimits, { now: () => 0, fetch }),
    actions = createUpstreamReader(upstreamTestLimits, { now: () => 0, fetch });
  if (
    malware.kind !== 'ready' ||
    npm.kind !== 'ready' ||
    times.kind !== 'ready' ||
    metadata.kind !== 'ready' ||
    actions.kind !== 'ready'
  )
    throw new Error('reader');
  const input = {
    ...fixture.input,
    ...advisories,
    publicIdentities: upstream.publicIdentities,
    actionVersions: upstream.actionVersions,
    evaluationTime,
    limits: { ...upstreamTestLimits, maxFindings: 500 },
    ...(withArtifacts
      ? { artifactLimits: { ...fixture.artifactParseLimits, maxArtifacts: 10 } }
      : {}),
  };
  const result = await enrichPolicySignals(input, {
    malwareReader: malware,
    npmReader: npm,
    publishTimeReader: times,
    metadataReader: metadata,
    upstreamReader: actions.reader,
    artifactSession,
  });
  malware.close();
  times.close();
  metadata.close();
  actions.reader.close();
  if (artifacts?.kind === 'ready') artifacts.session.close();
  if (result.kind !== 'enriched') throw new Error(JSON.stringify(result));
  const packet = validateReviewPacket(
    {
      version: 1,
      ...fixture.expected,
      changes: result.changes,
      sources: result.sources,
      findings: result.findings,
      coverage: fixture.coverage,
      relationships: fixture.relationships,
    },
    fixture.expected,
  );
  if (!packet.ok) throw new Error(JSON.stringify(packet));
  const units = formDecisionUnits(packet.packet);
  const policy = evaluateUnitPolicy(
    units,
    parseReviewConfig(
      JSON.stringify({
        version: 1,
        policy: {
          verdicts:
            mode === 'malware'
              ? { incompleteEvidence: 'merge', highOrCriticalVulnerability: 'merge' }
              : {},
        },
      }),
    ),
    evaluationTime,
  );
  return {
    fixture,
    upstream,
    advisories,
    result,
    packet,
    units,
    policy,
    requests,
    input,
    lockReads,
  };
}
