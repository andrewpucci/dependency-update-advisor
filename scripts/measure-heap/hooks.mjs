// Module hooks for the heap probe (see run.ts). Inside this repository a `./x.js` import resolves
// to `./x.ts` when that file exists, as the TypeScript sources are written. HEAP_LIMIT_OVERRIDES
// (`id=value,...`) rewrites register values in src/limits.ts as it loads, so a packet larger than
// a count cap can be measured: a written value in place, and a derived entry by fixing its formula
// at the value before the register is built, so the entries derived from it follow.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url).href;
const LIMITS = new URL('src/limits.ts', ROOT).href;
/** The line that builds the register; a derived override rewrites it. */
const REGISTER_LINE = 'export const REGISTER = buildRegister(DEFINITIONS);';

export async function resolve(specifier, context, next) {
  if (
    specifier.startsWith('.') &&
    specifier.endsWith('.js') &&
    context.parentURL?.startsWith(ROOT)
  ) {
    const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}

/** Whether `id` is a derived entry: the derived() helper, or an object whose own basis is derived. */
function isDerived(source, quoted) {
  if (new RegExp(`derived\\(\\s*'${quoted}',`).test(source)) return true;
  // An object entry runs from its id to the next entry, which opens at two spaces of indent.
  const entry = new RegExp(`id: '${quoted}',((?:(?!\\n  [{a-zA-Z])[^])*)`).exec(source);
  return entry !== null && entry[1].includes("kind: 'derived'");
}

function override({ source, derived }, pair) {
  const [id, value] = pair.split('=');
  const quoted = id.replace(/\./g, '\\.');
  for (const pattern of [
    new RegExp(`(id: '${quoted}',\\s*value: )[0-9_]+`),
    new RegExp(`(unjustified\\(\\s*'${quoted}',\\s*)[0-9_]+`),
  ])
    if (pattern.test(source)) return { source: source.replace(pattern, `$1${value}`), derived };
  if (isDerived(source, quoted)) return { source, derived: { ...derived, [id]: Number(value) } };
  throw new Error(`HEAP_LIMIT_OVERRIDES: no entry ${id}`);
}

/** The source with the register built from definitions whose overridden derived entries are fixed. */
function withDerived(source, derived) {
  if (Object.keys(derived).length === 0) return source;
  if (!source.includes(REGISTER_LINE))
    throw new Error('HEAP_LIMIT_OVERRIDES: the register line moved; update hooks.mjs');
  return source.replace(
    REGISTER_LINE,
    `const OVERRIDDEN: Record<string, number> = ${JSON.stringify(derived)};
export const REGISTER = buildRegister(
  DEFINITIONS.map((entry) =>
    entry.id in OVERRIDDEN && entry.basis.kind === 'derived'
      ? { ...entry, basis: { ...entry.basis, inputs: [], formula: () => OVERRIDDEN[entry.id] } }
      : entry,
  ) as typeof DEFINITIONS,
);`,
  );
}

export async function load(url, context, next) {
  const result = await next(url, context);
  const overrides = process.env.HEAP_LIMIT_OVERRIDES;
  if (!overrides || url !== LIMITS) return result;
  const { source, derived } = overrides
    .split(',')
    .reduce(override, { source: String(result.source), derived: {} });
  return { ...result, source: withDerived(source, derived) };
}
