/**
 * Tier proof generation and verification.
 *
 * Proves "trust score >= threshold" without revealing exact score,
 * using the risk_score Noir circuit via UltraHonk.
 *
 * Trust model: the risk_score signals are private and unsigned, so a tier
 * proof shows only that the prover knows a score meeting the threshold under
 * the committed config. It is not provider-attested; a verifier granting fees
 * or privacy access must still bind the score to an authoritative source.
 *
 * Ported from xochi frontend src/lib/tier-proofs.ts.
 */

import { bytesToHex, encodePacked, keccak256, type Address, type Hex } from "viem";
import type { CircuitLoader } from "./types.js";
import { encodeProof, encodePublicInputs } from "./encoding.js";
import { DEFAULT_CONFIG_HASH, PROOF_TYPES, PUBLIC_INPUT_COUNTS } from "./constants.js";
import { validateSubmitter } from "./inputs/validate.js";
import {
  type TierThreshold,
  type TierName,
  getTierName,
  getFeeRate,
  TIER_PROOF_EXPIRY_MS,
  SHIELDED_MIN_SCORE,
} from "./tiers.js";

export type { TierThreshold };

// ============================================================
// Types
// ============================================================

export interface TierProof {
  threshold: TierThreshold;
  tierName: TierName;
  /** UltraHonk proof bytes (hex) */
  proofHex: Hex;
  /** Public inputs (hex, 32-byte padded concatenated) */
  publicInputsHex: Hex;
  /** Raw proof bytes */
  proof: Uint8Array;
  /** Raw public inputs */
  publicInputs: string[];
  /** keccak256(abi.encodePacked(uint256 score, bytes32 blindingFactor)); reveals neither */
  scoreCommitment: Hex;
  /**
   * Prover-side bookkeeping only. risk_score has no timestamp public input, so
   * these are not bound to the proof: `verifyTierProof` ignores them and a
   * verifier must track freshness from its own verification time.
   */
  createdAt: number;
  expiresAt: number;
}

export interface TierProofVerification {
  /**
   * bb.js accepted the proof AND its public inputs encode a tier claim bound
   * to the expected submitter and config.
   */
  valid: boolean;
  /** Threshold the public inputs prove (0 when invalid); never the caller's label. */
  threshold: TierThreshold;
  tierName: TierName;
  feeRate: number;
  error?: string;
}

export interface TierProofExpectations {
  /** Address the proof must be bound to (the circuit's `submitter` public input). */
  submitter: Address;
  /** Config hash the proof must commit to (default DEFAULT_CONFIG_HASH). */
  configHash?: Hex;
}

type ProvableTierThreshold = Exclude<TierThreshold, 0>;

// ============================================================
// Tier claim encoding
// ============================================================

/**
 * Thresholds a tier proof can attest, highest first. Standard (0) is the
 * default and has no proof: "score >= 0" would need bound_lower = -1, and the
 * Oracle rejects "score > 0" as TrivialRiskBound.
 */
const PROVABLE_THRESHOLDS: readonly ProvableTierThreshold[] = [100, 75, 50, 25];

/** Provider set hash of the fixed tier-proof witness (provider id 1, weight 100). */
const TIER_PROVIDER_SET_HASH =
  "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2" as Hex;

// risk_score public-input order (ERC-8262 circuits/risk_score/src/main.nr)
const PI_PROOF_TYPE = 0;
const PI_DIRECTION = 1;
const PI_BOUND_LOWER = 2;
const PI_BOUND_UPPER = 3;
const PI_RESULT = 4;
const PI_CONFIG_HASH = 5;
const PI_PROVIDER_SET_HASH = 6;
const PI_SUBMITTER = 7;

const RISK_PROOF_THRESHOLD = 1n;
const DIRECTION_GT = 1n;

/**
 * bound_lower for tier threshold T. The circuit proves `score_bps > bound_lower`
 * with score_bps = signal * 100 for the single-provider witness, so T*100 - 1
 * makes the strict comparison mean "score >= T" for integer scores. For T in
 * 25..100 it lies in (0, 10000), which the Oracle's `_validateRiskBounds`
 * accepts; T = 100 proves with signal 100 (10000 > 9999).
 */
