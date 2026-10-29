#!/usr/bin/env node
// Generates `conformance/shielded-recipient.json` (+ `shielded-recipient.schema.json`): the
// recipient-side encodings of the shielded settlement contract v1 (xochi
// docs/planning/shielded-execution.md §7; epic xochi#633, xochi#635), as decided by the
// product owner on 2026-10-24/25:
//
//   1. descriptorDigest = EIP-712 hashStruct(RecipientDescriptor), and the derivation that
//      recomputes the descriptor's Aztec address for the stock SchnorrAccount pinned on each
//      network (Aztec 5.2.0 and the @aztec-labs 6.0.0 public testnet);
//   2. the recipient message wrapper and its WIDE reduction into the BN254 scalar field;
//   3. three approved acknowledgement structs.
//
// INDEPENDENT OF @xochi/signer, deliberately (the #41 rule). Every value is derived here
// with generic primitives only: ethers (TypedDataEncoder, keccak256, AbiCoder), node's
// sha512, @zkpassport/poseidon2 (BN254 Poseidon2, the hash Noir and bb.js use) and the
// Grumpkin arithmetic written out below. `@xochi/signer`'s `shielded-recipient.ts` is
// checked AGAINST the committed file (packages/signer/test/shielded-recipient-vectors.test.ts).
//
// The Aztec SDKs are NOT imported here. `packages/spec/aztec-crosscheck` (its own package,
// exact-pinned `@aztec/*` 5.2.0 and `@aztec-labs/*` 6.0.0, CI job `aztec-crosscheck`) holds
// this file's output to the real SDKs: class ids, constructor selector, key derivation,
// every derivation intermediate and address, and every Schnorr verdict through bb.js.
//
// TEST-ONLY KEYS. Every secret below is a synthetic scalar derived from a label containing
// "TEST ONLY" (`testScalar`). They exist so the vectors are reproducible; they hold nothing
// and must never be used for anything else. Networks, corridors, nonces and digests are
// fixtures.
//
// Run: npm run generate:shielded-recipient   (SHIELDED_VECTORS_DIR overrides the output dir)

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { ethers } from "ethers";

// --- Fields and curve --------------------------------------------------------------------

/** BN254 scalar field r = Grumpkin base field = Noir `Field`. */
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
/** BN254 base field q = Grumpkin group order (Aztec `GrumpkinScalar` / `Fq`). */
const Q = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
/** Grumpkin: y^2 = x^3 - 17 over F_r, generator (1, sqrt(-16)). */
const G = { x: 1n, y: 0x0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272cn };

type Point = { x: bigint; y: bigint };

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let out = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) out = (out * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return out;
}
const inv = (a: bigint) => modPow(a, R - 2n, R);
const onCurve = (p: Point) =>
  p.x >= 0n && p.x < R && p.y >= 0n && p.y < R && mod(p.y * p.y - (p.x ** 3n - 17n), R) === 0n;

// Affine arithmetic, `null` = the point at infinity. Public data only (derivation and the
// test-only signer below), so no constant-time care is taken.
function add(a: Point | null, b: Point | null): Point | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y, R) === 0n) return null;
    const l = mod(3n * a.x * a.x * inv(2n * a.y), R);
    const x = mod(l * l - 2n * a.x, R);
    return { x, y: mod(l * (a.x - x) - a.y, R) };
  }
  const l = mod((b.y - a.y) * inv(b.x - a.x), R);
  const x = mod(l * l - a.x - b.x, R);
  return { x, y: mod(l * (a.x - x) - a.y, R) };
}
function mul(k: bigint, p: Point): Point | null {
  let out: Point | null = null;
  let acc: Point | null = p;
  for (let e = mod(k, Q); e > 0n; e >>= 1n) {
    if (e & 1n) out = add(out, acc);
    acc = add(acc, acc);
  }
  return out;
}
const mulG = (k: bigint): Point => {
  const p = mul(k, G);
  if (p === null) throw new Error("scalar is 0 mod q");
  return p;
};
if (!onCurve(G)) throw new Error("Grumpkin generator is not on the curve");

const p2 = (inputs: bigint[]) => poseidon2Hash(inputs);
const hex32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
function be(v: bigint, bytes: number): Uint8Array {
  const raw = ethers.toBeArray(v);
  if (raw.length > bytes) throw new Error(`${v} does not fit ${bytes} bytes`);
  return ethers.getBytes(ethers.zeroPadValue(raw, bytes));
}
const os2ip = (bytes: Uint8Array) => (bytes.length === 0 ? 0n : BigInt(ethers.hexlify(bytes)));

/** A synthetic scalar from a TEST ONLY label (keccak256 of the label, reduced). */
const testScalar = (label: string, modulus: bigint) => {
  if (!label.includes("TEST ONLY")) throw new Error(`test label must say TEST ONLY: ${label}`);
  const v = mod(BigInt(ethers.id(label)), modulus);
  if (v === 0n) throw new Error(`zero test scalar for ${label}`);
  return v;
};

// --- Aztec derivation constants (read from the pinned SDKs; aztec-crosscheck holds them) ----

// `DomainSeparator` values, @aztec/constants 5.2.0 and @aztec-labs/constants 6.0.0. Only the
// contract-address separator differs between the two (V2 -> V3).
const SEP = {
  FUNCTION_ARGS: 3576554347n,
  INITIALIZER: 385396519n,
  SALTED_INITIALIZATION_HASH: 2763052992n,
  PARTIAL_ADDRESS: 2103633018n,
  PUBLIC_KEYS_HASH: 777457226n,
  SINGLE_PUBLIC_KEY_HASH: 3452068255n,
};
// Master-key derivation separators (stdlib `deriveKeys`). Used only to build the TEST-ONLY
// fixture accounts the way a stock wallet does; verification never needs a secret.
const KEY_SEP = {
  NHK_M: 242137788,
  IVSK_M: 2747825907,
  OVSK_M: 4272201051,
  TSK_M: 1546190975,
  MSSK_M: 617962565,
  FBSK_M: 787738027,
};
// `poseidon2_hash_bytes("schnorr_grumpkin_poseidon2")`, noir-lang/schnorr v0.4.0, the
// library both pinned SchnorrAccount artifacts call from `is_valid_impl`.
const SCHNORR_CHALLENGE_DST = 0x024c76938ed06b8ec1d9094b1013d190baa4011372f0604643bda812a63b832en;

// FunctionSelector.fromNameAndParameters("constructor", [Field, Field]): the same in both
// SDKs, since the selector depends only on the signature string `constructor(Field,Field)`.
const CONSTRUCTOR_SELECTOR = 0xcd9728afn;

type Profile = {
  id: string;
  sdk: string;
  network: string;
  pinnedClassId: string;
  artifactHash: string;
  initializerlessClassId: string;
  contractAddressSeparator: { name: string; value: bigint };
};
const PROFILES: Profile[] = [
  {
    id: "aztec-5.2.0",
    sdk: "@aztec/accounts 5.2.0 SchnorrAccount",
    network: "Aztec SDK 5.2.0 networks (Aztec mainnet)",
    pinnedClassId: "0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd",
    artifactHash: "0x153f4c0cf8c78f5d943aaa307706a90128eee86af5242b1eda55aeca7372591a",
    initializerlessClassId: "0x1c59d7500b7d8ba4bb13ace9e7c07e9576a11a5966624ced14f8efd117b9d5b2",
    contractAddressSeparator: { name: "CONTRACT_ADDRESS_V2", value: 4099338721n },
  },
  {
    id: "aztec-6.0.0",
    sdk: "@aztec-labs/accounts 6.0.0 SchnorrAccount",
    network: "Aztec public testnet 6.0.0 (corridor manifest revision 1)",
    pinnedClassId: "0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15",
    artifactHash: "0x0b0ac14534e632fe31df7b90d8dc8c2a7a0d815bb6768d9e72b1c23a9c3b646d",
    initializerlessClassId: "0x222287bfcd04411264393983dd8d01ca5ea9ae305d1a10a1e6d8deef7f17659b",
    contractAddressSeparator: { name: "CONTRACT_ADDRESS_V3", value: 993442748n },
  },
];
const profileById = (id: string) => PROFILES.find((p) => p.id === id)!;

