#!/usr/bin/env node
// Generates `conformance/shielded-terms.json` (+ `shielded-terms.schema.json`): the PROPOSED
// typed encoding of `ShieldedTermsV1`, the design-A (Riddler collector) terms of the
// shielded settlement contract v1 (xochi docs/planning/shielded-execution.md §7, Riddler#1296).
//
// STATUS: PROPOSED, NOT APPROVED. §7 approves the terms DOMAIN ("Xochi Shielded Terms", the
// salted `{name, version, chainId, salt}` scheme pinned by shielded.json) and says
// ShieldedTermsV1 is "the typed encoding of exactly the SignedTerms fields", but leaves the
// struct's member names, types and nesting to these vectors. Every choice below that §7 does
// not spell is listed in `proposed` in the output, so a reviewer approves or rejects each one;
// none of them is a §7 literal. Riddler vendors this file behind a default-off preview flag
// only, and nothing signs or settles against it.
//
// What the proposal changes relative to §7's SignedTerms list:
//   - rail + feePayer are ADDED (Riddler#1296, 2026-10-17 re-scope under D7): a digest signed
//     for the design-A tracer can never settle on the B-panel rail, and the public fee payer
//     (the PrivateFPC instance in production) is bound.
//   - the per-EXECUTION members (intent_id, quote_id, operation_id, source_authorization_digest,
//     reservation_id) are NOT members. They do not exist until an execute admits the order, and
//     an authenticated preview must return a stable digest while creating no source
//     authorization, reservation or obligation (Riddler#1296 Demo). §7 already requires the
//     origin authorization and this digest to be bound in the accepted intent; that execute-time
//     struct carries `termsDigest` and the instance members, and is a later version.
//   - fee_breakdown is NOT a member: §7 lists its typed shape as open. The exact source amount
//     and exact destination amount ARE members, so the economics the signer agrees to are bound.
//
// INDEPENDENT OF @xochi/signer and of Riddler: every value is derived here with ethers'
// generic primitives (TypedDataEncoder, keccak256, AbiCoder, Wallet), every refusal is written
// below as DATA. Implementations meet only at the committed JSON.
//
// Every network, corridor, digest, Aztec value and identifier below is a FIXTURE. The signer
// keys are the PUBLIC Hardhat/Anvil test keys #0 and #1: known to everyone, never to hold funds.
//
// Run: npm run generate:shielded-terms   (SHIELDED_TERMS_VECTORS_DIR overrides the output dir)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

// --- §7 literals (approved) --------------------------------------------------------------

const DOMAIN_VERSION = "1";
const TERMS_DOMAIN_NAME = "Xochi Shielded Terms";
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)";
const NETWORK_IDENTITY_TYPE_STRING =
  "NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress," +
  "uint256 l1ChainId,bytes32 genesisOrNetworkDigest)";
// §7 ShieldedDestination literals.
const SETTLEMENT_TYPE = "shielded";
const PRIVACY_LEVEL = "private";
const DISCLOSURE_PROFILE_A = "recipient-private-public-amount-v1";

// --- Proposed literals --------------------------------------------------------------------

const PROTOCOL_VERSION = "xochi.shielded.terms.v1";
const RAIL_A = "a_tracer";
const RAIL_B = "b_panel";

const TERMS_TYPE_STRING =
  "ShieldedTermsV1(string protocolVersion,string environment,ShieldedSource source," +
  "ShieldedDestination destination,address refundAddress,uint256 refundAmount," +
  "uint64 collectBefore,uint64 settlementServiceDeadline,bytes32 recipientBindingDigest," +
  "uint32 policyRevision)";
const SOURCE_TYPE_STRING =
  "ShieldedSource(uint256 chainId,address token,address wallet,address collector,uint256 amount)";
const DESTINATION_TYPE_STRING =
  "ShieldedDestination(string settlementType,string privacyLevel,string disclosureProfile," +
  "string rail,NetworkIdentity network,ShieldedCorridor corridor,string assetId," +
  "bytes32 aztecToken,string recipientBindingId,bytes32 descriptorDigest," +
  "bytes32 aztecRecipient,uint256 amount,bytes32 feePayer)";
const CORRIDOR_TYPE_STRING =
  "ShieldedCorridor(bytes32 corridorId,uint32 corridorRevision,bytes32 manifestDigest)";

