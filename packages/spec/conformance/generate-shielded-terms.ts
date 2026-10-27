#!/usr/bin/env node
// Generates `conformance/shielded-terms.json` (+ `shielded-terms.schema.json`): the typed
// encodings of the shielded settlement contract v1 design-A terms, decided 2026-10-27 as the D7
// amendment (xochi docs/planning/shielded-execution.md §7 "Decided 2026-10-27 (D7 amendment)";
// axol-io/Riddler#1296):
//
//   - `ShieldedTermsV1`: EXACTLY §7's SignedTerms member set, in its order, PLUS the two
//     destination members the amendment adds, `rail` and `feePayer`. The rail enum is
//     `a_tracer` only; `b_panel` is refused as an unknown rail.
//   - `ShieldedPreviewV1`: the NON-SIGNABLE preview digest. Its own primary type, its own
//     `protocolVersion` and its own domain name, so no preview signature verifies as terms. It
//     carries every terms member except the five per-execution ones.
//   - `CorridorManifestV1`: the §6/§7 manifest identity fields whose `hashStruct` IS
//     `manifestDigest`, computed rather than configured.
//
// Every literal, width and member list §7 does not spell is listed in the output's `proposed`
// array, each one a draft awaiting owner review: the file is `status: "PROPOSED"`.
//
// INDEPENDENT OF @xochi/signer and of Riddler: every value is derived here with ethers'
// generic primitives (TypedDataEncoder, keccak256, AbiCoder, Wallet), every refusal is written
// below as DATA. Implementations meet only at the committed JSON.
//
// Values decided for manifest revision 1 (§7 "Tracer source", "third set", "Provisioned
// 2026-10-25") are used as such: Base Sepolia 84532, its USDC, Aztec SDK 6.0.0 and the XTU
// token and class. Every other network, corridor, digest, Aztec value and identifier is a
// FIXTURE. The signer keys are the PUBLIC Hardhat/Anvil test keys #0 and #1.
//
// Run: npm run generate:shielded-terms   (SHIELDED_TERMS_VECTORS_DIR overrides the output dir)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

// --- Literals ----------------------------------------------------------------------------

// §7, approved.
const DOMAIN_VERSION = "1";
const TERMS_DOMAIN_NAME = "Xochi Shielded Terms";
const BINDING_DOMAIN_NAME = "Xochi Shielded Recipient";
const BINDING_PURPOSE = "xochi.shielded.recipient-binding.v1";
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)";
const SETTLEMENT_TYPE = "shielded";
const PRIVACY_LEVEL = "private";
const DISCLOSURE_PROFILE_A = "recipient-private-public-amount-v1";
// D7 amendment (2026-10-27).
const RAIL_A = "a_tracer";
// PROPOSED (listed in `proposed`).
const TERMS_PROTOCOL_VERSION = "xochi.shielded.terms.v1";
const PREVIEW_PROTOCOL_VERSION = "xochi.shielded.preview.v1";
const PREVIEW_DOMAIN_NAME = "Xochi Shielded Preview";
const ROUNDING = "ceil-source-units";

const NETWORK_IDENTITY_TYPE_STRING =
  "NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress," +
  "uint256 l1ChainId,bytes32 genesisOrNetworkDigest)";
const SOURCE_TYPE_STRING =
  "ShieldedSource(uint256 chainId,address token,address wallet,address collector,uint256 amount)";
const CORRIDOR_TYPE_STRING =
  "ShieldedCorridor(bytes32 corridorId,uint32 corridorRevision,bytes32 manifestDigest)";
const DESTINATION_TYPE_STRING =
  "ShieldedDestination(string settlementType,string privacyLevel,string disclosureProfile," +
  "string rail,NetworkIdentity network,ShieldedCorridor corridor,string assetId," +
  "bytes32 aztecToken,string recipientBindingId,bytes32 descriptorDigest," +
  "bytes32 aztecRecipient,uint256 amount,bytes32 feePayer)";
const FEE_TYPE_STRING =
  "ShieldedFeeBreakdown(uint256 gasFloor,uint16 solverFeeBps,uint256 solverFee," +
  "uint16 priceImpactBps,uint256 priceImpact,uint16 venueFeeBps,uint256 venueFee," +
  "uint16 routingFeeBps,uint256 routingFee,uint16 totalBps,uint256 totalFee)";
const TERMS_TYPE_STRING =
  "ShieldedTermsV1(string protocolVersion,string environment,string intentId,string quoteId," +
  "string operationId,ShieldedSource source,ShieldedDestination destination," +
  "ShieldedFeeBreakdown feeBreakdown,bytes32 sourceAuthorizationDigest,address refundAddress," +
  "uint256 refundAmount,uint64 collectBefore,uint64 settlementServiceDeadline," +
  "bytes32 recipientBindingDigest,uint32 policyRevision,string reservationId)";
const PREVIEW_TYPE_STRING =
  "ShieldedPreviewV1(string protocolVersion,string environment,ShieldedSource source," +
  "ShieldedDestination destination,ShieldedFeeBreakdown feeBreakdown,address refundAddress," +
  "uint256 refundAmount,uint64 collectBefore,uint64 settlementServiceDeadline," +
  "bytes32 recipientBindingDigest,uint32 policyRevision)";
const MANIFEST_TYPE_STRING =
  "CorridorManifestV1(bytes32 corridorId,uint32 revision,string environment,string rail," +
  "uint256 sourceChainId,bytes32 sourceGenesisHash,address sourceToken,uint8 sourceDecimals," +
  "address collector,NetworkIdentity network,string aztecSdkVersion,bytes32 aztecToken," +
  "uint8 destinationDecimals,bytes32 aztecTokenClassId,bytes32 aztecTokenArtifactDigest," +
  "string issuerProvenance,string redemptionRules,uint256 sourceUnits,uint256 destinationUnits," +
  "string rounding,bytes32 solverAccount,bytes32 solverClassId,bytes32 solverConstructorDigest," +
  "string sourceFinality,string destinationFinality,bytes32 feePayer)";

