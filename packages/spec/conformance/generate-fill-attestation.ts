#!/usr/bin/env node
// Generates `conformance/fill-attestation.json`: vectors for AttestedFillVerifier's
// EIP-712 FillAttestation (ESCROW-RFC.md §9.4, tier 0), domain RiddlerFillAttestation/1,
// plus the `proof` bytes the escrow's claim passes to it. Signatures are 65-byte
// r||s||v, low-s.
//
// Run: npm run generate:fill-attestation -w @xochi/spec

import { ethers } from "ethers";

import {
  encodeAttestedProof,
  FILL_ATTESTATION_DOMAIN_NAME,
  FILL_ATTESTATION_DOMAIN_VERSION,
  FILL_ATTESTATION_TYPEHASH,
  fillAttestationDigest,
  fillAttestationDomainSeparator,
  fillAttestationStructHash,
  signFillAttestation,
} from "@xochi/signer";

import { baselineOrderId, HARDHAT_TEST_KEYS, writeVectors } from "./_lib.js";

const [TEST_KEY_0, TEST_KEY_1] = HARDHAT_TEST_KEYS;
const BASELINE_ORDER_ID = baselineOrderId();

const VERIFIER = "0x5555555555555555555555555555555555555555";
const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const CASES = [
  {
    name: "baseline-base",
    chainId: "8453",
    verifyingContract: VERIFIER,
    orderId: BASELINE_ORDER_ID,
    payee: PAYEE,
    key: TEST_KEY_0,
  },
  {
    name: "second-signer",
    chainId: "8453",
    verifyingContract: VERIFIER,
    orderId: BASELINE_ORDER_ID,
    payee: PAYEE,
    key: TEST_KEY_1,
  },
  {
    name: "other-chain-and-verifier",
    chainId: "1",
    verifyingContract: "0x9A676e781A523b5d0C0e43731313A708CB607508",
    orderId: BASELINE_ORDER_ID,
    payee: PAYEE,
    key: TEST_KEY_0,
  },
  {
    name: "one-order-id-zero-payee",
    chainId: "8453",
    verifyingContract: VERIFIER,
    orderId: "0x" + "00".repeat(31) + "01",
    payee: "0x0000000000000000000000000000000000000000",
    key: TEST_KEY_0,
  },
  {
    name: "max-uint256-order-id-max-payee",
    chainId: "42161",
    verifyingContract: VERIFIER,
    orderId: "0x" + "ff".repeat(32),
    payee: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF",
    key: TEST_KEY_1,
  },
];

const vectors = [];
for (const c of CASES) {
  const domain = { chainId: c.chainId, verifyingContract: c.verifyingContract };
  const signature = (
    await signFillAttestation(new ethers.Wallet(c.key), domain, c.orderId, c.payee)
  ).toLowerCase();
  vectors.push({
    name: c.name,
    chainId: c.chainId,
    verifyingContract: c.verifyingContract,
    orderId: c.orderId,
    payee: c.payee,
    expected_struct_hash: fillAttestationStructHash(c.orderId, c.payee),
    expected_domain_separator: fillAttestationDomainSeparator(domain),
    expected_digest: fillAttestationDigest(domain, c.orderId, c.payee),
    signer_private_key: c.key,
    signer_address: new ethers.Wallet(c.key).address,
    expected_signature: signature,
    expected_proof: encodeAttestedProof(c.payee, signature),
  });
}

const out = {
  $schema: "./fill-attestation.schema.json",
  description:
    "EIP-712 FillAttestation(bytes32 orderId,address payee) vectors for AttestedFillVerifier (ESCROW-RFC §9.4), " +
    "with proof = abi.encode(address payee, bytes signature). signer_private_key values are PUBLIC " +
    "Hardhat/Anvil TEST keys: never fund or register them.",
  domain: { name: FILL_ATTESTATION_DOMAIN_NAME, version: FILL_ATTESTATION_DOMAIN_VERSION },
  typehash: FILL_ATTESTATION_TYPEHASH,
  vectors,
};

writeVectors("fill-attestation.json", out);
