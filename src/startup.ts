import parser from 'stream-json/parser.js';
import { readWorkflow } from './evidence/actions-yaml.js';
import { createNpmPublishTimeReader } from './evidence/npm-publish-times.js';
import { canonicalLicense } from './evidence/policy-signals-licenses.js';
import { readToml } from './evidence/uv-toml.js';
import { compareUpstreamVersions } from './evidence/upstream-version.js';
import fs from 'node:fs/promises';
import { authenticatedFetch, createEventReads, publicFetch } from './adapters.js';
import { createRehearsalSink, type RehearsalSink } from './handoff.js';
import { runReview, type PipelineInput } from './pipeline.js';
import { createTestClaimStore, type ClaimStore } from './review.js';
import { createGithubTransport, parseRuntime, resolveWorkflow } from './runtime.js';
import { createGithubSnapshotReads } from './snapshot.js';

/** Distinct from 1, which Node uses when the bundle itself fails to load. */
export const NOT_WIRED_EXIT_CODE = 78;
export const SELF_CHECK_EXIT_CODE = 79;

// Referenced so the bundler keeps the module that owns the stream-json parse path.
const bundledModules = { createNpmPublishTimeReader };

const bytes = (text: string) => new TextEncoder().encode(text);

async function streamJsonParses(): Promise<boolean> {
  const names: string[] = [];
  const stream = parser.asStream({ packValues: false, streamValues: true, jsonStreaming: false });
  stream.on('data', (token: { name: string }) => names.push(token.name));
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
    stream.end('{"a":1}');
  });
  return (
    names.includes('startObject') && typeof bundledModules.createNpmPublishTimeReader === 'function'
  );
}

/** Runs each production dependency once, with no network, secret, or filesystem access. */
export async function selfCheck() {
  const toml = readToml(bytes('a = 1'), {
    maxFileBytes: 64,
    maxTomlDepth: 4,
    maxTomlEntries: 8,
    maxPackages: 1,
    maxDeclarations: 1,
    maxEdges: 1,
    maxStringBytes: 16,
    maxRequirementTokens: 4,
    maxMarkerDepth: 2,
  });
  const workflow = readWorkflow(bytes('jobs:\n  a:\n    steps:\n      - uses: ./local\n'), {
    maxFileBytes: 256,
    maxYamlNodes: 64,
    maxYamlDepth: 8,
    maxAliasExpansions: 0,
    maxOccurrences: 4,
  });
  const license = canonicalLicense('MIT', { maxBytes: 32, maxTokens: 4, maxDepth: 2 });
  return {
    semver: compareUpstreamVersions('npm', '1.0.0', '1.0.1') === -1,
    pep440: compareUpstreamVersions('uv', '1.0', '1.1') === -1,
    spdx: license.kind === 'known' && license.value === 'MIT',
    toml: toml.kind === 'parsed',
    yaml: workflow.kind === 'parsed',
    streamJson: await streamJsonParses(),
  };
}

export const MAX_EVENT_BYTES = 1024 * 1024;

export type StartupDependencies = Readonly<{
  /** The platform fetch; wrapped so only GitHub reads carry the read token. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Reads the trusted event file; at most `MAX_EVENT_BYTES`. */
  readEvent: (path: string) => Promise<string>;
  /** Monotonic milliseconds. */
  now: () => number;
  /** Epoch milliseconds. */
  evaluationTime: () => number;
  /** Replaces the model transport; unset uses the platform fetch. */
  model?: PipelineInput['model'];
  /**
   * No production claim backend exists, so the default is a single-attempt in-memory store: a
   * rehearsal cannot own an attempt across runs.
   */
  claims?: ClaimStore;
  /** Replaces the rehearsal sink; it must still be unable to write. */
  sink?: RehearsalSink;
}>;

export async function readBoundedEvent(path: string): Promise<string> {
  const handle = await fs.open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_EVENT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_EVENT_BYTES) throw new Error('event too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function platformDependencies(): StartupDependencies {
  return {
    fetch: (url, init) => fetch(url, init),
    readEvent: readBoundedEvent,
    now: () => performance.now(),
    evaluationTime: () => Date.now(),
  };
}

/**
 * Runs one no-write rehearsal of the review pipeline. It reads GitHub and public sources and records
 * the intended publication in a sink that cannot write, so the exit code stays non-zero: no status
 * or comment is ever published, and the run must not be mistaken for a live review. Every message
 * is a fixed string; no input, error text, or stack is echoed.
 */
export async function runStartup(
  writeError: (line: string) => void,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: StartupDependencies = platformDependencies(),
): Promise<number> {
  const passed = await selfCheck().then(
    (checks) => Object.values(checks).every(Boolean),
    () => false,
  );
  if (!passed) {
    writeError('dependabot-review: startup self-check failed; no review ran.');
    return SELF_CHECK_EXIT_CODE;
  }
  const runtime = parseRuntime(environment);
  if (!runtime) {
    writeError('dependabot-review: runtime configuration invalid; no review ran.');
    return NOT_WIRED_EXIT_CODE;
  }
  try {
    const eventPath = environment.GITHUB_EVENT_PATH;
    const eventName = environment.GITHUB_EVENT_NAME;
    let payload: unknown;
    try {
      if (!eventPath || !eventName) throw new Error('no event');
      payload = JSON.parse(await dependencies.readEvent(eventPath));
    } catch {
      writeError('dependabot-review: event unavailable; no review ran.');
      return NOT_WIRED_EXIT_CODE;
    }
    const transport = createGithubTransport({
      token: runtime.githubToken,
      fetch: dependencies.fetch,
      now: dependencies.now,
    });
    const workflow = await resolveWorkflow(runtime, transport);
    if (!workflow) {
      writeError('dependabot-review: workflow could not be verified; no review ran.');
      return NOT_WIRED_EXIT_CODE;
    }
    // The sink is built without the App token, so nothing here can publish.
    const sink = dependencies.sink ?? createRehearsalSink(null);
    if (!sink) throw new Error('sink');
    const claims = dependencies.claims ?? createTestClaimStore();
    const result = await runReview({
      event: { eventName, payload, expected: { repository: runtime.repository, workflow } },
      repository: runtime.repository,
      llmApiKey: runtime.llmApiKey,
      eventReads: createEventReads(transport, claims),
      snapshotReads: createGithubSnapshotReads(transport),
      claims,
      sink,
      githubFetch: authenticatedFetch(runtime.githubToken, dependencies.fetch),
      publicFetch: publicFetch(dependencies.fetch),
      model: dependencies.model,
      now: dependencies.now,
      evaluationTime: dependencies.evaluationTime(),
    });
    if (result.kind === 'handed-off' && !result.recorded)
      writeError(
        'dependabot-review: no-write rehearsal could not record the handoff; nothing was published.',
      );
    else if (result.kind === 'handed-off')
      writeError(
        `dependabot-review: no-write rehearsal recorded ${result.outcome}; nothing was published.`,
      );
    else if (result.kind === 'skipped')
      writeError(`dependabot-review: event skipped (${result.reason}); nothing was published.`);
    else
      writeError(
        `dependabot-review: no publishable handoff (${result.reason}); nothing was published.`,
      );
  } catch {
    writeError('dependabot-review: rehearsal failed; nothing was published.');
  }
  return NOT_WIRED_EXIT_CODE;
}