// Member lists, parsed from the literal type strings so the two cannot disagree.
const members = (typeString: string) =>
  typeString
    .slice(typeString.indexOf("(") + 1, -1)
    .split(",")
    .map((m): { name: string; type: string } => {
      const [type, name] = m.split(" ");
      if (!type || !name) throw new Error(`malformed member ${m}`);
      return { name, type };
    });
const NETWORK_MEMBERS = members(NETWORK_IDENTITY_TYPE_STRING);
const SHARED = {
  NetworkIdentity: NETWORK_MEMBERS,
  ShieldedSource: members(SOURCE_TYPE_STRING),
  ShieldedCorridor: members(CORRIDOR_TYPE_STRING),
  ShieldedDestination: members(DESTINATION_TYPE_STRING),
  ShieldedFeeBreakdown: members(FEE_TYPE_STRING),
};
const TERMS_TYPES = { ...SHARED, ShieldedTermsV1: members(TERMS_TYPE_STRING) };
const PREVIEW_TYPES = { ...SHARED, ShieldedPreviewV1: members(PREVIEW_TYPE_STRING) };
const MANIFEST_TYPES = {
  NetworkIdentity: NETWORK_MEMBERS,
  CorridorManifestV1: members(MANIFEST_TYPE_STRING),
};
const BINDING_TYPES = {
  RecipientBinding: members(
    "RecipientBinding(address sourceWallet,uint256 sourceChainId,bytes32 aztecRecipient," +
      "bytes32 aztecToken,bytes32 descriptorDigest,bytes32 corridorId,uint32 corridorRevision," +
      "bytes32 manifestDigest,bytes32 nonce,uint64 challengeExpiry,string purpose)",
  ),
};

const termsEncoder = ethers.TypedDataEncoder.from(TERMS_TYPES);
const previewEncoder = ethers.TypedDataEncoder.from(PREVIEW_TYPES);
const manifestEncoder = ethers.TypedDataEncoder.from(MANIFEST_TYPES);

// EIP-712 encodeType: the primary type, then every referenced type sorted by name.
const REFERENCED =
  NETWORK_IDENTITY_TYPE_STRING +
  CORRIDOR_TYPE_STRING +
  DESTINATION_TYPE_STRING +
  FEE_TYPE_STRING +
  SOURCE_TYPE_STRING;
const TERMS_ENCODE_TYPE = TERMS_TYPE_STRING + REFERENCED;
const PREVIEW_ENCODE_TYPE = PREVIEW_TYPE_STRING + REFERENCED;
const DESTINATION_ENCODE_TYPE =
  DESTINATION_TYPE_STRING + NETWORK_IDENTITY_TYPE_STRING + CORRIDOR_TYPE_STRING;
const MANIFEST_ENCODE_TYPE = MANIFEST_TYPE_STRING + NETWORK_IDENTITY_TYPE_STRING;
for (const [encoder, primary, expected] of [
  [termsEncoder, "ShieldedTermsV1", TERMS_ENCODE_TYPE],
  [previewEncoder, "ShieldedPreviewV1", PREVIEW_ENCODE_TYPE],
  [termsEncoder, "ShieldedDestination", DESTINATION_ENCODE_TYPE],
  [termsEncoder, "ShieldedSource", SOURCE_TYPE_STRING],
  [termsEncoder, "ShieldedFeeBreakdown", FEE_TYPE_STRING],
  [termsEncoder, "ShieldedCorridor", CORRIDOR_TYPE_STRING],
  [manifestEncoder, "CorridorManifestV1", MANIFEST_ENCODE_TYPE],
] as const) {
  if (encoder.encodeType(primary) !== expected) {
    throw new Error(`${primary} encodes as ${encoder.encodeType(primary)}`);
  }
}

// The terms member set is §7's SignedTerms list in order, plus nothing at the top level.
const SIGNED_TERMS_ORDER = [
  "protocolVersion",
  "environment",
  "intentId",
  "quoteId",
  "operationId",
  "source",
  "destination",
  "feeBreakdown",
  "sourceAuthorizationDigest",
  "refundAddress",
  "refundAmount",
  "collectBefore",
  "settlementServiceDeadline",
  "recipientBindingDigest",
  "policyRevision",
  "reservationId",
];
const EXECUTION_MEMBERS = [
  "intentId",
  "quoteId",
  "operationId",
  "sourceAuthorizationDigest",
  "reservationId",
];
if (TERMS_TYPES.ShieldedTermsV1.map((m) => m.name).join() !== SIGNED_TERMS_ORDER.join()) {
  throw new Error("ShieldedTermsV1 is not §7's SignedTerms order");
}
if (
  PREVIEW_TYPES.ShieldedPreviewV1.map((m) => m.name).join() !==
  SIGNED_TERMS_ORDER.filter((m) => !EXECUTION_MEMBERS.includes(m)).join()
) {
  throw new Error("ShieldedPreviewV1 is not the terms minus the execution members");
}

// BN254 scalar field order r; Aztec field elements and addresses are below it.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const AMOUNT_MAX = 2n ** 128n - 1n;
const UINT8_MAX = 2n ** 8n - 1n;
const UINT16_MAX = 2n ** 16n - 1n;
const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const BPS_MAX = 10000n;

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
const rep32 = (byte: string) => "0x" + byte.repeat(32);
const rep20 = (byte: string) => "0x" + byte.repeat(20);

type Network = Record<
  "aztecChainId" | "protocolVersion" | "rollupAddress" | "l1ChainId" | "genesisOrNetworkDigest",
  string
>;
type Manifest = Record<string, string | Network> & { network: Network };
type Policy = {
  gasFloor: bigint;
  solverFeeBps: bigint;
  priceImpactBps: bigint;
  venueFeeBps: bigint;
  routingFeeBps: bigint;
  policyRevision: string;
  assetId: string;
};
type Caller = {
  wallet: string;
  aztecRecipient: string;
  descriptorDigest: string;
  amount: string;
  recipientBindingId: string;
  nonce: string;
  challengeExpiry: string;
  refundAddress: string;
  collectBefore: string;
  settlementServiceDeadline: string;
};

const networkDigest = (n: Network) =>
  ethers.TypedDataEncoder.hashStruct("NetworkIdentity", { NetworkIdentity: NETWORK_MEMBERS }, n);