const TYPES = {
  ShieldedTermsV1: [
    { name: "protocolVersion", type: "string" },
    { name: "environment", type: "string" },
    { name: "source", type: "ShieldedSource" },
    { name: "destination", type: "ShieldedDestination" },
    { name: "refundAddress", type: "address" },
    { name: "refundAmount", type: "uint256" },
    { name: "collectBefore", type: "uint64" },
    { name: "settlementServiceDeadline", type: "uint64" },
    { name: "recipientBindingDigest", type: "bytes32" },
    { name: "policyRevision", type: "uint32" },
  ],
  ShieldedSource: [
    { name: "chainId", type: "uint256" },
    { name: "token", type: "address" },
    { name: "wallet", type: "address" },
    { name: "collector", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  ShieldedDestination: [
    { name: "settlementType", type: "string" },
    { name: "privacyLevel", type: "string" },
    { name: "disclosureProfile", type: "string" },
    { name: "rail", type: "string" },
    { name: "network", type: "NetworkIdentity" },
    { name: "corridor", type: "ShieldedCorridor" },
    { name: "assetId", type: "string" },
    { name: "aztecToken", type: "bytes32" },
    { name: "recipientBindingId", type: "string" },
    { name: "descriptorDigest", type: "bytes32" },
    { name: "aztecRecipient", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "feePayer", type: "bytes32" },
  ],
  ShieldedCorridor: [
    { name: "corridorId", type: "bytes32" },
    { name: "corridorRevision", type: "uint32" },
    { name: "manifestDigest", type: "bytes32" },
  ],
  NetworkIdentity: [
    { name: "aztecChainId", type: "uint256" },
    { name: "protocolVersion", type: "uint256" },
    { name: "rollupAddress", type: "address" },
    { name: "l1ChainId", type: "uint256" },
    { name: "genesisOrNetworkDigest", type: "bytes32" },
  ],
};

// The type definitions must spell exactly the literal type strings, and encodeType must
// append the referenced types in EIP-712's alphabetical order.
const encoder = ethers.TypedDataEncoder.from(TYPES);
const EXPECTED_ENCODE_TYPE =
  TERMS_TYPE_STRING +
  NETWORK_IDENTITY_TYPE_STRING +
  CORRIDOR_TYPE_STRING +
  DESTINATION_TYPE_STRING +
  SOURCE_TYPE_STRING;
if (encoder.encodeType("ShieldedTermsV1") !== EXPECTED_ENCODE_TYPE) {
  throw new Error(`ShieldedTermsV1 encodes as ${encoder.encodeType("ShieldedTermsV1")}`);
}
for (const [primary, literal] of [
  ["ShieldedSource", SOURCE_TYPE_STRING],
  ["ShieldedCorridor", CORRIDOR_TYPE_STRING],
  ["NetworkIdentity", NETWORK_IDENTITY_TYPE_STRING],
] as const) {
  if (encoder.encodeType(primary) !== literal) throw new Error(`${primary} mismatch`);
}
if (
  encoder.encodeType("ShieldedDestination") !==
  DESTINATION_TYPE_STRING + NETWORK_IDENTITY_TYPE_STRING + CORRIDOR_TYPE_STRING
) {
  throw new Error("ShieldedDestination encodeType mismatch");
}

// BN254 scalar field order r; Aztec field elements and addresses are below it.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const AMOUNT_MAX = 2n ** 128n - 1n;
const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #0 and #1). NOT SECRET. NEVER USE.
const WALLET_0 = new ethers.Wallet(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const WALLET_1 = new ethers.Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const ADDR_0 = WALLET_0.address.toLowerCase();
const ADDR_1 = WALLET_1.address.toLowerCase();

const hex32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

type Network = {
  aztecChainId: string;
  protocolVersion: string;
  rollupAddress: string;
  l1ChainId: string;
  genesisOrNetworkDigest: string;
};
type Corridor = { corridorId: string; corridorRevision: string; manifestDigest: string };
type Source = { chainId: string; token: string; wallet: string; collector: string; amount: string };
type Destination = {
  settlementType: string;
  privacyLevel: string;
  disclosureProfile: string;
  rail: string;
  network: Network;
  corridor: Corridor;
  assetId: string;
  aztecToken: string;
  recipientBindingId: string;
  descriptorDigest: string;
  aztecRecipient: string;
  amount: string;
  feePayer: string;
};
type Terms = {
  protocolVersion: string;
  environment: string;
  source: Source;
  destination: Destination;
  refundAddress: string;
  refundAmount: string;
  collectBefore: string;
  settlementServiceDeadline: string;
  recipientBindingDigest: string;
  policyRevision: string;
};

const networkDigest = (n: Network) =>
  ethers.TypedDataEncoder.hashStruct(
    "NetworkIdentity",
    { NetworkIdentity: TYPES.NetworkIdentity },
    n,
  );
// §7: salt = keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest)).
// The terms domain's chainId is the SOURCE chain; its network is the destination network.
const termsDomain = (t: Terms) => ({
  name: TERMS_DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: t.source.chainId,
  salt: ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ethers.id(t.environment), networkDigest(t.destination.network)],
    ),
  ),
});

