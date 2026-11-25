import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';
import { upstreamGithubUrl } from '../evidence/upstream-read.js';
import {
  parseTagCandidate,
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

test('a versioned query yields its one target once per side, and only when requested', () => {
  const lodash = advisoryUrl('npm', ['lodash@4.17.20'], 'reviewed');
  const unrequested = advisoryUrl('npm', ['lodash@4.17.20'], 'malware');
  const discovery = advisoryUrl('pip', ['flo-pro-adk', 'flo_pro_adk'], 'malware', '50');
  const requested = new Set([lodash, discovery, 'https://api.osv.dev/v1/query']);
  const lookup = { ecosystem: 'npm', name: 'lodash', version: '4.17.20' };
  const target = { ...lookup, type: 'reviewed' };
  expect(
    settledTargets(
      [
        { side: 'head', url: lodash, target: lookup, complete: true },
        { side: 'head', url: lodash, target: lookup, complete: true },
        { side: 'base', url: lodash, target: lookup, complete: true },
        { side: 'head', url: unrequested, target: lookup, complete: true },
        { side: 'head', url: discovery, target: lookup, complete: true },
        { side: 'base', url: 'https://api.osv.dev/v1/query', target: lookup, complete: true },
        { side: 'base', url: null, target: lookup, complete: true },
        { side: 'base', url: lodash, target: null, complete: true },
      ],
      requested,
    ),
  ).toEqual([
    { ...target, side: 'base', complete: true },
    { ...target, side: 'head', complete: true },
  ]);
});

test('keeps a target whose lookup failed, marked incomplete on that side', () => {
  const lodash = advisoryUrl('npm', ['lodash@4.17.20'], 'reviewed');
  const lookup = { ecosystem: 'npm', name: 'lodash', version: '4.17.20' };
  const target = { ...lookup, type: 'reviewed' };
  expect(
    settledTargets(
      [
        { side: 'head', url: lodash, target: lookup, complete: false },
        { side: 'head', url: lodash, target: lookup, complete: true },
        { side: 'base', url: lodash, target: lookup, complete: true },
        { side: 'base', url: lodash, target: lookup, complete: false },
      ],
      new Set([lodash]),
    ),
  ).toEqual([
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
