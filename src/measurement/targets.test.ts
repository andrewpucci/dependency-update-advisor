import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import { upstreamGithubUrl } from '../evidence/upstream-read.js';
import { createAdvisoryReader } from '../evidence/advisory-read.js';
import * as advisories from '../evidence/advisories.js';
import { collectAdvisoryNpm, syntheticAdvisory } from '../../tests/parity/advisories.js';
import {
  addTargetSides,
  parseTagCandidate,
  recordReads,
  type ReaderRead,
  type Side,
  type TargetSides,
  parseVersionedQuery,
  settledTarget,
  settledTargets,
  tagCandidates,
} from './targets.js';

// The reader's query shape. `githubUrl` in advisory-read.ts is private, so the recorded name-form
// fixtures below pin this copy to URLs the reader really sent.
function advisoryUrl(ecosystem: string, affects: readonly string[], type: string, perPage = '100') {
  const url = new URL('https://api.github.com/advisories');
  url.search = new URLSearchParams({
    ecosystem,
    affects: affects.join(','),
    type,
    per_page: perPage,
  }).toString();
  return url.href;
}

const fixtureUrl = (name: string): string =>
  JSON.parse(
    readFileSync(new URL(`../evidence/fixtures/name-forms/${name}.json`, import.meta.url), 'utf8'),
  ).request.url;

const tagUrl = (repository: string, tag: string) =>
  upstreamGithubUrl({ kind: 'github', repository, resource: 'ref', ref: 'tags/' + tag });

test('the copied query shape matches URLs the reader sent', () => {
  expect(advisoryUrl('actions', ['tj-actions/changed-files@45.0.7'], 'reviewed')).toBe(
    fixtureUrl('github-tj-actions-versioned'),
  );
  expect(advisoryUrl('pip', ['flo-pro-adk@1.0.0'], 'malware')).toBe(
    fixtureUrl('github-flo-pro-adk-malware-versioned'),
  );
  expect(advisoryUrl('actions', ['TJ-Actions/Changed-Files'], 'reviewed', '50')).toBe(
    fixtureUrl('github-tj-actions-discovery'),
  );
});

test('round-trips npm targets, including scoped names, with their type', () => {
  for (const [name, version] of [
    ['lodash', '4.17.20'],
    ['@babel/traverse', '7.22.0'],
  ])
    for (const type of ['reviewed', 'malware'])
      expect(
        settledTarget(
          advisoryUrl('npm', [`${name}@${version}`], type),
          { ecosystem: 'npm', name, version },
          'head',
          true,
        ),
      ).toEqual({ ecosystem: 'npm', name, version, type, side: 'head', complete: true });
});

test('names a target as the reader looked it up, not as GitHub stores it', () => {
  // The recorded versioned query for TJ-Actions/Changed-Files lists GitHub's lowercase form.
  expect(
    settledTarget(
      fixtureUrl('github-tj-actions-versioned'),
      { ecosystem: 'actions', name: 'TJ-Actions/Changed-Files', version: '45.0.7' },
      'base',
      true,
    ),
  ).toEqual({
    ecosystem: 'actions',
    name: 'TJ-Actions/Changed-Files',
    version: '45.0.7',
    type: 'reviewed',
    side: 'base',
    complete: true,
  });
  // One stored pip form that differs in case and separators still names the normalized target.
  expect(
    settledTarget(
      advisoryUrl('pip', ['Flo_Pro.adk@1.0.0'], 'malware'),
      { ecosystem: 'pip', name: 'flo-pro-adk', version: '1.0.0' },
      'head',
      true,
    ),
  ).toEqual({
    ecosystem: 'pip',
    name: 'flo-pro-adk',
    version: '1.0.0',
    type: 'malware',
    side: 'head',
    complete: true,
  });
  // Several stored forms of one target.
  expect(
    settledTarget(
      advisoryUrl('actions', ['Owner/Action@v1', 'owner/action@v1'], 'malware'),
      { ecosystem: 'actions', name: 'OWNER/action', version: 'v1' },
      'head',
      true,
    )?.name,
  ).toBe('OWNER/action');
});

test('a versioned query for another target settles nothing', () => {
  const pip = { ecosystem: 'pip', name: 'flo-pro-adk', version: '1.0.0' };
  for (const [url, target] of [
    [advisoryUrl('pip', ['flo-pro-adk@1.0.0', 'other@1.0.0'], 'malware'), pip],
    [advisoryUrl('pip', ['flo-pro-adk@1.0.0'], 'malware'), { ...pip, version: '2.0.0' }],
    [advisoryUrl('pip', ['flo-pro-adk@1.0.0'], 'malware'), { ...pip, ecosystem: 'npm' }],
    [
      advisoryUrl('npm', ['Lodash@1.0.0'], 'reviewed'),
      { ...pip, ecosystem: 'npm', name: 'lodash' },
    ],
  ] as const)
    expect(settledTarget(url, target, 'head', true), url).toBeNull();
});

