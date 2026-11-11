/**
 * Applies the common conservative multi-anchor decision: ambiguity keeps two proofs, a sole
 * reachable anchor may group only with a representable proof, and every other anchor needs an
 * absence verdict. Ecosystem adapters retain their graph, path, and marker semantics.
 */
export function resolveMultiAnchor<C, P, V, O>(
  input: Readonly<{
    candidates: readonly C[];
    reaches: (candidate: C) => boolean;
    noReach: () => O;
    ambiguityProofs: (reaching: readonly C[]) => readonly P[];
    soleProof: (candidate: C) => P | O;
    isProof: (value: P | O) => value is P;
    ambiguous: O;
    unreachable: (candidate: C) => readonly V[];
  }>,
) {
  const verdicts: V[] = [];
  const reaching = input.candidates.filter(input.reaches);
  if (!reaching.length) return { proofs: [] as P[], verdicts, observation: input.noReach() };
  if (reaching.length > 1)
    return {
      proofs: [...input.ambiguityProofs(reaching)],
      verdicts,
      observation: input.ambiguous,
    };
  const proof = input.soleProof(reaching[0]);
  if (!input.isProof(proof)) return { proofs: [] as P[], verdicts, observation: proof };
  for (const candidate of input.candidates)
    if (candidate !== reaching[0]) verdicts.push(...input.unreachable(candidate));
  return { proofs: [proof], verdicts, observation: null };
}
