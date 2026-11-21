/**
 * Measures research read demand for one Dependabot PR, open or closed, with no model call and no
 * write. A closed PR is measured as if open (see `reopenPullRequest`); the report counts the
 * reads that shim changed in `reopenedPullReads`. The run fails, after writing its report, when
 * research does not complete. Usage: MEASURE_PR=276 GITHUB_TOKEN=... npm run measure:demand
 * Optional: MEASURE_REPO (default andrewpucci/dependency-update-advisor), MEASURE_CI_WORKFLOW
 * (default .github/workflows/ci.yml), MEASURE_OUT (write the JSON report to this path),
 * MEASURE_SCALE (a positive integer; multiplies the read budget, see `isReadBudget`, so the run
 * shows demand the current shares would cut off; a report with `censored` stages is still capped).
 * The report holds counts only: no URL, header, token, or response body.
 */
import { writeFileSync } from 'node:fs';
import { test, vi } from 'vite-plus/test';
import { authenticatedFetch, researchFetch } from '../../src/adapters.js';
import {
  EVIDENCE_READ_ALLOCATION,
  EVIDENCE_READ_ENVELOPE,
  RESEARCH_CACHE_LIMITS,
} from '../../src/budget.js';
import { createEvidenceCollectors, openEvidenceSession } from '../../src/collection.js';
import { parseReviewBinding } from '../../src/event.js';
import { createResearchCache } from '../../src/evidence/research-cache.js';
import { limit } from '../../src/limits.js';
import {
  createDemandRecorder,
  labelShare,
  type DemandPhase,
} from '../../src/measurement/demand.js';
import { reopenPullRequest } from '../../src/measurement/reopen.js';
import { assembleReviewPacket } from '../../src/packet.js';
import { dependencyIdentities } from '../../src/pipeline.js';
import { runResearch } from '../../src/research.js';
import { createGithubTransport } from '../../src/runtime.js';
import { createGithubSnapshotReads, withTrustedSnapshot } from '../../src/snapshot.js';

// Mock factories run before imports, so they share the recorder's phase through this holder.
const hooks = vi.hoisted(() => ({ phase: (): DemandPhase => 'pre-research' }));

vi.mock('../../src/limits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/limits.js')>();
  const { scaledDefinitions } = await import('../../src/measurement/scale.js');
  const factor = Number(process.env.MEASURE_SCALE ?? '1');
  const register = actual.buildRegister(scaledDefinitions(actual.REGISTER, factor));
  const limitEntry = (id: string) => {
    const entry = register.get(id);
    if (entry === undefined) throw new Error(`unknown limit id: ${id}`);
    return entry;
  };
  return { ...actual, REGISTER: register, limitEntry, limit: (id: string) => limitEntry(id).value };
});

// Each research reader's requests count against its allocation share.
vi.mock('../../src/evidence/upstream-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evidence/upstream-read.js')>();
  const { labelReader } = await import('../../src/measurement/demand.js');
  const phase = () => hooks.phase();
  return {
    ...actual,
    createUpstreamReader: labelReader('upstream', actual.createUpstreamReader, phase),
  };
});
vi.mock('../../src/evidence/advisory-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evidence/advisory-read.js')>();
  const { labelReader } = await import('../../src/measurement/demand.js');
  const phase = () => hooks.phase();
  return {
    ...actual,
    createAdvisoryReader: labelReader('advisory', actual.createAdvisoryReader, phase),
    createMalwareReader: labelReader('malware', actual.createMalwareReader, phase),
  };
});
vi.mock('../../src/evidence/npm-publish-times.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evidence/npm-publish-times.js')>();
  const { labelReader } = await import('../../src/measurement/demand.js');
  const phase = () => hooks.phase();
  return {
    ...actual,
    createNpmPublishTimeReader: labelReader(
      'publishTimes',
      actual.createNpmPublishTimeReader,
      phase,
    ),
  };
});
vi.mock('../../src/evidence/npm-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evidence/npm-registry.js')>();
  const { labelReader } = await import('../../src/measurement/demand.js');
  const phase = () => hooks.phase();
  return {
    ...actual,
    createNpmRegistryReader: labelReader('npmRegistry', actual.createNpmRegistryReader, phase),
  };
});
vi.mock('../../src/evidence/policy-signals-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evidence/policy-signals-read.js')>();
  const { labelReader } = await import('../../src/measurement/demand.js');
  const phase = () => hooks.phase();
  return {
    ...actual,
    createPolicySignalReader: labelReader('metadata', actual.createPolicySignalReader, phase),
  };
});

const env = process.env;
const [owner, name] = (env.MEASURE_REPO ?? 'andrewpucci/dependency-update-advisor').split('/');
const workflowPath = env.MEASURE_CI_WORKFLOW ?? '.github/workflows/ci.yml';

async function api(token: string, path: string): Promise<any> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`binding read failed: ${response.status}`);
  return response.json();
}

