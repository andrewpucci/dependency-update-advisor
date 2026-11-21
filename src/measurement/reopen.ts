type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const PULL_PATH = /^\/(?:repos\/[^/]+\/[^/]+|repositories\/\d+)\/pulls\/(\d+)$/;

/**
 * A measurement-only shim: the reviewer stops on a closed pull request, so to measure the reads a
 * closed Dependabot PR would have needed, its pull request read comes back open and unmerged. The
 * head SHA, base, and file list are unchanged. `rewrites` counts the reads it changed.
 */
export function reopenPullRequest(
  fetch: FetchLike,
  pullNumber: number,
): { fetch: FetchLike; rewrites(): number } {
  let rewrites = 0;
  const reopened = async (url: string, init: RequestInit): Promise<Response> => {
    const response = await fetch(url, init);
    const match = PULL_PATH.exec(new URL(url).pathname);
    if (!response.ok || match?.[1] !== String(pullNumber)) return response;
    let value: unknown;
    try {
      value = await response.clone().json();
    } catch {
      return response;
    }
    if (typeof value !== 'object' || value === null) return response;
    const pull = value as { state?: unknown; merged?: unknown };
    if (pull.state !== 'closed' && pull.merged !== true) return response;
    rewrites += 1;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify({ ...pull, state: 'open', merged: false }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  return { fetch: reopened, rewrites: () => rewrites };
}
