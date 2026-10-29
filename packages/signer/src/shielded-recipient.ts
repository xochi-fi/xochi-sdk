// Recipient-side encodings of the shielded settlement contract v1 (xochi
// docs/planning/shielded-execution.md §7; epic xochi#633, xochi#635), decided by the product
// owner on 2026-10-24/25. INERT: nothing in the signing path calls this, and shielded
// settlement is off everywhere (SHIELDED_SETTLEMENT_LIVE).
//
// What is here:
//   - `RecipientDescriptor` and `descriptorDigest = hashStruct(RecipientDescriptor)`;
//   - the address recomputation for the stock `SchnorrAccount` pinned per network
//     (`AZTEC_RECIPIENT_PROFILES`) and the fail-closed descriptor check;
//   - the recipient message wrapper and its wide reduction into the BN254 scalar field;
//   - a Schnorr-over-Grumpkin verifier for the account's signature over that field value;
//   - (the acknowledgement structs are DRAFT and live in the internal
//     `shielded-recipient-acks.ts`, not exported until the owner approves them).
//
// VERIFY-ONLY: the recipient signs with its own tooling, which rebuilds the full typed
// preimage and applies the wrapper itself; it never signs a value supplied by Xochi. No
// signing key is held or accepted here.
//
// Every value is pinned by `@xochi/spec`'s conformance/shielded-recipient.json, which is
// generated independently of this file and held to the real Aztec SDKs (5.2.0 and
// @aztec-labs 6.0.0) by packages/spec/aztec-crosscheck.

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { ethers } from "ethers";

import {
  NETWORK_IDENTITY_TYPE_STRING,
  hashNetworkIdentity,
  type NetworkIdentity,
} from "./shielded";
import {
  AZTEC_FIELD_MODULUS,
  assertAztecBytes32,
  aztecField,
  bytes32,
  coder,
  keccak,
  withRefusalsAs,
  type ShieldedRefusal,
} from "./shielded-values";
import type { Hex } from "./types";

const R = AZTEC_FIELD_MODULUS;
const hex32 = (v: bigint): Hex => ("0x" + v.toString(16).padStart(64, "0")) as Hex;

/**
 * Why a descriptor or digest is refused: the shared value rules (`ShieldedRefusal`) plus
 * the descriptor checks. Its own union and error, so `ShieldedEncodingError` keeps the
 * `shielded.ts` contract.
 */
export type RecipientRefusal =
  | ShieldedRefusal
  | "class_not_pinned"
  | "signing_key_invalid"
  | "ivpk_invalid"
  | "address_mismatch";

export class RecipientEncodingError extends Error {
  readonly code: RecipientRefusal;
  readonly field: string;
  constructor(code: RecipientRefusal, field: string, detail: string) {
    super(`${field}: ${code} (${detail})`);
    this.name = "RecipientEncodingError";
    this.code = code;
    this.field = field;
  }
}

const refuseRecipient = (code: RecipientRefusal, field: string, detail: string): never => {
  throw new RecipientEncodingError(code, field, detail);
};
// The shared value rules, refusing as RecipientEncodingError.
const recipientRules = <T>(fn: () => T): T =>
  withRefusalsAs(fn, (code, field, detail) => new RecipientEncodingError(code, field, detail));

// ---------------------------------------------------------------------------
// Grumpkin (y^2 = x^3 - 17 over F_r), Jacobian coordinates. Public data only
// (derivation and verification), so nothing here needs to be constant-time.
// ---------------------------------------------------------------------------

/** Grumpkin group order q = the BN254 base field (Aztec `GrumpkinScalar`). */
export const GRUMPKIN_ORDER = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
const GENERATOR = { x: 1n, y: 0x0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272cn };

export interface GrumpkinPoint {
  x: bigint;
  y: bigint;
}
type Jacobian = { X: bigint; Y: bigint; Z: bigint }; // Z = 0: the point at infinity