// --- EIP-712 types ------------------------------------------------------------------------

const DOMAIN_VERSION = "1";
const BINDING_DOMAIN_NAME = "Xochi Shielded Recipient";
const BINDING_PURPOSE = "xochi.shielded.recipient-binding.v1";
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)";

const NETWORK_IDENTITY = [
  { name: "aztecChainId", type: "uint256" },
  { name: "protocolVersion", type: "uint256" },
  { name: "rollupAddress", type: "address" },
  { name: "l1ChainId", type: "uint256" },
  { name: "genesisOrNetworkDigest", type: "bytes32" },
];
const NETWORK_IDENTITY_TYPE_STRING =
  "NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress," +
  "uint256 l1ChainId,bytes32 genesisOrNetworkDigest)";

// The descriptor carries exactly what recomputes the address of a stock SchnorrAccount:
// the instance fields (address, class, salt, deployer), the constructor args (the Schnorr
// signing key), and the account's public keys in the SDK's public form (`PublicKeys`):
// ivpk_m as a point (the address adds it), the other five master keys as their
// `hashPublicKey` digests, which is all a non-owner ever sees of them. immutablesHash is not
// a member: it is 0 for the pinned class, and a nonzero one is refused (§7), so the
// derivation fixes it at 0.
const DESCRIPTOR_MEMBERS = [
  { name: "aztecAddress", type: "bytes32" },
  { name: "classId", type: "bytes32" },
  { name: "salt", type: "bytes32" },
  { name: "deployer", type: "bytes32" },
  { name: "signingPublicKeyX", type: "bytes32" },
  { name: "signingPublicKeyY", type: "bytes32" },
  { name: "npkMHash", type: "bytes32" },
  { name: "ivpkMX", type: "bytes32" },
  { name: "ivpkMY", type: "bytes32" },
  { name: "ovpkMHash", type: "bytes32" },
  { name: "tpkMHash", type: "bytes32" },
  { name: "mspkMHash", type: "bytes32" },
  { name: "fbpkMHash", type: "bytes32" },
  { name: "network", type: "NetworkIdentity" },
];
const DESCRIPTOR_TYPES = {
  RecipientDescriptor: DESCRIPTOR_MEMBERS,
  NetworkIdentity: NETWORK_IDENTITY,
};
const DESCRIPTOR_TYPE_STRING =
  "RecipientDescriptor(bytes32 aztecAddress,bytes32 classId,bytes32 salt,bytes32 deployer," +
  "bytes32 signingPublicKeyX,bytes32 signingPublicKeyY,bytes32 npkMHash,bytes32 ivpkMX," +
  "bytes32 ivpkMY,bytes32 ovpkMHash,bytes32 tpkMHash,bytes32 mspkMHash,bytes32 fbpkMHash," +
  "NetworkIdentity network)" +
  NETWORK_IDENTITY_TYPE_STRING;

const BINDING_TYPES = {
  RecipientBinding: [
    { name: "sourceWallet", type: "address" },
    { name: "sourceChainId", type: "uint256" },
    { name: "aztecRecipient", type: "bytes32" },
    { name: "aztecToken", type: "bytes32" },
    { name: "descriptorDigest", type: "bytes32" },
    { name: "corridorId", type: "bytes32" },
    { name: "corridorRevision", type: "uint32" },
    { name: "manifestDigest", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "challengeExpiry", type: "uint64" },
    { name: "purpose", type: "string" },
  ],
};
const BINDING_TYPE_STRING =
  "RecipientBinding(address sourceWallet,uint256 sourceChainId,bytes32 aztecRecipient," +
  "bytes32 aztecToken,bytes32 descriptorDigest,bytes32 corridorId,uint32 corridorRevision," +
  "bytes32 manifestDigest,bytes32 nonce,uint64 challengeExpiry,string purpose)";

// Approved acknowledgement structs (decision 3, 2026-10-29). Each has its own primary
// type and purpose string; all are signed under `Domain (binding)` through the recipient
// message wrapper. They share the binding's challenge members (nonce, challengeExpiry) and
// name the binding by its EIP-712 digest, so an acknowledgement is scoped to one binding.
const ACKS = [
  {
    primaryType: "BackupPersistenceAck",
    purpose: "xochi.shielded.backup-persistence-ack.v1",
    scope: "both designs",
    members: [
      { name: "bindingDigest", type: "bytes32" },
      { name: "aztecRecipient", type: "bytes32" },
      { name: "backupCommitment", type: "bytes32" },
      { name: "backupFormatId", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "challengeExpiry", type: "uint64" },
      { name: "purpose", type: "string" },
    ],
  },
  {
    primaryType: "SenderRegistrationAck",
    purpose: "xochi.shielded.sender-registration-ack.v1",
    scope: "B-panel",
    members: [
      { name: "bindingDigest", type: "bytes32" },
      { name: "aztecRecipient", type: "bytes32" },
      { name: "registeredSenders", type: "bytes32[]" },
      { name: "nonce", type: "bytes32" },
      { name: "challengeExpiry", type: "uint64" },
      { name: "purpose", type: "string" },
    ],
  },
  {
    primaryType: "PaymentReceiptAck",
    purpose: "xochi.shielded.payment-receipt-ack.v1",
    scope: "both designs",
    members: [
      { name: "bindingDigest", type: "bytes32" },
      { name: "termsDigest", type: "bytes32" },
      { name: "operationId", type: "bytes32" },
      { name: "network", type: "NetworkIdentity" },
      { name: "txHash", type: "bytes32" },
      { name: "blockNumber", type: "uint64" },
      { name: "aztecToken", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "aztecRecipient", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "challengeExpiry", type: "uint64" },
      { name: "purpose", type: "string" },
    ],
  },
] as const;
type AckType = (typeof ACKS)[number]["primaryType"];

const typesFor = (primaryType: string): Record<string, { name: string; type: string }[]> => {
  if (primaryType === "RecipientBinding") return { ...BINDING_TYPES };
  const ack = ACKS.find((a) => a.primaryType === primaryType)!;
  const types: Record<string, { name: string; type: string }[]> = {
    [primaryType]: ack.members.map((m) => ({ ...m })),
  };
  if (ack.members.some((m) => m.type === "NetworkIdentity"))
    types.NetworkIdentity = NETWORK_IDENTITY;
  return types;
};
const typeString = (primaryType: string) =>
  ethers.TypedDataEncoder.from(typesFor(primaryType)).encodeType(primaryType);

// The literals above are what the vectors publish; the type definitions must spell them.
if (
  ethers.TypedDataEncoder.from(DESCRIPTOR_TYPES).encodeType("RecipientDescriptor") !==
  DESCRIPTOR_TYPE_STRING
) {
  throw new Error("RecipientDescriptor types do not spell the literal type string");
}
if (typeString("RecipientBinding") !== BINDING_TYPE_STRING) {
  throw new Error("RecipientBinding types do not spell the approved type string");
}

// --- Recipient message wrapper (decision 2) ----------------------------------------------

const MESSAGE_PREFIX = "\x19Xochi Shielded Recipient Message v1";
const PREFIX_BYTES = ethers.toUtf8Bytes(MESSAGE_PREFIX);
if (PREFIX_BYTES.length !== 36 || PREFIX_BYTES[0] !== 0x19) throw new Error("prefix bytes");
/** L = ceil((ceil(log2 r) + k) / 8) with k = 128 (RFC 9380 hash_to_field sizing). */
const WIDE_BYTES = 48;
if (R.toString(2).length !== 254 || Math.ceil((254 + 128) / 8) !== WIDE_BYTES) {
  throw new Error("wide-reduction length");
}

type Wrapped = { u: string; u48: string; messageField: string; provisionalPlainModR: string };
function wrap(digest: string): Wrapped {
  const d = ethers.getBytes(digest);
  if (d.length !== 32) throw new Error("digest must be 32 bytes");
  const u0 = ethers.keccak256(ethers.concat([PREFIX_BYTES, d, "0x00"]));
  const u1 = ethers.keccak256(ethers.concat([PREFIX_BYTES, d, "0x01"]));
  const u = ethers.concat([u0, u1]);
  const u48 = ethers.dataSlice(u, 0, WIDE_BYTES);
  return {
    u,
    u48,
    messageField: hex32(os2ip(ethers.getBytes(u48)) % R),
    // NOT the rule: the compatibility spike's provisional plain reduction, OS2IP(d) mod r.
    provisionalPlainModR: hex32(os2ip(d) % R),
  };
}

