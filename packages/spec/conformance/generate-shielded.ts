#!/usr/bin/env node
// Generates `conformance/shielded.json` (+ `shielded.schema.json`): the vector set for
// the recipient-private Aztec settlement contract v1 typed encodings approved on
// 2026-10-18 (xochi docs/planning/shielded-execution.md §7 "Approved 2026-10-18: typed
// encodings"; xochi#633, xochi#635): the NetworkIdentity hashStruct, the salted
// `Domain (binding)` / `Domain (terms)`, the RecipientBinding struct hash, EIP-712
// digest and source-wallet signature, and the value refusals (Aztec bytes32, amounts).
//
// `@xochi/signer` (src/shielded.ts) is the REFERENCE. Riddler and the Xochi Worker
// vendor this file and must reproduce every value; they never compute their own
// expectations. ShieldedTermsV1, the manifestDigest struct, the descriptorDigest
// encoding and the recipient message wrapper/acknowledgements are NOT here: §7 leaves
// them open, and `open` in the output names each one.
//
// Every network, corridor, digest and Aztec value below is a FIXTURE. No Aztec network,
// corridor manifest or token is pinned by this file (manifest revision 1 is open).
// The signer keys are the PUBLIC Hardhat/Anvil test keys #0 and #1: known to everyone,
// never to hold funds.
//
// Run: npm run generate:shielded   (SHIELDED_VECTORS_DIR overrides the output dir)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

import {
  AZTEC_FIELD_MODULUS,
  NETWORK_IDENTITY_TYPEHASH,
  NETWORK_IDENTITY_TYPE_STRING,
  RECIPIENT_BINDING_PURPOSE,
  RECIPIENT_BINDING_TYPEHASH,
  RECIPIENT_BINDING_TYPE_STRING,
  SHIELDED_AMOUNT_MAX,
  SHIELDED_BINDING_DOMAIN_NAME,
  SHIELDED_DOMAIN_TYPEHASH,
  SHIELDED_DOMAIN_TYPE_STRING,
  SHIELDED_DOMAIN_VERSION,
  SHIELDED_TERMS_DOMAIN_NAME,
  ShieldedEncodingError,
  assertAztecBytes32,
  bindingDomain,
  hashNetworkIdentity,
  hashRecipientBinding,
  parseShieldedAmount,
  recipientBindingDigest,
  shieldedDomainSalt,
  shieldedDomainSeparator,
  termsDomain,
  type NetworkIdentity,
  type RecipientBinding,
} from "@xochi/signer";

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #0 and #1). NOT SECRET. NEVER USE.
const TEST_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WALLET_0 = new ethers.Wallet(TEST_KEY_0);
const WALLET_1 = new ethers.Wallet(TEST_KEY_1);
const ADDR_0 = WALLET_0.address.toLowerCase();
const ADDR_1 = WALLET_1.address.toLowerCase();

const hex32 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const P = AZTEC_FIELD_MODULUS;
const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

// --- Networks (FIXTURES) -----------------------------------------------------

const NET_A: NetworkIdentity = {
  aztecChainId: "11155111",
  protocolVersion: "3924331020",
  rollupAddress: "0x" + "a1".repeat(20),
  l1ChainId: "11155111",
  genesisOrNetworkDigest: "0x" + "9e".repeat(32),
};
// Same network but a redeployed rollup: a different identity.
const NET_B: NetworkIdentity = { ...NET_A, rollupAddress: "0x" + "a2".repeat(20) };
// Every member at its largest admissible value.
const NET_MAX: NetworkIdentity = {
  aztecChainId: (P - 1n).toString(),
  protocolVersion: (P - 1n).toString(),
  rollupAddress: "0x" + "ff".repeat(20),
  l1ChainId: UINT256_MAX.toString(),
  genesisOrNetworkDigest: "0x" + "ff".repeat(32),
};

const NETWORKS: { name: string; network: NetworkIdentity }[] = [
  { name: "fixture-a", network: NET_A },
  { name: "fixture-a-redeployed-rollup", network: NET_B },
  { name: "max-members", network: NET_MAX },
];

const networkJson = (n: NetworkIdentity) => ({
  aztecChainId: String(n.aztecChainId),
  protocolVersion: String(n.protocolVersion),
  rollupAddress: n.rollupAddress.toLowerCase(),
  l1ChainId: String(n.l1ChainId),
  genesisOrNetworkDigest: n.genesisOrNetworkDigest.toLowerCase(),
});

