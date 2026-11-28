/**
 * One parse-cost measurement for the parse-cost probe (run.ts starts it with the flags it needs):
 * one counter's reader, run on a crafted input that fills that reader's own byte cap with the
 * densest form of the counted unit, so it holds the most units the reader can be given. The
 * reader's count caps are lifted for the run, so the whole input is counted. It prints the units
 * counted and the slowest and median of RUNS timed runs after one warm-up. Usage:
 * measure.ts <counter>.
 *
 * Counters: `session` (the W2 GitHub read session's JSON entries, src/github-read.ts),
 * `registry` (the npm registry reader's, src/evidence/npm-registry.ts), `npm` (the npm lockfile
 * collector's, src/evidence/npm.ts), `research` (a research reader's copy, the unit
 * limit:research.maxWork charges per entry, src/evidence/upstream-read.ts), `toml` (the uv TOML
 * reader's entries, src/evidence/uv-toml.ts), `workflow-nodes`, `workflow-aliases` and
 * `workflow-occurrences` (the actions reader, src/evidence/actions-yaml.ts), and
 * `dependabot-nodes`, `dependabot-updates` and `dependabot-roots` (the Dependabot roots reader,
 * src/dependabot-roots.ts, whose caps the runner lifts through HEAP_LIMIT_OVERRIDES).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Composer, Parser } from 'yaml';
import type * as Core from './core.js';
import type * as Collection from '../../src/collection.js';
import type * as DependabotRoots from '../../src/dependabot-roots.js';
import type * as GithubRead from '../../src/github-read.js';
import type * as ActionsYaml from '../../src/evidence/actions-yaml.js';
import type * as Npm from '../../src/evidence/npm.js';
import type * as NpmGraph from '../../src/evidence/npm-graph.js';
import type * as Registry from '../../src/evidence/npm-registry.js';
import type * as UpstreamRead from '../../src/evidence/upstream-read.js';
import type * as UvToml from '../../src/evidence/uv-toml.js';
import type * as Format from '../../src/format.js';
import type * as Limits from '../../src/limits.js';
import type * as UvGraph from '../../src/evidence/uv-graph.js';
import type * as Fixtures from '../../tests/parity/evidence-reads.js';
import type * as UvFixtures from '../../tests/parity/uv-graph.js';
import type * as NpmFixtures from '../../tests/parity/npm-inventory.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(ROOT, file)).href)) as T;
const core = await load<typeof Core>('scripts/probe-parse-cost/core.ts');
const { W2_EVIDENCE_LIMITS } = await load<typeof Collection>('src/collection.ts');
const { parseDependabotRoots } = await load<typeof DependabotRoots>('src/dependabot-roots.ts');
const { createGithubReadSession } = await load<typeof GithubRead>('src/github-read.ts');
const { expand, preflight, readWorkflow } = await load<typeof ActionsYaml>('src/evidence/actions-yaml.ts');
const { collectNpmInventory } = await load<typeof Npm>('src/evidence/npm.ts');
const { createNpmRegistryReader } = await load<typeof Registry>('src/evidence/npm-registry.ts');
const { upstreamCopy } = await load<typeof UpstreamRead>('src/evidence/upstream-read.ts');
const { readToml } = await load<typeof UvToml>('src/evidence/uv-toml.ts');
const { BINARY_BYTES, DECIMAL_RADIX, DIGEST_BYTES, GIT_SHA_HEX_LENGTH, HTTP_STATUS } = await load<typeof Format>('src/format.ts');
const { limit } = await load<typeof Limits>('src/limits.ts');
const { binding, npmRequest } = await load<typeof Fixtures>('tests/parity/evidence-reads.ts');
const { npmScenario } = await load<typeof NpmFixtures>('tests/parity/npm-inventory.ts');
const { proveNpmRelationships } = await load<typeof NpmGraph>('src/evidence/npm-graph.ts');
const { reconcileUvGraph } = await load<typeof UvGraph>('src/evidence/uv-graph.ts');
const { uvGraphFixture } = await load<typeof UvFixtures>('tests/parity/uv-graph.ts');

const RUNS = Number(process.env.RUNS ?? '5');
/** A count cap lifted out of the way, so the whole input is counted. */
const LIFTED = Number.MAX_SAFE_INTEGER;
// No read here waits on a clock, so every timeout is the whole job window.
const WINDOW_MS = limit('job.window');
const now = () => 0;
const encode = (text: string) => new TextEncoder().encode(text);