// --- Schnorr over Grumpkin (noir-lang/schnorr v0.4.0), TEST-ONLY deterministic signer -------

/**
 * e = Poseidon2([DST, R.x, P.x, P.y, m]); s = k - e * sk (mod q); signature = s || e (big
 * endian, 32 bytes each). The nonce k is derived from the TEST-ONLY key and the message, so
 * reruns are byte-identical; a real signer's nonce is its own business (bb.js draws one at
 * random), and any valid nonce verifies the same way.
 */
function schnorrSign(sk: bigint, message: bigint): string {
  const pk = mulG(sk);
  const k =
    os2ip(
      createHash("sha512")
        .update(ethers.toUtf8Bytes("xochi-spec TEST ONLY schnorr nonce"))
        .update(be(sk, 32))
        .update(be(message, 32))
        .digest(),
    ) % Q;
  if (k === 0n) throw new Error("zero nonce");
  const Rpt = mulG(k);
  const e = p2([SCHNORR_CHALLENGE_DST, Rpt.x, pk.x, pk.y, message]);
  const s = mod(k - e * sk, Q);
  if (s === 0n || e === 0n) throw new Error("degenerate signature");
  if (!schnorrVerify(pk, message, s, e)) throw new Error("signature does not verify");
  return hex32(s) + hex32(e).slice(2);
}
function schnorrVerify(pk: Point, message: bigint, s: bigint, e: bigint): boolean {
  if (!onCurve(pk) || s === 0n || e === 0n || s >= Q || e >= R || message >= R) return false;
  const Rpt = add(mul(s, G), mul(e, pk));
  if (Rpt === null) return false;
  return p2([SCHNORR_CHALLENGE_DST, Rpt.x, pk.x, pk.y, message]) === e;
}
const verifySig = (pk: Point, message: string, sig: string) =>
  schnorrVerify(pk, BigInt(message), BigInt(sig.slice(0, 66)), BigInt("0x" + sig.slice(66)));

// --- Fixture accounts (TEST-ONLY keys) -----------------------------------------------------

/** stdlib `sha512ToGrumpkinScalar([secretKey, separator])`: sha512(Fr || u32) mod q. */
const masterScalar = (secretKey: bigint, sep: number) =>
  os2ip(
    createHash("sha512")
      .update(be(secretKey, 32))
      .update(be(BigInt(sep), 4))
      .digest(),
  ) % Q;
const hashPublicKey = (p: Point) => p2([SEP.SINGLE_PUBLIC_KEY_HASH, p.x, p.y]);

type Network = Record<(typeof NETWORK_IDENTITY)[number]["name"], string>;
type Descriptor = {
  aztecAddress: string;
  classId: string;
  salt: string;
  deployer: string;
  signingPublicKeyX: string;
  signingPublicKeyY: string;
  npkMHash: string;
  ivpkMX: string;
  ivpkMY: string;
  ovpkMHash: string;
  tpkMHash: string;
  mspkMHash: string;
  fbpkMHash: string;
  network: Network;
};

/** The descriptor's address recomputation, every intermediate published. */
type Derivation = {
  constructorArgsHash: string;
  initializationHash: string;
  immutablesHash: string;
  saltedInitializationHash: string;
  partialAddress: string;
  ivpkMHash: string;
  publicKeysHash: string;
  preaddress: string;
  addressPoint: { x: string; y: string };
  address: string;
};
function derive(d: Omit<Descriptor, "aztecAddress" | "network">, profile: Profile): Derivation {
  const argsHash = p2([
    SEP.FUNCTION_ARGS,
    BigInt(d.signingPublicKeyX),
    BigInt(d.signingPublicKeyY),
  ]);
  const initializationHash = p2([SEP.INITIALIZER, CONSTRUCTOR_SELECTOR, argsHash]);
  const saltedInitializationHash = p2([
    SEP.SALTED_INITIALIZATION_HASH,
    BigInt(d.salt),
    initializationHash,
    BigInt(d.deployer),
    0n, // immutablesHash
  ]);
  const partialAddress = p2([SEP.PARTIAL_ADDRESS, BigInt(d.classId), saltedInitializationHash]);
  const ivpkM = { x: BigInt(d.ivpkMX), y: BigInt(d.ivpkMY) };
  const ivpkMHash = hashPublicKey(ivpkM);
  const publicKeysHash = p2([
    SEP.PUBLIC_KEYS_HASH,
    BigInt(d.npkMHash),
    ivpkMHash,
    BigInt(d.ovpkMHash),
    BigInt(d.tpkMHash),
    BigInt(d.mspkMHash),
    BigInt(d.fbpkMHash),
  ]);
  const preaddress = p2([profile.contractAddressSeparator.value, publicKeysHash, partialAddress]);
  const addressPoint = add(mulG(preaddress), ivpkM);
  if (addressPoint === null) throw new Error("address point at infinity");
  return {
    constructorArgsHash: hex32(argsHash),
    initializationHash: hex32(initializationHash),
    immutablesHash: hex32(0n),
    saltedInitializationHash: hex32(saltedInitializationHash),
    partialAddress: hex32(partialAddress),
    ivpkMHash: hex32(ivpkMHash),
    publicKeysHash: hex32(publicKeysHash),
    preaddress: hex32(preaddress),
    addressPoint: { x: hex32(addressPoint.x), y: hex32(addressPoint.y) },
    address: hex32(addressPoint.x),
  };
}

// Networks are FIXTURES (§7 NetworkIdentity); nothing in the address depends on them.
const NET_MAINNET_FIXTURE: Network = {
  aztecChainId: "1",
  protocolVersion: "2934756011",
  rollupAddress: "0x" + "b1".repeat(20),
  l1ChainId: "1",
  genesisOrNetworkDigest: "0x" + "5e".repeat(32),
};
const NET_TESTNET_FIXTURE: Network = {
  aztecChainId: "11155111",
  protocolVersion: "679261766",
  rollupAddress: "0x" + "b6".repeat(20),
  l1ChainId: "11155111",
  genesisOrNetworkDigest: "0x" + "6e".repeat(32),
};

type Account = {
  name: string;
  profile: Profile;
  secrets: { secretKey: string; signingPrivateKey: string };
  signingKey: bigint;
  signingPublicKey: Point;
  descriptor: Descriptor;
  derivation: Derivation;
};

function account(
  name: string,
  profile: Profile,
  network: Network,
  seed: string,
  salt: bigint,
  deployer: bigint,
): Account {
  const secretKey = testScalar(`xochi-spec TEST ONLY recipient secret key: ${seed}`, R);
  const signingKey = testScalar(`xochi-spec TEST ONLY recipient signing key: ${seed}`, Q);
  const signingPublicKey = mulG(signingKey);
  const pub = Object.fromEntries(
    Object.entries(KEY_SEP).map(([k, sep]) => [k, mulG(masterScalar(secretKey, sep))]),
  ) as Record<keyof typeof KEY_SEP, Point>;
  const partial = {
    classId: profile.pinnedClassId,
    salt: hex32(salt),
    deployer: hex32(deployer),
    signingPublicKeyX: hex32(signingPublicKey.x),
    signingPublicKeyY: hex32(signingPublicKey.y),
    npkMHash: hex32(hashPublicKey(pub.NHK_M)),
    ivpkMX: hex32(pub.IVSK_M.x),
    ivpkMY: hex32(pub.IVSK_M.y),
    ovpkMHash: hex32(hashPublicKey(pub.OVSK_M)),
    tpkMHash: hex32(hashPublicKey(pub.TSK_M)),
    mspkMHash: hex32(hashPublicKey(pub.MSSK_M)),
    fbpkMHash: hex32(hashPublicKey(pub.FBSK_M)),
  };
  const derivation = derive(partial, profile);
  const descriptor: Descriptor = { aztecAddress: derivation.address, ...partial, network };
  return {
    name,
    profile,
    secrets: { secretKey: hex32(secretKey), signingPrivateKey: hex32(signingKey) },
    signingKey,
    signingPublicKey,
    descriptor,
    derivation,
  };
}