// --- Fixtures -----------------------------------------------------------------------------

const NET_A: Network = {
  aztecChainId: "11155111",
  protocolVersion: "3924331020",
  rollupAddress: "0x" + "a1".repeat(20),
  l1ChainId: "11155111",
  genesisOrNetworkDigest: "0x" + "9e".repeat(32),
};
const NET_B: Network = { ...NET_A, rollupAddress: "0x" + "a2".repeat(20) };
const NET_MAX: Network = {
  aztecChainId: (P - 1n).toString(),
  protocolVersion: (P - 1n).toString(),
  rollupAddress: "0x" + "ff".repeat(20),
  l1ChainId: UINT256_MAX.toString(),
  genesisOrNetworkDigest: "0x" + "ff".repeat(32),
};

// The RecipientBinding the terms bind (§7, approved; pinned by shielded.json). Its overlapping
// members are the terms' own, so `recipientBindingDigest` cannot vouch for another recipient,
// token, wallet or corridor than the terms pay; only `nonce` and `challengeExpiry` are its own.
const BINDING_DOMAIN_NAME = "Xochi Shielded Recipient";
const BINDING_PURPOSE = "xochi.shielded.recipient-binding.v1";
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
type BindingInputs = { nonce: string; challengeExpiry: string };
const BASE_BINDING: BindingInputs = {
  nonce: "0x" + "0e".repeat(32),
  challengeExpiry: "1899999700",
};

const bindingFor = (t: Omit<Terms, "recipientBindingDigest">, b: BindingInputs) => {
  const message = {
    sourceWallet: t.source.wallet,
    sourceChainId: t.source.chainId,
    aztecRecipient: t.destination.aztecRecipient,
    aztecToken: t.destination.aztecToken,
    descriptorDigest: t.destination.descriptorDigest,
    corridorId: t.destination.corridor.corridorId,
    corridorRevision: t.destination.corridor.corridorRevision,
    manifestDigest: t.destination.corridor.manifestDigest,
    nonce: b.nonce,
    challengeExpiry: b.challengeExpiry,
    purpose: BINDING_PURPOSE,
  };
  const domain = { ...termsDomain(t as Terms), name: BINDING_DOMAIN_NAME };
  return { message, digest: ethers.TypedDataEncoder.hash(domain, BINDING_TYPES, message) };
};

const BASE_UNBOUND: Omit<Terms, "recipientBindingDigest"> = {
  protocolVersion: PROTOCOL_VERSION,
  environment: "staging",
  source: {
    chainId: "84532",
    token: "0x" + "5c".repeat(20),
    wallet: ADDR_0,
    collector: "0x" + "c1".repeat(20),
    amount: "1010000",
  },
  destination: {
    settlementType: SETTLEMENT_TYPE,
    privacyLevel: PRIVACY_LEVEL,
    disclosureProfile: DISCLOSURE_PROFILE_A,
    rail: RAIL_A,
    network: NET_A,
    corridor: {
      corridorId: "0x" + "c0".repeat(32),
      corridorRevision: "1",
      manifestDigest: "0x" + "4d".repeat(32),
    },
    assetId: "aztec-testnet-test-token",
    aztecToken: "0x" + "2b".repeat(32),
    recipientBindingId: "bnd_0001",
    descriptorDigest: "0x" + "d5".repeat(32),
    aztecRecipient: "0x" + "1c".repeat(32),
    amount: "1000000",
    feePayer: "0x" + "0f".repeat(31) + "01",
  },
  refundAddress: ADDR_0,
  refundAmount: "1010000",
  collectBefore: "1900000000",
  settlementServiceDeadline: "1900003600",
  policyRevision: "1",
};
const BASE: Terms = {
  ...BASE_UNBOUND,
  recipientBindingDigest: bindingFor(BASE_UNBOUND, BASE_BINDING).digest,
};

