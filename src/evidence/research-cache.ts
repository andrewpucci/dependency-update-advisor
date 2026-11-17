import { createHash } from 'node:crypto';
import { HTTP_STATUS } from '../format.js';

export type ResearchCacheOptions = Readonly<{ maxEntryBytes: number; maxTotalBytes: number }>;

export type ResearchCache = {
  /** Deterministic key: METHOD, full URL, and headers (names lowercased, sorted); an authorization value is replaced by its SHA-256 hex. */
  key(method: string, url: string, headers?: HeadersInit): string;
  /** A fresh Response for a stored entry, or undefined. Each call returns a new Response object with the same status, headers, and bytes. */
  lookup(key: string): Response | undefined;
  /** Stores a 200 or 404 response if it fits; returns a Response the caller must use instead of `response`. */
  store(key: string, response: Response): Promise<Response>;
};

type Entry = { status: number; headers: [string, string][]; bytes: Uint8Array<ArrayBuffer> };

const CACHEABLE_STATUSES = new Set<number>([HTTP_STATUS.ok, HTTP_STATUS.notFound]);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeHeaders(headers: HeadersInit | undefined): [string, string][] {
  return [...new Headers(headers)]
    .map(([name, value]): [string, string] =>
      name === 'authorization' ? [name, sha256Hex(value)] : [name, value],
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function toResponse(entry: Entry): Response {
  return new Response(entry.bytes, { status: entry.status, headers: entry.headers });
}

/** Re-emits chunks already read from `reader`, then continues reading until done. */
function passThrough(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[],
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}

export function createResearchCache(options: ResearchCacheOptions): ResearchCache {
  const entries = new Map<string, Entry>();
  let totalBytes = 0;

  function commit(
    key: string,
    response: Response,
    bytes: Uint8Array<ArrayBuffer>,
    previousBytes: number,
  ) {
    totalBytes += bytes.byteLength - previousBytes;
    const entry = { status: response.status, headers: [...response.headers], bytes };
    entries.set(key, entry);
    return toResponse(entry);
  }

  return {
    key(method, url, headers) {
      return JSON.stringify([method.toUpperCase(), url, normalizeHeaders(headers)]);
    },

    lookup(key) {
      const entry = entries.get(key);
      return entry === undefined ? undefined : toResponse(entry);
    },

    async store(key, response) {
      if (!CACHEABLE_STATUSES.has(response.status)) return response;
      const previousBytes = entries.get(key)?.bytes.byteLength ?? 0;
      if (response.body === null) {
        return commit(key, response, new Uint8Array(), previousBytes);
      }

      const reader = response.body.getReader();
      const buffered: Uint8Array[] = [];
      let entryBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered.push(value);
        entryBytes += value.byteLength;
        const overEntry = entryBytes > options.maxEntryBytes;
        const overTotal = totalBytes - previousBytes + entryBytes > options.maxTotalBytes;
        if (overEntry || overTotal) return passThrough(response, reader, buffered);
      }

      const bytes = new Uint8Array(entryBytes);
      let offset = 0;
      for (const chunk of buffered) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return commit(key, response, bytes, previousBytes);
    },
  };
}
