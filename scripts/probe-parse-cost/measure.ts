/**
 * One parse-cost measurement for the parse-cost probe (run.ts starts it with the flags it needs):
 * one counter's reader, run on crafted inputs that fill a byte size with the densest form of the
 * counted unit, at doubling sizes around the reader's own byte cap: two halvings below it and two
 * doublings above it (four for the Dependabot reader, whose cap is small), set by DOUBLINGS_BELOW,
 * DOUBLINGS_ABOVE and DEPENDABOT_DOUBLINGS_ABOVE. The reader's count and byte caps are lifted for
 * the run, so the whole input is counted, and each run checks the reader walked it all. Per size it
 * prints the units counted and the slowest and median of RUNS timed runs after one warm-up; per
 * shape, the ratios of successive timings, which stay near 2 when the cost is linear. Usage:
 * measure.ts <counter>, measure.ts use <corpus directory>, or measure.ts heap (the Dependabot
 * reader's heap at its own caps; see run.ts).
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
const { expand, preflight, readWorkflow } = await load<typeof ActionsYaml>(
  'src/evidence/actions-yaml.ts',
);
const { collectNpmInventory } = await load<typeof Npm>('src/evidence/npm.ts');
const { createNpmRegistryReader } = await load<typeof Registry>('src/evidence/npm-registry.ts');
const { upstreamCopy } = await load<typeof UpstreamRead>('src/evidence/upstream-read.ts');
const { readToml } = await load<typeof UvToml>('src/evidence/uv-toml.ts');
const { BINARY_BYTES, DECIMAL_RADIX, DIGEST_BYTES, GIT_SHA_HEX_LENGTH, HTTP_STATUS } =
  await load<typeof Format>('src/format.ts');
const { limit } = await load<typeof Limits>('src/limits.ts');
const { binding, npmRequest } = await load<typeof Fixtures>('tests/parity/evidence-reads.ts');
const { npmScenario } = await load<typeof NpmFixtures>('tests/parity/npm-inventory.ts');
const { proveNpmRelationships } = await load<typeof NpmGraph>('src/evidence/npm-graph.ts');
const { reconcileUvGraph } = await load<typeof UvGraph>('src/evidence/uv-graph.ts');
const { uvGraphFixture } = await load<typeof UvFixtures>('tests/parity/uv-graph.ts');

const RUNS = Number(process.env.RUNS ?? '5');
/** Doublings measured below and above each reader's byte cap (see core.doublingSizes). */
const BELOW = Number(process.env.DOUBLINGS_BELOW ?? '2');
const ABOVE = Number(process.env.DOUBLINGS_ABOVE ?? '2');
/** The Dependabot cap is small, so its series runs further above it, nearer its harm point. */
const DEPENDABOT_ABOVE = Number(process.env.DEPENDABOT_DOUBLINGS_ABOVE ?? '4');
/**
 * The register's Dependabot byte cap, which run.ts passes in because HEAP_LIMIT_OVERRIDES lifts the
 * register value this process reads.
 */
const DEPENDABOT_CAP = Number(process.env.DEPENDABOT_MAX_FILE_BYTES);
if (!Number.isSafeInteger(DEPENDABOT_CAP) || DEPENDABOT_CAP <= 0) {
  throw new Error('run through npm run probe:parse-cost, which passes DEPENDABOT_MAX_FILE_BYTES');
}
/** A count cap lifted out of the way, so the whole input is counted. */
const LIFTED = Number.MAX_SAFE_INTEGER;
// No read here waits on a clock, so every timeout is the whole job window.
const WINDOW_MS = limit('job.window');
const now = () => 0;
const encode = (text: string) => new TextEncoder().encode(text);
const gc = globalThis.gc;
if (!gc) throw new Error('run with --expose-gc (npm run probe:parse-cost does)');
/** The narrowed collector, for functions that run after the check above. */
const collect: () => void = gc;

function stubFetch(body: string) {
  const bytes = encode(body);
  return async () =>
    new Response(new Uint8Array(bytes), {
      status: HTTP_STATUS.ok,
      headers: { 'content-type': 'application/json' },
    });
}

