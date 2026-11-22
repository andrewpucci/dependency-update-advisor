/**
 * The pure part of the comment-limit probe (docs/specs/SPEC-limit-register.md, External
 * Citations Amendment A2): the bodies it sends, how one write's answer is classified, which
 * counting unit a set of outcomes fits, and the bounded search for the limit. The runner in
 * run.ts does the network calls; everything here takes an injected writer.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Format from '../../src/format.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { HTTP_STATUS } = (await import(
  pathToFileURL(join(ROOT, 'src/format.ts')).href
)) as typeof Format;

export const UNITS = ['code points', 'code units', 'bytes'] as const;
export type Unit = (typeof UNITS)[number];

export type WriteKind = 'create' | 'update';

/** One write as the runner saw it: an HTTP answer, or a failure with no answer. */
export type WriteAnswer = { status: number; data: unknown } | { error: string };

export type WriteResult =
  | { outcome: 'accepted'; status: number }
  | { outcome: 'rejected'; status: number; message: string }
  | { outcome: 'inconclusive'; status?: number; reason: string };

export type BodyName =
  | 'ascii'
  | 'astral'
  | 'astralPlusOne'
  | 'twoByte'
  | 'threeByte'
  | 'lineBreaks';

export type WriteRecord = {
  kind: WriteKind;
  body: BodyName;
  codeUnits: number;
  status: number | null;
  outcome: WriteResult['outcome'];
};

export type ProbeOutcome = {
  unit: Unit | 'inconclusive';
  reason?: string;
  /** L: the longest ASCII body create accepted, with L + 1 rejected. */
  limit?: number;
  update: 'agrees' | 'differs' | 'inconclusive' | 'not run';
  lineBreaks: 'accepted' | 'rejected' | 'inconclusive' | 'not run';
  writes: WriteRecord[];
};

/** A non-BMP character: one code point, two UTF-16 code units, four UTF-8 bytes. */
const ASTRAL = '\u{1F600}';
/** One code point and one code unit, two UTF-8 bytes. */
const TWO_BYTE = 'é';
/** One code point and one code unit, three UTF-8 bytes. */
const THREE_BYTE = 'あ';

