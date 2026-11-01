// ERC-5564 / ERC-6538 receive-side stealth crypto: deriving a wallet's stealth
// keys from a signature, its meta-address, the sender's one-time address, and
// the receiver's view-tag filter and owner derivation.
//
// Moved from the Xochi widget (`src/lib/stealth.ts`) and `@xochi/shared`
// byte-for-byte. `computeStealthAddress` is the reference two Elixir conformance
// suites check themselves against (raxol `stealth_vectors.json`, forward; the
// reverse fixture in `test/vectors/`), so its output is frozen.
//
// Network-free. Matching an announcement to a counterfactual account
// (`getAddress(owner, salt)` on the factory) and reading balances are on-chain
// reads and stay with the caller, which also owns the factory allowlist.
//
// @see https://eips.ethereum.org/EIPS/eip-5564
// @see https://eips.ethereum.org/EIPS/eip-6538

import { secp256k1 } from "@noble/curves/secp256k1";
import { ethers } from "ethers";
import { deriveStealthPrivateKey, stealthAddressFromPrivateKey } from "./stealth.js";

/** ERC-5564 Announcer contract address. */
export const ERC5564_ANNOUNCER = "0x55649E01B5Df198D18D95b5cc5051630cfD45564";

/** ERC-6538 Registry contract address. */
export const ERC6538_REGISTRY = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";

/** Scheme ID for secp256k1 with view tags (ERC-5564). */
export const STEALTH_SCHEME_ID = 1;

/**
 * The message a wallet signs to derive its stealth keys.
 *
 * `deriveStealthKeys` is a pure function of this signature, so the string IS the
 * key namespace: change a character and the same wallet derives a different
 * spending/viewing pair, a different meta-address, and matches none of the
 * announcements its payments were actually sent to (xochi#471). The bytes are
 * pinned by `test/stealth-derive-namespace.test.ts`.
 *
 * Changing this string strands every existing stealth payment. Do not edit it.
 */
export const STEALTH_DERIVE_MESSAGE =
  "Sign this message to derive your Xochi stealth keys.\n\nThis signature will be used to create receiving addresses that only you can spend from.";

/** A private scalar as bytes or `0x` hex. */
export type StealthScalar = Uint8Array | string;

/**
 * Stealth meta-address: the spending and viewing public keys a wallet registers
 * on ERC-6538 and shares publicly. `C` narrows `chainId` for callers with their
 * own chain-id union.
 */
export interface StealthMetaAddress<C extends number = number> {
  /** Compressed secp256k1 spending public key (33 bytes hex). */
  spendingPubKey: string;
  /** Compressed secp256k1 viewing public key (33 bytes hex). */
  viewingPubKey: string;
  /** Chain the meta-address is registered on. */
  chainId: C;
}

/** Stealth keys derived from a wallet signature. Private keys are never shared or stored. */
export interface StealthKeys {
  /** Private spending key (32 bytes), in [1, n-1]. */
  spendingKey: Uint8Array;
  /** Private viewing/scanning key (32 bytes), in [1, n-1]. */
  viewingKey: Uint8Array;
  /** Compressed public spending key (33 bytes hex). */
  spendingPubKey: string;
  /** Compressed public viewing key (33 bytes hex). */
  viewingPubKey: string;
}

/** What a sender derives for one stealth payment. */
export interface StealthSettlement {
  /** One-time stealth address, lowercase hex. */
  stealthAddress: string;
  /** Ephemeral public key for ECDH (33 bytes hex). */
  ephemeralPubKey: string;
  /** View tag for fast scanning (0-255). */
  viewTag: number;
}

/** ERC-5564 `Announcement` event data. */
export interface StealthAnnouncement {
  /** Scheme ID (1 for secp256k1 with view tags). */
  schemeId: number;
  /** Address that received the funds. */
  stealthAddress: string;
  /** Caller that made the announcement. */
  caller: string;
  /** Ephemeral public key (33 bytes hex). */
  ephemeralPubKey: string;
  /** Metadata, view tag in the first byte. */
  metadata: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
}

/** A payment a scan matched to the receiver. */
export interface StealthPayment {
  /** The announcement that matched. */
  announcement: StealthAnnouncement;
  /** Private key that controls the stealth owner. */
  stealthPrivKey: Uint8Array;
  /** Token address, from the metadata or a separate lookup. */
  tokenAddress?: string;
  /** Amount received, from chain state. */
  amount?: string;
}

/** The per-payment stealth key and owner for an announcement. */
export interface StealthDerivation {
  /**
   * Per-payment stealth spending private key. It controls the stealth owner EOA
   * and, through it, the counterfactual SimpleAccount it owns.
   */
  stealthPrivKey: Uint8Array;
  /** The stealth owner EOA, address(P'), checksummed. */
  stealthEOA: string;
}

/**
 * Everything the ERC-5564 metadata blob carries beyond the view tag.
 *
 * Riddler packs the full settlement description in, so the recipient can
 * reconstruct a payment from the announcement alone; only the owner EOA (which
 * needs the viewing key) is absent.
 */
