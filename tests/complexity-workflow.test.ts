import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vite-plus/test';

const workflow = readFileSync(
  new URL('../.github/workflows/complexity.yml', import.meta.url),
  'utf8',
);
const script = workflow.split('          script: |\n')[1]?.replace(/^ {12}/gm, '');
const marker = '<!-- complexity-report -->';
type Comment = { id: number; user: { login: string }; body: string };

async function publish(comments: Comment[], sha = 'current', body = `${marker}\nReport`) {
  const writes: Array<{ operation: string; comment_id?: number; body: string }> = [];
  await runInNewContext(`(async () => {${script}})()`, {
    process: { env: { REPORT_JSON: JSON.stringify(body) } },
    context: {
      repo: { owner: 'example', repo: 'public' },
      issue: { number: 1 },
      payload: { pull_request: { head: { sha: 'current' } } },
    },
    core: { info() {} },
    github: {
      paginate: async () => comments,
      rest: {
        pulls: { get: async () => ({ data: { state: 'open', head: { sha } } }) },
        issues: {
          listComments() {},
          updateComment: async (args: { comment_id: number; body: string }) => {
            writes.push({ operation: 'update', ...args });
          },
          createComment: async (args: { body: string }) => {
            writes.push({ operation: 'create', ...args });
          },
        },
      },
    },
  });
  return writes;
}

test('creates its own comment rather than overwriting a user-supplied marker', async () => {
  const writes = await publish([{ id: 1, user: { login: 'contributor' }, body: marker }]);
  expect(writes.map(({ operation }) => operation)).toEqual(['create']);
});

test('updates the existing bot-owned comment', async () => {
  const writes = await publish([{ id: 2, user: { login: 'github-actions[bot]' }, body: marker }]);
  expect(writes[0]?.operation).toBe('update');
  expect(writes[0]?.comment_id).toBe(2);
});

test('does not publish a report for an outdated head', async () => {
  expect(await publish([], 'new-head')).toEqual([]);
});

test('rejects invalid or oversized report data', async () => {
  await expect(publish([], 'current', 'missing marker')).rejects.toThrow(
    'Invalid complexity report',
  );
  await expect(publish([], 'current', marker + 'x'.repeat(60000))).rejects.toThrow(
    'Invalid complexity report',
  );
});
