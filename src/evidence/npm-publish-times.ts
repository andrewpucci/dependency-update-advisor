import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { types } from 'node:util';
import parser, { type Token } from 'stream-json/parser.js';
import { PACKET_LIMITS, type EvidenceReason } from '../schema.js';
import { advisoryCheck, AdvisoryFailure, advisoryText } from './advisory-read.js';
import { freeze, isPlainObject } from './common.js';

export type PublishTimeLimits = {
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxJsonEntries: number;
  maxJsonDepth: number;
  maxWork: number;
  maxRetainedBytes: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
};
type Target = {
  name: string;
  versions: string[];
  source: { kind: 'registry'; identity: string };
  evaluationTime: number;
};
export type NpmTimesResult =
  | {
      kind: 'times';
      url: string;
      times: Readonly<Record<string, number>>;
      reasons: Readonly<Record<string, EvidenceReason>>;
    }
  | { kind: 'unavailable'; reason: EvidenceReason };
type Dependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
};
export type NpmPublishTimeReader = {
  limits: PublishTimeLimits;
  read: (value: unknown) => Promise<NpmTimesResult>;
  close: () => void;
};
function target(value: unknown): Target {
  advisoryCheck(isPlainObject(value) && isPlainObject(value.source), 'unsupported');
  const v = value,
    source = v.source as Record<string, unknown>;
  advisoryCheck(
    advisoryText(v.name) && /^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu.test(v.name),
    'unsupported',
  );
  advisoryCheck(source.kind === 'registry' && typeof source.identity === 'string', 'unsupported');
  const origin = new URL(source.identity);
  advisoryCheck(
    origin.origin === 'https://registry.npmjs.org' &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
    'unsupported',
  );
  advisoryCheck(
    Array.isArray(v.versions) &&
      !types.isProxy(v.versions) &&
      Object.getPrototypeOf(v.versions) === Array.prototype &&
      v.versions.length > 0 &&
      v.versions.length <= 2,
    'unsupported',
  );
  advisoryCheck(
    Reflect.ownKeys(v.versions).every(
      (k) =>
        typeof k === 'string' &&
        (k === 'length' || /^(?:0|[1-9]\d*)$/u.test(k)) &&
        'value' in Object.getOwnPropertyDescriptor(v.versions, k)!,
    ),
    'unsupported',
  );
  advisoryCheck(
    v.versions.every((x) => advisoryText(x) && !/[/\s@,]/u.test(x)),
    'unsupported',
  );
  advisoryCheck(Number.isSafeInteger(v.evaluationTime) && Number(v.evaluationTime) >= 0);
  return {
    name: v.name,
    versions: [...new Set(v.versions)] as string[],
    source: { kind: 'registry', identity: String(source.identity) },
    evaluationTime: Number(v.evaluationTime),
  };
}
export function publishTimestamp(value: unknown, evaluationTime: number): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value)
  )
    return null;
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return null;
  const time = Date.parse(value);
  return Number.isSafeInteger(time) && time >= 0 && time <= evaluationTime ? time : null;
}
function extractor(t: Target, limits: PublishTimeLimits, spend: () => void) {
  const frames: { kind: 'object' | 'array'; key: string | null }[] = [],
    times: Record<string, number> = {},
    reasons: Record<string, EvidenceReason> = {};
  const seen = new Set<string>();
  let text = '',
    collectingKey = false,
    capture: string | null = null,
    nameSeen = false,
    timeSeen = false;
  const keyLimit = Math.max(4, ...t.versions.map((v) => v.length));
  function selected() {
    const f = frames.at(-1);
    return frames.length === 2 &&
      timeSeen &&
      frames[0].key === 'time' &&
      f?.kind === 'object' &&
      f.key &&
      t.versions.includes(f.key)
      ? f.key
      : null;
  }
  function beginValue(kind: string) {
    const f = frames.at(-1);
    if (frames.length === 1 && f?.key === 'time') {
      advisoryCheck(kind === 'object');
      advisoryCheck(!timeSeen, 'conflict');
      timeSeen = true;
    }
    if (frames.length === 1 && f?.key === 'name') {
      advisoryCheck(kind === 'string');
      advisoryCheck(!nameSeen, 'conflict');
      nameSeen = true;
      return 'name';
    }
    const version = selected();
    if (version) {
      advisoryCheck(!seen.has(version), 'conflict');
      seen.add(version);
      if (kind !== 'string') reasons[version] = 'malformed';
      return kind === 'string' ? version : null;
    }
    return null;
  }
  function accept(token: Token) {
    spend();
    switch (token.name) {
      case 'startObject':
      case 'startArray': {
        beginValue(token.name === 'startObject' ? 'object' : 'array');
        advisoryCheck(frames.length || token.name === 'startObject');
        frames.push({ kind: token.name === 'startObject' ? 'object' : 'array', key: null });
        advisoryCheck(frames.length <= limits.maxJsonDepth, 'budget');
        break;
      }
      case 'endObject':
      case 'endArray':
        frames.pop();
        break;
      case 'startKey':
        collectingKey = true;
        text = '';
        break;
      case 'endKey':
        frames.at(-1)!.key = text.length <= keyLimit ? text : null;
        collectingKey = false;
        break;
      case 'startString':
        capture = beginValue('string');
        text = '';
        break;
      case 'stringChunk':
        if (collectingKey) {
          if (text.length <= keyLimit) text = (text + token.value).slice(0, keyLimit + 1);
        } else if (capture) {
          text += token.value;
          advisoryCheck(Buffer.byteLength(text) <= PACKET_LIMITS.identityBytes, 'budget');
        }
        break;
      case 'endString':
        if (capture === 'name') advisoryCheck(text === t.name, 'conflict');
        else if (capture) {
          const time = publishTimestamp(text, t.evaluationTime);
          if (time === null)
            reasons[capture] =
              Number.isFinite(Date.parse(text)) && Date.parse(text) > t.evaluationTime
                ? 'conflict'
                : 'malformed';
          else times[capture] = time;
        }
        capture = null;
        break;
      case 'startNumber':
      case 'trueValue':
      case 'falseValue':
      case 'nullValue':
        beginValue('other');
        break;
    }
  }
  return {
    accept,
    finish() {
      advisoryCheck(nameSeen && timeSeen, 'missing');
      for (const v of t.versions) if (times[v] === undefined && !reasons[v]) reasons[v] = 'missing';
      advisoryCheck(
        Object.keys(times).length + Object.keys(reasons).length <= limits.maxJsonEntries,
        'budget',
      );
      return { times, reasons };
    },
  };
}
class TimeReader {
  private requests = 0;
  private bytes = 0;
  private work = 0;
  private last: number;
  private started: number;
  private stopped = false;
  private busy = false;
  private active: (() => void) | null = null;
  private retained = 0;
  private cache = new Map<string, NpmTimesResult>();
  constructor(
    readonly limits: PublishTimeLimits,
    private deps: Dependencies,
  ) {
    this.started = this.last = deps.now();
    advisoryCheck(Number.isFinite(this.started));
  }
  close() {
    this.stopped = true;
    this.active?.();
  }
  private remaining() {
    const time = this.deps.now();
    advisoryCheck(!this.stopped && !this.deps.signal?.aborted, 'unknown');
    advisoryCheck(Number.isFinite(time) && time >= this.last, 'unknown');
    this.last = time;
    const left = this.limits.totalTimeoutMs - (time - this.started);
    advisoryCheck(left > 0, 'timeout');
    return left;
  }
  private spend = () => {
    advisoryCheck(++this.work <= this.limits.maxWork, 'budget');
    this.remaining();
  };
  private async fetch(t: Target): Promise<NpmTimesResult> {
    advisoryCheck(++this.requests <= this.limits.maxRequests, 'budget');
    const url = 'https://registry.npmjs.org/' + encodeURIComponent(t.name),
      controller = new AbortController();
    let reject: (error: AdvisoryFailure) => void = () => {};
    const aborted = new Promise<never>((_, r) => {
      reject = r;
    });
    const stop = (reason: EvidenceReason) => {
      controller.abort();
      reject(new AdvisoryFailure(reason));
    };
    const cancel = () => stop('unknown');
    this.active = cancel;
    this.deps.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () => stop('timeout'),
      Math.min(this.remaining(), this.limits.requestTimeoutMs),
    );
    let response: Response | undefined;
    try {
      response = await Promise.race([
        this.deps.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        }),
        aborted,
      ]);
      advisoryCheck(!response.redirected && (!response.url || response.url === url), 'unsupported');
      if (response.status === 429) throw new AdvisoryFailure('rate_limit');
      if (response.status !== 200)
        throw new AdvisoryFailure(
          response.status === 404
            ? 'missing'
            : [401, 403].includes(response.status)
              ? 'permission'
              : response.status >= 300 && response.status < 400
                ? 'unsupported'
                : 'unknown',
        );
      advisoryCheck(
        /^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? ''),
        'unsupported',
      );
      advisoryCheck(response.body);
      const stream = response.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      const state = extractor(t, this.limits, this.spend);
      const debitBytes = (count: number) => {
        size += count;
        this.bytes += count;
        advisoryCheck(
          size <= this.limits.maxResponseBytes && this.bytes <= this.limits.maxTotalBytes,
          'budget',
        );
        this.remaining();
      };
      async function* chunks() {
        try {
          for (;;) {
            const part = await Promise.race([
              stream.read().catch(() => {
                throw new AdvisoryFailure('unknown');
              }),
              aborted,
            ]);
            if (part.done) break;
            debitBytes(part.value.byteLength);
            for (let i = 0; i < part.value.length; i += PACKET_LIMITS.textBytes)
              yield decoder.decode(part.value.subarray(i, i + PACKET_LIMITS.textBytes), {
                stream: true,
              });
          }
          yield decoder.decode();
        } finally {
          void stream.cancel().catch(() => {});
          stream.releaseLock();
        }
      }
      try {
        await pipeline(
          Readable.from(chunks()),
          parser.asStream({ packValues: false, streamValues: true, jsonStreaming: false }),
          async (tokens) => {
            for await (const token of tokens) state.accept(token as Token);
          },
        );
      } catch (error) {
        throw error instanceof AdvisoryFailure ? error : new AdvisoryFailure('malformed');
      }
      const result = { kind: 'times' as const, url, ...state.finish() };
      advisoryCheck(
        Buffer.byteLength(JSON.stringify(result)) <= this.limits.maxRetainedBytes,
        'budget',
      );
      return freeze(result);
    } finally {
      clearTimeout(timer);
      this.deps.signal?.removeEventListener('abort', cancel);
      controller.abort();
      this.active = null;
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  async read(value: unknown): Promise<NpmTimesResult> {
    if (this.busy) return { kind: 'unavailable', reason: 'conflict' };
    this.busy = true;
    try {
      this.remaining();
      const t = target(value),
        key = JSON.stringify(t);
      const cached = this.cache.get(key);
      if (cached) return cached;
      let result: NpmTimesResult;
      try {
        result = await this.fetch(t);
      } catch (error) {
        result = {
          kind: 'unavailable',
          reason: error instanceof AdvisoryFailure ? error.reason : 'unknown',
        };
      }
      const retained = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(result));
      advisoryCheck(this.retained + retained <= this.limits.maxRetainedBytes, 'budget');
      this.retained += retained;
      this.cache.set(key, result);
      return result;
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: error instanceof AdvisoryFailure ? error.reason : 'unknown',
      };
    } finally {
      this.busy = false;
    }
  }
}
export function createNpmPublishTimeReader(
  value: unknown,
  dependencies: Dependencies,
): ({ kind: 'ready' } & NpmPublishTimeReader) | { kind: 'invalid' } {
  try {
    advisoryCheck(isPlainObject(value));
    const keys = [
      'maxRequests',
      'maxResponseBytes',
      'maxTotalBytes',
      'maxJsonEntries',
      'maxJsonDepth',
      'maxWork',
      'maxRetainedBytes',
      'requestTimeoutMs',
      'totalTimeoutMs',
    ] as const;
    advisoryCheck(keys.every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) > 0));
    advisoryCheck(
      Number(value.maxResponseBytes) <= Number(value.maxTotalBytes) &&
        Number(value.requestTimeoutMs) <= Number(value.totalTimeoutMs) &&
        Number(value.requestTimeoutMs) <= 2 ** 31 - 1,
    );
    const limits = Object.fromEntries(keys.map((k) => [k, value[k]])) as PublishTimeLimits,
      reader = new TimeReader(limits, dependencies);
    return Object.freeze({
      kind: 'ready',
      limits: freeze(limits),
      read: (v: unknown) => reader.read(v),
      close: () => reader.close(),
    });
  } catch {
    return { kind: 'invalid' };
  }
}