/** One measured size: its input bytes, the units the reader counts in it, and the timed run. */
type Point = { bytes: number; units: number; run: () => unknown };
/** One shape measured at doubling sizes. */
type Series = { shape: string; points: Point[] };

const sizes = (cap: number, above = ABOVE) => core.doublingSizes(cap, BELOW, above);

/** Fails the probe when a reader did not walk the whole input: the run would time less work. */
function expectWalked(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${what}: the reader did not count the whole input`);
}

/** JSON series, one per shape, each at the doubling sizes of `cap`. */
async function jsonSeries(
  cap: number,
  point: (shape: Core.JsonShape, body: string, bytes: number) => Promise<Point>,
): Promise<Series[]> {
  const series: Series[] = [];
  for (const shape of Object.keys(core.JSON_UNITS) as Core.JsonShape[]) {
    const points: Point[] = [];
    for (const bytes of sizes(cap))
      points.push(await point(shape, core.jsonDocument(shape, bytes), bytes));
    series.push({ shape, points });
  }
  return series;
}

/** A read must end in the full-walk outcome: the shaped body is walked, then refused as malformed. */
const malformed = (result: unknown) =>
  (result as { kind?: unknown; reason?: unknown }).kind === 'unavailable' &&
  (result as { reason?: unknown }).reason === 'malformed';

function sessionSeries(): Promise<Series[]> {
  return jsonSeries(W2_EVIDENCE_LIMITS.session.maxResponseBytes, async (shape, body, bytes) => {
    const limits = {
      ...W2_EVIDENCE_LIMITS.session,
      maxJsonEntries: LIFTED,
      maxResponseBytes: bytes,
      maxTotalBytes: LIFTED,
      totalTimeoutMs: WINDOW_MS,
    };
    const run = () => createGithubReadSession({ binding, limits }, { fetch: stubFetch(body), now });
    expectWalked(malformed(await run()), `session ${shape}`);
    // The session's count is private; the walk counts every property and element, as entryCount.
    return { bytes, units: core.entryCount(JSON.parse(body)), run };
  });
}

function registrySeries(): Promise<Series[]> {
  return jsonSeries(W2_EVIDENCE_LIMITS.registry.maxResponseBytes, async (shape, body, bytes) => {
    const limits = {
      ...W2_EVIDENCE_LIMITS.registry,
      maxRequests: 1,
      maxJsonEntries: LIFTED,
      maxResponseBytes: bytes,
      maxTotalBytes: bytes,
      maxRetainedBytes: bytes,
      requestTimeoutMs: WINDOW_MS,
      totalTimeoutMs: WINDOW_MS,
    };
    const read = async () => {
      const opened = createNpmRegistryReader(limits, { fetch: stubFetch(body), now });
      if (opened.kind !== 'ready') throw new Error('registry reader');
      return { result: await opened.read(npmRequest), stopLimit: opened.stopLimit() };
    };
    const { result, stopLimit } = await read();
    expectWalked(malformed(result) && stopLimit === null, `registry ${shape}`);
    return { bytes, units: core.entryCount(JSON.parse(body)), run: read };
  });
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

function npmSeries(): Promise<Series[]> {
  const { binding: scenario, expected } = npmScenario();
  return jsonSeries(W2_EVIDENCE_LIMITS.npm.maxFileBytes, async (shape, body, bytes) => {
    const limits = {
      ...W2_EVIDENCE_LIMITS.npm,
      maxFileBytes: bytes,
      maxJsonEntries: LIFTED,
      maxRoots: 1,
    };
    const run = () =>
      collectNpmInventory(
        { binding: scenario, roots: ['.'], configRevision: expected.contextRevision, limits },
        {
          session: npmSession(scenario, (_, path) => (path.endsWith('package.json') ? '{}' : body)),
        },
      );
    // Both sides' lockfiles are counted whole, then each is a malformed gap, never a budget one.
    const result = (await run()) as { kind?: unknown; gaps?: { path: string; reason: string }[] };
    const locks = (result.gaps ?? []).filter((gap) => gap.path === 'package-lock.json');
    expectWalked(
      result.kind === 'inventory' &&
        locks.length > 0 &&
        locks.every((gap) => gap.reason === 'malformed'),
      `npm ${shape}`,
    );
    return { bytes, units: locks.length * core.entryCount(JSON.parse(body)), run };
  });
}

function researchSeries(): Promise<Series[]> {
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
  return jsonSeries(limits.maxResponseBytes, async (_, body, bytes) => {
    // The reader parses the body, then copies it, charging one unit of work per entry it counts.
    const run = () => {
      const work = { entries: 0 };
      upstreamCopy(JSON.parse(body) as unknown, limits, work);
      return work.entries;
    };
    return { bytes, units: run(), run };
  });
}

function tomlSeries(): Series[] {
  return (Object.keys(core.TOML_UNITS) as Core.TomlShape[]).map((shape) => ({
    shape,
    points: sizes(W2_EVIDENCE_LIMITS.uv.maxFileBytes).map((size) => {
      const limits = { ...W2_EVIDENCE_LIMITS.uv, maxFileBytes: size, maxTomlEntries: LIFTED };
      const bytes = encode(core.tomlDocument(shape, size));
      const budget = { entries: 0, packages: 0, declarations: 0, edges: 0 };
      expectWalked(readToml(bytes, limits, budget).kind === 'parsed', `toml ${shape}`);
      return { bytes: size, units: budget.entries, run: () => readToml(bytes, limits) };
    }),
  }));
}

function workflowSeries(shape: Core.WorkflowShape): Series[] {
  return [
    {
      shape,
      points: sizes(W2_EVIDENCE_LIMITS.actions.maxFileBytes).map((size) => {
        const limits = {
          ...W2_EVIDENCE_LIMITS.actions,
          maxFileBytes: size,
          maxYamlNodes: LIFTED,
          maxAliasExpansions: LIFTED,
          maxOccurrences: LIFTED,
        };
        const bytes = encode(core.workflowDocument(shape, size));
        const budget = { nodes: 0, aliases: 0, occurrences: 0 };
        expectWalked(readWorkflow(bytes, limits, budget).kind === 'parsed', `workflow ${shape}`);
        return { bytes: size, units: budget[shape], run: () => readWorkflow(bytes, limits) };
      }),
    },
  ];
}

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

/**
 * What the Dependabot roots reader counts in a config, through its own preflight and expansion
 * (src/evidence/actions-yaml.ts) on the same tokens and composer options: the preflight nodes,
 * the composed nodes and the length of the composed `updates` list, the list it caps. `refused` is
 * set when the composition or expansion fails, so a count of 0 is never silent.
 */
function dependabotCounts(text: string) {
  const budget = { nodes: 0, aliases: 0, occurrences: 0 };
  const tokens = [...new Parser().parse(text)];
  for (const token of tokens) preflight(token, LIFTED_YAML, budget);
  const composed = { nodes: 0, aliases: 0, occurrences: 0 };
  const [document] = [...new Composer(COMPOSER_OPTIONS).compose(tokens)];
  let updates = 0;
  let refused: string | null = null;
  try {
    if (!document?.contents || document.errors.length > 0) throw new Error('malformed');
    const value = expand(document.contents, LIFTED_YAML, composed, { lenientKeys: true });
    const list = value instanceof Map ? value.get('updates') : undefined;
    if (!Array.isArray(list)) throw new Error('malformed');
    updates = list.length;
  } catch (error) {
    refused = error instanceof Error ? error.message : 'malformed';
  }
  return { preflight: budget.nodes, composed: composed.nodes, updates, refused };
}

function dependabotSeries(shape: Core.DependabotShape): Series[] {
  return [
    {
      shape,
      // The reader's own byte cap, and doublings above it (run.ts lifts it for the larger sizes).
      points: sizes(DEPENDABOT_CAP, DEPENDABOT_ABOVE).map((size) => {
        const text = core.dependabotDocument(shape, size);
        const bytes = encode(text);
        const parsed = parseDependabotRoots(bytes);
        const counts = dependabotCounts(text);
        expectWalked(
          parsed.kind === 'roots' && parsed.npm.kind === 'roots' && counts.refused === null,
          `dependabot ${shape}`,
        );
        const units = {
          nodes: counts.preflight,
          updates: counts.updates,
          roots:
            parsed.kind === 'roots' && parsed.npm.kind === 'roots' ? parsed.npm.roots.length : 0,
        }[shape];
        return { bytes: size, units, run: () => parseDependabotRoots(bytes) };
      }),
    },
  ];
}

/** Collection limits that admit the whole input; the byte cap is the register's. */
const UV_COLLECTION = {
  ...W2_EVIDENCE_LIMITS.uv,
  maxTomlEntries: LIFTED,
  maxPackages: LIFTED,
  maxDeclarations: LIFTED,
  maxEdges: LIFTED,
  maxRetainedBytes: LIFTED,
};

/** The least graph work at which `run` completes without reporting `budget`, by bisection. */
async function leastWork(run: (work: number) => unknown, what: string): Promise<number> {
  const units = await core.smallestPassing((work) => !core.reportsBudget(run(work)), LIFTED);
  if (units === null) throw new Error(`${what}: never completes`);
  return units;
}

/**
 * The uv graph stage on a project whose lock fills the uv file cap on both sides, one member
 * changed, then on half that lock, and so on down to 10 KiB. Its units are the least graph work
 * that completes it, found by bisection; the work grows faster than the package count.
 */
async function uvGraphSeries(): Promise<Series[]> {
  const series: Series[] = [];
  const smallest = BINARY_BYTES.KiB * DECIMAL_RADIX;
  for (const shape of core.GRAPH_SHAPES) {
    const points: Point[] = [];
    for (
      let size = W2_EVIDENCE_LIMITS.uv.maxFileBytes;
      size >= smallest;
      size = Math.floor(size / 2)
    ) {
      const base = core.uvProject(shape, size, '1');
      const head = core.uvProject(shape, size, '2');
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
      const units = await leastWork(run, `uv graph ${shape}`);
      points.unshift({ bytes: size, units, run: () => run(units) });
      console.error(`graph-uv ${shape}: ${base.packages} packages need ${units} units`);
    }
    series.push({ shape, points });
  }
  return series;
}

/** The npm graph stage on lockfiles at the doubling sizes of the npm file cap, as for uv. */
async function npmGraphSeries(): Promise<Series[]> {
  const { binding: scenario, expected } = npmScenario();
  const integrity = 'sha512-' + Buffer.alloc(DIGEST_BYTES.sha512, 1).toString('base64');
  const series: Series[] = [];
  for (const shape of core.GRAPH_SHAPES) {
    const points: Point[] = [];
    for (const size of sizes(W2_EVIDENCE_LIMITS.npm.maxFileBytes)) {
      const limits = {
        ...W2_EVIDENCE_LIMITS.npm,
        maxFileBytes: size,
        maxJsonEntries: LIFTED,
        maxRoots: 1,
        maxRetainedBytes: LIFTED,
      };
      const base = core.npmProject(shape, size, '1.0.0', integrity);
      const head = core.npmProject(shape, size, '1.0.1', integrity);
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
      const units = await leastWork(run, `npm graph ${shape}`);
      points.push({ bytes: size, units, run: () => run(units) });
      console.error(`graph-npm ${shape}: ${base.packages} packages need ${units} units`);
    }
    series.push({ shape, points });
  }
  return series;
}

/**
 * The corroboration claim regexes (src/evidence/uv-corroboration.ts) on descriptions of lines of
 * one shape. Two kinds of series: at a fixed description of half the graph work cap in code units
 * (the stage charges one unit per code unit), lines from a tenth of the line cap up to the cap,
 * which shows how a line's cost grows with its length; and at a fixed line length (the cap, and a
 * quarter of it), descriptions at doubling sizes around that half, which shows how the cost grows
 * with the text. The cost is linear in the text when the second kind doubles with each size.
 */
async function claimSeries(): Promise<Series[]> {
  const input = await uvGraphFixture();
  const cap = limit('uv.maxCorroborationCodeUnits');
  const half = Math.floor(W2_EVIDENCE_LIMITS.graph.maxGraphWork / 2);
  const point = (shape: Core.ClaimShape, length: number, total: number): Point => {
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
    return { bytes: text.length, units: text.length, run };
  };
  const series: Series[] = [];
  for (const shape of core.CLAIM_SHAPES) {
    const lengths: number[] = [];
    for (let length = cap; length >= cap / DECIMAL_RADIX; length = Math.floor(length / 2))
      lengths.unshift(length);
    series.push({
      shape: `${shape}, ${half} code units, lines doubling`,
      points: lengths.map((length) => point(shape, length, half)),
    });
    for (const length of [cap / 2 / 2, cap])
      series.push({
        shape: `${shape}, lines of ${length}, text doubling`,
        points: sizes(half).map((total) => point(shape, length, total)),
      });
  }
  return series;
}

const counters: Record<Core.Counter, () => Series[] | Promise<Series[]>> = {
  session: sessionSeries,
  registry: registrySeries,
  npm: npmSeries,
  research: researchSeries,
  toml: tomlSeries,
  'workflow-nodes': () => workflowSeries('nodes'),
  'workflow-aliases': () => workflowSeries('aliases'),
  'workflow-occurrences': () => workflowSeries('occurrences'),
  'dependabot-nodes': () => dependabotSeries('nodes'),
  'dependabot-updates': () => dependabotSeries('updates'),
  'dependabot-roots': () => dependabotSeries('roots'),
  'graph-npm': npmGraphSeries,
  'graph-uv': uvGraphSeries,
  claims: claimSeries,
};

/** uv parse limits that admit a lock of any size, so a legitimate lock is counted whole. */
const UV_COLLECTION_UNBOUNDED = { ...UV_COLLECTION, maxFileBytes: LIFTED, maxStringBytes: LIFTED };

/** One file's counts, and the reason the reader refused it, if it did. */
type Reading = { counts: Record<string, number>; refused: string | null };

const parsedJson = (bytes: Buffer): unknown => JSON.parse(bytes.toString('utf8'));

/** The counts the readers charge for one legitimate file, by the reader its corpus group names. */
const readers: Record<string, (bytes: Buffer) => Reading> = {
  workflows: (bytes) => {
    const budget = { nodes: 0, aliases: 0, occurrences: 0 };
    const read = readWorkflow(bytes, LIFTED_YAML, budget);
    return {
      counts: { bytes: bytes.length, ...budget },
      refused: read.kind === 'unavailable' ? read.reason : null,
    };
  },
  dependabot: (bytes) => {
    const parsed = parseDependabotRoots(bytes);
    const roots = (ecosystem: 'npm' | 'uv') =>
      parsed.kind === 'roots' && parsed[ecosystem].kind === 'roots'
        ? parsed[ecosystem].roots.length
        : 0;
    const { refused, ...counts } = dependabotCounts(bytes.toString('utf8'));
    const ecosystems = (['npm', 'uv'] as const).filter(
      (ecosystem) => parsed.kind === 'roots' && parsed[ecosystem].kind === 'unavailable',
    );
    return {
      counts: { bytes: bytes.length, ...counts, npmRoots: roots('npm'), uvRoots: roots('uv') },
      refused:
        parsed.kind === 'unavailable'
          ? parsed.reason
          : (refused ?? (ecosystems.length > 0 ? `${ecosystems.join(' and ')} roots` : null)),
    };
  },
  'uv-lock': (bytes) => {
    const budget = { entries: 0, packages: 0, declarations: 0, edges: 0 };
    const read = readToml(bytes, UV_COLLECTION_UNBOUNDED, budget);
    const packages = read.kind === 'parsed' ? read.value.package : undefined;
    return {
      counts: {
        bytes: bytes.length,
        entries: budget.entries,
        packages: Array.isArray(packages) ? packages.length : 0,
      },
      refused: read.kind === 'unavailable' ? read.reason : null,
    };
  },
  // A PEP 691 JSON simple index: the longest project name, which a claim line can carry.
  'pypi-index': (bytes) => {
    const index = parsedJson(bytes) as { projects?: { name?: unknown }[] };
    const projects = index.projects ?? [];
    return {
      counts: {
        projects: projects.length,
        nameCodeUnits: projects.reduce(
          (longest, { name }) => Math.max(longest, String(name).length),
          0,
        ),
      },
      refused: projects.length === 0 ? 'no projects' : null,
    };
  },
  // PyPI project or release documents: the longest version, which a claim line carries twice.
  pypi: (bytes) => {
    const document = parsedJson(bytes) as {
      info?: { version?: unknown };
      releases?: Record<string, unknown>;
    };
    const versions = [
      ...Object.keys(document.releases ?? {}),
      String(document.info?.version ?? ''),
    ];
    return {
      counts: {
        versionCodeUnits: versions.reduce(
          (longest, version) => Math.max(longest, version.length),
          0,
        ),
      },
      refused: document.info === undefined ? 'no info' : null,
    };
  },
  json: (bytes) => ({
    counts: { bytes: bytes.length, entries: core.entryCount(parsedJson(bytes)) },
    refused: null,
  }),
};

/**
 * Per top-level subdirectory of a corpus of legitimate files the caller downloaded, numbered in
 * name order and never named: the reader it is read by (the first of `workflows`, `dependabot`,
 * `uv-lock`, `pypi-index`, `pypi` and `json` that its name starts with), the file count, the
 * largest and total value of each count, and the files the reader refused, by reason. A file that
 * is not valid JSON prints only its number, counted over the sorted file list.
 */
function useOf(corpus: string) {
  const files = readdirSync(corpus, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(corpus, join(entry.parentPath, entry.name)))
    .filter((path) => path.includes(sep))
    .sort();
  const names = [...new Set(files.map((path) => path.split(sep)[0] as string))];
  const groups = new Map<
    string,
    { reader: string; rows: Record<string, number>[]; refused: Record<string, number> }
  >();
  for (const [index, path] of files.entries()) {
    const name = path.split(sep)[0] as string;
    const reader = Object.keys(readers).find((key) => name.startsWith(key));
    if (reader === undefined) continue;
    const group = groups.get(name) ?? { reader, rows: [], refused: {} };
    groups.set(name, group);
    let reading: Reading;
    try {
      reading = (readers[reader] as (bytes: Buffer) => Reading)(readFileSync(join(corpus, path)));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.log(`parse error in file ${index + 1}`);
      group.refused.parse = (group.refused.parse ?? 0) + 1;
      continue;
    }
    group.rows.push(reading.counts);
    if (reading.refused !== null)
      group.refused[reading.refused] = (group.refused[reading.refused] ?? 0) + 1;
  }
  for (const [name, { reader, rows, refused }] of groups) {
    const keys = Object.keys(rows[0] ?? {});
    const largest = Object.fromEntries(
      keys.map((key) => [key, core.summarizeCounts(rows.map((row) => row[key] ?? 0)).largest]),
    );
    const total = Object.fromEntries(
      keys.map((key) => [key, rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)]),
    );
    const group = names.indexOf(name) + 1;
    console.log(JSON.stringify({ group, reader, documents: rows.length, largest, total, refused }));
  }
}

/**
 * The Dependabot reader's heap at its register caps, per crafted shape at its byte cap: what one
 * parse allocates, what stays held after a full collection while the result is kept, and the
 * slowest and median of RUNS parses.
 */
function heapOf(): void {
  const used = () => process.memoryUsage().heapUsed;
  for (const shape of core.DEPENDABOT_SHAPES) {
    const bytes = encode(core.dependabotDocument(shape, DEPENDABOT_CAP));
    parseDependabotRoots(bytes);
    collect();
    collect();
    const before = used();
    const result = parseDependabotRoots(bytes);
    const allocatedBytes = used() - before;
    collect();
    collect();
    const retainedBytes = used() - before;
    const timings = Array.from({ length: RUNS }, () => {
      const start = performance.now();
      parseDependabotRoots(bytes);
      return performance.now() - start;
    });
    console.log(
      JSON.stringify({
        node: process.version,
        reader: 'dependabot',
        shape,
        bytes: bytes.byteLength,
        outcome: result.kind,
        allocatedBytes,
        retainedBytes,
        resultBytes: Buffer.byteLength(JSON.stringify(result)),
        ...core.timingSummary(timings),
      }),
    );
  }
}

/** The densest forms of a JSON event: the elements a parse makes the most heap for per byte. */
const EVENT_SHAPES = {
  numbers: '0',
  objects: '{}',
  arrays: '[]',
  strings: '""',
  keyed: '{"a":0}',
} as const;

/**
 * One webhook-shaped event of exactly `bytes` bytes, `{"action":"completed","padding":[...]}`,
 * its padding the densest form of `shape`, filled to the byte with trailing spaces.
 */
function eventDocument(shape: keyof typeof EVENT_SHAPES, bytes: number): string {
  const head = '{"action":"completed","padding":[';
  const tail = ']}';
  const element = EVENT_SHAPES[shape];
  const count = Math.floor((bytes - head.length - tail.length + 1) / (element.length + 1));
  const body = Array.from({ length: count }, () => element).join(',');
  const text = head + body + tail;
  return text + ' '.repeat(bytes - text.length);
}

/**
 * The event parse at limit:startup.maxEventBytes (L11, item 11 review follow-up), for one dense shape:
 * the heap the decoded text takes and what JSON.parse allocates on top of it (an upper bound on
 * its peak, with the young generation sized so no collection runs during it), what stays held
 * after a full collection with the result kept, and the slowest and median of RUNS parses.
 */
function eventHeapOf(shape: keyof typeof EVENT_SHAPES): void {
  const cap = limit('startup.maxEventBytes');
  const used = () => process.memoryUsage().heapUsed;
  const external = () => process.memoryUsage().external;
  {
    // The file's bytes, off the V8 heap as readBoundedEvent's buffer is, then its decoded text.
    const bytes = encode(eventDocument(shape, cap));
    collect();
    collect();
    const empty = used(),
      emptyExternal = external();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // An ASCII text may be held outside the V8 heap, as an external string.
    const textBytes = used() - empty;
    const textExternalBytes = external() - emptyExternal;
    collect();
    collect();
    const before = used();
    const result: unknown = JSON.parse(text);
    const allocatedBytes = used() - before;
    collect();
    collect();
    const retainedBytes = used() - before;
    const elements = (result as { padding: unknown[] }).padding.length;
    const timings = Array.from({ length: RUNS }, () => {
      const start = performance.now();
      JSON.parse(text);
      return performance.now() - start;
    });
    console.log(
      JSON.stringify({
        node: process.version,
        reader: 'event',
        shape,
        bytes: bytes.byteLength,
        textBytes,
        textExternalBytes,
        allocatedBytes,
        peakBytes: textBytes + allocatedBytes,
        retainedBytes,
        elements,
        ...core.timingSummary(timings),
      }),
    );
  }
}

const [counter, corpus] = process.argv.slice(2);
if (counter === 'event') {
  if (!corpus || !(corpus in EVENT_SHAPES))
    throw new Error(`usage: measure.ts event <${Object.keys(EVENT_SHAPES).join('|')}>`);
  eventHeapOf(corpus as keyof typeof EVENT_SHAPES);
  process.exit(0);
}
if (counter === 'heap') {
  heapOf();
  process.exit(0);
}
if (counter === 'use') {
  if (corpus === undefined) throw new Error('usage: measure.ts use <corpus directory>');
  useOf(corpus);
  process.exit(0);
}
const series = counter === undefined ? undefined : counters[counter as Core.Counter];
if (!series) throw new Error(`counter must be one of ${core.COUNTERS.join(', ')}`);
for (const { shape, points } of await series()) {
  const slowest: number[] = [];
  const medians: number[] = [];
  for (const { bytes, units, run } of points) {
    // Each size starts from a collected heap, so one size's garbage is not timed in the next.
    gc();
    // Warm-up: the same run once, so compiled code and module state are in the baseline.
    await run();
    const timings: number[] = [];
    for (let index = 0; index < RUNS; index++) {
      const start = performance.now();
      await run();
      timings.push(performance.now() - start);
    }
    const summary = core.timingSummary(timings);
    slowest.push(summary.slowestMs);
    medians.push(summary.medianMs);
    console.log(
      JSON.stringify({ node: process.version, counter, shape, bytes, units, ...summary }),
    );
  }
  console.log(
    JSON.stringify({
      counter,
      shape,
      units: points.map((point) => point.units),
      slowestRatios: core.doublingRatios(slowest),
      medianRatios: core.doublingRatios(medians),
    }),
  );
}
