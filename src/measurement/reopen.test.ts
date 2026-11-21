import { expect, test } from 'vite-plus/test';
import { reopenPullRequest } from './reopen.js';

const pull = {
  number: 171,
  state: 'closed',
  merged: true,
  head: { sha: 'abc' },
  base: { ref: 'main' },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'content-length': '999' },
  });

test('a closed pull request read comes back open and unmerged, other fields unchanged', async () => {
  for (const url of [
    'https://api.github.com/repos/o/r/pulls/171',
    'https://api.github.com/repositories/42/pulls/171',
  ]) {
    const shim = reopenPullRequest(async () => json(pull), 171);
    const response = await shim.fetch(url, {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.json()).toEqual({ ...pull, state: 'open', merged: false });
    expect(shim.rewrites()).toBe(1);
  }
});

test('leaves other reads untouched', async () => {
  for (const url of [
    'https://api.github.com/repos/o/r/pulls/171/files',
    'https://api.github.com/repos/o/r/pulls/1710',
    'https://api.github.com/repos/o/r/pulls/17',
    'https://api.github.com/repos/o/r/issues/171',
  ]) {
    const original = json(pull);
    const shim = reopenPullRequest(async () => original, 171);
    expect(await shim.fetch(url, {}), url).toBe(original);
    expect(shim.rewrites(), url).toBe(0);
  }
});

test('passes through an open pull request, an error status, and a body that is not JSON', async () => {
  const cases = [
    json({ ...pull, state: 'open', merged: false }),
    json(pull, 404),
    new Response('<html>'),
  ];
  for (const original of cases) {
    const shim = reopenPullRequest(async () => original, 171);
    expect(await shim.fetch('https://api.github.com/repos/o/r/pulls/171', {})).toBe(original);
    expect(shim.rewrites()).toBe(0);
  }
});
