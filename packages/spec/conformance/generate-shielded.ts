#!/usr/bin/env node
// Generates `conformance/shielded.json` (+ `shielded.schema.json`): the vector set for
// the recipient-private Aztec settlement contract v1 typed encodings approved on
// 2026-10-18 (xochi docs/planning/shielded-execution.md §7 "Approved 2026-10-18: typed
// encodings"; xochi#633, xochi#635): the NetworkIdentity hashStruct, the salted
// `Domain (binding)` / `Domain (terms)`, the RecipientBinding struct hash, EIP-712
// digest and source-wallet signature, and the value refusals (Aztec bytes32, amounts).
//
// INDEPENDENT OF @xochi/signer, deliberately. Every value is derived here from §7's
// literals with ethers' generic primitives only (TypedDataEncoder, keccak256, AbiCoder,
// Wallet), and every refusal expectation is written below as data, never obtained by
// running the reference. `@xochi/signer`'s `shielded.ts` is then checked AGAINST this
// file (packages/signer/test/shielded-vectors.test.ts), so the two implementations meet
// only at the committed JSON. Importing the reference here would let it grade itself.
//
// NetworkIdentity: §7 names its five members and delegates the typed encoding to these
// vectors. The encoding below was approved by the product owner on 2026-10-19
// (protocolVersion = the numeric Aztec rollup version); the §7 record lands in a separate
// xochi PR.
//
// Aztec values are checked by magnitude only: nonzero and below BN254 r. There is no
// "looks like a padded EVM address" refusal: whether a bytes32 is really an Aztec address
// (and not an EVM address) is established by descriptor/address derivation, not by its size.
//
// ShieldedTermsV1, the manifestDigest struct, the descriptorDigest encoding and the
// recipient message wrapper/acknowledgements are NOT here: §7 leaves them open.
//
// Every network, corridor, digest and Aztec value below is a FIXTURE. The signer keys are
// the PUBLIC Hardhat/Anvil test keys #0 and #1: known to everyone, never to hold funds.
//
// Run: npm run generate:shielded   (SHIELDED_VECTORS_DIR overrides the output dir)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

// --- §7 literals -----------------------------------------------------------------------

const DOMAIN_VERSION = "1";
const BINDING_DOMAIN_NAME = "Xochi Shielded Recipient";
const TERMS_DOMAIN_NAME = "Xochi Shielded Terms";
const PURPOSE = "xochi.shielded.recipient-binding.v1";
// EIP-712's fixed member order for `{ name, version, chainId, salt }`.
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)";
// Approved byte-for-byte (§7).
const RECIPIENT_BINDING_TYPE_STRING =
  "RecipientBinding(address sourceWallet,uint256 sourceChainId,bytes32 aztecRecipient," +
  "bytes32 aztecToken,bytes32 descriptorDigest,bytes32 corridorId,uint32 corridorRevision," +
  "bytes32 manifestDigest,bytes32 nonce,uint64 challengeExpiry,string purpose)";
// Approved 2026-10-19 by the product owner (see header).
const NETWORK_IDENTITY_TYPE_STRING =
  "NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress," +
  "uint256 l1ChainId,bytes32 genesisOrNetworkDigest)";

const NETWORK_TYPES = {
  NetworkIdentity: [
    { name: "aztecChainId", type: "uint256" },
    { name: "protocolVersion", type: "uint256" },
    { name: "rollupAddress", type: "address" },
    { name: "l1ChainId", type: "uint256" },
    { name: "genesisOrNetworkDigest", type: "bytes32" },
  ],
};
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
// The type definitions above must spell exactly the literal type strings.
for (const [primary, types, literal] of [
  ["NetworkIdentity", NETWORK_TYPES, NETWORK_IDENTITY_TYPE_STRING],
  ["RecipientBinding", BINDING_TYPES, RECIPIENT_BINDING_TYPE_STRING],
] as const) {
  const encoded = ethers.TypedDataEncoder.from(types).encodeType(primary);
  if (encoded !== literal) throw new Error(`${primary} types spell ${encoded}`);
}