const networkVectors = NETWORKS.map(({ name, network }) => ({
  name,
  network: networkJson(network),
  networkIdentityDigest: hashNetworkIdentity(network),
}));

// --- Domains -------------------------------------------------------------------

type DomainCase = {
  name: string;
  environment: string;
  network: NetworkIdentity;
  chainId: string;
};
const DOMAIN_CASES: DomainCase[] = [
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
];

const domainVectors = DOMAIN_CASES.map((c) => {
  const binding = bindingDomain(c.chainId, c.environment, c.network);
  const terms = termsDomain(c.chainId, c.environment, c.network);
  return {
    name: c.name,
    environment: c.environment,
    network: networkJson(c.network),
    chainId: c.chainId,
    networkIdentityDigest: hashNetworkIdentity(c.network),
    salt: shieldedDomainSalt(c.environment, c.network),
    binding: { domain: binding, domainSeparator: shieldedDomainSeparator(binding) },
    terms: { domain: terms, domainSeparator: shieldedDomainSeparator(terms) },
  };
});

// --- RecipientBinding ------------------------------------------------------------

const AZTEC_RECIPIENT = "0x" + "1c".repeat(32);
const AZTEC_TOKEN = "0x" + "2b".repeat(32);

const BASE_BINDING: RecipientBinding = {
  sourceWallet: ADDR_0,
  sourceChainId: "84532",
  aztecRecipient: AZTEC_RECIPIENT,
  aztecToken: AZTEC_TOKEN,
  descriptorDigest: "0x" + "d5".repeat(32),
  corridorId: "0x" + "c0".repeat(32),
  corridorRevision: "1",
  manifestDigest: "0x" + "4d".repeat(32),
  nonce: "0x" + "0e".repeat(32),
  challengeExpiry: "1900000000",
  purpose: RECIPIENT_BINDING_PURPOSE,
};

const bindingJson = (b: RecipientBinding) => ({
  sourceWallet: b.sourceWallet.toLowerCase(),
  sourceChainId: String(b.sourceChainId),
  aztecRecipient: b.aztecRecipient.toLowerCase(),
  aztecToken: b.aztecToken.toLowerCase(),
  descriptorDigest: b.descriptorDigest.toLowerCase(),
  corridorId: b.corridorId.toLowerCase(),
  corridorRevision: String(b.corridorRevision),
  manifestDigest: b.manifestDigest.toLowerCase(),
  nonce: b.nonce.toLowerCase(),
  challengeExpiry: String(b.challengeExpiry),
  purpose: b.purpose,
});

// ethers' generic encoder: used here only to refuse to write a vector the reference and
// an independent implementation disagree on.
const ETHERS_BINDING_TYPES = {
  RecipientBinding: RECIPIENT_BINDING_TYPE_STRING.slice("RecipientBinding(".length, -1)
    .split(",")
    .map((m) => {
      const [type, name] = m.split(" ");
      return { name: name!, type: type! };
    }),
};

type BindingCase = {
  name: string;
  environment: string;
  network: NetworkIdentity;
  binding: RecipientBinding;
  wallet: ethers.Wallet;
};
const BINDING_CASES: BindingCase[] = [
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
      aztecToken: hex32(2n ** 160n),
      corridorRevision: UINT32_MAX.toString(),
      nonce: "0x" + "ff".repeat(32),
      challengeExpiry: UINT64_MAX.toString(),
    },
    wallet: WALLET_0,
  },
];

const bindingVectors = await Promise.all(
  BINDING_CASES.map(async ({ name, environment, network, binding, wallet }) => {
    const domain = bindingDomain(binding.sourceChainId, environment, network);
    const message = bindingJson(binding);
    const digest = recipientBindingDigest(binding, environment, network);
    const independent = ethers.TypedDataEncoder.hash(domain, ETHERS_BINDING_TYPES, message);
    if (independent !== digest) throw new Error(`${name}: reference digest disagrees with ethers`);
    const signature = ethers.Signature.from(
      await wallet.signTypedData(domain, ETHERS_BINDING_TYPES, message),
    ).serialized;
    if (ethers.recoverAddress(digest, signature).toLowerCase() !== message.sourceWallet) {
      throw new Error(`${name}: signature does not recover sourceWallet`);
    }
    return {
      name,
      environment,
      network: networkJson(network),
      domain,
      message,
      domainSeparator: shieldedDomainSeparator(domain),
      structHash: hashRecipientBinding(binding),
      digest,
      signer: wallet.address.toLowerCase(),
      signature,
    };
  }),
);