/** Builds a binding from the PR and its CI run; freshness is not checked, so closed PRs work. */
async function binding(token: string, pr: number) {
  const repo = await api(token, `repos/${owner}/${name}`);
  const pull = await api(token, `repos/${owner}/${name}/pulls/${pr}`);
  const compare = await api(
    token,
    `repos/${owner}/${name}/compare/${pull.base.sha}...${pull.head.sha}`,
  );
  const workflow = await api(
    token,
    `repos/${owner}/${name}/actions/workflows/${workflowPath.split('/').pop()}`,
  );
  const runs = await api(
    token,
    `repos/${owner}/${name}/actions/workflows/${workflow.id}/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=1`,
  );
  const run = runs.workflow_runs[0];
  if (!run) throw new Error('no CI run for the PR head');
  const value = {
    repository: { id: repo.id, owner, name },
    workflow: { id: workflow.id, path: workflow.path },
    runId: run.id,
    runAttempt: run.run_attempt,
    pullNumber: pr,
    headRepository: {
      id: pull.head.repo.id,
      owner: pull.head.repo.owner.login,
      name: pull.head.repo.name,
    },
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    mergeBaseSha: compare.merge_base_commit.sha,
    actorId: run.actor.id,
    conclusion: run.conclusion,
    identity: [repo.id, workflow.id, run.id, run.run_attempt, pr, pull.head.sha],
  };
  const parsed = parseReviewBinding(value);
  if (!parsed) throw new Error('binding invalid');
  return { binding: parsed, repository: { id: repo.id, owner, name } };
}

function units(packet: any): Record<string, number> {
  const changes = packet.changes as any[];
  const count = (predicate: (change: any) => boolean) => changes.filter(predicate).length;
  return {
    changes: changes.length,
    direct: count((c) => c.role === 'direct'),
    transitive: count((c) => c.role === 'transitive'),
    added: count((c) => !c.from),
    removed: count((c) => !c.to),
    releaseSources: new Set(
      (packet.sources as any[])
        .filter((s) => s.kind === 'release' && s.provenance?.kind === 'upstream')
        .map((s) => s.provenance.url),
    ).size,
    sources: packet.sources.length,
    findings: packet.findings.length,
    packetBytes: Buffer.byteLength(JSON.stringify(packet)),
  };
}

test('measure research read demand', async () => {
  const token = env.GITHUB_TOKEN ?? '';
  const pr = Number(env.MEASURE_PR);
  if (!token || !Number.isSafeInteger(pr)) throw new Error('GITHUB_TOKEN and MEASURE_PR required');
  const now = () => performance.now();
  const recorder = createDemandRecorder(now);
  hooks.phase = recorder.phase;
  const base = recorder.wrap((url, init) => fetch(url, init));
  const { binding: bound, repository } = await binding(token, pr);
  const started = now();
  const deadline = started + EVIDENCE_READ_ENVELOPE.totalTimeoutMs;
  // Freshness reads never run here (isCurrent is always true), so transport is all snapshot.
  const transport = createGithubTransport({
    token,
    fetch: labelShare('transport', base),
    now,
    startedAt: started,
  });
  const publicFetch = researchFetch(token, base);
  const reopened = reopenPullRequest(labelShare('session', base), pr);
  let npmInventory: unknown = null;
  // As in the pipeline: one cache shared by collection's registry reads and research.
  const researchCache = createResearchCache(RESEARCH_CACHE_LIMITS);
  let measured: Record<string, number> = {};
  // Packet assembly turns a thrown session failure into internal-failure; keep why it failed.
  let sessionOutcome = 'not opened';
  const snapshot = await withTrustedSnapshot(
    { repository, reads: createGithubSnapshotReads(transport) },
    async (trusted) => {
      const collectors = createEvidenceCollectors({
        binding: bound,
        dependabot: await trusted.dependabotRoots(),
        registryFetch: labelShare('registry', publicFetch),
        researchCache,
        onNpmInventory: (inventory) => (npmInventory = inventory),
        now,
        deadline,
      });
      const trustedBase = {
        binding: bound,
        baseSha: bound.baseSha,
        contextRevision: trusted.contextRevision,
      };
      const assembled = await assembleReviewPacket({
        trusted: trustedBase,
        collectContext: (changes: readonly unknown[]) =>
          trusted.collectContext(dependencyIdentities(changes)),
        isCurrent: () => true,
        openSession: async () => {
          const opened = await openEvidenceSession({
            binding: bound,
            fetch: authenticatedFetch(token, reopened.fetch),
            now,
            deadline,
          });
          sessionOutcome = opened.kind;
          if (opened.kind !== 'ready') throw new Error('no evidence session');
          return opened.session;
        },
        collectors,
        inventorySource: null,
      } as never);
      if (assembled.kind === 'incomplete') return { packet: assembled.kind, gaps: assembled.gaps };
      if (assembled.kind === 'context-failure')
        return { packet: assembled.kind, category: assembled.category };
      if (assembled.kind !== 'ready') return { packet: assembled.kind, session: sessionOutcome };
      const researched = await runResearch({
        packet: assembled.packet,
        trusted: { ...trustedBase, context: assembled.packet.context as never },
        npmInventory: npmInventory as never,
        comparison: null,
        fetch: publicFetch,
        cache: researchCache,
        now,
        deadline,
        evaluationTime: Date.now(),
        observe: recorder.observe,
      });
      if (researched.kind !== 'ready') return { research: researched.kind };
      measured = units(researched.packet);
      return { unavailable: researched.unavailable };
    },
  );
  const report = {
    pr,
    measuredAt: new Date().toISOString(),
    totalMs: Math.round(now() - started),
    result: snapshot,
    scale: Number(env.MEASURE_SCALE ?? '1'),
    reopenedPullReads: reopened.rewrites(),
    effectiveLimits: {
      envelope: EVIDENCE_READ_ENVELOPE,
      allocation: EVIDENCE_READ_ALLOCATION,
      researchMaxAttempts: limit('research.maxAttempts'),
    },
    ...recorder.report(measured),
  };
  const text = JSON.stringify(report, null, 2);
  if (env.MEASURE_OUT) writeFileSync(env.MEASURE_OUT, text + '\n');
  console.log(text);
  if (Object.keys(measured).length === 0)
    throw new Error(`research did not complete: ${JSON.stringify(snapshot)}`);
});