// §7: salt = keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest)).
const domainFor = (name: string, chainId: string, environment: string, network: Network) => ({
  name,
  version: DOMAIN_VERSION,
  chainId,
  salt: ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ethers.id(environment), networkDigest(network)],
    ),
  ),
});
const manifestDigest = (m: Manifest) => manifestEncoder.hashStruct("CorridorManifestV1", m);

// --- Fixtures ----------------------------------------------------------------------------

const NET_A: Network = {
  aztecChainId: "11155111",
  protocolVersion: "3924331020",
  rollupAddress: rep20("a1"),
  l1ChainId: "11155111",
  genesisOrNetworkDigest: rep32("9e"),
};

// Revision 1 of the tracer corridor. Decided values (§7) are marked; the rest are FIXTURES.
const BASE_MANIFEST: Manifest = {
  corridorId: rep32("c0"),
  revision: "1",
  environment: "staging",
  rail: RAIL_A,
  sourceChainId: "84532", // decided: Base Sepolia
  sourceGenesisHash: rep32("6e"),
  sourceToken: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // decided: Circle testnet USDC
  sourceDecimals: "6",
  collector: rep20("c1"),
  network: NET_A,
  aztecSdkVersion: "6.0.0", // decided 2026-10-27
  aztecToken: "0x13b600d8f842babc98a7130dcb79a2d1f4f0ba22569b2fb99f3ecc3b5c39282b", // XTU
  destinationDecimals: "6", // XTU
  aztecTokenClassId: "0x067df4ddda0b0872ef604f47f3681d5e8c0de98280ac6b79963851c055ba91e0", // XTU
  aztecTokenArtifactDigest: rep32("af"),
  issuerProvenance: "fixture: Xochi deployment of the Aztec standard Token",
  redemptionRules: "fixture: test unit, not redeemable",
  sourceUnits: "1",
  destinationUnits: "1",
  rounding: ROUNDING,
  solverAccount: rep32("05"),
  solverClassId: rep32("06"),
  solverConstructorDigest: rep32("07"),
  sourceFinality: "fixture: finalized",
  destinationFinality: "fixture: finalized",
  feePayer: "0x" + "0f".repeat(31) + "01",
};

const BASE_POLICY: Policy = {
  gasFloor: 5000n,
  solverFeeBps: 18n,
  priceImpactBps: 0n,
  venueFeeBps: 10n,
  routingFeeBps: 12n,
  policyRevision: "1",
  assetId: "aztec-testnet-xtu",
};

const BASE_CALLER: Caller = {
  wallet: ADDR_0,
  aztecRecipient: rep32("1c"),
  descriptorDigest: rep32("d5"),
  amount: "1000000",
  recipientBindingId: "bnd_0001",
  nonce: rep32("0e"),
  challengeExpiry: "1899999700",
  refundAddress: ADDR_0,
  collectBefore: "1900000000",
  settlementServiceDeadline: "1900003600",
};

// --- Derivation (PROPOSED) ---------------------------------------------------------------
//
// Exact output. base = ceil(amount * sourceUnits / destinationUnits) in source base units;
// each layer = floor(base * bps / 10000) (FeePolicy: independently floored layers);
// totalFee = max(gasFloor, the four layers) -- FeePolicy's gas floor is a MINIMUM fee, never
// added on top; source.amount = base + totalFee; design A refunds
// the collected principal in full, so refundAmount = source.amount.
const derive = (manifest: Manifest, policy: Policy, caller: Caller) => {
  const su = BigInt(manifest.sourceUnits as string);
  const du = BigInt(manifest.destinationUnits as string);
  const base = (BigInt(caller.amount) * su + du - 1n) / du;
  const layer = (bps: bigint) => (base * bps) / BPS_MAX;
  const solverFee = layer(policy.solverFeeBps);
  const priceImpact = layer(policy.priceImpactBps);
  const venueFee = layer(policy.venueFeeBps);
  const routingFee = layer(policy.routingFeeBps);
  const layers = solverFee + priceImpact + venueFee + routingFee;
  const totalFee = layers > policy.gasFloor ? layers : policy.gasFloor;
  const totalBps =
    policy.solverFeeBps + policy.priceImpactBps + policy.venueFeeBps + policy.routingFeeBps;
  const sourceAmount = base + totalFee;
  const corridor = {
    corridorId: manifest.corridorId as string,
    corridorRevision: manifest.revision as string,
    manifestDigest: manifestDigest(manifest),
  };
  const bindingMessage = {
    sourceWallet: caller.wallet,
    sourceChainId: manifest.sourceChainId as string,
    aztecRecipient: caller.aztecRecipient,
    aztecToken: manifest.aztecToken as string,
    descriptorDigest: caller.descriptorDigest,
    corridorId: corridor.corridorId,
    corridorRevision: corridor.corridorRevision,
    manifestDigest: corridor.manifestDigest,
    nonce: caller.nonce,
    challengeExpiry: caller.challengeExpiry,
    purpose: BINDING_PURPOSE,
  };
  const bindingDomain = domainFor(
    BINDING_DOMAIN_NAME,
    manifest.sourceChainId as string,
    manifest.environment as string,
    manifest.network,
  );
  const bindingDigest = ethers.TypedDataEncoder.hash(bindingDomain, BINDING_TYPES, bindingMessage);
  const preview = {
    protocolVersion: PREVIEW_PROTOCOL_VERSION,
    environment: manifest.environment as string,
    source: {
      chainId: manifest.sourceChainId as string,
      token: manifest.sourceToken as string,
      wallet: caller.wallet,
      collector: manifest.collector as string,
      amount: sourceAmount.toString(),
    },
    destination: {
      settlementType: SETTLEMENT_TYPE,
      privacyLevel: PRIVACY_LEVEL,
      disclosureProfile: DISCLOSURE_PROFILE_A,
      rail: manifest.rail as string,
      network: manifest.network,
      corridor,
      assetId: policy.assetId,
      aztecToken: manifest.aztecToken as string,
      recipientBindingId: caller.recipientBindingId,
      descriptorDigest: caller.descriptorDigest,
      aztecRecipient: caller.aztecRecipient,
      amount: caller.amount,
      feePayer: manifest.feePayer as string,
    },
    feeBreakdown: {
      gasFloor: policy.gasFloor.toString(),
      solverFeeBps: policy.solverFeeBps.toString(),
      solverFee: solverFee.toString(),
      priceImpactBps: policy.priceImpactBps.toString(),
      priceImpact: priceImpact.toString(),
      venueFeeBps: policy.venueFeeBps.toString(),
      venueFee: venueFee.toString(),
      routingFeeBps: policy.routingFeeBps.toString(),
      routingFee: routingFee.toString(),
      totalBps: totalBps.toString(),
      totalFee: totalFee.toString(),
    },
    refundAddress: caller.refundAddress,
    refundAmount: sourceAmount.toString(),
    collectBefore: caller.collectBefore,
    settlementServiceDeadline: caller.settlementServiceDeadline,
    recipientBindingDigest: bindingDigest,
    policyRevision: policy.policyRevision,
  };
  return { bindingMessage, bindingDigest, preview };
};

