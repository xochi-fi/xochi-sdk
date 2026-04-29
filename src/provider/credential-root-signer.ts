/**
 * Credential-root publication signing.
 *
 * The provider's signing key (held in HSM/KMS, distinct from the publisher EOA)
 * signs an EIP-712 `CredentialRootPublication` struct. The Oracle verifies the
 * signature on-chain via `ecrecover` at `publishCredentialRoot` time. A
 * compromised publisher EOA alone can no longer mint credential roots, since
 * they do not hold the signing key.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256 } from "viem";

import { credentialRootDigest, cidHash } from "./eip712.js";
import { fieldToBytes } from "./pedersen.js";
import type { SignerKey } from "./keystore.js";

/** Inputs to a credential-root publication signature. */
export interface SignCredentialRootRequest {
  /** EVM chain ID where the Oracle lives. */
  chainId: bigint;
  /** XochiZKPOracle deployment address. */
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

/** Sign a CredentialRootPublication. Pure compute. */
export function signCredentialRoot(
  key: SignerKey,
  req: SignCredentialRootRequest,
): SignCredentialRootResult {
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
  const sig = secp256k1.sign(digest, key.privateKey, { lowS: true });
  const compact = sig.toCompactRawBytes(); // 64 bytes: r || s
  const recovery = sig.recovery; // 0 or 1
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = 27 + (recovery ?? 0);
  return {
    signature: out,
    digest,
    signer: ethereumAddressFromPubkey(key.publicKeyX, key.publicKeyY),
  };
}
