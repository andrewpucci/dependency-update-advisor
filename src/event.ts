const CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
] as const;
const RUN_STATUSES = ['completed', 'queued', 'in_progress', 'requested', 'waiting', 'pending'];

export type CiConclusion = (typeof CONCLUSIONS)[number];
export type RepositoryIdentity = Readonly<{ id: number; owner: string; name: string }>;
export type WorkflowIdentity = Readonly<{ id: number; path: string }>;
export type ReviewIdentity = readonly [number, number, number, number, number, string];
export type ReviewBinding = Readonly<{
  repository: RepositoryIdentity;
  workflow: WorkflowIdentity;
  runId: number;
  runAttempt: number;
  pullNumber: number;
  headRepository: RepositoryIdentity;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
  actorId: number;
  conclusion: CiConclusion;
  identity: ReviewIdentity;
}>;
type ErrorField =
  | 'event'
  | 'expected'
  | 'workflow'
  | 'run'
  | 'pullRequest'
  | 'replay'
  | 'binding'
  | 'comparison';
export type VerificationError = {
  kind: 'error';
  category: 'input' | 'mismatch' | 'read' | 'replay';
  field: ErrorField;
};
export type EventResult =
  | { kind: 'verified'; binding: ReviewBinding }
  | { kind: 'skip'; reason: 'ineligible' | 'obsolete' | 'duplicate' }
  | VerificationError;
export type EventReads = {
  readWorkflow: (repository: RepositoryIdentity, workflowId: number) => Promise<unknown>;
  readRun: (repository: RepositoryIdentity, runId: number) => Promise<unknown>;
  readPullRequest: (repository: RepositoryIdentity, pullNumber: number) => Promise<unknown>;
  readComparison: (repository: RepositoryIdentity, base: string, head: string) => Promise<unknown>;
  readReplay: (identity: ReviewIdentity) => Promise<unknown>;
};
export type FreshnessReads = Pick<EventReads, 'readRun' | 'readPullRequest' | 'readComparison'>;
export type FreshnessResult = { kind: 'fresh' } | { kind: 'obsolete' } | VerificationError;

type Actor = { id: number; login: string; type: string };
type Association = {
  number: number;
  baseId: number;
  baseName: string;
  headId: number;
  headName: string;
  headSha: string;
};
type Run = {
  id: number;
  workflowId: number;
  attempt: number;
  event: string;
  status: string;
  conclusion: CiConclusion | null;
  headSha: string;
  actor: Actor;
  repository: RepositoryIdentity;
  headRepository: RepositoryIdentity;
  associations: Association[];
};
type PullRequest = {
  number: number;
  closed: boolean;
  actor: Actor;
  repository: RepositoryIdentity;
  headRepository: RepositoryIdentity;
  headSha: string;
  baseRef: string;
  baseSha: string;
};

function failure(
  field: ErrorField,
  category: VerificationError['category'] = 'input',
): VerificationError {
  return { kind: 'error', category, field };
}

