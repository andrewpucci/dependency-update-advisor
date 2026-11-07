import { expect, test, vi } from 'vite-plus/test';
import { createUpstreamReader } from './upstream-read.js';

const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const limits = {
  maxRequests: 30,
  maxPages: 10,
  maxTagCandidates: 20,
  maxTagDepth: 5,
  maxResponseBytes: 50_000,
  maxTotalBytes: 500_000,
  maxJsonEntries: 50_000,
  maxJsonDepth: 32,
  maxWork: 100_000,
  maxRetainedBytes: 500_000,
  maxAttempts: 100,
  requestTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
};
const target = {
  kind: 'npm' as const,
  name: '@fixture/widget',
  version: '1.2.3',
  integrity,
  source: { kind: 'registry' as const, identity: 'https://registry.npmjs.org/widget.tgz' },
};
const document = {
  _id: '@fixture/widget@1.2.3',
  name: target.name,
  version: target.version,
  dist: { integrity },
  description: 'Version-specific package description.',
};
function setup(
  response: () => Promise<Response> = async () => Response.json(document),
  overrides = {},
) {
  const fetch = vi.fn(response);
  const opened = createUpstreamReader({ ...limits, ...overrides }, { fetch, now: () => 0 });
  if (opened.kind !== 'ready') throw new Error('reader');
  return { reader: opened.reader, fetch };
}
test('integrity-bound npm reads remain credential-free and attempt-local', async () => {
  const f = setup();
  const r = await f.reader.read(target);
  expect(r).toMatchObject({ status: 'available', fetched: true, data: document });
  expect(f.fetch).toHaveBeenCalledWith(
    'https://registry.npmjs.org/%40fixture%2Fwidget/1.2.3',
    expect.objectContaining({ redirect: 'manual', credentials: 'omit' }),
  );
  expect(
    (
      await f.reader.read({
        ...target,
        integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64'),
      })
    ).reasons,
  ).toContain('conflict');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.reader.close();
  expect((await f.reader.read(target)).fetched).toBe(false);
});
test('unsupported sources and invalid limits perform no I/O', async () => {
  const f = setup();
  expect(
    (
      await f.reader.read({
        ...target,
        source: { kind: 'registry', identity: 'https://private.example/pkg' },
      })
    ).status,
  ).toBe('unavailable');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(
    createUpstreamReader({ ...limits, maxRequests: 0 }, { fetch: f.fetch, now: () => 0 }).kind,
  ).toBe('invalid');
  f.reader.close();
});
test.each([302, 429, 500])('HTTP %s is not successful empty evidence', async (status) => {
  const f = setup(
    async () => new Response('{}', { status, headers: { location: 'https://elsewhere.example' } }),
  );
  expect((await f.reader.read(target)).status).toBe('unavailable');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  f.reader.close();
});
test('stream and cumulative request bounds cover nested registry reads', async () => {
  const f = setup(undefined, { maxResponseBytes: 10 });
  expect((await f.reader.read(target)).reasons).toContain('budget');
  f.reader.close();
  const g = setup(undefined, { maxRequests: 1 });
  await g.reader.read(target);
  const second = await g.reader.read({ ...target, version: '1.2.4' });
  expect(second).toMatchObject({ fetched: false, reasons: ['budget'] });
  expect(g.fetch).toHaveBeenCalledTimes(1);
  g.reader.close();
});

test('exact public PyPI metadata validates both normalized identity and version', async () => {
  const f = setup(async () =>
    Response.json({
      info: { name: 'Fixture_Widget', version: '2.0rc1', description: 'Exact prerelease.' },
    }),
  );
  const py = {
    kind: 'pypi',
    name: 'fixture-widget',
    version: '2.0rc1',
    source: { kind: 'registry', identity: 'https://pypi.org/simple' },
  };
  expect(await f.reader.read(py)).toMatchObject({
    status: 'available',
    data: { description: 'Exact prerelease.' },
  });
  expect(f.fetch).toHaveBeenCalledWith(
    'https://pypi.org/pypi/fixture-widget/2.0rc1/json',
    expect.anything(),
  );
  expect((await f.reader.read({ ...py, version: '2.0' })).reasons).toContain('conflict');
  const calls = f.fetch.mock.calls.length;
  expect(
    (
      await f.reader.read({
        ...py,
        source: { kind: 'registry', identity: 'https://private.example/simple' },
      })
    ).status,
  ).toBe('unavailable');
  expect(f.fetch).toHaveBeenCalledTimes(calls);
  f.reader.close();
});