const m = (a: bigint) => {
  const r = a % R;
  return r < 0n ? r + R : r;
};
function invert(a: bigint): bigint {
  // Extended Euclid over the prime field.
  let [t, newT, r, newR] = [0n, 1n, R, m(a)];
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  return m(t);
}
function double(p: Jacobian): Jacobian {
  if (p.Z === 0n || p.Y === 0n) return { X: 0n, Y: 1n, Z: 0n };
  const A = m(p.X * p.X);
  const B = m(p.Y * p.Y);
  const C = m(B * B);
  const D = m(2n * (m((p.X + B) * (p.X + B)) - A - C));
  const E = m(3n * A);
  const X = m(E * E - 2n * D);
  return { X, Y: m(E * (D - X) - 8n * C), Z: m(2n * p.Y * p.Z) };
}
function addJ(p: Jacobian, q: Jacobian): Jacobian {
  if (p.Z === 0n) return q;
  if (q.Z === 0n) return p;
  const z1z1 = m(p.Z * p.Z);
  const z2z2 = m(q.Z * q.Z);
  const u1 = m(p.X * z2z2);
  const u2 = m(q.X * z1z1);
  const s1 = m(p.Y * q.Z * z2z2);
  const s2 = m(q.Y * p.Z * z1z1);
  if (u1 === u2) return s1 === s2 ? double(p) : { X: 0n, Y: 1n, Z: 0n };
  const h = m(u2 - u1);
  const i = m(4n * h * h);
  const j = m(h * i);
  const r = m(2n * (s2 - s1));
  const v = m(u1 * i);
  const X = m(r * r - j - 2n * v);
  return {
    X,
    Y: m(r * (v - X) - 2n * s1 * j),
    Z: m((m((p.Z + q.Z) * (p.Z + q.Z)) - z1z1 - z2z2) * h),
  };
}
function mulJ(k: bigint, p: GrumpkinPoint): Jacobian {
  let out: Jacobian = { X: 0n, Y: 1n, Z: 0n };
  let acc: Jacobian = { X: p.x, Y: p.y, Z: 1n };
  for (let e = k % GRUMPKIN_ORDER; e > 0n; e >>= 1n) {
    if (e & 1n) out = addJ(out, acc);
    acc = double(acc);
  }
  return out;
}
function affine(p: Jacobian): GrumpkinPoint | null {
  if (p.Z === 0n) return null;
  const zi = invert(p.Z);
  const zi2 = m(zi * zi);
  return { x: m(p.X * zi2), y: m(p.Y * zi2 * zi) };
}

/**
 * A finite Grumpkin point: both coordinates below r, on the curve. (0, 0) is not on the
 * curve, and is also how the Aztec SDKs encode the point at infinity, which no key can be.
 */
export function isGrumpkinPoint(p: GrumpkinPoint): boolean {
  return p.x >= 0n && p.x < R && p.y >= 0n && p.y < R && m(p.y * p.y) === m(p.x * p.x * p.x - 17n);
}

// ---------------------------------------------------------------------------
// RecipientDescriptor
// ---------------------------------------------------------------------------

/**
 * Exactly the public inputs that recompute the Aztec address of a stock `SchnorrAccount`:
 * the instance fields, the constructor args (the Schnorr signing key), and the account's
 * public keys in the SDK's public form (`PublicKeys`): ivpk_m as a point, the other five
 * master keys as their `hashPublicKey` digests. Delivery preferences are not in it.
 * `immutablesHash` is not a member: it is 0 for the pinned class and the derivation fixes it.
 */
export interface RecipientDescriptor {
  aztecAddress: string; // bytes32, nonzero, the address being proven
  classId: string; // bytes32, must equal the network's pinned class
  salt: string; // bytes32
  deployer: string; // bytes32, 0 for a universal deploy
  signingPublicKeyX: string; // bytes32, constructor arg 0
  signingPublicKeyY: string; // bytes32, constructor arg 1
  npkMHash: string; // bytes32, hashPublicKey(npk_m)
  ivpkMX: string; // bytes32
  ivpkMY: string; // bytes32
  ovpkMHash: string; // bytes32
  tpkMHash: string; // bytes32
  mspkMHash: string; // bytes32
  fbpkMHash: string; // bytes32
  network: NetworkIdentity;
}

const DESCRIPTOR_FIELDS = [
  "aztecAddress",
  "classId",
  "salt",
  "deployer",
  "signingPublicKeyX",
  "signingPublicKeyY",
  "npkMHash",
  "ivpkMX",
  "ivpkMY",
  "ovpkMHash",
  "tpkMHash",
  "mspkMHash",
  "fbpkMHash",
] as const;
type DescriptorField = (typeof DESCRIPTOR_FIELDS)[number];