// BN254 scalar field order r (EIP-196/197); Aztec field elements and addresses are below it.
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
const paddedEvm = (addr: string) => ethers.zeroPadValue(addr, 32).toLowerCase();

type Network = {
  aztecChainId: string;
  protocolVersion: string;
  rollupAddress: string;
  l1ChainId: string;
  genesisOrNetworkDigest: string;
};
type Binding = {
  sourceWallet: string;
  sourceChainId: string;
  aztecRecipient: string;
  aztecToken: string;
  descriptorDigest: string;
  corridorId: string;
  corridorRevision: string;
  manifestDigest: string;
  nonce: string;
  challengeExpiry: string;
  purpose: string;
};

const networkDigest = (n: Network) =>
  ethers.TypedDataEncoder.hashStruct("NetworkIdentity", NETWORK_TYPES, n);
// salt = keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest))
const domainSalt = (environment: string, n: Network) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ethers.id(environment), networkDigest(n)],
    ),
  );
const domainFor = (name: string, chainId: string, environment: string, n: Network) => ({
  name,
  version: DOMAIN_VERSION,
  chainId,
  salt: domainSalt(environment, n),
});

// --- Networks (FIXTURES) ---------------------------------------------------------------

const NET_A: Network = {
  aztecChainId: "11155111",
  protocolVersion: "3924331020",
  rollupAddress: "0x" + "a1".repeat(20),
  l1ChainId: "11155111",
  genesisOrNetworkDigest: "0x" + "9e".repeat(32),
};
// Same network but a redeployed rollup: a different identity.
const NET_B: Network = { ...NET_A, rollupAddress: "0x" + "a2".repeat(20) };
// Every member at its largest admissible value.
const NET_MAX: Network = {
  aztecChainId: (P - 1n).toString(),
  protocolVersion: (P - 1n).toString(),
  rollupAddress: "0x" + "ff".repeat(20),
  l1ChainId: UINT256_MAX.toString(),
  genesisOrNetworkDigest: "0x" + "ff".repeat(32),
};

const networkVectors = [
  { name: "fixture-a", network: NET_A },
  { name: "fixture-a-redeployed-rollup", network: NET_B },
  { name: "max-members", network: NET_MAX },
].map((v) => ({ ...v, networkIdentityDigest: networkDigest(v.network) }));

// --- Domains -----------------------------------------------------------------------------

const domainVectors = [
  { name: "staging-fixture-a-84532", environment: "staging", network: NET_A, chainId: "84532" },
  {
    name: "production-fixture-a-84532",
    environment: "production",
    network: NET_A,
    chainId: "84532",
  },
  {
    name: "staging-redeployed-rollup-84532",
    environment: "staging",
    network: NET_B,
    chainId: "84532",
  },
  { name: "staging-fixture-a-chain-1", environment: "staging", network: NET_A, chainId: "1" },
  {
    name: "utf8-environment-max-members",
    environment: "tést-ñet",
    network: NET_MAX,
    chainId: UINT256_MAX.toString(),
  },
].map((c) => {
  const binding = domainFor(BINDING_DOMAIN_NAME, c.chainId, c.environment, c.network);
  const terms = domainFor(TERMS_DOMAIN_NAME, c.chainId, c.environment, c.network);
  return {
    ...c,
    networkIdentityDigest: networkDigest(c.network),
    salt: domainSalt(c.environment, c.network),
    binding: { domain: binding, domainSeparator: ethers.TypedDataEncoder.hashDomain(binding) },
    terms: { domain: terms, domainSeparator: ethers.TypedDataEncoder.hashDomain(terms) },
  };
});

// --- RecipientBinding --------------------------------------------------------------------

const BASE_BINDING: Binding = {
  sourceWallet: ADDR_0,
  sourceChainId: "84532",
  aztecRecipient: "0x" + "1c".repeat(32),
  aztecToken: "0x" + "2b".repeat(32),
  descriptorDigest: "0x" + "d5".repeat(32),
  corridorId: "0x" + "c0".repeat(32),
  corridorRevision: "1",
  manifestDigest: "0x" + "4d".repeat(32),
  nonce: "0x" + "0e".repeat(32),
  challengeExpiry: "1900000000",
  purpose: PURPOSE,
};

