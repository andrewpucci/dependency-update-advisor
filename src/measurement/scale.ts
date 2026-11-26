import type { Limit, LimitDefinition } from '../limits.js';

const SCALED_RESEARCH = new Set(['research.maxAttempts', 'research.maxRetainedBytes']);

/**
 * The hand-set read budget a demand measurement lifts: every evidence share and envelope value,
 * the research attempt cap, and the research retained-byte cap. The retained-byte cap is a memory
 * guard awaiting measurement (#431), so a run shows retained demand while production keeps the
 * register value. Derived entries are left for `buildRegister` to recompute, so totals and copies
 * of these values scale with them.
 */
export function isReadBudget(entry: Limit): boolean {
  if (entry.basis.kind === 'derived') return false;
  return entry.id.startsWith('evidence.') || SCALED_RESEARCH.has(entry.id);
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
    return { ...entry, value: isReadBudget({ ...entry, value }) ? value * factor : value };
  });
}
