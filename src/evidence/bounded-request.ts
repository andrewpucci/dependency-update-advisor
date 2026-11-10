import type { EvidenceReason } from '../schema.js';
import { advisoryCheck, AdvisoryFailure } from './advisory-read.js';
import { isPlainObject } from './common.js';

export type BoundedLimits = {
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
export type BoundedDependencies = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  signal?: AbortSignal;
};
export function boundedLimits(value: unknown): BoundedLimits {
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
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as BoundedLimits;
}
/** Wall-clock budget shared by every request of one reader; a non-monotonic clock is unknown. */
export class BoundedClock {
  private readonly started: number;
  private last: number;
  constructor(
    private readonly totalTimeoutMs: number,
    private readonly deps: BoundedDependencies,
  ) {
    this.started = this.last = deps.now();
    advisoryCheck(Number.isFinite(this.started));
  }
  remaining(stopped: EvidenceReason | null) {
    advisoryCheck(!stopped && !this.deps.signal?.aborted, stopped ?? 'unknown');
    const now = this.deps.now();
    advisoryCheck(Number.isFinite(now) && now >= this.last, 'unknown');
    this.last = now;
    const left = this.totalTimeoutMs - (now - this.started);
    advisoryCheck(left > 0, 'timeout');
    return left;
  }
}
/**
 * One credential-free GET raced against its timeout, the caller's signal, and `onCancel`
 * (registered for the reader's close). Every exit aborts the request and releases its body.
 */
export async function boundedGet<T>(
  deps: BoundedDependencies,
  request: { url: string; accept: string; timeoutMs: number },
  onCancel: (cancel: (() => void) | null) => void,
  consume: (response: Response, aborted: Promise<never>) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let reject: (error: AdvisoryFailure) => void = () => {};
  const aborted = new Promise<never>((_, r) => {
    reject = r;
  });
  const stop = (reason: EvidenceReason) => {
    controller.abort();
    reject(new AdvisoryFailure(reason));
  };
  const cancel = () => stop('unknown');
  onCancel(cancel);
  deps.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
  let response: Response | undefined;
  try {
    const pending = deps.fetch(request.url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: request.accept },
      signal: controller.signal,
    });
    void pending.then(
      (late) => {
        if (controller.signal.aborted && late.body && !late.body.locked)
          void late.body.cancel().catch(() => {});
      },
      () => {},
    );
    response = await Promise.race([pending, aborted]);
    return await consume(response, aborted);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', cancel);
    onCancel(null);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