/** Hashed, so never reformat it. NetworkIdentity is appended as the referenced type. */
export const RECIPIENT_DESCRIPTOR_TYPE_STRING =
  "RecipientDescriptor(bytes32 aztecAddress,bytes32 classId,bytes32 salt,bytes32 deployer,bytes32 signingPublicKeyX,bytes32 signingPublicKeyY,bytes32 npkMHash,bytes32 ivpkMX,bytes32 ivpkMY,bytes32 ovpkMHash,bytes32 tpkMHash,bytes32 mspkMHash,bytes32 fbpkMHash,NetworkIdentity network)" +
  NETWORK_IDENTITY_TYPE_STRING;
export const RECIPIENT_DESCRIPTOR_TYPEHASH = ethers.id(RECIPIENT_DESCRIPTOR_TYPE_STRING) as Hex;

// Encoding check: every member a bytes32 field element below r; aztecAddress nonzero.
function descriptorFields(d: RecipientDescriptor): Record<DescriptorField, bigint> {
  return recipientRules(() => {
    const out = {} as Record<DescriptorField, bigint>;
    for (const f of DESCRIPTOR_FIELDS) {
      out[f] = f === "aztecAddress" ? BigInt(assertAztecBytes32(f, d[f])) : aztecField(f, d[f]);
    }
    return out;
  });
}

/** `descriptorDigest = hashStruct(RecipientDescriptor)`: no domain, no 0x1901 prefix. */
export function hashRecipientDescriptor(d: RecipientDescriptor): Hex {
  const f = descriptorFields(d);
  return keccak(
    coder.encode(Array(DESCRIPTOR_FIELDS.length + 2).fill("bytes32"), [
      RECIPIENT_DESCRIPTOR_TYPEHASH,
      ...DESCRIPTOR_FIELDS.map((k) => hex32(f[k])),
      recipientRules(() => hashNetworkIdentity(d.network)),
    ]),
  );
}

/** The stock SchnorrAccount pinned for one Aztec SDK line, and what its derivation needs. */
export interface AztecRecipientProfile {
  id: string;
  sdk: string;
  pinnedClassId: Hex;
  /** DomainSeparator.CONTRACT_ADDRESS_V2 (5.2.0) / _V3 (6.0.0): the only derivation change. */
  contractAddressSeparator: bigint;
}

/** Pinned per network (§7 Recipient authorization; decided 2026-10-19/20/24). */
export const AZTEC_RECIPIENT_PROFILES = {
  "aztec-5.2.0": {
    id: "aztec-5.2.0",
    sdk: "@aztec/accounts 5.2.0 SchnorrAccount",
    pinnedClassId: "0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd",
    contractAddressSeparator: 4099338721n,
  },
  "aztec-6.0.0": {
    id: "aztec-6.0.0",
    sdk: "@aztec-labs/accounts 6.0.0 SchnorrAccount",
    pinnedClassId: "0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15",
    contractAddressSeparator: 993442748n,
  },
} as const satisfies Record<string, AztecRecipientProfile>;

function pinnedProfile(profile: AztecRecipientProfile): AztecRecipientProfile {
  const pinned = AZTEC_RECIPIENT_PROFILES[profile.id as keyof typeof AZTEC_RECIPIENT_PROFILES];
  if (
    pinned === undefined ||
    profile.sdk !== pinned.sdk ||
    profile.pinnedClassId.toLowerCase() !== pinned.pinnedClassId ||
    profile.contractAddressSeparator !== pinned.contractAddressSeparator
  ) {
    return refuseRecipient(
      "class_not_pinned",
      "profile",
      `${profile.id} does not match an AZTEC_RECIPIENT_PROFILES entry`,
    );
  }
  return pinned;
}

// stdlib DomainSeparator values, identical in both pinned SDK lines.
const SEP_FUNCTION_ARGS = 3576554347n;
const SEP_INITIALIZER = 385396519n;
const SEP_SALTED_INITIALIZATION_HASH = 2763052992n;
const SEP_PARTIAL_ADDRESS = 2103633018n;
const SEP_PUBLIC_KEYS_HASH = 777457226n;
const SEP_SINGLE_PUBLIC_KEY_HASH = 3452068255n;
/** FunctionSelector of `constructor(Field,Field)`, the SchnorrAccount initializer. */
export const SCHNORR_ACCOUNT_CONSTRUCTOR_SELECTOR = 0xcd9728afn;