const BINDING_CASES: {
  name: string;
  environment: string;
  network: Network;
  binding: Binding;
  wallet: ethers.Wallet;
}[] = [
  {
    name: "baseline",
    environment: "staging",
    network: NET_A,
    binding: BASE_BINDING,
    wallet: WALLET_0,
  },
  {
    name: "other-environment",
    environment: "production",
    network: NET_A,
    binding: BASE_BINDING,
    wallet: WALLET_0,
  },
  {
    name: "redeployed-rollup",
    environment: "staging",
    network: NET_B,
    binding: BASE_BINDING,
    wallet: WALLET_0,
  },
  {
    name: "other-source-chain",
    environment: "staging",
    network: NET_A,
    binding: { ...BASE_BINDING, sourceChainId: "1" },
    wallet: WALLET_0,
  },
  {
    name: "next-corridor-revision",
    environment: "staging",
    network: NET_A,
    binding: { ...BASE_BINDING, corridorRevision: "2", manifestDigest: "0x" + "4e".repeat(32) },
    wallet: WALLET_0,
  },
  {
    name: "second-source-wallet",
    environment: "staging",
    network: NET_A,
    binding: { ...BASE_BINDING, sourceWallet: ADDR_1, nonce: "0x" + "0f".repeat(32) },
    wallet: WALLET_1,
  },
  {
    name: "boundary-values",
    environment: "staging",
    network: NET_MAX,
    binding: {
      ...BASE_BINDING,
      sourceChainId: UINT256_MAX.toString(),
      aztecRecipient: hex32(P - 1n),
      aztecToken: hex32(1n),
      corridorRevision: UINT32_MAX.toString(),
      nonce: "0x" + "ff".repeat(32),
      challengeExpiry: UINT64_MAX.toString(),
    },
    wallet: WALLET_0,
  },
];

const bindingVectors = await Promise.all(
  BINDING_CASES.map(async ({ name, environment, network, binding, wallet }) => {
    // Domain (binding)'s chainId is the source chain.
    const domain = domainFor(BINDING_DOMAIN_NAME, binding.sourceChainId, environment, network);
    const digest = ethers.TypedDataEncoder.hash(domain, BINDING_TYPES, binding);
    const signature = ethers.Signature.from(
      await wallet.signTypedData(domain, BINDING_TYPES, binding),
    ).serialized;
    if (ethers.recoverAddress(digest, signature).toLowerCase() !== binding.sourceWallet) {
      throw new Error(`${name}: signature does not recover sourceWallet`);
    }
    return {
      name,
      environment,
      network,
      domain,
      message: binding,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
      structHash: ethers.TypedDataEncoder.hashStruct("RecipientBinding", BINDING_TYPES, binding),
      digest,
      signer: wallet.address.toLowerCase(),
      signature,
    };
  }),
);

// --- Refusals: expectations are DATA, written from §7's rules ----------------------------
//
// Rules (codes are encoding-level, not the enrollment wire classes):
//   not_bytes32               not 0x + 64 hex
//   aztec_zero                Aztec value (bytes32, or uint256 Aztec chain id / version) is 0
//   aztec_out_of_field        Aztec value >= BN254 r
//   amount_not_canonical      not a canonical decimal (no sign/leading zero/space/exponent)
//   amount_zero / amount_over_max   0, or > 2^128 - 1
//   not_evm_address / evm_address_zero
//   uint_not_canonical / uint_out_of_range   uint32/uint64 member outside its type
//   chain_id_zero             a chain id of 0 (no virtual-chain stand-in)
//   environment_empty / digest_zero (genesisOrNetworkDigest) / purpose_mismatch