function stubFetch(body: string) {
  const bytes = encode(body);
  return async () =>
    new Response(new Uint8Array(bytes), {
      status: HTTP_STATUS.ok,
      headers: { 'content-type': 'application/json' },
    });
}

/** The slowest JSON shape is the one a review cares about, so each JSON counter runs both. */
function jsonShapes(bytes: number) {
  return (Object.keys(core.JSON_UNITS) as Core.JsonShape[]).map((shape) => {
    const body = core.jsonDocument(shape, bytes);
    return { shape, body, units: core.entryCount(JSON.parse(body)) };
  });
}

type Case = { shape: string; units: number; run: () => unknown };

/** Collection limits that admit the whole input; the byte cap is the register's. */
const UV_COLLECTION = {
  ...W2_EVIDENCE_LIMITS.uv,
  maxTomlEntries: LIFTED,
  maxPackages: LIFTED,
  maxDeclarations: LIFTED,
  maxEdges: LIFTED,
  maxRetainedBytes: LIFTED,
};

/** Whether a graph result is complete: nothing in it ran out of budget. */
const withinBudget = (result: unknown) => !JSON.stringify(result).includes('"budget"');

/**
 * The uv graph stage on a project whose lock fills the uv file cap on both sides, one member
 * changed, then on half that lock, and so on down to the smallest lock: the work grows faster than
 * the package count, so each size is a point. Its units are the least graph work that completes
 * it, found by bisection.
 */
async function uvGraphCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const smallest = BINARY_BYTES.KiB * DECIMAL_RADIX;
  for (const shape of core.GRAPH_SHAPES) {
    for (let bytes = W2_EVIDENCE_LIMITS.uv.maxFileBytes; bytes >= smallest; bytes = Math.floor(bytes / 2)) {
      const base = core.uvProject(shape, bytes, '1');
      const head = core.uvProject(shape, bytes, '2');
      const input = await uvGraphFixture(
        {
          'base:pyproject.toml': base.manifest,
          'head:pyproject.toml': head.manifest,
          'base:uv.lock': base.lock,
          'head:uv.lock': head.lock,
        },
        UV_COLLECTION,
      );
      const run = (maxGraphWork: number) =>
        reconcileUvGraph({ ...input, limits: { maxGraphWork, maxRetainedBytes: LIFTED } });
      const units = await core.smallestPassing((work) => withinBudget(run(work)), LIFTED);
      if (units === null || run(units).kind !== 'inventory') throw new Error(`uv graph ${shape}`);
      cases.push({ shape: `${shape}, ${base.packages} packages`, units, run: () => run(units) });
    }
  }
  return cases;
}

/**
 * The corroboration claim regexes (src/evidence/uv-corroboration.ts) on a description of half
 * the graph work cap in code units, the most the stage reads, since it charges one unit per code
 * unit. The description is lines of one shape at the line cap, then half of it, and so on: if the
 * matching is linear, the time stays flat as the lines shorten, and it does not grow with the line.
 */