export interface AnnouncementMetadata {
  /** ERC-5564 view tag: the first byte of `keccak(sharedSecret)`. */
  viewTag: number;
  /** ERC-20 the payment settled in. */
  token: string;
  /** 4-byte transfer selector. */
  selector: string;
  /** Payout in token base units. */
  amount: bigint;
  /** SimpleAccountFactory that owns the counterfactual. */
  factory: string;
  /** CREATE2 salt (0 in every announcement to date). */
  salt: bigint;
}

// secp256k1 group order.
const N = secp256k1.CURVE.n;

/**
 * Byte layout of the metadata blob:
 * `[viewTag(1)][token(20)][selector(4)][amount(32)][factory(20)][salt(32)]`.
 */
const METADATA_BYTES = 1 + 20 + 4 + 32 + 20 + 32;

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function toBytes(value: StealthScalar): Uint8Array {
  return typeof value === "string" ? ethers.getBytes("0x" + strip0x(value)) : value;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result;
}

/**
 * Reduce a byte-encoded scalar into [0, n).
 *
 * noble's `ProjectivePoint.multiply` requires a scalar in [1, n-1] and throws
 * otherwise. Stealth scalars come from keccak256 and can land >= n (probability
 * ~2^-128, but nonzero). Since k*P == (k mod n)*P for any point of order n,
 * reducing preserves every valid key and only prevents the edge-case throw.
 * Every scalar is reduced the same way, so sender and receiver agree.
 */
function modOrder(bytes: Uint8Array): bigint {
  return bytesToBigInt(bytes) % N;
}

/** Compressed (33-byte) public key of a private scalar, `0x` hex. */
function compressedPublicKey(privateKey: Uint8Array): string {
  return ethers.hexlify(
    secp256k1.ProjectivePoint.BASE.multiply(modOrder(privateKey)).toRawBytes(true),
  );
}

/** `keccak256(compressed(priv * pub))`: the ECDH secret both sides hash. */
function sharedSecretHash(publicKey: string, privateKey: Uint8Array): string {
  const point = secp256k1.ProjectivePoint.fromHex(ethers.getBytes("0x" + strip0x(publicKey)));
  return ethers.keccak256(point.multiply(modOrder(privateKey)).toRawBytes(true));
}

/**
 * Validate a compressed secp256k1 public key (33 bytes): `02` or `03` followed by
 * the 32-byte X coordinate.
 */
function isValidCompressedPubKey(hex: string): boolean {
  const clean = strip0x(hex);
  if (clean.length !== 66) return false;
  const prefix = clean.slice(0, 2);
  return prefix === "02" || prefix === "03";
}

/**
 * Derive stealth keys from the wallet's signature over `STEALTH_DERIVE_MESSAGE`:
 * `keccak256(utf8("stealth:spending:" + sigHex))` and
 * `keccak256(utf8("stealth:viewing:" + sigHex))`, `sigHex` without `0x`.
 *
 * Both private keys are returned reduced into [1, n-1], the range
 * `deriveStealthPrivateKey` accepts. The reduction cannot change a public key, a
 * stealth address or a view tag: k*G == (k mod n)*G.
 */
export function deriveStealthKeys(signature: string): StealthKeys {
  const cleanSig = strip0x(signature);

  // keccak256 of the UTF-8 domain-tagged signature hex, reduced mod n, as 32 bytes.
  const deriveKey = (domain: string): Uint8Array => {
    const hash = ethers.keccak256(new TextEncoder().encode(domain + ":" + cleanSig));
    return ethers.getBytes("0x" + modOrder(ethers.getBytes(hash)).toString(16).padStart(64, "0"));
  };

  const spendingKey = deriveKey("stealth:spending");
  const viewingKey = deriveKey("stealth:viewing");

  // A zero scalar (mod n) has no public key and cannot spend. Impossible from
  // keccak256 in practice; guarded so a bad key surfaces here, not in a multiply.
  if (modOrder(spendingKey) === 0n || modOrder(viewingKey) === 0n) {
    throw new Error("Derived stealth key is out of range; re-sign to derive keys");
  }

  return {
    spendingKey,
    viewingKey,
    spendingPubKey: compressedPublicKey(spendingKey),
    viewingPubKey: compressedPublicKey(viewingKey),
  };
}

/** The stealth meta-address for a pair of public keys; what gets registered on ERC-6538. */
export function computeMetaAddress<C extends number>(
  spendingPubKey: string,
  viewingPubKey: string,
  chainId: C,
): StealthMetaAddress<C> {
  return { spendingPubKey, viewingPubKey, chainId };
}

/** The stealth meta-address for derived stealth keys. */
export function computeMetaAddressFromKeys<C extends number>(
  keys: Pick<StealthKeys, "spendingPubKey" | "viewingPubKey">,
  chainId: C,
): StealthMetaAddress<C> {
  return computeMetaAddress(keys.spendingPubKey, keys.viewingPubKey, chainId);
}

/**
 * Encode a meta-address as `st:eth:0x{spendingPubKey}{viewingPubKey}`. Throws
 * unless both keys are compressed secp256k1 public keys.
 */