const withSource = (s: Partial<Source>): Partial<Terms> => ({ source: { ...BASE.source, ...s } });
const withDest = (d: Partial<Destination>): Partial<Terms> => ({
  destination: { ...BASE.destination, ...d },
});
const withCorridor = (c: Partial<Corridor>): Partial<Terms> =>
  withDest({ corridor: { ...BASE.destination.corridor, ...c } });

// Each case differs from the baseline in exactly ONE input (or one coherent pair), so every
// digest below must differ from the baseline's and from every other's. A change to a member
// the binding shares also changes `recipientBindingDigest`, as it must.
const CASES: {
  name: string;
  terms: Partial<Terms>;
  binding?: Partial<BindingInputs>;
  wallet?: ethers.Wallet;
}[] = [
  { name: "baseline", terms: {} },
  { name: "other-environment", terms: { environment: "production" } },
  { name: "redeployed-rollup", terms: withDest({ network: NET_B }) },
  { name: "other-source-chain", terms: withSource({ chainId: "1" }) },
  { name: "other-source-token", terms: withSource({ token: "0x" + "5d".repeat(20) }) },
  {
    name: "other-source-wallet",
    terms: { ...withSource({ wallet: ADDR_1 }), refundAddress: ADDR_1 },
    wallet: WALLET_1,
  },
  { name: "other-collector", terms: withSource({ collector: "0x" + "c2".repeat(20) }) },
  { name: "other-source-amount", terms: withSource({ amount: "1010001" }) },
  { name: "other-corridor-id", terms: withCorridor({ corridorId: "0x" + "c3".repeat(32) }) },
  {
    name: "next-corridor-revision",
    terms: withCorridor({ corridorRevision: "2", manifestDigest: "0x" + "4e".repeat(32) }),
  },
  {
    name: "other-manifest-digest",
    terms: withCorridor({ manifestDigest: "0x" + "4f".repeat(32) }),
  },
  { name: "other-asset-id", terms: withDest({ assetId: "aztec-testnet-test-token-2" }) },
  { name: "other-aztec-token", terms: withDest({ aztecToken: "0x" + "2c".repeat(32) }) },
  { name: "other-aztec-recipient", terms: withDest({ aztecRecipient: "0x" + "1d".repeat(32) }) },
  {
    name: "other-descriptor-digest",
    terms: withDest({ descriptorDigest: "0x" + "d6".repeat(32) }),
  },
  { name: "other-recipient-binding-id", terms: withDest({ recipientBindingId: "bnd_0002" }) },
  { name: "other-binding-nonce", terms: {}, binding: { nonce: "0x" + "0f".repeat(32) } },
  { name: "other-binding-challenge-expiry", terms: {}, binding: { challengeExpiry: "1899999701" } },
  { name: "other-destination-amount", terms: withDest({ amount: "1000001" }) },
  { name: "rail-b-panel", terms: withDest({ rail: RAIL_B }) },
  { name: "other-fee-payer", terms: withDest({ feePayer: "0x" + "0f".repeat(31) + "02" }) },
  { name: "other-refund-address", terms: { refundAddress: "0x" + "ad".repeat(20) } },
  { name: "other-refund-amount", terms: { refundAmount: "1009999" } },
  { name: "other-collect-before", terms: { collectBefore: "1900000001" } },
  { name: "other-service-deadline", terms: { settlementServiceDeadline: "1900003601" } },
  { name: "next-policy-revision", terms: { policyRevision: "2" } },
  {
    name: "boundary-values",
    terms: {
      ...withSource({ chainId: UINT256_MAX.toString(), amount: AMOUNT_MAX.toString() }),
      destination: {
        ...BASE.destination,
        network: NET_MAX,
        corridor: {
          corridorId: "0x" + "ff".repeat(32),
          corridorRevision: UINT32_MAX.toString(),
          manifestDigest: "0x" + "ff".repeat(32),
        },
        aztecToken: hex32(1n),
        aztecRecipient: hex32(P - 1n),
        amount: AMOUNT_MAX.toString(),
        feePayer: hex32(P - 1n),
      },
      refundAmount: AMOUNT_MAX.toString(),
      collectBefore: (UINT64_MAX - 1n).toString(),
      settlementServiceDeadline: UINT64_MAX.toString(),
      policyRevision: UINT32_MAX.toString(),
    },
  },
];