async function claimCases(): Promise<Case[]> {
  const input = await uvGraphFixture();
  const cap = limit('uv.maxCorroborationCodeUnits');
  const total = Math.floor(W2_EVIDENCE_LIMITS.graph.maxGraphWork / 2);
  const cases: Case[] = [];
  for (const shape of core.CLAIM_SHAPES) {
    for (let length = cap; length >= cap / DECIMAL_RADIX; length = Math.floor(length / 2)) {
      const line = core.claimLine(shape, length);
      const text = Array.from({ length: Math.floor(total / (length + 1)) }, () => line).join('\n');
      const corroboration = {
        status: 'available',
        repository: input.binding.repository,
        pullNumber: input.binding.pullNumber,
        headSha: input.binding.headSha,
        text,
      };
      const run = () =>
        reconcileUvGraph({
          ...input,
          corroboration,
          limits: { maxGraphWork: LIFTED, maxRetainedBytes: LIFTED },
        });
      if (run().kind !== 'inventory') throw new Error(`claims ${shape}`);
      cases.push({ shape: `${shape}, lines of ${length}`, units: text.length, run });
    }
  }
  return cases;
}

function sessionCases(): Case[] {
  const limits = {
    ...W2_EVIDENCE_LIMITS.session,
    maxJsonEntries: LIFTED,
    totalTimeoutMs: WINDOW_MS,
  };
  return jsonShapes(limits.maxResponseBytes).map(({ shape, body, units }) => ({
    shape,
    units,
    run: () => createGithubReadSession({ binding, limits }, { fetch: stubFetch(body), now }),
  }));
}

function registryCases(): Case[] {
  const limits = {
    ...W2_EVIDENCE_LIMITS.registry,
    maxRequests: 1,
    maxJsonEntries: LIFTED,
    maxRetainedBytes: W2_EVIDENCE_LIMITS.registry.maxTotalBytes,
    requestTimeoutMs: WINDOW_MS,
    totalTimeoutMs: WINDOW_MS,
  };
  return jsonShapes(limits.maxResponseBytes).map(({ shape, body, units }) => ({
    shape,
    units,
    run: () => {
      const opened = createNpmRegistryReader(limits, { fetch: stubFetch(body), now });
      if (opened.kind !== 'ready') throw new Error('registry reader');
      return opened.read(npmRequest);
    },
  }));
}

/** A file session over one npm root whose files are `files(side, path)`, as the collector reads it. */
function npmSession(
  scenario: ReturnType<typeof npmScenario>['binding'],
  files: (side: 'base' | 'head', path: string) => string,
): GithubRead.GithubReadSession {
  return {
    discoverFiles: async () => ({
      kind: 'available',
      binding: scenario,
      complete: true,
      reasons: [],
      files: [{ path: 'package-lock.json', previousPath: null, status: 'modified', blobSha: null }],
    }),
    readFile: async (value) => {
      const { side, path } = value as { side: 'base' | 'head'; path: string };
      return {
        kind: 'available',
        side,
        path,
        repository: scenario.repository,
        commitSha: side === 'base' ? scenario.baseSha : scenario.headSha,
        blobSha: 'e'.repeat(GIT_SHA_HEX_LENGTH),
        bytes: encode(files(side, path)),
      };
    },
    readComparison: async () => ({
      kind: 'available',
      repository: scenario.repository,
      headRepository: scenario.headRepository,
      baseSha: scenario.baseSha,
      headSha: scenario.headSha,
      mergeBaseSha: scenario.mergeBaseSha,
      reasons: [],
      records: [],
    }),
    close: () => {},
  };
}

function npmCases(): Case[] {
  const { binding: scenario, expected } = npmScenario();
  const limits = { ...W2_EVIDENCE_LIMITS.npm, maxJsonEntries: LIFTED, maxRoots: 1 };
  return jsonShapes(limits.maxFileBytes).map(({ shape, body, units }) => ({
    shape,
    units,
    run: () =>
      collectNpmInventory(
        { binding: scenario, roots: ['.'], configRevision: expected.contextRevision, limits },
        {
          session: npmSession(scenario, (_, path) => (path.endsWith('package.json') ? '{}' : body)),
        },
      ),
  }));
}