const ACCOUNTS = [
  account(
    "aztec-5.2.0-stock",
    profileById("aztec-5.2.0"),
    NET_MAINNET_FIXTURE,
    "5.2.0 a",
    0x5a17n,
    0n,
  ),
  account(
    "aztec-5.2.0-nonzero-deployer",
    profileById("aztec-5.2.0"),
    NET_MAINNET_FIXTURE,
    "5.2.0 b",
    R - 1n,
    0x2a5en,
  ),
  account(
    "aztec-6.0.0-stock",
    profileById("aztec-6.0.0"),
    NET_TESTNET_FIXTURE,
    "6.0.0 a",
    0x6a17n,
    0n,
  ),
  account(
    "aztec-6.0.0-nonzero-deployer",
    profileById("aztec-6.0.0"),
    NET_TESTNET_FIXTURE,
    "6.0.0 b",
    1n,
    0x2a5en,
  ),
];
const acct = (name: string) => ACCOUNTS.find((a) => a.name === name)!;

const descriptorDigest = (d: Descriptor) =>
  ethers.TypedDataEncoder.hashStruct("RecipientDescriptor", DESCRIPTOR_TYPES, d);

// Same keys, salt and deployer under both profiles: the class id and the address separator
// alone move the address, so a descriptor is meaningful on exactly one network line.
const crossProfile = (() => {
  const a = acct("aztec-6.0.0-stock");
  const other = profileById("aztec-5.2.0");
  const { aztecAddress: _a, network: _n, ...rest } = a.descriptor;
  const asOther = derive({ ...rest, classId: other.pinnedClassId }, other);
  return {
    name: "same-keys-salt-deployer-both-profiles",
    keysFrom: a.name,
    addresses: { "aztec-6.0.0": a.derivation.address, "aztec-5.2.0": asOther.address },
  };
})();
if (crossProfile.addresses["aztec-6.0.0"] === crossProfile.addresses["aztec-5.2.0"]) {
  throw new Error("profiles must derive different addresses");
}

const descriptorVectors = ACCOUNTS.map((a) => ({
  name: a.name,
  profile: a.profile.id,
  testOnlySecrets: a.secrets,
  descriptor: a.descriptor,
  descriptorDigest: descriptorDigest(a.descriptor),
  derivation: a.derivation,
}));

// --- Descriptor refusals -------------------------------------------------------------------
//
// Checks run in this order, and the first failure names the refusal:
//   1. encoding: every bytes32 is 0x + 64 hex (not_bytes32) and a field element below r
//      (aztec_out_of_field); aztecAddress is nonzero (aztec_zero);
//   2. class: classId equals the profile's pinned class (class_not_pinned);
//   3. points: the signing key and ivpk_m are finite points on Grumpkin (signing_key_invalid,
//      ivpk_invalid). (0, 0) is refused too: it is not on the curve, and the SDKs read it as
//      the point at infinity, which no account key can be;
//   4. address: the derivation's address equals aztecAddress (address_mismatch).
// The NetworkIdentity member is validated as in shielded.json and is not repeated here.

const EVM_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"; // public test account #1
const descriptorRefusals = (() => {
  const out: {
    name: string;
    profile: string;
    descriptor: Descriptor;
    error: { code: string; field: string };
  }[] = [];
  const push = (
    name: string,
    base: Account,
    patch: Partial<Descriptor>,
    code: string,
    field: string,
    rederive = false,
  ) => {
    let descriptor = { ...base.descriptor, ...patch };
    if (rederive) {
      // Self-consistent forgery: the address is recomputed from the forged inputs, so the
      // named check is the only one that fails.
      const { aztecAddress: _a, network: _n, ...rest } = descriptor;
      descriptor = { ...descriptor, aztecAddress: derive(rest, base.profile).address };
    }
    out.push({ name, profile: base.profile.id, descriptor, error: { code, field } });
  };
  for (const id of ["aztec-5.2.0", "aztec-6.0.0"]) {
    const base = acct(`${id}-stock`);
    const other = PROFILES.find((p) => p.id !== id)!;
    const otherAcct = acct(`${id}-nonzero-deployer`);
    // A descriptor that derives a different address than it claims.
    push(
      `${id}: salt changed, address kept`,
      base,
      { salt: hex32(BigInt(base.descriptor.salt) + 1n) },
      "address_mismatch",
      "aztecAddress",
    );
    push(
      `${id}: another valid signing key, address kept`,
      base,
      {
        signingPublicKeyX: otherAcct.descriptor.signingPublicKeyX,
        signingPublicKeyY: otherAcct.descriptor.signingPublicKeyY,
      },
      "address_mismatch",
      "aztecAddress",
    );
    push(
      `${id}: ivpk_m of another account, address kept`,
      base,
      { ivpkMX: otherAcct.descriptor.ivpkMX, ivpkMY: otherAcct.descriptor.ivpkMY },
      "address_mismatch",
      "aztecAddress",
    );
    push(
      `${id}: tpk_m hash changed, address kept`,
      base,
      { tpkMHash: otherAcct.descriptor.tpkMHash },
      "address_mismatch",
      "aztecAddress",
    );
    push(
      `${id}: deployer changed, address kept`,
      base,
      { deployer: hex32(1n) },
      "address_mismatch",
      "aztecAddress",
    );
    push(
      `${id}: padded EVM address as aztecAddress`,
      base,
      { aztecAddress: ethers.zeroPadValue(EVM_ADDRESS, 32) },
      "address_mismatch",
      "aztecAddress",
    );
    push(
      `${id}: the other network's address for the same keys`,
      base,
      {
        aztecAddress: derive(
          (({ aztecAddress: _a, network: _n, ...r }) => ({ ...r, classId: other.pinnedClassId }))(
            base.descriptor,
          ),
          other,
        ).address,
      },
      "address_mismatch",
      "aztecAddress",
    );
    // Wrong class id, address recomputed so only the pin fails.
    push(
      `${id}: SchnorrInitializerlessAccount class`,
      base,
      { classId: base.profile.initializerlessClassId },
      "class_not_pinned",
      "classId",
      true,
    );
    push(
      `${id}: the other network's pinned class`,
      base,
      { classId: other.pinnedClassId },
      "class_not_pinned",
      "classId",
      true,
    );
    // Points.
    push(
      `${id}: signing key off curve (y + 1), address recomputed`,
      base,
      { signingPublicKeyY: hex32((BigInt(base.descriptor.signingPublicKeyY) + 1n) % R) },
      "signing_key_invalid",
      "signingPublicKeyY",
      true,
    );
    push(
      `${id}: signing key coordinates swapped, address recomputed`,
      base,
      {
        signingPublicKeyX: base.descriptor.signingPublicKeyY,
        signingPublicKeyY: base.descriptor.signingPublicKeyX,
      },
      "signing_key_invalid",
      "signingPublicKeyY",
      true,
    );
    push(
      `${id}: signing key (0, 0) = the SDK's point at infinity, address recomputed`,
      base,
      { signingPublicKeyX: hex32(0n), signingPublicKeyY: hex32(0n) },
      "signing_key_invalid",
      "signingPublicKeyY",
      true,
    );
    push(
      `${id}: ivpk_m off curve (y + 1)`,
      base,
      { ivpkMY: hex32((BigInt(base.descriptor.ivpkMY) + 1n) % R) },
      "ivpk_invalid",
      "ivpkMY",
    );
    push(
      `${id}: ivpk_m (0, 0) = the SDK's point at infinity`,
      base,
      { ivpkMX: hex32(0n), ivpkMY: hex32(0n) },
      "ivpk_invalid",
      "ivpkMY",
    );
    // Encoding.
    push(
      `${id}: aztecAddress zero`,
      base,
      { aztecAddress: hex32(0n) },
      "aztec_zero",
      "aztecAddress",
    );
    push(
      `${id}: aztecAddress = r`,
      base,
      { aztecAddress: hex32(R) },
      "aztec_out_of_field",
      "aztecAddress",
    );
    push(`${id}: salt = r`, base, { salt: hex32(R) }, "aztec_out_of_field", "salt");
    push(
      `${id}: signing key x + r`,
      base,
      { signingPublicKeyX: hex32(BigInt(base.descriptor.signingPublicKeyX) + R) },
      "aztec_out_of_field",
      "signingPublicKeyX",
    );
    push(
      `${id}: npkMHash 31 bytes`,
      base,
      { npkMHash: base.descriptor.npkMHash.slice(0, -2) },
      "not_bytes32",
      "npkMHash",
    );
    push(
      `${id}: classId uppercase 0X prefix`,
      base,
      { classId: "0X" + base.descriptor.classId.slice(2) },
      "not_bytes32",
      "classId",
    );
  }
  return out;
})();
// Each class/point forgery must pass every check before the one it names.
for (const r of descriptorRefusals) {
  if (r.error.code === "class_not_pinned" || r.error.field === "signingPublicKeyY") {
    const { aztecAddress, network: _n, ...rest } = r.descriptor;
    if (derive(rest, profileById(r.profile)).address !== aztecAddress) {
      throw new Error(`${r.name}: forgery is not self-consistent`);
    }
  }
}

