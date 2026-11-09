import parser from 'stream-json/parser.js';
import { readWorkflow } from './evidence/actions-yaml.js';
import { createNpmPublishTimeReader } from './evidence/npm-publish-times.js';
import { canonicalLicense } from './evidence/policy-signals-licenses.js';
import { readToml } from './evidence/uv-toml.js';
import { compareUpstreamVersions } from './evidence/upstream-version.js';
import { parseRuntime } from './runtime.js';

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

/** The W2 action validates startup inputs but intentionally has no production claim or write adapter. */
export async function runStartup(
  writeError: (line: string) => void,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const passed = await selfCheck().then(
    (checks) => Object.values(checks).every(Boolean),
    () => false,
  );
  if (!passed) {
    writeError('dependabot-review: startup self-check failed; no review ran.');
    return SELF_CHECK_EXIT_CODE;
  }
  if (!parseRuntime(environment)) {
    writeError('dependabot-review: runtime configuration invalid; no review ran.');
    return NOT_WIRED_EXIT_CODE;
  }
  writeError('dependabot-review: no-write rehearsal completed; no review ran.');
  return NOT_WIRED_EXIT_CODE;
}
