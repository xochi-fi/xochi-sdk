import type { Address } from "viem";
import { validateCredentialType, validateSubmitter, validateTimestamp } from "./validate.js";

/**
 * ATTESTATION proof inputs (post-audit C-1 redesign).
 *
 * The circuit no longer takes a "providers tree" path. Instead it proves
 * inclusion of `leaf_hash_value(credential_hash)` in the provider's per-provider
 * credentials Merkle tree, where:
 *
 *   credential_hash = H(DOMAIN_CREDENTIAL,
 *                       provider_id,
 *                       submitter,
 *                       credential_type,
 *                       credential_attribute,
 *                       expiry_timestamp)
 *
 * The hash binds the credential to a SPECIFIC submitter at issuance time.
 * Forging a credential requires producing a Merkle path to a leaf in the
 * registered tree, which only the provider's authorized publisher can publish
 * via Oracle.publishCredentialRoot.
 *
 * Tree-publisher convention: each leaf in the credentials tree is computed as
 *   leaf_hash_value(credential_hash)
 * The provider issues a credential by adding such a leaf and publishing the
 * new tree root on-chain.
 */
export interface AttestationInput {
  /** Opaque per-credential attribute (e.g. KYC level). Private input. */
  credentialAttribute: string;
  expiryTimestamp: number;
  merkleIndex: string;
  merklePath: string[];
  providerId: string;
  /** 1 = KYC basic, 4 = institutional (2/3 reserved). */
  credentialType: number;
  /** Per-provider credentials root, currently registered in the Oracle. */
  credentialRoot: string;
  currentTimestamp?: number;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export function buildAttestationInputs(opts: AttestationInput): Record<string, string | string[]> {
  if (opts.merklePath.length !== 20) {
    throw new Error(
      `Merkle path must have 20 elements, got ${String(opts.merklePath.length)}`,
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
    credential_attribute: opts.credentialAttribute,
    expiry_timestamp: String(opts.expiryTimestamp),
    merkle_index: opts.merkleIndex,
    merkle_path: opts.merklePath,
    provider_id: opts.providerId,
    credential_type: String(opts.credentialType),
    is_valid: "1",
    credential_root: opts.credentialRoot,
    current_timestamp: String(currentTimestamp),
    submitter: opts.submitter,
  };
}