const vectors = await Promise.all(
  CASES.map(async ({ name, terms, binding, wallet }) => {
    const unbound = { ...BASE_UNBOUND, ...terms };
    const recipientBinding = bindingFor(unbound, { ...BASE_BINDING, ...binding });
    const message: Terms = { ...unbound, recipientBindingDigest: recipientBinding.digest };
    const signer = wallet ?? WALLET_0;
    if (signer.address.toLowerCase() !== message.source.wallet) {
      throw new Error(`${name}: the signer must be the source wallet`);
    }
    const domain = termsDomain(message);
    const digest = ethers.TypedDataEncoder.hash(domain, TYPES, message);
    const signature = ethers.Signature.from(
      await signer.signTypedData(domain, TYPES, message),
    ).serialized;
    if (ethers.recoverAddress(digest, signature).toLowerCase() !== message.source.wallet) {
      throw new Error(`${name}: signature does not recover the source wallet`);
    }
    return {
      name,
      recipientBinding,
      message,
      domain,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
      networkIdentityDigest: networkDigest(message.destination.network),
      sourceHash: encoder.hashStruct("ShieldedSource", message.source),
      corridorHash: encoder.hashStruct("ShieldedCorridor", message.destination.corridor),
      destinationHash: encoder.hashStruct("ShieldedDestination", message.destination),
      structHash: encoder.hashStruct("ShieldedTermsV1", message),
      digest,
      signer: message.source.wallet,
      signature,
    };
  }),
);

const seen = new Map<string, string>();
for (const v of vectors) {
  const other = seen.get(v.digest);
  if (other) throw new Error(`${v.name} and ${other} share a digest`);
  seen.set(v.digest, v.name);
}

// Every accepted vector must carry admissible Aztec values (nonzero, below r): a fixture
// outside the field would pass here and be refused by every conforming parser.
for (const v of vectors) {
  const d = v.message.destination;
  for (const [field, value] of [
    ["aztecToken", BigInt(d.aztecToken)],
    ["aztecRecipient", BigInt(d.aztecRecipient)],
    ["feePayer", BigInt(d.feePayer)],
    ["network.aztecChainId", BigInt(d.network.aztecChainId)],
    ["network.protocolVersion", BigInt(d.network.protocolVersion)],
  ] as const) {
    if (value === 0n || value >= P) throw new Error(`${v.name}: ${field} is not an Aztec value`);
  }
}