// --- RecipientBinding messages (decision 2) --------------------------------------------------

const ENVIRONMENT = "staging";
const SOURCE_CHAIN_ID = "84532"; // Base Sepolia, corridor manifest revision 1 (§7)
const networkDigest = (n: Network) =>
  ethers.TypedDataEncoder.hashStruct("NetworkIdentity", { NetworkIdentity: NETWORK_IDENTITY }, n);
const bindingDomain = (environment: string, chainId: string, network: Network): Domain => ({
  name: BINDING_DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId,
  salt: ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ethers.id(environment), networkDigest(network)],
    ),
  ),
});

const SOURCE_WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // public test account #0
const bindingFor = (a: Account, nonce: string) => ({
  sourceWallet: SOURCE_WALLET,
  sourceChainId: SOURCE_CHAIN_ID,
  aztecRecipient: a.descriptor.aztecAddress,
  aztecToken: "0x" + "2b".repeat(32),
  descriptorDigest: descriptorDigest(a.descriptor),
  corridorId: "0x" + "c0".repeat(32),
  corridorRevision: "1",
  manifestDigest: "0x" + "4d".repeat(32),
  nonce,
  challengeExpiry: "1900000000",
  purpose: BINDING_PURPOSE,
});

type Domain = { name: string; version: string; chainId: string; salt: string };
type Signed = {
  primaryType: string;
  environment: string;
  network: Network;
  domain: Domain;
  message: Record<string, unknown>;
  structHash: string;
  digest: string;
  wrapper: Wrapped;
  publicKey: { x: string; y: string };
  signature: string;
};
/** Signs under `Domain (binding)` for the account's network and the corridor's source chain. */
function signAs(
  a: Account,
  primaryType: string,
  environment: string,
  message: Record<string, unknown>,
): Signed {
  const network = a.descriptor.network;
  const domain = bindingDomain(environment, SOURCE_CHAIN_ID, network);
  const types = typesFor(primaryType);
  const digest = ethers.TypedDataEncoder.hash(domain, types, message);
  const wrapper = wrap(digest);
  return {
    primaryType,
    environment,
    network,
    domain,
    message,
    structHash: ethers.TypedDataEncoder.hashStruct(primaryType, types, message),
    digest,
    wrapper,
    publicKey: { x: hex32(a.signingPublicKey.x), y: hex32(a.signingPublicKey.y) },
    signature: schnorrSign(a.signingKey, BigInt(wrapper.messageField)),
  };
}

const bindingMessages = ["aztec-5.2.0-stock", "aztec-6.0.0-stock"].map((name) => {
  const a = acct(name);
  const s = signAs(a, "RecipientBinding", ENVIRONMENT, bindingFor(a, "0x" + "0e".repeat(32)));
  if (s.wrapper.provisionalPlainModR === s.wrapper.messageField) throw new Error("rules coincide");
  return { name: `${name} binding`, account: name, ...s };
});

// The same recipient key, signing the provisional plain reduction instead: refused.
const messageRefusals = bindingMessages.flatMap((v) => {
  const a = acct(v.account);
  const pk = a.signingPublicKey;
  const plainSig = schnorrSign(a.signingKey, BigInt(v.wrapper.provisionalPlainModR));
  const cases = [
    {
      name: `${v.name}: signature over the provisional plain reduction OS2IP(d) mod r`,
      signature: plainSig,
      signedField: v.wrapper.provisionalPlainModR,
    },
    {
      name: `${v.name}: signature over the truncated reduction OS2IP(u[0:32]) mod r`,
      signature: schnorrSign(
        a.signingKey,
        os2ip(ethers.getBytes(ethers.dataSlice(v.wrapper.u, 0, 32))) % R,
      ),
      signedField: hex32(os2ip(ethers.getBytes(ethers.dataSlice(v.wrapper.u, 0, 32))) % R),
    },
    {
      name: `${v.name}: valid signature, other account's key`,
      signature: v.signature,
      signedField: v.wrapper.messageField,
      publicKey: {
        x: acct(v.account.replace("stock", "nonzero-deployer")).descriptor.signingPublicKeyX,
        y: acct(v.account.replace("stock", "nonzero-deployer")).descriptor.signingPublicKeyY,
      },
    },
  ];
  return cases.map((c) => {
    const publicKey = c.publicKey ?? v.publicKey;
    const ok = verifySig(
      { x: BigInt(publicKey.x), y: BigInt(publicKey.y) },
      v.wrapper.messageField,
      c.signature,
    );
    if (ok) throw new Error(`${c.name} must not verify`);
    if (c.publicKey === undefined && !verifySig(pk, c.signedField, c.signature))
      throw new Error(`${c.name}: not a real signature`);
    return {
      name: c.name,
      account: v.account,
      digest: v.digest,
      messageField: v.wrapper.messageField,
      signedField: c.signedField,
      publicKey,
      signature: c.signature,
      valid: false,
    };
  });
});

// --- Wide reduction alone ------------------------------------------------------------------

const TWO_384 = 1n << 384n;
const K_MAX = (TWO_384 - 1n) / R; // largest k with k*r < 2^384
const reductionInputs: { name: string; value: bigint }[] = [
  { name: "zero", value: 0n },
  { name: "one", value: 1n },
  { name: "r - 1", value: R - 1n },
  { name: "r", value: R },
  { name: "r + 1", value: R + 1n },
  { name: "2r - 1", value: 2n * R - 1n },
  { name: "2r", value: 2n * R },
  { name: "2^256 - 1 (all-ones low 32 bytes)", value: (1n << 256n) - 1n },
  {
    name: "(r + 1) * 2^128: truncation to 256 bits gives r + 1 (-> 1), wide gives 2^128",
    value: (R + 1n) << 128n,
  },
  { name: "r * 2^128 (a multiple of r)", value: R << 128n },
  { name: "r * 2^128 - 1", value: (R << 128n) - 1n },
  { name: "kmax * r - 1", value: K_MAX * R - 1n },
  { name: "kmax * r (largest multiple of r below 2^384)", value: K_MAX * R },
  { name: "kmax * r + 1", value: K_MAX * R + 1n },
  { name: "2^384 - 1 (all-ones)", value: TWO_384 - 1n },
];
const reductionVectors = reductionInputs.map(({ name, value }) => {
  if (value < 0n || value >= TWO_384) throw new Error(`${name} out of range`);
  const u48 = ethers.hexlify(be(value, 48));
  const truncated = os2ip(ethers.getBytes(ethers.dataSlice(u48, 0, 32))) % R;
  return {
    name,
    u48,
    messageField: hex32(value % R),
    notTheRule: { truncated256ModR: hex32(truncated) },
  };
});
if (!reductionVectors.some((v) => v.notTheRule.truncated256ModR !== v.messageField)) {
  throw new Error("need a vector where the 256-bit reduction differs");
}

// --- Acknowledgements (decision 3, approved 2026-10-29) -------------------------------------