export function encodeMetaAddress(metaAddress: StealthMetaAddress): string {
  if (!isValidCompressedPubKey(metaAddress.spendingPubKey)) {
    throw new Error("Invalid spending public key");
  }
  if (!isValidCompressedPubKey(metaAddress.viewingPubKey)) {
    throw new Error("Invalid viewing public key");
  }
  return `st:eth:0x${strip0x(metaAddress.spendingPubKey)}${strip0x(metaAddress.viewingPubKey)}`;
}

/**
 * Sender side: the one-time stealth address for a recipient's meta-address and
 * an ephemeral private key (ERC-5564):
 *
 * 1. shared secret S = r * V
 * 2. view tag = first byte of keccak256(compressed(S))
 * 3. stealth public key P' = P + keccak256(compressed(S)) * G
 * 4. stealth address = address(P'), lowercase
 *
 * Frozen: the reference for the raxol forward and reverse conformance suites.
 */
export function computeStealthAddress(
  metaAddress: StealthMetaAddress,
  ephemeralPrivKey: StealthScalar,
): StealthSettlement {
  const ephemeral = toBytes(ephemeralPrivKey);
  const hashBytes = ethers.getBytes(sharedSecretHash(metaAddress.viewingPubKey, ephemeral));

  const tweakPoint = secp256k1.ProjectivePoint.BASE.multiply(modOrder(hashBytes));
  const stealthPubKey = secp256k1.ProjectivePoint.fromHex(
    ethers.getBytes("0x" + strip0x(metaAddress.spendingPubKey)),
  )
    .add(tweakPoint)
    .toRawBytes(false);

  return {
    stealthAddress: "0x" + ethers.keccak256(stealthPubKey.slice(1)).slice(-40),
    ephemeralPubKey: compressedPublicKey(ephemeral),
    viewTag: hashBytes[0]!,
  };
}

/**
 * The ERC-5564 view tag: the first metadata byte. Returns 0 for empty or short
 * metadata; throws on non-hex.
 */
export function extractViewTag(metadata: string): number {
  const clean = strip0x(metadata);
  if (clean.length < 2) return 0;
  const parsed = parseInt(clean.slice(0, 2), 16);
  if (isNaN(parsed)) {
    throw new Error(`Invalid view tag hex: ${clean.slice(0, 2)}`);
  }
  return parsed;
}

/**
 * Decode the full metadata blob. `null`, not a throw, when it is shorter than
 * the layout or not hex: ERC-5564 mandates only the view-tag byte, so a
 * third-party (or older) announcer may carry nothing else.
 */
export function decodeAnnouncementMetadata(metadata: string): AnnouncementMetadata | null {
  const clean = strip0x(metadata);
  if (clean.length < METADATA_BYTES * 2) return null;
  if (!/^[0-9a-fA-F]+$/.test(clean.slice(0, METADATA_BYTES * 2))) return null;

  // Cursor in hex characters, two per byte.
  let at = 0;
  const take = (bytes: number): string => {
    const slice = clean.slice(at, at + bytes * 2);
    at += bytes * 2;
    return slice;
  };

  const viewTag = parseInt(take(1), 16);
  const token = "0x" + take(20);
  const selector = "0x" + take(4);
  const amount = BigInt("0x" + take(32));
  const factory = "0x" + take(20);
  const salt = BigInt("0x" + take(32));

  return { viewTag, token, selector, amount, factory, salt };
}

/**
 * Receiver side, fast filter: whether the announcement's view tag matches
 * `viewingPriv * ephemeralPub`. A mismatch means the payment is not ours; a match
 * only means it might be.
 */
export function checkViewTag(
  announcement: Pick<StealthAnnouncement, "ephemeralPubKey" | "metadata">,
  viewingPrivKey: StealthScalar,
): boolean {
  const hash = sharedSecretHash(announcement.ephemeralPubKey, toBytes(viewingPrivKey));
  return parseInt(hash.slice(2, 4), 16) === extractViewTag(announcement.metadata);
}

/**
 * The per-payment stealth spending key and owner EOA for an announcement, via
 * `deriveStealthPrivateKey`. Whether the announcement is actually ours is decided
 * by matching the counterfactual account this EOA owns, an on-chain read left to
 * the caller.
 *
 * Throws on a private key outside [1, n-1]; `deriveStealthKeys` returns keys in
 * that range.
 */
export function deriveStealthOwner(
  announcement: Pick<StealthAnnouncement, "ephemeralPubKey">,
  spendingPrivKey: StealthScalar,
  viewingPrivKey: StealthScalar,
): StealthDerivation {
  const stealthPrivHex = deriveStealthPrivateKey(
    ethers.hexlify(toBytes(spendingPrivKey)),
    ethers.hexlify(toBytes(viewingPrivKey)),
    announcement.ephemeralPubKey,
  );
  return {
    stealthPrivKey: ethers.getBytes(stealthPrivHex),
    stealthEOA: stealthAddressFromPrivateKey(stealthPrivHex),
  };
}