export function counts(text: string): Record<Unit, number> {
  return {
    'code points': [...text].length,
    'code units': text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

export const asciiBody = (length: number): string => 'a'.repeat(length);

/** L ASCII code units in which every other one is a line feed. */
export const lineBreakBody = (length: number): string =>
  'a\n'.repeat(Math.floor(length / 2)) + 'a'.repeat(length % 2);

/** The bodies that tell the units apart once L is known (A2 table, after the ASCII pair). */
export function unitBodies(limit: number): { name: BodyName; text: string }[] {
  const half = Math.floor(limit / 2);
  return [
    { name: 'astral', text: ASTRAL.repeat(half) },
    { name: 'astralPlusOne', text: ASTRAL.repeat(half + 1) },
    { name: 'twoByte', text: TWO_BYTE.repeat(limit) },
    { name: 'threeByte', text: THREE_BYTE.repeat(limit) },
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The too-long message of a 422 whose errors list names the body, if it has one. */
function tooLongMessage(data: unknown): string | undefined {
  const errors = isRecord(data) && Array.isArray(data.errors) ? data.errors : [];
  for (const error of errors) {
    if (!isRecord(error) || error.field !== 'body' || typeof error.message !== 'string') continue;
    if (/too long/i.test(error.message)) return error.message;
  }
  return undefined;
}

/**
 * Accepted only on the status the reviewer expects with the body returned unchanged, as
 * src/comments.ts checks its own writes; rejected only on a 422 with a too-long body error.
 * Anything else is inconclusive and never counts as a rejection.
 */
export function classifyWrite(kind: WriteKind, sent: string, answer: WriteAnswer): WriteResult {
  if ('error' in answer) return { outcome: 'inconclusive', reason: `no answer: ${answer.error}` };
  const { status, data } = answer;
  const expected = kind === 'create' ? HTTP_STATUS.created : HTTP_STATUS.ok;
  if (status === expected) {
    return isRecord(data) && data.body === sent
      ? { outcome: 'accepted', status }
      : { outcome: 'inconclusive', status, reason: 'the returned body differs from the one sent' };
  }
  if (status === HTTP_STATUS.unprocessableContent) {
    const message = tooLongMessage(data);
    if (message !== undefined) return { outcome: 'rejected', status, message };
    return { outcome: 'inconclusive', status, reason: 'a 422 that is not a too-long body error' };
  }
  return { outcome: 'inconclusive', status, reason: `unexpected status ${status}` };
}

/** The maximum a too-long message states, such as "maximum is N characters". */
export function statedMaximum(message: string | undefined): number | undefined {
  const digits = message === undefined ? undefined : /maximum is (\d+)/i.exec(message)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

type Outcome = 'accepted' | 'rejected';

/** The one unit whose count, compared with L, predicts every outcome; else inconclusive. */
export function classifyUnit(
  limit: number,
  outcomes: readonly { text: string; outcome: Outcome }[],
): Unit | 'inconclusive' {
  const fits = UNITS.filter((unit) =>
    outcomes.every(
      ({ text, outcome }) => (counts(text)[unit] > limit ? 'rejected' : 'accepted') === outcome,
    ),
  );
  return fits.length === 1 ? (fits[0] ?? 'inconclusive') : 'inconclusive';
}

export type Writer = (kind: WriteKind, text: string) => Promise<WriteResult>;

/**
 * L by the bounded search: one body expected to be rejected, then M and M + 1 when the
 * rejection states M, else halving between an empty body (never sent) and the first body.
 */
export async function findLimit(
  firstLength: number,
  write: Writer,
): Promise<{ limit?: number; reason?: string }> {
  const first = await write('create', asciiBody(firstLength));
  if (first.outcome === 'inconclusive') return { reason: first.reason };
  if (first.outcome === 'accepted') return { reason: 'the first body was accepted' };
  let accepted = 0;
  let rejected = firstLength;
  const stated = statedMaximum(first.message);
  if (stated !== undefined && stated > 0 && stated < firstLength) {
    for (const length of [stated, stated + 1]) {
      const result = await write('create', asciiBody(length));
      if (result.outcome === 'inconclusive') return { reason: result.reason };
      if (result.outcome === 'accepted') accepted = Math.max(accepted, length);
      else rejected = Math.min(rejected, length);
      if (result.outcome === 'rejected') break;
    }
  }
  while (rejected - accepted > 1) {
    const middle = accepted + Math.floor((rejected - accepted) / 2);
    const result = await write('create', asciiBody(middle));
    if (result.outcome === 'inconclusive') return { reason: result.reason };
    if (result.outcome === 'accepted') accepted = middle;
    else rejected = middle;
  }
  return accepted > 0 ? { limit: accepted } : { reason: 'no body was accepted' };
}

/** Runs the whole probe against one writer: L, the unit bodies, the update pair, line breaks. */
export async function runProbe(io: { firstLength: number; write: Writer }): Promise<ProbeOutcome> {
  const writes: WriteRecord[] = [];
  const write =
    (body: BodyName): Writer =>
    async (kind, text) => {
      const result = await io.write(kind, text);
      writes.push({
        kind,
        body,
        codeUnits: text.length,
        status: result.status ?? null,
        outcome: result.outcome,
      });
      return result;
    };
  const stop = (reason: string, partial: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
    unit: 'inconclusive',
    reason,
    update: 'not run',
    lineBreaks: 'not run',
    ...partial,
    writes,
  });

  const found = await findLimit(io.firstLength, write('ascii'));
  if (found.limit === undefined) return stop(found.reason ?? 'no limit found');
  const limit = found.limit;

  const seen: { text: string; outcome: Outcome }[] = [
    { text: asciiBody(limit), outcome: 'accepted' },
    { text: asciiBody(limit + 1), outcome: 'rejected' },
  ];
  for (const { name, text } of unitBodies(limit)) {
    const result = await write(name)('create', text);
    if (result.outcome === 'inconclusive') return stop(result.reason, { limit });
    seen.push({ text, outcome: result.outcome });
  }
  const unit = classifyUnit(limit, seen);

  const atLimit = await write('ascii')('update', asciiBody(limit));
  if (atLimit.outcome === 'inconclusive')
    return stop(atLimit.reason, { limit, update: 'inconclusive' });
  const pastLimit = await write('ascii')('update', asciiBody(limit + 1));
  if (pastLimit.outcome === 'inconclusive')
    return stop(pastLimit.reason, { limit, update: 'inconclusive' });
  const update =
    atLimit.outcome === 'accepted' && pastLimit.outcome === 'rejected' ? 'agrees' : 'differs';

  const breaks = await write('lineBreaks')('create', lineBreakBody(limit));
  if (breaks.outcome === 'inconclusive')
    return stop(breaks.reason, { limit, update, lineBreaks: 'inconclusive' });

  return {
    unit,
    ...(unit === 'inconclusive' ? { reason: 'the outcomes fit no single unit' } : {}),
    limit,
    update,
    lineBreaks: breaks.outcome,
    writes,
  };
}

/** Spec A3: the comment limit may be raised only in this case; every other result stops. */
export function raiseAllowed(outcome: ProbeOutcome): boolean {
  return (
    (outcome.unit === 'code units' || outcome.unit === 'code points') &&
    outcome.update === 'agrees' &&
    outcome.lineBreaks === 'accepted'
  );
}
