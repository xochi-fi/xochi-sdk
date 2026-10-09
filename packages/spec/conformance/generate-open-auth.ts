#!/usr/bin/env node
// Generates `conformance/open-auth.json`: vectors for the venue's EIP-712 OpenAuth
// over an orderId (ESCROW-RFC §12). RiddlerEscrow verifies this signature in
// `_lock`; the Riddler server produces it. Signatures are 65-byte r||s||v, low-s.
//
// The signer keys below are the PUBLIC Hardhat/Anvil TEST keys. They are known to
// everyone and MUST NEVER hold funds or be registered as an OpenAuth signer.
//
// Run: npm run generate:open-auth

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

import {
  OPEN_AUTH_DOMAIN_NAME,
  OPEN_AUTH_DOMAIN_VERSION,
  OPEN_AUTH_TYPEHASH,
  openAuthDigest,
  openAuthDomainSeparator,
  openAuthStructHash,
  signOpenAuth,
} from "@xochi/signer";

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #0 and #1). NOT SECRET. NEVER USE.
const TEST_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const orderIds = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "order-id.json"), "utf8"),
).vectors;
const baselineOrderId: string = orderIds.find((v: { name: string }) => v.name === "baseline-evm-usdc").expected_order_id;

const CASES = [
  { name: "baseline-base", chainId: "8453", verifyingContract: "0x3333333333333333333333333333333333333333", orderId: baselineOrderId, expiry: "1900000000", key: TEST_KEY_0 },
  { name: "second-signer", chainId: "8453", verifyingContract: "0x3333333333333333333333333333333333333333", orderId: baselineOrderId, expiry: "1900000000", key: TEST_KEY_1 },
  { name: "other-chain-and-escrow", chainId: "1", verifyingContract: "0x9A676e781A523b5d0C0e43731313A708CB607508", orderId: baselineOrderId, expiry: "1900000000", key: TEST_KEY_0 },
  { name: "zero-expiry", chainId: "8453", verifyingContract: "0x3333333333333333333333333333333333333333", orderId: "0x" + "00".repeat(31) + "01", expiry: "0", key: TEST_KEY_0 },
  { name: "max-uint256-expiry-high-bit-order", chainId: "42161", verifyingContract: "0x3333333333333333333333333333333333333333", orderId: "0x" + "ff".repeat(32), expiry: (2n ** 256n - 1n).toString(), key: TEST_KEY_1 },
];

const vectors = [];
for (const c of CASES) {
  const domain = { chainId: c.chainId, verifyingContract: c.verifyingContract };
  vectors.push({
    name: c.name,
    chainId: c.chainId,
    verifyingContract: c.verifyingContract,
    orderId: c.orderId,
    expiry: c.expiry,
    expected_struct_hash: openAuthStructHash(c.orderId, c.expiry),
    expected_domain_separator: openAuthDomainSeparator(domain),
    expected_digest: openAuthDigest(domain, c.orderId, c.expiry),
    signer_private_key: c.key,
    signer_address: new ethers.Wallet(c.key).address,
    expected_signature: (await signOpenAuth(new ethers.Wallet(c.key), domain, c.orderId, c.expiry)).toLowerCase(),
  });
}

const out = {
  $schema: "./open-auth.schema.json",
  description:
    "EIP-712 OpenAuth(bytes32 orderId,uint256 expiry) vectors (ESCROW-RFC §12). " +
    "signer_private_key values are PUBLIC Hardhat/Anvil TEST keys: never fund or register them.",
  domain: { name: OPEN_AUTH_DOMAIN_NAME, version: OPEN_AUTH_DOMAIN_VERSION },
  typehash: OPEN_AUTH_TYPEHASH,
  vectors,
};

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "open-auth.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