function tierBoundLower(threshold: ProvableTierThreshold): number {
  return threshold * 100 - 1;
}

function isProvableThreshold(value: number): value is ProvableTierThreshold {
  return (PROVABLE_THRESHOLDS as readonly number[]).includes(value);
}

interface TierClaim {
  threshold: ProvableTierThreshold;
  configHash: bigint;
  providerSetHash: bigint;
  submitter: bigint;
}

/** Parse the tier-claim shape from risk_score public inputs, or describe why it is not one. */
function readTierClaim(publicInputs: readonly string[]): TierClaim | { error: string } {
  const expectedCount = PUBLIC_INPUT_COUNTS[PROOF_TYPES.RISK_SCORE];
  if (publicInputs.length !== expectedCount) {
    return {
      error: `Expected ${String(expectedCount)} risk_score public inputs, got ${String(publicInputs.length)}`,
    };
  }
  const bad = publicInputs.findIndex((w) => !/^0x[0-9a-fA-F]{1,64}$/.test(w));
  if (bad !== -1) {
    return { error: `Public input ${String(bad)} is not a 0x-prefixed field element` };
  }
  const pi = publicInputs.map((w) => BigInt(w));

  const fixed: Array<[number, bigint, string]> = [
    [PI_PROOF_TYPE, RISK_PROOF_THRESHOLD, "proof_type"],
    [PI_DIRECTION, DIRECTION_GT, "direction"],
    [PI_RESULT, 1n, "result"],
    [PI_BOUND_UPPER, 0n, "bound_upper"],
  ];
  for (const [index, want, name] of fixed) {
    if (pi[index] !== want) {
      return { error: `${name} is ${String(pi[index])}, expected ${String(want)}` };
    }
  }

  const boundLower = pi[PI_BOUND_LOWER];
  const threshold = Number((boundLower + 1n) / 100n);
  if ((boundLower + 1n) % 100n !== 0n || !isProvableThreshold(threshold)) {
    return {
      error: `bound_lower ${String(boundLower)} does not encode a tier threshold (T*100 - 1 for T in 25, 50, 75, 100)`,
    };
  }

  return {
    threshold,
    configHash: pi[PI_CONFIG_HASH],
    providerSetHash: pi[PI_PROVIDER_SET_HASH],
    submitter: pi[PI_SUBMITTER],
  };
}

/**
 * Decode and check the tier claim in risk_score public inputs.
 *
 * Requires the exact tier-proof encoding (threshold proof, direction GT,
 * result true, bound_upper 0, bound_lower = T*100 - 1), the fixed tier-proof
 * provider set, and the expected config hash and submitter. Returns the proven
 * threshold; throws describing the first mismatch.
 *
 * Does NOT verify the proof itself. Pair it with `verifyTierProof`, or with an
 * on-chain verification whose `publicInputs` it reads (`OracleLite.verifyProof`).
 */
export function decodeTierProofClaim(
  publicInputs: readonly string[],
  expected: TierProofExpectations,
): TierThreshold {
  validateSubmitter(expected.submitter);
  const claim = readTierClaim(publicInputs);
  if ("error" in claim) throw new Error(claim.error);

  const configHash = expected.configHash ?? DEFAULT_CONFIG_HASH;
  if (claim.configHash !== BigInt(configHash)) {
    throw new Error(`config_hash does not match the expected ${configHash}`);
  }
  if (claim.providerSetHash !== BigInt(TIER_PROVIDER_SET_HASH)) {
    throw new Error("provider_set_hash is not the tier-proof provider set");
  }
  if (claim.submitter !== BigInt(expected.submitter)) {
    throw new Error(`submitter does not match the expected ${expected.submitter}`);
  }
  return claim.threshold;
}

// ============================================================
// Score Commitment (display-only)
// ============================================================