/** The npm graph stage on a lockfile that fills the npm file cap on both sides, as for uv. */
async function npmGraphCases(): Promise<Case[]> {
  const { binding: scenario, expected } = npmScenario();
  const limits = {
    ...W2_EVIDENCE_LIMITS.npm,
    maxJsonEntries: LIFTED,
    maxRoots: 1,
    maxRetainedBytes: LIFTED,
  };
  const integrity = 'sha512-' + Buffer.alloc(DIGEST_BYTES.sha512, 1).toString('base64');
  const cases: Case[] = [];
  for (const shape of core.GRAPH_SHAPES) {
    const base = core.npmProject(shape, limits.maxFileBytes, '1.0.0', integrity);
    const head = core.npmProject(shape, limits.maxFileBytes, '1.0.1', integrity);
    const inventory = await collectNpmInventory(
      { binding: scenario, roots: ['.'], configRevision: expected.contextRevision, limits },
      {
        session: npmSession(scenario, (side, path) => {
          const project = side === 'base' ? base : head;
          return path.endsWith('package.json') ? project.manifest : project.lock;
        }),
      },
    );
    const run = (maxGraphWork: number) =>
      proveNpmRelationships({
        inventory,
        binding: scenario,
        limits: { maxGraphWork, maxRetainedBytes: LIFTED },
      });
    const units = await core.smallestPassing((work) => withinBudget(run(work)), LIFTED);
    if (units === null || run(units).kind !== 'inventory') throw new Error(`npm graph ${shape}`);
    cases.push({ shape: `${shape}, ${base.packages} packages`, units, run: () => run(units) });
  }
  return cases;
}

function researchCases(): Case[] {
  const limits = {
    maxRequests: 1,
    maxPages: 1,
    maxTagCandidates: limit('research.maxTagCandidates'),
    maxTagDepth: limit('research.maxTagDepth'),
    maxResponseBytes: limit('evidence.envelope.maxResponseBytes'),
    maxTotalBytes: limit('evidence.envelope.maxResponseBytes'),
    maxJsonEntries: LIFTED,
    maxJsonDepth: limit('research.maxJsonDepth'),
    maxWork: LIFTED,
    maxRetainedBytes: limit('research.maxRetainedBytes'),
    maxAttempts: limit('research.maxAttempts'),
    requestTimeoutMs: WINDOW_MS,
    totalTimeoutMs: WINDOW_MS,
  };
  return jsonShapes(limits.maxResponseBytes).map(({ shape, body, units }) => ({
    shape,
    units,
    // The reader parses the body, then copies it, charging one unit of work per entry.
    run: () => upstreamCopy(JSON.parse(body) as unknown, limits),
  }));
}

function tomlCases(): Case[] {
  const limits = { ...W2_EVIDENCE_LIMITS.uv, maxTomlEntries: LIFTED };
  return (Object.keys(core.TOML_UNITS) as Core.TomlShape[]).map((shape) => {
    const bytes = encode(core.tomlDocument(shape, limits.maxFileBytes));
    const budget = { entries: 0, packages: 0, declarations: 0, edges: 0 };
    if (readToml(bytes, limits, budget).kind !== 'parsed') throw new Error(`toml ${shape}`);
    return { shape, units: budget.entries, run: () => readToml(bytes, limits) };
  });
}

function workflowCase(shape: Core.WorkflowShape): Case[] {
  const limits = {
    ...W2_EVIDENCE_LIMITS.actions,
    maxYamlNodes: LIFTED,
    maxAliasExpansions: LIFTED,
    maxOccurrences: LIFTED,
  };
  const bytes = encode(core.workflowDocument(shape, limits.maxFileBytes));
  const budget = { nodes: 0, aliases: 0, occurrences: 0 };
  if (readWorkflow(bytes, limits, budget).kind !== 'parsed') throw new Error(`workflow ${shape}`);
  return [{ shape, units: budget[shape], run: () => readWorkflow(bytes, limits) }];
}

/** The nodes the preflight charges for a document, the count the node cap bounds first. */
function preflightNodes(text: string): number {
  const budget = { nodes: 0, aliases: 0, occurrences: 0 };
  const limits = {
    maxFileBytes: LIFTED,
    maxYamlNodes: LIFTED,
    maxYamlDepth: LIFTED,
    maxAliasExpansions: LIFTED,
    maxOccurrences: LIFTED,
  };
  for (const token of new Parser().parse(text)) preflight(token, limits, budget);
  return budget.nodes;
}

