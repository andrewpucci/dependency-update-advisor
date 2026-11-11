import { Composer, Parser, visit, isMap, isSeq } from 'yaml';
import type { RepositoryIdentity } from './event.js';
import { preflight, YamlFailure } from './evidence/actions-yaml.js';
import type { EvidenceReason } from './schema.js';

/** Bounds on the Dependabot configuration file and the roots read from it. */
export const DEPENDABOT_ROOT_LIMITS = Object.freeze({
  maxFileBytes: 65_536,
  maxYamlNodes: 20_000,
  maxYamlDepth: 16,
  maxAliasExpansions: 0,
  maxUpdates: 256,
  maxRoots: 256,
});

const MAX_PATH_BYTES = 1_024;

type Revision = Readonly<{ repository: RepositoryIdentity; sha: string }>;

export type EcosystemRoots =
  | Readonly<{ kind: 'roots'; roots: readonly string[] }>
  | Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;
export type DependabotRoots =
  | Readonly<{ kind: 'roots'; npm: EcosystemRoots; uv: EcosystemRoots }>
  | Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;

type Path = { kind: 'ok'; path: string } | { kind: 'glob' } | { kind: 'bad' };
type Ecosystem = 'npm' | 'uv';
type Collected = { roots: Set<string>; malformed: boolean; unsupported: boolean };

function fail(reason: EvidenceReason): never {
  throw new YamlFailure(reason);
}

/** One leading and one trailing slash are Dependabot syntax; everything else must be a plain path. */
function canonicalPath(directory: string): Path {
  if (/[\p{Cc}\p{Cs}\\]/u.test(directory)) return { kind: 'bad' };
  let path = directory === '/' ? '.' : directory;
  if (path !== '.') {
    if (path.startsWith('/')) path = path.slice(1);
    if (path.endsWith('/')) path = path.slice(0, -1);
    if (path === '' || path.split('/').some((part) => part === '' || part === '.' || part === '..'))
      return { kind: 'bad' };
  }
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return { kind: 'bad' };
  return /[*?[{]/u.test(path) ? { kind: 'glob' } : { kind: 'ok', path };
}

function directoriesOf(entry: Map<unknown, unknown>): string[] {
  const single = entry.has('directory');
  const several = entry.has('directories');
  if (single === several) fail('malformed');
  if (single) {
    const value = entry.get('directory');
    if (typeof value !== 'string') fail('malformed');
    return [value];
  }
  const value = entry.get('directories');
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) fail('malformed');
  return value as string[];
}

function settle(collected: Collected): EcosystemRoots {
  const reason: EvidenceReason | null = collected.malformed
    ? 'malformed'
    : collected.unsupported
      ? 'unsupported'
      : collected.roots.size > DEPENDABOT_ROOT_LIMITS.maxRoots
        ? 'budget'
        : null;
  if (reason) return Object.freeze({ kind: 'unavailable', reason });
  return Object.freeze({ kind: 'roots', roots: Object.freeze([...collected.roots].sort()) });
}

function collectEntry(entry: unknown, collected: Record<Ecosystem, Collected>): void {
  if (!(entry instanceof Map)) fail('malformed');
  const ecosystem: unknown = entry.get('package-ecosystem');
  if (typeof ecosystem !== 'string') fail('malformed');
  // Entries for other ecosystems are never interpreted, so their other keys cannot fail the file.
  if (ecosystem !== 'npm' && ecosystem !== 'uv') return;
  const target = collected[ecosystem];
  for (const directory of directoriesOf(entry)) {
    const path = canonicalPath(directory);
    if (path.kind === 'bad') target.malformed = true;
    else if (path.kind === 'glob') target.unsupported = true;
    else target.roots.add(path.path);
  }
}

function extract(document: unknown): DependabotRoots {
  if (!(document instanceof Map) || document.get('version') !== 2) fail('malformed');
  const updates: unknown = document.get('updates');
  if (!Array.isArray(updates)) fail('malformed');
  if (updates.length > DEPENDABOT_ROOT_LIMITS.maxUpdates) fail('budget');
  const collected: Record<Ecosystem, Collected> = {
    npm: { roots: new Set(), malformed: false, unsupported: false },
    uv: { roots: new Set(), malformed: false, unsupported: false },
  };
  for (const entry of updates) collectEntry(entry, collected);
  return Object.freeze({ kind: 'roots', npm: settle(collected.npm), uv: settle(collected.uv) });
}

/** Parses bounded Dependabot configuration bytes into exact npm and uv roots; never echoes input. */
export function parseDependabotRoots(bytes: Uint8Array): DependabotRoots {
  try {
    if (bytes.byteLength > DEPENDABOT_ROOT_LIMITS.maxFileBytes) fail('budget');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const budget = { nodes: 0, aliases: 0, occurrences: 0 };
    const tokens = [];
    let documentTokens = 0;
    for (const token of new Parser().parse(text)) {
      // Only one document is accepted, so stop before inspecting or composing a second.
      if (token.type === 'document' && ++documentTokens > 1) fail('malformed');
      preflight(token, { ...DEPENDABOT_ROOT_LIMITS, maxOccurrences: 0 }, budget);
      tokens.push(token);
    }
    const documents = [
      ...new Composer({
        version: '1.2',
        schema: 'core',
        strict: true,
        stringKeys: true,
        uniqueKeys: true,
        merge: false,
        resolveKnownTags: false,
        prettyErrors: false,
        logLevel: 'silent',
      }).compose(tokens),
    ];
    if (documents.length !== 1) fail('malformed');
    const [document] = documents;
    if (document.errors.length > 0 || document.warnings.length > 0 || !document.contents)
      fail('malformed');
    // Zero alias expansions are allowed, so any alias is a budget breach rather than data to expand.
    visit(document, {
      Alias: () => fail('budget'),
    });
    if (!isMap(document.contents) && !isSeq(document.contents)) fail('malformed');
    return extract(document.toJS({ mapAsMap: true }));
  } catch (error) {
    const reason = error instanceof YamlFailure ? error.reason : 'malformed';
    return Object.freeze({ kind: 'unavailable', reason });
  }
}

/** The snapshot's result: parsed roots attributed to its revision, confirmed absence, or a failure. */
export type DependabotRootsOutcome =
  | Readonly<{ kind: 'roots'; revision: Revision; npm: EcosystemRoots; uv: EcosystemRoots }>
  | Readonly<{ kind: 'absent'; revision: Revision }>
  | Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;
export type CollectorRoots =
  | Readonly<{ kind: 'roots'; roots: readonly string[]; configRevision: Revision }>
  | Readonly<{ kind: 'unavailable'; reason: EvidenceReason }>;

/**
 * What a collector may be given. Absence or an unconfigured ecosystem passes no configured roots,
 * so the collector reports its own ownership gaps; a failure never becomes an empty list.
 */
export function collectorRoots(
  outcome: DependabotRootsOutcome,
  ecosystem: Ecosystem,
): CollectorRoots {
  if (outcome.kind === 'unavailable') return outcome;
  if (outcome.kind === 'absent')
    return { kind: 'roots', roots: [], configRevision: outcome.revision };
  const configured = outcome[ecosystem];
  return configured.kind === 'roots'
    ? { kind: 'roots', roots: configured.roots, configRevision: outcome.revision }
    : configured;
}