export function record(
  value: unknown,
  keys: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** An HTTP status that GitHub definitively rejected; other non-2xx values stay unknown. */
export function rejectedStatus(status: unknown): boolean {
  return (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599 &&
    (status < 200 || status > 299)
  );
}

export function dispatchFailure(error: unknown): 'timeout' | 'transport' {
  try {
    if (record(error) && error.kind === 'timeout') return 'timeout';
  } catch {
    /* Exception properties are untrusted. */
  }
  return 'transport';
}

function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function segment(value: unknown): value is string {
  return text(value) && !/[\s/\\]/u.test(value) && value !== '.' && value !== '..';
}

function sha(value: unknown): string | null {
  return typeof value === 'string' && value.length === 40 && /^[a-f\d]{40}$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

function conclusion(value: unknown): value is CiConclusion {
  return CONCLUSIONS.some((item) => item === value);
}

function repository(value: unknown): RepositoryIdentity | null {
  if (!record(value, ['id', 'full_name']) || !positiveId(value.id) || !text(value.full_name))
    return null;
  const parts = value.full_name.split('/');
  if (parts.length !== 2 || !segment(parts[0]) || !segment(parts[1])) return null;
  return Object.freeze({
    id: value.id,
    owner: parts[0].toLowerCase(),
    name: parts[1].toLowerCase(),
  });
}

function expectedRepository(value: unknown): RepositoryIdentity | null {
  if (
    !record(value, ['id', 'owner', 'name']) ||
    !positiveId(value.id) ||
    !segment(value.owner) ||
    !segment(value.name)
  )
    return null;
  return Object.freeze({
    id: value.id,
    owner: value.owner.toLowerCase(),
    name: value.name.toLowerCase(),
  });
}

function workflow(value: unknown): WorkflowIdentity | null {
  if (!record(value, ['id', 'path']) || !positiveId(value.id) || !text(value.path)) return null;
  return Object.freeze({ id: value.id, path: value.path });
}

function actor(value: unknown): Actor | null {
  if (
    !record(value, ['id', 'login', 'type']) ||
    !positiveId(value.id) ||
    !text(value.login) ||
    !text(value.type)
  )
    return null;
  return { id: value.id, login: value.login, type: value.type };
}

function isDependabot(value: Actor): boolean {
  return value.login === 'dependabot[bot]' && value.type === 'Bot';
}

function association(value: unknown): Association | null {
  if (
    !record(value, ['number', 'base', 'head']) ||
    !positiveId(value.number) ||
    !record(value.base, ['repo']) ||
    !record(value.head, ['repo', 'sha'])
  )
    return null;
  const base = value.base.repo,
    head = value.head.repo,
    headSha = sha(value.head.sha);
  if (
    !record(base, ['id', 'name']) ||
    !record(head, ['id', 'name']) ||
    !positiveId(base.id) ||
    !segment(base.name) ||
    !positiveId(head.id) ||
    !segment(head.name) ||
    !headSha
  )
    return null;
  return {
    number: value.number,
    baseId: base.id,
    baseName: base.name.toLowerCase(),
    headId: head.id,
    headName: head.name.toLowerCase(),
    headSha,
  };
}

function run(value: unknown): Run | null {
  if (
    !record(value, [
      'id',
      'workflow_id',
      'run_attempt',
      'event',
      'status',
      'conclusion',
      'head_sha',
      'actor',
      'repository',
      'head_repository',
      'pull_requests',
    ]) ||
    !positiveId(value.id) ||
    !positiveId(value.workflow_id) ||
    !positiveId(value.run_attempt) ||
    !text(value.event) ||
    !text(value.status) ||
    !RUN_STATUSES.includes(value.status) ||
    (value.conclusion !== null && !conclusion(value.conclusion)) ||
    !Array.isArray(value.pull_requests)
  )
    return null;
  const runActor = actor(value.actor),
    repo = repository(value.repository);
  const headRepo = repository(value.head_repository),
    headSha = sha(value.head_sha);
  const associations = Array.from(value.pull_requests, association);
  if (
    !runActor ||
    !repo ||
    !headRepo ||
    !headSha ||
    !associations.every((item): item is Association => item !== null)
  )
    return null;
  return {
    id: value.id,
    workflowId: value.workflow_id,
    attempt: value.run_attempt,
    event: value.event,
    status: value.status,
    conclusion: value.conclusion,
    headSha,
    actor: runActor,
    repository: repo,
    headRepository: headRepo,
    associations,
  };
}

function pullRequest(value: unknown): PullRequest | null {
  if (
    !record(value, ['number', 'state', 'merged', 'user', 'base', 'head']) ||
    !positiveId(value.number) ||
    (value.state !== 'open' && value.state !== 'closed') ||
    typeof value.merged !== 'boolean' ||
    !record(value.base, ['repo', 'ref', 'sha']) ||
    !text(value.base.ref) ||
    Buffer.byteLength(value.base.ref, 'utf8') > 1024 ||
    !record(value.head, ['repo', 'sha'])
  )
    return null;
  const prActor = actor(value.user),
    repo = repository(value.base.repo);
  const headRepo = repository(value.head.repo),
    headSha = sha(value.head.sha);
  const baseSha = sha(value.base.sha);
  if (!prActor || !repo || !headRepo || !headSha || !baseSha) return null;
  return {
    number: value.number,
    closed: value.state === 'closed' || value.merged,
    actor: prActor,
    repository: repo,
    headRepository: headRepo,
    headSha,
    baseRef: value.base.ref,
    baseSha,
  };
}

function comparisonMergeBase(value: unknown, baseSha: string): string | null {
  if (
    !record(value, ['base_commit', 'merge_base_commit']) ||
    !record(value.base_commit, ['sha']) ||
    !record(value.merge_base_commit, ['sha']) ||
    sha(value.base_commit.sha) !== baseSha
  )
    return null;
  return sha(value.merge_base_commit.sha);
}

function sameRepository(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.id === b.id && a.owner === b.owner && a.name === b.name;
}

function sameActor(a: Actor, b: Actor): boolean {
  return a.id === b.id && a.login === b.login && a.type === b.type;
}

function associatedWith(
  a: Association,
  number: number,
  base: RepositoryIdentity,
  head: RepositoryIdentity,
): boolean {
  return (
    a.number === number &&
    a.baseId === base.id &&
    a.baseName === base.name &&
    a.headId === head.id &&
    a.headName === head.name
  );
}

function identity(
  repoId: number,
  workflowId: number,
  runId: number,
  attempt: number,
  number: number,
  headSha: string,
): ReviewIdentity {
  return Object.freeze([repoId, workflowId, runId, attempt, number, headSha] as const);
}

export function sameIdentity(value: unknown, expected: readonly unknown[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((item, index) => item === value[index])
  );
}

async function read(
  field: ErrorField,
  operation: () => Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: VerificationError }> {
  try {
    return { ok: true, value: await operation() };
  } catch {
    return { ok: false, error: failure(field, field === 'replay' ? 'replay' : 'read') };
  }
}

type EligibleEvent = {
  kind: 'eligible';
  expectedRepo: RepositoryIdentity;
  expectedWorkflow: WorkflowIdentity;
  eventRun: Run;
  eventAssociation: Association;
};
type EventStop = Exclude<EventResult, { kind: 'verified' }>;

function verifyEventInput(input: unknown): EligibleEvent | EventStop {
  if (!record(input, ['eventName']) || !text(input.eventName)) return failure('event');
  if (input.eventName !== 'workflow_run') return { kind: 'skip', reason: 'ineligible' };
  if (
    !record(input, ['payload', 'expected']) ||
    !record(input.payload, ['action']) ||
    !text(input.payload.action)
  )
    return failure('event');
  if (input.payload.action !== 'completed') return { kind: 'skip', reason: 'ineligible' };
  if (!record(input.expected, ['repository', 'workflow'])) return failure('expected');
  const expectedRepo = expectedRepository(input.expected.repository);
  const expectedWorkflow = workflow(input.expected.workflow);
  if (!expectedRepo || !expectedWorkflow) return failure('expected');
  if (!record(input.payload, ['repository', 'workflow_run'])) return failure('event');
  const eventRepo = repository(input.payload.repository),
    eventRun = run(input.payload.workflow_run);
  if (!eventRepo || !eventRun) return failure('event');
  if (eventRun.event !== 'pull_request' || !isDependabot(eventRun.actor))
    return { kind: 'skip', reason: 'ineligible' };
  if (eventRun.status !== 'completed') return failure('event', 'mismatch');
  if (eventRun.conclusion === null) return failure('event');
  if (
    !sameRepository(eventRepo, expectedRepo) ||
    !sameRepository(eventRun.repository, expectedRepo) ||
    eventRun.workflowId !== expectedWorkflow.id
  )
    return failure('event', 'mismatch');
  if (eventRun.associations.length !== 1) return { kind: 'skip', reason: 'ineligible' };
  const eventAssociation = eventRun.associations[0]!;
  if (
    !associatedWith(
      eventAssociation,
      eventAssociation.number,
      expectedRepo,
      eventRun.headRepository,
    ) ||
    eventAssociation.headSha !== eventRun.headSha
  )
    return failure('event', 'mismatch');
  return { kind: 'eligible', expectedRepo, expectedWorkflow, eventRun, eventAssociation };
}

function verifyCurrentRun(
  currentRun: Run,
  event: EligibleEvent,
): EventStop | { kind: 'current'; association: Association; conclusion: CiConclusion } {
  const { expectedRepo, expectedWorkflow, eventRun, eventAssociation } = event;
  if (
    currentRun.id !== eventRun.id ||
    currentRun.workflowId !== expectedWorkflow.id ||
    !sameRepository(currentRun.repository, expectedRepo) ||
    !sameRepository(currentRun.headRepository, eventRun.headRepository) ||
    !sameActor(currentRun.actor, eventRun.actor) ||
    currentRun.event !== eventRun.event ||
    currentRun.headSha !== eventRun.headSha
  )
    return failure('run', 'mismatch');
  if (currentRun.attempt > eventRun.attempt) return { kind: 'skip', reason: 'obsolete' };
  if (currentRun.attempt !== eventRun.attempt || currentRun.status !== 'completed')
    return failure('run', 'mismatch');
  if (currentRun.conclusion === null) return failure('run');
  if (currentRun.conclusion !== eventRun.conclusion) return failure('run', 'mismatch');
  if (currentRun.associations.length !== 1) return { kind: 'skip', reason: 'ineligible' };
  const currentAssociation = currentRun.associations[0]!;
  if (
    !associatedWith(
      currentAssociation,
      eventAssociation.number,
      expectedRepo,
      eventRun.headRepository,
    )
  )
    return failure('run', 'mismatch');
  return { kind: 'current', association: currentAssociation, conclusion: currentRun.conclusion };
}

function verifyEventPullRequest(
  value: unknown,
  event: EligibleEvent,
  currentAssociation: Association,
): EventStop | { kind: 'current'; pr: PullRequest } {
  const { expectedRepo, eventRun, eventAssociation } = event;
  const pr = pullRequest(value);
  if (!pr) return failure('pullRequest');
  if (
    pr.number !== eventAssociation.number ||
    !sameRepository(pr.repository, expectedRepo) ||
    !sameRepository(pr.headRepository, eventRun.headRepository)
  )
    return failure('pullRequest', 'mismatch');
  if (!isDependabot(pr.actor)) return { kind: 'skip', reason: 'ineligible' };
  if (!sameActor(pr.actor, eventRun.actor)) return failure('pullRequest', 'mismatch');
  if (pr.closed || pr.headSha !== eventRun.headSha) return { kind: 'skip', reason: 'obsolete' };
  if (currentAssociation.headSha !== eventRun.headSha) return failure('run', 'mismatch');
  return { kind: 'current', pr };
}

function verifyReplay(replay: unknown, reviewIdentity: ReviewIdentity): EventStop | undefined {
  if (!record(replay, ['identity', 'state']) || !sameIdentity(replay.identity, reviewIdentity))
    return failure('replay', 'replay');
  if (replay.state === 'claimed' || replay.state === 'completed')
    return { kind: 'skip', reason: 'duplicate' };
  if (replay.state !== 'unseen') return failure('replay', 'replay');
  return undefined;
}

/** Read-only identity verification. A binding is a snapshot; W2 must claim it before any write. */
export async function verifyCiEvent(input: unknown, reads: EventReads): Promise<EventResult> {
  try {
    const event = verifyEventInput(input);
    if (event.kind !== 'eligible') return event;
    const { expectedRepo, expectedWorkflow, eventRun, eventAssociation } = event;
    const workflowRead = await read('workflow', () =>
      reads.readWorkflow(expectedRepo, expectedWorkflow.id),
    );
    if (!workflowRead.ok) return workflowRead.error;
    const actualWorkflow = workflow(workflowRead.value);
    if (!actualWorkflow) return failure('workflow');
    if (actualWorkflow.id !== expectedWorkflow.id || actualWorkflow.path !== expectedWorkflow.path)
      return failure('workflow', 'mismatch');
    const runRead = await read('run', () => reads.readRun(expectedRepo, eventRun.id));
    if (!runRead.ok) return runRead.error;
    const currentRun = run(runRead.value);
    if (!currentRun) return failure('run');
    const checkedRun = verifyCurrentRun(currentRun, event);
    if (checkedRun.kind !== 'current') return checkedRun;
    const currentAssociation = checkedRun.association;
    const prRead = await read('pullRequest', () =>
      reads.readPullRequest(expectedRepo, eventAssociation.number),
    );
    if (!prRead.ok) return prRead.error;
    const checkedPr = verifyEventPullRequest(prRead.value, event, currentAssociation);
    if (checkedPr.kind !== 'current') return checkedPr;
    const { pr } = checkedPr;
    const reviewIdentity = identity(
      expectedRepo.id,
      expectedWorkflow.id,
      eventRun.id,
      eventRun.attempt,
      pr.number,
      pr.headSha,
    );
    const replayRead = await read('replay', () => reads.readReplay(reviewIdentity));
    if (!replayRead.ok) return replayRead.error;
    const replayError = verifyReplay(replayRead.value, reviewIdentity);
    if (replayError) return replayError;
    const comparisonRead = await read('comparison', () =>
      reads.readComparison(expectedRepo, pr.baseSha, pr.headSha),
    );
    if (!comparisonRead.ok) return comparisonRead.error;
    const mergeBaseSha = comparisonMergeBase(comparisonRead.value, pr.baseSha);
    if (!mergeBaseSha) return failure('comparison');
    return {
      kind: 'verified',
      binding: Object.freeze({
        repository: expectedRepo,
        workflow: expectedWorkflow,
        runId: eventRun.id,
        runAttempt: eventRun.attempt,
        pullNumber: pr.number,
        headRepository: eventRun.headRepository,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        baseSha: pr.baseSha,
        mergeBaseSha,
        actorId: pr.actor.id,
        conclusion: checkedRun.conclusion,
        identity: reviewIdentity,
      }),
    };
  } catch {
    return failure('event');
  }
}

function binding(value: unknown): ReviewBinding | null {
  if (
    !record(value, [
      'repository',
      'workflow',
      'runId',
      'runAttempt',
      'pullNumber',
      'headRepository',
      'headSha',
      'baseRef',
      'baseSha',
      'mergeBaseSha',
      'actorId',
      'conclusion',
      'identity',
    ]) ||
    !positiveId(value.runId) ||
    !positiveId(value.runAttempt) ||
    !positiveId(value.pullNumber) ||
    !positiveId(value.actorId) ||
    !conclusion(value.conclusion)
  )
    return null;
  const repo = expectedRepository(value.repository),
    expectedWorkflow = workflow(value.workflow);
  const headRepo = expectedRepository(value.headRepository),
    headSha = sha(value.headSha);
  const baseSha = sha(value.baseSha),
    mergeBaseSha = sha(value.mergeBaseSha);
  if (
    !repo ||
    !expectedWorkflow ||
    !headRepo ||
    !headSha ||
    !baseSha ||
    !mergeBaseSha ||
    !text(value.baseRef) ||
    Buffer.byteLength(value.baseRef, 'utf8') > 1024
  )
    return null;
  const reviewIdentity = identity(
    repo.id,
    expectedWorkflow.id,
    value.runId,
    value.runAttempt,
    value.pullNumber,
    headSha,
  );
  if (!sameIdentity(value.identity, reviewIdentity)) return null;
  return Object.freeze({
    repository: repo,
    workflow: expectedWorkflow,
    runId: value.runId,
    runAttempt: value.runAttempt,
    pullNumber: value.pullNumber,
    headRepository: headRepo,
    headSha,
    baseRef: value.baseRef,
    baseSha,
    mergeBaseSha,
    actorId: value.actorId,
    conclusion: value.conclusion,
    identity: reviewIdentity,
  });
}

/** Validate and copy a binding snapshot; this grants no freshness or ownership authority. */
export function parseReviewBinding(value: unknown): ReviewBinding | null {
  try {
    return binding(structuredClone(value));
  } catch {
    return null;
  }
}

function verifyBoundRun(
  current: Run,
  original: ReviewBinding,
):
  | Exclude<FreshnessResult, { kind: 'fresh' }>
  | { kind: 'current'; association: Association | undefined } {
  if (
    current.id !== original.runId ||
    current.workflowId !== original.workflow.id ||
    !sameRepository(current.repository, original.repository) ||
    !sameRepository(current.headRepository, original.headRepository) ||
    current.headSha !== original.headSha ||
    current.event !== 'pull_request' ||
    !isDependabot(current.actor) ||
    current.actor.id !== original.actorId
  )
    return failure('run', 'mismatch');
  if (current.attempt > original.runAttempt) return { kind: 'obsolete' };
  if (current.attempt !== original.runAttempt || current.status !== 'completed')
    return failure('run', 'mismatch');
  if (current.conclusion === null) return failure('run');
  if (current.conclusion !== original.conclusion) return failure('run', 'mismatch');
  if (current.associations.length > 1) return failure('run', 'mismatch');
  const currentAssociation = current.associations[0];
  if (
    currentAssociation &&
    !associatedWith(
      currentAssociation,
      original.pullNumber,
      original.repository,
      original.headRepository,
    )
  )
    return failure('run', 'mismatch');
  return { kind: 'current', association: currentAssociation };
}

function pullRequestMatchesBinding(pr: PullRequest, original: ReviewBinding): boolean {
  return (
    pr.number === original.pullNumber &&
    sameRepository(pr.repository, original.repository) &&
    sameRepository(pr.headRepository, original.headRepository) &&
    isDependabot(pr.actor) &&
    pr.actor.id === original.actorId
  );
}

export type PullRequestState =
  | { kind: 'current' }
  | { kind: 'obsolete' }
  | { kind: 'compare'; baseSha: string }
  | VerificationError;

/** Classify an observed PR without rebinding; a moved base needs its own comparison. */
export function classifyPullRequest(
  bindingValue: unknown,
  value: unknown,
  comparison?: { value: unknown },
): PullRequestState {
  try {
    const original = parseReviewBinding(bindingValue);
    if (!original) return failure('binding');
    const pr = pullRequest(value);
    if (!pr) return failure('pullRequest');
    if (!pullRequestMatchesBinding(pr, original)) return failure('pullRequest', 'mismatch');
    if (pr.closed || pr.headSha !== original.headSha || pr.baseRef !== original.baseRef)
      return { kind: 'obsolete' };
    if (pr.baseSha === original.baseSha) return { kind: 'current' };
    if (!comparison) return { kind: 'compare', baseSha: pr.baseSha };
    const mergeBaseSha = comparisonMergeBase(comparison.value, pr.baseSha);
    if (!mergeBaseSha) return failure('comparison');
    return { kind: mergeBaseSha === original.mergeBaseSha ? 'current' : 'obsolete' };
  } catch {
    return failure('pullRequest');
  }
}

/** Recheck an owned attempt after claiming. W2 must separately verify exclusive ownership. */
export async function reverifyReviewBinding(
  value: unknown,
  reads: FreshnessReads,
): Promise<FreshnessResult> {
  try {
    const original = parseReviewBinding(value);
    if (!original) return failure('binding');
    const runRead = await read('run', () => reads.readRun(original.repository, original.runId));
    if (!runRead.ok) return runRead.error;
    const current = run(runRead.value);
    if (!current) return failure('run');
    const checkedRun = verifyBoundRun(current, original);
    if (checkedRun.kind !== 'current') return checkedRun;
    const currentAssociation = checkedRun.association;
    const prRead = await read('pullRequest', () =>
      reads.readPullRequest(original.repository, original.pullNumber),
    );
    if (!prRead.ok) return prRead.error;
    const state = classifyPullRequest(original, prRead.value);
    if (state.kind === 'obsolete' || state.kind === 'error') return state;
    if (!currentAssociation || currentAssociation.headSha !== original.headSha)
      return failure('run', 'mismatch');
    if (state.kind === 'compare') {
      const comparison = await read('comparison', () =>
        reads.readComparison(original.repository, state.baseSha, original.headSha),
      );
      if (!comparison.ok) return comparison.error;
      const checked = classifyPullRequest(original, prRead.value, { value: comparison.value });
      if (checked.kind === 'obsolete' || checked.kind === 'error') return checked;
    }
    return { kind: 'fresh' };
  } catch {
    return failure('binding');
  }
}
