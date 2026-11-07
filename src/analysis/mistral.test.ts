import { afterEach, expect, test, vi } from 'vite-plus/test';
import { analysisDocument, preparedAnalysis } from '../../tests/parity/analysis.js';
import { ANALYSIS_LIMITS, prepareAnalysisBatch, type PreparedAnalysisBatch } from './contract.js';
import { analyzeMistralBatch } from './mistral.js';

function completion(
  batch: PreparedAnalysisBatch,
  finish = 'stop',
  content = JSON.stringify(analysisDocument(batch)),
) {
  return Response.json({
    model: 'resolved-model-alias',
    choices: [
      {
        index: 0,
        finish_reason: finish,
        message: { role: 'assistant', content, tool_calls: [], refusal: null },
      },
    ],
  });
}
const options = { apiKey: 'SYNTHETIC_KEY', deadlineMs: 1000 };
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('sends one fixed authenticated request and returns only validated original-ID assessments', async () => {
  const { batch } = await preparedAnalysis();
  const fetch = vi.fn(async () => completion(batch));
  const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
  expect(result.kind).toBe('validated');
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
  expect(init).toMatchObject({
    method: 'POST',
    redirect: 'error',
    credentials: 'omit',
    headers: {
      Authorization: 'Bearer SYNTHETIC_KEY',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  expect(JSON.parse(String(init.body))).toEqual(batch.request);
  if (result.kind !== 'validated') throw new Error('validation');
  expect(result.assessments.map((entry) => entry.unitId)).toEqual(batch.unitIds);
  expect(result.diagnostics).toMatchObject({
    provider: 'mistral',
    model: 'synthetic-model',
    unitCount: batch.unitIds.length,
    attempted: true,
    category: null,
  });
});

test('rejects missing or header-invalid credentials and copied handles before fetch', async () => {
  const { batch } = await preparedAnalysis();
  const fetch = vi.fn(async () => completion(batch));
  for (const apiKey of ['', ' ', 'KEY\nINJECTION', undefined]) {
    expect(
      await analyzeMistralBatch(batch, { ...options, apiKey }, { fetch, now: () => 0 }),
    ).toMatchObject({ kind: 'unavailable', attempted: false, category: 'configuration' });
  }
  expect(await analyzeMistralBatch({ ...batch }, options, { fetch, now: () => 0 })).toMatchObject({
    kind: 'invalid',
    attempted: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});

test.each([301, 401, 403, 429, 500])(
  'HTTP %s causes one scoped failure with no retry',
  async (status) => {
    const { batch } = await preparedAnalysis();
    const fetch = vi.fn(
      async () =>
        new Response('RAW_ERROR_SENTINEL', {
          status,
          headers: { location: 'https://example.invalid/redirect', 'retry-after': '500' },
        }),
    );
    const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
    expect(result).toMatchObject({
      kind: 'failed',
      category: 'http',
      attempted: true,
      batchId: batch.batchId,
    });
    expect(result).not.toHaveProperty('assessments');
    expect(JSON.stringify(result)).not.toContain('RAW_ERROR_SENTINEL');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test.each(['length', 'model_length', 'tool_calls', 'unknown'])(
  'classifies finish reason %s without accepting partial text',
  async (finish) => {
    const { batch } = await preparedAnalysis();
    const fetch = vi.fn(async () => completion(batch, finish, 'incomplete JSON'));
    const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
    expect(result.kind).toBe(finish === 'length' ? 'truncated' : 'failed');
    expect(result).not.toHaveProperty('assessments');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test('rejects fenced/malformed JSON and model schema violations without exposing model text', async () => {
  const { batch } = await preparedAnalysis();
  for (const content of ['```json\n{}\n```', '{ RAW_MODEL_SENTINEL', '{"assessments":[]}']) {
    const fetch = vi.fn(async () => completion(batch, 'stop', content));
    const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
    expect(result.kind).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('RAW_MODEL_SENTINEL');
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

test('requires exactly one assistant choice with plain string content before considering length', async () => {
  const { batch } = await preparedAnalysis();
  const message = { role: 'assistant', content: JSON.stringify(analysisDocument(batch)) };
  const choice = { index: 0, finish_reason: 'length', message };
  const invalid = [
    {},
    { choices: [] },
    { choices: [choice, choice] },
    { choices: [{ ...choice, index: '0' }] },
    ...[
      { role: 'tool' },
      { content: null },
      { content: [] },
      { tool_calls: [{ id: 'tool' }] },
      { function_call: {} },
      { refusal: 'No' },
    ].map((patch) => ({ choices: [{ ...choice, message: { ...message, ...patch } }] })),
  ];
  for (const envelope of invalid) {
    const fetch = vi.fn(async () => Response.json(envelope));
    expect(await analyzeMistralBatch(batch, options, { fetch, now: () => 0 })).toMatchObject({
      kind: 'failed',
      category: 'envelope',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

test('requires application/json with normal casing and parameters', async () => {
  const { batch } = await preparedAnalysis();
  const body = await completion(batch).text();
  for (const media of [
    null,
    'text/html',
    'text/event-stream',
    'x-application/json',
    'application/jsonp',
  ]) {
    const headers = new Headers();
    if (media) headers.set('content-type', media);
    const fetch = vi.fn(async () => new Response(new TextEncoder().encode(body), { headers }));
    expect(await analyzeMistralBatch(batch, options, { fetch, now: () => 0 })).toMatchObject({
      category: 'media-type',
      kind: 'failed',
    });
  }
  const fetch = vi.fn(
    async () =>
      new Response(body, { headers: { 'content-type': 'Application/JSON; charset=utf-8' } }),
  );
  expect((await analyzeMistralBatch(batch, options, { fetch, now: () => 0 })).kind).toBe(
    'validated',
  );
});

test('rejects invalid UTF-8, malformed outer JSON, and network errors safely', async () => {
  const { batch } = await preparedAnalysis();
  const cases = [
    { body: new Uint8Array([0xc3, 0x28]), category: 'encoding' },
    { body: new TextEncoder().encode('{ RAW_OUTER_SENTINEL'), category: 'envelope' },
  ];
  for (const entry of cases) {
    const fetch = vi.fn(
      async () => new Response(entry.body, { headers: { 'content-type': 'application/json' } }),
    );
    const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
    expect(result).toMatchObject({ kind: 'failed', category: entry.category });
    expect(JSON.stringify(result)).not.toContain('RAW_OUTER_SENTINEL');
  }
  const fetch = vi.fn(async () => {
    throw new Error('SECRET_NETWORK_SENTINEL');
  });
  const result = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
  expect(result).toMatchObject({ kind: 'failed', category: 'transport', attempted: true });
  expect(JSON.stringify(result)).not.toContain('SECRET_NETWORK_SENTINEL');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('cancels headers received at the deadline even when they cannot be assigned to the caller', async () => {
  const { batch } = await preparedAnalysis();
  let now = 0;
  let resolve: (response: Response) => void = () => {};
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const task = analyzeMistralBatch(batch, options, { fetch: () => pending, now: () => now });
  resolve(new Response(body, { headers: { 'content-type': 'application/json' } }));
  now = options.deadlineMs;
  expect(await task).toMatchObject({ kind: 'failed', category: 'deadline' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});

test('does not dispatch after abort, exhausted/non-finite deadline, or a backwards clock', async () => {
  const { batch } = await preparedAnalysis();
  const fetch = vi.fn(async () => completion(batch));
  for (const deadlineMs of [NaN, Infinity, -1, 0]) {
    expect(
      await analyzeMistralBatch(batch, { ...options, deadlineMs }, { fetch, now: () => 0 }),
    ).toMatchObject({ kind: 'unavailable', category: 'deadline', attempted: false });
  }
  const controller = new AbortController();
  controller.abort('SECRET_ABORT_REASON');
  const stopped = await analyzeMistralBatch(
    batch,
    { ...options, signal: controller.signal },
    { fetch, now: () => 0 },
  );
  expect(stopped).toMatchObject({ kind: 'unavailable', category: 'cancelled', attempted: false });
  expect(JSON.stringify(stopped)).not.toContain('SECRET_ABORT_REASON');
  const now = vi.fn().mockReturnValueOnce(1).mockReturnValue(0);
  expect(await analyzeMistralBatch(batch, options, { fetch, now })).toMatchObject({
    attempted: false,
    category: 'deadline',
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('times out ignored fetch, clears resources, and cancels a late body without awaiting cancellation', async () => {
  const { batch } = await preparedAnalysis();
  vi.useFakeTimers();
  let now = 0;
  let resolve: (response: Response) => void = () => {};
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const caller = new AbortController();
  const add = vi.spyOn(caller.signal, 'addEventListener');
  const remove = vi.spyOn(caller.signal, 'removeEventListener');
  let sentSignal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    sentSignal = init.signal!;
    return pending;
  });
  const task = analyzeMistralBatch(
    batch,
    { ...options, deadlineMs: 50, signal: caller.signal },
    { fetch, now: () => now },
  );
  now = 50;
  await vi.advanceTimersByTimeAsync(50);
  const result = await task;
  expect(result).toMatchObject({ kind: 'failed', attempted: true, category: 'deadline' });
  expect(sentSignal?.aborted).toBe(true);
  expect(add).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  expect(vi.getTimerCount()).toBe(0);
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  resolve(new Response(body));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(result.kind).toBe('failed');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(['timeout', 'abort'] as const)(
  'settles a stalled body on %s and releases its reader even if cancel never settles',
  async (mode) => {
    const { batch } = await preparedAnalysis();
    vi.useFakeTimers();
    let now = 0;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel,
    });
    const caller = new AbortController();
    const fetch = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    );
    const task = analyzeMistralBatch(
      batch,
      { ...options, deadlineMs: 50, signal: caller.signal },
      { fetch, now: () => now },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(true);
    if (mode === 'abort') caller.abort('PRIVATE_ABORT_REASON');
    else {
      now = 50;
      await vi.advanceTimersByTimeAsync(50);
    }
    const result = await task;
    expect(result).toMatchObject({
      kind: 'failed',
      category: mode === 'abort' ? 'cancelled' : 'deadline',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ABORT_REASON');
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test('clips the per-request limit independently of the caller deadline', async () => {
  const { input } = await preparedAnalysis();
  const prepared = prepareAnalysisBatch({
    ...input,
    limits: { ...ANALYSIS_LIMITS, requestTimeoutMs: 40 },
  });
  if (prepared.kind !== 'prepared') throw new Error('fixture');
  vi.useFakeTimers();
  let now = 0;
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  const task = analyzeMistralBatch(prepared.batch, options, { fetch, now: () => now });
  now = 40;
  await vi.advanceTimersByTimeAsync(40);
  expect(await task).toMatchObject({ kind: 'failed', category: 'deadline' });
  expect(vi.getTimerCount()).toBe(0);
});

test('rejects output that becomes late during synchronous inner parsing', async () => {
  const { batch } = await preparedAnalysis();
  let now = 0;
  const response = completion(batch);
  const parse = JSON.parse;
  vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
    const value = parse(text);
    if (text.startsWith('{"assessments":')) now = options.deadlineMs;
    return value;
  });
  expect(
    await analyzeMistralBatch(batch, options, { fetch: async () => response, now: () => now }),
  ).toMatchObject({ kind: 'failed', category: 'deadline' });
});

test('releases a failed stream and keeps an independent call usable', async () => {
  const { batch } = await preparedAnalysis();
  vi.useFakeTimers();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('RAW_STREAM_ERROR'));
    },
  });
  const fetch = vi.fn(
    async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
  );
  const failed = await analyzeMistralBatch(batch, options, { fetch, now: () => 0 });
  expect(failed).toMatchObject({ kind: 'failed', category: 'transport' });
  expect(JSON.stringify(failed)).not.toContain('RAW_STREAM_ERROR');
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(
    (
      await analyzeMistralBatch(batch, options, {
        fetch: async () => completion(batch),
        now: () => 0,
      })
    ).kind,
  ).toBe('validated');
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps cancellation ownership when the caller mutates its options after dispatch', async () => {
  const { batch } = await preparedAnalysis();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, 'removeEventListener');
  const mutable = { ...options, signal: caller.signal };
  const fetch = vi.fn(async () => {
    mutable.signal = new AbortController().signal;
    return completion(batch);
  });
  expect((await analyzeMistralBatch(batch, mutable, { fetch, now: () => 0 })).kind).toBe(
    'validated',
  );
  expect(remove).toHaveBeenCalledTimes(1);
});
