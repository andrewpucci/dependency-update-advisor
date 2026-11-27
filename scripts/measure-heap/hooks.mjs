// Module hooks for the heap probe (see run.ts). Inside this repository a `./x.js` import resolves
// to `./x.ts` when that file exists, as the TypeScript sources are written. HEAP_LIMIT_OVERRIDES
// (`id=value,...`) rewrites written register values in src/limits.ts as it loads, so a packet
// larger than a count cap can be measured; derived entries cannot be overridden.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url).href;
const LIMITS = new URL('src/limits.ts', ROOT).href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(ROOT)) {
    const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}

function override(source, pair) {
  const [id, value] = pair.split('=');
  const quoted = id.replace(/\./g, '\\.');
  for (const pattern of [
    new RegExp(`(id: '${quoted}',\\s*value: )[0-9_]+`),
    new RegExp(`(unjustified\\(\\s*'${quoted}',\\s*)[0-9_]+`),
  ])
    if (pattern.test(source)) return source.replace(pattern, `$1${value}`);
  throw new Error(`HEAP_LIMIT_OVERRIDES: no written value for ${id}`);
}

export async function load(url, context, next) {
  const result = await next(url, context);
  const overrides = process.env.HEAP_LIMIT_OVERRIDES;
  if (!overrides || url !== LIMITS) return result;
  return { ...result, source: overrides.split(',').reduce(override, String(result.source)) };
}