// --- Refusals: expectations are DATA ------------------------------------------------------
//
// Encoding-level codes, shared with shielded.json where the rule is the same:
//   terms_version_unsupported  protocolVersion is not "xochi.shielded.terms.v1"
//   settlement_type_mismatch   destination.settlementType is not "shielded"
//   privacy_level_unsupported  destination.privacyLevel is not "private" (Sovereign refused)
//   disclosure_profile_mismatch  rail a_tracer with a profile other than §7's A profile
//   rail_unknown               rail is neither a_tracer nor b_panel
//   string_empty               assetId / recipientBindingId is empty
//   environment_empty          environment is empty (shielded.json's code)
//   deadline_order             settlementServiceDeadline <= collectBefore
//   aztec_zero / aztec_out_of_field / not_bytes32 / amount_* / evm_address_zero /
//   not_evm_address / uint_out_of_range / chain_id_zero   as in shielded.json
const refusals = (
  [
    {
      name: "protocol-version-v2",
      terms: { protocolVersion: "xochi.shielded.terms.v2" },
      error: { code: "terms_version_unsupported", field: "protocolVersion" },
    },
    {
      name: "settlement-type-stealth",
      terms: withDest({ settlementType: "stealth" }),
      error: { code: "settlement_type_mismatch", field: "destination.settlementType" },
    },
    {
      name: "privacy-level-sovereign",
      terms: withDest({ privacyLevel: "sovereign" }),
      error: { code: "privacy_level_unsupported", field: "destination.privacyLevel" },
    },
    {
      name: "a-tracer-other-profile",
      terms: withDest({ disclosureProfile: "recipient-private-private-amount-v1" }),
      error: { code: "disclosure_profile_mismatch", field: "destination.disclosureProfile" },
    },
    {
      name: "rail-unknown",
      terms: withDest({ rail: "c_voucher" }),
      error: { code: "rail_unknown", field: "destination.rail" },
    },
    {
      name: "asset-id-empty",
      terms: withDest({ assetId: "" }),
      error: { code: "string_empty", field: "destination.assetId" },
    },
    {
      name: "recipient-binding-id-empty",
      terms: withDest({ recipientBindingId: "" }),
      error: { code: "string_empty", field: "destination.recipientBindingId" },
    },
    {
      name: "environment-empty",
      terms: { environment: "" },
      error: { code: "environment_empty", field: "environment" },
    },
    {
      name: "service-deadline-equals-collect-before",
      terms: { settlementServiceDeadline: BASE.collectBefore },
      error: { code: "deadline_order", field: "settlementServiceDeadline" },
    },
    {
      name: "aztec-recipient-zero",
      terms: withDest({ aztecRecipient: hex32(0n) }),
      error: { code: "aztec_zero", field: "destination.aztecRecipient" },
    },
    {
      name: "aztec-token-field-modulus",
      terms: withDest({ aztecToken: hex32(P) }),
      error: { code: "aztec_out_of_field", field: "destination.aztecToken" },
    },
    {
      name: "fee-payer-zero",
      terms: withDest({ feePayer: hex32(0n) }),
      error: { code: "aztec_zero", field: "destination.feePayer" },
    },
    {
      name: "aztec-recipient-evm-length",
      terms: withDest({ aztecRecipient: ADDR_1 }),
      error: { code: "not_bytes32", field: "destination.aztecRecipient" },
    },
    {
      name: "destination-amount-zero",
      terms: withDest({ amount: "0" }),
      error: { code: "amount_zero", field: "destination.amount" },
    },
    {
      name: "source-amount-over-max",
      terms: withSource({ amount: (AMOUNT_MAX + 1n).toString() }),
      error: { code: "amount_over_max", field: "source.amount" },
    },
    {
      name: "refund-amount-not-canonical",
      terms: { refundAmount: "01" },
      error: { code: "amount_not_canonical", field: "refundAmount" },
    },
    {
      name: "collector-zero",
      terms: withSource({ collector: "0x" + "00".repeat(20) }),
      error: { code: "evm_address_zero", field: "source.collector" },
    },
    {
      name: "source-token-aztec-length",
      terms: withSource({ token: "0x" + "2b".repeat(32) }),
      error: { code: "not_evm_address", field: "source.token" },
    },
    {
      name: "corridor-revision-zero",
      terms: withCorridor({ corridorRevision: "0" }),
      error: { code: "uint_out_of_range", field: "destination.corridor.corridorRevision" },
    },
    {
      name: "policy-revision-over-uint32",
      terms: { policyRevision: (UINT32_MAX + 1n).toString() },
      error: { code: "uint_out_of_range", field: "policyRevision" },
    },
    {
      name: "source-chain-zero",
      terms: withSource({ chainId: "0" }),
      error: { code: "chain_id_zero", field: "source.chainId" },
    },
  ] as { name: string; terms: Partial<Terms>; error: { code: string; field: string } }[]
).map((c) => ({ name: c.name, message: { ...BASE, ...c.terms }, error: c.error }));

// --- Output -------------------------------------------------------------------------------

