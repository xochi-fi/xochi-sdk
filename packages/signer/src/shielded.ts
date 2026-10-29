// Recipient-private Aztec settlement, contract v1: the typed encodings approved on
// 2026-10-18 (xochi docs/planning/shielded-execution.md §7 "Approved 2026-10-18: typed
// encodings"; epic xochi#633, xochi#635). INERT: nothing in the signing path calls this,
// and shielded settlement is off everywhere (SHIELDED_SETTLEMENT_LIVE).
//
// HASH-ONLY, like xsp.ts: the source wallet signs a RecipientBinding through its own
// wallet as EIP-712, and the recipient signs it under its Aztec account scheme. Neither
// key is held here.
//
// What is here, and only this:
//   - the salted domain shared by `Domain (binding)` and `Domain (terms)`;
//   - the NetworkIdentity hashStruct that feeds the salt;
//   - the RecipientBinding struct hash and EIP-712 digest;
//   - the value rules the approval states (Aztec bytes32, amounts).
//
// NOT here, because §7 leaves them open: ShieldedTermsV1 (no member names or types are
// fixed, and `fee_breakdown` has no typed shape) and the manifestDigest struct (its identity
// fields are listed but not typed). A vector for either would be a guess other
// implementations are then held to. The descriptorDigest encoding, recipient message
// wrapper and field reduction are in `shielded-recipient.ts`; approved acknowledgement
// structs are in `shielded-recipient-acks.ts`; readiness is in `shielded-readiness.ts`.
//
// Every hash is built by hand from `abi.encode`, so the vector suite can cross-check it
// against ethers' TypedDataEncoder as an independent implementation.

import { ethers } from "ethers";
import type { Hex } from "./types";
import {
  UINT32_MAX,
  UINT64_MAX,
  assertAztecBytes32,
  aztecUint,
  bytes32,
  chainId,
  coder,
  environmentHash,
  evmAddress,
  keccak,
  refuse,
  uint,
  type UintLike,
} from "./shielded-values";

// The value rules live in `shielded-values.ts` (shared with the recipient and readiness
// encodings); these are their public names.
export {
  AZTEC_FIELD_MODULUS,
  SHIELDED_AMOUNT_MAX,
  ShieldedEncodingError,
  assertAztecBytes32,
  parseShieldedAmount,
  type ShieldedRefusal,
} from "./shielded-values";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHIELDED_DOMAIN_VERSION = "1";
export const SHIELDED_BINDING_DOMAIN_NAME = "Xochi Shielded Recipient";
export const SHIELDED_TERMS_DOMAIN_NAME = "Xochi Shielded Terms";

// `{ name, version, chainId, salt }` in EIP-712's fixed member order, with no
// verifyingContract: neither domain names a contract.
export const SHIELDED_DOMAIN_TYPE_STRING =
  "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)";
export const SHIELDED_DOMAIN_TYPEHASH = ethers.id(SHIELDED_DOMAIN_TYPE_STRING) as Hex;

// §7 `NetworkIdentity = { aztec_chain_id, protocol_version, rollup_address, l1_chain_id,
// genesis_or_network_digest }`. §7 delegates its typed encoding to these vectors; this one
// was approved by the product owner on 2026-10-19 (its §7 record lands in a separate xochi
// PR). Member names follow the approval's snake_case -> camelCase mapping. `rollupAddress`
// is the L1 rollup contract, so `address`; `protocolVersion` is the numeric Aztec rollup
// version. Both Aztec values are protocol field elements (tx context `chainId` /
// `version`), carried as uint256 and held in-field.
export const NETWORK_IDENTITY_TYPE_STRING =
  "NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress,uint256 l1ChainId,bytes32 genesisOrNetworkDigest)";
export const NETWORK_IDENTITY_TYPEHASH = ethers.id(NETWORK_IDENTITY_TYPE_STRING) as Hex;

// Byte-for-byte the approved type string (§7). Hashed, so never reformat it.
export const RECIPIENT_BINDING_TYPE_STRING =
  "RecipientBinding(address sourceWallet,uint256 sourceChainId,bytes32 aztecRecipient,bytes32 aztecToken,bytes32 descriptorDigest,bytes32 corridorId,uint32 corridorRevision,bytes32 manifestDigest,bytes32 nonce,uint64 challengeExpiry,string purpose)";
export const RECIPIENT_BINDING_TYPEHASH = ethers.id(RECIPIENT_BINDING_TYPE_STRING) as Hex;
export const RECIPIENT_BINDING_PURPOSE = "xochi.shielded.recipient-binding.v1";

// ---------------------------------------------------------------------------
// NetworkIdentity and the salted domain
// ---------------------------------------------------------------------------

/**
 * The approved Aztec network a shielded corridor runs on (xochi `shielded-execution.md` §7;
 * `NETWORK_IDENTITY_TYPE_STRING`). `ESCROW-RFC.md` §5.1 "Network binding" says how a venue
 * proves its node serves it.
 */
export interface NetworkIdentity {
  /**
   * The chain id every tx on the Aztec network carries in its context (`TxContext.chainId`).
   * Aztec networks take it from their L1, so it equals `l1ChainId` on current networks (as in
   * the vector). It is not the settlement-type label `XSP_AZTEC_CHAIN_ID`.
   */
  aztecChainId: UintLike;
  /** The numeric Aztec rollup version (`TxContext.version`). */
  protocolVersion: UintLike;
  /** The rollup contract on L1. */
  rollupAddress: string;
  /** The L1 chain the rollup contract lives on. */
  l1ChainId: UintLike;
  /** bytes32: the network's genesis digest or a network digest; never zero. */
  genesisOrNetworkDigest: string;
}

