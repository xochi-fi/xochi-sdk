import type { Address } from "viem";
import { validateSubmitter } from "./validate.js";

/**
 * MEMBERSHIP proof inputs.
 *
 * Per audit fix H-3, the leaf is bound to the submitter:
 *   leaf = leaf_hash_subject(submitter, set_id, subjectSalt)
 *
 * Tree publishers MUST construct each leaf as
 *   leaf_hash_subject(member_address, set_id, salt_for_that_member)
 * and supply each user's `subjectSalt` (or `0` for public sets such as
 * unsalted whitelists).
 */
export interface MembershipInput {
  /**
   * Per-user salt provided by the tree publisher (defaults to "0" for public sets).
   * Same salt that was used when constructing the user's leaf.
   */
  subjectSalt?: string;
  merkleIndex: string;
  merklePath: string[];
  merkleRoot: string;
  setId: string;
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export function buildMembershipInputs(opts: MembershipInput): Record<string, string | string[]> {
  if (opts.merklePath.length !== 20) {
    throw new Error(`Merkle path must have 20 elements, got ${String(opts.merklePath.length)}`);
  }
  validateSubmitter(opts.submitter);

  return {
    subject_salt: opts.subjectSalt ?? "0",
    merkle_index: opts.merkleIndex,
    merkle_path: opts.merklePath,
    merkle_root: opts.merkleRoot,
    set_id: opts.setId,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    is_member: "1",
    submitter: opts.submitter,
  };
}
