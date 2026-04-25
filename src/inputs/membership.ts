import type { Address } from "viem";
import { validateSubmitter } from "./validate.js";

export interface MembershipInput {
  element: string;
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
    element: opts.element,
    merkle_index: opts.merkleIndex,
    merkle_path: opts.merklePath,
    merkle_root: opts.merkleRoot,
    set_id: opts.setId,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    is_member: "1",
    submitter: opts.submitter,
  };
}