/** `network_identity_digest`: the EIP-712 hashStruct of NetworkIdentity. */
export function hashNetworkIdentity(n: NetworkIdentity): Hex {
  const genesis = bytes32("network.genesisOrNetworkDigest", n.genesisOrNetworkDigest);
  if (BigInt(genesis) === 0n) refuse("digest_zero", "network.genesisOrNetworkDigest", "zero");
  return keccak(
    coder.encode(
      ["bytes32", "uint256", "uint256", "address", "uint256", "bytes32"],
      [
        NETWORK_IDENTITY_TYPEHASH,
        aztecUint("network.aztecChainId", n.aztecChainId),
        aztecUint("network.protocolVersion", n.protocolVersion),
        evmAddress("network.rollupAddress", n.rollupAddress),
        chainId("network.l1ChainId", n.l1ChainId),
        genesis,
      ],
    ),
  );
}

/** `salt = keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest))`. */
export function shieldedDomainSalt(environment: string, network: NetworkIdentity): Hex {
  return keccak(
    coder.encode(
      ["bytes32", "bytes32"],
      [environmentHash(environment), hashNetworkIdentity(network)],
    ),
  );
}

export interface ShieldedDomain {
  name: string;
  version: string;
  chainId: string; // decimal
  salt: Hex;
}

function shieldedDomain(
  name: string,
  sourceChainId: UintLike,
  environment: string,
  network: NetworkIdentity,
): ShieldedDomain {
  return {
    name,
    version: SHIELDED_DOMAIN_VERSION,
    chainId: chainId("sourceChainId", sourceChainId).toString(),
    salt: shieldedDomainSalt(environment, network),
  };
}

/** `Domain (binding)`: chainId is the source chain. */
export function bindingDomain(
  sourceChainId: UintLike,
  environment: string,
  network: NetworkIdentity,
): ShieldedDomain {
  return shieldedDomain(SHIELDED_BINDING_DOMAIN_NAME, sourceChainId, environment, network);
}

/** `Domain (terms)`: the same scheme under "Xochi Shielded Terms". */
export function termsDomain(
  sourceChainId: UintLike,
  environment: string,
  network: NetworkIdentity,
): ShieldedDomain {
  return shieldedDomain(SHIELDED_TERMS_DOMAIN_NAME, sourceChainId, environment, network);
}

export function shieldedDomainSeparator(domain: ShieldedDomain): Hex {
  return keccak(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "bytes32"],
      [
        SHIELDED_DOMAIN_TYPEHASH,
        ethers.id(domain.name),
        ethers.id(domain.version),
        chainId("domain.chainId", domain.chainId),
        bytes32("domain.salt", domain.salt),
      ],
    ),
  );
}

// ---------------------------------------------------------------------------
// RecipientBinding
// ---------------------------------------------------------------------------

export interface RecipientBinding {
  sourceWallet: string; // EVM address
  sourceChainId: UintLike;
  aztecRecipient: string; // bytes32 AztecAddress  (recipient_address)
  aztecToken: string; // bytes32 AztecAddress      (token_address)
  descriptorDigest: string; // bytes32             (recipient_descriptor_digest)
  corridorId: string; // bytes32
  corridorRevision: UintLike; // uint32
  manifestDigest: string; // bytes32
  nonce: string; // bytes32, server-issued, single-use
  challengeExpiry: UintLike; // uint64, Unix seconds: the signing window only
  purpose: string; // must be RECIPIENT_BINDING_PURPOSE
}

export function hashRecipientBinding(b: RecipientBinding): Hex {
  if (b.purpose !== RECIPIENT_BINDING_PURPOSE) {
    refuse("purpose_mismatch", "purpose", `expected ${RECIPIENT_BINDING_PURPOSE}`);
  }
  return keccak(
    coder.encode(
      [
        "bytes32",
        "address",
        "uint256",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint32",
        "bytes32",
        "bytes32",
        "uint64",
        "bytes32",
      ],
      [
        RECIPIENT_BINDING_TYPEHASH,
        evmAddress("sourceWallet", b.sourceWallet),
        chainId("sourceChainId", b.sourceChainId),
        assertAztecBytes32("aztecRecipient", b.aztecRecipient),
        assertAztecBytes32("aztecToken", b.aztecToken),
        bytes32("descriptorDigest", b.descriptorDigest),
        bytes32("corridorId", b.corridorId),
        uint("corridorRevision", b.corridorRevision, UINT32_MAX),
        bytes32("manifestDigest", b.manifestDigest),
        bytes32("nonce", b.nonce),
        uint("challengeExpiry", b.challengeExpiry, UINT64_MAX),
        ethers.id(b.purpose),
      ],
    ),
  );
}

/**
 * The EIP-712 digest the source wallet signs. The domain's chainId is taken from the
 * binding's own `sourceChainId`, so the two can never disagree.
 */
export function recipientBindingDigest(
  b: RecipientBinding,
  environment: string,
  network: NetworkIdentity,
): Hex {
  const structHash = hashRecipientBinding(b);
  const separator = shieldedDomainSeparator(bindingDomain(b.sourceChainId, environment, network));
  return keccak(ethers.concat(["0x1901", separator, structHash]));
}