const policyWire = (p: Policy) => ({
  gasFloor: p.gasFloor.toString(),
  solverFeeBps: p.solverFeeBps.toString(),
  priceImpactBps: p.priceImpactBps.toString(),
  venueFeeBps: p.venueFeeBps.toString(),
  routingFeeBps: p.routingFeeBps.toString(),
  policyRevision: p.policyRevision,
  assetId: p.assetId,
});

// --- Manifest vectors --------------------------------------------------------------------

const MANIFEST_CASES: { name: string; manifest: Partial<Manifest> }[] = [
  { name: "baseline", manifest: {} },
  { name: "other-corridor-id", manifest: { corridorId: rep32("c3") } },
  { name: "next-revision", manifest: { revision: "2" } },
  { name: "other-environment", manifest: { environment: "production" } },
  { name: "other-source-chain", manifest: { sourceChainId: "11155111" } },
  { name: "other-source-genesis", manifest: { sourceGenesisHash: rep32("6f") } },
  { name: "other-source-token", manifest: { sourceToken: rep20("5d") } },
  { name: "other-source-decimals", manifest: { sourceDecimals: "18" } },
  { name: "rotated-collector", manifest: { collector: rep20("c2") } },
  {
    name: "redeployed-rollup",
    manifest: { network: { ...NET_A, rollupAddress: rep20("a2") } },
  },
  { name: "other-sdk-version", manifest: { aztecSdkVersion: "6.0.1" } },
  { name: "other-aztec-token", manifest: { aztecToken: rep32("2c") } },
  { name: "other-destination-decimals", manifest: { destinationDecimals: "18" } },
  { name: "other-token-class", manifest: { aztecTokenClassId: rep32("08") } },
  { name: "other-token-artifact", manifest: { aztecTokenArtifactDigest: rep32("ae") } },
  { name: "other-provenance", manifest: { issuerProvenance: "fixture: other issuer" } },
  { name: "other-redemption", manifest: { redemptionRules: "fixture: redeemable 1:1" } },
  { name: "other-unit-conversion", manifest: { sourceUnits: "2" } },
  { name: "rotated-solver-account", manifest: { solverAccount: rep32("15") } },
  { name: "other-solver-class", manifest: { solverClassId: rep32("16") } },
  { name: "other-solver-constructor", manifest: { solverConstructorDigest: rep32("17") } },
  { name: "other-source-finality", manifest: { sourceFinality: "fixture: safe" } },
  { name: "other-destination-finality", manifest: { destinationFinality: "fixture: proven" } },
  { name: "other-fee-payer", manifest: { feePayer: "0x" + "0f".repeat(31) + "02" } },
];

const manifestVectors = MANIFEST_CASES.map(({ name, manifest }) => {
  const message = { ...BASE_MANIFEST, ...manifest } as Manifest;
  return { name, message, manifestDigest: manifestDigest(message) };
});

// --- Preview vectors ---------------------------------------------------------------------

const PREVIEW_CASES: {
  name: string;
  caller?: Partial<Caller>;
  manifest?: Partial<Manifest>;
  policy?: Partial<Policy>;
}[] = [
  { name: "baseline" },
  { name: "other-aztec-recipient", caller: { aztecRecipient: rep32("1d") } },
  { name: "other-descriptor-digest", caller: { descriptorDigest: rep32("d6") } },
  { name: "other-destination-amount", caller: { amount: "1000001" } },
  { name: "other-recipient-binding-id", caller: { recipientBindingId: "bnd_0002" } },
  { name: "other-binding-nonce", caller: { nonce: rep32("0f") } },
  { name: "other-binding-challenge-expiry", caller: { challengeExpiry: "1899999701" } },
  { name: "other-source-wallet", caller: { wallet: ADDR_1, refundAddress: ADDR_1 } },
  { name: "other-refund-address", caller: { refundAddress: rep20("ad") } },
  { name: "other-collect-before", caller: { collectBefore: "1900000001" } },
  { name: "other-service-deadline", caller: { settlementServiceDeadline: "1900003601" } },
  { name: "other-manifest-revision", manifest: { revision: "2" } },
  { name: "redeployed-rollup", manifest: { network: { ...NET_A, rollupAddress: rep20("a2") } } },
  { name: "other-policy-revision", policy: { policyRevision: "2" } },
  { name: "other-solver-fee", policy: { solverFeeBps: 19n } },
  { name: "other-gas-floor", policy: { gasFloor: 5001n } },
  // 10 test units: the layers (40,000) exceed the 5,000 floor, so the floor does not bind.
  { name: "layers-above-floor", caller: { amount: "10000000" } },
];

const previewVectors = PREVIEW_CASES.map(({ name, caller, manifest, policy }) => {
  const m = { ...BASE_MANIFEST, ...manifest } as Manifest;
  const p = { ...BASE_POLICY, ...policy };
  const c = { ...BASE_CALLER, ...caller };
  const { bindingMessage, bindingDigest, preview } = derive(m, p, c);
  const domain = domainFor(
    PREVIEW_DOMAIN_NAME,
    m.sourceChainId as string,
    m.environment as string,
    m.network,
  );
  return {
    name,
    inputs: { manifest: m, policy: policyWire(p), caller: c },
    recipientBinding: { message: bindingMessage, digest: bindingDigest },
    message: preview,
    domain,
    domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
    structHash: previewEncoder.hashStruct("ShieldedPreviewV1", preview),
    digest: ethers.TypedDataEncoder.hash(domain, PREVIEW_TYPES, preview),
  };
});