// --- Refusals ------------------------------------------------------------------------

function refusalOf(fn: () => unknown): { code: string; field: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ShieldedEncodingError) return { code: e.code, field: e.field };
    throw e;
  }
  throw new Error("expected a refusal, got none");
}

const paddedEvm = (addr: string) => ethers.zeroPadValue(addr, 32).toLowerCase();

const aztecAccepted = [
  { name: "fixture-recipient", value: AZTEC_RECIPIENT },
  { name: "fixture-token", value: AZTEC_TOKEN },
  { name: "smallest-not-evm-shaped", value: hex32(2n ** 160n) },
  { name: "largest-in-field", value: hex32(P - 1n) },
].map((c) => ({ ...c, value: assertAztecBytes32("value", c.value) }));

const aztecRefused = [
  { name: "zero", value: hex32(0n) },
  { name: "one", value: hex32(1n) },
  { name: "padded-evm-address", value: paddedEvm(ADDR_1) },
  { name: "largest-evm-shaped", value: hex32(2n ** 160n - 1n) },
  { name: "field-modulus", value: hex32(P) },
  { name: "all-ones", value: hex32(UINT256_MAX) },
  { name: "no-0x-prefix", value: "1c".repeat(32) },
  { name: "31-bytes", value: "0x" + "1c".repeat(31) },
  { name: "33-bytes", value: "0x" + "1c".repeat(33) },
  { name: "non-hex", value: "0x" + "zz".repeat(32) },
].map((c) => ({ ...c, error: refusalOf(() => assertAztecBytes32("value", c.value)).code }));

const amountAccepted = [
  { name: "one", value: "1" },
  { name: "six-decimal-unit", value: "1000000" },
  { name: "max", value: SHIELDED_AMOUNT_MAX.toString() },
].map((c) => ({ ...c, parsed: parseShieldedAmount("amount", c.value).toString() }));

const amountRefused = [
  { name: "zero", value: "0" },
  { name: "max-plus-one", value: (SHIELDED_AMOUNT_MAX + 1n).toString() },
  { name: "uint256-max", value: UINT256_MAX.toString() },
  { name: "leading-zero", value: "01" },
  { name: "double-zero", value: "00" },
  { name: "negative", value: "-1" },
  { name: "plus-sign", value: "+1" },
  { name: "fraction", value: "1.0" },
  { name: "exponent", value: "1e3" },
  { name: "hex", value: "0x10" },
  { name: "leading-space", value: " 1" },
  { name: "trailing-space", value: "1 " },
  { name: "empty", value: "" },
].map((c) => ({ ...c, error: refusalOf(() => parseShieldedAmount("amount", c.value)).code }));

// Each case differs from the baseline in exactly ONE input, so its expected code does
// not depend on the order an implementation runs its checks in.
type BindingRefusalCase = {
  name: string;
  environment?: string;
  network?: Partial<NetworkIdentity>;
  binding?: Partial<RecipientBinding>;
};
const BINDING_REFUSAL_CASES: BindingRefusalCase[] = [
  { name: "recipient-is-padded-source-wallet", binding: { aztecRecipient: paddedEvm(ADDR_0) } },
  { name: "token-is-padded-evm-address", binding: { aztecToken: paddedEvm(ADDR_1) } },
  { name: "token-zero", binding: { aztecToken: hex32(0n) } },
  { name: "recipient-field-modulus", binding: { aztecRecipient: hex32(P) } },
  { name: "purpose-other-version", binding: { purpose: "xochi.shielded.recipient-binding.v2" } },
  {
    name: "corridor-revision-over-uint32",
    binding: { corridorRevision: (UINT32_MAX + 1n).toString() },
  },
  {
    name: "challenge-expiry-over-uint64",
    binding: { challengeExpiry: (UINT64_MAX + 1n).toString() },
  },
  { name: "source-chain-zero", binding: { sourceChainId: "0" } },
  { name: "source-wallet-zero", binding: { sourceWallet: "0x" + "00".repeat(20) } },
  { name: "source-wallet-not-20-bytes", binding: { sourceWallet: "0x" + "f3".repeat(19) } },
  { name: "descriptor-digest-not-bytes32", binding: { descriptorDigest: "0x" + "d5".repeat(20) } },
  { name: "environment-empty", environment: "" },
  { name: "network-aztec-chain-zero", network: { aztecChainId: "0" } },
  { name: "network-protocol-version-field-modulus", network: { protocolVersion: P.toString() } },
  { name: "network-rollup-zero", network: { rollupAddress: "0x" + "00".repeat(20) } },
  { name: "network-l1-chain-zero", network: { l1ChainId: "0" } },
  { name: "network-genesis-digest-zero", network: { genesisOrNetworkDigest: hex32(0n) } },
];

