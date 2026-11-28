/**
 * Fixed facts of the formats the reviewer reads and writes: protocol codes, character ranges,
 * field layouts, and unit conversions. Nobody chooses these values, so they are not limits and
 * live outside the limit register; the magic-number lint exempts this file for that reason.
 */

/** HTTP status codes and class boundaries (RFC 9110). */
export const HTTP_STATUS = Object.freeze({
  min: 100,
  ok: 200,
  successMin: 200,
  created: 201,
  successMax: 299,
  redirectMin: 300,
  clientErrorMin: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  uriTooLong: 414,
  unprocessableContent: 422,
  tooManyRequests: 429,
  serverErrorMin: 500,
  max: 599,
});

/** UTF-16 code units with fixed meaning: line breaks, control ranges, and surrogates. */
export const CHAR_CODE = Object.freeze({
  tab: 9,
  lineFeed: 10,
  carriageReturn: 13,
  /** Code units below this are C0 controls. */
  firstPrintable: 32,
  delete: 127,
  /** 127 through this are DEL and the C1 controls. */
  lastC1Control: 159,
  surrogateFirst: 0xd800,
  highSurrogateLast: 0xdbff,
  surrogateLast: 0xdfff,
});

/** A full git object id in hexadecimal. */
export const GIT_SHA_HEX_LENGTH = 40;

/**
 * GitHub autolinks a run of 7 or more hex digits as a commit, so rendered text breaks such runs
 * after this many characters.
 */
export const AUTOLINK_SAFE_HEX_PREFIX = 6;

/** Digest sizes in bytes for the Subresource Integrity algorithms npm lockfiles use. */
export const DIGEST_BYTES = Object.freeze({ sha1: 20, sha256: 32, sha384: 48, sha512: 64 });

/** Base64 encodes every 3 bytes as 4 characters. */
export const BASE64 = Object.freeze({ chars: 4, bytes: 3 });

/** Field positions and maxima of an ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SS...`). */
export const ISO_DATE_TIME = Object.freeze({
  year: Object.freeze([0, 4] as const),
  month: Object.freeze([5, 7] as const),
  day: Object.freeze([8, 10] as const),
  hour: Object.freeze([11, 13] as const),
  minute: Object.freeze([14, 16] as const),
  second: Object.freeze([17, 19] as const),
  maxMonth: 12,
  maxHour: 23,
  maxMinute: 59,
  maxSecond: 59,
  /** Fractional seconds are padded to milliseconds. */
  millisecondDigits: 3,
});

export const MS_PER_DAY = 86_400_000;

/** Binary byte units, as specs write sizes (`16 KiB`, `1.5 MiB`). */
export const BINARY_BYTES = Object.freeze({ KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 });

/** Durations in milliseconds, as specs write timeouts (`240 seconds`, `15 minutes`). */
export const DURATION_MS = Object.freeze({ second: 1000, minute: 60_000, hour: 3_600_000 });

/** The largest delay `setTimeout` accepts: a signed 32-bit integer. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** File modes for the private snapshot workspace. */
export const FILE_MODE = Object.freeze({
  privateDirectory: 0o700,
  privateFile: 0o600,
  privateExecutable: 0o700,
});

/** Radix of the short aliases analysis gives each unit. */
export const ALIAS_RADIX = 36;

/** Decimal notation's base, for exact arithmetic on decimal parameters written in base ten. */
export const DECIMAL_RADIX = 10;

/** A JSON `\uXXXX` escape is six bytes, the most one UTF-16 code unit can expand to. */
export const JSON_ESCAPE_BYTES = 6;

/** Lockfile and config format versions the readers support. */
export const FORMAT_VERSION = Object.freeze({
  npmLockfile: 3,
  uvLockRevisions: Object.freeze([3, 5] as const),
  dependabotConfig: 2,
});

/** The review identity tuple: five positive ids, then the head SHA last. */
export const REVIEW_IDENTITY = Object.freeze({ length: 6, shaIndex: 5 });

/** Process exit codes the action reports to the runner. */
export const EXIT_CODE = Object.freeze({ notWired: 78, selfCheck: 79, heap: 80 });