// Magnitude does not police provenance (header), so a value no larger than an EVM address
// is accepted like any other nonzero in-field value.
const aztecAccepted = [
  { name: "fixture-recipient", value: BASE_BINDING.aztecRecipient },
  { name: "fixture-token", value: BASE_BINDING.aztecToken },
  { name: "one", value: hex32(1n) },
  { name: "evm-address-sized", value: paddedEvm(ADDR_1) },
  { name: "largest-below-2^160", value: hex32(2n ** 160n - 1n) },
  { name: "largest-in-field", value: hex32(P - 1n) },
];
const aztecRefused = [
  { name: "zero", value: hex32(0n), error: "aztec_zero" },
  { name: "field-modulus", value: hex32(P), error: "aztec_out_of_field" },
  { name: "all-ones", value: hex32(UINT256_MAX), error: "aztec_out_of_field" },
  { name: "no-0x-prefix", value: "1c".repeat(32), error: "not_bytes32" },
  { name: "31-bytes", value: "0x" + "1c".repeat(31), error: "not_bytes32" },
  { name: "33-bytes", value: "0x" + "1c".repeat(33), error: "not_bytes32" },
  { name: "non-hex", value: "0x" + "zz".repeat(32), error: "not_bytes32" },
];

const amountAccepted = [
  { name: "one", value: "1" },
  { name: "six-decimal-unit", value: "1000000" },
  { name: "max", value: AMOUNT_MAX.toString() },
];
const amountRefused = [
  { name: "zero", value: "0", error: "amount_zero" },
  { name: "max-plus-one", value: (AMOUNT_MAX + 1n).toString(), error: "amount_over_max" },
  { name: "uint256-max", value: UINT256_MAX.toString(), error: "amount_over_max" },
  { name: "leading-zero", value: "01", error: "amount_not_canonical" },
  { name: "double-zero", value: "00", error: "amount_not_canonical" },
  { name: "negative", value: "-1", error: "amount_not_canonical" },
  { name: "plus-sign", value: "+1", error: "amount_not_canonical" },
  { name: "fraction", value: "1.0", error: "amount_not_canonical" },
  { name: "exponent", value: "1e3", error: "amount_not_canonical" },
  { name: "hex", value: "0x10", error: "amount_not_canonical" },
  { name: "leading-space", value: " 1", error: "amount_not_canonical" },
  { name: "trailing-space", value: "1 ", error: "amount_not_canonical" },
  { name: "empty", value: "", error: "amount_not_canonical" },
];

// Each case differs from the baseline in exactly ONE input, so its expected code does
// not depend on the order an implementation runs its checks in.
const bindingRefusals = (
  [
    {
      name: "token-zero",
      binding: { aztecToken: hex32(0n) },
      error: { code: "aztec_zero", field: "aztecToken" },
    },
    {
      name: "recipient-field-modulus",
      binding: { aztecRecipient: hex32(P) },
      error: { code: "aztec_out_of_field", field: "aztecRecipient" },
    },
    {
      name: "purpose-other-version",
      binding: { purpose: "xochi.shielded.recipient-binding.v2" },
      error: { code: "purpose_mismatch", field: "purpose" },
    },
    {
      name: "corridor-revision-over-uint32",
      binding: { corridorRevision: (UINT32_MAX + 1n).toString() },
      error: { code: "uint_out_of_range", field: "corridorRevision" },
    },
    {
      name: "challenge-expiry-over-uint64",
      binding: { challengeExpiry: (UINT64_MAX + 1n).toString() },
      error: { code: "uint_out_of_range", field: "challengeExpiry" },
    },
    {
      name: "source-chain-zero",
      binding: { sourceChainId: "0" },
      error: { code: "chain_id_zero", field: "sourceChainId" },
    },
    {
      name: "source-wallet-zero",
      binding: { sourceWallet: "0x" + "00".repeat(20) },
      error: { code: "evm_address_zero", field: "sourceWallet" },
    },
    {
      name: "source-wallet-not-20-bytes",
      binding: { sourceWallet: "0x" + "f3".repeat(19) },
      error: { code: "not_evm_address", field: "sourceWallet" },
    },
    {
      name: "descriptor-digest-not-bytes32",
      binding: { descriptorDigest: "0x" + "d5".repeat(20) },
      error: { code: "not_bytes32", field: "descriptorDigest" },
    },
    {
      name: "environment-empty",
      environment: "",
      error: { code: "environment_empty", field: "environment" },
    },
    {
      name: "network-aztec-chain-zero",
      network: { aztecChainId: "0" },
      error: { code: "aztec_zero", field: "network.aztecChainId" },
    },
    {
      name: "network-protocol-version-field-modulus",
      network: { protocolVersion: P.toString() },
      error: { code: "aztec_out_of_field", field: "network.protocolVersion" },
    },
    {
      name: "network-rollup-zero",
      network: { rollupAddress: "0x" + "00".repeat(20) },
      error: { code: "evm_address_zero", field: "network.rollupAddress" },
    },
    {
      name: "network-l1-chain-zero",
      network: { l1ChainId: "0" },
      error: { code: "chain_id_zero", field: "network.l1ChainId" },
    },
    {
      name: "network-genesis-digest-zero",
      network: { genesisOrNetworkDigest: hex32(0n) },
      error: { code: "digest_zero", field: "network.genesisOrNetworkDigest" },
    },
  ] as {
    name: string;
    environment?: string;
    network?: Partial<Network>;
    binding?: Partial<Binding>;
    error: { code: string; field: string };
  }[]
).map((c) => ({
  name: c.name,
  environment: c.environment ?? "staging",
  network: { ...NET_A, ...c.network },
  message: { ...BASE_BINDING, ...c.binding },
  error: c.error,
}));

