import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import { parseDocument } from 'yaml';

import { parseDependabotRoots } from '../../src/dependabot-roots.js';

const dependabotPath = new URL('../../.github/dependabot.yml', import.meta.url);

test('R1 retains the approved Dependabot schedules and npm root', () => {
  const source = readFileSync(dependabotPath, 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });

  expect(document.errors).toEqual([]);
  const config = document.toJS() as { updates: Array<Record<string, unknown>> };
  expect(
    config.updates.map(({ 'package-ecosystem': ecosystem, directory, schedule }) => ({
      'package-ecosystem': ecosystem,
      directory,
      schedule,
    })),
  ).toEqual([
    {
      'package-ecosystem': 'npm',
      directory: '/',
      schedule: {
        interval: 'weekly',
        day: 'tuesday',
        time: '09:00',
        timezone: 'America/Los_Angeles',
      },
    },
    {
      'package-ecosystem': 'github-actions',
      directory: '/',
      schedule: {
        interval: 'weekly',
        day: 'tuesday',
        time: '09:00',
        timezone: 'America/Los_Angeles',
      },
    },
  ]);
  expect(parseDependabotRoots(new TextEncoder().encode(source))).toEqual({
    kind: 'roots',
    npm: { kind: 'roots', roots: ['.'] },
    uv: { kind: 'roots', roots: [] },
  });
});
