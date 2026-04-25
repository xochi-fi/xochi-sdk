import type { Address } from "viem";
import { validateCredentialType, validateSubmitter, validateTimestamp } from "./validate.js";

export interface AttestationInput {
  credentialHash: string;
  credentialSubject: string;
  credentialAttribute: string;
  expiryTimestamp: number;
  providerMerkleIndex: string;
  providerMerklePath: string[];
  providerId: string;
  credentialType: number; // 1=KYC basic, 4=institutional
  merkleRoot: string;
  currentTimestamp?: number;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export function buildAttestationInputs(opts: AttestationInput): Record<string, string | string[]> {
  if (opts.providerMerklePath.length !== 20) {
    throw new Error(
      `Provider merkle path must have 20 elements, got ${String(opts.providerMerklePath.length)}`,
    );
  }

  const currentTimestamp = opts.currentTimestamp ?? Math.floor(Date.now() / 1000);

  validateCredentialType(opts.credentialType);
  validateTimestamp(currentTimestamp);
  validateSubmitter(opts.submitter);

  if (currentTimestamp >= opts.expiryTimestamp) {
    throw new Error("Credential has expired");
  }

  return {
    credential_hash: opts.credentialHash,
    credential_subject: opts.credentialSubject,
    credential_attribute: opts.credentialAttribute,
    expiry_timestamp: String(opts.expiryTimestamp),
    provider_merkle_index: opts.providerMerkleIndex,
    provider_merkle_path: opts.providerMerklePath,
    provider_id: opts.providerId,
    credential_type: String(opts.credentialType),
    is_valid: "1",
    merkle_root: opts.merkleRoot,
    current_timestamp: String(currentTimestamp),
    submitter: opts.submitter,
  };
}
