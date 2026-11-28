/**
 * One evidence-read heap measurement for the heap probe (run.ts starts it with the flags it
 * needs): one response body of exactly `limit:evidence.envelope.maxResponseBytes` through a real
 * reader's read, parse and copy path, with a stub fetch. Usage: evidence.ts <reader> <shape>.
 *
 * Readers: `transport` (the snapshot and freshness GitHub transport, src/runtime.ts), `session`
 * (the W2 GitHub read session, src/github-read.ts), `advisory` (the malware reader's GitHub
 * advisory query) and `osv` (the reviewed reader's OSV query for a PyPI target), both
 * src/evidence/advisory-read.ts, `pypi` (the PyPI JSON metadata reader,
 * src/evidence/policy-signals-read.ts) and `npm` (npm registry documents,
 * src/evidence/npm-registry.ts). Each reader is single-flight and every evidence read is awaited
 * in turn, so one body is in flight at a time.
 *
 * Shapes fill the body with one JSON value repeated: `flat` (empty arrays), `objects` (empty
 * objects), `nested` (arrays nested to `limit:research.maxJsonDepth`) or `empty` (a two-element
 * body, the baseline). Every body opens with one CJK string, so the decoded text is a two-byte
 * string, the larger of V8's two string representations.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Collection from '../../src/collection.js';
import type * as GithubRead from '../../src/github-read.js';
import type * as Runtime from '../../src/runtime.js';
import type * as Advisory from '../../src/evidence/advisory-read.js';
import type * as PolicyRead from '../../src/evidence/policy-signals-read.js';
import type * as Registry from '../../src/evidence/npm-registry.js';
import type * as Format from '../../src/format.js';
import type * as Limits from '../../src/limits.js';
import type * as Fixtures from '../../tests/parity/evidence-reads.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(ROOT, file)).href)) as T;
const { W2_EVIDENCE_LIMITS } = await load<typeof Collection>('src/collection.ts');
const { createGithubReadSession } = await load<typeof GithubRead>('src/github-read.ts');
const { createGithubTransport } = await load<typeof Runtime>('src/runtime.ts');
const { createAdvisoryReader, createMalwareReader } = await load<typeof Advisory>('src/evidence/advisory-read.ts');
const { createPolicySignalReader } = await load<typeof PolicyRead>(
  'src/evidence/policy-signals-read.ts',
);
const { createNpmRegistryReader } = await load<typeof Registry>('src/evidence/npm-registry.ts');
const { HTTP_STATUS } = await load<typeof Format>('src/format.ts');
const { limit } = await load<typeof Limits>('src/limits.ts');
const { binding, npmRequest, repository } = await load<typeof Fixtures>(
  'tests/parity/evidence-reads.ts',
);

const gc = globalThis.gc;
if (!gc) throw new Error('run with --expose-gc (npm run measure:heap does)');

const RESPONSE_BYTES = limit('evidence.envelope.maxResponseBytes');
const DEPTH = limit('research.maxJsonDepth');
// No read here waits on a clock, so every timeout is the whole job window.
const WINDOW_MS = limit('job.window');

/** A body of exactly `bytes`: one two-byte string, then `unit` repeated, padded with spaces. */
function crafted(shape: string, bytes: number): Buffer {
  const head = '["一"';
  const tail = ']';
  const units: Record<string, string> = {
    flat: ',[]',
    objects: ',{}',
    nested: ',' + '['.repeat(DEPTH - 1) + ']'.repeat(DEPTH - 1),
    empty: '',
  };
  const unit = units[shape];
  if (unit === undefined) throw new Error(`shape must be one of ${Object.keys(units).join(', ')}`);
  const fixed = Buffer.byteLength(head + tail);
  const count = unit ? Math.floor((bytes - fixed) / unit.length) : 0;
  const text = head + unit.repeat(count);
  const pad = unit ? bytes - Buffer.byteLength(text + tail) : 0;
  const body = Buffer.from(text + ' '.repeat(pad) + tail);
  if (unit && body.byteLength !== bytes) throw new Error('crafted body is not exactly the cap');
  return body;
}

const [reader, shape] = process.argv.slice(2);
if (!reader || !shape) throw new Error('usage: evidence.ts <reader> <shape>');
// Off-heap, like a body arriving from the network.
const body = crafted(shape, RESPONSE_BYTES);
const urls: string[] = [];
const fetch = async (url: string) => {
  urls.push(url);
  return new Response(new Uint8Array(body), {
    status: HTTP_STATUS.ok,
    headers: { 'content-type': 'application/json' },
  });
};
const now = () => 0;

// The limits research opens its readers with (src/research.ts), at the full response cap.
const research = {
  maxRequests: 1,
  maxPages: 1,
  maxResponseBytes: RESPONSE_BYTES,
  maxTotalBytes: RESPONSE_BYTES,
  maxJsonEntries: limit('research.maxJsonEntries'),
  maxJsonDepth: DEPTH,
  maxWork: limit('research.maxWork'),
  maxRetainedBytes: limit('research.maxRetainedBytes'),
  maxFindings: limit('research.maxFindings'),
  requestTimeoutMs: WINDOW_MS,
  totalTimeoutMs: WINDOW_MS,
};

const reads: Record<string, () => Promise<unknown>> = {
  transport: () =>
    createGithubTransport({ token: 'stub', fetch, now }).readRepository(repository),
  session: () =>
    createGithubReadSession(
      { binding, limits: { ...W2_EVIDENCE_LIMITS.session, totalTimeoutMs: WINDOW_MS } },
      { fetch, now },
    ),
  advisory: async () => {
    const opened = createMalwareReader(research, { fetch, now });
    if (opened.kind !== 'ready') throw new Error('advisory reader');
    return opened.read({ ecosystem: 'npm', name: 'fixture', version: '1.0.0' });
  },
  osv: async () => {
    const opened = createAdvisoryReader(research, { fetch, now });
    if (opened.kind !== 'ready') throw new Error('osv reader');
    return opened.read({ ecosystem: 'pip', name: 'fixture', version: '1.0.0' });
  },
  pypi: async () => {
    const opened = createPolicySignalReader(research, { fetch, now });
    if (opened.kind !== 'ready') throw new Error('pypi reader');
    return opened.read({
      kind: 'pypi',
      name: 'fixture',
      version: '1.0.0',
      source: { kind: 'registry', identity: 'https://pypi.org/simple' },
    });
  },
  npm: async () => {
    const opened = createNpmRegistryReader(research, { fetch, now });
    if (opened.kind !== 'ready') throw new Error('npm reader');
    return opened.read(npmRequest);
  },
};
const read = reads[reader];
if (!read) throw new Error(`reader must be one of ${Object.keys(reads).join(', ')}`);

// Warm-up: the same read once, so compiled code and module state are in the baseline.
await read();
gc();
urls.length = 0;
const result = await read();
if (urls.length !== 1) throw new Error(`${reader} made ${urls.length} requests`);
console.log(
  JSON.stringify({
    node: process.version,
    reader,
    shape,
    url: urls[0],
    bodyBytes: body.byteLength,
    result: (result as { kind?: string; status?: string }).kind ?? (result as { status?: string }).status,
  }),
);
