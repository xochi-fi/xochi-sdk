#!/usr/bin/env node
// Generates `conformance/slash-attestation.json`: vectors for SolverBond's EIP-712
// SlashAttestation (ESCROW-RFC §6), domain RiddlerSolverBond/2, over the fields of
// `SolverBond.SlashClaim` in declaration order. Signatures are 65-byte r||s||v, low-s.
//
// The signer keys below are the PUBLIC Hardhat/Anvil TEST keys. They are known to
// everyone and MUST NEVER hold funds or be registered as a slash attester.
//
// Run: npm run generate:slash-attestation

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

import {
  signSlashAttestation,
  SLASH_ATTESTATION_DOMAIN_NAME,
  SLASH_ATTESTATION_DOMAIN_VERSION,
  SLASH_ATTESTATION_TYPEHASH,
  slashAttestationDigest,
  slashAttestationDomainSeparator,
  slashAttestationStructHash,
} from "@xochi/signer";

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #0 and #1). NOT SECRET. NEVER USE.
const TEST_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const here = path.dirname(fileURLToPath(import.meta.url));
const orderIds = JSON.parse(fs.readFileSync(path.join(here, "order-id.json"), "utf8")).vectors;
const baselineOrderId: string = orderIds.find((v: { name: string }) => v.name === "baseline-evm-usdc").expected_order_id;

const BOND = "0x6666666666666666666666666666666666666666";
const SOLVER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BENEFICIARY = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ESCROW = "0x3333333333333333333333333333333333333333";
const MAX = (2n ** 256n - 1n).toString();

const base = { orderId: baselineOrderId, solver: SOLVER, beneficiary: BENEFICIARY, notional: "1000000", originChainId: "8453", escrow: ESCROW, deadline: "1900000000" };

const CASES = [
  { name: "baseline-base", chainId: "8453", verifyingContract: BOND, claim: base, key: TEST_KEY_0 },
  { name: "second-signer", chainId: "8453", verifyingContract: BOND, claim: base, key: TEST_KEY_1 },
  { name: "other-chain-and-bond", chainId: "1", verifyingContract: "0x9A676e781A523b5d0C0e43731313A708CB607508", claim: { ...base, originChainId: "1", escrow: "0x9A676e781A523b5d0C0e43731313A708CB607508" }, key: TEST_KEY_0 },
  { name: "zero-notional-zero-deadline", chainId: "8453", verifyingContract: BOND, claim: { ...base, orderId: "0x" + "00".repeat(31) + "01", notional: "0", deadline: "0" }, key: TEST_KEY_0 },
  { name: "max-uint256-values", chainId: "42161", verifyingContract: BOND, claim: { orderId: "0x" + "ff".repeat(32), solver: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF", beneficiary: BENEFICIARY, notional: MAX, originChainId: MAX, escrow: ESCROW, deadline: MAX }, key: TEST_KEY_1 },
];

const vectors = [];
for (const c of CASES) {
  const domain = { chainId: c.chainId, verifyingContract: c.verifyingContract };
  vectors.push({
    name: c.name,
    chainId: c.chainId,
    verifyingContract: c.verifyingContract,
    claim: c.claim,
    expected_struct_hash: slashAttestationStructHash(c.claim),
    expected_domain_separator: slashAttestationDomainSeparator(domain),
    expected_digest: slashAttestationDigest(domain, c.claim),
    signer_private_key: c.key,
    signer_address: new ethers.Wallet(c.key).address,
    expected_signature: (await signSlashAttestation(new ethers.Wallet(c.key), domain, c.claim)).toLowerCase(),
  });
}

const out = {
  $schema: "./slash-attestation.schema.json",
  description:
    "EIP-712 SlashAttestation(bytes32 orderId,address solver,address beneficiary,uint256 notional," +
    "uint256 originChainId,address escrow,uint256 deadline) vectors for SolverBond. signer_private_key " +
    "values are PUBLIC Hardhat/Anvil TEST keys: never fund or register them.",
  domain: { name: SLASH_ATTESTATION_DOMAIN_NAME, version: SLASH_ATTESTATION_DOMAIN_VERSION },
  typehash: SLASH_ATTESTATION_TYPEHASH,
  vectors,
};

const target = path.join(here, "slash-attestation.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
