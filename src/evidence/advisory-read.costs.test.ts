import { expect, test } from 'vite-plus/test';
import { createAdvisoryReader, createMalwareReader } from './advisory-read.js';

const limits = {
  maxRequests: 20,
  maxPages: 20,
  maxResponseBytes: 1_048_576,
  maxTotalBytes: 8_388_608,
  maxJsonEntries: 100_000,
  maxJsonDepth: 32,
  maxRetainedBytes: 1_048_576,
  maxFindings: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const action = (version: string) => ({ ecosystem: 'actions', name: 'fixture/action', version });

/** Answers every request with an empty record list, recording each URL. */
function empty() {
  const requests: string[] = [];
  const fetch = async (url: string) => (requests.push(url), Response.json([]));
  // A versioned query names `name@version`; discovery names the package alone.
  const versioned = () =>
    requests.filter((url) => new URL(url).searchParams.get('affects')?.includes('@'));
  return { fetch, requests, versioned };
}

// These per-target costs size the direct-member advisory and malware rates in the register.
test('an unbatched Actions update costs 3 reviewed requests and 2 malware requests', async () => {
  const server = empty();
  const reviewed = createAdvisoryReader(limits, { fetch: server.fetch, now: () => 0 });
  if (reviewed.kind !== 'ready') throw new Error('reader');
  // Base and head share one stored-name discovery; each side sends its own versioned query.
  for (const side of [action('1.0.0'), action('2.0.0')])
    expect(await reviewed.read(side)).toMatchObject({ complete: true });
  reviewed.close();
  expect(server.requests).toHaveLength(3);
  expect(server.versioned()).toHaveLength(2);

  const malwareServer = empty();
  const malware = createMalwareReader(limits, { fetch: malwareServer.fetch, now: () => 0 });
  if (malware.kind !== 'ready') throw new Error('reader');
  // Malware reads the proposed side only: one discovery, then its versioned query.
  expect(await malware.read(action('2.0.0'))).toMatchObject({ complete: true });
  malware.close();
  expect(malwareServer.requests).toHaveLength(2);
  expect(malwareServer.versioned()).toHaveLength(1);
});