function dependabotCase(shape: Core.DependabotShape): Case[] {
  // The Dependabot byte cap is lifted with the count caps; the workflow cap sizes the input.
  const text = core.dependabotDocument(shape, limit('w2.actions.maxFileBytes'));
  const bytes = encode(text);
  const parsed = parseDependabotRoots(bytes);
  if (parsed.kind !== 'roots' || parsed.npm.kind !== 'roots') throw new Error(`dependabot ${shape}`);
  const units = {
    nodes: () => preflightNodes(text),
    updates: () => text.split('package-ecosystem').length - 1,
    roots: () => (parsed.npm.kind === 'roots' ? parsed.npm.roots.length : 0),
  }[shape]();
  return [{ shape, units, run: () => parseDependabotRoots(bytes) }];
}

const counters: Record<string, () => Case[] | Promise<Case[]>> = {
  'graph-uv': uvGraphCases,
  'graph-npm': npmGraphCases,
  claims: claimCases,
  session: sessionCases,
  registry: registryCases,
  npm: npmCases,
  research: researchCases,
  toml: tomlCases,
  'workflow-nodes': () => workflowCase('nodes'),
  'workflow-aliases': () => workflowCase('aliases'),
  'workflow-occurrences': () => workflowCase('occurrences'),
  'dependabot-nodes': () => dependabotCase('nodes'),
  'dependabot-updates': () => dependabotCase('updates'),
  'dependabot-roots': () => dependabotCase('roots'),
};

/** The readers' composer options (src/dependabot-roots.ts, src/evidence/actions-yaml.ts). */
const COMPOSER_OPTIONS = {
  version: '1.2',
  schema: 'core',
  strict: true,
  stringKeys: true,
  uniqueKeys: true,
  merge: false,
  resolveKnownTags: false,
  prettyErrors: false,
  logLevel: 'silent',
} as const;

const LIFTED_YAML = {
  maxFileBytes: LIFTED,
  maxYamlNodes: LIFTED,
  maxYamlDepth: LIFTED,
  maxAliasExpansions: LIFTED,
  maxOccurrences: LIFTED,
};

/** The preflight and composed node counts of a Dependabot config, as its reader charges them. */
function dependabotNodes(text: string): { preflight: number; composed: number } {
  const budget = { nodes: 0, aliases: 0, occurrences: 0 };
  const tokens = [...new Parser().parse(text)];
  for (const token of tokens) preflight(token, LIFTED_YAML, budget);
  const [document] = [...new Composer(COMPOSER_OPTIONS).compose(tokens)];
  const composed = { nodes: 0, aliases: 0, occurrences: 0 };
  try {
    if (document?.contents) expand(document.contents, LIFTED_YAML, composed, { lenientKeys: true });
  } catch {
    // A config the reader refuses still counts the nodes composed before the refusal.
  }
  return { preflight: budget.nodes, composed: composed.nodes };
}