/**
 * Create a display commitment to a score:
 * `keccak256(abi.encodePacked(uint256 score, bytes32 blindingFactor))`.
 *
 * This is NOT a Pedersen commitment and nothing verifies it against the proof;
 * the real score hiding happens inside the Noir circuit (score is a private
 * input). Keep `blindingFactor` secret: with it the score is brute-forceable.
 */
export function createScoreCommitment(
  score: number,
  blindingFactor?: Hex,
): { commitment: Hex; blindingFactor: Hex } {
  if (!Number.isSafeInteger(score) || score < 0) {
    throw new Error(`score must be a non-negative integer, got ${String(score)}`);
  }
  const blinding = blindingFactor ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  if (!/^0x[0-9a-fA-F]{64}$/.test(blinding)) {
    throw new Error("blindingFactor must be 32 bytes of 0x-prefixed hex");
  }
  const commitment = keccak256(encodePacked(["uint256", "bytes32"], [BigInt(score), blinding]));
  return { commitment, blindingFactor: blinding };
}

// ============================================================
// Tier Proof Generation
// ============================================================

function assertScore(score: number): void {
  if (!Number.isFinite(score) || score < 0) {
    throw new Error(`Score must be a finite non-negative number, got ${String(score)}`);
  }
}

/**
 * Generate a tier proof proving score >= threshold.
 *
 * `threshold` must be 25, 50, 75 or 100 (Standard needs no proof). Fractional
 * scores round down and scores above 100 prove as 100: circuit signals are
 * integers capped at 100, and Institutional is the 100+ tier.
 */
export async function generateTierProof(
  loader: CircuitLoader,
  score: number,
  threshold: TierThreshold,
  submitter: Address,
  configHash?: string,
): Promise<TierProof> {
  assertScore(score);
  if (!isProvableThreshold(threshold)) {
    throw new Error(
      threshold === 0
        ? "Standard (threshold 0) is the default tier and has no proof; the Oracle rejects a 'score > 0' claim as TrivialRiskBound"
        : `Invalid tier threshold ${String(threshold)}: expected 25, 50, 75 or 100`,
    );
  }
  validateSubmitter(submitter);

  const signal = Math.min(Math.floor(score), 100);
  const boundLower = tierBoundLower(threshold);
  if (signal * 100 <= boundLower) {
    throw new Error(`Score ${String(score)} does not meet threshold ${String(threshold)}`);
  }

  const { Noir } = await import("@noir-lang/noir_js");
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");

  // Single-provider risk_score witness: signals[0] = score, weights[0] = 100,
  // threshold proof (proof_type 1), direction GT, bound_lower = T*100 - 1.
  const inputs = {
    signals: [String(signal), "0", "0", "0", "0", "0", "0", "0"],
    weights: ["100", "0", "0", "0", "0", "0", "0", "0"],
    weight_sum: "100",
    provider_ids: ["1", "0", "0", "0", "0", "0", "0", "0"],
    num_providers: "1",
    proof_type: String(RISK_PROOF_THRESHOLD),
    direction: String(DIRECTION_GT),
    bound_lower: String(boundLower),
    bound_upper: "0",
    result: "1",
    config_hash: configHash ?? DEFAULT_CONFIG_HASH,
    provider_set_hash: TIER_PROVIDER_SET_HASH,
    submitter,
  };
  const circuit = await loader.load("risk_score");
  const api = await Barretenberg.new();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noir = new Noir(circuit as any);
    const backend = new UltraHonkBackend(circuit.bytecode, api);

    const { witness } = await noir.execute(inputs);
    const proofData = await backend.generateProof(witness, {
      verifierTarget: "evm",
    });

    const commitment = createScoreCommitment(Math.floor(score));
    const now = Date.now();

    return {
      threshold,
      tierName: getTierName(threshold),
      proofHex: encodeProof(proofData.proof),
      publicInputsHex: encodePublicInputs(proofData.publicInputs),
      proof: proofData.proof,
      publicInputs: proofData.publicInputs,
      scoreCommitment: commitment.commitment,
      createdAt: now,
      expiresAt: now + TIER_PROOF_EXPIRY_MS,
    };
  } finally {
    await api.destroy();
  }
}