test('a discovery query or an OSV query is not a versioned query', () => {
  for (const url of [
    fixtureUrl('github-tj-actions-discovery'),
    advisoryUrl('pip', ['flo-pro-adk', 'flo_pro_adk', 'flo.pro.adk'], 'malware', '50'),
    advisoryUrl('npm', ['@babel/traverse'], 'reviewed', '50'),
    'https://api.osv.dev/v1/query',
  ])
    expect(parseVersionedQuery(url), url).toBeNull();
});

test('rejects URLs that are not one versioned query', () => {
  for (const url of [
    advisoryUrl('npm', ['lodash@4.17.20', 'left-pad@4.17.20'], 'reviewed'),
    advisoryUrl('npm', ['lodash@4.17.20', 'left-pad@1.3.0'], 'reviewed'),
    advisoryUrl('pip', ['flo-pro-adk@1.0.0', 'flo_pro_adk@2.0.0'], 'malware'),
    advisoryUrl('rubygems', ['rails@7.0.0'], 'reviewed'),
    advisoryUrl('npm', ['lodash@4.17.20'], 'unreviewed'),
    advisoryUrl('npm', ['lodash@'], 'reviewed'),
    'https://example.com/advisories?ecosystem=npm&affects=lodash%404.17.20&type=reviewed',
    'not a url',
  ])
    expect(parseVersionedQuery(url), url).toBeNull();
});

test('round-trips tag candidates with `@` and `/` in the tag, decoding each segment once', () => {
  for (const tag of ['v1.2.3', 'release/@scope/pkg@1.0.0', 'v1%40beta', 'a/b/c'])
    expect(parseTagCandidate(tagUrl('owner/repo', tag)), tag).toEqual({
      repository: 'owner/repo',
      tag,
    });
});

test('ignores refs that are not tags and other upstream requests', () => {
  for (const url of [
    'https://api.github.com/repos/owner/repo/git/ref/heads/main',
    'https://api.github.com/repos/owner/repo/git/tags/0123456789abcdef',
    'https://api.github.com/repos/owner/repo/releases/tags/v1',
    'https://api.github.com/repos/owner/repo/git/ref/tags/v1?x=1',
    'https://example.com/repos/owner/repo/git/ref/tags/v1',
  ])
    expect(parseTagCandidate(url), url).toBeNull();
});

const lodashTarget = { ecosystem: 'npm', name: 'lodash', version: '4.17.20' };
const sidesOf = (entries: [string, Side[]][]): TargetSides =>
  new Map(entries.map(([key, sides]) => [key, new Set(sides)]));
const lodashSides = (type: string, sides: Side[]) =>
  sidesOf([[JSON.stringify([type, 'npm', 'lodash', '4.17.20']), sides]]);

test('a versioned read yields its one target once per side, and only when requested', () => {
  const lodash = advisoryUrl('npm', ['lodash@4.17.20'], 'reviewed');
  const unrequested = advisoryUrl('npm', ['lodash@4.17.20'], 'malware');
  const osv = 'https://api.osv.dev/v1/query';
  const requested = new Set([lodash, osv]);
  const read = (url: string, type: 'reviewed' | 'malware' = 'reviewed') => ({
    type,
    url,
    target: lodashTarget,
    complete: true,
  });
  const sides = new Map([
    ...lodashSides('reviewed', ['head', 'base']),
    ...lodashSides('malware', ['head']),
  ]);
  expect(
    settledTargets(
      [read(lodash), read(lodash), read(unrequested, 'malware'), read(osv)],
      sides,
      requested,
    ),
  ).toEqual([
    { ...lodashTarget, type: 'reviewed', side: 'base', complete: true },
    { ...lodashTarget, type: 'reviewed', side: 'head', complete: true },
  ]);
  // A read for a target no member resolved to, or of the other type, has no side.
  expect(settledTargets([read(lodash)], lodashSides('malware', ['head']), requested)).toEqual([]);
});

test('keeps a target whose read failed, marked incomplete on every side it was read for', () => {
  const lodash = advisoryUrl('npm', ['lodash@4.17.20'], 'reviewed');
  const read = (complete: boolean) => ({
    type: 'reviewed' as const,
    url: lodash,
    target: lodashTarget,
    complete,
  });
  const target = { ...lodashTarget, type: 'reviewed' };
  const sides = lodashSides('reviewed', ['head', 'base']);
  expect(settledTargets([read(false), read(true)], sides, new Set([lodash]))).toEqual([
    { ...target, side: 'base', complete: false },
    { ...target, side: 'head', complete: false },
  ]);
  expect(settledTargets([read(true), read(false)], sides, new Set([lodash]))).toEqual([
    { ...target, side: 'base', complete: false },
    { ...target, side: 'head', complete: false },
  ]);
});

