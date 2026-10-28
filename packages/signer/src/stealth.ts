// ERC-5564 stealth-address crypto for the Xochi gasless claim flow.
//
// Mirrors the recipient-side derivation in Riddler's
// `Riddler.Integrations.Xochi.StealthAccount.derive_stealth_private_key/3` and the
// raw UserOp signing in `Riddler.EVM.ERC4337.UserOperation.sign/3` (v0.8
// SimpleAccount -- ECDSA over the EIP-712 userOpHash with NO EIP-191 prefix).
//
// The client only needs to (1) reconstruct the stealth signing key and (2) sign
// the unsigned userOpHash the server returns from POST /xochi/claim/prepare. The
// server builds the UserOperation and computes the counterfactual address;
// ERC-4337 is not reimplemented here.

import { secp256k1 } from "@noble/curves/secp256k1";
import { ethers } from "ethers";
import { assertValidPrivateKey } from "./private-key.js";

// secp256k1 group order.
const N = secp256k1.CURVE.n;

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

// Receiver-side stealth private key:
//   shared        = compress(ECDH(viewing_priv, ephemeral_pub))   (33-byte SEC1)
//   stealth_priv  = (spending_priv + keccak256(shared)) mod n
//
// getSharedSecret(privA, pubB, true) returns the compressed point pubB*privA --
// the same bytes Riddler hashes (ExSecp256k1.public_key_compress over the ECDH
// point). All inputs are 0x-prefixed hex; spending/viewing are 32-byte private
// keys, ephemeral_pub is a 33-byte compressed public key.
export function deriveStealthPrivateKey(
  spendingPrivHex: string,
  viewingPrivHex: string,
  ephemeralPubHex: string,
): string {
  assertValidPrivateKey(spendingPrivHex, "spendingPrivHex");
  assertValidPrivateKey(viewingPrivHex, "viewingPrivHex");

  const shared = secp256k1.getSharedSecret(strip0x(viewingPrivHex), strip0x(ephemeralPubHex), true);
  const hashSs = BigInt(ethers.keccak256(shared));
  const spendingInt = BigInt("0x" + strip0x(spendingPrivHex));
  const stealthInt = (spendingInt + hashSs) % N;
  return "0x" + stealthInt.toString(16).padStart(64, "0");
}

// Stealth EOA address from its private key (last 20 bytes of keccak256 of the
// uncompressed pubkey). Used to verify the derived key controls the intent's
// stealth address before signing anything.
export function stealthAddressFromPrivateKey(privHex: string): string {
  assertValidPrivateKey(privHex, "privHex");
  return new ethers.Wallet(privHex).address;
}

// Sign the 32-byte userOpHash with the stealth key. Raw ECDSA over the digest --
// NO toEthSignedMessageHash / EIP-191 wrapper -- matching v0.8 SimpleAccount.
// Returns 0x + r(32) + s(32) + v(1), with v in {27,28}; ethers normalizes to
// low-s, which OpenZeppelin ECDSA.recover requires.
export function signUserOpHash(userOpHash: string, stealthPrivHex: string): string {
  assertValidPrivateKey(stealthPrivHex, "stealthPrivHex");
  return new ethers.SigningKey(stealthPrivHex).sign(userOpHash).serialized;
}

/** What a prepared claim op does. Anything other than a sweep binds the action. */
export type ClaimAction = "transfer" | "approve_permit2";

// The canonical claim-prepare challenge, byte-for-byte as Riddler builds it
// (`Xochi.Adapter.ClaimProof.challenge/5`).
//
// Two versions, and the choice is not stylistic: `transfer` keeps the v1 string
// so already-deployed clients and the published vectors stay valid, while any
// other action uses v2, which inserts the action between the counterfactual and
// the recipient. That is what stops a captured `transfer` proof from preparing
// an `approve_permit2` (Riddler#1103).
//
// Both addresses are lowercased: the server does the same before hashing, so a
// checksummed address here produces a digest it will not recover from.
// `chainId` is the DESTINATION chain (`intent.to_chain_id`).
//
// Conformance vectors: Riddler `priv/conformance/claim_prepare_proof.json`,
// vendored byte-for-byte at `packages/signer/test/vectors/` and pinned by
// `packages/signer/test/claim-proof.test.ts`. Riddler also routes it as
// `/xochi/vectors/claim-prepare-proof.json`.
export function claimPrepareChallenge(params: {
  chainId: number;
  counterfactualAddress: string;
  recipientAddress: string;
  issuedAt: number;
  action?: ClaimAction;
}): string {
  const action = params.action ?? "transfer";
  const parts =
    action === "transfer"
      ? [
          "xochi-claim-prepare-v1",
          String(params.chainId),
          params.counterfactualAddress.toLowerCase(),
          params.recipientAddress.toLowerCase(),
          String(params.issuedAt),
        ]
      : [
          "xochi-claim-prepare-v2",
          String(params.chainId),
          params.counterfactualAddress.toLowerCase(),
          action,
          params.recipientAddress.toLowerCase(),
          String(params.issuedAt),
        ];
  return parts.join(":");
}

// Sign a claim-prepare proof of control with the derived stealth key: 65-byte
// r||s||v over keccak256(challenge).
//
// RAW keccak of the string, with NO EIP-191 personal_sign wrapper -- the same
// choice as `signUserOpHash` above, and the server recovers with
// `ExSecp256k1.recover_compact` over exactly those 32 bytes.
//
// Single-use: the server keys its replay guard on the digest, so every prepare
// needs a fresh `issuedAt`. The freshness window is 300s back / 120s forward of
// SERVER time while `issuedAt` comes from the CLIENT's clock, so a device
// running fast is the documented failure mode -- prefer a server-anchored time
// over `Date.now()` where one is available.
export function signClaimPrepareProof(
  stealthPrivHex: string,
  params: {
    chainId: number;
    counterfactualAddress: string;
    recipientAddress: string;
    issuedAt: number;
    action?: ClaimAction;
  },
): string {
  assertValidPrivateKey(stealthPrivHex, "stealthPrivHex");
  const digest = ethers.keccak256(ethers.toUtf8Bytes(claimPrepareChallenge(params)));
  return new ethers.SigningKey(stealthPrivHex).sign(digest).serialized;
}