/**
 * Generate a proof for the highest tier the score qualifies for.
 * Returns null below Trusted (25): Standard has no proof.
 */
export async function generateHighestTierProof(
  loader: CircuitLoader,
  score: number,
  submitter: Address,
  configHash?: string,
): Promise<TierProof | null> {
  assertScore(score);
  const threshold = PROVABLE_THRESHOLDS.find((t) => score >= t);
  if (threshold === undefined) return null;
  return generateTierProof(loader, score, threshold, submitter, configHash);
}

// ============================================================
// Tier Proof Verification
// ============================================================

/**
 * Verify a tier proof client-side using bb.js.
 *
 * Valid only when the public inputs encode a tier claim bound to
 * `expected.submitter` and `expected.configHash` (see decodeTierProofClaim),
 * the proof's `threshold` label equals the proven threshold, and bb.js accepts
 * the proof. The returned threshold, tier and fee rate come from the public
 * inputs. `createdAt` / `expiresAt` are ignored (not bound to the proof).
 */
export async function verifyTierProof(
  loader: CircuitLoader,
  proof: TierProof,
  expected: TierProofExpectations,
): Promise<TierProofVerification> {
  const invalid = (error: string): TierProofVerification => ({
    valid: false,
    threshold: 0,
    tierName: getTierName(0),
    feeRate: getFeeRate(0),
    error,
  });

  let threshold: TierThreshold;
  try {
    threshold = decodeTierProofClaim(proof.publicInputs, expected);
  } catch (err) {
    return invalid(err instanceof Error ? err.message : String(err));
  }
  if (proof.threshold !== threshold) {
    return invalid(
      `Proof is labelled threshold ${String(proof.threshold)} but proves ${String(threshold)}`,
    );
  }

  try {
    const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");
    const circuit = await loader.load("risk_score");
    const api = await Barretenberg.new();

    try {
      const backend = new UltraHonkBackend(circuit.bytecode, api);
      const valid = await backend.verifyProof(
        { proof: proof.proof, publicInputs: proof.publicInputs },
        { verifierTarget: "evm" },
      );
      if (!valid) return invalid("Invalid proof");
      return {
        valid: true,
        threshold,
        tierName: getTierName(threshold),
        feeRate: getFeeRate(threshold),
      };
    } finally {
      await api.destroy();
    }
  } catch (err) {
    return invalid(err instanceof Error ? err.message : "Verification failed");
  }
}

// ============================================================
// Utility
// ============================================================

/**
 * Highest threshold among unexpired proofs whose public inputs encode their
 * labelled tier (0 when none). Local bookkeeping over the caller's own proofs:
 * it does not verify them, so run verifyTierProof on anything received from
 * another party first.
 */
function highestProvenThreshold(proofs: readonly TierProof[]): TierThreshold {
  const now = Date.now();
  return proofs
    .filter((p) => p.expiresAt > now)
    .map((p): TierThreshold => {
      const claim = readTierClaim(p.publicInputs);
      return "error" in claim || claim.threshold !== p.threshold ? 0 : claim.threshold;
    })
    .reduce<TierThreshold>((best, t) => (t > best ? t : best), 0);
}

/**
 * Check if a set of proofs includes shielded (Aztec L2) settlement eligibility.
 *
 * Reads SHIELDED_MIN_SCORE rather than a literal. The literal here was 25, the
 * pre-ungating L1-stealth threshold, so this admitted proofs at half the score
 * shielded settlement actually requires.
 */
export function hasShieldedEligibility(proofs: readonly TierProof[]): boolean {
  return highestProvenThreshold(proofs) >= SHIELDED_MIN_SCORE;
}

/**
 * Get the fee rate from the highest valid proof.
 *
 * No valid proof means no proven trust, which is Standard: getFeeRate(0).
 */
export function getProvenFeeRate(proofs: readonly TierProof[]): number {
  return getFeeRate(highestProvenThreshold(proofs));
}

/**
 * Get the highest proven tier name from valid proofs.
 */
export function getProvenTierName(proofs: readonly TierProof[]): TierName {
  return getTierName(highestProvenThreshold(proofs));
}
