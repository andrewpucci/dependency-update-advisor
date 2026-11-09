import type { ReviewIdentity as EventReviewIdentity } from './event.js';

export type ReviewIdentity = EventReviewIdentity;
export type ReviewOutcomeKind =
  | 'skipped'
  | 'stale'
  | 'invalid-config'
  | 'incomplete-evidence'
  | 'model-unavailable'
  | 'complete'
  | 'internal-failure';
export type ReviewOutcome = Readonly<{
  kind: ReviewOutcomeKind;
  status: 'none' | 'failure' | 'success';
  comment: 'none' | 'eligible';
}>;
export type OwnedClaim = Readonly<{
  kind: 'owned';
  identity: ReviewIdentity;
  owner: string;
  generation: number;
}>;
export type ClaimResult = OwnedClaim | Readonly<{ kind: 'duplicate'; identity: ReviewIdentity }>;
export type ClaimState =
  | OwnedClaim
  | Readonly<{
      kind: 'lost' | 'completed';
      identity: ReviewIdentity;
      generation: number;
    }>;
export type ReplayState = Readonly<{
  identity: ReviewIdentity;
  state: 'unseen' | 'claimed' | 'completed';
}>;
export type ClaimStore = Readonly<{
  /** Reports whether this exact attempt was already seen, without claiming it. */
  replay: (identity: ReviewIdentity) => Promise<ReplayState>;
  claim: (identity: ReviewIdentity) => Promise<ClaimResult>;
  read: (claim: OwnedClaim) => Promise<ClaimState>;
  abandon: (claim: OwnedClaim) => Promise<void>;
  complete: (claim: OwnedClaim) => Promise<void>;
}>;

const outcomeEligibility: Readonly<Record<ReviewOutcomeKind, ReviewOutcome>> = Object.freeze({
  skipped: { kind: 'skipped', status: 'none', comment: 'none' },
  stale: { kind: 'stale', status: 'none', comment: 'none' },
  'invalid-config': { kind: 'invalid-config', status: 'failure', comment: 'none' },
  'incomplete-evidence': { kind: 'incomplete-evidence', status: 'failure', comment: 'eligible' },
  'model-unavailable': { kind: 'model-unavailable', status: 'failure', comment: 'none' },
  complete: { kind: 'complete', status: 'success', comment: 'eligible' },
  'internal-failure': { kind: 'internal-failure', status: 'failure', comment: 'none' },
});

function copyIdentity(identity: ReviewIdentity): ReviewIdentity {
  return Object.freeze([...identity]) as ReviewIdentity;
}

function identityKey(identity: ReviewIdentity): string {
  return JSON.stringify(identity);
}

function ownerKey(identity: ReviewIdentity): string {
  return JSON.stringify([identity[0], identity[1], identity[4]]);
}

type StoredClaim = {
  identity: ReviewIdentity;
  owner: string;
  generation: number;
  state: 'owned' | 'lost' | 'completed';
};

export function reviewOutcome(kind: ReviewOutcomeKind): ReviewOutcome {
  return outcomeEligibility[kind];
}

export function createTestClaimStore(): ClaimStore {
  const records = new Map<string, StoredClaim>();
  const current = new Map<string, string>();
  const generations = new Map<string, number>();
  let nextOwner = 0;

  const read = async (claim: OwnedClaim): Promise<ClaimState> => {
    const record = records.get(identityKey(claim.identity));
    if (!record || record.owner !== claim.owner || record.generation !== claim.generation)
      return { kind: 'lost', identity: copyIdentity(claim.identity), generation: claim.generation };
    if (record.state === 'owned')
      return {
        kind: 'owned',
        identity: copyIdentity(record.identity),
        owner: record.owner,
        generation: record.generation,
      };
    return {
      kind: record.state,
      identity: copyIdentity(record.identity),
      generation: record.generation,
    };
  };

  return Object.freeze({
    replay: async (value) => {
      const identity = copyIdentity(value);
      const record = records.get(identityKey(identity));
      return {
        identity,
        state: !record ? 'unseen' : record.state === 'completed' ? 'completed' : 'claimed',
      };
    },
    claim: async (value) => {
      const identity = copyIdentity(value);
      const key = identityKey(identity);
      if (records.has(key)) return { kind: 'duplicate', identity };
      const group = ownerKey(identity);
      const previous = current.get(group);
      if (previous) {
        const record = records.get(previous);
        if (record?.state === 'owned') record.state = 'lost';
      }
      const generation = (generations.get(group) ?? 0) + 1;
      const owner = 'test-owner-' + ++nextOwner;
      records.set(key, { identity, owner, generation, state: 'owned' });
      current.set(group, key);
      generations.set(group, generation);
      return { kind: 'owned', identity, owner, generation };
    },
    read,
    abandon: async (claim) => {
      const record = records.get(identityKey(claim.identity));
      if (record?.owner === claim.owner && record.generation === claim.generation)
        record.state = 'lost';
    },
    complete: async (claim) => {
      const record = records.get(identityKey(claim.identity));
      if (record?.owner === claim.owner && record.generation === claim.generation)
        record.state = 'completed';
    },
  });
}
