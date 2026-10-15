/**
 * Credential-root publication signing.
 *
 * A provider-controlled `DigestSigner` (normally a non-exportable KMS/HSM
 * key, distinct from the publisher EOA) signs an EIP-712
 * `CredentialRootPublication`. The Oracle verifies the signature on-chain via
 * `ecrecover`; a compromised publisher EOA alone cannot mint roots.
 */

import { keccak256 } from "viem";

import { credentialRootDigest, cidHash } from "./eip712.js";
import { validatedSignDigest, type DigestSigner } from "./keystore.js";
import { fieldToBytes } from "./pedersen.js";

/** Inputs to a credential-root publication signature. */
export interface SignCredentialRootRequest {
  /** EVM chain ID where the Oracle lives. */
  chainId: bigint;
  /** ERC8262Oracle deployment address. */
  oracleAddress: `0x${string}`;
  /** Provider this credential tree belongs to. */
  providerId: bigint;
  /** New credential merkle root. */
  root: `0x${string}`;
  /** IPFS / Arweave CID for the tree contents (binds via keccak in the signed struct). */
  cid: string;
  /** Unix timestamp; signature is invalid before this. */
  notBefore: bigint;
  /** Unix timestamp; signature is invalid after this. */
  notAfter: bigint;
}

export interface SignCredentialRootResult {
  /** 65-byte ECDSA signature (r || s || v) ready for `publishCredentialRoot`. */
  signature: Uint8Array;
  /** 32-byte EIP-712 digest the signature is over (audit log hook). */
  digest: Uint8Array;
  /** The signer address recovered from the key (sanity check vs registry). */
  signer: `0x${string}`;
}

function ethereumAddressFromPubkey(x: Uint8Array, y: Uint8Array): `0x${string}` {
  // Ethereum address = last 20 bytes of keccak256(uncompressed pubkey x || y).
  const concat = new Uint8Array(64);
  concat.set(x, 0);
  concat.set(y, 32);
  const digest = keccak256(concat);
  return ("0x" + digest.slice(-40)) as `0x${string}`;
}

/**
 * Asynchronously sign a CredentialRootPublication.
 *
 * Digest construction and validation are local. `DigestSigner.signDigest` may
 * perform remote I/O; its adapter owns authentication, timeout, cancellation,
 * retry, DER decoding and low-S normalization. Adapter failures propagate.
 * Retrying the digest is safe. This function has no replay ledger; callers
 * requiring byte-identical retries must retain the result themselves.
 */
export async function signCredentialRoot(
  signer: DigestSigner,
  req: SignCredentialRootRequest,
): Promise<SignCredentialRootResult> {
  const digestHex = credentialRootDigest({
    chainId: req.chainId,
    oracleAddress: req.oracleAddress,
    publication: {
      providerId: req.providerId,
      root: req.root,
      cidHash: cidHash(req.cid),
      notBefore: req.notBefore,
      notAfter: req.notAfter,
    },
  });
  const digest = fieldToBytes(BigInt(digestHex));
  const signed = await validatedSignDigest(signer, digest);
  const signature = new Uint8Array(65);
  signature.set(signed.signature, 0);
  signature[64] = 27 + signed.recovery;
  return {
    signature,
    digest: digest.slice(),
    signer: ethereumAddressFromPubkey(signed.publicKeyX, signed.publicKeyY),
  };
}
