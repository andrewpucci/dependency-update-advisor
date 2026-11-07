import { freeze, isPlainObject } from '../evidence/common.js';
import {
  preparedSnapshot,
  receiveAnalysisReply,
  validateAnalysisReply,
  type AnalysisCategory,
  type AnalysisResult,
  type PreparedAnalysisBatch,
} from './contract.js';
import type { BatchSnapshot } from './projection.js';

export type MistralCategory =
  | AnalysisCategory
  | 'cancelled'
  | 'deadline'
  | 'transport'
  | 'http'
  | 'media-type'
  | 'response-size'
  | 'encoding'
  | 'envelope'
  | 'json'
  | 'length';
export type MistralOptions = Readonly<{
  apiKey?: string;
  deadlineMs: number;
  signal?: AbortSignal;
}>;
export type MistralDependencies = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}>;
export type MistralDiagnostics = Readonly<{
  provider: 'mistral';
  model: string | null;
  headSha: string | null;
  unitCount: number;
  memberCount: number;
  attempted: boolean;
  category: MistralCategory | null;
}>;
type Outcome =
  | AnalysisResult
  | Readonly<{
      kind: 'invalid' | 'unavailable' | 'failed' | 'truncated';
      category: MistralCategory;
      attempted: boolean;
      batchId?: string;
      unitIds?: readonly string[];
    }>;
export type MistralResult = Outcome & Readonly<{ diagnostics: MistralDiagnostics }>;

class MistralFailure extends Error {
  constructor(readonly category: MistralCategory) {
    super(category);
  }
}
function requireValue(value: unknown, category: MistralCategory): asserts value {
  if (!value) throw new MistralFailure(category);
}
function preflight(options: MistralOptions, deps: MistralDependencies): number {
  requireValue(isPlainObject(options), 'configuration');
  for (const key of Reflect.ownKeys(options)) {
    const field = Object.getOwnPropertyDescriptor(options, key)!;
    requireValue(
      ['apiKey', 'deadlineMs', 'signal'].includes(String(key)) && 'value' in field,
      'configuration',
    );
  }
  requireValue(
    typeof options.apiKey === 'string' && /^[\x21-\x7e]+$/.test(options.apiKey),
    'configuration',
  );
  requireValue(
    options.signal === undefined || options.signal instanceof AbortSignal,
    'configuration',
  );
  requireValue(!options.signal?.aborted, 'cancelled');
  const now = deps.now();
  requireValue(
    Number.isFinite(now) && Number.isFinite(options.deadlineMs) && options.deadlineMs > now,
    'deadline',
  );
  return now;
}
function cancelBody(response: Response | undefined) {
  if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

/** Abort is raced as well as signalled: an uncooperative fetch/read cannot hold the caller open. */
function lifecycle(
  options: MistralOptions,
  deps: MistralDependencies,
  start: number,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const deadline = Math.min(options.deadlineMs, start + timeoutMs);
  let last = start,
    closed = false;
  let observed: Response | undefined;
  let reject: (reason: MistralFailure) => void = () => {};
  const aborted = new Promise<never>((_, fail) => {
    reject = fail;
  });
  void aborted.catch(() => {});
  const stop = (category: MistralCategory) => {
    controller.abort();
    reject(new MistralFailure(category));
  };
  const cancel = () => stop('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('deadline'), deadline - start);
  const check = () => {
    requireValue(!options.signal?.aborted, 'cancelled');
    const now = deps.now();
    requireValue(Number.isFinite(now) && now >= last && now < deadline, 'deadline');
    last = now;
  };
  return {
    signal: controller.signal,
    check,
    async race<T>(pending: Promise<T>): Promise<T> {
      check();
      const value = await Promise.race([pending, aborted]);
      check();
      return value;
    },
    observe(pending: Promise<Response>) {
      void pending.then(
        (response) => {
          observed = response;
          if (closed) cancelBody(response);
        },
        () => {},
      );
    },
    close() {
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort();
      cancelBody(observed);
    },
  };
}
type Lifecycle = ReturnType<typeof lifecycle>;

async function readResponse(response: Response, limit: number, run: Lifecycle): Promise<string> {
  requireValue(response.status === 200 && !response.redirected, 'http');
  requireValue(
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
      'application/json',
    'media-type',
  );
  const length = response.headers.get('content-length');
  requireValue(!length || !/^\d+$/.test(length) || Number(length) <= limit, 'response-size');
  requireValue(response.body, 'envelope');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await run.race(reader.read());
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      requireValue(bytes <= limit, 'response-size');
      chunks.push(chunk.value);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    } catch {
      throw new MistralFailure('encoding');
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function json(text: string, category: 'envelope' | 'json'): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MistralFailure(category);
  }
}
function emptyToolFields(message: Record<string, unknown>) {
  requireValue(
    message.tool_calls == null ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length === 0),
    'envelope',
  );
  requireValue(
    message.function_call == null && (message.refusal == null || message.refusal === ''),
    'envelope',
  );
}
function document(text: string): unknown {
  const envelope = json(text, 'envelope');
  requireValue(
    isPlainObject(envelope) && Array.isArray(envelope.choices) && envelope.choices.length === 1,
    'envelope',
  );
  const choice: unknown = envelope.choices[0];
  requireValue(
    isPlainObject(choice) && choice.index === 0 && isPlainObject(choice.message),
    'envelope',
  );
  const message = choice.message;
  requireValue(message.role === 'assistant' && typeof message.content === 'string', 'envelope');
  emptyToolFields(message);
  if (choice.finish_reason === 'length') throw new MistralFailure('length');
  requireValue(choice.finish_reason === 'stop' && message.content.trim().length > 0, 'envelope');
  return json(message.content, 'json');
}
function result(outcome: Outcome, snapshot?: BatchSnapshot): MistralResult {
  return freeze({
    ...outcome,
    diagnostics: {
      provider: 'mistral',
      model: snapshot?.request.model ?? null,
      headSha: snapshot?.inventory.packet.binding.headSha ?? null,
      unitCount: snapshot?.selected.length ?? 0,
      memberCount: snapshot?.members.length ?? 0,
      attempted: 'attempted' in outcome ? outcome.attempted : true,
      category: 'category' in outcome ? outcome.category : null,
    },
  });
}
function failure(
  snapshot: BatchSnapshot,
  category: MistralCategory,
  attempted: boolean,
): MistralResult {
  return result(
    {
      kind: attempted ? (category === 'length' ? 'truncated' : 'failed') : 'unavailable',
      category,
      attempted,
      batchId: snapshot.batchId,
      unitIds: snapshot.selected.map((unit) => unit.id),
    },
    snapshot,
  );
}