export interface RecipientDerivation {
  constructorArgsHash: Hex;
  initializationHash: Hex;
  immutablesHash: Hex;
  saltedInitializationHash: Hex;
  partialAddress: Hex;
  ivpkMHash: Hex;
  publicKeysHash: Hex;
  preaddress: Hex;
  addressPoint: { x: Hex; y: Hex };
  address: Hex;
}

/**
 * Recomputes the address a descriptor's inputs produce under `profile`, with every
 * intermediate. It does NOT check the class pin, the points or the claimed address:
 * `verifyRecipientDescriptor` does.
 */
export function deriveRecipientAddress(
  d: RecipientDescriptor,
  profile: AztecRecipientProfile,
): RecipientDerivation {
  const pinned = pinnedProfile(profile);
  const f = descriptorFields(d);
  const argsHash = poseidon2Hash([SEP_FUNCTION_ARGS, f.signingPublicKeyX, f.signingPublicKeyY]);
  const initializationHash = poseidon2Hash([
    SEP_INITIALIZER,
    SCHNORR_ACCOUNT_CONSTRUCTOR_SELECTOR,
    argsHash,
  ]);
  const saltedInitializationHash = poseidon2Hash([
    SEP_SALTED_INITIALIZATION_HASH,
    f.salt,
    initializationHash,
    f.deployer,
    0n, // immutablesHash
  ]);
  const partialAddress = poseidon2Hash([SEP_PARTIAL_ADDRESS, f.classId, saltedInitializationHash]);
  const ivpkMHash = poseidon2Hash([SEP_SINGLE_PUBLIC_KEY_HASH, f.ivpkMX, f.ivpkMY]);
  const publicKeysHash = poseidon2Hash([
    SEP_PUBLIC_KEYS_HASH,
    f.npkMHash,
    ivpkMHash,
    f.ovpkMHash,
    f.tpkMHash,
    f.mspkMHash,
    f.fbpkMHash,
  ]);
  const preaddress = poseidon2Hash([
    pinned.contractAddressSeparator,
    publicKeysHash,
    partialAddress,
  ]);
  const point = affine(addJ(mulJ(preaddress, GENERATOR), { X: f.ivpkMX, Y: f.ivpkMY, Z: 1n }));
  if (point === null) {
    return refuseRecipient("address_mismatch", "aztecAddress", "address point at infinity");
  }
  return {
    constructorArgsHash: hex32(argsHash),
    initializationHash: hex32(initializationHash),
    immutablesHash: hex32(0n),
    saltedInitializationHash: hex32(saltedInitializationHash),
    partialAddress: hex32(partialAddress),
    ivpkMHash: hex32(ivpkMHash),
    publicKeysHash: hex32(publicKeysHash),
    preaddress: hex32(preaddress),
    addressPoint: { x: hex32(point.x), y: hex32(point.y) },
    address: hex32(point.x),
  };
}

/**
 * The fail-closed descriptor check, in this order (the first failure names the refusal):
 * encoding (`not_bytes32`, `aztec_out_of_field`, `aztec_zero` for aztecAddress), the class
 * pin (`class_not_pinned`), the points (`signing_key_invalid`, `ivpk_invalid`), then the
 * recomputed address (`address_mismatch`). Off-chain only: whether the instance's CURRENT
 * class (and any scheduled `ContractInstanceRegistry.update`) is still the pin is a node
 * read the caller re-runs at every use (§7, decided 2026-10-24).
 */
export function verifyRecipientDescriptor(
  d: RecipientDescriptor,
  profile: AztecRecipientProfile,
): RecipientDerivation {
  const pinned = pinnedProfile(profile);
  const f = descriptorFields(d);
  recipientRules(() => hashNetworkIdentity(d.network));
  if (hex32(f.classId) !== pinned.pinnedClassId) {
    refuseRecipient("class_not_pinned", "classId", `not ${pinned.sdk} ${pinned.pinnedClassId}`);
  }
  if (!isGrumpkinPoint({ x: f.signingPublicKeyX, y: f.signingPublicKeyY })) {
    refuseRecipient("signing_key_invalid", "signingPublicKeyY", "not a finite Grumpkin point");
  }
  if (!isGrumpkinPoint({ x: f.ivpkMX, y: f.ivpkMY })) {
    refuseRecipient("ivpk_invalid", "ivpkMY", "not a finite Grumpkin point");
  }
  const derivation = deriveRecipientAddress(d, pinned);
  if (derivation.address !== hex32(f.aztecAddress)) {
    refuseRecipient(
      "address_mismatch",
      "aztecAddress",
      `the descriptor derives ${derivation.address}`,
    );
  }
  return derivation;
}

