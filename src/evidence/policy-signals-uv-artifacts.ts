import { isDeepStrictEqual } from 'node:util';
import type { GithubReadSession } from '../github-read.js';
import { PACKET_LIMITS } from '../schema.js';
import type { AdvisoryInput } from './advisories.js';
import { readToml, type UvParseLimits } from './uv-toml.js';
import { advisoryCheck, advisoryText } from './advisory-read.js';
import { isPlainObject, byCodeUnit } from './common.js';
import { observe, type Observation } from './policy-signals.js';

export type UvArtifact = { filename: string; sha256: string };
export type LockfileReader = Pick<GithubReadSession, 'readFile'>;
/** Members sharing a lockfile reuse one budgeted read per side instead of re-reading it. */
export function cacheLockfileReads(session: LockfileReader): LockfileReader {
  const reads = new Map<string, ReturnType<LockfileReader['readFile']>>();
  return {
    readFile: (request) => {
      const key = JSON.stringify(request);
      const read = reads.get(key) ?? session.readFile(request);
      reads.set(key, read);
      return read;
    },
  };
}
export type ArtifactLimits = UvParseLimits & { maxArtifacts: number };
export function artifactLimits(value: unknown): ArtifactLimits {
  advisoryCheck(isPlainObject(value));
  const keys = [
    'maxFileBytes',
    'maxTomlDepth',
    'maxTomlEntries',
    'maxPackages',
    'maxDeclarations',
    'maxEdges',
    'maxStringBytes',
    'maxRequirementTokens',
    'maxMarkerDepth',
    'maxArtifacts',
  ] as const;
  advisoryCheck(keys.every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) > 0));
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as ArtifactLimits;
}
export async function readUvArtifacts(
  input: Pick<AdvisoryInput, 'binding' | 'sources'>,
  change: AdvisoryInput['changes'][number],
  side: 'base' | 'head',
  session?: LockfileReader,
  limits?: ArtifactLimits,
): Promise<Observation<UvArtifact[]>> {
  if (!session || !limits) return { kind: 'unchecked', reason: 'unsupported' };
  const result = observe(() => {
    const instance = side === 'base' ? change.from : change.to;
    advisoryCheck(change.ecosystem === 'uv' && instance && 'marker' in instance);
    const source = input.sources.find((s) => s.id === instance.sourceId);
    advisoryCheck(
      source?.kind === 'file' && source.status === 'available' && source.provenance.kind === 'file',
    );
    const p = source.provenance;
    advisoryCheck(
      p.revision === side &&
        p.sha === (side === 'base' ? input.binding.baseSha : input.binding.headSha) &&
        isDeepStrictEqual(
          p.repository,
          side === 'base' ? input.binding.repository : input.binding.headRepository,
        ),
      'conflict',
    );
    advisoryCheck(
      p.path === (instance.root === '.' ? '' : instance.root + '/') + 'uv.lock',
      'conflict',
    );
    return { instance, p };
  });
  if (result.kind === 'unchecked') return result;
  const { instance, p } = result.value;
  let file;
  try {
    file = await session.readFile({ side, path: p.path });
  } catch {
    return { kind: 'unchecked', reason: 'unknown' };
  }
  return observe(() => {
    advisoryCheck(file.kind === 'available', file.kind === 'unavailable' ? file.reason : 'missing');
    advisoryCheck(
      file.side === side &&
        file.path === p.path &&
        file.commitSha === p.sha &&
        isDeepStrictEqual(file.repository, p.repository),
      'conflict',
    );
    const parsed = readToml(file.bytes, limits);
    advisoryCheck(
      parsed.kind === 'parsed',
      parsed.kind === 'unavailable' ? parsed.reason : 'malformed',
    );
    const data = parsed.value;
    advisoryCheck(
      (data.version === 1 || data.version === 1n) && [3, 5].includes(Number(data.revision)),
      'unsupported',
    );
    advisoryCheck(Array.isArray(data.package));
    advisoryCheck(data.package.length <= limits.maxPackages, 'budget');
    const matches = data.package.filter((raw) => {
      if (!isPlainObject(raw) || !isPlainObject(raw.source) || typeof raw.name !== 'string')
        return false;
      const markers = raw['resolution-markers'];
      if (markers !== undefined)
        advisoryCheck(Array.isArray(markers) && markers.every((m) => typeof m === 'string'));
      const marker =
        Array.isArray(markers) && markers.length
          ? JSON.stringify([...new Set(markers)].sort(byCodeUnit))
          : null;
      return (
        raw.name.toLowerCase().replace(/[-_.]+/gu, '-') === instance.name &&
        raw.version === instance.version &&
        raw.source.registry === instance.source.identity &&
        marker === instance.marker
      );
    });
    advisoryCheck(matches.length === 1, 'conflict');
    const pkg = matches[0];
    advisoryCheck(isPlainObject(pkg));
    advisoryCheck(pkg.wheels === undefined || Array.isArray(pkg.wheels));
    const entries = [
      ...(pkg.sdist === undefined ? [] : [pkg.sdist]),
      ...(Array.isArray(pkg.wheels) ? pkg.wheels : []),
    ];
    advisoryCheck(entries.length > 0, 'missing');
    advisoryCheck(
      entries.length <=
        Math.min(limits.maxArtifacts, Math.floor((PACKET_LIMITS.listEntries - 1) / 2)),
      'budget',
    );
    const artifacts = entries.map((raw) => {
      advisoryCheck(
        isPlainObject(raw) &&
          advisoryText(raw.url) &&
          typeof raw.hash === 'string' &&
          /^sha256:[a-f\d]{64}$/iu.test(raw.hash),
        'unsupported',
      );
      const url = new URL(raw.url);
      advisoryCheck(
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
        'unsupported',
      );
      const filename = decodeURIComponent(url.pathname.split('/').at(-1)!);
      advisoryCheck(advisoryText(filename) && !/[/\\?#\s]/u.test(filename), 'unsupported');
      return { filename, sha256: raw.hash.slice(7).toLowerCase() };
    });
    advisoryCheck(new Set(artifacts.map((a) => a.filename)).size === artifacts.length, 'conflict');
    return artifacts;
  });
}