test('records each distinct candidate and status the run requested', () => {
  const v1 = tagUrl('owner/repo', 'v1');
  const v2 = tagUrl('owner/repo', 'v2');
  expect(
    tagCandidates([
      { url: v1, status: '200' },
      { url: v1, status: '200' },
      { url: v2, status: '404' },
      { url: 'https://api.github.com/repos/owner/repo/git/ref/heads/v1', status: '200' },
    ]),
  ).toEqual([
    { repository: 'owner/repo', tag: 'v1', status: '200' },
    { repository: 'owner/repo', tag: 'v2', status: '404' },
  ]);
});

// The wiring the demand script uses: reads come from the reader, sides from the stage's resolver.
async function recordedRun(maxFindings?: number, failAnchor = false) {
  const { input } = await collectAdvisoryNpm('empty', 1);
  const requested = new Set<string>();
  const opened = createAdvisoryReader(input.limits, {
    now: () => 0,
    fetch: async (url) => {
      requested.add(url);
      if (failAnchor && new URL(url).searchParams.get('affects')?.startsWith('fixture-anchor@'))
        return Response.json({ message: 'unavailable' }, { status: 503 });
      // Two advisories for the anchor, so a one-finding budget rolls its member back.
      return Response.json(
        new URL(url).searchParams.get('affects')?.startsWith('fixture-anchor@')
          ? [
              syntheticAdvisory,
              {
                ...syntheticAdvisory,
                ghsa_id: 'GHSA-dddd-eeee-ffff',
                html_url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
              },
            ]
          : [],
      );
    },
  });
  if (opened.kind !== 'ready') throw new Error('reader');
  const reads: ReaderRead[] = [];
  const sides: TargetSides = new Map();
  const staged = { ...input, limits: { ...input.limits, ...(maxFindings ? { maxFindings } : {}) } };
  addTargetSides(sides, staged, 'reviewed', advisories);
  const result = await advisories.enrichAdvisories(staged, {
    reader: recordReads(opened, 'reviewed', reads),
  });
  opened.close();
  return { result, settled: settledTargets(reads, sides, requested) };
}

test('records every target the stage read, with the side the stage read it for', async () => {
  const { result, settled } = await recordedRun();
  if (result.kind !== 'enriched') throw new Error('enrichment');
  const looked = result.lookups.flatMap(({ side, lookup }) =>
    lookup ? [{ ...lookup.target, side }] : [],
  );
  expect(looked.length).toBeGreaterThan(0);
  expect(
    settled.map(({ ecosystem, name, version, side }) => ({ ecosystem, name, version, side })),
  ).toEqual(expect.arrayContaining(looked));
  expect(settled).toHaveLength(looked.length);
  expect(settled.every((t) => t.type === 'reviewed' && t.complete)).toBe(true);
});

test('a member the stage rolls back still has its completed read recorded', async () => {
  const { result, settled } = await recordedRun(1);
  if (result.kind !== 'enriched') throw new Error('enrichment');
  // The stage keeps no lookup for the rolled-back anchor, but GitHub answered it in full.
  expect(result.lookups.some(({ lookup }) => lookup?.target.name === 'fixture-anchor')).toBe(false);
  expect(settled).toContainEqual(
    expect.objectContaining({ name: 'fixture-anchor', type: 'reviewed', complete: true }),
  );
});

test('a read GitHub answered with an error is kept, marked incomplete', async () => {
  const { settled } = await recordedRun(undefined, true);
  expect(settled).toContainEqual(
    expect.objectContaining({ name: 'fixture-anchor', type: 'reviewed', complete: false }),
  );
  expect(settled.filter((t) => t.name !== 'fixture-anchor').every((t) => t.complete)).toBe(true);
});

test('malware targets take only the proposed side; reviewed targets take every existing side', async () => {
  const { input } = await collectAdvisoryNpm('empty', 1);
  const reviewed: TargetSides = new Map();
  const malware: TargetSides = new Map();
  addTargetSides(reviewed, input, 'reviewed', advisories);
  addTargetSides(malware, input, 'malware', advisories);
  const all = (sides: TargetSides) => [...sides.values()].flatMap((set) => [...set]);
  expect(all(reviewed)).toEqual(expect.arrayContaining(['base', 'head']));
  for (const change of input.changes) {
    if ('basis' in change) continue;
    const target = advisories.resolveAdvisoryTarget(
      input,
      change as never,
      change.to ? 'head' : 'base',
    );
    if (!target) continue;
    expect([
      ...(malware.get(JSON.stringify(['malware', target.ecosystem, target.name, target.version])) ??
        []),
    ]).toEqual([change.to ? 'head' : 'base']);
  }
  expect(malware.size).toBeGreaterThan(0);
  // One proposed-side entry per member, and nothing for the other side.
  const proposed = input.changes.filter(
    (c) =>
      !('basis' in c) &&
      advisories.resolveAdvisoryTarget(input, c as never, c.to ? 'head' : 'base') !== null,
  ).length;
  expect(all(malware)).toHaveLength(proposed);
  const before = JSON.stringify([...malware].map(([key, set]) => [key, [...set]]));
  addTargetSides(malware, { not: 'input' }, 'malware', advisories);
  expect(JSON.stringify([...malware].map(([key, set]) => [key, [...set]]))).toBe(before);
});