const out = {
  version: 1,
  status: "PROPOSED",
  generator: "packages/spec/conformance/generate-shielded-terms.ts",
  source:
    'xochi docs/planning/shielded-execution.md §7 "Domain (terms)" + "ShieldedTermsV1" ' +
    "(approved 2026-10-18 as a domain and a field list), Riddler#1296 (rail + fee payer, 2026-10-17)",
  constants: {
    aztecFieldModulus: P.toString(),
    amountMax: AMOUNT_MAX.toString(),
    domainVersion: DOMAIN_VERSION,
    termsDomainName: TERMS_DOMAIN_NAME,
    protocolVersion: PROTOCOL_VERSION,
    settlementType: SETTLEMENT_TYPE,
    privacyLevel: PRIVACY_LEVEL,
    disclosureProfileA: DISCLOSURE_PROFILE_A,
    rails: [RAIL_A, RAIL_B],
  },
  domain: { typeString: DOMAIN_TYPE_STRING, typehash: ethers.id(DOMAIN_TYPE_STRING) },
  types: {
    encodeType: EXPECTED_ENCODE_TYPE,
    typehash: ethers.id(EXPECTED_ENCODE_TYPE),
    source: { typeString: SOURCE_TYPE_STRING, typehash: ethers.id(SOURCE_TYPE_STRING) },
    corridor: { typeString: CORRIDOR_TYPE_STRING, typehash: ethers.id(CORRIDOR_TYPE_STRING) },
    destination: {
      encodeType: encoder.encodeType("ShieldedDestination"),
      typehash: ethers.id(encoder.encodeType("ShieldedDestination")),
    },
  },
  signerIsTestKey: true,
  vectors,
  refusals,
  proposed: [
    {
      item: "member list and nesting",
      reason:
        "§7 fixes the domain and names the SignedTerms fields; the member names, types and the " +
        "ShieldedSource / ShieldedDestination / ShieldedCorridor nesting above are a proposal.",
    },
    {
      item: "rail, feePayer",
      reason:
        "Added per Riddler#1296 (2026-10-17): rail a_tracer | b_panel, so a digest for one rail " +
        "cannot settle on the other; feePayer is the public Aztec fee payer (PrivateFPC in production).",
    },
    {
      item: "execution-instance members",
      reason:
        "intent_id, quote_id, operation_id, source_authorization_digest and reservation_id are not " +
        "members: a preview must return a stable digest with no authorization or reservation. The " +
        "execute-time struct binds termsDigest to them and is a later version.",
    },
    {
      item: "fee_breakdown",
      reason:
        "Not a member: §7 lists its typed shape as open. The exact source and destination amounts are bound.",
    },
    {
      item: "assetId, recipientBindingId as strings; policyRevision as uint32",
      reason: "§7 names them without a type.",
    },
    {
      item: "b_panel disclosure profile",
      reason:
        "§7 defines only design A's profile. The rail-b-panel vector changes rail alone; the b_panel " +
        "profile and its pairing rule are open.",
    },
    {
      item: "recipientBindingDigest derivation",
      reason:
        "The EIP-712 digest of the §7 RecipientBinding whose shared members (source wallet/chain, " +
        "aztecRecipient, aztecToken, descriptorDigest, corridor) are the terms' own; only nonce and " +
        "challengeExpiry come from the binding. Each vector carries that binding.",
    },
  ],
};

// --- Schema -------------------------------------------------------------------------------