const ackAccount = acct("aztec-6.0.0-stock");
const ackDomain = bindingDomain(ENVIRONMENT, SOURCE_CHAIN_ID, ackAccount.descriptor.network);
const bindingX = bindingMessages.find((b) => b.account === ackAccount.name)!;
const BINDING_X = bindingX.digest;
// Another binding of the same recipient (a fresh enrollment: new challenge nonce).
const BINDING_Y = ethers.TypedDataEncoder.hash(
  ackDomain,
  BINDING_TYPES,
  bindingFor(ackAccount, "0x" + "0f".repeat(32)),
);
const ACK_NONCE = "0x" + "a5".repeat(32);
const ACK_EXPIRY = "1900000300";
const BACKUP_FORMAT_V1_NAME = "xochi.shielded.backup-format.v1";
const BACKUP_FORMAT_V1_ID = ethers.id(BACKUP_FORMAT_V1_NAME);
const SENDERS = ["0x" + "17".repeat(32), "0x" + "05".padStart(64, "0"), "0x" + "2c".repeat(32)]
  .map((s) => s.toLowerCase())
  .sort();

const ackMessage = (primaryType: AckType, bindingDigest: string): Record<string, unknown> => {
  const common = {
    bindingDigest,
    aztecRecipient: ackAccount.descriptor.aztecAddress,
    nonce: ACK_NONCE,
    challengeExpiry: ACK_EXPIRY,
  };
  const purpose = ACKS.find((a) => a.primaryType === primaryType)!.purpose;
  switch (primaryType) {
    case "BackupPersistenceAck":
      return {
        ...common,
        backupCommitment: ethers.keccak256(
          ethers.toUtf8Bytes("xochi-spec TEST ONLY randomized encrypted backup"),
        ),
        backupFormatId: BACKUP_FORMAT_V1_ID,
        purpose,
      };
    case "SenderRegistrationAck":
      return { ...common, registeredSenders: SENDERS, purpose };
    case "PaymentReceiptAck":
      return {
        ...common,
        termsDigest: "0x" + "7d".repeat(32),
        operationId: "0x" + "09".repeat(32),
        network: ackAccount.descriptor.network,
        txHash: "0x" + "1a".repeat(32),
        blockNumber: "3062",
        aztecToken: "0x" + "2b".repeat(32),
        amount: "1000000",
        purpose,
      };
  }
};

const ackVectors = ACKS.map((a) => ({
  name: `${a.primaryType} (binding X)`,
  ...signAs(ackAccount, a.primaryType, ENVIRONMENT, ackMessage(a.primaryType, BINDING_X)),
}));

const recipientSigned: Signed[] = [{ ...bindingX }, ...ackVectors];

// Cross-type replay: every recipient-signed type's signature, presented as every other type
// over the same challenge and binding. Each must fail.
const crossTypeReplays = recipientSigned.flatMap((signed) =>
  recipientSigned
    .filter((other) => other.primaryType !== signed.primaryType)
    .map((presented) => {
      if (
        verifySig(ackAccount.signingPublicKey, presented.wrapper.messageField, signed.signature)
      ) {
        throw new Error(`${signed.primaryType} verifies as ${presented.primaryType}`);
      }
      return {
        name: `${signed.primaryType} signature presented as ${presented.primaryType}`,
        signedAs: signed.primaryType,
        presentedAs: presented.primaryType,
        domain: presented.domain,
        message: presented.message,
        digest: presented.digest,
        messageField: presented.wrapper.messageField,
        publicKey: presented.publicKey,
        signature: signed.signature,
        valid: false,
      };
    }),
);

// Cross-binding replay: an acknowledgement signed for binding X, presented for binding Y of
// the same recipient (and, separately, under another environment's domain).
const crossBindingReplays = ackVectors.flatMap((v) => {
  const asY = { ...v.message, bindingDigest: BINDING_Y };
  const yDigest = ethers.TypedDataEncoder.hash(ackDomain, typesFor(v.primaryType), asY);
  const prodDomain = bindingDomain("production", SOURCE_CHAIN_ID, ackAccount.descriptor.network);
  const prodDigest = ethers.TypedDataEncoder.hash(prodDomain, typesFor(v.primaryType), v.message);
  return [
    { label: "for binding Y", domain: ackDomain, message: asY, digest: yDigest },
    {
      label: "under the production domain",
      domain: prodDomain,
      message: v.message,
      digest: prodDigest,
    },
  ].map((c) => {
    const field = wrap(c.digest).messageField;
    if (verifySig(ackAccount.signingPublicKey, field, v.signature))
      throw new Error(`${v.name} replays ${c.label}`);
    return {
      name: `${v.primaryType} signed for binding X, presented ${c.label}`,
      primaryType: v.primaryType,
      domain: c.domain,
      message: c.message,
      digest: c.digest,
      messageField: field,
      publicKey: v.publicKey,
      signature: v.signature,
      valid: false,
    };
  });
});

// Encoding refusals for the acknowledgements: each differs from its valid vector in one input.
const ackRefusals = (() => {
  const base = (t: AckType) => ackVectors.find((v) => v.primaryType === t)!.message;
  const otherPurpose = (t: AckType) => ACKS.find((a) => a.primaryType !== t)!.purpose;
  const out: {
    name: string;
    primaryType: string;
    message: Record<string, unknown>;
    error: { code: string; field: string };
  }[] = [];
  for (const a of ACKS) {
    out.push({
      name: `${a.primaryType}: another acknowledgement's purpose`,
      primaryType: a.primaryType,
      message: { ...base(a.primaryType), purpose: otherPurpose(a.primaryType) },
      error: { code: "purpose_mismatch", field: "purpose" },
    });
    out.push({
      name: `${a.primaryType}: the binding purpose`,
      primaryType: a.primaryType,
      message: { ...base(a.primaryType), purpose: BINDING_PURPOSE },
      error: { code: "purpose_mismatch", field: "purpose" },
    });
    out.push({
      name: `${a.primaryType}: aztecRecipient zero`,
      primaryType: a.primaryType,
      message: { ...base(a.primaryType), aztecRecipient: hex32(0n) },
      error: { code: "aztec_zero", field: "aztecRecipient" },
    });
    out.push({
      name: `${a.primaryType}: challengeExpiry above uint64`,
      primaryType: a.primaryType,
      message: { ...base(a.primaryType), challengeExpiry: (1n << 64n).toString() },
      error: { code: "uint_out_of_range", field: "challengeExpiry" },
    });
    for (const field of ["bindingDigest", "nonce"]) {
      out.push({
        name: `${a.primaryType}: ${field} zero`,
        primaryType: a.primaryType,
        message: { ...base(a.primaryType), [field]: hex32(0n) },
        error: { code: "digest_zero", field },
      });
    }
  }
  const sr = base("SenderRegistrationAck");
  const senders = sr.registeredSenders as string[];
  out.push({
    name: "SenderRegistrationAck: senders not ascending",
    primaryType: "SenderRegistrationAck",
    message: { ...sr, registeredSenders: [...senders].reverse() },
    error: { code: "senders_not_canonical", field: "registeredSenders" },
  });
  out.push({
    name: "SenderRegistrationAck: duplicate sender",
    primaryType: "SenderRegistrationAck",
    message: { ...sr, registeredSenders: [senders[0], senders[0], ...senders.slice(1)] },
    error: { code: "senders_not_canonical", field: "registeredSenders" },
  });
  out.push({
    name: "SenderRegistrationAck: no senders",
    primaryType: "SenderRegistrationAck",
    message: { ...sr, registeredSenders: [] },
    error: { code: "senders_empty", field: "registeredSenders" },
  });
  out.push({
    name: "SenderRegistrationAck: sender zero",
    primaryType: "SenderRegistrationAck",
    message: { ...sr, registeredSenders: [hex32(0n), ...senders] },
    error: { code: "aztec_zero", field: "registeredSenders" },
  });
  const pr = base("PaymentReceiptAck");
  out.push({
    name: "PaymentReceiptAck: amount zero",
    primaryType: "PaymentReceiptAck",
    message: { ...pr, amount: "0" },
    error: { code: "amount_zero", field: "amount" },
  });
  out.push({
    name: "PaymentReceiptAck: amount 2^128",
    primaryType: "PaymentReceiptAck",
    message: { ...pr, amount: (1n << 128n).toString() },
    error: { code: "amount_over_max", field: "amount" },
  });
  out.push({
    name: "PaymentReceiptAck: amount with a leading zero",
    primaryType: "PaymentReceiptAck",
    message: { ...pr, amount: "01000000" },
    error: { code: "amount_not_canonical", field: "amount" },
  });
  out.push({
    name: "PaymentReceiptAck: aztecToken zero",
    primaryType: "PaymentReceiptAck",
    message: { ...pr, aztecToken: hex32(0n) },
    error: { code: "aztec_zero", field: "aztecToken" },
  });
  for (const field of ["termsDigest", "operationId", "txHash"]) {
    out.push({
      name: `PaymentReceiptAck: ${field} zero`,
      primaryType: "PaymentReceiptAck",
      message: { ...pr, [field]: hex32(0n) },
      error: { code: "digest_zero", field },
    });
  }
  out.push({
    name: "PaymentReceiptAck: blockNumber not canonical",
    primaryType: "PaymentReceiptAck",
    message: { ...pr, blockNumber: "03062" },
    error: { code: "uint_not_canonical", field: "blockNumber" },
  });
  const bp = base("BackupPersistenceAck");
  for (const field of ["backupCommitment", "backupFormatId"]) {
    out.push({
      name: `BackupPersistenceAck: ${field} zero`,
      primaryType: "BackupPersistenceAck",
      message: { ...bp, [field]: hex32(0n) },
      error: { code: "digest_zero", field },
    });
  }
  out.push({
    name: "BackupPersistenceAck: unknown backupFormatId",
    primaryType: "BackupPersistenceAck",
    message: { ...bp, backupFormatId: ethers.id("xochi.shielded.backup-format.unknown") },
    error: { code: "backup_format_mismatch", field: "backupFormatId" },
  });
  return out;
})();

