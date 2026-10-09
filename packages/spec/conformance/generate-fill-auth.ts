#!/usr/bin/env node
// Generates `conformance/fill-auth.json`: vectors for RiddlerFiller's EIP-712
// FillAuth (ESCROW-RFC §9.4), domain RiddlerFiller/1. The venue signs it; the
// filler presents it with `fill`. Signatures are 65-byte r||s||v, low-s.
//
// The signer keys below are the PUBLIC Hardhat/Anvil TEST keys. They are known to
// everyone and MUST NEVER hold funds or be registered as a fill authorizer.
//
// Run: npm run generate:fill-auth

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

import {
  FILL_AUTH_DOMAIN_NAME,
  FILL_AUTH_DOMAIN_VERSION,
  FILL_AUTH_TYPEHASH,
  fillAuthDigest,
  fillAuthDomainSeparator,
  fillAuthStructHash,
  signFillAuth,
} from "@xochi/signer";

// PUBLIC TEST KEYS (Hardhat/Anvil accounts #0 and #1). NOT SECRET. NEVER USE.
const TEST_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const here = path.dirname(fileURLToPath(import.meta.url));
const fillIds = JSON.parse(fs.readFileSync(path.join(here, "fill-salt.json"), "utf8")).vectors;
const baselineFillId: string = fillIds.find((v: { name: string }) => v.name === "baseline").expected_fill_id;

const FILLER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TO = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FILLER_CONTRACT = "0x4444444444444444444444444444444444444444";
const MAX = (2n ** 256n - 1n).toString();

const CASES = [
  { name: "baseline-base", chainId: "8453", verifyingContract: FILLER_CONTRACT, fillId: baselineFillId, filler: FILLER, to: TO, token: USDC_BASE, amount: "1000000", deadline: "1900000000", key: TEST_KEY_0 },
  { name: "second-signer", chainId: "8453", verifyingContract: FILLER_CONTRACT, fillId: baselineFillId, filler: FILLER, to: TO, token: USDC_BASE, amount: "1000000", deadline: "1900000000", key: TEST_KEY_1 },
  { name: "other-chain-and-filler", chainId: "1", verifyingContract: "0x9A676e781A523b5d0C0e43731313A708CB607508", fillId: baselineFillId, filler: FILLER, to: TO, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "1000000", deadline: "1900000000", key: TEST_KEY_0 },
  { name: "zero-amount-zero-deadline", chainId: "8453", verifyingContract: FILLER_CONTRACT, fillId: "0x" + "00".repeat(31) + "01", filler: FILLER, to: TO, token: USDC_BASE, amount: "0", deadline: "0", key: TEST_KEY_0 },
  { name: "max-uint256-amount-and-deadline", chainId: "42161", verifyingContract: FILLER_CONTRACT, fillId: "0x" + "ff".repeat(32), filler: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF", to: TO, token: USDC_BASE, amount: MAX, deadline: MAX, key: TEST_KEY_1 },
];

const vectors = [];
for (const c of CASES) {
  const { key, name, chainId, verifyingContract, ...auth } = c;
  const domain = { chainId, verifyingContract };
  vectors.push({
    name,
    chainId,
    verifyingContract,
    ...auth,
    expected_struct_hash: fillAuthStructHash(auth),
    expected_domain_separator: fillAuthDomainSeparator(domain),
    expected_digest: fillAuthDigest(domain, auth),
    signer_private_key: key,
    signer_address: new ethers.Wallet(key).address,
    expected_signature: (await signFillAuth(new ethers.Wallet(key), domain, auth)).toLowerCase(),
  });
}

const out = {
  $schema: "./fill-auth.schema.json",
  description:
    "EIP-712 FillAuth(bytes32 fillId,address filler,address to,address token,uint256 amount,uint256 deadline) " +
    "vectors for RiddlerFiller (ESCROW-RFC §9.4). signer_private_key values are PUBLIC Hardhat/Anvil TEST keys: " +
    "never fund or register them.",
  domain: { name: FILL_AUTH_DOMAIN_NAME, version: FILL_AUTH_DOMAIN_VERSION },
  typehash: FILL_AUTH_TYPEHASH,
  vectors,
};

const target = path.join(here, "fill-auth.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${target}`);
