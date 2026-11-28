/**
 * Invented inputs for the heap probe's evidence reads (scripts/measure-heap/evidence.ts): a
 * review binding the W2 GitHub read session accepts, and one npm registry request. None of
 * these values is a limit.
 */
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
export const repository = { id: 101, owner: 'example', name: 'consumer' };
export const binding = {
  repository,
  workflow: { id: 301, path: '.github/workflows/ci.yml' },
  runId: 401,
  runAttempt: 1,
  pullNumber: 42,
  headRepository: repository,
  headSha: HEAD,
  baseRef: 'main',
  baseSha: BASE,
  mergeBaseSha: BASE,
  actorId: 201,
  conclusion: 'success',
  identity: [101, 301, 401, 1, 42, HEAD],
};
export const npmRequest = {
  name: '@fixture/widget',
  version: '1.2.3',
  integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64'),
  source: {
    kind: 'registry',
    identity: 'https://registry.npmjs.org/@fixture/widget/-/widget-1.2.3.tgz',
  },
};