// --- Output ------------------------------------------------------------------------------

const out = {
  version: 1,
  generator: "packages/spec/conformance/generate-shielded-recipient.ts",
  source:
    'xochi docs/planning/shielded-execution.md §7 ("Approved 2026-10-18: typed encodings", Recipient message) and the product-owner decisions of 2026-10-24/25 (xochi#633, xochi#635, xochi-sdk#42)',
  testOnlyKeys:
    "Every secret here (testOnlySecrets, the signing keys behind every signature) is a synthetic TEST ONLY scalar: keccak256 of a label containing 'TEST ONLY', reduced. Never use them for anything else. Networks, corridors, nonces and digests are fixtures.",
  constants: {
    fieldModulus: hex32(R),
    grumpkinOrder: hex32(Q),
    grumpkinGenerator: { x: hex32(G.x), y: hex32(G.y) },
    domainVersion: DOMAIN_VERSION,
    bindingDomainName: BINDING_DOMAIN_NAME,
    bindingPurpose: BINDING_PURPOSE,
  },
  descriptor: {
    decided:
      "2026-10-24/25 by the product owner: descriptorDigest = EIP-712 hashStruct(RecipientDescriptor)",
    typeString: DESCRIPTOR_TYPE_STRING,
    typehash: ethers.id(DESCRIPTOR_TYPE_STRING),
    digestRule: "descriptorDigest = hashStruct(RecipientDescriptor) (no domain, no 0x1901 prefix)",
    publicKeys:
      "The account's public keys in the SDK's public form (stdlib PublicKeys): ivpk_m as a point (x, y), the nullifier, outgoing-viewing, tagging, message-signing and fallback master keys as hashPublicKey digests. Both pinned SDKs carry six master keys, five of them only as digests; no isInfinite flag enters any hash.",
    derivation: [
      "constructorArgsHash = poseidon2([FUNCTION_ARGS, signingPublicKeyX, signingPublicKeyY])",
      "initializationHash = poseidon2([INITIALIZER, constructorSelector, constructorArgsHash])",
      "saltedInitializationHash = poseidon2([SALTED_INITIALIZATION_HASH, salt, initializationHash, deployer, immutablesHash = 0])",
      "partialAddress = poseidon2([PARTIAL_ADDRESS, classId, saltedInitializationHash])",
      "ivpkMHash = poseidon2([SINGLE_PUBLIC_KEY_HASH, ivpkMX, ivpkMY])",
      "publicKeysHash = poseidon2([PUBLIC_KEYS_HASH, npkMHash, ivpkMHash, ovpkMHash, tpkMHash, mspkMHash, fbpkMHash])",
      "preaddress = poseidon2([contractAddressSeparator, publicKeysHash, partialAddress])",
      "addressPoint = preaddress * G + ivpk_m (Grumpkin); address = addressPoint.x",
    ],
    poseidon2:
      "BN254 Poseidon2 sponge (t = 4, rate 3), poseidon2([s, ...]) = Noir/bb.js poseidon2_hash over the field list with the separator first",
    separators: Object.fromEntries(Object.entries(SEP).map(([k, v]) => [k, v.toString()])),
    constructorSelector: hex32(CONSTRUCTOR_SELECTOR),
    constructorSignature: "constructor(Field,Field)",
    profiles: PROFILES.map((p) => ({
      id: p.id,
      sdk: p.sdk,
      network: p.network,
      pinnedClassId: p.pinnedClassId,
      artifactHash: p.artifactHash,
      initializerlessClassId: p.initializerlessClassId,
      contractAddressSeparator: {
        name: p.contractAddressSeparator.name,
        value: p.contractAddressSeparator.value.toString(),
      },
    })),
    checkOrder: [
      "encoding (not_bytes32, aztec_out_of_field, aztec_zero for aztecAddress)",
      "class_not_pinned",
      "signing_key_invalid, ivpk_invalid",
      "address_mismatch",
    ],
    vectors: descriptorVectors,
    crossProfile,
    refusals: descriptorRefusals,
  },
  recipientMessage: {
    decided:
      "2026-10-24/25 by the product owner; replaces the compatibility spike's provisional plain mod r",
    prefix: MESSAGE_PREFIX,
    prefixHex: ethers.hexlify(PREFIX_BYTES),
    wideBytes: WIDE_BYTES,
    rule: [
      "d = the EIP-712 digest of the inner struct (keccak256(0x1901 || domainSeparator || hashStruct))",
      "u = keccak256(P || d || 0x00) || keccak256(P || d || 0x01)",
      "m = OS2IP(u[0:48]) mod r",
      "the account signs m as a 32-byte big-endian field element under SchnorrAccount's scheme",
    ],
    schnorr: {
      library: "noir-lang/schnorr v0.4.0 (both pinned SchnorrAccount artifacts)",
      challenge:
        "e = poseidon2([SCHNORR_CHALLENGE_DST, R.x, P.x, P.y, m]); accept iff P on curve, s != 0, e != 0, R = s*G + e*P != O",
      challengeDst: hex32(SCHNORR_CHALLENGE_DST),
      signatureEncoding: "s || e, 32 bytes each, big-endian (64 bytes); canonical s < q, e < r",
      testOnlyNonce:
        "the vectors' nonce k = OS2IP(sha512('xochi-spec TEST ONLY schnorr nonce' || sk || m)) mod q; any valid nonce verifies the same way",
    },
    tooling:
      "The recipient's own tooling rebuilds the full typed preimage, computes d, applies the wrapper and signs m. It never signs a digest or field value supplied by Xochi.",
    reduction: reductionVectors,
    bindingMessages,
    refusals: messageRefusals,
  },
  acknowledgements: {
    domain:
      "Domain (binding): every acknowledgement is a statement by the recipient about one binding, so it is scoped to that binding's environment, network and source chain. Primary type and purpose string separate the types inside the domain; a dedicated domain would add no separation those two do not.",
    types: ACKS.map((a) => ({
      primaryType: a.primaryType,
      scope: a.scope,
      purpose: a.purpose,
      typeString: typeString(a.primaryType),
      typehash: ethers.id(typeString(a.primaryType)),
    })),
    rules: [
      "bindingDigest = the RecipientBinding EIP-712 digest both parties signed",
      `BackupPersistenceAck.backupCommitment = keccak256(randomized encrypted backup bytes); backupFormatId = keccak256(UTF8("${BACKUP_FORMAT_V1_NAME}")) = ${BACKUP_FORMAT_V1_ID}; neither value contains plaintext`,
      "nonce / challengeExpiry: a server-issued single-use challenge and its signing window, as for RecipientBinding (for PaymentReceiptAck, the receipt challenge)",
      "SenderRegistrationAck.registeredSenders: nonempty, strictly ascending (bytewise), each a nonzero in-field Aztec address",
      "PaymentReceiptAck.amount: the exact credited BaseUnits, 0 < amount <= 2^128 - 1; blockNumber: decimal string on the wire",
    ],
    vectors: ackVectors,
    crossTypeReplays,
    crossBindingReplays,
    refusals: ackRefusals,
  },
};

