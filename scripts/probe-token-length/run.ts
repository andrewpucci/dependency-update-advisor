/**
 * The token-length probe's runner. It grounds `limit:analysis.maxTokenEscapedBytes` from a
 * Mistral tokenizer file downloaded at a pinned commit, for example:
 *
 *   curl -L -o tekken.json \
 *     https://huggingface.co/mistralai/<model>/resolve/<commit sha>/tekken.json
 *   npm run probe:token-length -- tekken.json
 *
 * It prints one JSON summary per file: the longest token in raw bytes, decoded UTF-16 code
 * units, JSON-escaped bytes, and bytes with every non-ASCII code unit escaped. All logic is in
 * core.ts; this file only reads the files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Core from './core.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Loaded by path, not by a static import, so Node can run this file directly (see check.ts).
const { summarize } = (await import(
  pathToFileURL(join(ROOT, 'scripts/probe-token-length/core.ts')).href
)) as typeof Core;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: npm run probe:token-length -- <tekken.json> [<tekken.json> ...]');
  process.exit(1);
}
for (const file of files)
  console.log(
    JSON.stringify({ file, ...summarize(JSON.parse(readFileSync(file, 'utf8')) as unknown) }),
  );