// --- Terms vectors -----------------------------------------------------------------------

type Execution = {
  intentId: string;
  quoteId: string;
  operationId: string;
  sourceAuthorizationDigest: string;
  reservationId: string;
};
const BASE_EXECUTION: Execution = {
  intentId: "xi_fixture0001",
  quoteId: "xq_fixture0001",
  operationId: "op_fixture0001",
  sourceAuthorizationDigest: rep32("5a"),
  reservationId: "rsv_fixture0001",
};

const termsFrom = (preview: (typeof previewVectors)[number]["message"], e: Execution) => {
  const { protocolVersion: _p, environment, source, destination, feeBreakdown, ...rest } = preview;
  return {
    protocolVersion: TERMS_PROTOCOL_VERSION,
    environment,
    intentId: e.intentId,
    quoteId: e.quoteId,
    operationId: e.operationId,
    source,
    destination,
    feeBreakdown,
    sourceAuthorizationDigest: e.sourceAuthorizationDigest,
    refundAddress: rest.refundAddress,
    refundAmount: rest.refundAmount,
    collectBefore: rest.collectBefore,
    settlementServiceDeadline: rest.settlementServiceDeadline,
    recipientBindingDigest: rest.recipientBindingDigest,
    policyRevision: rest.policyRevision,
    reservationId: e.reservationId,
  };
};
type Terms = ReturnType<typeof termsFrom>;

const previewByName = Object.fromEntries(previewVectors.map((v) => [v.name, v]));
const TERMS_CASES: {
  name: string;
  preview: string;
  execution?: Partial<Execution>;
  wallet?: ethers.Wallet;
}[] = [
  { name: "baseline", preview: "baseline" },
  { name: "other-intent-id", preview: "baseline", execution: { intentId: "xi_fixture0002" } },
  { name: "other-quote-id", preview: "baseline", execution: { quoteId: "xq_fixture0002" } },
  {
    name: "other-operation-id",
    preview: "baseline",
    execution: { operationId: "op_fixture0002" },
  },
  {
    name: "other-source-authorization",
    preview: "baseline",
    execution: { sourceAuthorizationDigest: rep32("5b") },
  },
  {
    name: "other-reservation-id",
    preview: "baseline",
    execution: { reservationId: "rsv_fixture0002" },
  },
  ...PREVIEW_CASES.filter((c) => c.name !== "baseline").map((c) => ({
    name: c.name,
    preview: c.name,
    wallet: c.caller?.wallet === ADDR_1 ? WALLET_1 : undefined,
  })),
];

const termsVectors = await Promise.all(
  TERMS_CASES.map(async ({ name, preview, execution, wallet }) => {
    const pv = previewByName[preview];
    if (!pv) throw new Error(`${name}: no preview vector ${preview}`);
    const message: Terms = termsFrom(pv.message, { ...BASE_EXECUTION, ...execution });
    const signer = wallet ?? WALLET_0;
    if (signer.address.toLowerCase() !== message.source.wallet) {
      throw new Error(`${name}: the signer must be the source wallet`);
    }
    const domain = domainFor(
      TERMS_DOMAIN_NAME,
      message.source.chainId,
      message.environment,
      message.destination.network,
    );
    const digest = ethers.TypedDataEncoder.hash(domain, TERMS_TYPES, message);
    const signature = ethers.Signature.from(
      await signer.signTypedData(domain, TERMS_TYPES, message),
    ).serialized;
    if (ethers.recoverAddress(digest, signature).toLowerCase() !== message.source.wallet) {
      throw new Error(`${name}: signature does not recover the source wallet`);
    }
    if (digest === pv.digest) throw new Error(`${name}: terms digest equals its preview digest`);
    return {
      name,
      previewVector: preview,
      message,
      domain,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
      sourceHash: termsEncoder.hashStruct("ShieldedSource", message.source),
      corridorHash: termsEncoder.hashStruct("ShieldedCorridor", message.destination.corridor),
      destinationHash: termsEncoder.hashStruct("ShieldedDestination", message.destination),
      feeBreakdownHash: termsEncoder.hashStruct("ShieldedFeeBreakdown", message.feeBreakdown),
      structHash: termsEncoder.hashStruct("ShieldedTermsV1", message),
      digest,
      signer: message.source.wallet,
      signature,
    };
  }),
);

// Every digest is distinct within and across the three sets, and every accepted vector carries
// admissible Aztec values (nonzero, below r).
const seen = new Map<string, string>();
for (const [set, list] of [
  ["manifest", manifestVectors.map((v): [string, string] => [v.name, v.manifestDigest])],
  ["preview", previewVectors.map((v): [string, string] => [v.name, v.digest])],
  ["terms", termsVectors.map((v): [string, string] => [v.name, v.digest])],
] as const) {
  for (const [name, digest] of list) {
    const other = seen.get(digest);
    if (other) throw new Error(`${set}/${name} and ${other} share a digest`);
    seen.set(digest, `${set}/${name}`);
  }
}
for (const v of previewVectors) {
  const d = v.message.destination;
  for (const [field, value] of [
    ["aztecToken", d.aztecToken],
    ["aztecRecipient", d.aztecRecipient],
    ["feePayer", d.feePayer],
    ["network.aztecChainId", d.network.aztecChainId],
    ["network.protocolVersion", d.network.protocolVersion],
  ] as const) {
    if (BigInt(value) === 0n || BigInt(value) >= P) {
      throw new Error(`${v.name}: ${field} is not an Aztec value`);
    }
  }
}