// --- Schema ------------------------------------------------------------------------------

const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const HEX = { type: "string", pattern: "^0x[0-9a-f]*$" };
const ADDR = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
const UINT = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const SIG = { type: "string", pattern: "^0x[0-9a-f]{128}$" };
const STR = { type: "string" };
const obj = (props: Record<string, unknown>, optional: string[] = []) => ({
  type: "object",
  required: Object.keys(props).filter((k) => !optional.includes(k)),
  additionalProperties: false,
  properties: props,
});
const arr = (items: unknown) => ({ type: "array", minItems: 1, items });
const LOOSE = { type: "object" };
const POINT = obj({ x: HEX32, y: HEX32 });
const NETWORK = obj({
  aztecChainId: UINT,
  protocolVersion: UINT,
  rollupAddress: ADDR,
  l1ChainId: UINT,
  genesisOrNetworkDigest: HEX32,
});
const DESCRIPTOR = obj({
  ...Object.fromEntries(
    DESCRIPTOR_MEMBERS.filter((m) => m.type === "bytes32").map((m) => [m.name, HEX32]),
  ),
  network: NETWORK,
});
const DOMAIN = obj({ name: STR, version: STR, chainId: UINT, salt: HEX32 });
const WRAPPER = obj({ u: HEX, u48: HEX, messageField: HEX32, provisionalPlainModR: HEX32 });
const SIGNED = {
  primaryType: STR,
  environment: STR,
  network: NETWORK,
  domain: DOMAIN,
  message: LOOSE,
  structHash: HEX32,
  digest: HEX32,
  wrapper: WRAPPER,
  publicKey: POINT,
  signature: SIG,
};
const REFUSAL_CODE = {
  enum: [
    "not_bytes32",
    "aztec_zero",
    "aztec_out_of_field",
    "class_not_pinned",
    "signing_key_invalid",
    "ivpk_invalid",
    "address_mismatch",
    "purpose_mismatch",
    "uint_not_canonical",
    "uint_out_of_range",
    "amount_not_canonical",
    "amount_zero",
    "amount_over_max",
    "senders_not_canonical",
    "senders_empty",
  ],
};
const ERROR = obj({ code: REFUSAL_CODE, field: STR });
const REPLAY_BASE = {
  name: STR,
  domain: DOMAIN,
  message: LOOSE,
  digest: HEX32,
  messageField: HEX32,
  publicKey: POINT,
  signature: SIG,
  valid: { const: false },
};

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://xochi.fi/spec/conformance/shielded-recipient.schema.json",
  title: "Shielded settlement v1 recipient encodings vector set",
  description:
    "RecipientDescriptor hashStruct (descriptorDigest) and the stock SchnorrAccount address derivation for the pinned " +
    "Aztec 5.2.0 and @aztec-labs 6.0.0 classes; the recipient message wrapper with its wide reduction and Schnorr " +
    "signatures; and the approved acknowledgement structs with cross-type and cross-binding replay refusals (xochi " +
    "shielded-execution.md §7; product-owner decisions 2026-10-24/25 and 2026-10-29). Generated independently of @xochi/signer; " +
    "held to the real SDKs by packages/spec/aztec-crosscheck. All keys are TEST ONLY synthetic scalars.",
  ...obj({
    version: { const: 1 },
    generator: STR,
    source: STR,
    testOnlyKeys: STR,
    constants: obj({
      fieldModulus: HEX32,
      grumpkinOrder: HEX32,
      grumpkinGenerator: POINT,
      domainVersion: { const: "1" },
      bindingDomainName: { const: BINDING_DOMAIN_NAME },
      bindingPurpose: { const: BINDING_PURPOSE },
    }),
    descriptor: obj({
      decided: STR,
      typeString: { const: DESCRIPTOR_TYPE_STRING },
      typehash: HEX32,
      digestRule: STR,
      publicKeys: STR,
      derivation: arr(STR),
      poseidon2: STR,
      separators: obj(Object.fromEntries(Object.keys(SEP).map((k) => [k, UINT]))),
      constructorSelector: HEX32,
      constructorSignature: { const: "constructor(Field,Field)" },
      profiles: arr(
        obj({
          id: STR,
          sdk: STR,
          network: STR,
          pinnedClassId: HEX32,
          artifactHash: HEX32,
          initializerlessClassId: HEX32,
          contractAddressSeparator: obj({ name: STR, value: UINT }),
        }),
      ),
      checkOrder: arr(STR),
      vectors: arr(
        obj({
          name: STR,
          profile: STR,
          testOnlySecrets: obj({ secretKey: HEX32, signingPrivateKey: HEX32 }),
          descriptor: DESCRIPTOR,
          descriptorDigest: HEX32,
          derivation: obj({
            constructorArgsHash: HEX32,
            initializationHash: HEX32,
            immutablesHash: HEX32,
            saltedInitializationHash: HEX32,
            partialAddress: HEX32,
            ivpkMHash: HEX32,
            publicKeysHash: HEX32,
            preaddress: HEX32,
            addressPoint: POINT,
            address: HEX32,
          }),
        }),
      ),
      crossProfile: obj({
        name: STR,
        keysFrom: STR,
        addresses: obj({ "aztec-6.0.0": HEX32, "aztec-5.2.0": HEX32 }),
      }),
      refusals: arr(obj({ name: STR, profile: STR, descriptor: LOOSE, error: ERROR })),
    }),
    recipientMessage: obj({
      decided: STR,
      prefix: { const: MESSAGE_PREFIX },
      prefixHex: { const: ethers.hexlify(PREFIX_BYTES) },
      wideBytes: { const: WIDE_BYTES },
      rule: arr(STR),
      schnorr: obj({
        library: STR,
        challenge: STR,
        challengeDst: HEX32,
        signatureEncoding: STR,
        testOnlyNonce: STR,
      }),
      tooling: STR,
      reduction: arr(
        obj({
          name: STR,
          u48: { type: "string", pattern: "^0x[0-9a-f]{96}$" },
          messageField: HEX32,
          notTheRule: obj({ truncated256ModR: HEX32 }),
        }),
      ),
      bindingMessages: arr(obj({ name: STR, account: STR, ...SIGNED })),
      refusals: arr(
        obj({
          name: STR,
          account: STR,
          digest: HEX32,
          messageField: HEX32,
          signedField: HEX32,
          publicKey: POINT,
          signature: SIG,
          valid: { const: false },
        }),
      ),
    }),
    acknowledgements: obj({
      domain: STR,
      types: arr(
        obj({
          primaryType: STR,
          scope: STR,
          purpose: STR,
          typeString: STR,
          typehash: HEX32,
        }),
      ),
      rules: arr(STR),
      vectors: arr(obj({ name: STR, ...SIGNED })),
      crossTypeReplays: arr(obj({ ...REPLAY_BASE, signedAs: STR, presentedAs: STR })),
      crossBindingReplays: arr(obj({ ...REPLAY_BASE, primaryType: STR })),
      refusals: arr(obj({ name: STR, primaryType: STR, message: LOOSE, error: ERROR })),
    }),
  }),
};

const dir = process.env.SHIELDED_VECTORS_DIR ?? path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(dir, "shielded-recipient.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(
  path.join(dir, "shielded-recipient.schema.json"),
  JSON.stringify(schema, null, 2) + "\n",
);
console.log(
  `wrote shielded-recipient.json: ${descriptorVectors.length} descriptors, ` +
    `${descriptorRefusals.length} descriptor refusals, ${reductionVectors.length} reductions, ` +
    `${bindingMessages.length} binding messages, ${ackVectors.length} approved acks, ` +
    `${crossTypeReplays.length} cross-type and ${crossBindingReplays.length} cross-binding replays`,
);
for (const v of descriptorVectors) console.log(`  ${v.name.padEnd(30)} ${v.derivation.address}`);