/** The counts the readers charge for one legitimate file, by the corpus group it sits in. */
const groups: Record<string, (bytes: Buffer) => Record<string, number>> = {
  workflows: (bytes) => {
    const budget = { nodes: 0, aliases: 0, occurrences: 0 };
    readWorkflow(bytes, LIFTED_YAML, budget);
    return { bytes: bytes.length, ...budget };
  },
  dependabot: (bytes) => {
    const parsed = parseDependabotRoots(bytes);
    const roots = (ecosystem: 'npm' | 'uv') =>
      parsed.kind === 'roots' && parsed[ecosystem].kind === 'roots'
        ? parsed[ecosystem].roots.length
        : 0;
    const text = bytes.toString('utf8');
    return {
      bytes: bytes.length,
      ...dependabotNodes(text),
      updates: text.match(/^\s*-\s*package-ecosystem\s*:/gmu)?.length ?? 0,
      npmRoots: roots('npm'),
      uvRoots: roots('uv'),
    };
  },
  'uv-lock': (bytes) => {
    const budget = { entries: 0, packages: 0, declarations: 0, edges: 0 };
    const read = readToml(bytes, UV_COLLECTION_UNBOUNDED, budget);
    const packages = read.kind === 'parsed' ? read.value.package : undefined;
    return {
      bytes: bytes.length,
      entries: budget.entries,
      packages: Array.isArray(packages) ? packages.length : 0,
    };
  },
  // A PEP 691 JSON simple index: the longest project name, which a claim line can carry.
  'pypi-index': (bytes) => {
    const index = JSON.parse(bytes.toString('utf8')) as { projects?: { name?: unknown }[] };
    return {
      projects: index.projects?.length ?? 0,
      nameCodeUnits: (index.projects ?? []).reduce(
        (longest, { name }) => Math.max(longest, String(name).length),
        0,
      ),
    };
  },
  // PyPI project or release documents: the longest version, which a claim line carries twice.
  pypi: (bytes) => {
    const document = JSON.parse(bytes.toString('utf8')) as {
      info?: { version?: unknown };
      releases?: Record<string, unknown>;
    };
    const versions = [...Object.keys(document.releases ?? {}), String(document.info?.version ?? '')];
    return {
      versionCodeUnits: versions.reduce((longest, version) => Math.max(longest, version.length), 0),
    };
  },
  json: (bytes) => ({
    bytes: bytes.length,
    entries: core.entryCount(JSON.parse(bytes.toString('utf8')) as unknown),
  }),
};

/** uv parse limits that admit a lock of any size, so a legitimate lock is counted whole. */
const UV_COLLECTION_UNBOUNDED = {
  ...UV_COLLECTION,
  maxFileBytes: LIFTED,
  maxStringBytes: LIFTED,
};

/**
 * Per top-level subdirectory of a corpus of legitimate files the caller downloaded: the file
 * count and the largest and total value of each count, aggregates only. A subdirectory is read by the group
 * its name starts with (`workflows`, `dependabot`, `uv-lock`, `pypi-index`, `pypi`, or `json` for
 * the entries of any JSON documents).
 */
function useOf(corpus: string) {
  const counts = new Map<string, Record<string, number>[]>();
  for (const entry of readdirSync(corpus, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = relative(corpus, join(entry.parentPath, entry.name));
    const group = path.split(sep)[0] as string;
    const read = Object.entries(groups).find(([name]) => group.startsWith(name))?.[1];
    if (!read || !path.includes(sep)) continue;
    counts.set(group, [...(counts.get(group) ?? []), read(readFileSync(join(corpus, path)))]);
  }
  for (const [group, rows] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const largest = Object.fromEntries(
      Object.keys(rows[0] ?? {}).map((key) => [key, core.summarizeCounts(rows.map((row) => row[key] ?? 0)).largest]),
    );
    const total = Object.fromEntries(
      Object.keys(rows[0] ?? {}).map((key) => [key, rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)]),
    );
    console.log(JSON.stringify({ group, documents: rows.length, largest, total }));
  }
}

const [counter, corpus] = process.argv.slice(2);
if (counter === 'use') {
  if (corpus === undefined) throw new Error('usage: measure.ts use <corpus directory>');
  useOf(corpus);
  process.exit(0);
}
const cases = counter === undefined ? undefined : counters[counter];
if (!cases) throw new Error(`counter must be one of ${Object.keys(counters).join(', ')}`);
for (const { shape, units, run } of await cases()) {
  // Warm-up: the same run once, so compiled code and module state are in the baseline.
  await run();
  const timings: number[] = [];
  for (let index = 0; index < RUNS; index++) {
    const start = performance.now();
    await run();
    timings.push(performance.now() - start);
  }
  console.log(
    JSON.stringify({ node: process.version, counter, shape, units, ...core.timingSummary(timings) }),
  );
}