/** One trusted prepared batch, one fixed POST, and no repair, fallback or retry. */
export async function analyzeMistralBatch(
  batch: PreparedAnalysisBatch,
  options: MistralOptions,
  deps: MistralDependencies = { fetch: globalThis.fetch, now: () => performance.now() },
): Promise<MistralResult> {
  const snapshot = preparedSnapshot(batch);
  if (!snapshot) return result({ kind: 'invalid', category: 'reference', attempted: false });
  let attempted = false,
    run: Lifecycle | undefined,
    response: Response | undefined;
  try {
    const start = preflight(options, deps);
    const body = JSON.stringify(snapshot.request);
    requireValue(Buffer.byteLength(body) <= snapshot.limits.requestBytes, 'budget');
    run = lifecycle(options, deps, start, snapshot.limits.requestTimeoutMs);
    run.check();
    attempted = true;
    const pending = deps.fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      signal: run.signal,
    });
    run.observe(pending);
    response = await run.race(pending);
    const text = await readResponse(response, snapshot.limits.responseBytes, run);
    run.check();
    const reply = await receiveAnalysisReply(batch, async () => document(text));
    run.check();
    const validated = validateAnalysisReply(batch, reply);
    run.check();
    return result(validated, snapshot);
  } catch (error) {
    return failure(
      snapshot,
      error instanceof MistralFailure ? error.category : 'transport',
      attempted,
    );
  } finally {
    run?.close();
    cancelBody(response);
  }
}
