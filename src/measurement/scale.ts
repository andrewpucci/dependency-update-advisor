import type { Limit, LimitDefinition } from '../limits.js';

const SCALED_RESEARCH = new Set([
  'research.maxAttempts',
  'research.maxJsonEntries',
  'research.maxRetainedBytes',
]);
/** Scaled-share bases and rates, so a share lifts with its ceiling and the run sees uncut demand. */
const SHARE_PREFIXES = ['research.share.', 'collection.share.'];

/**
 * The hand-set read budget a demand measurement lifts: every evidence share and envelope value,
 * every scaled-share base and rate, the research attempt cap, the research JSON entry cap, and the
 * research retained-byte cap. The retained-byte cap is a memory guard awaiting measurement (#431),
 * and the entry cap stopped upstream on every real uv change measured for #462 (approved by the
 * maintainer on 2026-11-27), so a run shows that demand while production keeps the register value. Derived entries are left for `buildRegister`
 * to recompute, so totals and copies of these values scale with them.
 */
export function isReadBudget(entry: Limit): boolean {
  if (entry.basis.kind === 'derived') return false;
  return (
    entry.id.startsWith('evidence.') ||
    SHARE_PREFIXES.some((prefix) => entry.id.startsWith(prefix)) ||
    SCALED_RESEARCH.has(entry.id)
  );
}

/**
 * `value × factor` on the value's decimal digits, so a rate such as 0.1 × 3 is 0.3 rather than
 * 0.30000000000000004. A value written in exponent form is multiplied directly.
 */
function times(value: number, factor: number): number {
  const written = String(value);
  if (!/^\d+(?:\.\d+)?$/u.test(written)) return value * factor;
  const [whole, fraction = ''] = written.split('.');
  return Number(`${BigInt(whole + fraction) * BigInt(factor)}e-${fraction.length}`);
}

/**
 * The register's definitions with the read budget multiplied by `factor`, ready for
 * `buildRegister`. Measuring at a factor large enough that no stage stops on budget shows the
 * demand the current shares cut off.
 */
export function scaledDefinitions(
  register: ReadonlyMap<string, Limit>,
  factor: number,
): LimitDefinition[] {
  if (!Number.isSafeInteger(factor) || factor < 1)
    throw new Error(`measurement scale must be a positive integer, got ${factor}`);
  return [...register.values()].map(({ value, ...entry }) => {
    // A built register carries each derived entry's resolved value; a definition must not.
    if (entry.basis.kind === 'derived') return entry;
    return { ...entry, value: isReadBudget({ ...entry, value }) ? times(value, factor) : value };
  });
}