// --- Refusals: expectations are DATA -----------------------------------------------------
//
// Encoding-level codes, shared with shielded.json where the rule is the same:
//   terms_version_unsupported    protocolVersion is not this type's literal
//   settlement_type_mismatch     destination.settlementType is not "shielded"
//   privacy_level_unsupported    destination.privacyLevel is not "private" (Sovereign refused)
//   disclosure_profile_mismatch  a profile other than §7's design-A profile
//   rail_unknown                 rail is not "a_tracer" (b_panel is not a v1 rail)
//   string_empty                 an id, assetId or recipientBindingId is empty
//   environment_empty            environment is empty (shielded.json's code)
//   deadline_order               settlementServiceDeadline <= collectBefore
//   fee_breakdown_inconsistent   totalFee != max(gasFloor, layers), or totalBps != sum of rates
//   rounding_unknown             a manifest rounding rule other than "ceil-source-units"
//   aztec_zero / aztec_out_of_field / not_bytes32 / amount_* / evm_address_zero /
//   not_evm_address / uint_out_of_range / chain_id_zero   as in shielded.json

const baseTerms: Terms = termsFrom(
  derive(BASE_MANIFEST, BASE_POLICY, BASE_CALLER).preview,
  BASE_EXECUTION,
);
const withDest = (d: Partial<Terms["destination"]>) => ({
  destination: { ...baseTerms.destination, ...d },
});
const withFee = (f: Partial<Terms["feeBreakdown"]>) => ({
  feeBreakdown: { ...baseTerms.feeBreakdown, ...f },
});
const withSource = (s: Partial<Terms["source"]>) => ({ source: { ...baseTerms.source, ...s } });

const termsRefusals = (
  [
    [
      "protocol-version-preview",
      { protocolVersion: PREVIEW_PROTOCOL_VERSION },
      "terms_version_unsupported",
      "protocolVersion",
    ],
    [
      "settlement-type-stealth",
      withDest({ settlementType: "stealth" }),
      "settlement_type_mismatch",
      "destination.settlementType",
    ],
    [
      "privacy-level-sovereign",
      withDest({ privacyLevel: "sovereign" }),
      "privacy_level_unsupported",
      "destination.privacyLevel",
    ],
    [
      "other-profile",
      withDest({ disclosureProfile: "recipient-private-private-amount-v1" }),
      "disclosure_profile_mismatch",
      "destination.disclosureProfile",
    ],
    ["rail-b-panel", withDest({ rail: "b_panel" }), "rail_unknown", "destination.rail"],
    ["intent-id-empty", { intentId: "" }, "string_empty", "intentId"],
    ["reservation-id-empty", { reservationId: "" }, "string_empty", "reservationId"],
    ["asset-id-empty", withDest({ assetId: "" }), "string_empty", "destination.assetId"],
    ["environment-empty", { environment: "" }, "environment_empty", "environment"],
    [
      "service-deadline-equals-collect-before",
      { settlementServiceDeadline: baseTerms.collectBefore },
      "deadline_order",
      "settlementServiceDeadline",
    ],
    [
      "collect-before-over-uint64",
      { collectBefore: (UINT64_MAX + 1n).toString() },
      "uint_out_of_range",
      "collectBefore",
    ],
    [
      "policy-revision-over-uint32",
      { policyRevision: (UINT32_MAX + 1n).toString() },
      "uint_out_of_range",
      "policyRevision",
    ],
    [
      "fee-total-off-by-one",
      withFee({ totalFee: (BigInt(baseTerms.feeBreakdown.totalFee) + 1n).toString() }),
      "fee_breakdown_inconsistent",
      "feeBreakdown.totalFee",
    ],
    [
      "fee-total-bps-off-by-one",
      withFee({ totalBps: (BigInt(baseTerms.feeBreakdown.totalBps) + 1n).toString() }),
      "fee_breakdown_inconsistent",
      "feeBreakdown.totalBps",
    ],
    [
      "fee-bps-over-uint16",
      withFee({ solverFeeBps: (UINT16_MAX + 1n).toString() }),
      "uint_out_of_range",
      "feeBreakdown.solverFeeBps",
    ],
    [
      "aztec-recipient-zero",
      withDest({ aztecRecipient: hex32(0n) }),
      "aztec_zero",
      "destination.aztecRecipient",
    ],
    [
      "aztec-token-field-modulus",
      withDest({ aztecToken: hex32(P) }),
      "aztec_out_of_field",
      "destination.aztecToken",
    ],
    ["fee-payer-zero", withDest({ feePayer: hex32(0n) }), "aztec_zero", "destination.feePayer"],
    [
      "aztec-recipient-evm-length",
      withDest({ aztecRecipient: ADDR_1 }),
      "not_bytes32",
      "destination.aztecRecipient",
    ],
    ["destination-amount-zero", withDest({ amount: "0" }), "amount_zero", "destination.amount"],
    [
      "source-amount-over-max",
      withSource({ amount: (AMOUNT_MAX + 1n).toString() }),
      "amount_over_max",
      "source.amount",
    ],
    ["refund-amount-not-canonical", { refundAmount: "01" }, "amount_not_canonical", "refundAmount"],
    [
      "collector-zero",
      withSource({ collector: rep20("00") }),
      "evm_address_zero",
      "source.collector",
    ],
    [
      "source-token-aztec-length",
      withSource({ token: rep32("2b") }),
      "not_evm_address",
      "source.token",
    ],
    ["source-chain-zero", withSource({ chainId: "0" }), "chain_id_zero", "source.chainId"],
    [
      "source-authorization-not-bytes32",
      { sourceAuthorizationDigest: rep20("5a") },
      "not_bytes32",
      "sourceAuthorizationDigest",
    ],
  ] as [string, Partial<Terms>, string, string][]
).map(([name, terms, code, field]) => ({
  name,
  message: { ...baseTerms, ...terms },
  error: { code, field },
}));

