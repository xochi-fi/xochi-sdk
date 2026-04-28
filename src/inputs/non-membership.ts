import type { Address } from "viem";
import { validateSubmitter } from "./validate.js";

/**
 * NON_MEMBERSHIP proof inputs.
 *
 * Per audit fixes H-3, M-2, and H-4:
 *
 * - The value being proven non-member IS the submitter (no separate `element`).
 *   The circuit asserts `low_leaf < submitter < high_leaf` using full Field
 *   ordering (no u64 ceiling), so any 254-bit Field value compares correctly.
 *
 * - The tree leaves are `leaf_hash_subject(value, set_id, salt)` -- the same
 *   format as the membership tree. Salts MAY be 0 for public sets (e.g. OFAC).
 *
 * - The circuit additionally requires `highIndex == lowIndex + 1`. Tree
 *   publishers MUST sort leaves by raw value and SHOULD insert sentinel
 *   boundary leaves at 0 and (BN254 prime - 1) so every submitter has
 *   well-defined neighbors.
 */
export interface NonMembershipInput {
  lowLeaf: string;
  /** Per-leaf salt for low_leaf (use "0" for public sets). */
  lowLeafSalt?: string;
  lowIndex: string;
  lowPath: string[];
  highLeaf: string;
  /** Per-leaf salt for high_leaf (use "0" for public sets). */
  highLeafSalt?: string;
  /** MUST be `String(BigInt(lowIndex) + 1n)` -- adjacency is enforced in-circuit. */
  highIndex: string;
  highPath: string[];
  merkleRoot: string;
  setId: string;
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export function buildNonMembershipInputs(
  opts: NonMembershipInput,
): Record<string, string | string[]> {
  if (opts.lowPath.length !== 20 || opts.highPath.length !== 20) {
    throw new Error("Merkle paths must have 20 elements each");
  }
  validateSubmitter(opts.submitter);

  // Defensive client-side adjacency check. The circuit will also enforce this,
  // but failing fast off-chain saves the user from a wasted proof generation.
  const expectedHigh = (BigInt(opts.lowIndex) + 1n).toString();
  if (BigInt(opts.highIndex).toString() !== expectedHigh) {
    throw new Error(
      `Non-membership requires adjacency: highIndex must equal lowIndex+1 (got ${opts.lowIndex} -> ${opts.highIndex})`,
    );
  }

  return {
    low_leaf: opts.lowLeaf,
    low_leaf_salt: opts.lowLeafSalt ?? "0",
    low_index: opts.lowIndex,
    low_path: opts.lowPath,
    high_leaf: opts.highLeaf,
    high_leaf_salt: opts.highLeafSalt ?? "0",
    high_index: opts.highIndex,
    high_path: opts.highPath,
    merkle_root: opts.merkleRoot,
    set_id: opts.setId,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    is_non_member: "1",
    submitter: opts.submitter,
  };
}