// --- Output ------------------------------------------------------------------------------

const out = {
  version: 1,
  generator: "packages/spec/conformance/generate-shielded.ts",
  source:
    'xochi docs/planning/shielded-execution.md §7 "Approved 2026-10-18: typed encodings" (xochi#633, xochi#635)',
  constants: {
    aztecFieldModulus: P.toString(),
    amountMax: AMOUNT_MAX.toString(),
    domainVersion: DOMAIN_VERSION,
    bindingDomainName: BINDING_DOMAIN_NAME,
    termsDomainName: TERMS_DOMAIN_NAME,
    purpose: PURPOSE,
  },
  domain: { typeString: DOMAIN_TYPE_STRING, typehash: ethers.id(DOMAIN_TYPE_STRING) },
  networkIdentity: {
    approved:
      "2026-10-19 by the product owner, protocolVersion = numeric Aztec rollup version; the §7 record lands in a separate xochi PR",
    typeString: NETWORK_IDENTITY_TYPE_STRING,
    typehash: ethers.id(NETWORK_IDENTITY_TYPE_STRING),
    vectors: networkVectors,
  },
  domains: domainVectors,
  recipientBinding: {
    typeString: RECIPIENT_BINDING_TYPE_STRING,
    typehash: ethers.id(RECIPIENT_BINDING_TYPE_STRING),
    signerIsTestKey: true,
    vectors: bindingVectors,
    refusals: bindingRefusals,
  },
  values: {
    aztecBytes32: { accepted: aztecAccepted, refused: aztecRefused },
    amount: { accepted: amountAccepted, refused: amountRefused },
  },
  open: [
    {
      item: "ShieldedTermsV1",
      reason:
        "§7 fixes the terms domain only. The struct's member names and types, its nesting of source/destination/network/corridor, and the fee_breakdown typed shape are not fixed.",
    },
    {
      item: "manifestDigest",
      reason:
        "§7 lists the manifest identity fields but not their typed encoding; manifestDigest is an opaque bytes32 input here.",
    },
    {
      item: "descriptorDigest",
      reason: "Its encoding is open (§7 'Still open'); it is an opaque bytes32 input here.",
    },
    {
      item: "recipientMessage",
      reason:
        "The recipient message wrapper, its 256-bit-to-field reduction and the acknowledgement structs are open (§7). Selecting the recipient account class (§7 'Recipient authorization') is a prerequisite, not their specification.",
    },
  ],
};