const baseManifest = BASE_MANIFEST;
const manifestRefusals = (
  [
    ["rail-b-panel", { rail: "b_panel" }, "rail_unknown", "rail"],
    ["rounding-other", { rounding: "floor-source-units" }, "rounding_unknown", "rounding"],
    ["revision-zero", { revision: "0" }, "uint_out_of_range", "revision"],
    [
      "decimals-over-uint8",
      { sourceDecimals: (UINT8_MAX + 1n).toString() },
      "uint_out_of_range",
      "sourceDecimals",
    ],
    ["source-units-zero", { sourceUnits: "0" }, "amount_zero", "sourceUnits"],
    ["environment-empty", { environment: "" }, "environment_empty", "environment"],
    ["sdk-version-empty", { aztecSdkVersion: "" }, "string_empty", "aztecSdkVersion"],
    ["aztec-token-zero", { aztecToken: hex32(0n) }, "aztec_zero", "aztecToken"],
    [
      "solver-account-field-modulus",
      { solverAccount: hex32(P) },
      "aztec_out_of_field",
      "solverAccount",
    ],
    ["collector-zero", { collector: rep20("00") }, "evm_address_zero", "collector"],
    ["source-chain-zero", { sourceChainId: "0" }, "chain_id_zero", "sourceChainId"],
  ] as [string, Partial<Manifest>, string, string][]
).map(([name, manifest, code, field]) => ({
  name,
  message: { ...baseManifest, ...manifest },
  error: { code, field },
}));

// --- Output ------------------------------------------------------------------------------

const out = {
  version: 2,
  status: "PROPOSED",
  generator: "packages/spec/conformance/generate-shielded-terms.ts",
  source:
    'xochi docs/planning/shielded-execution.md §7 "Decided 2026-10-27 (D7 amendment)" ' +
    '(axol-io/Riddler#1296); manifest revision 1 values from §7 "Tracer source", ' +
    '"Decided 2026-10-24 (third set)" and "Provisioned 2026-10-25"',
  constants: {
    aztecFieldModulus: P.toString(),
    amountMax: AMOUNT_MAX.toString(),
    domainVersion: DOMAIN_VERSION,
    termsDomainName: TERMS_DOMAIN_NAME,
    previewDomainName: PREVIEW_DOMAIN_NAME,
    termsProtocolVersion: TERMS_PROTOCOL_VERSION,
    previewProtocolVersion: PREVIEW_PROTOCOL_VERSION,
    settlementType: SETTLEMENT_TYPE,
    privacyLevel: PRIVACY_LEVEL,
    disclosureProfileA: DISCLOSURE_PROFILE_A,
    rails: [RAIL_A],
    rounding: ROUNDING,
    executionMembers: EXECUTION_MEMBERS,
  },
  domain: { typeString: DOMAIN_TYPE_STRING, typehash: ethers.id(DOMAIN_TYPE_STRING) },
  types: {
    terms: { encodeType: TERMS_ENCODE_TYPE, typehash: ethers.id(TERMS_ENCODE_TYPE) },
    preview: { encodeType: PREVIEW_ENCODE_TYPE, typehash: ethers.id(PREVIEW_ENCODE_TYPE) },
    manifest: { encodeType: MANIFEST_ENCODE_TYPE, typehash: ethers.id(MANIFEST_ENCODE_TYPE) },
    destination: {
      encodeType: DESTINATION_ENCODE_TYPE,
      typehash: ethers.id(DESTINATION_ENCODE_TYPE),
    },
    source: { encodeType: SOURCE_TYPE_STRING, typehash: ethers.id(SOURCE_TYPE_STRING) },
    corridor: { encodeType: CORRIDOR_TYPE_STRING, typehash: ethers.id(CORRIDOR_TYPE_STRING) },
    feeBreakdown: { encodeType: FEE_TYPE_STRING, typehash: ethers.id(FEE_TYPE_STRING) },
  },
  signerIsTestKey: true,
  manifest: { vectors: manifestVectors, refusals: manifestRefusals },
  preview: { vectors: previewVectors },
  terms: { vectors: termsVectors, refusals: termsRefusals },
  proposed: [
    {
      item: "member types and nesting",
      reason:
        "§7 names the SignedTerms members and the amendment adds rail and feePayer; the types and " +
        "the ShieldedSource / ShieldedDestination / ShieldedCorridor / ShieldedFeeBreakdown nesting " +
        "are fixed here.",
    },
    {
      item: "protocolVersion literals",
      reason: `"${TERMS_PROTOCOL_VERSION}" for terms, "${PREVIEW_PROTOCOL_VERSION}" for the preview.`,
    },
    {
      item: "ShieldedPreviewV1",
      reason:
        `Primary type ShieldedPreviewV1 under domain name "${PREVIEW_DOMAIN_NAME}" (version "1", ` +
        "the §7 chainId/salt scheme): the terms minus intentId, quoteId, operationId, " +
        "sourceAuthorizationDigest and reservationId. Never signed.",
    },
    {
      item: "widths",
      reason:
        "collectBefore and settlementServiceDeadline uint64 Unix seconds; policyRevision uint32; " +
        "bps uint16; decimals uint8; ids, assetId and recipientBindingId strings; " +
        "sourceAuthorizationDigest bytes32.",
    },
    {
      item: "ShieldedFeeBreakdown",
      reason:
        "The narrowest shape matching Riddler FeePolicy's layered breakdown, amounts in SOURCE base " +
        "units (an exact-output fee is added to the source pull). gasFloor is a MINIMUM, as in " +
        "FeePolicy: totalFee = max(gasFloor, the four layers); totalBps = the four rates. Tier, " +
        "asset class, total_usd and the surplus share are " +
        "not signing values.",
    },
    {
      item: "derivation",
      reason:
        "base = ceil(amount * sourceUnits / destinationUnits); each layer floor(base * bps / 10000); " +
        "totalFee = max(gasFloor, layers); source.amount = base + totalFee; refundAmount = " +
        "source.amount (design A refunds in full). Each preview vector carries its inputs, and a " +
        "preview never varies a revision's fixed identity field (that is a new revision).",
    },
    {
      item: "CorridorManifestV1",
      reason:
        "The §6/§7 identity fields as typed members: the recipient class pin is outside (decided " +
        "2026-10-24), the exact Aztec SDK version inside; rounding literal " +
        `"${ROUNDING}"; provenance, redemption and finality rules as strings. The manifest ` +
        "vectors pin the hash only: a revision's decided identity values are fixed, and changing " +
        "one is a new revision.",
    },
    {
      item: "recipientBindingDigest derivation",
      reason:
        "The EIP-712 digest of the §7 RecipientBinding whose shared members are the terms' own; " +
        "only nonce and challengeExpiry come from the binding.",
    },
  ],
};

