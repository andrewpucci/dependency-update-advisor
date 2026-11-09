import type { EventReads } from './event.js';
import type { GithubRead, GithubTransport } from './runtime.js';
import type { ClaimStore } from './review.js';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function value(read: Promise<GithubRead>): Promise<unknown> {
  const result = await read;
  if (result.kind !== 'available') throw new Error('read unavailable');
  return result.value;
}

/** T1's reads throw on any failure; replay state comes from the claim store, never from GitHub. */
export function createEventReads(transport: GithubTransport, claims: ClaimStore): EventReads {
  return {
    readWorkflow: (repository, workflowId) =>
      value(transport.readWorkflowById(repository, workflowId)),
    readRun: (repository, runId) => value(transport.readRun(repository, runId)),
    readPullRequest: (repository, pullNumber) =>
      value(transport.readPullRequest(repository, pullNumber)),
    readComparison: (repository, base, head) =>
      value(transport.readComparison(repository, base, head)),
    readReplay: (identity) => claims.replay(identity),
  };
}

function httpsUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('request refused');
  return parsed;
}

/** The only holder of the read token: it is added for the GitHub API origin and nothing else. */
export function authenticatedFetch(token: string, fetchImpl: Fetch): Fetch {
  return async (url, init) => {
    if (httpsUrl(url).origin !== 'https://api.github.com') throw new Error('request refused');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(url, { ...init, headers, credentials: 'omit', redirect: 'manual' });
  };
}

/** Public registries and advisory sources never see a credential, whatever the caller supplies. */
export function publicFetch(fetchImpl: Fetch): Fetch {
  return async (url, init) => {
    httpsUrl(url);
    const headers = new Headers(init.headers);
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
    return fetchImpl(url, { ...init, headers, credentials: 'omit', redirect: 'manual' });
  };
}