const bindingRefusals = BINDING_REFUSAL_CASES.map((c) => {
  const environment = c.environment ?? "staging";
  const network = { ...NET_A, ...c.network };
  const binding = { ...BASE_BINDING, ...c.binding };
  return {
    name: c.name,
    environment,
    network: networkJson(network),
    message: bindingJson(binding),
    error: refusalOf(() => recipientBindingDigest(binding, environment, network)),
  };
});

// --- Output ----------------------------------------------------------------------------

const out = {
  version: 1,
  generator: "packages/spec/conformance/generate-shielded.ts",
  source:
    'xochi docs/planning/shielded-execution.md §7 "Approved 2026-10-18: typed encodings" (xochi#633, xochi#635)',
  constants: {
    aztecFieldModulus: P.toString(),
    amountMax: SHIELDED_AMOUNT_MAX.toString(),
    domainVersion: SHIELDED_DOMAIN_VERSION,
    bindingDomainName: SHIELDED_BINDING_DOMAIN_NAME,
    termsDomainName: SHIELDED_TERMS_DOMAIN_NAME,
    purpose: RECIPIENT_BINDING_PURPOSE,
  },
  domain: { typeString: SHIELDED_DOMAIN_TYPE_STRING, typehash: SHIELDED_DOMAIN_TYPEHASH },
  networkIdentity: {
    typeString: NETWORK_IDENTITY_TYPE_STRING,
    typehash: NETWORK_IDENTITY_TYPEHASH,
    vectors: networkVectors,
  },
  domains: domainVectors,
  recipientBinding: {
    typeString: RECIPIENT_BINDING_TYPE_STRING,
    typehash: RECIPIENT_BINDING_TYPEHASH,
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
        "The recipient message wrapper, its 256-bit-to-field reduction and the acknowledgement structs wait on the recipient account class (§7).",
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
const MESSAGE_LOOSE = obj({
  sourceWallet: STR,
  sourceChainId: STR,
  aztecRecipient: STR,
  aztecToken: STR,
  descriptorDigest: STR,
  corridorId: STR,
  corridorRevision: STR,
  manifestDigest: STR,
  nonce: STR,
  challengeExpiry: STR,
  purpose: STR,
});
const NETWORK_LOOSE = obj({
  aztecChainId: STR,
  protocolVersion: STR,
  rollupAddress: STR,
  l1ChainId: STR,
  genesisOrNetworkDigest: STR,
});
const REFUSAL_CODE = {
  enum: [
    "not_bytes32",
    "aztec_zero",
    "aztec_out_of_field",
    "aztec_padded_evm_address",
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

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://xochi.fi/spec/conformance/shielded.schema.json",
  title: "Shielded settlement contract v1 typed-encoding vector set",
  description:
    "NetworkIdentity hashStruct, the salted Domain (binding) / Domain (terms), the RecipientBinding " +
    "struct hash, EIP-712 digest and source-wallet signature (public test keys), and the value refusals " +
    "(xochi shielded-execution.md §7, approved 2026-10-18). Reference: @xochi/signer. uint values are " +
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
        accepted: arr(obj({ name: STR, value: UINT, parsed: UINT })),
        refused: arr(obj({ name: STR, value: STR, error: REFUSAL_CODE })),
      }),
    }),
    open: arr(obj({ item: STR, reason: STR })),
  }),
};

const dir = process.env.SHIELDED_VECTORS_DIR ?? path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(dir, "shielded.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(path.join(dir, "shielded.schema.json"), JSON.stringify(schema, null, 2) + "\n");
console.log(
  `wrote shielded.json: ${networkVectors.length} networks, ${domainVectors.length} domains, ` +
    `${bindingVectors.length} bindings, ${bindingRefusals.length} binding refusals`,
);
for (const v of bindingVectors) console.log(`  ${v.name.padEnd(28)} ${v.digest}`);
