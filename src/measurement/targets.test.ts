import { expect, test } from 'vite-plus/test';
import {
  parseAdvisoryTarget,
  parseTagCandidate,
  settledTargets,
  tagCandidates,
} from './targets.js';

// The reader's query shape (`githubUrl` in advisory-read.ts).
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

// The upstream reader's ref shape (`upstreamGithubUrl` in upstream-read.ts).
function tagUrl(repository: string, tag: string) {
  const ref = 'tags/' + tag;
  return (
    'https://api.github.com/repos/' +
    repository +
    '/git/ref/' +
    ref.split('/').map(encodeURIComponent).join('/')
  );
}

test('round-trips npm targets, including scoped names, with their type', () => {
  for (const [name, version] of [
    ['lodash', '4.17.20'],
    ['@babel/traverse', '7.22.0'],
  ])
    for (const type of ['reviewed', 'malware'])
      expect(parseAdvisoryTarget(advisoryUrl('npm', [`${name}@${version}`], type))).toEqual({
        ecosystem: 'npm',
        name,
        version,
        type,
      });
});

test('round-trips Actions and pip versioned queries to their one target', () => {
  expect(
    parseAdvisoryTarget(advisoryUrl('actions', ['tj-actions/changed-files@45.0.7'], 'reviewed')),
  ).toEqual({
    ecosystem: 'actions',
    name: 'tj-actions/changed-files',
    version: '45.0.7',
    type: 'reviewed',
  });
  // A versioned query for a pip malware hit lists each stored form at the target's version.
  expect(
    parseAdvisoryTarget(
      advisoryUrl(
        'pip',
        ['Flo_Pro.adk@1.0.0', 'flo-pro-adk@1.0.0', 'flo_pro_adk@1.0.0'],
        'malware',
      ),
    ),
  ).toEqual({ ecosystem: 'pip', name: 'flo-pro-adk', version: '1.0.0', type: 'malware' });
  // Actions forms that differ only in case settle the lowercase name.
  expect(
    parseAdvisoryTarget(advisoryUrl('actions', ['Owner/Action@v1', 'owner/action@v1'], 'malware')),
  ).toEqual({ ecosystem: 'actions', name: 'owner/action', version: 'v1', type: 'malware' });
});

test('a discovery query or an OSV query yields no target', () => {
  for (const url of [
    advisoryUrl('pip', ['flo-pro-adk', 'flo_pro_adk', 'flo.pro.adk'], 'malware', '50'),
    advisoryUrl('actions', ['tj-actions/changed-files'], 'reviewed', '50'),
    advisoryUrl('npm', ['@babel/traverse'], 'reviewed', '50'),
    'https://api.osv.dev/v1/query',
  ])
    expect(parseAdvisoryTarget(url), url).toBeNull();
});

test('rejects URLs that are not one target', () => {
  for (const url of [
    advisoryUrl('npm', ['lodash@4.17.20', 'left-pad@1.3.0'], 'reviewed'),
    advisoryUrl('pip', ['flo-pro-adk@1.0.0', 'other@1.0.0'], 'malware'),
    advisoryUrl('pip', ['flo-pro-adk@1.0.0', 'flo_pro_adk@2.0.0'], 'malware'),
    advisoryUrl('rubygems', ['rails@7.0.0'], 'reviewed'),
    advisoryUrl('npm', ['lodash@4.17.20'], 'unreviewed'),
    advisoryUrl('npm', ['lodash@'], 'reviewed'),
    'https://example.com/advisories?ecosystem=npm&affects=lodash%404.17.20&type=reviewed',
    'not a url',
  ])
    expect(parseAdvisoryTarget(url), url).toBeNull();
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
  const unrequested = advisoryUrl('npm', ['left-pad@1.3.0'], 'reviewed');
  const discovery = advisoryUrl('pip', ['flo-pro-adk', 'flo_pro_adk'], 'malware', '50');
  const requested = new Set([lodash, discovery, 'https://api.osv.dev/v1/query']);
  const target = { ecosystem: 'npm', name: 'lodash', version: '4.17.20', type: 'reviewed' };
  expect(
    settledTargets(
      [
        { side: 'head', url: lodash },
        { side: 'head', url: lodash },
        { side: 'base', url: lodash },
        { side: 'head', url: unrequested },
        { side: 'head', url: discovery },
        { side: 'base', url: 'https://api.osv.dev/v1/query' },
        { side: 'base', url: null },
      ],
      requested,
    ),
  ).toEqual([
    { ...target, side: 'base' },
    { ...target, side: 'head' },
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
