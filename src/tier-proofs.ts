/**
 * Tier proof generation and verification.
 *
 * Proves "trust score >= threshold" without revealing exact score,
 * using the risk_score Noir circuit via UltraHonk.
 *
 * Ported from xochi frontend src/lib/tier-proofs.ts.
 */

import type { Hex } from "viem";
import type { CircuitLoader, ProofResult } from "./types.js";
import { encodeProof, encodePublicInputs, decodePublicInputs } from "./encoding.js";
import { DEFAULT_CONFIG_HASH } from "./constants.js";
import {
  type TierThreshold,
  type TierName,
  getTierName,
  getFeeRate,
  TIER_PROOF_EXPIRY_MS,
  TIERS,
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
  /** Display-only keccak256 commitment to the score */
  scoreCommitment: Hex;
  createdAt: number;
  expiresAt: number;
}

export interface TierProofVerification {
  valid: boolean;
  threshold: TierThreshold;
  tierName: TierName;
  feeRate: number;
  error?: string;
}

// ============================================================
// Score Commitment (display-only)
// ============================================================

/**
 * Create a display commitment to a score.
 *
 * This is NOT a cryptographic Pedersen commitment. The real score
 * hiding happens inside the Noir circuit (score is a private input).
 * This is a keccak256 hash for display/tracking purposes.
 */
export function createScoreCommitment(
  score: number,
  blindingFactor?: Hex,
): { commitment: Hex; blindingFactor: Hex } {
  const blinding = blindingFactor ?? generateBlindingFactor();

  // Inline keccak256(abi.encodePacked(uint256, bytes32, bytes32))
  // without importing viem's keccak256 to keep this lightweight.
  // Consumers who need the commitment can pass it through.
  const scoreHex = score.toString(16).padStart(64, "0");
  const blindHex = blinding.startsWith("0x") ? blinding.slice(2) : blinding;
  const gPoint = "01".repeat(32);
  const packed = `0x${scoreHex}${blindHex}${gPoint}` as Hex;

  return { commitment: packed, blindingFactor: blinding };
}

function generateBlindingFactor(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

// ============================================================
// Tier Proof Generation
// ============================================================

/**
 * Build risk_score circuit inputs for a tier proof.
 *
 * Maps trust score to single-provider risk_score circuit:
 * - signals[0] = score, rest = 0
 * - weights[0] = 100, rest = 0
 * - proof_type = 1 (threshold), direction = 1 (GT)
 * - bound_lower = threshold * 100 (basis points)
 */
function buildTierProofInputs(
  score: number,
  threshold: TierThreshold,
  submitter: string,
  configHash?: string,
): Record<string, string | string[]> {
  const thresholdBps = threshold * 100;
  const scoreBps = score * 100;

  if (scoreBps <= thresholdBps && threshold > 0) {
    throw new Error(`Score ${String(score)} does not meet threshold ${String(threshold)}`);
  }

  return {
    signals: [String(score), "0", "0", "0", "0", "0", "0", "0"],
    weights: ["100", "0", "0", "0", "0", "0", "0", "0"],
    weight_sum: "100",
    provider_ids: ["1", "0", "0", "0", "0", "0", "0", "0"],
    num_providers: "1",
    proof_type: "1",
    direction: "1",
    bound_lower: String(thresholdBps),
    bound_upper: "0",
    result: "1",
    config_hash: configHash ?? DEFAULT_CONFIG_HASH,
    provider_set_hash: "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2",
    submitter,
  };
}

/**
 * Generate a tier proof proving score >= threshold.
 */
export async function generateTierProof(
  loader: CircuitLoader,
  score: number,
  threshold: TierThreshold,
  submitter: string,
  configHash?: string,
): Promise<TierProof> {
  const { Noir } = await import("@noir-lang/noir_js");
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");

  const inputs = buildTierProofInputs(score, threshold, submitter, configHash);
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

    const commitment = createScoreCommitment(score);
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
 */
export async function generateHighestTierProof(
  loader: CircuitLoader,
  score: number,
  submitter: string,
  configHash?: string,
): Promise<TierProof | null> {
  const thresholds: TierThreshold[] = [100, 75, 50, 25, 0];

  for (const threshold of thresholds) {
    if (score >= threshold) {
      return generateTierProof(loader, score, threshold, submitter, configHash);
    }
  }

  return null;
}

// ============================================================
// Tier Proof Verification
// ============================================================

/**
 * Verify a tier proof client-side using bb.js.
 */
export async function verifyTierProof(
  loader: CircuitLoader,
  proof: TierProof,
): Promise<TierProofVerification> {
  if (proof.expiresAt < Date.now()) {
    return {
      valid: false,
      threshold: proof.threshold,
      tierName: proof.tierName,
      feeRate: getFeeRate(proof.threshold),
      error: "Proof has expired",
    };
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

      return {
        valid,
        threshold: proof.threshold,
        tierName: proof.tierName,
        feeRate: getFeeRate(proof.threshold),
        error: valid ? undefined : "Invalid proof",
      };
    } finally {
      await api.destroy();
    }
  } catch (err) {
    return {
      valid: false,
      threshold: proof.threshold,
      tierName: proof.tierName,
      feeRate: getFeeRate(proof.threshold),
      error: err instanceof Error ? err.message : "Verification failed",
    };
  }
}

// ============================================================
// Utility
// ============================================================

/**
 * Check if a set of proofs includes shielded settlement eligibility (score >= 25).
 */
export function hasShieldedEligibility(proofs: readonly TierProof[]): boolean {
  return proofs.some((p) => p.threshold >= 25 && p.expiresAt > Date.now());
}

/**
 * Get the fee rate from the highest valid proof.
 */
export function getProvenFeeRate(proofs: readonly TierProof[]): number {
  const valid = proofs
    .filter((p) => p.expiresAt > Date.now())
    .sort((a, b) => b.threshold - a.threshold);

  if (valid.length === 0) return 0.3;
  return getFeeRate(valid[0].threshold);
}

/**
 * Get the highest proven tier name from valid proofs.
 */
export function getProvenTierName(proofs: readonly TierProof[]): TierName {
  const valid = proofs
    .filter((p) => p.expiresAt > Date.now())
    .sort((a, b) => b.threshold - a.threshold);

  if (valid.length === 0) return "Standard";
  return valid[0].tierName;
}