const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const ADDR = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
const UINT = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const SIG = { type: "string", pattern: "^0x[0-9a-f]{130}$" };
const STR = { type: "string" };
const obj = (props: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(props),
  additionalProperties: false,
  properties: props,
});
const arr = (items: unknown) => ({ type: "array", minItems: 1, items });
const NETWORK = obj({
  aztecChainId: UINT,
  protocolVersion: UINT,
  rollupAddress: ADDR,
  l1ChainId: UINT,
  genesisOrNetworkDigest: HEX32,
});
const DOMAIN = obj({ name: STR, version: STR, chainId: UINT, salt: HEX32 });
const MESSAGE = obj({
  protocolVersion: { const: PROTOCOL_VERSION },
  environment: STR,
  source: obj({ chainId: UINT, token: ADDR, wallet: ADDR, collector: ADDR, amount: UINT }),
  destination: obj({
    settlementType: { const: SETTLEMENT_TYPE },
    privacyLevel: { const: PRIVACY_LEVEL },
    disclosureProfile: STR,
    rail: { enum: [RAIL_A, RAIL_B] },
    network: NETWORK,
    corridor: obj({ corridorId: HEX32, corridorRevision: UINT, manifestDigest: HEX32 }),
    assetId: STR,
    aztecToken: HEX32,
    recipientBindingId: STR,
    descriptorDigest: HEX32,
    aztecRecipient: HEX32,
    amount: UINT,
    feePayer: HEX32,
  }),
  refundAddress: ADDR,
  refundAmount: UINT,
  collectBefore: UINT,
  settlementServiceDeadline: UINT,
  recipientBindingDigest: HEX32,
  policyRevision: UINT,
});
const LOOSE = { type: "object" };
const REFUSAL_CODE = {
  enum: [
    "terms_version_unsupported",
    "settlement_type_mismatch",
    "privacy_level_unsupported",
    "disclosure_profile_mismatch",
    "rail_unknown",
    "string_empty",
    "environment_empty",
    "deadline_order",
    "not_bytes32",
    "aztec_zero",
    "aztec_out_of_field",
    "amount_not_canonical",
    "amount_zero",
    "amount_over_max",
    "not_evm_address",
    "evm_address_zero",
    "uint_out_of_range",
    "chain_id_zero",
  ],
};
const TYPE_ENTRY = obj({ typeString: STR, typehash: HEX32 });

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://xochi.fi/spec/conformance/shielded-terms.schema.json",
  title: "Shielded settlement ShieldedTermsV1 typed-encoding vector set (PROPOSED)",
  description:
    "PROPOSED typed encoding of ShieldedTermsV1 under the approved Domain (terms) (xochi " +
    "shielded-execution.md §7; Riddler#1296): type strings, struct hashes, EIP-712 digests and " +
    "source-wallet signatures (public test keys), plus single-field refusals. Generated with ethers " +
    "primitives, independently of @xochi/signer and Riddler. uint values are decimal strings; " +
    "bytes/addresses lowercase hex. Every vector differs from the baseline in one member; all " +
    "digests are distinct. All values are fixtures.",
  ...obj({
    version: { const: 1 },
    status: { const: "PROPOSED" },
    generator: STR,
    source: STR,
    constants: obj({
      aztecFieldModulus: UINT,
      amountMax: UINT,
      domainVersion: { const: DOMAIN_VERSION },
      termsDomainName: { const: TERMS_DOMAIN_NAME },
      protocolVersion: { const: PROTOCOL_VERSION },
      settlementType: { const: SETTLEMENT_TYPE },
      privacyLevel: { const: PRIVACY_LEVEL },
      disclosureProfileA: { const: DISCLOSURE_PROFILE_A },
      rails: { type: "array", items: STR },
    }),
    domain: TYPE_ENTRY,
    types: obj({
      encodeType: STR,
      typehash: HEX32,
      source: TYPE_ENTRY,
      corridor: TYPE_ENTRY,
      destination: obj({ encodeType: STR, typehash: HEX32 }),
    }),
    signerIsTestKey: { const: true },
    vectors: arr(
      obj({
        name: STR,
        recipientBinding: obj({
          message: obj({
            sourceWallet: ADDR,
            sourceChainId: UINT,
            aztecRecipient: HEX32,
            aztecToken: HEX32,
            descriptorDigest: HEX32,
            corridorId: HEX32,
            corridorRevision: UINT,
            manifestDigest: HEX32,
            nonce: HEX32,
            challengeExpiry: UINT,
            purpose: { const: BINDING_PURPOSE },
          }),
          digest: HEX32,
        }),
        message: MESSAGE,
        domain: DOMAIN,
        domainSeparator: HEX32,
        networkIdentityDigest: HEX32,
        sourceHash: HEX32,
        corridorHash: HEX32,
        destinationHash: HEX32,
        structHash: HEX32,
        digest: HEX32,
        signer: ADDR,
        signature: SIG,
      }),
    ),
    refusals: arr(
      obj({ name: STR, message: LOOSE, error: obj({ code: REFUSAL_CODE, field: STR }) }),
    ),
    proposed: arr(obj({ item: STR, reason: STR })),
  }),
};

const dir = process.env.SHIELDED_TERMS_VECTORS_DIR ?? path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(dir, "shielded-terms.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(
  path.join(dir, "shielded-terms.schema.json"),
  JSON.stringify(schema, null, 2) + "\n",
);
console.log(`wrote shielded-terms.json: ${vectors.length} vectors, ${refusals.length} refusals`);
for (const v of vectors) console.log(`  ${v.name.padEnd(32)} ${v.digest}`);
