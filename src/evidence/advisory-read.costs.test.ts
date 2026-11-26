import { expect, test } from 'vite-plus/test';
import { createAdvisoryReader, createMalwareReader, OSV_QUERY_URL } from './advisory-read.js';

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

/** Answers every request with no records (an empty GitHub list, an empty OSV result). */
function empty() {
  const requests: string[] = [];
  const fetch = async (url: string) => (
    requests.push(url),
    Response.json(url === OSV_QUERY_URL ? {} : [])
  );
  // A versioned query names `name@version`; discovery names the package alone.
  const versioned = () =>
    requests.filter((url) => new URL(url).searchParams.get('affects')?.includes('@'));
  return { fetch, requests, versioned };
}

// These per-target costs size the advisory and malware rates in the register.
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

test('an unbatched npm or pip update costs 2 reviewed requests, and npm malware 1', async () => {
  for (const ecosystem of ['npm', 'pip'] as const) {
    const server = empty();
    const reviewed = createAdvisoryReader(limits, { fetch: server.fetch, now: () => 0 });
    if (reviewed.kind !== 'ready') throw new Error('reader');
    // No discovery: npm sends one versioned GitHub query per side, pip one OSV query per side.
    for (const version of ['1.0.0', '2.0.0'])
      expect(await reviewed.read({ ecosystem, name: 'orbit', version }), ecosystem).toMatchObject({
        complete: true,
      });
    reviewed.close();
    expect(server.requests, ecosystem).toHaveLength(2);
    if (ecosystem === 'pip') expect(server.requests).toEqual([OSV_QUERY_URL, OSV_QUERY_URL]);
    else expect(server.versioned()).toHaveLength(2);
  }
  const server = empty();
  const malware = createMalwareReader(limits, { fetch: server.fetch, now: () => 0 });
  if (malware.kind !== 'ready') throw new Error('reader');
  // Malware reads the proposed side only, with no discovery for npm.
  expect(await malware.read({ ecosystem: 'npm', name: 'orbit', version: '2.0.0' })).toMatchObject({
    complete: true,
  });
  malware.close();
  expect(server.versioned()).toEqual(server.requests);
  expect(server.requests).toHaveLength(1);
});
