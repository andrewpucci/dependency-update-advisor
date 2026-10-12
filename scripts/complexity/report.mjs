import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const threshold = 15;
const run = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const git = (...args) => run(...args).trim();

export function measure(source, path) {
  const root = mkdtempSync(join(tmpdir(), 'complexity-measure-'));
  try {
    const input = join(root, path.endsWith('.mjs') ? 'source.mjs' : 'source.ts');
    const output = join(root, 'scores.json');
    writeFileSync(input, source);
    const cli = fileURLToPath(new URL('../../node_modules/vite-plus/bin/vp', import.meta.url));
    const config = fileURLToPath(new URL('./vite.config.mjs', import.meta.url));
    execFileSync(
      process.execPath,
      [cli, 'lint', '-c', config, '--no-ignore', '--format', 'json', input],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        encoding: 'utf8',
        env: { ...process.env, COMPLEXITY_OUTPUT: output },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return JSON.parse(readFileSync(output, 'utf8')).map((fn) => ({ path, ...fn }));
  } catch (error) {
    throw new Error(
      `Analysis failed for ${path}: ${error.stdout || error.stderr || error.message}`,
      { cause: error },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function groups(functions) {
  const result = new Map();
  for (const fn of functions) {
    const key = JSON.stringify([fn.path, fn.name]);
    const group = result.get(key) ?? [];
    group.push(fn);
    result.set(key, group);
  }
  for (const group of result.values()) group.sort((a, b) => b.score - a.score);
  return result;
}

export function regressions(head, base) {
  const previous = groups(base);
  return [...groups(head)]
    .flatMap(([key, group]) =>
      group.flatMap((fn, rank) => {
        const before = previous.get(key)?.[rank]?.score ?? null;
        return fn.score > threshold && (before === null || fn.score > before)
          ? [{ ...fn, before }]
          : [];
      }),
    )
    .sort((a, b) => b.score - a.score);
}

const cell = (value) =>
  String(value)
    .slice(0, 160)
    .replace(/[&<>|`\r\n]/g, (char) => `&#${char.charCodeAt(0)};`)
    .slice(0, 200)
    .replace(/&[^;]*$/, '');

export function render(head, base, headSha, baseSha) {
  const scores = head.map((fn) => fn.score);
  const mean = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  const changes = regressions(head, base);
  const lines = [
    '<!-- complexity-report -->',
    '### 🐙 Cognitive complexity',
    '',
    `Reviewed \`${headSha}\` against merge base \`${baseSha}\`.`,
    '',
    `**${scores.length} functions**, max **${Math.max(0, ...scores)}**, mean **${mean.toFixed(2)}**; **${scores.filter((score) => score > threshold).length}** over the advisory threshold of ${threshold}.`,
    '',
  ];
  if (changes.length) {
    lines.push(
      `⚠️ **${changes.length} new or worsened functions above ${threshold}:**`,
      '',
      '| Function | File | Now | Base |',
      '| --- | --- | ---: | ---: |',
    );
    for (const fn of changes.slice(0, 100)) {
      lines.push(
        `| <code>${cell(fn.name)}</code> | <code>${cell(fn.path)}:${fn.line}</code> | ${fn.score} | ${fn.before ?? 'new'} |`,
      );
    }
    if (changes.length > 100)
      lines.push('', `Showing the first 100 of ${changes.length} findings.`);
    lines.push('', 'Advisory: simplify where practical; these findings do not block merging.');
  } else {
    lines.push(`✅ No functions regressed past ${threshold} versus the base.`);
  }
  lines.push(
    '',
    'Scope: tracked source and scripts; tests and declarations excluded. Names and paths are matched by score rank; moves and renames count as new.',
  );
  return `${lines.join('\n')}\n`;
}

// Unchanged blobs are shared by both revisions; measure each one once.
const measured = new Map();

function inventory(revision) {
  return run('ls-tree', '-r', '-z', revision, '--', 'src', 'scripts')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { oid: entry.slice(0, tab).split(' ')[2], path: entry.slice(tab + 1) };
    })
    .filter(({ path }) => /\.(ts|mjs)$/.test(path) && !/\.(test|d)\.(ts|mjs)$/.test(path))
    .flatMap(({ oid, path }) => {
      const key = `${oid}:${path}`;
      if (!measured.has(key)) measured.set(key, measure(run('cat-file', 'blob', oid), path));
      return measured.get(key);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'origin/main' },
      'github-output': { type: 'boolean', default: false },
    },
  });
  const headSha = git('rev-parse', '--verify', 'HEAD^{commit}');
  const baseSha = git(
    'merge-base',
    headSha,
    git('rev-parse', '--verify', `${values.base}^{commit}`),
  );
  const report = render(inventory(headSha), inventory(baseSha), headSha, baseSha);
  process.stdout.write(report);
  if (values['github-output'])
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\n`);
}