// --- Schema ------------------------------------------------------------------------------

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
// Refusal inputs are the refused values themselves, so they are not shape-constrained.
const MESSAGE_LOOSE = obj(
  Object.fromEntries(BINDING_TYPES.RecipientBinding.map((m) => [m.name, STR])),
);
const NETWORK_LOOSE = obj(
  Object.fromEntries(NETWORK_TYPES.NetworkIdentity.map((m) => [m.name, STR])),
);
const REFUSAL_CODE = {
  enum: [
    "not_bytes32",
    "aztec_zero",
    "aztec_out_of_field",
    "amount_not_canonical",
    "amount_zero",
    "amount_over_max",
    "not_evm_address",
    "evm_address_zero",
    "uint_not_canonical",
    "uint_out_of_range",
    "chain_id_zero",
    "environment_empty",
    "digest_zero",
    "purpose_mismatch",
  ],
};
const OPEN_ITEM = obj({ item: STR, reason: STR });

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://xochi.fi/spec/conformance/shielded.schema.json",
  title: "Shielded settlement contract v1 typed-encoding vector set",
  description:
    "NetworkIdentity hashStruct, the salted Domain (binding) / Domain (terms), the RecipientBinding " +
    "struct hash, EIP-712 digest and source-wallet signature (public test keys), and the value refusals " +
    "(xochi shielded-execution.md §7, approved 2026-10-18; NetworkIdentity encoding approved 2026-10-19). " +
    "Generated from §7 literals with ethers primitives, independently of @xochi/signer. uint values are " +
    "decimal strings; bytes/addresses lowercase hex. Every refusal case differs from the baseline in " +
    "exactly one input, so its expected code is independent of check order. Network, corridor and Aztec " +
    "values are fixtures.",
  ...obj({
    version: { const: 1 },
    generator: STR,
    source: STR,
    constants: obj({
      aztecFieldModulus: UINT,
      amountMax: UINT,
      domainVersion: { const: "1" },
      bindingDomainName: { const: "Xochi Shielded Recipient" },
      termsDomainName: { const: "Xochi Shielded Terms" },
      purpose: { const: "xochi.shielded.recipient-binding.v1" },
    }),
    domain: obj({ typeString: STR, typehash: HEX32 }),
    networkIdentity: obj({
      approved: STR,
      typeString: STR,
      typehash: HEX32,
      vectors: arr(obj({ name: STR, network: NETWORK, networkIdentityDigest: HEX32 })),
    }),
    domains: arr(
      obj({
        name: STR,
        environment: STR,
        network: NETWORK,
        chainId: UINT,
        networkIdentityDigest: HEX32,
        salt: HEX32,
        binding: obj({ domain: DOMAIN, domainSeparator: HEX32 }),
        terms: obj({ domain: DOMAIN, domainSeparator: HEX32 }),
      }),
    ),
    recipientBinding: obj({
      typeString: STR,
      typehash: HEX32,
      signerIsTestKey: { const: true },
      vectors: arr(
        obj({
          name: STR,
          environment: STR,
          network: NETWORK,
          domain: DOMAIN,
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
            purpose: { const: "xochi.shielded.recipient-binding.v1" },
          }),
          domainSeparator: HEX32,
          structHash: HEX32,
          digest: HEX32,
          signer: ADDR,
          signature: SIG,
        }),
      ),
      refusals: arr(
        obj({
          name: STR,
          environment: STR,
          network: NETWORK_LOOSE,
          message: MESSAGE_LOOSE,
          error: obj({ code: REFUSAL_CODE, field: STR }),
        }),
      ),
    }),
    values: obj({
      aztecBytes32: obj({
        accepted: arr(obj({ name: STR, value: HEX32 })),
        refused: arr(obj({ name: STR, value: STR, error: REFUSAL_CODE })),
      }),
      amount: obj({
        accepted: arr(obj({ name: STR, value: UINT })),
        refused: arr(obj({ name: STR, value: STR, error: REFUSAL_CODE })),
      }),
    }),
    open: arr(OPEN_ITEM),
  }),
};

const dir = process.env.SHIELDED_VECTORS_DIR ?? path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(dir, "shielded.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(path.join(dir, "shielded.schema.json"), JSON.stringify(schema, null, 2) + "\n");
console.log(
  `wrote shielded.json: ${networkVectors.length} networks, ` +
    `${domainVectors.length} domains, ${bindingVectors.length} bindings, ` +
    `${bindingRefusals.length} binding refusals`,
);
for (const v of bindingVectors) console.log(`  ${v.name.padEnd(28)} ${v.digest}`);