// ---------------------------------------------------------------------------
// Recipient message wrapper (decided 2026-10-24/25)
// ---------------------------------------------------------------------------

/** `P`: ASCII, exactly these 36 bytes. */
export const RECIPIENT_MESSAGE_PREFIX = "\x19Xochi Shielded Recipient Message v1";
/** L = ceil((254 + 128) / 8): RFC 9380 hash_to_field sizing for a 254-bit field. */
export const RECIPIENT_MESSAGE_WIDE_BYTES = 48;
const PREFIX_BYTES = ethers.toUtf8Bytes(RECIPIENT_MESSAGE_PREFIX);

/** `OS2IP(u) mod r` for exactly 48 bytes: the wide reduction, alone. */
export function reduceWideToField(u48: ethers.BytesLike): Hex {
  const bytes = ethers.getBytes(u48);
  if (bytes.length !== RECIPIENT_MESSAGE_WIDE_BYTES) {
    throw new RangeError(`wide reduction takes exactly 48 bytes, got ${bytes.length}`);
  }
  return hex32(BigInt(ethers.hexlify(bytes)) % R);
}

export interface RecipientMessage {
  /** keccak256(P || d || 0x00) || keccak256(P || d || 0x01), 64 bytes. */
  u: Hex;
  /** u[0:48]. */
  u48: Hex;
  /** m = OS2IP(u48) mod r, 32 bytes big-endian: the value the account signs. */
  messageField: Hex;
}

/**
 * The wrapper over an EIP-712 digest `d` of the inner struct. Recipient tooling computes
 * `d` itself from the full typed preimage; it never takes `d` or `m` from Xochi.
 */
export function recipientMessage(digest: string): RecipientMessage {
  const d = ethers.getBytes(recipientRules(() => bytes32("digest", digest)));
  const u = ethers.concat([
    ethers.keccak256(ethers.concat([PREFIX_BYTES, d, "0x00"])),
    ethers.keccak256(ethers.concat([PREFIX_BYTES, d, "0x01"])),
  ]) as Hex;
  const u48 = ethers.dataSlice(u, 0, RECIPIENT_MESSAGE_WIDE_BYTES) as Hex;
  return { u, u48, messageField: reduceWideToField(u48) };
}

// ---------------------------------------------------------------------------
// Schnorr over Grumpkin: noir-lang/schnorr v0.4.0, what SchnorrAccount verifies
// ---------------------------------------------------------------------------

/** `poseidon2_hash_bytes("schnorr_grumpkin_poseidon2")`, pinned in the Noir library. */
export const SCHNORR_CHALLENGE_DST =
  0x024c76938ed06b8ec1d9094b1013d190baa4011372f0604643bda812a63b832en;

/**
 * Verifies `signature = s || e` (32 bytes each, big-endian) over the field element
 * `messageField` under the account's signing key: R = s*G + e*P, accept iff P is a finite
 * curve point, s != 0, e != 0, R != O and poseidon2([DST, R.x, P.x, P.y, m]) == e. Stricter
 * than the circuit on encodings, never looser: s >= q, e >= r and m >= r are refused. Do
 * not use signature bytes as an identifier.
 */
export function verifyRecipientSchnorr(
  publicKey: { x: string; y: string },
  messageField: string,
  signature: string,
): boolean {
  if (
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]{128}$/.test(signature) ||
    !/^0x[0-9a-fA-F]{64}$/.test(messageField) ||
    !/^0x[0-9a-fA-F]{64}$/.test(publicKey.x) ||
    !/^0x[0-9a-fA-F]{64}$/.test(publicKey.y)
  ) {
    return false;
  }
  const s = BigInt(signature.slice(0, 66));
  const e = BigInt("0x" + signature.slice(66));
  const msg = BigInt(messageField);
  const P = { x: BigInt(publicKey.x), y: BigInt(publicKey.y) };
  if (s === 0n || e === 0n || s >= GRUMPKIN_ORDER || e >= R || msg >= R) return false;
  if (!isGrumpkinPoint(P)) return false;
  const point = affine(addJ(mulJ(s, GENERATOR), mulJ(e, P)));
  if (point === null) return false;
  return poseidon2Hash([SCHNORR_CHALLENGE_DST, point.x, P.x, P.y, msg]) === e;
}