// --- Schema ------------------------------------------------------------------------------

const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const ADDR = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
const UINT = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const SIG = { type: "string", pattern: "^0x[0-9a-f]{130}$" };
const STR = { type: "string" };
const LOOSE = { type: "object" };
const obj = (props: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(props),
  additionalProperties: false,
  properties: props,
});
const arr = (items: unknown) => ({ type: "array", minItems: 1, items });
const typed = (memberList: { name: string; type: string }[], nested: Record<string, unknown>) =>
  obj(
    Object.fromEntries(
      memberList.map(({ name, type }) => [
        name,
        nested[type] ??
          (type === "address" ? ADDR : type === "bytes32" ? HEX32 : type === "string" ? STR : UINT),
      ]),
    ),
  );
const NETWORK = typed(NETWORK_MEMBERS, {});
const SOURCE = typed(SHARED.ShieldedSource, {});
const CORRIDOR = typed(SHARED.ShieldedCorridor, {});
const FEE = typed(SHARED.ShieldedFeeBreakdown, {});
const DESTINATION = typed(SHARED.ShieldedDestination, {
  NetworkIdentity: NETWORK,
  ShieldedCorridor: CORRIDOR,
});
const NESTED = {
  ShieldedSource: SOURCE,
  ShieldedDestination: DESTINATION,
  ShieldedFeeBreakdown: FEE,
};
const MANIFEST = typed(MANIFEST_TYPES.CorridorManifestV1, { NetworkIdentity: NETWORK });
const DOMAIN = obj({ name: STR, version: STR, chainId: UINT, salt: HEX32 });
const TYPE_ENTRY = obj({ encodeType: STR, typehash: HEX32 });
const REFUSAL = (codes: string[]) =>
  arr(obj({ name: STR, message: LOOSE, error: obj({ code: { enum: codes }, field: STR }) }));
const CODES = [
  "terms_version_unsupported",
  "settlement_type_mismatch",
  "privacy_level_unsupported",
  "disclosure_profile_mismatch",
  "rail_unknown",
  "string_empty",
  "environment_empty",
  "deadline_order",
  "fee_breakdown_inconsistent",
  "rounding_unknown",
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
];

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://xochi.fi/spec/conformance/shielded-terms.schema.json",
  title: "Shielded settlement v1 design-A terms, preview and manifest vectors (PROPOSED)",
  description:
    "ShieldedTermsV1 (§7 SignedTerms + rail + feePayer, D7 amendment 2026-10-27), the non-signable " +
    "ShieldedPreviewV1 and the CorridorManifestV1 hashStruct (manifestDigest), with single-member " +
    "refusals. Generated with ethers primitives, independently of @xochi/signer and Riddler. uint " +
    "values are decimal strings; bytes/addresses lowercase hex. All digests are distinct.",
  ...obj({
    version: { const: 2 },
    status: { const: "PROPOSED" },
    generator: STR,
    source: STR,
    constants: obj({
      aztecFieldModulus: UINT,
      amountMax: UINT,
      domainVersion: { const: DOMAIN_VERSION },
      termsDomainName: { const: TERMS_DOMAIN_NAME },
      previewDomainName: { const: PREVIEW_DOMAIN_NAME },
      termsProtocolVersion: { const: TERMS_PROTOCOL_VERSION },
      previewProtocolVersion: { const: PREVIEW_PROTOCOL_VERSION },
      settlementType: { const: SETTLEMENT_TYPE },
      privacyLevel: { const: PRIVACY_LEVEL },
      disclosureProfileA: { const: DISCLOSURE_PROFILE_A },
      rails: { type: "array", items: { const: RAIL_A } },
      rounding: { const: ROUNDING },
      executionMembers: { type: "array", items: STR },
    }),
    domain: obj({ typeString: STR, typehash: HEX32 }),
    types: obj({
      terms: TYPE_ENTRY,
      preview: TYPE_ENTRY,
      manifest: TYPE_ENTRY,
      destination: TYPE_ENTRY,
      source: TYPE_ENTRY,
      corridor: TYPE_ENTRY,
      feeBreakdown: TYPE_ENTRY,
    }),
    signerIsTestKey: { const: true },
    manifest: obj({
      vectors: arr(obj({ name: STR, message: MANIFEST, manifestDigest: HEX32 })),
      refusals: REFUSAL(CODES),
    }),
    preview: obj({
      vectors: arr(
        obj({
          name: STR,
          inputs: obj({ manifest: MANIFEST, policy: LOOSE, caller: LOOSE }),
          recipientBinding: obj({ message: LOOSE, digest: HEX32 }),
          message: typed(PREVIEW_TYPES.ShieldedPreviewV1, NESTED),
          domain: DOMAIN,
          domainSeparator: HEX32,
          structHash: HEX32,
          digest: HEX32,
        }),
      ),
    }),
    terms: obj({
      vectors: arr(
        obj({
          name: STR,
          previewVector: STR,
          message: typed(TERMS_TYPES.ShieldedTermsV1, NESTED),
          domain: DOMAIN,
          domainSeparator: HEX32,
          sourceHash: HEX32,
          corridorHash: HEX32,
          destinationHash: HEX32,
          feeBreakdownHash: HEX32,
          structHash: HEX32,
          digest: HEX32,
          signer: ADDR,
          signature: SIG,
        }),
      ),
      refusals: REFUSAL(CODES),
    }),
    proposed: arr(obj({ item: STR, reason: STR })),
  }),
};

const dir = process.env.SHIELDED_TERMS_VECTORS_DIR ?? path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(dir, "shielded-terms.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(
  path.join(dir, "shielded-terms.schema.json"),
  JSON.stringify(schema, null, 2) + "\n",
);
console.log(
  `wrote shielded-terms.json: ${manifestVectors.length} manifests, ` +
    `${previewVectors.length} previews, ${termsVectors.length} terms, ` +
    `${manifestRefusals.length + termsRefusals.length} refusals`,
);
